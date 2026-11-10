"""Optional historical training data from CSV / Excel.

Sources, in priority order:

1. The school's uploaded file in the ``training-data`` Supabase Storage
   bucket (``historical/training_data.csv`` or ``.xlsx``) — admins upload
   real past scholarship applications from the Ranking page.
2. ``ml/training_data.csv`` or ``ml/training_data.xlsx`` shipped with the
   repo (small sample used when nothing is uploaded).

Rows join every training run alongside the seeded synthetic population and
the current run's real applicants:

    synthetic rows + historical rows + real applicant rows -> RandomForest fit

Required column: annual income. Everything else is optional.

    annual_income,year_level,sex,gwa,gpa,ocr_match_pct,has_itr
    120000,3,Female,1.55,,99.2,yes
    450000,1,Male,,3.10,88.0,no

Header aliases are accepted (income, family_income, gender, grade, ...).
Values may carry currency symbols and thousands separators
("PHP 120,000.00" parses as 120000.0).

For the optional historical-data path, missing data is non-fatal:

* A file without an income column (or a row without a usable income) still
  contributes every other recognized column as a *neutral* row (need score
  50, the default income baseline). Only rows with no income column AND no
  other recognized column are dropped.

Colab-aligned training is stricter: it requires usable annual family income
and an observed NPCINC label for each uploaded row.
"""

from __future__ import annotations

import csv
import io
import math
import tempfile
from pathlib import Path
from typing import Dict, List, Optional

from . import config as _config
from . import features as _features

TRAINING_CSV = _config.ML_DIR / "training_data.csv"
TRAINING_XLSX = _config.ML_DIR / "training_data.xlsx"
STORAGE_BUCKET = "training-data"
STORAGE_PREFIX = "historical/"

_ALIASES = {
    "income": ("annual_income", "income", "family_income", "total_family_annual_income",
               "family_annual_income", "yearly_income", "declared_income", "amount",
               "annual_income_family", "total_family_income",
               # PSA FIES PUF: TOINC = total annual family income
               "toinc", "total_income"),
    # PSA FIES PUF: NPCINC = net per-capita income decile (1-10). The Colab
    # notebook's target is `NPCINC <= 4` -> low-income priority.
    "npcinc": ("npcinc", "net_per_capita_income", "per_capita_income", "npc_inc"),
    "year_level": ("year_level", "year", "level", "grade_level", "year_lvl"),
    "sex": ("sex", "gender"),
    "gwa": ("gwa", "shs_gwa", "senior_high_gwa"),
    "gpa": ("gpa", "college_gpa", "tertiary_gpa"),
    "ocr_match_pct": ("ocr_match_pct", "ocr_match", "match_pct", "ocr_pct"),
    "has_itr": ("has_itr", "itr", "has_itr_upload", "itr_uploaded",
                "income_tax_return", "itr_path", "itr_file"),
    "student_name": ("student_name", "name", "full_name", "applicant"),
    # --- statutory priority columns (the preprocessed historical TES file) ---
    "pwd_flag": ("pwd_flag", "pwd", "disability_flag", "has_disability",
                 "person_with_disability", "disability"),
    "ip_flag": ("ip_flag", "indigenous_flag", "indigenous_people", "is_ip",
                "indigenous_people_group", "ip"),
    "solo_parent": ("solo_parent", "solo_parent_flag", "is_solo_parent",
                    "dependent_child_of_solo_parent", "solo"),
    "first_gen": ("first_gen", "first_generation", "first_gen_flag",
                  "first_generation_college_student", "firstgen"),
    "is_4ps": ("is_4ps", "four_ps", "4ps", "fourps_flag", "is_4ps_member",
               "ps_ncct", "4ps_id"),
    "age": ("age", "applicant_age", "age_years"),
    "program": ("program", "course", "program_name", "complete_program",
                "complete_program_name"),
    # Household size (PSA FIES PUF: FSIZE) and per-capita income (PERCAPITA).
    # The label NPCINC is a per-capita decile, so the household size is what
    # turns a flat ~75% income-only model into a ~97%+ one.
    # NOTE: "per_capita_income" is NOT listed here on purpose - that header is
    # already claimed by the NPCINC *label* above.
    "fsize": ("fsize", "family_size", "hhsize", "household_size", "size_of_family",
              "size_of_household", "number_of_members", "no_of_members",
              "n_members", "members", "family_members"),
    "per_capita": ("percapita", "per_capita", "pc_income", "income_per_capita",
                   "pcinc", "per_capita_amount"),
}

