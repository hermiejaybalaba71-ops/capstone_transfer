"""OCR engine wrapper + ITR income extraction.

Engine: RapidOCR (PP-OCR detection/recognition + ONNX Runtime).
Extraction: keyword-anchored amount parsing, so the *family annual income*
figure is pulled from the right box on a BIR Form 1701 instead of "the biggest
number on the page".
"""

from __future__ import annotations

import re
import sys
import time
import unicodedata
from typing import Callable, Dict, List, Optional

import cv2
import numpy as np

from . import config as _config
from . import form_layout

# ---------------------------------------------------------------- amount ----
AMOUNT_RE = re.compile(
    r"(?<![A-Za-z0-9.,])(?:₱\s*|PHP\s*|P\s*)?(?:"
    r"\d{1,3}(?:,\d{3})+"
    r"|\d{1,3}(?:\.\d{3})+"
    r"|\d{4,9}"
    r")(?:[.,]\d{1,2})?(?![A-Za-z0-9.,])"
)
BARE_CURRENCY_RE = re.compile(r"(?<![\d.,])\d{4,9}(?![\d.,])")

# Ordered from family-level income labels through common BIR compensation,
# business-income and taxable-income labels. BIR layouts vary by form and year.
INCOME_KEYWORDS = [
    (re.compile(r"total\s*family\s*annual\s*income", re.I), True),
    (re.compile(r"total\s*annual\s*family\s*income", re.I), True),
    (re.compile(r"total\s*family\s*income", re.I), True),
    (re.compile(r"total\s*gross\s*compensation\s*income", re.I), True),
    (re.compile(r"total\s*compensation\s*income", re.I), True),
    (re.compile(r"gross\s*compensation\s*income", re.I), True),
    (re.compile(r"taxable\s*compensation\s*income", re.I), False),
    (re.compile(r"annual\s*compensation\s*income", re.I), False),
    (re.compile(r"total\s*annual\s*income", re.I), True),
    (re.compile(r"family\s*annual\s*income", re.I), False),
    (re.compile(r"annual\s*income", re.I), False),
    (re.compile(r"total\s*gross\s*income", re.I), True),
    (re.compile(r"gross\s*income\s*from\s*(?:business|operation)", re.I), True),
    (re.compile(r"gross\s*income", re.I), False),
    (re.compile(r"total\s*taxable\s*income", re.I), True),
    (re.compile(r"net\s*taxable\s*income", re.I), False),
    (re.compile(r"total\s*income", re.I), True),
    (re.compile(r"taxable\s*income", re.I), False),
    (re.compile(r"total\s*net\s*income", re.I), False),
    (re.compile(r"net\s*income", re.I), False),
    (re.compile(r"total\s*business\s*income", re.I), False),
    (re.compile(r"compensation\s*income", re.I), False),
]

IGNORE_RE = re.compile(
    r"page\s*\d|form\s*no|birt|date|schedule|part\s*[iv]+|"
    r"tax\s*due|tax\s*payable|amount\s*due|penalt|surcharge|advances",
    re.I,
)

# Payment/due lines sit near income rows on BIR forms - their amounts must
# never be mistaken for income (e.g. "TOTAL TAX DUE 12,500").
DUE_RE = re.compile(
    r"tax\s*due|tax\s*payable|amount\s*due|amount\s*payable|penalt|surcharge|"
    r"interest\s*on\s|advances\s*from|credit\s*balance",
    re.I,
)

# 1701-MS pages include a printed tax-rate table and explanatory notes with
# large, comma-grouped numbers. These are not an applicant's reported income.
NON_INCOME_CONTEXT_RE = re.compile(
    r"\bif\s*taxable\s*income\s*is\b|\b(?:but\s+)?not\s+over\b|"
    r"\bnot\s+applicable\b.*\bcompensation\s+income\b|"
    r"\btax\s+rate\s+table\b|\bincome\s+tax\s+rate\b|"
    r"\btable\s*\d*\s*[-:]?\s*tax\s+rates?\b|\bexcess\s+over\b",
    re.I,
)

# The form title is "ANNUAL INCOME TAX RETURN" - OCR often returns it glued
# together ("ANNUALINCOMETAXRETURN"), which a naive "annual income" search
# would happily treat as the income label. Reject label candidates that are
# really part of the document header.
ANCHOR_BLOCK_RE = re.compile(
    r"tax\s*return|income\s*tax|\bform\b|bureau|republic|philippines|"
    r"calendar|department|particulars|registered|revised|envelope|schedule",
    re.I,
)
ANCHOR_MAX_LEN = 70

_ORT_CONFIGURED = False
_ORT_INFO: Dict[str, str] = {}
# Live provider order - mutated by ItrOcr._recover() when the DirectML
# session wedges (repeated "ONNXRuntime inferece failed." after the first
# document) so freshly built sessions fall back to the CPU provider.
_RUN_PROVIDERS: List[str] = []


