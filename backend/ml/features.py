"""Feature engineering: financial need score, OCR match percentage, encoding.

Everything is plain NumPy so the feature matrix, the imputation statistics and
the final ranking can all be reported in the analytics panel.
"""

from __future__ import annotations

import datetime as dt
import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

from . import config as _config

FEATURE_COLUMNS: List[str] = [
    "financial_need_score",   # 0-100, higher = poorer
    "income_log",             # log1p(income) scaled to 0-1
    "has_itr",                # 1 when an ITR document exists
    "year_level_num",         # 1..5
    "sex_code",               # 0 male / 1 female / 2 unknown
    # --- statutory priority flags (from the preprocessed historical data) ---
    "pwd_flag",               # 1 = person with disability (RA 7277)
    "ip_flag",                # 1 = indigenous peoples member (RA 8371)
    "solo_parent_flag",       # 1 = solo-parent dependent (RA 8972)
    "four_ps_flag",           # 1 = 4Ps member (DSWD poverty indicator)
    "first_gen_flag",         # 1 = first-generation college student (CHED)
    "age_norm",               # (age - 15) / 30 clipped to 0-1 (NaN when unknown)
    "program_code",           # coarse program family index 0..7 (NaN when unknown)
    # --- PSA FIES 2025 income features (the Colab notebook's training set) ---
    "annual_income_family",       # raw annual family income in pesos (TOINC)
    "monthly_income_equiv",       # annual_income_family / 12
    "is_train_tax_exempt",        # 1 when income <= 250,000 (BIR TRAIN Law)
    "is_ched_priority_ceiling",   # 1 when income <= 400,000 (CHED ceiling)
    "itr_income_bracket",         # 1..7 income band from the FIES brackets
    "family_size",               # household members (FIES FSIZE), NaN when unknown
    "per_capita_income",         # annual_income_family / family_size
]

# The Colab notebook's training set, in its exact order. The train-only
# "Execute Training Data" run fits on these columns and nothing else, so a
# file trained here and a file trained in Colab see identical X.
#
# EXACTLY the five columns of the panel's notebook (spc_scholarship_ml_
# training): income-derived features only. The label (NPCINC <= 4) is a
# per-capita income decile, so a model on these five columns tops out near
# ~74% accuracy; that trade-off is accepted so the notebook and the app stay
# literally identical code.
NOTEBOOK_FEATURE_COLUMNS: List[str] = [
    "annual_income_family",
    "monthly_income_equiv",
    "is_train_tax_exempt",
    "is_ched_priority_ceiling",
    "itr_income_bracket",
]

# Neutral household size (PSA FIES mean = 4.07 persons). Used ONLY when an
# applicant did not answer the Family Size field, so their per-capita income
# still follows their declared income (income / 4) instead of collapsing to
# the dataset's median per-capita income - which would make every applicant
# who skipped the field look equally poor.
DEFAULT_FAMILY_SIZE = 4.0

# Text in a priority field that does NOT mean the flag applies. Blanks, "N/A",
# religion and ethnolinguistic (non-IP) answers collected during cleaning.
_FLAG_NO = {
    "", "0", "no", "n", "false", "none", "n/a", "na", "n.a", "n.a.", "-", ".",
    "_", "*", "nil", "null", "wala", "nope", "nothing", "not applicable",
    "unknown", "?", "no ip", "no-ip", "not indigenous", "no disability",
    "normal", "healthy", "ok", "good", "working student", "tuition",
}
_NON_IP_WORDS = {
    "cebuano", "bisaya", "binisaya", "bisdak", "waray", "iliganon", "ilonggo",
    "tagalog", "bicolano", "ilocano", "pangasinense", "kampampangan",
    "kapampangan", "iganon", "filipino", "pilipino", "muslim", "islam",
    "christian", "catholic", "roman catholic", "religion", "mixed", "other",
    "moro", "mindanao", "dili", "dont know", "don't know",
}