# Columns that make up a row's identity for de-duplication when the file
# carries no explicit student id / name / timestamp column (the FIES workbook
# has none). Two rows that agree on every one of these are the same record
# copied twice, not two different households.
_SIGNATURE_FIELDS = (
    "annual_income_family", "family_size", "per_capita_income",
    "year_level_num", "sex_code", "academic_norm", "age_norm", "program_code",
    "pwd_flag", "ip_flag", "solo_parent_flag", "first_gen_flag", "four_ps_flag",
    "npcinc",
)


def _canonical(header: str) -> str:
    return header.strip().lower().replace("-", "_").replace(" ", "_")


def _resolve(header_map: Dict[str, str]) -> Dict[str, Optional[str]]:
    """canonical field -> actual CSV column name present in the file."""
    resolved: Dict[str, Optional[str]] = {}
    for field, names in _ALIASES.items():
        resolved[field] = next((header_map[n] for n in names if n in header_map), None)
    return resolved


def _money(value) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    for token in ("php", "peso", "₱", "p", "per", "year", "annum", "annual"):
        text = text.replace(token, "")
    text = text.replace(",", "").replace(" ", "").strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1]
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number >= 0 else None


def _num(value) -> Optional[float]:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number > 0 else None


def _isnan(value) -> bool:
    return isinstance(value, float) and math.isnan(value)


def _flag(value, default: bool) -> bool:
    if value is None:
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    if text in ("no", "n", "false", "0", "none", "-"):
        return False
    if text in ("yes", "y", "true", "1"):
        return True
    return default


