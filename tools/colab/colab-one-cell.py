import sys, io, json, math, subprocess, time
from pathlib import Path

print("ISEWM Scholarship Ranking — all-in-one Colab cell")
print("Python:", sys.version.split()[0])

# --- 1. dependencies (numpy/pandas preinstalled in Colab) ---------------------
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "scikit-learn", "joblib", "openpyxl"], check=True)
import numpy as np
import joblib
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score, precision_score,
                             recall_score, roc_auc_score, r2_score, root_mean_squared_error)
from sklearn.model_selection import train_test_split

# --- 2. configuration (mirrors ml/config.py) ---------------------------------
DEFAULT_SEED = 2026
DEFAULT_N_TREES = 100
DEFAULT_SYNTH = 800
DEFAULT_MAX_DEPTH = 8
INCOME_FLOOR = 100_000.0   # need 100
INCOME_CEIL = 600_000.0    # need 0
W_NEED, W_OCR, W_ACADEMIC = 1.00, 0.00, 0.00
OCR_TRUST_MIN_PCT = 90.0
HIGH_NEED_LABEL_SCORE = 55.0
AVERAGE_ACADEMIC = 0.70

print(f"Config: need {INCOME_FLOOR:.0f}->{INCOME_CEIL:.0f} | weights need={W_NEED} ocr={W_OCR} academic={W_ACADEMIC}")

# --- 3. features (mirrors ml/features.py) ------------------------------------
def financial_need_score(income):
    if income is None:
        return 50.0
    return round(float(np.clip(100.0 * (INCOME_CEIL - float(income)) / (INCOME_CEIL - INCOME_FLOOR), 0.0, 100.0)), 2)

def year_level_num(value):
    if not value:
        return 0.0
    digits = "".join(ch for ch in str(value) if ch.isdigit())
    return float(int(digits)) if digits and 1 <= int(digits) <= 5 else 0.0

def sex_code(value):
    text = (value or "").strip().lower()
    return 0.0 if text.startswith("m") else (1.0 if text.startswith("f") else 2.0)

def academic_norm(gwa, gpa):
    if gpa is not None and not math.isnan(gpa) and gpa > 0:
        return float(np.clip(gpa / 4.0, 0.0, 1.0))
    if gwa is not None and not math.isnan(gwa) and gwa > 0:
        return float(np.clip(gwa / 100.0, 0.0, 1.0))
    return float("nan")

def income_log(income):
    if income is None:
        return float(np.log1p(150_000.0)) / float(np.log1p(INCOME_CEIL))
    return float(np.log1p(max(0.0, float(income)))) / float(np.log1p(INCOME_CEIL))

# --- PSA FIES 2025 income features (must match ml/features.py exactly) ------
TRAIN_TAX_EXEMPT_CEILING = 250_000.0
CHED_PRIORITY_CEILING = 400_000.0
INCOME_BRACKETS = ((100_000.0, 1), (150_000.0, 2), (200_000.0, 3),
                   (250_000.0, 4), (300_000.0, 5), (400_000.0, 6))

def monthly_income_equiv(income):
    if income is None:
        return float("nan")
    return round(float(income) / 12.0, 2)

def is_train_tax_exempt(income):
    if income is None:
        return float("nan")
    return 1.0 if float(income) <= TRAIN_TAX_EXEMPT_CEILING else 0.0

def is_ched_priority_ceiling(income):
    if income is None:
        return float("nan")
    return 1.0 if float(income) <= CHED_PRIORITY_CEILING else 0.0

def itr_income_bracket(income):
    if income is None:
        return 0.0
    value = float(income)
    for ceiling, label in INCOME_BRACKETS:
        if value <= ceiling:
            return float(label)
    return 7.0

DEFAULT_FAMILY_SIZE = 4.0   # FIES mean household size (FSIZE = 4.07)

def family_size(value):
    """Household members -> 1.0..20.0, else the neutral default (4)."""
    if value is None:
        return DEFAULT_FAMILY_SIZE
    if str(value).strip() == "":
        return DEFAULT_FAMILY_SIZE
    try:
        size = float(str(value).strip().replace(",", ""))
    except (TypeError, ValueError):
        return DEFAULT_FAMILY_SIZE
    if not (1.0 <= size <= 20.0):
        return DEFAULT_FAMILY_SIZE
    return size

def per_capita_income(income, size):
    if income is None or size is None:
        return float("nan")
    try:
        members = float(size)
    except (TypeError, ValueError):
        return float("nan")
    if math.isnan(members) or members <= 0:
        return float("nan")
    return round(float(income) / members, 2)