def _configure_ort_session() -> Dict[str, str]:
    """Speed up + fix ONNX Runtime as used by ``rapidocr_onnxruntime``.

    Two problems are patched at the ``InferenceSession`` factory that
    ``OrtInferSession`` closes over:

    1. rapidocr sets ``enable_cpu_mem_arena = False``, which allocates and
       frees every intermediate tensor on every node of every run.
    2. The bundled PP-OCR models are CPU-only by default. On this machine
       (AMD Athlon 300GE, 2 cores / 4 threads) recognition costs ~0.43 s per
       text box (~75 s per page). Routing the same ONNX graphs through the
       ``DmlExecutionProvider`` on the Radeon Vega iGPU measures **0.29 s per
       6-box batch - a 10.6x speedup** - with CPU kept as the fallback
       provider for any op DirectML does not cover.

    The provider list lives in ``_RUN_PROVIDERS`` so a wedged GPU session can
    be downgraded to CPU at runtime (see ``ItrOcr._recover``).
    """
    global _ORT_CONFIGURED
    if _ORT_CONFIGURED:
        return dict(_ORT_INFO)

    import onnxruntime as ort

    original = ort.InferenceSession
    providers = list(ort.get_available_providers())

    if "DmlExecutionProvider" in providers:
        _RUN_PROVIDERS[:] = ["DmlExecutionProvider", "CPUExecutionProvider"]
        _ORT_INFO["provider"] = "DmlExecutionProvider (GPU)"
    else:
        _RUN_PROVIDERS[:] = ["CPUExecutionProvider"]
        _ORT_INFO["provider"] = "CPUExecutionProvider"

    def _inference_session(model_path, *args, **kwargs):
        sess_options = kwargs.get("sess_options")
        if sess_options is not None and not sess_options.enable_cpu_mem_arena:
            sess_options.enable_cpu_mem_arena = True
        if sess_options is not None and not sess_options.intra_op_num_threads:
            # One thread: 0.1 CPU cannot feed a pool, and every extra ORT thread
            # keeps its own scratch buffers alive on a 512 MB instance.
            sess_options.intra_op_num_threads = 1
        kwargs["providers"] = list(_RUN_PROVIDERS)
        return original(model_path, *args, **kwargs)

    for name in ("rapidocr_onnxruntime.utils", "utils"):
        module = sys.modules.get(name)
        if module is not None and getattr(module, "InferenceSession", None) is original:
            module.InferenceSession = _inference_session
            _ORT_INFO["patched_module"] = name

    _ORT_INFO["available"] = ",".join(providers)
    _ORT_CONFIGURED = bool(_ORT_INFO.get("patched_module"))
    return dict(_ORT_INFO)


def parse_amount(raw: str) -> Optional[float]:
    text = raw.replace("₱", "").replace("PHP", "").strip()
    text = re.sub(r"[^\d.]", "", text)
    if not text or text == ".":
        return None
    if re.fullmatch(r"\d{1,3}(?:\.\d{3})+", text):
        text = text.replace(".", "")
    try:
        value = float(text)
    except ValueError:
        return None
    return value if value >= 0 else None


