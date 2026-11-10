#!/usr/bin/env python
"""NDJSON pipeline: OCR every uploaded ITR, verify it, then rank with a
Random Forest. Progress is streamed line-by-line on stdout.

    echo '{...}' | python ml/pipeline.py

Event types: start, log, doc, doc_result, scan_progress, scan_analytics,
preprocess, train, rank, done, error.
"""

from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# NDJSON is UTF-8. On Windows the default stdout/stderr codecs are cp1252,
# which cannot encode e.g. the peso sign in dataset labels - force UTF-8.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
    except (AttributeError, ValueError):
        pass

from ml import cache as ocr_cache
from ml import config as cfg
from ml import csv_data as _csv_data
from ml import features as ft
from ml import ocr_engine, preproc, rank_model, storage

# Fast pass first: a strict box threshold keeps only high-confidence text
# boxes (71 vs 187 on the reference ITR) and still reaches the income line.
# If no income label survives it, the full-detail pass runs before giving up.
THRESHOLD_LEVELS = (0.75, 0.5)


START_TIME = time.time()


def _json_safe(value):
    """Recursively replace NaN / +-inf with None.

    json.dumps writes a bare ``NaN`` token for float('nan'), which is not valid
    JSON - the browser's JSON.parse then throws and silently drops the whole
    NDJSON event (that is how a single income-less row blanked the entire
    ranking). Numpy scalars are also unwrapped here so they hit the same check.
    """
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
        return None
    if hasattr(value, "item") and hasattr(value, "dtype"):  # numpy scalar
        try:
            return _json_safe(value.item())
        except Exception:
            return str(value)
    return value


def _mem_mb() -> tuple[float | None, float | None]:
    """Current + peak RSS in MB (Linux /proc, Windows GetProcessMemoryInfo).

    Render's free instance is 512 MB and a container killed for exceeding it
    dies silently - no traceback reaches the logs. Recording RSS on every event
    is how we tell an OOM kill from a Python crash.
    """
    current = peak = None
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    current = round(int(line.split()[1]) / 1024, 1)
                elif line.startswith("VmHWM:"):
                    peak = round(int(line.split()[1]) / 1024, 1)
    except (OSError, ValueError, IndexError):
        pass
    if current is not None:
        return current, peak
    if sys.platform == "win32":
        try:
            import ctypes
            from ctypes import wintypes

            class counters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            counters = counters()  # type: ignore[no-redef]
            counters.cb = ctypes.sizeof(counters)
            handle = ctypes.windll.kernel32.GetCurrentProcess()
            ctypes.windll.psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
            current = round(counters.WorkingSetSize / (1024 * 1024), 1)
            peak = round(counters.PeakWorkingSetSize / (1024 * 1024), 1)
        except Exception:
            return None, None
    return current, peak


def emit(payload: dict) -> None:
    payload.setdefault("t", round(time.time() - START_TIME, 2))
    rss_mb, peak_mb = _mem_mb()
    if rss_mb is not None:
        payload.setdefault("rss_mb", rss_mb)
        payload.setdefault("peak_mb", peak_mb)
    sys.stdout.write(json.dumps(_json_safe(payload), ensure_ascii=False, default=str, allow_nan=False) + "\n")
    sys.stdout.flush()


def log(message: str, **extra) -> None:
    emit(
        {
            "type": "log",
            "msg": message,
            **extra,
        }
    )


def _peso(value) -> str:
    if value is None:
        return "PHP -"
    try:
        return f"PHP {float(value):,.0f}"
    except (TypeError, ValueError):
        return str(value)


def storage_index() -> dict:
    """path -> {size, updated_at} for every object in the ITR bucket."""
    try:
        return {item["path"]: item for item in storage.list_all(cfg.STORAGE_BUCKET)}
    except Exception as exc:  # storage is optional for a pure scan
        log(f"Storage listing skipped: {exc}")
        return {}


def build_docs(applicants: list) -> list:
    index = storage_index()
    docs = []
    seen = set()
    for applicant in applicants:
        page1_path = applicant.get("itr_path")
        page2_path = applicant.get("itr_path_p2")
        path = page1_path or page2_path
        if not path:
            continue
        meta = index.get(path, {})
        doc = {
            "path": path,
            "page_no": 1 if page1_path else 2,
            "size": meta.get("size"),
            "updated_at": meta.get("updated_at"),
            "application_id": applicant.get("application_id"),
            "student_name": applicant.get("student_name"),
            "declared_income": applicant.get("declared_income"),
            "linked": True,
        }
        # ITR Page 2 (BIR 1701-MS back page) carries the income figures, so it
        # is scanned whenever Page 1 yields no income of its own.
        if page1_path and page2_path:
            meta2 = index.get(page2_path, {})
            doc["path2"] = page2_path
            doc["size2"] = meta2.get("size")
            doc["updated_at2"] = meta2.get("updated_at")
        docs.append(doc)
        seen.add(path)

    docs.sort(key=lambda d: d["path"])
    return docs


def _cache_id(doc: dict) -> tuple:
    """Cache identity: a document only reuses its cached OCR when BOTH of its
    pages still match (path + size + updated_at), so replacing Page 2 always
    triggers a fresh two-page scan."""
    path, size, updated_at = doc["path"], doc.get("size"), doc.get("updated_at")
    if doc.get("path2"):
        path = f"{path}::{doc['path2']}"
        size = f"{size}:{doc.get('size2')}"
        updated_at = f"{updated_at}:{doc.get('updated_at2')}"
    return path, size, updated_at