# Program name -> family index (same mapping for historical rows and the
# live applicants, so the encoding can never drift between the two).
_PROGRAM_FAMILIES = (
    ("information technology", "computer", "information system", "software"),
    ("engineering",),
    ("education",),
    ("criminology", "criminal justice"),
    ("business", "management", "accountancy", "economics", "entrepreneur", "hospitality", "tourism"),
    ("nursing", "medical", "health", "pharmacy", "therapy", "psychology"),
    ("maritime", "fisheries", "agriculture", "forestry", "veterinary", "food technology"),
)


def flag_value(value, non_ip: bool = False) -> float:
    """Declared priority text -> 0.0 / 1.0.

    "0"/"No"/blank/junk -> 0.0, "1"/"Yes" or any real value (a disability
    type, an indigenous group name) -> 1.0. Religion and non-IP
    ethnolinguistic answers never set ``non_ip`` flags. Unknown = 0.0, which
    matches how the preprocessed historical file treats a blank answer.
    """
    if value is None:
        return 0.0
    text = " ".join(str(value).split()).strip().lower().strip(" .,;:-")
    if text in _FLAG_NO:
        return 0.0
    if non_ip and (text in _NON_IP_WORDS or any(text.startswith(w + " ") for w in _NON_IP_WORDS)):
        return 0.0
    if len(text) > 60:  # an address or a sentence got past the form validation
        return 0.0
    return 1.0


def age_norm(value) -> float:
    """Age in years -> 0..1 (15 = 0.0, 45 = 1.0). NaN when unknown."""
    if value is None or str(value).strip() == "":
        return float("nan")
    try:
        age = float(str(value).strip())
    except (TypeError, ValueError):
        return float("nan")
    if not (10.0 <= age <= 70.0):
        return float("nan")
    return float(np.clip((age - 15.0) / 30.0, 0.0, 1.0))


def program_code(value) -> float:
    """Program / course name -> family index 0..7. NaN when unknown."""
    text = " ".join(str(value or "").split()).lower()
    if not text:
        return float("nan")
    for index, keywords in enumerate(_PROGRAM_FAMILIES):
        if any(keyword in text for keyword in keywords):
            return float(index)
    return float(len(_PROGRAM_FAMILIES))


def financial_need_score(income: Optional[float]) -> float:
    """Annual family income -> 0..100 need score (100 = most needed)."""
    if income is None:
        return 50.0
    value = float(income)
    span = _config.INCOME_CEIL - _config.INCOME_FLOOR
    score = 100.0 * (_config.INCOME_CEIL - value) / span
    return round(float(np.clip(score, 0.0, 100.0)), 2)


def year_level_num(value: Optional[str]) -> float:
    if not value:
        return 0.0
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    return float(int(digits)) if digits and 1 <= int(digits) <= 5 else 0.0


def sex_code(value: Optional[str]) -> float:
    text = (value or "").strip().lower()
    if text.startswith("m"):
        return 0.0
    if text.startswith("f"):
        return 1.0
    return 2.0


def academic_norm(gwa: Optional[float], gpa: Optional[float]) -> float:
    """College GPA (4.0 scale) wins, otherwise SHS GWA (100 scale)."""
    if gpa is not None and not math.isnan(gpa) and gpa > 0:
        return float(np.clip(gpa / 4.0, 0.0, 1.0))
    if gwa is not None and not math.isnan(gwa) and gwa > 0:
        return float(np.clip(gwa / 100.0, 0.0, 1.0))
    return float("nan")


def income_log(income: Optional[float]) -> float:
    if income is None:
        return float(np.log1p(150_000.0)) / float(np.log1p(_config.INCOME_CEIL))
    return float(np.log1p(max(0.0, float(income)))) / float(np.log1p(_config.INCOME_CEIL))


# --- PSA FIES / BIR TRAIN / CHED income features ---------------------------
# Same derivations the Colab notebook (google-colab-training.ipynb) builds from
# FIES_PUF_2025_TRAIN.xlsx, so a forest trained there and scored here sees the
# identical column values.
TRAIN_TAX_EXEMPT_CEILING = 250_000.0   # BIR TRAIN Law personal exemption
CHED_PRIORITY_CEILING = 400_000.0      # CHED income ceiling
# (upper bound, label) - matches the notebook's pd.cut bins exactly.
INCOME_BRACKETS = (
    (100_000.0, 1),
    (150_000.0, 2),
    (200_000.0, 3),
    (250_000.0, 4),
    (300_000.0, 5),
    (400_000.0, 6),
)
BRACKET_MISSING = 0.0   # the notebook never emits 0, but an unknown income needs one