def extract_1701_ms_compensation_income(
    image: np.ndarray,
    lines: List[dict],
    recognize_crops: Callable[[List[np.ndarray]], tuple],
) -> Optional[dict]:
    """Read the gross-compensation amount from the BIR 1701-MS Page 2 boxes.

    Full-page detection often misses the digits because each character sits in
    a separate amount cell. This fallback isolates those printed glyphs only
    when the page and its Gross Compensation Income label were recognized.
    """
    if not any(re.search(r"\b1701\s*[-–]?\s*MS\b", line["text"], re.I) for line in lines):
        return None
    anchor_line = next(
        (
            line
            for line in lines
            if re.search(r"\bgross\s*compensation\s*income\b", line["text"], re.I)
        ),
        None,
    )
    if anchor_line is None or image.ndim < 2:
        return None

    height, width = image.shape[:2]
    scale = width / 1224.0
    aspect = width / height if height else 0.0
    if width < 600 or not 0.58 <= aspect <= 0.72:
        return None

    x0 = int(round(650 * scale))
    x1 = min(width, int(round(925 * scale)))
    center_y = float(anchor_line["y"])
    half_height = max(15, int(round(24 * scale)))
    y0 = max(0, int(round(center_y)) - half_height)
    y1 = min(height, int(round(center_y)) + half_height)
    if x1 <= x0 or y1 <= y0:
        return None

    page_crop = image[y0:y1, x0:x1]
    gray = (
        cv2.cvtColor(page_crop, cv2.COLOR_RGB2GRAY)
        if page_crop.ndim == 3
        else page_crop
    )
    _, ink = cv2.threshold(gray, 140, 255, cv2.THRESH_BINARY_INV)
    count, _, stats, _ = cv2.connectedComponentsWithStats(ink, 8)

    glyph_boxes = []
    for x, y, glyph_width, glyph_height, area in stats[1:count]:
        scale_area = scale * scale
        if (
            x < 8 * scale
            or x > 260 * scale
            or glyph_height < 8 * scale
            or glyph_height > 17 * scale
            or glyph_width > 12 * scale
            or area < 12 * scale_area
            or y + glyph_height / 2 >= 0.95 * gray.shape[0]
        ):
            continue
        glyph_boxes.append(
            (int(x), int(y), int(glyph_width), int(glyph_height))
        )
    glyph_boxes.sort()
    merged_boxes = []
    merge_gap = max(3, int(round(6 * scale)))
    for x, y, glyph_width, glyph_height in glyph_boxes:
        if merged_boxes:
            prev_x, prev_y, prev_width, prev_height = merged_boxes[-1]
            gap = x - (prev_x + prev_width)
            vertical_overlap = min(prev_y + prev_height, y + glyph_height) - max(prev_y, y)
            if gap <= merge_gap and vertical_overlap > 0:
                right = max(prev_x + prev_width, x + glyph_width)
                bottom = max(prev_y + prev_height, y + glyph_height)
                merged_boxes[-1] = (
                    prev_x,
                    min(prev_y, y),
                    right - prev_x,
                    bottom - min(prev_y, y),
                )
                continue
        merged_boxes.append((x, y, glyph_width, glyph_height))
    glyph_boxes = merged_boxes
    if not 4 <= len(glyph_boxes) <= 9:
        return None

    crops = []
    for x, y, glyph_width, glyph_height in glyph_boxes:
        glyph = gray[y : y + glyph_height, x : x + glyph_width]
        padding = max(2, int(round(8 * scale)))
        glyph = cv2.copyMakeBorder(
            glyph,
            padding,
            padding,
            padding,
            padding,
            cv2.BORDER_CONSTANT,
            value=255,
        )
        glyph = cv2.resize(
            glyph,
            None,
            fx=4,
            fy=4,
            interpolation=cv2.INTER_CUBIC,
        )
        crops.append(cv2.cvtColor(glyph, cv2.COLOR_GRAY2RGB))

    recognized, _elapsed = recognize_crops(crops)
    if len(recognized) != len(glyph_boxes):
        return None

    digits = []
    confidences = []
    for text, score in recognized:
        token = str(text).strip().lower()
        confidence = float(score)
        if confidence < 0.15:
            return None
        if token == "o":
            token = "0"
        if len(token) != 1 or token not in "0123456789":
            return None
        digits.append(token)
        confidences.append(confidence)

    value = int("".join(digits))
    if value < 1_000:
        return None
    return {
        "value": value,
        "method": "1701_ms_compensation_digit_boxes",
        "anchor": anchor_line["text"].strip(),
        "amount_line": f"{value:,}",
        "confidence": round(sum(confidences) / len(confidences), 4),
        "matched": True,
    }


# --------------------------------------------------------- layout cells ----
# The official 1701-MS prints every amount digit inside its own comb cell, so
# a full-page OCR pass returns fragments ("8..8.0.0") instead of the number.
# This reader anchors on the row's printed label (which OCR *does* detect),
# scales the official PDF layout box of that row's amount cell to the image,
# crops just the cell, and recognizes its glyphs left to right. Rows whose
# cell is empty are skipped - never guessed, keeping the "not cleared"
# contract intact.

_1701_MS_META: Dict[tuple, tuple] = {}  # filled in after _1701_MS_FIELDS


def _layout_anchor(lines: List[dict], pattern: str, width: float) -> Optional[dict]:
    """The row's own label line: left half of the page, item number leading.

    Section headers (e.g. "PART II - Total Income Tax Payable") share words
    with item 25's label, so the strict leading-item pattern is what keeps
    the crop anchored to the right row.
    """
    for line in lines:
        if float(line.get("x", 0.0)) >= width * 0.5:
            continue
        if re.search(pattern, str(line.get("text") or ""), re.I):
            return line
    return None