def scan_documents(docs: list) -> tuple:
    """OCR every document -> ({path: result}, scan analytics)."""
    total = len(docs)
    results: dict = {}
    started = time.time()
    cache_hits = 0

    for index, doc in enumerate(docs, start=1):
        path = doc["path"]
        emit(
            {
                "type": "doc",
                "index": index,
                "total": total,
                "path": path,
                "student_name": doc.get("student_name"),
                "declared_income": doc.get("declared_income"),
                "status": "scanning",
            }
        )

        cached = ocr_cache.get(*_cache_id(doc))
        if cached and not cached.get("scan_failure"):
            cached_variants = cached.get("ocr_max_variants", 3)
            if not isinstance(cached_variants, int):
                cached_variants = 3
            if cached_variants < cfg.OCR_MAX_VARIANTS:
                cached = None

        if cached and not cached.get("scan_failure"):
            cache_hits += 1
            record = {**cached, "cached": True}
            record["application_id"] = doc.get("application_id")
            record["student_name"] = doc.get("student_name")
            record["declared_income"] = doc.get("declared_income")
            record["linked"] = doc["linked"]
            record["path"] = path
            record["path2"] = doc.get("path2")
            record["match"] = ocr_engine.match_declared(
                record.get("ocr_value"), doc.get("declared_income")
            )
            log(f"[{index}/{total}] {path} - cached OCR result reused ({record.get('ocr_ms', 0)} ms)")
        else:
            if cached:
                log(f"[{index}/{total}] Retrying previous OCR failure for {path}")
            else:
                log(f"[{index}/{total}] Scanning {path}")
            record = _scan_one(doc)

        if not record["error"] and not doc["linked"]:
            record["error"] = "No application linked to this ITR file"

        if not record["cached"] and not record.get("scan_failure"):
            ocr_cache.put(*_cache_id(doc), record)

        result_key = f"app-{doc['application_id']}" if doc.get("application_id") is not None else path
        results[result_key] = record
        annotate_record(record)
        status = (
            "skipped"
            if record.get("skipped")
            else ("error" if record.get("error") else "done")
        )
        emit(
            {
                "type": "doc_result",
                "index": index,
                "total": total,
                "status": status,
                "cached": bool(record.get("cached")),
                "record": record,
            }
        )
        emit({"type": "scan_progress", "done": index, "total": total})

    elapsed = time.time() - started
    stats = analytics_from(results, elapsed)
    stats["cache_hits"] = cache_hits
    return results, stats


# Fields that together describe one page's income extraction - moved around as
# a unit when Page 1's fallback figure is deferred in favour of Page 2.
_INCOME_FIELDS = (
    "ocr_value",
    "method",
    "low_confidence",
    "income_confidence",
    "anchor",
    "amount_line",
    "variant",
    "steps",
    "line_count",
    "confidence",
    "preview",
    "box_thresh",
    # Which priority row produced the figure (1..3), and whether any of the
    # page's three priority rows carried a value at all.
    "priority_rank",
    "priority_field",
    "priority_label",
    "ocr_cleared",
)


def _clear_income(record: dict) -> None:
    """Reset the extracted-income fields so the next page starts clean."""
    record["ocr_value"] = None
    record["method"] = None
    record["low_confidence"] = False
    record["income_confidence"] = None
    record["anchor"] = None
    record["amount_line"] = None
    record["variant"] = None
    record["steps"] = None
    record["priority_rank"] = None
    record["priority_field"] = None
    record["priority_label"] = None
    record["ocr_cleared"] = None


def _scan_one(doc: dict) -> dict:
    """OCR one ITR document - Page 1 first, then Page 2 when Page 1 carries no
    income figure (the BIR 1701-MS income lines live on the back page)."""
    path = doc["path"]
    path2 = doc.get("path2")
    record = {
        "path": path,
        "path2": path2,
        "income_page": None,
        "application_id": doc.get("application_id"),
        "student_name": doc.get("student_name"),
        "declared_income": doc.get("declared_income"),
        "linked": doc["linked"],
        "ocr_value": None,
        "match": {"exact_match": False, "align_pct": 0.0, "diff": None, "status": "not_comparable"},
        "confidence": 0.0,
        "ocr_ms": 0.0,
        "line_count": 0,
        "preview": [],
        "method": None,
        "variant": None,
        "box_thresh": None,
        "attempts": 0,
        "image": {},
        "cached": False,
        "scan_failure": False,
        "skipped": None,
        "error": None,
        "ocr_max_variants": cfg.OCR_MAX_VARIANTS,
        "itr_fields": [],
        # Priority-reading outcome for this document (1..3 = which priority row
        # supplied the figure; None = no priority row carried a value).
        "priority_rank": None,
        "priority_field": None,
        "priority_label": None,
        "ocr_cleared": None,
        "pages_read": [],
    }

    try:
        pages = [(doc.get("page_no", 1), path)] + ([(2, path2)] if path2 else [])
        scanned = skipped = failed = 0
        skip_detail = None
        last_error = None
        # Scan both pages when both are uploaded. Page 1 tax/payment values are
        # not substitutes for the annual income rows on Page 2.
        deferred = None

        for page_no, page_path in pages:
            log(
                f"      page {page_no} starting: {page_path}"
                + (
                    " - priority read order: "
                    + ocr_engine.describe_priority_chain(page_no)
                    if ocr_engine.describe_priority_chain(page_no)
                    else ""
                )
            )
            status, detail = _ocr_page(page_path, record, page_no)
            if status != "skipped":
                record["pages_read"].append(page_no)
            log(
                f"      page {page_no} result: {status}"
                + (f" - {detail}" if detail else "")
            )
            if status == "found":
                scanned += 1
                if page_no == 1 and path2:
                    deferred = {key: record.get(key) for key in _INCOME_FIELDS}
                    _clear_income(record)
                    log(
                        f"      page 1 candidate deferred - scanning page 2 "
                        f"({path2}) for the labeled annual income row"
                    )
                    continue
                record["income_page"] = page_no
                break
            if status == "no_income":
                scanned += 1
                if record.get("ocr_cleared") is False:
                    log(
                        f"      page {page_no}: NOT CLEARED - none of the three "
                        f"priority rows carried a value "
                        f"({ocr_engine.describe_priority_chain(page_no)})"
                    )
            elif status == "skipped":
                skipped += 1
                skip_detail = detail
            else:  # failed - the next page may still carry the income
                failed += 1
                last_error = detail

        if record["ocr_value"] is None and deferred:
            # Page 2 could not beat Page 1's fallback - keep the fallback.
            record.update(deferred)
            record["income_page"] = 1
            deferred = None

        if record["ocr_value"] is not None:
            # A later page succeeded, so an earlier skip/failure is moot.
            record["scan_failure"] = False
            record["error"] = None
            record["ocr_cleared"] = True
            log(
                f"      selected Page {record.get('income_page')} OCR result: "
                f"{_peso(record['ocr_value'])} via {record.get('method') or 'unknown method'}; "
                f"anchor={record.get('anchor') or '(none)'}; "
                f"amount line={record.get('amount_line') or '(none)'}; "
                f"confidence={record.get('income_confidence') or 0:.3f}; "
                f"low_confidence={bool(record.get('low_confidence'))}"
            )
            if record.get("priority_rank"):
                log(
                    f"      PRIORITY PROOF: page {record.get('income_page')} "
                    f"priority {record['priority_rank']}/3 = "
                    f"{record.get('priority_label') or record.get('priority_field')} "
                    f"= {_peso(record['ocr_value'])} "
                    f"(anchor '{record.get('anchor') or '(none)'}', "
                    f"amount line '{record.get('amount_line') or '(none)'}', "
                    f"confidence={record.get('income_confidence') or 0:.3f})"
                )
        elif failed and not scanned:
            record["scan_failure"] = True
            record["error"] = last_error or "OCR failed"
        elif skipped and not scanned:
            record["skipped"] = skip_detail
            record["error"] = "Skipped: image too small to be a document page"
        else:
            # Every priority row on the uploaded page(s) was empty.
            record["ocr_cleared"] = False
            record["error"] = (
                "OCR not cleared: none of the three priority rows carried a value "
                + (
                    f"on page {record.get('income_page')}"
                    if record.get("income_page")
                    else "on the uploaded ITR page(s)"
                )
                + (f" (page error: {last_error})" if failed else "")
            )

        record["match"] = ocr_engine.match_declared(
            record["ocr_value"], doc.get("declared_income")
        )
    except Exception as exc:
        record["scan_failure"] = True
        record["error"] = str(exc)
        log(f"      failed: {exc}")

    return record


