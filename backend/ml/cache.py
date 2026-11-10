"""Disk cache for OCR results.

A page costs ~10-50 s to recognise on this hardware, so every document is
remembered by ``path + size + updated_at``. Re-running the scan (or running
the ranking step with previously scanned documents) then costs milliseconds.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Dict, Optional

from . import config as _config

CACHE_PATH = _config.MODEL_DIR / "ocr_cache.json"
VERSION = 9


def _key(path: str, size, updated_at) -> str:
    return f"{path}|{size or 0}|{updated_at or 0}|v{VERSION}"


def load() -> Dict[str, dict]:
    try:
        if CACHE_PATH.is_file():
            data = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict) and data.get("_v") == VERSION:
                return {k: v for k, v in data.items() if k != "_v"}
    except (OSError, ValueError):
        pass
    return {}


def save(entries: Dict[str, dict]) -> None:
    try:
        _config.MODEL_DIR.mkdir(parents=True, exist_ok=True)
        payload = {"_v": VERSION, **entries}
        CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass  # a read-only install must not break the scan


def get(path: str, size, updated_at) -> Optional[dict]:
    return load().get(_key(path, size, updated_at))


def put(path: str, size, updated_at, record: dict) -> None:
    entries = load()
    entries[_key(path, size, updated_at)] = record
    save(entries)


def clear() -> int:
    entries = load()
    try:
        CACHE_PATH.unlink()
    except OSError:
        pass
    return len(entries)