def _read_layout_cell(
    image: np.ndarray,
    cell: tuple,
    label_top_pt: float,
    anchor: dict,
    scale: float,
    recognize_crops: Callable[[List[np.ndarray]], tuple],
) -> Optional[tuple]:
    """Crop one official amount cell and read its digits.

    Returns ``(value, confidence)`` or None when the cell is empty or the
    read is not trustworthy.
    """
    height, width = image.shape[:2]
    anchor_top = float(anchor["y"]) - float(anchor.get("h", 0.0)) / 2.0
    dy = anchor_top - float(label_top_pt) * scale
    if abs(dy) > height * 0.15:
        # The detected line cannot belong to this row on this image; cropping
        # anyway would silently read a neighbouring row's digits.
        return None
    x0 = max(0, int(round(cell[0] * scale)))
    y0 = max(0, int(round(cell[1] * scale + dy)))
    x1 = min(width, int(round(cell[2] * scale)))
    y1 = min(height, int(round(cell[3] * scale + dy)))
    if x1 - x0 < 40 or y1 - y0 < 8:
        return None

    crop = image[y0:y1, x0:x1]
    gray = (
        cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY)
        if crop.ndim == 3
        else crop
    )
    _, ink = cv2.threshold(gray, 140, 255, cv2.THRESH_BINARY_INV)
    count, _, stats, _ = cv2.connectedComponentsWithStats(ink, 8)
    cell_h, cell_w = gray.shape[:2]

    glyph_boxes = []
    for x, y, w, h, _area in stats[1:count]:
        if (
            w >= 0.9 * cell_w            # top/bottom border or underline
            or h >= 0.95 * cell_h        # left/right border column
            or x <= 0                    # touching the crop edge -
            or y <= 0                    #   misalignment, not a digit
            or x + w >= cell_w
            or y + h >= cell_h
        ):
            continue
        # Digits sit in the upper band of the cell (height ~40% of the cell,
        # top <= 55%); commas and comb tick marks hang below that band.
        if h < 0.33 * cell_h or y > 0.55 * cell_h or w > 0.45 * cell_w:
            continue
        glyph_boxes.append((int(x), int(y), int(w), int(h)))
    if not glyph_boxes:
        return None

    # Thresholding can split one glyph (e.g. "8") into pieces; digit slots
    # are ~29 px apart at 1224 px width while parts of one glyph sit within
    # 6*scale px of each other, so only same-line neighbours rejoin.
    glyph_boxes.sort()
    merged: List[list] = []
    merge_gap = max(3, int(round(6 * scale)))
    for x, y, w, h in glyph_boxes:
        if merged:
            px, py, pw, ph = merged[-1]
            gap = x - (px + pw)
            overlap = min(py + ph, y + h) - max(py, y)
            if gap <= merge_gap and overlap > 0:
                merged[-1] = [
                    px,
                    min(py, y),
                    max(px + pw, x + w) - px,
                    max(py + ph, y + h) - min(py, y),
                ]
                continue
        merged.append([x, y, w, h])
    if len(merged) > 16:
        return None

    # Assemble the digits into ONE strip (their printed order, uniformly
    # sized, gaps normalized) and recognize the strip as a single line:
    # PP-OCR reads a whole number far more reliably than isolated glyphs
    # (a lone "1" comes back as "4" or "" glyph-by-glyph, while the same
    # cells read 17600 / 146500 as a strip).
    target_h = 48
    tiles = []
    for x, y, w, h in merged:
        glyph = gray[y : y + h, x : x + w]
        # Black-on-white, matching what the recognizer was trained on.
        _, glyph = cv2.threshold(glyph, 140, 255, cv2.THRESH_BINARY)
        target_w = max(4, int(round(w * target_h / float(h))))
        tiles.append(
            cv2.resize(glyph, (target_w, target_h), interpolation=cv2.INTER_CUBIC)
        )
    gap = max(6, int(round(5 * scale)))
    total_w = sum(tile.shape[1] for tile in tiles) + gap * (len(tiles) + 1)
    canvas = np.full((target_h + 2 * gap, total_w), 255, dtype=np.uint8)
    cursor = gap
    for tile in tiles:
        canvas[gap : gap + tile.shape[0], cursor : cursor + tile.shape[1]] = tile
        cursor += tile.shape[1] + gap
    strip = cv2.cvtColor(canvas, cv2.COLOR_GRAY2RGB)

    recognized, _elapsed = recognize_crops([strip])
    if not recognized:
        return None
    text, score = recognized[0]
    confidence = float(score)
    # Whole strips score 0.65+ when they read correctly; anything this low
    # is the recognizer guessing on noise rather than digits.
    if confidence < 0.20:
        return None
    token = unicodedata.normalize("NFKC", str(text))
    token = (
        token.replace(",", "")
        .replace(" ", "")
        .replace("o", "0")
        .replace("O", "0")
    )
    if not re.fullmatch(r"\d{1,12}", token):
        return None
    return int(token), round(confidence, 4)


def extract_1701_ms_layout_fields(
    image: np.ndarray,
    lines: List[dict],
    page_no: int,
    recognize_crops: Callable[[List[np.ndarray]], tuple],
) -> List[dict]:
    """Read every mapped 1701-MS row straight from its official amount cell.

    ``lines`` are the full-page OCR lines (they supply the label anchors);
    ``recognize_crops`` is the engine's text recognizer, fed one small glyph
    crop at a time. Rows whose cell holds no digits are left out entirely so
    ``pick_priority_value`` keeps walking the priority chain to the next row.
    """
    if image is None or getattr(image, "ndim", 0) < 2 or not lines:
        return []
    rows = form_layout.FIELD_LAYOUT.get(int(page_no))
    if not rows:
        return []
    if not any(
        re.search(r"\b1701\s*[-–]?\s*MS\b", str(line.get("text") or ""), re.I)
        for line in lines
    ):
        return []
    height, width = image.shape[:2]
    if width < 600:
        return []
    aspect = width / float(height) if height else 0.0
    if not 0.5 <= aspect <= 0.8:
        return []
    scale = width / form_layout.PAGE_WIDTH_PT

    fields: List[dict] = []
    for field_key, (cx0, ctop, cx1, cbottom, label_top, pattern) in rows.items():
        anchor = _layout_anchor(lines, pattern, width)
        if anchor is None:
            continue
        read = _read_layout_cell(
            image,
            (cx0, ctop, cx1, cbottom),
            label_top,
            anchor,
            scale,
            recognize_crops,
        )
        if read is None:
            continue
        value, confidence = read
        label, kind = _1701_MS_META.get(
            (int(page_no), field_key), (field_key, "amount")
        )
        fields.append(
            {
                "field": field_key,
                "label": label,
                "kind": kind,
                "page": int(page_no),
                "value": value,
                "confidence": confidence,
                "method": "1701_ms_layout_cell",
                "anchor": str(anchor.get("text") or "").strip(),
                "amount_line": f"{value:,}",
            }
        )
    return fields


