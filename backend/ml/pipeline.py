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
        path = applicant.get("itr_path")
        if not path:
            continue
        meta = index.get(path, {})
        docs.append(
            {
                "path": path,
                "size": meta.get("size"),
                "updated_at": meta.get("updated_at"),
                "application_id": applicant.get("application_id"),
                "student_name": applicant.get("student_name"),
                "declared_income": applicant.get("declared_income"),
                "linked": True,
            }
        )
        seen.add(path)

    docs.sort(key=lambda d: d["path"])
    return docs


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

        cached = ocr_cache.get(path, doc.get("size"), doc.get("updated_at"))
        if cached and not cached.get("scan_failure"):
            cache_hits += 1
            record = {**cached, "cached": True}
            record["application_id"] = doc.get("application_id")
            record["student_name"] = doc.get("student_name")
            record["declared_income"] = doc.get("declared_income")
            record["linked"] = doc["linked"]
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
            ocr_cache.put(path, doc.get("size"), doc.get("updated_at"), record)

        results[path] = record
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


def _scan_one(doc: dict) -> dict:
    """Download + preprocess + OCR a single ITR document."""
    path = doc["path"]
    record = {
        "path": path,
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
    }

    try:
        blob = storage.download(cfg.STORAGE_BUCKET, path)
        blob_size = len(blob)
        rgb, meta = preproc.decode(blob)
        del blob
        record["image"] = {**meta, **preproc.image_stats(rgb), "bytes": blob_size}

        # Storage also holds icons/thumbnails; OCR'ing them only burns time and
        # drags the detection rate down. A real ITR page is never this small.
        if min(rgb.shape[:2]) < 500 or blob_size < 20_000:
            record["skipped"] = f"{rgb.shape[1]}x{rgb.shape[0]} px - not an ITR page"
            record["error"] = "Skipped: image too small to be a document page"
            log(f"      skipped ({rgb.shape[1]}x{rgb.shape[0]} px, {blob_size} bytes)")
            return record

        if ocr_engine.peek() is None:
            log("Loading the RapidOCR engine (ONNX Runtime + DirectML GPU)...")
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
            for level_index, threshold in enumerate(levels):
                record["attempts"] += 1
                outcome = engine.scan(
                    candidate["array"],
                    box_thresh=threshold,
                    allow_fallback=False,
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

                if outcome["extracted"]:
                    record["ocr_value"] = outcome["extracted"]["value"]
                    record["method"] = outcome["extracted"]["method"]
                    record["low_confidence"] = bool(outcome["extracted"].get("low_confidence"))
                    record["income_confidence"] = outcome["extracted"]["confidence"]
                    record["anchor"] = outcome["extracted"].get("anchor")
                    record["amount_line"] = outcome["extracted"].get("amount_line")
                    record["variant"] = candidate["name"]
                    record["steps"] = candidate["steps"]
                    break

                log(
                    f"      no income label at box_thresh={threshold} on '{candidate['name']}' "
                    f"({outcome['line_count']} lines)"
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
            extracted = ocr_engine.extract_income(
                last_outcome["lines"],
                allow_fallback=True,
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

        del last_outcome, last_candidate, rgb

        record["match"] = ocr_engine.match_declared(
            record["ocr_value"], doc.get("declared_income")
        )
        if record["ocr_value"] is None:
            record["error"] = "No income value detected in the ITR image"

    except Exception as exc:
        record["scan_failure"] = True
        record["error"] = str(exc)
        log(f"      failed: {exc}")

    return record


def annotate_record(record: dict) -> dict:
    """Per-document: typed-income accuracy + the income/need score ranking uses."""
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
                    if ocr_cache.get(doc["path"], doc.get("size"), doc.get("updated_at")) is None
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
                for item in mismatches:
                    log(
                        f"ITR income check for {item['student_name']}: OCR read "
                        f"{_peso(item.get('ocr_income'))}, applicant entered "
                        f"{_peso(item.get('declared_income'))}; the declared income remains "
                        "the model input. Review the mismatch."
                    )
                if not mismatches and any(r.get("ocr_income") is not None for r in rows):
                    log("OCR income matches the typed income; declared income remains the model input.")
                elif not any(r.get("ocr_income") is not None for r in rows):
                    log("No OCR income available; the declared annual income remains the model input.")

                comparable = [r for r in rows if r["ocr_status"] == "match"]
                log(
                    f"Preprocessing {len(rows)} applicant(s) -> {len(feature_columns)} features "
                    f"with NumPy (median imputation)."
                )
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
            if train_from_upload:
                # This run explicitly requests a fresh fit on the current upload,
                # never a potentially stale deployed artifact.
                log(
                    "Uploaded-data training: fitting a fresh Random Forest on the current file "
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
                ranking = rank_model.predict(rows, training)
                emit({"type": "rank", "rows": ranking})
                for item in ranking:
                    ocr_match = item.get("ocr_match_pct")
                    ocr_match_label = f"{ocr_match}%" if ocr_match is not None else "not comparable"
                    log(
                        f"  #{item['rank']} {item.get('student_name') or 'File row'} - priority {item['priority_score']} "
                        f"({item['prediction']}, need {item.get('financial_need_score')}, "
                        f"OCR {ocr_match_label}, "
                        f"income {_peso(item.get('income_used') or item.get('annual_income_family'))} "
                        f"from {item.get('income_source', 'declared')})"
                    )
                log(
                    "Ranking complete: highest model-predicted priority probability ranks first; "
                    "lower declared annual income breaks ties. OCR is shown as a separate ITR check."
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