def _ocr_page(path: str, record: dict, page_no: int = 1) -> tuple:
    """Download + preprocess + OCR a single ITR page, writing the outcome into
    ``record``. Returns ``(status, detail)`` with status one of ``"found"``
    (income figure extracted), ``"no_income"``, ``"skipped"`` (image too small
    to be a document page) or ``"failed"`` (exception)."""
    try:
        blob = storage.download(cfg.STORAGE_BUCKET, path)
        blob_size = len(blob)
        log(f"      page {page_no}: downloaded {blob_size:,} bytes from {cfg.STORAGE_BUCKET}/{path}")
        rgb, meta = preproc.decode(blob)
        del blob
        image = {**meta, **preproc.image_stats(rgb), "bytes": blob_size}
        record["image" if page_no == 1 else "image2"] = image
        log(
            f"      page {page_no}: decoded {image.get('format')} "
            f"{image.get('size')} -> {image.get('ocr_size')} for OCR; "
            f"mode={image.get('mode')}, mean_luma={image.get('mean_luma')}, "
            f"std_luma={image.get('std_luma')}"
        )

        # Storage also holds icons/thumbnails; OCR'ing them only burns time and
        # drags the detection rate down. A real ITR page is never this small.
        if min(rgb.shape[:2]) < 500 or blob_size < 20_000:
            note = f"{rgb.shape[1]}x{rgb.shape[0]} px - not an ITR page"
            log(
                f"      page {page_no} skipped "
                f"({rgb.shape[1]}x{rgb.shape[0]} px, {blob_size} bytes)"
            )
            del rgb
            return "skipped", note

        if ocr_engine.peek() is None:
            log("Loading the RapidOCR engine (ONNX Runtime)...")
        engine = ocr_engine.shared()
        candidates = preproc.build_candidates(rgb)
        candidate = next(candidates, None)
        position = 0
        last_outcome = None
        last_candidate = None

        while candidate is not None:
            last_candidate = {
                "name": candidate["name"],
                "steps": candidate["steps"],
            }
            levels = THRESHOLD_LEVELS if position == 0 else (THRESHOLD_LEVELS[-1],)
            # Best priority reading so far on this candidate; a partial chain
            # on the strict pass escalates instead of finalizing (below).
            deferred_priority = None
            for level_index, threshold in enumerate(levels):
                record["attempts"] += 1
                log(
                    f"      page {page_no}: OCR pass {record['attempts']} "
                    f"variant='{candidate['name']}', steps={','.join(candidate['steps'])}, "
                    f"box_thresh={threshold:.2f}"
                )
                outcome = engine.scan(
                    candidate["array"],
                    box_thresh=threshold,
                    allow_fallback=False,
                )
                engine_info = getattr(engine, "engine_info", {})
                if record["attempts"] == 1 and engine_info:
                    log(
                        f"      OCR runtime: provider={engine_info.get('provider', 'unknown')}, "
                        f"RapidOCR={engine_info.get('rapidocr', 'unknown')}, "
                        f"ONNX Runtime patch={engine_info.get('ort_patch', 'unknown')}, "
                        f"engine load={getattr(engine, 'load_ms', 0.0):.1f} ms"
                    )
                last_outcome = outcome
                record["line_count"] = outcome["line_count"]
                record["confidence"] = outcome["avg_confidence"]
                record["ocr_ms"] = round(record["ocr_ms"] + outcome["ocr_ms"], 1)
                record["preview"] = [
                    {"text": line["text"], "score": round(line["score"], 3)}
                    for line in outcome["lines"][: cfg.OCR_LINE_PREVIEW]
                ]
                record["box_thresh"] = threshold
                is_1701_ms = any(
                    re.search(r"\b1701\s*[-–]?\s*MS\b", line["text"], re.I)
                    for line in outcome["lines"]
                )
                page_fields = ocr_engine.extract_1701_ms_fields(
                    outcome["lines"],
                    page_no,
                )
                # Official-layout cell read: the printed digits live in comb
                # cells full-page OCR cannot assemble, so each mapped row is
                # cropped from the BIR PDF layout and read glyph by glyph.
                # Its value wins over a same-row text guess; rows with an
                # empty cell stay absent and the priority chain moves on.
                layout_reader = getattr(
                    engine,
                    "extract_1701_ms_layout_fields",
                    None,
                )
                if is_1701_ms and callable(layout_reader):
                    record["attempts"] += 1
                    cell_started = time.perf_counter()
                    cell_fields = (
                        layout_reader(
                            candidate["array"],
                            outcome["lines"],
                            page_no,
                        )
                        or []
                    )
                    cell_ms = round((time.perf_counter() - cell_started) * 1000, 1)
                    record["ocr_ms"] = round(record["ocr_ms"] + cell_ms, 1)
                    if cell_fields:
                        merged = {field["field"]: field for field in page_fields}
                        for field in cell_fields:
                            merged[field["field"]] = field
                        page_fields = list(merged.values())
                        log(
                            f"      page {page_no}: layout cell read "
                            f"{len(cell_fields)} row(s) ({cell_ms:.1f} ms): "
                            + ", ".join(
                                f"{field['label']} = {_peso(field['value'])}"
                                for field in cell_fields
                            )
                        )
                    else:
                        log(
                            f"      page {page_no}: layout cell pass "
                            f"found no digits ({cell_ms:.1f} ms)"
                        )
                record["itr_fields"] = [
                    field
                    for field in record.get("itr_fields", [])
                    if field.get("page") != page_no
                ] + page_fields

                extracted = outcome["extracted"]
                if is_1701_ms and (
                    page_no != 2
                    or extracted is None
                    or not re.search(
                        r"\bgross\s*compensation\s*income\b",
                        str(extracted.get("anchor") or ""),
                        re.I,
                    )
                ):
                    extracted = None

                # --- panel priority contract ---------------------------------
                # On a 1701-MS page the reading order is fixed: walk
                # priority 1 -> 2 -> 3 and take the first row that carries a
                # value. This replaces the generic keyword scanner, which by
                # design refuses tax-due / tax-payable rows.
                priority = (
                    ocr_engine.pick_priority_value(page_fields, page_no)
                    if is_1701_ms
                    else None
                )
                # The strict first pass (0.75) often keeps the rank-3 label
                # while dropping rank 1/2 (57 vs 140 lines on a real sample).
                # Reporting item 29 when item 23 actually carries a value
                # would understate the reading, so a chain that starts below
                # rank 1 escalates to the full-detail pass first - and only
                # the stricter pass's reading is kept when it finds nothing
                # better than what was already read.
                if (
                    priority is not None
                    and priority["rank"] > 1
                    and level_index < len(levels) - 1
                ):
                    deferred_priority = priority
                    log(
                        f"      page {page_no}: priority rank "
                        f"{priority['rank']} read at box_thresh={threshold:.2f} "
                        f"- escalating to complete the priority chain"
                    )
                    continue
                if (
                    deferred_priority is not None
                    and (
                        priority is None
                        or deferred_priority["rank"] < priority["rank"]
                    )
                ):
                    priority = deferred_priority
                if priority is not None:
                    extracted = {
                        "value": priority["value"],
                        "method": f"1701_ms_priority_{priority['rank']}",
                        "anchor": priority.get("anchor"),
                        "amount_line": priority.get("amount_line"),
                        "confidence": priority.get("confidence") or 0.0,
                    }
                    record["priority_rank"] = priority["rank"]
                    record["priority_field"] = priority["field"]
                    record["priority_label"] = priority["label"]
                    record["ocr_cleared"] = True
                    log(
                        f"      page {page_no}: PRIORITY {priority['rank']}/3 HIT - "
                        f"{priority['label']} = {_peso(priority['value'])} "
                        f"(anchor '{priority.get('anchor') or '(none)'}', "
                        f"amount line '{priority.get('amount_line') or '(none)'}', "
                        f"confidence={priority.get('confidence') or 0:.3f})"
                    )
                elif is_1701_ms:
                    # All three priority rows were empty on this pass.
                    record["ocr_cleared"] = False
                if (
                    extracted is None
                    and page_no == 2
                    and candidate["name"] == "original"
                    and level_index == len(levels) - 1
                ):
                    read_form_cells = getattr(
                        engine,
                        "extract_1701_ms_compensation_income",
                        None,
                    )
                    if callable(read_form_cells):
                        record["attempts"] += 1
                        cell_started = time.perf_counter()
                        extracted = read_form_cells(candidate["array"], outcome["lines"])
                        cell_ms = round((time.perf_counter() - cell_started) * 1000, 1)
                        record["ocr_ms"] = round(record["ocr_ms"] + cell_ms, 1)
                        log(
                            f"      page {page_no}: targeted 1701-MS compensation digit-box "
                            f"pass ({cell_ms:.1f} ms)"
                            + (
                                f" -> {_peso(extracted['value'])}"
                                if extracted
                                else " -> no reliable amount"
                            )
                        )

                if extracted:
                    record["ocr_value"] = extracted["value"]
                    record["method"] = extracted["method"]
                    record["low_confidence"] = bool(extracted.get("low_confidence"))
                    record["income_confidence"] = extracted["confidence"]
                    record["anchor"] = extracted.get("anchor")
                    record["amount_line"] = extracted.get("amount_line")
                    record["variant"] = candidate["name"]
                    if record.get("ocr_cleared") is None:
                        record["ocr_cleared"] = True
                    if str(extracted.get("method") or "").startswith("1701_ms_priority_"):
                        # Record which priority row produced the figure so the
                        # log and the results panel can show the proof.
                        record["steps"] = (candidate["steps"] + ["priority_read"])
                    else:
                        record["steps"] = (
                            candidate["steps"] + ["1701_ms_digit_boxes"]
                            if extracted["method"] == "1701_ms_compensation_digit_boxes"
                            else candidate["steps"]
                        )
                    if extracted.get("method") == "1701_ms_compensation_digit_boxes":
                        record["priority_rank"] = record.get("priority_rank") or 1
                        record["priority_field"] = (
                            record.get("priority_field") or "gross_compensation_income"
                        )
                        record["priority_label"] = (
                            record.get("priority_label")
                            or "Item 1 - Gross Compensation Income"
                        )
                        record["itr_fields"] = [
                            field
                            for field in record.get("itr_fields", [])
                            if field.get("field") != "gross_compensation_income"
                        ] + [
                            {
                                "field": "gross_compensation_income",
                                "label": "Item 1 - Gross Compensation Income",
                                "kind": "income",
                                "page": 2,
                                "value": int(round(extracted["value"])),
                                "confidence": extracted["confidence"],
                                "method": extracted["method"],
                                "anchor": extracted.get("anchor"),
                                "amount_line": extracted.get("amount_line"),
                            }
                        ]
                    log(
                        f"      page {page_no}: recognized {_peso(record['ocr_value'])} "
                        f"via '{record['method']}' from anchor "
                        f"'{record['anchor'] or '(none)'}' and amount line "
                        f"'{record['amount_line'] or '(none)'}'; "
                        f"confidence={record['income_confidence']:.3f}, "
                        f"{outcome['line_count']} text lines, {outcome['ocr_ms']:.1f} ms"
                    )
                    break

                log(
                    f"      page {page_no}: priority 1-3 "
                    + (
                        "all empty"
                        if record.get("ocr_cleared") is False
                        else "no value yet"
                    )
                    + f" at box_thresh={threshold:.2f} on '{candidate['name']}' "
                    f"({outcome['line_count']} text lines, {outcome['ocr_ms']:.1f} ms)"
                    + (
                        " -> escalating to the full-detail pass"
                        if level_index < len(levels) - 1
                        else ""
                    )
                )

            if record["ocr_value"] is not None:
                break
            candidate_name = candidate["name"]
            candidate = None
            candidate = next(candidates, None)
            if candidate is not None:
                log(
                    f"      retrying preprocessing: "
                    f"'{candidate_name}' -> '{candidate['name']}'"
                )
                position += 1

        candidates.close()
        candidate = None
        if record["ocr_value"] is None and last_outcome is not None:
            has_1701_ms_header = any(
                re.search(r"\b1701\s*[-–]?\s*MS\b", line["text"], re.I)
                for line in last_outcome["lines"]
            )
            extracted = ocr_engine.extract_income(
                last_outcome["lines"],
                allow_fallback=not has_1701_ms_header,
            )
            if extracted:
                record["ocr_value"] = extracted["value"]
                record["method"] = extracted["method"]
                record["low_confidence"] = bool(extracted.get("low_confidence"))
                record["income_confidence"] = extracted["confidence"]
                record["anchor"] = extracted.get("anchor")
                record["amount_line"] = extracted.get("amount_line")
                record["variant"] = last_candidate["name"]
                record["steps"] = last_candidate["steps"]
                log(
                    f"      page {page_no}: low-confidence fallback recognized "
                    f"{_peso(record['ocr_value'])} from '{record.get('amount_line') or '(no text)'}'; "
                    "this fallback is for audit only"
                )

        del last_outcome, last_candidate, rgb

        if record["ocr_value"] is not None:
            return "found", None
        return "no_income", None

    except Exception as exc:
        log(f"      page {page_no} failed: {exc}")
        return "failed", str(exc)


