# -*- coding: utf-8 -*-
"""Row report for the uploaded training file - counts only, never values.

Prints ONE JSON object describing the file the admin is about to train on:
how many data rows it has, which columns it carries, and how many rows carry
the two columns Colab-aligned training requires (TOINC + NPCINC).

Privacy contract: this report deliberately contains NO row values, no sample
rows, no min/max and no averages - only counts and column names. The panel
must be able to say "10,006 rows, TOINC on 10,006, NPCINC on 10,006" so the
admin can confirm the upload, without a single household record leaving the
server.

Run:  python rows_report.py [optional-local-file-path]
"""

from __future__ import annotations

import csv as _csv
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

# backend/ on sys.path so `from ml import ...` works when run as a script.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Columns the admin needs confirmation for. Case-insensitive header match.
TRACKED_COLUMNS = ("TOINC", "NPCINC", "FSIZE", "PERCAPITA")


def _header_index(header: List[object]) -> Dict[str, int]:
    index: Dict[str, int] = {}
    for position, cell in enumerate(header):
        name = str(cell).strip().upper() if cell is not None else ""
        if name and name not in index:
            index[name] = position
    return index


def _has(value: object) -> bool:
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    try:  # numpy / openpyxl numerics, NaN
        return value == value and str(value) != ""
    except Exception:
        return True


def _looks_like_header(row: List[object]) -> bool:
    names = {str(cell).strip().upper() for cell in row if cell is not None}
    return "TOINC" in names and "NPCINC" in names


def _report(
    *,
    file_name: str,
    file_size: int,
    sheet: str,
    rows: int,
    headers: List[str],
    populated: Dict[str, int],
    trainable: int,
    warnings: List[str],
) -> Dict:
    return {
        "available": True,
        "file": file_name,
        "size": file_size,
        "sheet": sheet,
        "rows": rows,
        "columns": len(headers),
        "headers": headers,
        "populated": populated,
        "trainable_rows": trainable,
        "required": ["TOINC", "NPCINC"],
        "warnings": warnings,
    }


def _scan_openpyxl(path: Path) -> Optional[Dict]:
    from openpyxl import load_workbook

    book = load_workbook(path, read_only=True, data_only=True)
    try:
        # Prefer the sheet whose header row actually carries TOINC + NPCINC,
        # so a workbook with a DICTIONARY tab in front still reports the data.
        chosen = None
        header_row: Optional[List[object]] = None
        for sheet_name in book.sheetnames:
            worksheet = book[sheet_name]
            first = next(worksheet.iter_rows(min_row=1, max_row=1, values_only=True), None)
            if first and _looks_like_header(list(first)):
                chosen = worksheet
                header_row = list(first)
                break
        if chosen is None:
            if not book.sheetnames:
                return None
            chosen = book[book.sheetnames[0]]
            header_row = next(
                (list(row) for row in chosen.iter_rows(min_row=1, max_row=3, values_only=True) if row),
                None,
            )
        if header_row is None:
            return None

        index = _header_index(header_row)
        tracked = {name: index[name] for name in TRACKED_COLUMNS if name in index}
        counts = {name: 0 for name in tracked}
        trainable = 0
        rows = 0
        for row in chosen.iter_rows(min_row=2, values_only=True):
            if not any(_has(cell) for cell in row):
                continue
            rows += 1
            for name, position in tracked.items():
                if _has(row[position] if position < len(row) else None):
                    counts[name] += 1
            if "TOINC" in tracked and "NPCINC" in tracked:
                toinc = row[tracked["TOINC"]] if tracked["TOINC"] < len(row) else None
                npcinc = row[tracked["NPCINC"]] if tracked["NPCINC"] < len(row) else None
                if _has(toinc) and _has(npcinc):
                    trainable += 1
        headers = [str(cell).strip() if cell is not None else "" for cell in header_row]
        return _report(
            file_name=path.name,
            file_size=path.stat().st_size,
            sheet=chosen.title,
            rows=rows,
            headers=headers,
            populated=counts,
            trainable=trainable,
            warnings=[],
        )
    finally:
        try:
            book.close()
        except Exception:
            pass


def _scan_csv(path: Path) -> Dict:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = _csv.reader(handle)
        header = next(reader, None)
        if not header:
            return {
                "available": False,
                "file": path.name,
                "error": "The CSV file has no header row.",
            }
        index = _header_index(header)
        tracked = {name: index[name] for name in TRACKED_COLUMNS if name in index}
        counts = {name: 0 for name in tracked}
        trainable = 0
        rows = 0
        for row in reader:
            if not any(cell.strip() for cell in row):
                continue
            rows += 1
            for name, position in tracked.items():
                if _has(row[position] if position < len(row) else None):
                    counts[name] += 1
            if "TOINC" in tracked and "NPCINC" in tracked:
                if _has(row[tracked["TOINC"]]) and _has(row[tracked["NPCINC"]]):
                    trainable += 1
    return _report(
        file_name=path.name,
        file_size=path.stat().st_size,
        sheet="csv",
        rows=rows,
        headers=[str(cell).strip() for cell in header],
        populated=counts,
        trainable=trainable,
        warnings=[],
    )


def main() -> int:
    from ml import csv_data

    supplied = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    identity = None if supplied else csv_data.uploaded_file_identity()
    path = supplied if supplied else csv_data.downloaded_upload_path()

    if path is None:
        print(
            json.dumps(
                {
                    "available": False,
                    "error": "No training file is uploaded yet. Upload a CSV / Excel file first.",
                }
            )
        )
        return 0

    try:
        report = _scan_csv(path) if path.suffix.lower() == ".csv" else _scan_openpyxl(path)
    except Exception as exc:  # never crash the panel - report why instead
        print(json.dumps({"available": False, "file": path.name, "error": str(exc)}))
        return 0

    if report is None:
        print(
            json.dumps(
                {
                    "available": False,
                    "file": path.name,
                    "error": "No sheet with a TOINC + NPCINC header row was found.",
                }
            )
        )
        return 0

    if not supplied:
        # The temp download was only needed to read it - clean it up.
        try:
            path.unlink()
        except OSError:
            pass

    # Report the *uploaded* name and timestamp (not the temp file's), so the
    # panel can key its cache to exactly the file the training run will read.
    if identity:
        report["file"] = identity.get("name") or report["file"]
        report["updated_at"] = identity.get("updated_at")
        report["size"] = identity.get("size") or report["size"]

    if "TOINC" not in {name.upper() for name in report["headers"]}:
        report.setdefault("warnings", []).append("No TOINC column - annual family income cannot be read.")
    if "NPCINC" not in {name.upper() for name in report["headers"]}:
        report.setdefault("warnings", []).append(
            "No NPCINC column - Colab-aligned training needs it for the target label."
        )

    print(json.dumps(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