def row_from(record: Dict[str, str], resolved: Dict[str, Optional[str]], income_ranked: bool = False) -> Optional[Dict]:
    """One CSV record -> the same feature-row shape the forests train on.

    A record with no usable income is kept as a *neutral* row (need score 50,
    default income baseline) whenever any other column is recognized, so
    historical files without income data still join every training run.
    Only records with no income AND no other recognized column are dropped.
    """
    raw_income = record.get(resolved["income"], "") if resolved["income"] else ""
    income = _money(raw_income)

    priority_fields = ("year_level", "sex", "gwa", "gpa", "ocr_match_pct", "has_itr",
                       "pwd_flag", "ip_flag", "solo_parent", "first_gen", "is_4ps",
                       "age", "program", "fsize", "per_capita")
    has_other = any(resolved.get(field) for field in priority_fields)
    if income is None and not has_other:
        return None

    gwa = _num(record.get(resolved["gwa"], "")) if resolved["gwa"] else None
    gpa = _num(record.get(resolved["gpa"], "")) if resolved["gpa"] else None

    year_text = record.get(resolved["year_level"], "") if resolved["year_level"] else ""
    sex_text = record.get(resolved["sex"], "") if resolved["sex"] else ""

    def text_of(field: str):
        return record.get(resolved[field], "") if resolved[field] else None

    # A file without an income column carries no ITR data either - those rows
    # are the school's historical records, not scanned documents.
    itr_default = bool(resolved["income"])
    ocr_default = 100.0 if _flag(record.get(resolved["has_itr"], "") if resolved["has_itr"] else None, itr_default) else 0.0
    raw_pct = _num(record.get(resolved["ocr_match_pct"], "")) if resolved["ocr_match_pct"] else None
    ocr_pct = float(min(max(raw_pct, 0.0), 100.0)) if raw_pct is not None else ocr_default

    has_itr = 1.0 if _flag(record.get(resolved["has_itr"], "") if resolved["has_itr"] else None, itr_default) else 0.0
    if has_itr < 0.5:
        ocr_pct = 0.0

    # Household size + per-capita income: FSIZE from the file, else the
    # explicit PERCAPITA column, else NaN (median-imputed at scoring time).
    family = _features.family_size(text_of("fsize"))
    per_capita = _features.per_capita_income(income, family)
    if _isnan(per_capita) and resolved.get("per_capita"):
        raw_pc = _money(record.get(resolved["per_capita"], ""))
        if raw_pc is not None and raw_pc > 0:
            per_capita = round(float(raw_pc), 2)
    if income is not None and _isnan(per_capita):
        # Same neutral household size live applicants fall back to, so the
        # forest sees one consistent per-capita rule at train and score time.
        per_capita = _features.per_capita_income(income, _features.DEFAULT_FAMILY_SIZE)

    row = {
        "declared_income": income,
        "family_size": family,
        "per_capita_income": per_capita,
        "financial_need_score": _features.financial_need_score(income),
        "ocr_match_pct": round(ocr_pct, 2),
        "income_log": _features.income_log(income),
        "has_itr": has_itr,
        "ocr_verified": 1.0 if ocr_pct > 0 else 0.0,
        "year_level_num": _features.year_level_num(year_text),
        "sex_code": _features.sex_code(sex_text),
        "academic_norm": _features.academic_norm(gwa, gpa),
        # statutory priority flags (blank / junk answer = no declared flag)
        "pwd_flag": _features.flag_value(text_of("pwd_flag")),
        "ip_flag": _features.flag_value(text_of("ip_flag"), non_ip=True),
        "solo_parent_flag": _features.flag_value(text_of("solo_parent")),
        "first_gen_flag": _features.flag_value(text_of("first_gen")),
        "four_ps_flag": _features.flag_value(text_of("is_4ps")),
        "age_norm": _features.age_norm(text_of("age")),
        "program_code": _features.program_code(text_of("program")),
        # PSA FIES / BIR TRAIN / CHED income features (Colab training set)
        "annual_income_family": income if income is not None else float("nan"),
        "monthly_income_equiv": _features.monthly_income_equiv(income),
        "is_train_tax_exempt": _features.is_train_tax_exempt(income),
        "is_ched_priority_ceiling": _features.is_ched_priority_ceiling(income),
        "itr_income_bracket": _features.itr_income_bracket(income),
        "source": "csv",
    }
    if income is None:
        row["income_missing"] = True
    if math.isnan(row["academic_norm"]):
        row["academic_norm"] = None
    # Colab-aligned training maps the observed NPCINC decile to the target.
    if income_ranked and income is not None:
        row["income_ranked"] = True
        # Colab notebook target: `NPCINC <= 4` -> Prioritized (1), else Waitlisted
        # (0). Expressed on the 0-100 scale the forests already learn, where the
        # classifier calls >= 55.0 "High Need".
        npcinc = _num(record.get(resolved["npcinc"], "")) if resolved.get("npcinc") else None
        if npcinc is not None:
            row["npcinc"] = npcinc
            row["notebook_target"] = 1 if npcinc <= 4 else 0
            row["target_source"] = "npcinc"
            # The notebook's exact label: NPCINC <= 4 -> Prioritized (1).
            # Expressed on the 0-100 scale the forests learn, where the
            # classifier calls >= 55.0 "High Need".
            row["priority_target"] = 100.0 if npcinc <= 4 else 0.0
    if "priority_target" not in row:
        row["priority_target"] = _features.priority_target(row)
    row.setdefault("target_source", "income_proxy")
    row["priority_bonus"], row["priority_bonus_parts"] = _features.priority_flags(row)
    return row


def _read_records(csv_path: Path) -> tuple[List[Dict[str, str]], List[str]]:
    """Read CSV or Excel (.xlsx) into row dicts keyed by header text."""
    if csv_path.suffix.lower() == ".xlsx":
        try:
            from openpyxl import load_workbook
        except ImportError:
            return [], ["openpyxl is not installed - cannot read .xlsx (save the sheet as CSV instead)"]
        try:
            book = load_workbook(csv_path, read_only=True, data_only=True)

            # Pick the sheet that actually holds the data. A PSA FIES workbook
            # ships a DICTIONARY sheet first and the household records second
            # (FIES_PUF_2025), so blindly using book.active reads the wrong one
            # and reports "no income column". Choose the first sheet whose
            # header carries an income column; otherwise the widest sheet.
            def sheet_header(ws):
                for values in ws.iter_rows(min_row=1, max_row=1, values_only=True):
                    return ["" if c is None else str(c).strip() for c in values]
                return []

            income_keys = {_canonical(a) for a in _ALIASES["income"]}
            chosen = None
            widest = None
            for ws in book.worksheets:
                head = sheet_header(ws)
                canon = {_canonical(h) for h in head if h}
                if income_keys & canon:
                    chosen = ws
                    break
                if widest is None or len(head) > len(widest[1]):
                    widest = (ws, head)
            sheet = chosen or (widest[0] if widest else book.active)

            rows_iter = sheet.iter_rows(values_only=True)
            header = ["" if cell is None else str(cell).strip() for cell in next(rows_iter, []) or []]
            records: List[Dict[str, str]] = []
            for values in rows_iter:
                cells = ["" if cell is None else str(cell) for cell in values]
                if not any(cell.strip() for cell in cells):
                    continue
                records.append({h: c for h, c in zip(header, cells) if h})
            book.close()
            return records, []
        except OSError as exc:
            return [], [f"training workbook unreadable: {exc}"]

    try:
        text = csv_path.read_text(encoding="utf-8-sig")
    except OSError as exc:
        return [], [f"training CSV unreadable: {exc}"]
    if not text.strip():
        return [], []

    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel

    reader = csv.reader(io.StringIO(text), dialect)
    try:
        header = next(reader)
    except StopIteration:
        return [], []
    header = [cell.strip() for cell in header]

    records = []
    for values in reader:
        if not any(cell.strip() for cell in values):
            continue
        records.append({h: c for h, c in zip(header, values) if h})
    return records, []