def fies_features(income, household=None):
    """The seven PSA FIES columns, shared by every row builder here.

    family_size defaults to the FIES mean (4) when the caller has no FSIZE
    value, so per-capita income still follows income instead of becoming NaN.
    """
    size = family_size(household)
    return {
        "annual_income_family": income if income is not None else float("nan"),
        "monthly_income_equiv": monthly_income_equiv(income),
        "is_train_tax_exempt": is_train_tax_exempt(income),
        "is_ched_priority_ceiling": is_ched_priority_ceiling(income),
        "itr_income_bracket": itr_income_bracket(income),
        "family_size": size,
        "per_capita_income": per_capita_income(income, size),
    }

def priority_target(row):
    need = row.get("financial_need_score", 0.0)
    ocr = row.get("ocr_match_pct", 0.0)
    academic = row.get("academic_norm", AVERAGE_ACADEMIC)
    if academic is None or (isinstance(academic, float) and math.isnan(academic)):
        academic = AVERAGE_ACADEMIC
    return round(100.0 * (W_NEED * (need / 100.0) + W_OCR * (ocr / 100.0) + W_ACADEMIC * academic), 4)

FEATURE_COLUMNS = ["financial_need_score", "ocr_match_pct", "income_log", "has_itr",
                   "ocr_verified", "year_level_num", "sex_code", "academic_norm",
                   "annual_income_family", "monthly_income_equiv", "is_train_tax_exempt",
                   "is_ched_priority_ceiling", "itr_income_bracket",
                   "family_size", "per_capita_income"]

def matrix(rows, medians=None):
    if medians is None:
        collected = {c: [] for c in FEATURE_COLUMNS}
        for row in rows:
            for col in FEATURE_COLUMNS:
                value = row.get(col)
                if value is None or (isinstance(value, float) and math.isnan(value)):
                    continue
                collected[col].append(float(value))
        medians = {c: (float(np.median(v)) if v else 0.0) for c, v in collected.items()}
    data = np.zeros((len(rows), len(FEATURE_COLUMNS)))
    for i, row in enumerate(rows):
        for j, col in enumerate(FEATURE_COLUMNS):
            value = row.get(col)
            if value is None or (isinstance(value, float) and math.isnan(value)):
                value = medians[col]
            data[i, j] = float(value)
    return data, medians

def itr_trust(row):
    if not (row.get("itr_path") or row.get("has_itr")):
        return "no_itr"
    try:
        match = float(row.get("ocr_match_pct") or 0.0)
    except (TypeError, ValueError):
        match = 0.0
    return "verified" if match >= OCR_TRUST_MIN_PCT else "mismatch"

# --- 4. historical data loader (mirrors ml/csv_data.py) ----------------------
_ALIASES = {
    "income": ("annual_income", "income", "family_income", "total_family_annual_income",
               "family_annual_income", "yearly_income", "declared_income", "amount",
               "annual_income_family", "total_family_income"),
    "year_level": ("year_level", "year", "level", "grade_level", "year_lvl"),
    "sex": ("sex", "gender"),
    "gwa": ("gwa", "shs_gwa", "senior_high_gwa"),
    "gpa": ("gpa", "college_gpa", "tertiary_gpa"),
    "ocr_match_pct": ("ocr_match_pct", "ocr_match", "match_pct", "ocr_pct"),
    "has_itr": ("has_itr", "itr", "has_itr_upload", "itr_uploaded",
                "income_tax_return", "itr_path", "itr_file"),
}

def _csv_canonical(header):
    return header.strip().lower().replace("-", "_").replace(" ", "_")

def _csv_money(value):
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    for token in ("php", "peso", "\u20b1", "p", "per", "year", "annum", "annual"):
        text = text.replace(token, "")
    text = text.replace(",", "").replace(" ", "").strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1]
    try:
        number = float(text)
    except ValueError:
        return None
    return number if number > 0 else None