class ItrOcr:
    """Lazily loaded RapidOCR engine."""

    def __init__(self) -> None:
        self._engine = None
        self.load_ms = 0.0
        self.engine_info: Dict[str, str] = {}
        # Recovery bookkeeping: a DirectML session can wedge after the first
        # document (every later run raises "ONNXRuntime inferece failed.").
        self._gpu_rebuilds = 0
        self._downgraded_to_cpu = False

    def _drop_engine(self) -> None:
        """Release the current ONNX sessions so a fresh engine can be built."""
        engine = self._engine
        self._engine = None
        if engine is not None:
            for holder in ("text_detector", "text_recognizer", "text_cls"):
                model = getattr(engine, holder, None)
                session = getattr(model, "session", None) or getattr(model, "_session", None)
                if session is not None:
                    try:
                        del session
                    except Exception:
                        pass
            del engine

    def _recover(self, exc: BaseException) -> None:
        """Rebuild the OCR engine after a runtime failure.

        First rebuild keeps the GPU provider (the failure may be transient);
        a second failure inside the same process means the DirectML session
        is wedged, so the provider order drops to CPU-only and the engine is
        rebuilt again. Subsequent scans are slower but keep working instead
        of failing every remaining document.
        """
        message = str(exc)
        self._drop_engine()
        if not self._downgraded_to_cpu and self._gpu_rebuilds >= 1:
            _RUN_PROVIDERS[:] = ["CPUExecutionProvider"]
            self._downgraded_to_cpu = True
            self.engine_info["provider"] = "CPUExecutionProvider (GPU downgraded)"
            print(
                "OCR: DirectML session failed twice - downgrading to CPU provider",
                file=sys.stderr,
                flush=True,
            )
        else:
            self._gpu_rebuilds += 1
            print(
                f"OCR: rebuilding the engine after a runtime failure ({message})",
                file=sys.stderr,
                flush=True,
            )
        # Building the engine is what allocates the sessions; the next
        # read_lines() call triggers it through the `engine` property.
        self.engine_info.pop("status", None)

    @property
    def engine(self):
        if self._engine is None:
            started = time.time()
            import rapidocr_onnxruntime  # noqa: F401  (registers rapidocr_onnxruntime.utils)
            from rapidocr_onnxruntime import RapidOCR

            patch = _configure_ort_session()
            # 180-degree angle classification costs ~14 s per page on this
            # hardware (187 crops) and ITR uploads are upright documents.
            self._engine = RapidOCR(use_angle_cls=False)
            self.load_ms = round((time.time() - started) * 1000, 1)

            import onnxruntime as ort
            try:
                from importlib.metadata import version as _pkg_version

                _v = _pkg_version("rapidocr-onnxruntime")
            except Exception:
                _v = "unknown"

            self.engine_info = {
                "engine": "RapidOCR (PP-OCRv4 detection + recognition)",
                "runtime": f"ONNX Runtime {ort.__version__}",
                "provider": (
                    "CPUExecutionProvider (GPU downgraded)"
                    if self._downgraded_to_cpu
                    else patch.get("provider", "?")
                ),
                "rapidocr": str(_v),
                "ort_patch": "on" if patch.get("patched_module") else "off",
            }
        return self._engine

    def read_lines(self, image, **call_kwargs) -> List[dict]:
        """Run OCR and return lines sorted top-to-bottom.

        A wedged ONNX session is recovered automatically (engine rebuild,
        then CPU downgrade) instead of failing every later document.
        """
        try:
            result, _ = self.engine(image, **call_kwargs)
        except Exception as exc:
            if "inferece failed" not in str(exc) and "inference failed" not in str(exc):
                raise
            self._recover(exc)
            result, _ = self.engine(image, **call_kwargs)
        lines: List[dict] = []
        for box, text, score in result or []:
            xs = [float(p[0]) for p in box]
            ys = [float(p[1]) for p in box]
            lines.append(
                {
                    "text": str(text),
                    "score": float(score),
                    "y": round(sum(ys) / len(ys), 1),
                    "x": round(min(xs), 1),
                    # Right edge + width: the row/column extractor needs the
                    # horizontal extent to tell a label cell (left column) from
                    # an amount cell (the form's amount columns on the right).
                    "x1": round(max(xs), 1),
                    "w": round(max(xs) - min(xs), 1),
                    "h": round(max(ys) - min(ys), 1),
                }
            )
        lines.sort(key=lambda item: (item["y"], item["x"]))
        return lines

    def scan(
        self,
        image,
        box_thresh: Optional[float] = None,
        allow_fallback: bool = True,
    ) -> dict:
        """OCR a candidate image and extract the family annual income."""
        started = time.time()
        # RapidOCR only rewrites its stored threshold when a kwarg is passed,
        # so always send an explicit value - otherwise a previous stricter
        # pass silently leaks into this one.
        lines = self.read_lines(image, box_thresh=box_thresh if box_thresh else 0.5)
        elapsed_ms = round((time.time() - started) * 1000, 1)
        extracted = extract_income(lines, allow_fallback=allow_fallback)
        return {
            "lines": lines,
            "extracted": extracted,
            "box_thresh": box_thresh,
            "line_count": len(lines),
            "avg_confidence": round(
                sum(item["score"] for item in lines) / len(lines), 4
            )
            if lines
            else 0.0,
            "ocr_ms": elapsed_ms,
        }

    def extract_1701_ms_compensation_income(self, image, lines: List[dict]) -> Optional[dict]:
        """Use the loaded recognizer on digit crops after full-page OCR misses."""
        return extract_1701_ms_compensation_income(
            image,
            lines,
            self.engine.text_recognizer,
        )

    def extract_1701_ms_layout_fields(
        self, image, lines: List[dict], page_no: int
    ) -> List[dict]:
        """Read every mapped row's amount cell from the official layout."""
        return extract_1701_ms_layout_fields(
            image,
            lines,
            page_no,
            self.engine.text_recognizer,
        )