def _download_uploaded() -> Optional[Path]:
    """Fetch the admin-uploaded historical file from Supabase Storage.

    Returns a local temp path (.csv or .xlsx) or None when nothing is
    uploaded / storage is unreachable. Never raises.
    """
    try:
        from . import storage as _storage
    except Exception:
        return None
    try:
        files = _storage.list_all(STORAGE_BUCKET, STORAGE_PREFIX)
    except Exception:
        return None
    target = next(
        (f for f in files if f["path"].lower().endswith((".csv", ".xlsx"))),
        None,
    )
    if not target:
        return None
    try:
        data = _storage.download(STORAGE_BUCKET, target["path"])
    except Exception:
        return None
    suffix = ".xlsx" if target["path"].lower().endswith(".xlsx") else ".csv"
    handle = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, prefix="historical_")
    handle.write(data)
    handle.close()
    return Path(handle.name)


def downloaded_upload_path() -> Optional[Path]:
    """Public handle on :func:`_download_uploaded` for the row-count report.

    Returns the very same file the training run will read - the caller owns
    the temp file and should delete it when done.
    """
    return _download_uploaded()


def uploaded_file_identity() -> Optional[Dict[str, object]]:
    """Name / size / updated_at of the admin's current training upload.

    Recorded into the saved model payload so a later ranking run can tell
    whether the deployed forest was trained on *this exact file*. When they
    match, ranking reuses the saved model instead of refitting from scratch -
    that is what makes "train once, rank automatically" work.
    """
    try:
        from . import storage as _storage
    except Exception:
        return None
    try:
        files = _storage.list_all(STORAGE_BUCKET, STORAGE_PREFIX)
    except Exception:
        return None
    target = next(
        (f for f in files if f["path"].lower().endswith((".csv", ".xlsx"))),
        None,
    )
    if not target:
        return None
    return {
        "name": target["path"].rsplit("/", 1)[-1],
        "path": target["path"],
        "size": int(target.get("size") or 0),
        "updated_at": target.get("updated_at"),
    }