def annotate_record(record: dict) -> dict:
    """Per-document OCR alignment and the income/need score used for ranking."""
    typed = record.get("declared_income")
    ocr_value = record.get("ocr_value")
    record["accuracy_pct"] = (
        round(float(record["match"]["align_pct"]), 2)
        if typed is not None and ocr_value is not None and record.get("match")
        else None
    )
    income, source = ft.effective_income(typed, ocr_value, bool(record.get("low_confidence")))
    record["income_used"] = income
    record["income_source"] = source
    record["income_delta"] = (
        round(float(ocr_value) - float(typed), 2)
        if typed is not None and ocr_value is not None
        else None
    )
    record["need_score"] = ft.financial_need_score(income) if typed is not None or ocr_value is not None else None
    return record


def analytics_from(results: dict, elapsed: float, engine=None) -> dict:
    all_records = list(results.values())
    records = [r for r in all_records if not r.get("skipped")]
    skipped = [r for r in all_records if r.get("skipped")]
    linked = [r for r in records if r["linked"]]
    comparable = [r for r in linked if r["ocr_value"] is not None and r["declared_income"] is not None]
    exact = [r for r in comparable if r["match"]["exact_match"]]
    detected = [r for r in records if r["ocr_value"] is not None]
    aligned = [r["match"]["align_pct"] for r in comparable]
    confidences = [r["confidence"] for r in records if r.get("line_count", 0) > 0]
    income_confidences = [
        r["income_confidence"] for r in detected if r.get("income_confidence") is not None
    ]
    scan_failures = [r for r in records if r.get("scan_failure")]

    for rec in linked:
        if rec.get("need_score") is None:
            annotate_record(rec)

    need_scores = [r["need_score"] for r in linked if r.get("need_score") is not None]

    engine_obj = engine or ocr_engine.peek()
    return {
        "documents_in_bucket": len(all_records),
        "documents_scanned": len(records),
        "skipped_documents": len(skipped),
        "linked_to_application": len(linked),
        "unlinked": len(records) - len(linked),
        "income_detected": len(detected),
        "detection_rate_pct": round(100.0 * len(detected) / len(records), 2) if records else 0.0,
        "income_not_detected": sum(1 for r in records if r["ocr_value"] is None and not r.get("scan_failure")),
        "declared_income_available": sum(1 for r in linked if r.get("declared_income") is not None),
        "scan_failures": len(scan_failures),
        "income_confidence_mean": round(sum(income_confidences) / len(income_confidences), 4) if income_confidences else None,
        "comparable": len(comparable),
        "exact_matches": len(exact),
        "mismatches": len(comparable) - len(exact),
        "match_rate_pct": round(100.0 * len(exact) / len(comparable), 2) if comparable else None,
        "avg_align_pct": round(sum(aligned) / len(aligned), 2) if aligned else None,
        "typed_accuracy_pct": round(sum(aligned) / len(aligned), 2) if aligned else None,
        "avg_need_score": round(sum(need_scores) / len(need_scores), 2) if need_scores else None,
        "avg_confidence": round(sum(confidences) / len(confidences), 4) if confidences else None,
        "total_ocr_ms": round(sum(r["ocr_ms"] for r in records), 1),
        "engine_load_ms": engine_obj.load_ms if engine_obj else 0.0,
        "engine": (engine_obj.engine_info if engine_obj and engine_obj.engine_info else {"status": "engine not loaded (all documents served from cache)"}),
        "scan_seconds": round(elapsed, 2),
    }