def monthly_income_equiv(income: Optional[float]) -> float:
    """Annual family income / 12, as the notebook computes it (raw pesos)."""
    if income is None:
        return float("nan")
    return round(float(income) / 12.0, 2)


def is_train_tax_exempt(income: Optional[float]) -> float:
    """1 when income is at or below the BIR TRAIN Law tax-exempt ceiling."""
    if income is None:
        return float("nan")
    return 1.0 if float(income) <= TRAIN_TAX_EXEMPT_CEILING else 0.0


def is_ched_priority_ceiling(income: Optional[float]) -> float:
    """1 when income is at or below the CHED priority ceiling."""
    if income is None:
        return float("nan")
    return 1.0 if float(income) <= CHED_PRIORITY_CEILING else 0.0


def itr_income_bracket(income: Optional[float]) -> float:
    """Income -> bracket 1..7 (1 = poorest band), mirroring pd.cut bins.

    The notebook's bins are left-open/right-closed: (-inf, 100k] -> 1,
    (100k, 150k] -> 2, ... (400k, inf) -> 7.
    """
    if income is None:
        return BRACKET_MISSING
    value = float(income)
    for ceiling, label in INCOME_BRACKETS:
        if value <= ceiling:
            return float(label)
    return 7.0


FAMILY_SIZE_MIN = 1.0
FAMILY_SIZE_MAX = 20.0   # FIES FSIZE tops out at 19.5 persons


def family_size(value) -> float:
    """Household size in persons -> 1.0..20.0. NaN when unknown/invalid.

    The FIES PUF carries FSIZE (mean 4.07, no missing values). An applicant
    who does not answer is left as NaN and gets the trained model's stored
    median at scoring time instead of a made-up household size.
    """
    if value is None or str(value).strip() == "":
        return float("nan")
    text = str(value).strip().replace(",", "")
    try:
        size = float(text)
    except (TypeError, ValueError):
        return float("nan")
    if not (FAMILY_SIZE_MIN <= size <= FAMILY_SIZE_MAX):
        return float("nan")
    return float(size)


def per_capita_income(income: Optional[float], size: Optional[float]) -> float:
    """Annual family income / household members. NaN when either is unknown."""
    if income is None:
        return float("nan")
    if size is None:
        return float("nan")
    try:
        members = float(size)
    except (TypeError, ValueError):
        return float("nan")
    if math.isnan(members) or members <= 0:
        return float("nan")
    return round(float(income) / members, 2)


def itr_trust(row: Dict) -> str:
    """ITR comparison status for analytics: verified, mismatch, unreadable, or absent.

    An applicant is only 'verified' when an ITR was uploaded and the income
    the applicant typed matches the figure OCR read from it (>= OCR_TRUST_MIN_PCT).
    This status is shown for review; it does not override income-based ordering.
    """
    has_itr = bool(row.get("itr_path")) or bool(row.get("has_itr"))
    if not has_itr:
        return "no_itr"
    if row.get("ocr_income") is None or row.get("ocr_status") == "not_comparable":
        return "unverified"
    match = row.get("ocr_match_pct") or 0.0
    try:
        match = float(match)
    except (TypeError, ValueError):
        match = 0.0
    return "verified" if match >= _config.OCR_TRUST_MIN_PCT else "mismatch"


def priority_flags(row: Dict) -> Tuple[float, Dict[str, float]]:
    """Declared statutory priority flags -> (bonus points, breakdown)."""
    parts = {
        "pwd": _config.W_PWD * float(row.get("pwd_flag") or 0.0),
        "ip": _config.W_IP * float(row.get("ip_flag") or 0.0),
        "solo_parent": _config.W_SOLO_PARENT * float(row.get("solo_parent_flag") or 0.0),
        "four_ps": _config.W_FOUR_PS * float(row.get("four_ps_flag") or 0.0),
        "first_gen": _config.W_FIRST_GEN * float(row.get("first_gen_flag") or 0.0),
    }
    return round(sum(parts.values()), 4), parts