def load_training_csv(
    path: Optional[Path] = None,
    income_ranked: bool = False,
    uploaded_only: bool = False,
) -> tuple[List[Dict], List[str]]:
    """Read the historical training file (uploaded, or the bundled sample).

    Set ``income_ranked=True`` for Colab-aligned training: rows are labelled
    from the uploaded ``NPCINC`` value (deciles 1-4 are prioritized).
    Set ``uploaded_only=True`` to prevent the train-only run from silently
    falling back to the bundled sample when the admin upload is unavailable.
    Returns (rows, warnings); never raises.
    """
    temp_path: Optional[Path] = None
    if path:
        csv_path: Optional[Path] = Path(path)
    else:
        temp_path = _download_uploaded()
        if temp_path is not None:
            csv_path = temp_path
        elif uploaded_only:
            return [], [
                "No uploaded training file was found in Supabase Storage. "
                "Upload the PSA FIES workbook or a school historical applications file first."
            ]
        elif TRAINING_CSV.is_file():
            csv_path = TRAINING_CSV
        elif TRAINING_XLSX.is_file():
            csv_path = TRAINING_XLSX
        else:
            csv_path = None
    try:
        if csv_path is None or not csv_path.is_file():
            return [], []

        records, warnings = _read_records(csv_path)
        if warnings and not records:
            return [], warnings
        if not records:
            return [], []

        header_map = {_canonical(name): name for name in records[0].keys() if name.strip()}
        resolved = _resolve(header_map)
        if not resolved["income"]:
            warnings.append(
                "training data has no income column — every row is kept with a neutral need score "
                "plus its statutory priority flags (accepted income headers: "
                f"{', '.join(_ALIASES['income'])})"
            )

        rows: List[Dict] = []
        seen: set = set()
        feature_seen: set = set()
        duplicates = 0
        neutral = 0
        # identity columns = what makes a row a *person* (for de-duplication)
        identity_cols = [
            name for key, name in header_map.items()
            if key in ("student_id", "student_number", "id", "sid", "lrn", "philsys",
                       "timestamp", "date_submitted", "email", "email_address",
                       "contact", "contact_number", "phone", "student_name", "name")
        ]
        for index, record in enumerate(records, start=2):
            row = row_from(record, resolved, income_ranked=income_ranked)
            if row is None:
                warnings.append(f"training data line {index}: skipped (nothing usable)")
                continue
            # same de-duplication the preprocessing pipeline applies: identical
            # feature vectors are counted once so a duplicated student cannot
            # bias the Random Forest.
            # De-duplication, same rule as the preprocessing pipeline: only a
            # repeated *identity* (student id / name / timestamp / contact
            # found in the file) is a duplicate. Two different students who
            # happen to share every feature are both kept - and a file that
            # carries no identity column at all was already de-duplicated
            # upstream (preprocess_tes_form.py), so nothing is dropped here.
            if identity_cols:
                signature = tuple(
                    str(record.get(col, "")).strip().lower() for col in identity_cols
                )
                if signature in seen:
                    duplicates += 1
                    continue
                seen.add(signature)
            else:
                # No identity column in the file (the FIES workbook has none):
                # fall back to an exact feature-vector signature. Two rows that
                # agree on income, household size, per-capita income, the
                # demographics and the NPCINC label are the same record copied
                # twice - the workbook ships ~69 of them and keeping them would
                # over-weight those households in the fit.
                signature = tuple(str(row.get(field, "")) for field in _SIGNATURE_FIELDS)
                if signature in feature_seen:
                    duplicates += 1
                    continue
                feature_seen.add(signature)
            if row.get("income_missing"):
                neutral += 1
                if neutral <= 3:
                    warnings.append(
                        f"training data line {index}: no income value — row kept "
                        "with a neutral need score (statutory priority flags still apply)"
                    )
            rows.append(row)
        if duplicates:
            warnings.append(
                f"Preprocessing: {duplicates} duplicate row(s) removed — "
                f"{len(rows)} unique training row(s) kept."
            )
        if neutral:
            warnings.append(
                f"{neutral} of {len(rows)} training row(s) have no income — "
                "they contribute their other columns with a neutral need score;"
                " ranking still works normally for applicants."
            )

        # --- data-quality summary (surfaced in the train panel log) ---------
        incomes = [
            float(row["annual_income_family"])
            for row in rows
            if row.get("annual_income_family") is not None
            and not _isnan(row["annual_income_family"])
        ]
        if incomes:
            ordered = sorted(incomes)
            above_5m = sum(1 for value in ordered if value > 5_000_000)
            warnings.append(
                "Income range check: "
                f"{ordered[0]:,.0f} to {ordered[-1]:,.0f} PHP "
                f"(median {ordered[len(ordered) // 2]:,.0f}); "
                f"{above_5m} row(s) above 5,000,000 PHP are kept and folded into "
                "the top income bracket."
            )
        sized = sum(
            1 for row in rows
            if row.get("family_size") is not None and not _isnan(row.get("family_size"))
        )
        if rows:
            warnings.append(
                f"Family size present on {sized} of {len(rows)} training row(s); "
                f"{len(rows) - sized} row(s) fall back to the trained model's median "
                "household size at scoring time."
            )
        if duplicates == 0 and len(rows) > 1:
            warnings.append(
                "Duplicate check: no repeated records were found in the training file."
            )

        return rows, warnings
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink()
            except OSError:
                pass


def load_count() -> int:
    return len(load_training_csv()[0])
