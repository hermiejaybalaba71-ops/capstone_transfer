"""NumPy / Pillow image preprocessing used before OCR.

Every step is intentionally simple and deterministic so the pipeline can be
reproduced exactly and reported in the analytics panel:

1. decode -> RGB uint8 array
2. LANCZOS upscale when the page is small
3. luminance grayscale
4. percentile contrast stretch + z-score normalisation
5. Otsu binarisation
6. projection-profile deskew (bounded)
"""

from __future__ import annotations

import io
from typing import Generator, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageEnhance

from . import config as _config

_LUMA = np.array([0.299, 0.587, 0.114], dtype=np.float32)
MAX_OCR_SIDE = 2800


def decode(source) -> Tuple[np.ndarray, dict]:
    """Bytes | file path | PIL image -> (RGB uint8 array, meta)."""
    if isinstance(source, (bytes, bytearray, memoryview)):
        img = Image.open(io.BytesIO(bytes(source)))
        origin = "bytes"
    elif isinstance(source, Image.Image):
        img = source
        origin = "pillow"
    else:
        img = Image.open(str(source))
        origin = "path"

    source_size = list(img.size)
    if max(img.size) > MAX_OCR_SIDE:
        img.thumbnail((MAX_OCR_SIDE, MAX_OCR_SIDE), Image.LANCZOS)

    meta = {
        "format": img.format or "?",
        "size": source_size,
        "ocr_size": list(img.size),
        "mode": img.mode,
    }
    if img.mode in ("RGBA", "LA", "P"):
        background = Image.new("RGBA", img.size, (255, 255, 255, 255))
        converted = img.convert("RGBA")
        background.paste(converted, mask=converted.split()[-1])
        img = background.convert("RGB")
    elif img.mode != "RGB":
        img = img.convert("RGB")
    return np.asarray(img, dtype=np.uint8), meta


def to_gray(rgb: np.ndarray) -> np.ndarray:
    return (rgb.astype(np.float32) @ _LUMA).astype(np.uint8)


def upscale(rgb: np.ndarray, target_min: int = 1600) -> np.ndarray:
    """LANCZOS upscale tiny pages so OCR gets usable glyph height."""
    h, w = rgb.shape[:2]
    smallest = min(h, w)
    if smallest >= target_min:
        return rgb
    scale = min(6.0, target_min / float(smallest))
    img = Image.fromarray(rgb)
    img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
    img = ImageEnhance.Sharpness(img).enhance(1.4)
    return np.asarray(img, dtype=np.uint8)


def normalize(gray: np.ndarray) -> np.ndarray:
    """Percentile stretch + z-score clamp -> uint8."""
    arr = gray.astype(np.float32)
    lo, hi = np.percentile(arr, 2.0), np.percentile(arr, 98.0)
    if hi - lo < 1e-6:
        hi = lo + 1.0
    arr = (arr - lo) / (hi - lo)
    arr = np.clip(arr, 0.0, 1.0)
    mean, std = float(arr.mean()), float(arr.std())
    if std > 1e-6:
        arr = (arr - mean) / std
        arr = np.clip(arr, -2.5, 2.5)
        arr = (arr + 2.5) / 5.0
    return (arr * 255.0).astype(np.uint8)


def otsu(gray: np.ndarray) -> np.ndarray:
    """Otsu threshold - returns a 0/255 uint8 image."""
    hist = np.bincount(gray.ravel(), minlength=256).astype(np.float64)
    total = hist.sum()
    if total <= 0:
        return gray
    probability = hist / total
    levels = np.arange(256, dtype=np.float64)
    omega = np.cumsum(probability)
    mu = np.cumsum(probability * levels)
    mu_t = mu[-1]
    denom = omega * (1.0 - omega)
    denom[denom == 0] = 1e-12
    sigma_b = (mu_t * omega - mu) ** 2 / denom
    threshold = int(np.argmax(sigma_b))
    return np.where(gray > threshold, 255, 0).astype(np.uint8)