def _csv_num(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return float(text) if float(text) > 0 else None
    except ValueError:
        return None

def _csv_flag(value, default):
    if value is None:
        return default
    text = str(value).strip().lower()
    if not text:
        return default
    return True if text in ("yes", "y", "true", "1") else (False if text in ("no", "n", "false", "0", "none", "-") else default)

def csv_rows_from_csv_text(text, warnings):
    import csv as _csvmod
    reader = _csvmod.reader(io.StringIO(text))
    try:
        header = [c.strip() for c in next(reader)]
    except StopIteration:
        return []
    header_map = {_csv_canonical(h): h for h in header if h}
    resolved = {f: next((header_map[n] for n in names if n in header_map), None) for f, names in _ALIASES.items()}
    out = []
    neutral = 0
    if not resolved["income"]:
        warnings.append("no income column -> every row trains with a neutral need score (ranking unaffected)")
    for index, values in enumerate(reader, start=2):
        record = {h: c for h, c in zip(header, values) if h}
        income = _csv_money(record.get(resolved["income"], "")) if resolved["income"] else None
        has_other = any(resolved[f] for f in ("year_level", "sex", "gwa", "gpa", "ocr_match_pct", "has_itr"))
        if income is None and not has_other:
            warnings.append(f"line {index}: skipped (nothing usable)")
            continue
        gwa = _csv_num(record.get(resolved["gwa"], "")) if resolved["gwa"] else None
        gpa = _csv_num(record.get(resolved["gpa"], "")) if resolved["gpa"] else None
        has_itr = 1.0 if _csv_flag(record.get(resolved["has_itr"], "") if resolved["has_itr"] else None, True) else 0.0
        raw = _csv_num(record.get(resolved["ocr_match_pct"], "")) if resolved["ocr_match_pct"] else None
        ocr = float(min(max(raw, 0.0), 100.0)) if raw is not None else (100.0 if has_itr > 0.5 else 0.0)
        if has_itr < 0.5:
            ocr = 0.0
        row = {
            "declared_income": income,
            "financial_need_score": financial_need_score(income),
            "ocr_match_pct": round(ocr, 2),
            "income_log": income_log(income),
            "has_itr": has_itr,
            "ocr_verified": 1.0 if ocr > 0 else 0.0,
            "year_level_num": year_level_num(record.get(resolved["year_level"], "") if resolved["year_level"] else ""),
            "sex_code": sex_code(record.get(resolved["sex"], "") if resolved["sex"] else ""),
            "academic_norm": academic_norm(gwa, gpa),
            **fies_features(income),
            "source": "csv",
            "priority_target": 0.0,
        }
        if income is None:
            warnings.append(f"line {index}: no income value — kept with a neutral need score")
            neutral += 1
        row["priority_target"] = priority_target(row)
        if not math.isnan(row["academic_norm"]):
            row["academic_norm"] = float(row["academic_norm"])
        else:
            row["academic_norm"] = None
        out.append(row)
    if neutral:
        warnings.append(f"{neutral} row(s) have no income -> neutral need score; ranking still works for applicants")
    return out

def bundled_rows(warnings):
    """The 20 bundled sample rows so training works even with no upload."""
    return csv_rows_from_csv_text(
        "annual_income,year_level,sex,gwa,gpa,ocr_match_pct,has_itr\n"
        "45000,1,Female,88.5,,100,yes\n52000,2,Male,82.0,,99.5,yes\n"
        "68000,3,Female,91.2,,98.8,yes\n75000,1,Male,79.5,,97.4,yes\n"
        "92000,4,Female,86.0,,100,yes\n110000,2,Female,93.4,,99.1,yes\n"
        "135000,3,Male,84.7,,96.5,yes\n155000,1,Female,90.1,,99.8,yes\n"
        "185000,5,Male,77.9,,98.2,yes\n210000,2,Female,88.0,,100,yes\n"
        "245000,3,Male,85.3,,99.4,yes\n275000,4,Female,92.6,,97.9,yes\n"
        "310000,1,Male,81.4,,99.0,yes\n345000,2,Female,89.7,,98.6,yes\n"
        "385000,3,Male,87.2,,100,yes\n420000,5,Female,83.8,,96.9,yes\n"
        "465000,4,Male,90.5,,99.3,yes\n510000,1,Female,86.9,,98.4,yes\n"
        "555000,2,Male,84.1,,99.6,yes\n595000,3,Female,91.8,,97.2,yes\n",
        warnings,
    )

# --- 5. train (mirrors ml/rank_model.train) ----------------------------------
def train(seed=DEFAULT_SEED, n_trees=DEFAULT_N_TREES, n_synth=DEFAULT_SYNTH, max_depth=DEFAULT_MAX_DEPTH, historical=None):
    rng = np.random.default_rng(seed)
    synth = []
    for _ in range(n_synth):
        income = float(np.exp(rng.uniform(np.log(40_000.0), np.log(600_000.0))))
        ocr_roll = rng.random()
        ocr = (float(rng.uniform(96, 100)) if ocr_roll < 0.72
               else float(rng.uniform(75, 96)) if ocr_roll < 0.92 else float(rng.uniform(0, 75)))
        has_itr = 1.0 if rng.random() < 0.9 else 0.0
        row = {
            "declared_income": income,
            "financial_need_score": financial_need_score(income),
            "ocr_match_pct": round(ocr, 2) if has_itr > 0.5 else 0.0,
            "income_log": income_log(income),
            "has_itr": has_itr,
            "ocr_verified": 1.0 if (ocr > 0 and has_itr > 0.5) else 0.0,
            "year_level_num": float(rng.integers(1, 6)),
            "sex_code": float(rng.integers(0, 2)),
            "academic_norm": float(np.clip(rng.normal(0.75, 0.12), 0.2, 1.0)),
            **fies_features(income),
            "priority_target": 0.0,
        }
        row["priority_target"] = priority_target(row)
        synth.append(row)

    csv_rows = list(historical or [])
    rows = synth + csv_rows
    X, medians = matrix(rows)
    y_cls = np.array([1 if r["priority_target"] >= HIGH_NEED_LABEL_SCORE else 0 for r in rows])
    y_reg = np.array([r["priority_target"] for r in rows])

    stratify = y_cls if len(np.unique(y_cls)) > 1 and np.min(np.bincount(y_cls)) >= 2 else None
    X_tr, X_te, yc_tr, yc_te, yr_tr, yr_te = train_test_split(X, y_cls, y_reg, test_size=0.2, random_state=seed, stratify=stratify)

    clf = RandomForestClassifier(n_estimators=n_trees, max_depth=max_depth, min_samples_split=5,
                                 min_samples_leaf=2, class_weight="balanced", random_state=seed, n_jobs=-1)
    clf.fit(X_tr, yc_tr)
    reg = RandomForestRegressor(n_estimators=n_trees, max_depth=max_depth, min_samples_split=5,
                                min_samples_leaf=2, random_state=seed, n_jobs=-1)
    reg.fit(X_tr, yr_tr)

    pred = clf.predict(X_te)
    proba = clf.predict_proba(X_te)[:, 1]
    auc = float(roc_auc_score(yc_te, proba)) if len(np.unique(yc_te)) > 1 else None
    importance = {n: round(float(v), 5) for n, v in zip(FEATURE_COLUMNS, reg.feature_importances_)}

    model = {"classifier": clf, "regressor": reg, "medians": medians, "seed": seed, "n_trees": n_trees,
             # feature_columns pins the training order on reload: without it a
             # later run that changed FEATURE_COLUMNS would score in the wrong order.
             "feature_columns": list(FEATURE_COLUMNS),
             "source": "colab",
             "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
             "n_samples": len(rows), "n_synthetic": len(synth), "n_csv": len(csv_rows),
             "weights": {"financial_need": W_NEED, "ocr_match": W_OCR, "academic": W_ACADEMIC}}
    metrics = {
        "n_rows": len(rows), "n_synthetic": len(synth), "n_csv": len(csv_rows),
        "accuracy": round(float(accuracy_score(yc_te, pred)), 4),
        "precision": round(float(precision_score(yc_te, pred, zero_division=0)), 4),
        "recall": round(float(recall_score(yc_te, pred, zero_division=0)), 4),
        "f1": round(float(f1_score(yc_te, pred, zero_division=0)), 4),
        "roc_auc": round(auc, 4) if auc is not None else None,
        "confusion_matrix": confusion_matrix(yc_te, pred, labels=[0, 1]).tolist(),
        "r2": round(float(r2_score(yr_te, reg.predict(X_te))), 4),
        "rmse": round(float(root_mean_squared_error(yr_te, reg.predict(X_te))), 4),
        "feature_importance": importance,
        "model": model,
    }
    return metrics

# --- 6. rank (mirrors ml/rank_model.predict) ---------------------------------
def rank_one(row, trained):
    X, _ = matrix([row], trained["medians"])
    score = float(trained["regressor"].predict(X)[0])
    label = trained["classifier"].predict(X)[0]
    proba = float(trained["classifier"].predict_proba(X)[:, 1][0])
    return {
        "student": row.get("student_name", ""),
        "income_used": row.get("income_used"),
        "need_score": row.get("financial_need_score"),
        "itr_trust": itr_trust(row),
        "priority_score": round(score, 2),
        "prediction": "High Need" if int(label) == 1 else "Low Need",
        "probability": round(proba, 4),
    }

def rank_applicants(rows, trained):
    out = [rank_one(r, trained) for r in rows]
    out.sort(key=lambda r: (0 if r["itr_trust"] == "verified" else 1, -r["priority_score"]))
    for i, r in enumerate(out, 1):
        r["rank"] = i
    return out

def build_row(applicant, ocr_result=None):
    declared = applicant.get("declared_income")
    ocr = (ocr_result or {}).get("ocr_value")
    low_conf = bool((ocr_result or {}).get("low_confidence"))
    if ocr is not None and not low_conf:
        income_used, source = float(ocr), "ocr"
    elif declared is not None:
        income_used, source = float(declared), "declared" if ocr is None else "declared_low_confidence_ocr"
    elif ocr is not None:
        income_used, source = float(ocr), "ocr_low_confidence"
    else:
        income_used, source = None, "none"
    match = (ocr_result or {}).get("match") or {}
    row = {
        "application_id": applicant.get("application_id"),
        "student_name": applicant.get("student_name") or "",
        "declared_income": declared,
        "income_used": income_used,
        "income_source": source,
        "itr_path": applicant.get("itr_path"),
        "financial_need_score": financial_need_score(income_used),
        "ocr_match_pct": float(match.get("align_pct") or 0.0),
        "income_log": income_log(income_used),
        "has_itr": 1.0 if applicant.get("itr_path") or (ocr_result is not None) else 0.0,
        "ocr_verified": 1.0 if ocr is not None else 0.0,
        **fies_features(income_used),
        "year_level_num": year_level_num(applicant.get("year_level")),
        "sex_code": sex_code(applicant.get("sex")),
        "academic_norm": academic_norm(_num(applicant.get("shs_gwa")), _num(applicant.get("college_gpa"))),
        "priority_target": 0.0,
    }
    row["priority_target"] = priority_target(row)
    return row

def _num(value):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None

# === RUN ======================================================================
try:
    from google.colab import files as colab_files
    IN_COLAB = True
except ImportError:
    IN_COLAB = False
    colab_files = None

warnings2 = []
csv_rows = bundled_rows(warnings2)
print(f"\nLoaded bundled historical sample: {len(csv_rows)} rows. "
      "(Upload your real historical CSV in the following cell — it will REPLACE this sample.)")
res = train(historical=csv_rows)
print(f"Training done: rows={res['n_rows']} (synthetic {res['n_synthetic']} + historical {res['n_csv']}) | "
      f"accuracy={res['accuracy']} f1={res['f1']} roc_auc={res['roc_auc']} r2={res['r2']}")
print("Feature importance:", json.dumps(res["feature_importance"]))

demo = [
    ({"application_id": 1, "student_name": "Ana Reyes", "year_level": "3", "sex": "Female", "declared_income": 58000.0}, {"ocr_value": 58000.0, "match": {"align_pct": 99.2}}),
    ({"application_id": 2, "student_name": "Carlo Magno", "year_level": "4", "sex": "Male", "declared_income": 520000.0}, {"ocr_value": 525000.0, "match": {"align_pct": 98.5}}),
    ({"application_id": 3, "student_name": "Maria Santos", "year_level": "1", "sex": "Female", "declared_income": 145000.0}, {"ocr_value": 143000.0, "match": {"align_pct": 95.1}}),
    ({"application_id": 4, "student_name": "Juan Dela Cruz", "year_level": "3", "sex": "Male", "declared_income": 88000.0}, {"ocr_value": 91000.0, "match": {"align_pct": 88.0}}),
]
ranked = rank_applicants([build_row(a, o) for a, o in demo], res["model"])
print("\nDemo ranking (Rank 1 = most in need, ITR-verified first):")
for r in ranked:
    print(f"  #{r['rank']} {r['student']:<16} used={r['income_used']:>10.0f} trust={r['itr_trust']:<9} "
          f"priority={r['priority_score']:>6.2f}  {r['prediction']} ({r['probability']})")

model_path = ("/content/rf_ranking_seed2026_colab.joblib" if IN_COLAB
              else "rf_ranking_seed2026_colab.joblib")
Path(model_path).parent.mkdir(parents=True, exist_ok=True)
joblib.dump(dict(res["model"]), model_path, compress=3)
size_kb = Path(model_path).stat().st_size // 1024
print(f"\nModel saved -> {model_path} ({size_kb} KB)")
if IN_COLAB:
    colab_files.download(model_path)
    print("Downloading rf_ranking_seed2026_colab.joblib — put it in backend/ml/models/ on your machine to reuse it.")