def _amounts_in(line: dict) -> List[tuple]:
    out = []
    for match in AMOUNT_RE.finditer(line["text"]):
        value = parse_amount(match.group(0))
        if value is not None:
            out.append((value, match.group(0), match.start()))
    return out


_1701_MS_FIELDS = (
    (
        2,
        "gross_compensation_income",
        "Item 1 - Gross Compensation Income",
        "income",
        re.compile(r"(?:\b1\s*)?gross\s*compensation\s*income\b", re.I),
    ),
    (
        2,
        "taxable_compensation_income",
        "Item 3 - Taxable Compensation Income",
        "income",
        re.compile(r"(?:\b3\s*)?taxable\s*compensation\s*income\b", re.I),
    ),
    (
        2,
        "gross_business_income",
        "Item 9 - Gross Income/(Loss) from Operation",
        "income",
        re.compile(
            # The printed form reads "Gross Income/(Loss) from Operation" - the
            # parentheses around "Loss" are literal, so they must be optional
            # parts of the pattern rather than assumed absent.
            r"(?:\b9\s*)?gross\s*income\s*(?:/\s*)?(?:\(?\s*loss\s*\)?\s*)?from\s*operation\b",
            re.I,
        ),
    ),
    (
        2,
        "net_business_income",
        "Item 12 - Net Income/(Loss)",
        "income",
        re.compile(r"(?:\b12\s*)?net\s*income\s*(?:/\s*)?(?:loss)?\b", re.I),
    ),
    (
        2,
        "taxable_business_income",
        "Item 14 - Taxable Income-Business",
        "income",
        re.compile(r"(?:\b14\s*)?taxable\s*income\s*[-–]?\s*business\b", re.I),
    ),
    (
        2,
        "total_taxable_income",
        "Item 15 - Total Taxable Income",
        "income",
        re.compile(r"(?:\b15\s*)?total\s*taxable\s*income\b", re.I),
    ),
    (
        2,
        "total_tax_due_compensation",
        "Item 18A - Total Tax Due (Compensation & Business)",
        "tax",
        re.compile(r"\b18\s*A\s*total\s*tax\s*due\b", re.I),
    ),
    (
        2,
        "total_tax_due_business",
        "Item 18B - Total Tax Due (Graduated Rates)",
        "tax",
        re.compile(r"\b18\s*B\s*total\s*tax\s*due\b", re.I),
    ),
    (
        1,
        "total_income_tax_due",
        "Item 23 - Total Income Tax Due",
        "tax",
        re.compile(r"(?:\b23\s*)?total\s*income\s*tax\s*due\b", re.I),
    ),
    (
        1,
        "tax_payable_overpayment",
        "Item 25 - Tax Payable/(Overpayment)",
        "tax",
        re.compile(r"(?:\b25\s*)?tax\s*payable\s*(?:/\s*)?(?:overpayment)?\b", re.I),
    ),
    (
        1,
        "total_amount_payable",
        "Item 29 - Total Amount Payable/(Overpayment)",
        "tax",
        re.compile(r"(?:\b29\s*)?total\s*amount\s*payable\b", re.I),
    ),
    (
        1,
        "aggregate_amount_payable",
        "Item 30 - Aggregate Amount Payable/(Overpayment)",
        "tax",
        re.compile(r"(?:\b30\s*)?aggregate\s*amount\s*payable\b", re.I),
    ),
)

# field key -> (display label, kind) for the layout-cell reader.
_1701_MS_META = {
    (page, key): (label, kind)
    for page, key, label, kind, _pattern in _1701_MS_FIELDS
}