def deskew(gray: np.ndarray, max_deg: float = 4.0, step: float = 1.0) -> Tuple[np.ndarray, float]:
    """Estimate skew from the horizontal projection profile (bounded search)."""
    small = gray
    h, w = gray.shape
    if max(h, w) > 700:
        scale = 700.0 / max(h, w)
        small = np.asarray(
            Image.fromarray(gray).resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.BILINEAR)
        )

    def profile(angle: float) -> float:
        if abs(angle) < 1e-6:
            img = small
        else:
            img = np.asarray(
                Image.fromarray(small).rotate(angle, resample=Image.BILINEAR, fillcolor=255)
            )
        # Row-to-row difference energy: minimised when text lines are level.
        diff = np.abs(np.diff(img.astype(np.int16), axis=0))
        return float(diff.sum())

    best_angle, best_score = 0.0, float("inf")
    angle = -max_deg
    while angle <= max_deg + 1e-9:
        score = profile(angle)
        if score < best_score:
            best_score, best_angle = score, angle
        angle += step

    if abs(best_angle) < 1e-6:
        return gray, 0.0
    rotated = Image.fromarray(gray).rotate(best_angle, resample=Image.BICUBIC, fillcolor=255)
    return np.asarray(rotated, dtype=np.uint8), float(best_angle)


def _to_rgb(gray: np.ndarray) -> np.ndarray:
    return np.repeat(gray[:, :, None], 3, axis=2).astype(np.uint8)


def build_candidates(rgb: np.ndarray, include_deskew: bool = True) -> Generator[dict, None, None]:
    """Ordered preprocessing variants handed to the OCR engine.

    ``original`` is always first (it is what the reference scans already use);
    the rest are built only when requested and tried only when no income value
    is detected, keeping high-resolution image variants out of memory together.
    """
    yield {"name": "original", "array": rgb, "steps": ["decode"]}
    max_candidates = _config.OCR_MAX_VARIANTS + 1
    yielded = 1
    if yielded >= max_candidates:
        return

    upscaled = upscale(rgb)
    if upscaled.shape[:2] != rgb.shape[:2]:
        if yielded >= max_candidates:
            return
        yielded += 1
        yield {
            "name": "upscale+sharpen",
            "array": upscaled,
            "steps": ["lanczos_upscale", "sharpen"],
        }

    gray = to_gray(upscaled)
    del upscaled
    normalized = normalize(gray)
    if yielded >= max_candidates:
        return
    yielded += 1
    contrast = _to_rgb(normalized)
    yield {
        "name": "grayscale+contrast",
        "array": contrast,
        "steps": ["grayscale", "percentile_stretch", "zscore"],
    }
    del contrast

    if yielded >= max_candidates:
        return
    yielded += 1
    binary = otsu(normalized)
    otsu_rgb = _to_rgb(binary)
    del binary, normalized
    yield {
        "name": "grayscale+otsu",
        "array": otsu_rgb,
        "steps": ["grayscale", "percentile_stretch", "otsu_threshold"],
    }
    del otsu_rgb

    if include_deskew:
        if yielded >= max_candidates:
            return
        deskewed, angle = deskew(gray)
        del gray
        if abs(angle) >= 0.5:
            yielded += 1
            deskew_candidate = _to_rgb(normalize(deskewed))
            yield {
                "name": f"deskew {angle:+.1f}deg",
                "array": deskew_candidate,
                "steps": ["grayscale", f"deskew({angle:+.1f})", "percentile_stretch"],
            }


def image_stats(rgb: np.ndarray) -> dict:
    gray = to_gray(rgb)
    return {
        "width": int(rgb.shape[1]),
        "height": int(rgb.shape[0]),
        "megapixels": round(rgb.shape[0] * rgb.shape[1] / 1_000_000.0, 2),
        "mean_luma": round(float(gray.mean()), 1),
        "std_luma": round(float(gray.std()), 1),
    }