def priority_target(row: Dict) -> float:
    """Ground-truth priority (0-100) the Random Forest learns.

    Base score = financial need from the income the OCR read from the ITR
    (W_NEED = 1.0; academic grades and OCR match stay out of the score).
    On top of that, every *declared*
    statutory priority flag adds its points, so an applicant - or a
    historical row - with no ITR and no income still gets a documented
    score instead of a flat neutral one.
    """
    need = row.get("financial_need_score", 0.0)
    ocr = row.get("ocr_match_pct", 0.0)
    bonus, _parts = priority_flags(row)
    # Two ranking bases running side by side:
    #  * rows from the UPLOADED HISTORICAL FILE -> dataset score
    #    (neutral need baseline + statutory priority flags), and
    #  * live applicants -> the original income / ITR formula, unchanged.
    # Colab-aligned rows carry the observed NPCINC-derived target directly.
    # This income-based proxy is only a fallback for other training paths.
    if row.get("income_ranked") and need is not None:
        return round(float(np.clip(need + bonus, 0.0, 100.0)), 4)
    if _config.HISTORICAL_DATASET_RANKING and row.get("source") == "csv":
        return round(float(np.clip(_config.NEUTRAL_NEED_SCORE + bonus, 0.0, 100.0)), 4)
    return round(
        float(np.clip(
            100.0
            * (
                _config.W_NEED * (need / 100.0)
                + _config.W_OCR * (ocr / 100.0)
            )
            + bonus,
            0.0,
            100.0,
        )),
        4,
    )


def effective_income(
    declared: Optional[float],
    ocr_value: Optional[float],
    low_confidence: bool = False,
) -> Tuple[Optional[float], str]:
    """Use declared income for ranking; OCR is only an audit comparison."""
    typed = None
    if declared is not None:
        try:
            typed = float(declared)
        except (TypeError, ValueError):
            typed = None

    if typed is not None:
        return typed, "declared" if ocr_value is None else "declared_ocr_audit"
    return None, "none"