def extract_1701_ms_fields(lines: List[dict], page_no: int) -> List[dict]:
    """Extract labeled 1701-MS income/tax amounts without mixing their meaning.

    Only amounts on the same OCR row as a supported label are returned. This
    intentionally avoids guessing from the form's tax tables or nearby rows.
    """
    if not lines or not any(
        re.search(r"\b1701\s*[-–]?\s*MS\b", line["text"], re.I)
        for line in lines
    ):
        return []

    fields = []
    if page_no == 1:
        source_line = next(
            (line for line in lines if re.search(r"\bsource\s*of\s*income\b", line["text"], re.I)),
            None,
        )
        if source_line:
            fields.append(
                {
                    "field": "income_source_options",
                    "label": "Item 11 - Source of Income (checkbox selection not inferred)",
                    "kind": "source",
                    "page": 1,
                    "value": source_line["text"].strip(),
                    "confidence": round(float(source_line["score"]), 4),
                    "method": "1701_ms_label_text",
                    "anchor": source_line["text"].strip(),
                    "amount_line": None,
                }
            )

    for field_page, key, label, kind, pattern in _1701_MS_FIELDS:
        if field_page != page_no:
            continue
        for anchor in lines:
            match = pattern.search(anchor["text"])
            if not match:
                continue
            same_row = [
                line
                for line in lines
                if abs(float(line["y"]) - float(anchor["y"]))
                <= max(18.0, float(anchor.get("h", 0.0)))
                and float(line.get("x", 0.0)) >= float(anchor.get("x", 0.0))
            ]
            amounts = []
            for line in same_row:
                for value, raw, start in _amounts_in(line):
                    token_tail = line["text"][start + len(raw) :].lstrip()
                    if (
                        value >= 1_000
                        and not token_tail.startswith("%")
                        and (line is not anchor or start >= match.end())
                    ):
                        amounts.append((line, value, raw))
            if not amounts:
                continue

            amount_line, value, raw = min(
                amounts,
                key=lambda item: (
                    abs(float(item[0]["y"]) - float(anchor["y"])),
                    float(item[0].get("x", 0.0)),
                ),
            )
            fields.append(
                {
                    "field": key,
                    "label": label,
                    "kind": kind,
                    "page": page_no,
                    "value": int(round(value)),
                    "confidence": round(
                        (float(anchor["score"]) + float(amount_line["score"])) / 2,
                        4,
                    ),
                    "method": "1701_ms_labeled_row",
                    "anchor": anchor["text"].strip(),
                    "amount_line": amount_line["text"].strip(),
                }
            )
            break
    return fields


# ---------------------------------------------------------------- priority ----
# The panel's reading contract: OCR reports ONE amount per page, walking a fixed
# priority list and stopping at the first row that actually carries a value.
# Whichever page(s) the applicant uploaded is enough - Page 1 only, Page 2 only,
# or both. When none of the three priority rows has a value the page is reported
# as "not cleared" rather than guessing from an unrelated number on the form.
#
#   Page 1 (payments)  23 Total Income Tax Due
#                      -> 25 Tax Payable/(Overpayment)
#                      -> 29 Total Amount Payable/(Overpayment)
#   Page 2 (income)     1 Gross Compensation Income
#                      -> 9 Gross Income/(Loss) from Operation
#                      -> 15 Total Taxable Income
PAGE_PRIORITY_CHAIN: Dict[int, tuple] = {
    1: (
        ("total_income_tax_due", "Item 23 - Total Income Tax Due"),
        ("tax_payable_overpayment", "Item 25 - Tax Payable/(Overpayment)"),
        ("total_amount_payable", "Item 29 - Total Amount Payable/(Overpayment)"),
    ),
    2: (
        ("gross_compensation_income", "Item 1 - Gross Compensation Income"),
        ("gross_business_income", "Item 9 - Gross Income/(Loss) from Operation"),
        ("total_taxable_income", "Item 15 - Total Taxable Income"),
    ),
}


def describe_priority_chain(page_no: int) -> str:
    """Human-readable priority list for the execution log."""
    chain = PAGE_PRIORITY_CHAIN.get(int(page_no))
    if not chain:
        return ""
    return " -> ".join(
        f"{rank}. {label}" for rank, (_key, label) in enumerate(chain, start=1)
    )


def pick_priority_value(fields: List[dict], page_no: int) -> Optional[dict]:
    """First priority row on ``page_no`` that carries a value, or None.

    Returns ``{"rank", "field", "label", "value", "confidence", "anchor",
    "amount_line"}``. Rank 1..3 matches ``PAGE_PRIORITY_CHAIN``; None means all
    three priorities were empty ("not cleared").
    """
    chain = PAGE_PRIORITY_CHAIN.get(int(page_no))
    if not chain:
        return None
    by_field = {
        field.get("field"): field
        for field in fields
        if field.get("page") == page_no and field.get("value") is not None
    }
    for rank, (key, label) in enumerate(chain, start=1):
        item = by_field.get(key)
        if item is None:
            continue
        try:
            value = int(round(float(item["value"])))
        except (TypeError, ValueError):
            continue
        return {
            "rank": rank,
            "field": key,
            "label": label,
            "value": value,
            "confidence": item.get("confidence"),
            "anchor": item.get("anchor"),
            "amount_line": item.get("amount_line"),
        }
    return None