def index_by_application(scan_results: dict) -> dict:
    out: dict = {}
    for record in scan_results.values():
        app_id = record.get("application_id")
        if app_id is None:
            continue
        out[int(app_id)] = record
    return out


def validate_colab_training_upload(rows: list, warnings: list) -> None:
    if not rows:
        raise ValueError(
            "No usable training rows in the uploaded file. Upload a CSV / Excel "
            "with valid annual family income (TOINC) and NPCINC values."
        )
    skipped_rows = [
        warning
        for warning in warnings
        if "skipped (nothing usable)" in warning or "no income value" in warning
    ]
    if skipped_rows:
        raise ValueError(
            "Colab-aligned training requires valid annual family income (TOINC) and "
            "NPCINC values on every uploaded row. Fix the rows missing either value "
            "and upload the file again."
        )


ML_WARM = threading.Event()


def _warm_ml_stack() -> None:
    """Import scikit-learn up front.

    On this machine the first ``from sklearn.ensemble import ...`` takes ~40 s,
    so it is started at t=0 and overlaps the OCR scan instead of blocking the
    ranking step.
    """
    try:
        from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor  # noqa: F401
        from sklearn.metrics import accuracy_score, roc_auc_score  # noqa: F401
        from sklearn.model_selection import train_test_split  # noqa: F401
        import joblib  # noqa: F401
    except Exception:
        pass
    finally:
        ML_WARM.set()