def build_row(applicant: Dict, ocr_result: Optional[Dict]) -> Dict:
    """Build model features from declared income and retain OCR only for audit."""
    declared = applicant.get("declared_income")
    ocr_value = (ocr_result or {}).get("ocr_value")
    match = (ocr_result or {}).get("match") or {}
    income_used, income_source = effective_income(
        declared,
        ocr_value,
        bool((ocr_result or {}).get("low_confidence")),
    )
    delta = None
    if declared is not None and ocr_value is not None:
        try:
            delta = round(float(ocr_value) - float(declared), 2)
        except (TypeError, ValueError):
            delta = None

    household = family_size(applicant.get("family_size"))
    per_capita = per_capita_income(income_used, household)
    if income_used is not None and (per_capita is None or math.isnan(per_capita)):
        # No household size declared -> neutral default, so per-capita income
        # tracks the declared income rather than the dataset median.
        per_capita = per_capita_income(income_used, DEFAULT_FAMILY_SIZE)

    # --- statutory priority flags (same fields the preprocessing pipeline
    # derives from the historical form: disability, indigenous group, solo
    # parent, first generation, 4Ps) ---------------------------------------
    pwd_flag = flag_value(
        applicant.get("pwd_flag") if applicant.get("pwd_flag") is not None else applicant.get("disability")
    )
    ip_flag = flag_value(
        applicant.get("ip_flag") if applicant.get("ip_flag") is not None else applicant.get("indigenous_people_group"),
        non_ip=True,
    )
    solo_parent_flag = flag_value(applicant.get("solo_parent") if applicant.get("solo_parent") is not None else applicant.get("solo_parent_flag"))
    first_gen_flag = flag_value(applicant.get("first_gen") if applicant.get("first_gen") is not None else applicant.get("first_gen_flag"))
    four_ps_flag = flag_value(applicant.get("is_4ps") if applicant.get("is_4ps") is not None else applicant.get("four_ps_flag"))

    age = applicant.get("age")
    if age in (None, "") and applicant.get("birthdate"):
        birth = str(applicant.get("birthdate"))[:10]
        try:
            born = dt.date.fromisoformat(birth)
            today = dt.date.today()
            age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
        except ValueError:
            age = None

    row = {
        "application_id": applicant.get("application_id"),
        "student_name": applicant.get("student_name") or "",
        "student_number": applicant.get("student_number") or "",
        "scholarship": applicant.get("scholarship") or "",
        "program": applicant.get("program") or "",
        "year_level": applicant.get("year_level") or "",
        "sex": applicant.get("sex") or "",
        "declared_income": declared,
        "ocr_income": ocr_value,
        "ocr_error": (ocr_result or {}).get("error"),
        "ocr_scan_failed": bool((ocr_result or {}).get("scan_failure")),
        "income_used": income_used,
        "income_source": income_source,
        "income_delta": delta,
        "ocr_income_differs": bool(delta is not None and abs(delta) > 0.005),
        "itr_path": applicant.get("itr_path"),
        "financial_need_score": financial_need_score(income_used),
        "ocr_match_pct": float(match.get("align_pct") or 0.0),
        "ocr_exact_match": bool(match.get("exact_match")),
        "ocr_status": match.get("status", "not_comparable"),
        "income_log": income_log(income_used),
        "has_itr": 1.0 if applicant.get("itr_path") or applicant.get("itr_path_p2") else 0.0,
        "itr_path_p2": applicant.get("itr_path_p2"),
        "ocr_verified": 1.0 if ocr_value is not None else 0.0,
        "year_level_num": year_level_num(applicant.get("year_level")),
        "sex_code": sex_code(applicant.get("sex")),
        "pwd_flag": pwd_flag,
        "ip_flag": ip_flag,
        "solo_parent_flag": solo_parent_flag,
        "four_ps_flag": four_ps_flag,
        "first_gen_flag": first_gen_flag,
        "age_norm": age_norm(age),
        "program_code": program_code(applicant.get("program")),
        # PSA FIES / BIR TRAIN / CHED income features (Colab training set)
        "annual_income_family": income_used if income_used is not None else float("nan"),
        "monthly_income_equiv": monthly_income_equiv(income_used),
        "is_train_tax_exempt": is_train_tax_exempt(income_used),
        "is_ched_priority_ceiling": is_ched_priority_ceiling(income_used),
        "itr_income_bracket": itr_income_bracket(income_used),
        "family_size": household,
        "per_capita_income": per_capita,
        "priority_target": 0.0,
    }
    row["priority_target"] = priority_target(row)
    row["priority_bonus"], row["priority_bonus_parts"] = priority_flags(row)
    row["itr_trust"] = itr_trust(row)
    return row


def matrix(
    rows: Sequence[Dict],
    medians: Optional[Dict[str, float]] = None,
    columns: Optional[Sequence[str]] = None,
) -> Tuple[np.ndarray, Dict[str, float]]:
    """Rows -> float matrix with median imputation (NaN-safe).

    ``columns`` pins the exact feature order a model was trained with, so a
    forest exported from Google Colab (built on an older/shorter feature list)
    still receives its columns in training order instead of the current
    ``FEATURE_COLUMNS``. Imputation medians for a subset come from the model
    payload whenever it carries them.
    """
    cols = list(columns) if columns else list(FEATURE_COLUMNS)

    if medians is None:
        collected: Dict[str, List[float]] = {c: [] for c in cols}
        for row in rows:
            for col in cols:
                value = row.get(col)
                if value is None or (isinstance(value, float) and math.isnan(value)):
                    continue
                collected[col].append(float(value))
        medians = {
            col: float(np.median(vals)) if vals else 0.0
            for col, vals in collected.items()
        }

    data = np.zeros((len(rows), len(cols)), dtype=np.float64)
    for i, row in enumerate(rows):
        for j, col in enumerate(cols):
            value = row.get(col)
            if value is None or (isinstance(value, float) and math.isnan(value)):
                value = medians.get(col, 0.0)
            data[i, j] = float(value)
    return data, medians


def _num(value) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number