def extract_income(lines: List[dict], allow_fallback: bool = True) -> Optional[dict]:
    """Locate the family annual income figure inside OCR'd ITR text."""
    if not lines:
        return None

    for pattern, want_total in INCOME_KEYWORDS:
        for index, line in enumerate(lines):
            anchor_match = pattern.search(line["text"])
            if not anchor_match:
                continue
            is_tax_return_header = re.search(
                r"(?:annual\s*income\s*tax|income\s*tax\s*return|tax\s*return)",
                line["text"],
                re.I,
            )
            # A tax-due / tax-rate row is never the income figure, even when
            # its label begins with "Total" - e.g. page 1 of the 1701-MS reads
            # "23 Total Income Tax Due (Sum of Items 21 and 22) 7,580", which
            # the "total income" keyword would otherwise happily match.
            if (
                is_tax_return_header
                or DUE_RE.search(line["text"])
                or NON_INCOME_CONTEXT_RE.search(line["text"])
                or re.search(r"income\s*tax", line["text"], re.I)
                or (
                    not want_total
                    and (
                        ANCHOR_BLOCK_RE.search(line["text"])
                        or len(line["text"]) > ANCHOR_MAX_LEN
                    )
                )
            ):
                continue

            height = max(line["h"], 10.0)
            window: List[dict] = []
            for nxt in lines[index : index + 5]:
                if nxt is not line and pattern.search(nxt["text"]) and want_total:
                    break
                if nxt["y"] - line["y"] > max(height * 3.0, 90.0):
                    break
                window.append(nxt)

            candidates: List[tuple] = []
            due_offsets = {
                i for i, win in enumerate(window) if DUE_RE.search(win["text"])
            }
            excluded_offsets = {
                i for i, win in enumerate(window) if NON_INCOME_CONTEXT_RE.search(win["text"])
            }
            for offset, win in enumerate(window):
                # Skip tax-due/penalty rows AND the amount line under them.
                if (
                    offset in due_offsets
                    or (offset - 1) in due_offsets
                    or offset in excluded_offsets
                    or (offset - 1) in excluded_offsets
                    or (offset + 1) in excluded_offsets
                ):
                    continue
                for value, raw, start in _amounts_in(win):
                    if value < 1000:
                        continue
                    if offset == 0 and start < anchor_match.end():
                        continue
                    if (
                        1900 <= value <= 2099
                        and re.search(r"\b(?:tax\s*year|calendar\s*year|t\.?\s*y\.?)\b", win["text"], re.I)
                    ):
                        continue
                    candidates.append((value, raw, offset, start, win))

            if not candidates:
                continue

            if want_total:
                chosen = min(candidates, key=lambda c: (c[2], c[3]))
            else:
                chosen = max(candidates, key=lambda c: c[0])

            value, raw, offset, _, win = chosen
            scores = [line["score"], win["score"]] if offset else [line["score"]]
            return {
                "value": value,
                "raw": raw,
                "method": pattern.pattern.replace("\\s*", " ").replace("\\s", " "),
                "anchor": line["text"].strip(),
                "amount_line": win["text"].strip(),
                "confidence": round(sum(scores) / len(scores), 4),
                "matched": True,
            }

    if not allow_fallback:
        return None

    # Fallback: biggest comma-grouped amount anywhere on the page.
    # Only reached on the final, full-detail pass - flagged low-confidence so
    # the UI never presents it as a verified figure.
    fallback: List[tuple] = []
    for index, line in enumerate(lines):
        context = lines[max(0, index - 1) : min(len(lines), index + 2)]
        if IGNORE_RE.search(line["text"]) or any(
            NON_INCOME_CONTEXT_RE.search(item["text"]) for item in context
        ):
            continue
        has_group = bool(re.search(r"\d{1,3}(?:,\d{3})+", line["text"]))
        if not has_group or line["score"] < _config.OCR_MIN_CONFIDENCE:
            continue
        for value, raw, _ in _amounts_in(line):
            if value >= 10_000:
                fallback.append((value, raw, line))

    if fallback:
        value, raw, line = max(fallback, key=lambda f: f[0])
        return {
            "value": value,
            "raw": raw,
            "method": "largest_currency_amount",
            "anchor": "",
            "amount_line": line["text"].strip(),
            "confidence": round(line["score"], 4),
            "matched": True,
            "low_confidence": True,
        }

    return None


def match_declared(ocr_value: Optional[float], declared: Optional[float]) -> dict:
    """Compare the OCR figure with the applicant's typed family income."""
    if ocr_value is None or declared is None:
        return {
            "exact_match": False,
            "align_pct": 0.0,
            "diff": None,
            "status": "not_comparable",
        }

    ocr_value = float(ocr_value)
    declared = float(declared)
    diff = abs(ocr_value - declared)
    denominator = max(ocr_value, declared, 1.0)
    align_pct = max(0.0, min(100.0, 100.0 * (1.0 - diff / denominator)))
    return {
        "exact_match": bool(diff < 0.005),
        "align_pct": round(align_pct, 2),
        "diff": round(diff, 2),
        "status": "match" if diff < 0.005 else "mismatch",
    }


_SHARED: Optional["ItrOcr"] = None


def shared() -> "ItrOcr":
    """Process-wide engine singleton (created on first real OCR use)."""
    global _SHARED
    if _SHARED is None:
        _SHARED = ItrOcr()
    return _SHARED


def peek() -> Optional["ItrOcr"]:
    """The engine if it has already been loaded, otherwise None."""
    return _SHARED