def main() -> int:
    started = time.time()
    try:
        payload = json.load(sys.stdin)
    except Exception as exc:
        emit({"type": "error", "message": f"Invalid JSON payload: {exc}"})
        return 1

    mode = str(payload.get("mode") or "full")
    seed = int(payload.get("seed") or cfg.DEFAULT_SEED)
    n_trees = int(payload.get("n_trees") or cfg.DEFAULT_N_TREES)
    # NOTE: `or` would swallow an explicit 0 - the train-only run sends
    # n_synth=0 so the forest fits on the uploaded file exactly as the Colab
    # notebook does, with no synthetic rows blended in.
    n_synth = int(payload["n_synth"]) if payload.get("n_synth") is not None else cfg.DEFAULT_SYNTH_SAMPLES
    train_uploaded = bool(payload.get("train_uploaded"))
    train_from_upload = mode == "train" or train_uploaded
    if train_from_upload:
        # A run that explicitly trains from the uploaded file must reproduce
        # the Colab dataset only, without synthetic or bundled sample rows.
        n_synth = 0
    # Optional forest knobs - the "train" mode UI sends the Colab notebook's
    # hyperparameters (200 trees, max_depth 3, min_samples_leaf 200).
    max_depth = int(payload.get("max_depth") or cfg.DEFAULT_MAX_DEPTH)
    min_samples_leaf = int(payload.get("min_samples_leaf") or 2)
    applicants = list(payload.get("applicants") or [])
    preloaded = {
        int(item["application_id"]): item
        for item in (payload.get("ocr_results") or [])
        if item.get("application_id") is not None
    }

    warm = None

    stack = cfg.stack_info()
    emit(
        {
            "type": "start",
            "mode": mode,
            "applicants": len(applicants),
            "seed": seed,
            "n_trees": n_trees,
            "stack": stack,
            "weights": {"need": cfg.W_NEED, "ocr": cfg.W_OCR, "academic": cfg.W_ACADEMIC},
            "limits": {
                "income_floor": cfg.INCOME_FLOOR,
                "income_ceil": cfg.INCOME_CEIL,
                "high_need_income": cfg.HIGH_NEED_INCOME,
            },
        }
    )
    log(
        f"Python {stack.get('python')} | NumPy {stack.get('numpy')} | "
        f"scikit-learn {stack.get('scikit-learn')} | joblib {stack.get('joblib')} | "
        f"Pillow {stack.get('pillow')}"
    )
    log(f"OCR: rapidocr {stack.get('rapidocr-onnxruntime')} | onnxruntime {stack.get('onnxruntime')}")
    log(
        "Ranking policy: declared annual family income is the model income; "
        "OCR is an audit comparison only "
        f"(W_NEED={cfg.W_NEED:.2f}, W_OCR={cfg.W_OCR:.2f}, "
        f"W_ACADEMIC={cfg.W_ACADEMIC:.2f})."
    )
    log(
        f"Priority-score income range: {cfg.INCOME_FLOOR:,.0f} to "
        f"{cfg.INCOME_CEIL:,.0f}; high-need threshold={cfg.HIGH_NEED_INCOME:,.0f}."
    )

    try:
        scan_results: dict = {}
        scan_stats: dict = {}

        # "train" = file-only training without applicants; the uploaded file is
        # trained and its own rows are returned for a dataset proof.
        # "rank" + train_uploaded = fit the uploaded file first, then scan and
        # rank this program's live applicants with that same freshly-fit model.
        if mode == "train":
            log(
                "Train-only run (Machine learning train data): skipping the OCR scan - "
                "the uploaded file is the training set and the ranked set."
            )
        needs_scan = mode in ("scan", "full", "rank") and not preloaded

        if needs_scan:
            docs = build_docs(applicants)
            emit(
                {
                    "type": "log",
                    "msg": f"Found {len(docs)} ITR document(s) to scan "
                    f"({sum(bool(applicant.get('itr_path')) for applicant in applicants)} applicant(s) with an uploaded ITR)",
                }
            )
            if not docs:
                log("No ITR documents found in storage - nothing to scan.")
            else:
                misses = [
                    doc
                    for doc in docs
                    if ocr_cache.get(*_cache_id(doc)) is None
                ]
                if misses and mode in ("rank", "full"):
                    # Real OCR is about to run: import scikit-learn concurrently so
                    # the ~40 s first import overlaps the scan instead of the ranking.
                    warm = threading.Thread(target=_warm_ml_stack, name="ml-warm", daemon=True)
                    warm.start()
                    log(
                        f"{len(misses)} document(s) need a fresh OCR scan - loading scikit-learn "
                        "in the background (first import costs ~40 s on this CPU) so ranking "
                        "does not wait for it..."
                    )
                scan_results, scan_stats = scan_documents(docs)
                log("OCR scan complete.")
        else:
            log("Reusing OCR results from the previous scan.")
            for app_id, item in preloaded.items():
                scan_results[f"app-{app_id}"] = {
                    "path": item.get("file"),
                    "application_id": app_id,
                    "student_name": item.get("student_name"),
                    "declared_income": item.get("declared_income"),
                    "linked": True,
                    "ocr_value": item.get("ocr_value"),
                    "match": item.get("match")
                    or {"exact_match": False, "align_pct": 0.0, "diff": None, "status": "not_comparable"},
                    "confidence": item.get("confidence") or 0.0,
                    "ocr_ms": 0.0,
                    "line_count": 0,
                    "preview": [],
                    "method": item.get("method"),
                    "variant": None,
                    "variants_tried": 0,
                    "image": {},
                    "error": None,
                }
            scan_stats = analytics_from(scan_results, 0.0)

        emit({"type": "scan_analytics", "analytics": scan_stats})

        ranking: list = []
        training: dict = {}
        if mode in ("rank", "full", "train"):
            csv_rows: list = []
            feature_columns = (
                ft.NOTEBOOK_FEATURE_COLUMNS if train_from_upload else ft.FEATURE_COLUMNS
            )
            if mode == "train":
                # No Supabase applicants in this mode: the uploaded training
                # file is the whole dataset. Its rows are also returned as a
                # proof of which data the forest was fitted on.
                from ml import csv_data as _csv_data

                csv_rows, csv_warnings = _csv_data.load_training_csv(
                    income_ranked=True,
                    uploaded_only=True,
                )
                validate_colab_training_upload(csv_rows, csv_warnings)
                rows = csv_rows
                for warning in csv_warnings:
                    log(warning)
                incomes = [r.get("annual_income_family") for r in rows if r.get("annual_income_family") is not None]
                log(
                    f"Loaded {len(rows)} training row(s) from the uploaded file "
                    f"({len(incomes)} with a usable annual family income)."
                )
                log(
                    "Colab-aligned training: the uploaded rows teach the classifier which "
                    "NPCINC <= 4 households are prioritized. Later applicant ranking uses "
                    "that model's predicted priority probability."
                )
            else:
                by_app = index_by_application(scan_results)
                rows = [ft.build_row(applicant, by_app.get(int(applicant["application_id"]))) for applicant in applicants]

                if train_uploaded:
                    from ml import csv_data as _csv_data

                    csv_rows, csv_warnings = _csv_data.load_training_csv(
                        income_ranked=True,
                        uploaded_only=True,
                    )
                    validate_colab_training_upload(csv_rows, csv_warnings)
                    for warning in csv_warnings:
                        log(warning)
                    incomes = [
                        row.get("annual_income_family")
                        for row in csv_rows
                        if row.get("annual_income_family") is not None
                    ]
                    log(
                        f"Training from uploaded file only: loaded {len(csv_rows)} row(s) "
                        f"({len(incomes)} with annual family income)."
                    )
                    log(
                        "Using the uploaded FIES/school file as the sole training dataset; "
                        "the same freshly trained model will score this program's applicants."
                    )

                mismatches = [r for r in rows if r.get("ocr_income_differs")]
                for item in rows:
                    log(
                        f"Applicant input {item.get('student_name') or 'Unknown'} "
                        f"(application #{item.get('application_id')}): "
                        f"declared={_peso(item.get('declared_income'))}; "
                        f"OCR audit={_peso(item.get('ocr_income'))}; "
                        f"OCR match={item.get('ocr_match_pct') if item.get('ocr_status') != 'not_comparable' else 'not comparable'}; "
                        f"model income={_peso(item.get('income_used'))} "
                        f"from {item.get('income_source')}; "
                        f"financial-need score={item.get('financial_need_score')}/100."
                    )
                for item in mismatches:
                    log(
                        f"ITR income check for {item['student_name']}: OCR read "
                        f"{_peso(item.get('ocr_income'))}, applicant entered "
                        f"{_peso(item.get('declared_income'))}; declared income remains the model input. "
                        "Review the OCR mismatch."
                    )
                if not mismatches and any(r.get("ocr_income") is not None for r in rows):
                    log("OCR values are available for audit; the declared annual income remains the model input.")
                elif not any(r.get("ocr_income") is not None for r in rows):
                    log("No OCR income was detected; declared annual income remains the model input.")

                comparable = [r for r in rows if r["ocr_status"] == "match"]
                log(
                    f"Preprocessing {len(rows)} applicant(s) -> {len(feature_columns)} features "
                    f"with NumPy (median imputation)."
                )
                log(f"Feature order: {', '.join(feature_columns)}")
                log(
                    f"Financial-need / OCR-alignment check: {len(comparable)} of {len(rows)} applicant(s) "
                    f"match their uploaded ITR exactly."
                )
                if not train_uploaded:
                    log(
                        "Training basis: the saved model is used when available; otherwise "
                        "the bundled historical sample and synthetic rows train a fallback model."
                    )

            X, medians = ft.matrix(rows, columns=feature_columns)
            emit(
                {
                    "type": "preprocess",
                    "feature_columns": feature_columns,
                    "matrix_shape": list(X.shape),
                    "medians": {k: round(float(v), 4) for k, v in medians.items()},
                    "row_label": "training" if mode == "train" else "applicant",
                    "rows": [
                        {
                            "application_id": r.get("application_id"),
                            "student_name": r.get("student_name"),
                            "income_used": r.get("income_used", r.get("annual_income_family")),
                            "income_source": r.get("income_source"),
                            "income_delta": r.get("income_delta"),
                            "financial_need_score": r.get("financial_need_score"),
                            "ocr_match_pct": r.get("ocr_match_pct"),
                            "priority_target": r.get("priority_target"),
                        }
                        for r in rows
                    ],
                }
            )

            if not ML_WARM.is_set() and warm is not None and warm.is_alive():
                log("Waiting for the scikit-learn import to finish...")
                ML_WARM.wait(300)

            mode_choice = (os.environ.get(cfg.MODEL_MODE_ENV) or "auto").strip().lower()
            external = None
            external_error = None
            if train_from_upload and mode != "train":
                # "Train from this upload, then rank" - but only refit when the
                # saved model was NOT built from the file now in Storage. When
                # they match, reuse it: that is what lets an admin train once
                # (Execute Training Data) and have every later Execute AI
                # Ranking run automatically use that same forest.
                try:
                    external = rank_model.load_external()
                except Exception as exc:
                    external_error = str(exc)
                current_file = _csv_data.uploaded_file_identity()
                saved_file = (external or {}).get("training_file")
                if external is None:
                    log(
                        "No saved model found yet - fitting a fresh Random Forest "
                        "from the uploaded file for this ranking run."
                    )
                elif saved_file and current_file and saved_file.get("path") == current_file.get("path") and saved_file.get("updated_at") == current_file.get("updated_at"):
                    log(
                        f"Reusing the saved model trained on {saved_file.get('name')} "
                        f"(model ID {external.get('model_id')}, trained {external.get('trained_at')}) - "
                        "the uploaded file has not changed, so no refit is needed."
                    )
                else:
                    external = None
                    log(
                        "The uploaded training file changed since the saved model was built - "
                        "fitting a fresh Random Forest on the current file."
                    )
            elif mode == "train":
                # Execute Training Data always refits: its whole job is to build
                # and deploy a new model from the current upload.
                log(
                    "Execute Training Data: fitting a fresh Random Forest on the current file "
                    "(the external-model shortcut is bypassed)."
                )
            else:
                try:
                    external = rank_model.load_external(
                        required=(mode_choice == "external")
                    )
                except Exception as exc:
                    external_error = str(exc)

            if external is not None:
                info = external.get("external_info") or {}
                training = external
                log(
                    f"Using the externally trained model -> {info.get('model_path')} "
                    f"({info.get('model_size_kb')} KB, seed {info.get('seed')}, "
                    f"{info.get('n_trees')} trees, {info.get('n_features')} features, "
                    f"model ID {info.get('model_id') or 'unavailable'}, "
                    f"trained {info.get('trained_at') or 'at an earlier time'})."
                )
                log(
                    "Scoring with the Colab model as-is: no local refit and no "
                    "holdout metrics for this run's applicants."
                )
                if external_error:
                    log(f"External model warning: {external_error}")
            else:
                if external_error:
                    log(f"External model unavailable: {external_error}")
                if train_from_upload:
                    log(
                        f"Training Random Forest ({n_trees} trees, seed {seed}) "
                        f"on {len(csv_rows)} uploaded rows only..."
                    )
                else:
                    log(
                        f"Training Random Forest ({n_trees} trees, seed {seed}) on "
                        f"{n_synth} synthetic + {len(rows)} real rows..."
                    )
                # rank_model.train() loads the uploaded training CSV itself - in
                # "train" mode those exact rows are already in `rows`, so pass an
                # empty real list to avoid counting the file twice.
                training = rank_model.train(
                    [] if mode == "train" or train_uploaded else rows,
                    seed=seed, n_trees=n_trees, n_synth=n_synth,
                    max_depth=max_depth, min_samples_leaf=min_samples_leaf,
                    income_ranked=train_from_upload,
                    csv_rows_override=csv_rows if train_from_upload else None,
                    # Uploaded-data training matches the notebook's five
                    # TOINC-derived features and training parameters.
                    columns=list(ft.NOTEBOOK_FEATURE_COLUMNS) if train_from_upload else None,
                )
                if training.get("n_csv"):
                    log(
                        f"Loaded {training['n_csv']} historical training row(s) "
                        f"({training['n_samples']} rows total in the fit)."
                    )
                for warning in training.get("csv_warnings") or []:
                    log(warning)
                emit(
                    {
                        "type": "train",
                        **{
                            k: v
                            for k, v in training.items()
                            if k not in ("classifier", "regressor", "medians")
                        },
                    }
                )
                log(
                    f"Model saved with joblib -> {training['model_path']} "
                    f"({training['model_size_kb']} KB) in {training['train_ms']} ms"
                )
                if training.get("deployed_path") and training.get("persisted"):
                    log(
                        f"Persisted to Storage and deployed for the main AI-Ranking -> {training['deployed_path']}. "
                        "This run scores applicants with the same freshly trained model; "
                        "later rankings can reuse the saved model."
                    )
                elif training.get("deployed_path"):
                    log(
                        "The model file exists only in this runtime's temporary storage; "
                        "it was not persisted to Supabase Storage, so a later serverless "
                        "ranking run may not be able to reuse it."
                    )

            if external is not None:
                emit(
                    {
                        "type": "train",
                        "external": True,
                        "model_source": "external",
                        "model_path": training.get("model_path"),
                        "model_id": training.get("model_id"),
                        "trained_at": training.get("trained_at"),
                        "model_params": training.get("model_params"),
                        "model_size_kb": training.get("model_size_kb"),
                        "n_samples": training.get("n_samples"),
                        "n_real": training.get("n_real"),
                        "n_synthetic": training.get("n_synthetic"),
                        "n_csv": training.get("n_csv"),
                        "n_trees": training.get("n_trees"),
                        "seed": training.get("seed"),
                        "feature_columns": training.get("feature_columns"),
                        "evaluation": training.get("evaluation"),
                        "accuracy": training.get("accuracy"),
                        "precision": training.get("precision"),
                        "recall": training.get("recall"),
                        "f1": training.get("f1"),
                        "roc_auc": training.get("roc_auc"),
                        "confusion_matrix": training.get("confusion_matrix"),
                        "r2": training.get("r2"),
                        "rmse": training.get("rmse"),
                        "feature_importance": training.get("feature_importance") or {},
                        "dataset": training.get("dataset"),
                        "persisted": training.get("persisted"),
                        "train_ms": training.get("train_ms", 0.0),
                    }
                )

            # The train panel ("Execute Training Data") exists only to FIT and
            # DEPLOY the model - it does not rank the file's own rows. Ranking
            # is the main AI Ranking's job (OCR + ITR / annual income), which
            # scores real applicants with THIS deployed model.
            ranking: List[Dict] = []
            if mode == "train":
                log(
                    "Training data run: model fitted and deployed. Ranking is skipped here - "
                    "use Step 1 -> Step 2 'Execute AI Ranking' to rank real applicants with this model."
                )
            else:
                model_columns = [
                    str(column)
                    for column in (training.get("feature_columns") or ft.FEATURE_COLUMNS)
                ]
                model_matrix, _ = ft.matrix(
                    rows,
                    training.get("medians") or None,
                    columns=model_columns,
                )
                log(
                    f"Model inference matrix: {model_matrix.shape[0]} row(s) x "
                    f"{model_matrix.shape[1]} feature(s); missing values use the "
                    "trained model's stored medians."
                )
                log(f"Model feature order: {', '.join(model_columns)}")
                for row_index, (row, values) in enumerate(zip(rows, model_matrix), start=1):
                    feature_values = ", ".join(
                        f"{name}={value:.4g}"
                        for name, value in zip(model_columns, values)
                    )
                    log(
                        f"Model input [{row_index}/{len(rows)}] "
                        f"{row.get('student_name') or 'Unknown'} "
                        f"(application #{row.get('application_id')}): {feature_values}"
                    )
                ranking = rank_model.predict(rows, training)
                emit({"type": "rank", "rows": ranking})
                for item in ranking:
                    ocr_match = item.get("ocr_match_pct")
                    ocr_match_label = f"{ocr_match}%" if ocr_match is not None else "not comparable"
                    probability = item.get("probability")
                    probability_label = (
                        f"{float(probability):.4f}"
                        if probability is not None
                        else "unavailable"
                    )
                    log(
                        f"  Rank #{item['rank']} {item.get('student_name') or 'File row'} "
                        f"(application #{item.get('application_id')}): "
                        f"class={item['prediction']}, model priority probability={probability_label}, "
                        f"priority score={item['priority_score']:.2f}/100, "
                        f"need score={item.get('financial_need_score')}/100, "
                        f"model income={_peso(item.get('income_used') or item.get('annual_income_family'))} "
                        f"from {item.get('income_source', 'declared')}, OCR audit={ocr_match_label}."
                    )
                log(
                    "Ranking complete: sort by model-predicted priority probability descending, "
                    "then declared annual income ascending, then priority score descending. "
                    "OCR is a separate ITR audit and does not change model inputs."
                )

        emit(
            {
                "type": "done",
                "ok": True,
                "mode": mode,
                "scan_analytics": scan_stats,
                "documents": list(scan_results.values()),
                "train": {k: v for k, v in training.items() if k not in ("classifier", "regressor", "medians")},
                "rankings": ranking,
                "total_seconds": round(time.time() - started, 2),
            }
        )
        return 0

    except Exception as exc:
        emit({"type": "error", "message": str(exc), "trace": traceback.format_exc(limit=6)})
        emit({"type": "done", "ok": False, "mode": mode, "total_seconds": round(time.time() - started, 2)})
        return 1


if __name__ == "__main__":
    sys.exit(main())
