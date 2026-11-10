"""Random Forest ranking model (scikit-learn + joblib).

For Colab-aligned training, one classifier is trained on the seven PSA FIES
income/household features and `NPCINC <= 4`; its priority probability drives
applicant ordering. The general local-training path fits a classifier and
regressor:

* ``RandomForestClassifier`` -> High Need / Low Need + probability
  (accuracy / precision / recall / F1 / ROC-AUC for the analytics panel)
* ``RandomForestRegressor`` -> a separate priority score for local analytics

Colab-aligned training uses only the uploaded labelled dataset and is persisted
with joblib for later applicant scoring.
"""

from __future__ import annotations

import json
import math
import time
import uuid
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

from . import config as _config
from . import csv_data as _csv_data
from . import features as _features
from .features import FEATURE_COLUMNS


def _synthetic_rows(n: int, seed: int) -> List[Dict]:
    """Seeded synthetic population blended into every fit.

    Income / OCR / ITR values are generated as before; the statutory
    priority flags are drawn at the prevalence measured in the school's
    preprocessed historical file (PWD 1.7%, IP 15.8%, solo-parent 25.7%,
    4Ps 11.8%, first-gen 49.2%) so the forests see the same flag
    distribution they will see at ranking time.
    """
    rng = np.random.default_rng(seed)
    rows: List[Dict] = []
    for _ in range(n):
        income = float(np.exp(rng.uniform(np.log(40_000.0), np.log(600_000.0))))
        # Household size drawn at the FIES distribution (mean 4.07 persons).
        size = float(np.clip(rng.normal(4.07, 1.7), 1.0, 19.5))
        ocr_roll = rng.random()
        if ocr_roll < 0.72:
            ocr_pct = float(rng.uniform(96.0, 100.0))
        elif ocr_roll < 0.92:
            ocr_pct = float(rng.uniform(75.0, 96.0))
        else:
            ocr_pct = float(rng.uniform(0.0, 75.0))
        has_itr = 1.0 if rng.random() < 0.9 else 0.0
        if has_itr < 0.5:
            ocr_pct = 0.0
        row = {
            "declared_income": income,
            "financial_need_score": _features.financial_need_score(income),
            "ocr_match_pct": round(ocr_pct, 2),
            "income_log": _features.income_log(income),
            "has_itr": has_itr,
            "ocr_verified": 1.0 if ocr_pct > 0 else 0.0,
            "year_level_num": float(rng.integers(1, 6)),
            "sex_code": float(rng.integers(0, 2)),
            "pwd_flag": 1.0 if rng.random() < 0.017 else 0.0,
            "ip_flag": 1.0 if rng.random() < 0.158 else 0.0,
            "solo_parent_flag": 1.0 if rng.random() < 0.257 else 0.0,
            "four_ps_flag": 1.0 if rng.random() < 0.118 else 0.0,
            "first_gen_flag": 1.0 if rng.random() < 0.492 else 0.0,
            "age_norm": float(np.clip((rng.normal(20.5, 2.6) - 15.0) / 30.0, 0.0, 1.0)),
            "program_code": float(rng.integers(0, 8)),
            # PSA FIES / BIR TRAIN / CHED income features (Colab training set)
            "annual_income_family": income,
            "monthly_income_equiv": _features.monthly_income_equiv(income),
            "is_train_tax_exempt": _features.is_train_tax_exempt(income),
            "is_ched_priority_ceiling": _features.is_ched_priority_ceiling(income),
            "itr_income_bracket": _features.itr_income_bracket(income),
            "family_size": size,
            "per_capita_income": _features.per_capita_income(income, size),
        }
        row["priority_target"] = _features.priority_target(row)
        rows.append(row)
    return rows


def _income_of(row: Dict) -> Optional[float]:
    for key in ("income_used", "declared_income", "ocr_income"):
        value = row.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


_INCOME_BINS = (
    (None, 100_000.0, "\u2264100k"),
    (100_000.0, 200_000.0, "100\u2013200k"),
    (200_000.0, 300_000.0, "200\u2013300k"),
    (300_000.0, 400_000.0, "300\u2013400k"),
    (400_000.0, 500_000.0, "400\u2013500k"),
    (500_000.0, 600_000.0, "500\u2013600k"),
    (600_000.0, None, "600k+"),
)


def _dataset_analytics(synth: List[Dict], csv_rows: List[Dict], real_rows: List[Dict]) -> Dict:
    """Distribution proof for the UI: sources, income histogram + quantiles."""
    all_rows = list(synth) + list(csv_rows) + list(real_rows)
    incomes: List[float] = []
    needs: List[float] = []
    for row in all_rows:
        income = _income_of(row)
        if income is None:
            continue
        incomes.append(income)
        try:
            needs.append(float(row.get("financial_need_score") or 0.0))
        except (TypeError, ValueError):
            pass

    out: Dict = {
        "sources": {"synthetic": len(synth), "csv": len(csv_rows), "real": len(real_rows)},
        "total": len(all_rows),
        "label_sources": {
            "observed_npcinc": sum(1 for row in all_rows if row.get("target_source") == "npcinc"),
            "derived_proxy": sum(1 for row in all_rows if row.get("target_source") != "npcinc"),
        },
        "target_classes": {
            "priority": sum(
                1 for row in all_rows
                if float(row.get("priority_target") or 0.0) >= _config.HIGH_NEED_LABEL_SCORE
            ),
            "not_priority": sum(
                1 for row in all_rows
                if float(row.get("priority_target") or 0.0) < _config.HIGH_NEED_LABEL_SCORE
            ),
        },
        "with_income": len(incomes),
        "need_mean": round(float(np.mean(needs)), 2) if needs else None,
        # statutory priority flags actually present in the fit
        "priority_flags": {
            "pwd": sum(1 for row in all_rows if row.get("pwd_flag")),
            "ip": sum(1 for row in all_rows if row.get("ip_flag")),
            "solo_parent": sum(1 for row in all_rows if row.get("solo_parent_flag")),
            "four_ps": sum(1 for row in all_rows if row.get("four_ps_flag")),
            "first_gen": sum(1 for row in all_rows if row.get("first_gen_flag")),
        },
        "priority_flag_source": {
            "csv": {
                "pwd": sum(1 for row in csv_rows if row.get("pwd_flag")),
                "ip": sum(1 for row in csv_rows if row.get("ip_flag")),
                "solo_parent": sum(1 for row in csv_rows if row.get("solo_parent_flag")),
                "four_ps": sum(1 for row in csv_rows if row.get("four_ps_flag")),
                "first_gen": sum(1 for row in csv_rows if row.get("first_gen_flag")),
            },
        },
    }
    if not incomes:
        return out

    arr = np.asarray(incomes, dtype=np.float64)
    out["income"] = {
        "min": round(float(arr.min()), 0),
        "p25": round(float(np.percentile(arr, 25)), 0),
        "median": round(float(np.median(arr)), 0),
        "p75": round(float(np.percentile(arr, 75)), 0),
        "max": round(float(arr.max()), 0),
        "mean": round(float(arr.mean()), 0),
    }
    total = len(arr)
    histogram = []
    for low, high, label in _INCOME_BINS:
        mask = np.ones(total, dtype=bool)
        if low is not None:
            mask &= arr > low
        if high is not None:
            mask &= arr <= high
        count = int(mask.sum())
        histogram.append({"label": label, "count": count, "pct": round(100.0 * count / total, 1)})
    out["histogram"] = histogram
    return out


def _write_model_meta_sidecar(payload: Dict, model_path: Path) -> Optional[Path]:
    """Write a plain-JSON twin of a saved model for the web analytics panel.

    ``joblib.dump`` output can only be read by Python + scikit-learn, which the
    Next.js route cannot do. Mirroring the metadata (model id, holdout metrics,
    feature importance, dataset proof, weights) into ``<name>.meta.json`` lets
    ``GET /api/ml/model-info`` report what the deployed model actually is -
    including after a stream drops mid-run and the panel loses its events.
    Returns the sidecar path, or None when it could not be written.
    """
    try:
        analytics = payload.get("analytics") or {}
        evaluation = analytics.get("evaluation") or {}
        sidecar = model_path.with_suffix(".meta.json")
        sidecar.write_text(
            json.dumps(
                {
                    "model_id": payload.get("model_id"),
                    "created_at": payload.get("created_at"),
                    "source": payload.get("source"),
                    "persisted": bool(payload.get("persisted")),
                    "n_samples": payload.get("n_samples"),
                    "n_csv": payload.get("n_csv"),
                    "n_real": payload.get("n_real"),
                    "n_synthetic": payload.get("n_synthetic"),
                    "n_trees": payload.get("n_trees"),
                    "seed": payload.get("seed"),
                    "sklearn_version": payload.get("sklearn_version"),
                    "model_params": payload.get("model_params"),
                    "feature_columns": payload.get("feature_columns"),
                    "medians": payload.get("medians"),
                    "weights": payload.get("weights"),
                    "evaluation": evaluation,
                    "accuracy": analytics.get("accuracy"),
                    "precision": analytics.get("precision"),
                    "recall": analytics.get("recall"),
                    "f1": analytics.get("f1"),
                    "roc_auc": analytics.get("roc_auc"),
                    "confusion_matrix": analytics.get("confusion_matrix"),
                    "feature_importance": analytics.get("feature_importance"),
                    "dataset": analytics.get("dataset"),
                    "train_ms": analytics.get("train_ms"),
                    "model_size_kb": round(model_path.stat().st_size / 1024.0, 1),
                },
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        return sidecar
    except Exception:
        # The sidecar is a display convenience - never fail a training run.
        return None


def train(
    real_rows: List[Dict],
    seed: int = _config.DEFAULT_SEED,
    n_trees: int = _config.DEFAULT_N_TREES,
    n_synth: int = _config.DEFAULT_SYNTH_SAMPLES,
    max_depth: int = _config.DEFAULT_MAX_DEPTH,
    min_samples_leaf: int = 2,
    income_ranked: bool = False,
    csv_rows_override: Optional[List[Dict]] = None,
    columns: Optional[List[str]] = None,
) -> Dict:
    """Train and persist the ranking model, then return its analytics.

    ``columns`` pins the feature matrix to an explicit list - the train-only
    run passes the Colab notebook's seven TOINC/FSIZE-derived columns so its
    classifier matches the notebook's model.
    """
    from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
    from sklearn.metrics import (
        accuracy_score,
        confusion_matrix,
        f1_score,
        precision_score,
        recall_score,
        roc_auc_score,
        r2_score,
        root_mean_squared_error,
    )
    from sklearn.model_selection import train_test_split
    import joblib

    started = time.time()
    synth = _synthetic_rows(n_synth, seed)
    if csv_rows_override is None:
        csv_rows, csv_warnings = _csv_data.load_training_csv(income_ranked=income_ranked)
    else:
        csv_rows, csv_warnings = list(csv_rows_override), []
    if income_ranked:
        if any(
            "skipped (nothing usable)" in warning or "no income value" in warning
            for warning in csv_warnings
        ):
            raise ValueError(
                "Colab-aligned training requires valid annual family income (TOINC) and "
                "NPCINC values on every uploaded row."
            )
        unlabeled_count = sum(row.get("target_source") != "npcinc" for row in csv_rows)
        if unlabeled_count:
            raise ValueError(
                "Colab-aligned training requires a valid NPCINC value for every uploaded "
                f"training row; {unlabeled_count} of {len(csv_rows)} row(s) are missing it. "
                "Upload the PSA FIES dataset with both TOINC and NPCINC columns."
            )
    rows = synth + csv_rows + list(real_rows)
    dataset = _dataset_analytics(synth, csv_rows, real_rows)

    X, medians = _features.matrix(rows, columns=columns)
    y_cls = np.array(
        [1 if row["priority_target"] >= _config.HIGH_NEED_LABEL_SCORE else 0 for row in rows],
        dtype=np.int64,
    )
    y_reg = np.array([row["priority_target"] for row in rows], dtype=np.float64)

    stratify = None
    if income_ranked:
        class_counts = np.bincount(y_cls, minlength=2)
        if np.any(class_counts < 2):
            raise ValueError(
                "Colab-aligned training needs at least two rows in each NPCINC priority "
                f"class for its stratified split; found {class_counts[1]} prioritized and "
                f"{class_counts[0]} not prioritized."
            )
        stratify = y_cls
    elif len(np.unique(y_cls)) > 1 and np.min(np.bincount(y_cls)) >= 2:
        stratify = y_cls
    target_is_observed = np.array(
        [row.get("target_source") == "npcinc" for row in rows],
        dtype=bool,
    )
    (
        X_train,
        X_test,
        y_cls_train,
        y_cls_test,
        y_reg_train,
        y_reg_test,
        observed_train,
        observed_test,
    ) = train_test_split(
        X,
        y_cls,
        y_reg,
        target_is_observed,
        test_size=0.2,
        random_state=seed,
        stratify=stratify,
    )

    clf = RandomForestClassifier(
        n_estimators=n_trees,
        max_depth=max_depth,
        min_samples_split=2 if income_ranked else 5,
        min_samples_leaf=min_samples_leaf,
        class_weight="balanced",
        random_state=seed,
        n_jobs=1 if income_ranked else _config.RF_N_JOBS,
    )
    clf.fit(X_train, y_cls_train)

    reg = None
    if not income_ranked:
        reg = RandomForestRegressor(
            n_estimators=n_trees,
            max_depth=max_depth,
            min_samples_split=5,
            min_samples_leaf=min_samples_leaf,
            random_state=seed,
            n_jobs=_config.RF_N_JOBS,
        )
        reg.fit(X_train, y_reg_train)

    cls_pred = clf.predict(X_test)
    cls_proba = clf.predict_proba(X_test)[:, 1]
    reg_pred = reg.predict(X_test) if reg is not None else None
    eval_cls_true = y_cls_test[observed_test]
    eval_cls_pred = cls_pred[observed_test]
    eval_cls_proba = cls_proba[observed_test]
    eval_reg_true = y_reg_test[observed_test]
    eval_reg_pred = reg_pred[observed_test] if reg_pred is not None else None
    evaluation_available = len(eval_cls_true) > 0
    auc = None
    if evaluation_available and len(np.unique(eval_cls_true)) > 1:
        auc = float(roc_auc_score(eval_cls_true, eval_cls_proba))
    matrix = (
        confusion_matrix(eval_cls_true, eval_cls_pred, labels=[0, 1]).tolist()
        if evaluation_available
        else None
    )
    evaluation = {
        "available": evaluation_available,
        "source": "observed NPCINC <= 4" if evaluation_available else "unavailable",
        "n_test": int(len(eval_cls_true)),
        "n_train": int(np.count_nonzero(observed_train)),
    }

    # The exact feature order this forest was fit on. The train-only run pins
    # it to the notebook's seven TOINC/FSIZE columns; everything else keeps the
    # full FEATURE_COLUMNS list. Recording anything else makes predict() feed
    # the forest the wrong matrix ("X has 20 features ... expecting 7").
    used_columns = list(columns) if columns else list(_features.FEATURE_COLUMNS)

    importance_model = reg or clf
    importance = {
        name: round(float(value), 5)
        for name, value in zip(used_columns, importance_model.feature_importances_)
    }
    analytics = {
        "evaluation": evaluation,
        "accuracy": round(float(accuracy_score(eval_cls_true, eval_cls_pred)), 4) if evaluation_available else None,
        "precision": round(float(precision_score(eval_cls_true, eval_cls_pred, zero_division=0)), 4) if evaluation_available else None,
        "recall": round(float(recall_score(eval_cls_true, eval_cls_pred, zero_division=0)), 4) if evaluation_available else None,
        "f1": round(float(f1_score(eval_cls_true, eval_cls_pred, zero_division=0)), 4) if evaluation_available else None,
        "roc_auc": round(auc, 4) if auc is not None else None,
        "confusion_matrix": matrix,
        "r2": round(float(r2_score(eval_reg_true, eval_reg_pred)), 4)
        if reg_pred is not None and len(eval_reg_true) >= 2 else None,
        "rmse": round(float(root_mean_squared_error(eval_reg_true, eval_reg_pred)), 4)
        if reg_pred is not None and evaluation_available else None,
        "feature_importance": importance,
        "dataset": dataset,
        "train_ms": round((time.time() - started) * 1000, 1),
    }

    _config.MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = _config.MODEL_DIR / f"rf_ranking_seed{seed}.joblib"
    model_id = uuid.uuid4().hex
    # Which upload produced this forest. A later ranking run compares this to
    # the file currently in Storage and reuses the model when they match.
    training_file = _csv_data.uploaded_file_identity() if income_ranked else None
    payload = {
        "classifier": clf,
        "regressor": reg,
        "feature_columns": list(used_columns),
        "model_id": model_id,
        "training_file": training_file,
        "model_params": {
            "max_depth": max_depth,
            "min_samples_leaf": min_samples_leaf,
            "min_samples_split": 2 if income_ranked else 5,
            "class_weight": "balanced",
        },
        "medians": medians,
        "seed": seed,
        "n_trees": n_trees,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "local",
        "n_samples": int(len(rows)),
        "n_real": int(len(real_rows)),
        "n_synthetic": int(len(synth)),
        "n_csv": int(len(csv_rows)),
        "sklearn_version": __import__("sklearn").__version__,
        "persisted": False,
        "analytics": analytics,
        "weights": {
            "financial_need": _config.W_NEED,
            "ocr_match": _config.W_OCR,
            "academic": _config.W_ACADEMIC,
        },
    }
    joblib.dump(payload, model_path, compress=3)
    size_kb = round(model_path.stat().st_size / 1024.0, 1)

    # The train panel ("Machine learning train data") exists to produce THE
    # model the main AI-Ranking scores with. The main ranking's
    # rank_model.load_external() globs scholarship_rf_model.joblib (the same
    # name the Colab notebook exports), but deliberately skips the local
    # rf_ranking_seed*.joblib above - so also write the payload under that
    # name. From then on Step 1->Step 2 "Execute AI Ranking" loads THIS trained
    # forest instead of retraining on synthetic rows, keeping OCR+ITR ranking
    # accurate and consistent with the notebook.
    deployed_path: Optional[Path] = None
    persisted = False
    if income_ranked:
        deployed_path = _config.MODEL_DIR / "scholarship_rf_model.joblib"
        payload["persisted"] = True
        joblib.dump(payload, deployed_path, compress=3)
        try:
            from . import storage as _storage

            _storage.upload(
                _config.MODEL_STORAGE_BUCKET,
                _config.MODEL_STORAGE_PATH,
                deployed_path.read_bytes(),
            )
            persisted = True
        except Exception as exc:
            payload["persisted"] = False
            joblib.dump(payload, deployed_path, compress=3)
            # The local artifact remains usable for this invocation; surface
            # persistence failure in analytics instead of hiding it.
            csv_warnings.append(f"Trained model could not be persisted to Storage: {exc}")
        # Mirror every displayable field into a plain JSON sidecar next to the
        # joblib. The Next.js panel cannot unpickle a joblib (that needs Python
        # + scikit-learn), so /api/ml/model-info reads this file instead - it is
        # how the analytics panel keeps showing real metrics even when the
        # NDJSON stream is interrupted mid-run.
        _write_model_meta_sidecar(payload, deployed_path)

    return {
        "classifier": clf,
        "regressor": reg,
        "medians": medians,
        "feature_columns": list(used_columns),
        "external": False,
        "external_info": None,
        "n_samples": int(len(rows)),
        "n_real": int(len(real_rows)),
        "n_synthetic": int(len(synth)),
        "n_csv": int(len(csv_rows)),
        "csv_warnings": list(csv_warnings),
        "dataset": analytics["dataset"],
        "n_trees": int(n_trees),
        "model_params": payload["model_params"],
        "seed": int(seed),
        **analytics,
        "model_path": str(model_path).replace("\\", "/"),
        "model_id": model_id,
        "trained_at": payload["created_at"],
        "model_size_kb": size_kb,
        # Set on a train-panel run: the path the main AI-Ranking will load
        # (scholarship_rf_model.joblib). The pipeline logs it so the admin can
        # see the model was deployed for Step 1 -> Step 2 ranking.
        "deployed_path": str(deployed_path).replace("\\", "/") if deployed_path else None,
        "persisted": persisted,
    }


def _columns_for(model, payload: Dict) -> List[str]:
    """Feature order a loaded forest expects.

    Preference order:
    1. ``feature_names_in_`` - scikit-learn records this when the model was fit
       on a DataFrame, which is exactly what the Colab notebook does
       (``X = df_train[feature_cols]``). Authoritative and self-describing.
    2. ``feature_columns`` written into the payload.
    3. The payload's ``medians`` keys, when their count matches
       ``n_features_in_`` - older Colab exports carry only the medians dict.
    4. Fail loudly rather than silently feeding columns in the wrong order.
    """
    n_features = int(getattr(model, "n_features_in_", 0) or 0)

    # feature_names_in_ is a numpy array - never truth-test it (`or []`
    # raises "truth value of an array is ambiguous").
    raw_names = getattr(model, "feature_names_in_", None)
    named = [str(c) for c in raw_names] if raw_names is not None else []
    if named:
        if not n_features or len(named) == n_features:
            return named

    declared = [str(c) for c in (payload.get("feature_columns") or [])]
    if declared:
        if not n_features or len(declared) == n_features:
            return declared
        raise ValueError(
            f"model declares {len(declared)} feature_columns but the forest expects "
            f"{n_features} - the joblib payload is inconsistent"
        )

    if named:
        return named

    medians = payload.get("medians") or {}
    keys = [str(k) for k in medians.keys()]
    if keys and (not n_features or len(keys) == n_features):
        return keys

    raise ValueError(
        "model payload carries no feature_names_in_, feature_columns or usable "
        "medians dict - cannot determine the training feature order"
    )


def _reject_grade_features(columns: List[str]) -> None:
    grade_columns = {"academic_norm", "shs_gwa", "college_gpa", "gwa", "gpa"}
    included = [column for column in columns if column.strip().lower() in grade_columns]
    if included:
        raise ValueError(
            "The saved ranking model uses grade feature(s) "
            f"{', '.join(included)}. Retrain it before ranking; grades are no longer "
            "permitted as ranking inputs."
        )


def load_external(path=None, required: bool = False) -> Optional[Dict]:
    """Load a model trained outside this process (Google Colab export).

    Returns a ``trained`` dict shaped exactly like :func:`train`'s return
    value so :func:`predict` and the ``train`` analytics event work unchanged.
    Returns ``None`` when no external model is configured or the file is
    missing, so callers can fall back to training locally.
    """
    import joblib

    if path is None:
        path = _config.external_model_path(required=required)
    downloaded_from_storage = False
    if path is None:
        from . import storage as _storage

        cached = _config.MODEL_DIR / _config.MODEL_STORAGE_PATH
        try:
            model_bytes = _storage.download(
                _config.MODEL_STORAGE_BUCKET,
                _config.MODEL_STORAGE_PATH,
            )
        except _storage.StorageError as exc:
            if exc.status_code != 404:
                raise
        else:
            cached.parent.mkdir(parents=True, exist_ok=True)
            cached.write_bytes(model_bytes)
            path = cached
            downloaded_from_storage = True
    if path is None:
        return None
    model_path = Path(path)
    if not model_path.is_file():
        return None

    payload = joblib.load(model_path)
    clf = None
    reg = None

    if isinstance(payload, dict):
        clf = payload.get("classifier") or payload.get("model")
        reg = payload.get("regressor")
        meta = payload
    elif hasattr(payload, "predict"):
        # The Colab notebook saves the bare estimator:
        #   joblib.dump(rf_model, 'scholarship_rf_model.joblib')
        # A classifier-only model has no regressor, so predict() derives the
        # priority score from class probabilities instead.
        estimator = payload
        meta = {}
        if hasattr(estimator, "predict_proba") and not hasattr(estimator, "feature_importances_"):
            clf, reg = None, estimator
        elif hasattr(estimator, "feature_importances_"):
            clf, reg = estimator, None
        else:
            raise ValueError(f"{model_path.name}: unsupported estimator {type(estimator).__name__}")
    else:
        raise ValueError(
            f"{model_path.name}: expected a joblib dict or a fitted estimator, "
            f"got {type(payload).__name__}"
        )

    if clf is None and reg is None:
        raise ValueError(
            f"{model_path.name}: payload needs a 'classifier' and/or 'regressor' "
            f"(found {sorted(meta.keys())})"
        )

    probe = reg or clf
    columns = _columns_for(probe, meta)
    _reject_grade_features(columns)
    medians = dict(meta.get("medians") or {})
    for col in columns:
        medians.setdefault(col, 0.0)

    size_kb = round(model_path.stat().st_size / 1024.0, 1)
    analytics = meta.get("analytics") or {}
    evaluation_data = analytics.get("evaluation")
    evaluation = evaluation_data if isinstance(evaluation_data, dict) else {
        "available": False,
        "source": "unavailable",
        "n_test": 0,
        "n_train": 0,
    }
    has_observed_evaluation = (
        evaluation.get("available") is True
        and evaluation.get("source") == "observed NPCINC <= 4"
        and int(evaluation.get("n_test") or 0) > 0
    )
    info = {
        "model_path": str(model_path).replace("\\", "/"),
        "model_id": meta.get("model_id"),
        "model_size_kb": size_kb,
        "source": meta.get("source") or "external",
        "trained_at": meta.get("created_at"),
        "n_features": len(columns),
        "feature_columns": columns,
        "seed": int(meta.get("seed") or _config.DEFAULT_SEED),
        "n_trees": int(
            meta.get("n_trees")
            or getattr(probe, "n_estimators", 0)
            or 0
        ),
        "model_params": meta.get("model_params") or {},
    }

    # Feature importance is available straight from the forest even when the
    # export carries no metrics of its own.
    importances = dict(analytics.get("feature_importance") or {})
    if not importances and hasattr(probe, "feature_importances_"):
        importances = {
            name: round(float(value), 5)
            for name, value in zip(columns, probe.feature_importances_)
        }

    return {
        "classifier": clf,
        "regressor": reg,
        "medians": medians,
        "feature_columns": columns,
        "model_id": info["model_id"],
        "trained_at": info["trained_at"],
        "model_params": info["model_params"],
        "external": True,
        "external_info": info,
        # The upload this forest was fitted on (None for older/Colab exports).
        # pipeline.py compares it with the file currently in Storage to decide
        # whether reusing the saved model is safe or a refit is required.
        "training_file": meta.get("training_file"),
        "n_samples": int(meta.get("n_samples") or 0),
        "n_real": int(meta.get("n_real") or 0),
        "n_synthetic": int(meta.get("n_synthetic") or 0),
        "n_csv": int(meta.get("n_csv") or 0),
        "csv_warnings": [],
        "dataset": analytics.get("dataset"),
        "evaluation": evaluation,
        "n_trees": info["n_trees"],
        "seed": info["seed"],
        "accuracy": analytics.get("accuracy") if has_observed_evaluation else None,
        "precision": analytics.get("precision") if has_observed_evaluation else None,
        "recall": analytics.get("recall") if has_observed_evaluation else None,
        "f1": analytics.get("f1") if has_observed_evaluation else None,
        "roc_auc": analytics.get("roc_auc") if has_observed_evaluation else None,
        "confusion_matrix": analytics.get("confusion_matrix") if has_observed_evaluation else None,
        "r2": analytics.get("r2") if has_observed_evaluation else None,
        "rmse": analytics.get("rmse") if has_observed_evaluation else None,
        "feature_importance": importances,
        "train_ms": analytics.get("train_ms", 0.0),
        "persisted": downloaded_from_storage or bool(meta.get("persisted")),
        **info,
    }


def _income_for_tiebreak(item: Dict) -> float:
    """Return declared model income for deterministic probability ties.

    ``income_used`` is declared annual income; OCR values are retained only for
    the separate ITR audit and never decide the tie.
    Rows without a usable declared amount sort last within a probability tie.
    """
    for key in ("income_used", "declared_income", "annual_income_family"):
        value = item.get(key)
        if value is not None:
            try:
                number = float(value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(number):
                return number
    return math.inf


def predict(rows: List[Dict], trained: Dict) -> List[Dict]:
    """Score applicants; highest model-predicted priority probability ranks first."""
    if not rows:
        return []
    # Column order comes from the model that is about to score, not from the
    # current FEATURE_COLUMNS - a forest exported from Google Colab may have
    # been trained on a shorter/older feature list.
    columns = [str(c) for c in (trained.get("feature_columns") or _features.FEATURE_COLUMNS)]
    _reject_grade_features(columns)
    X, _ = _features.matrix(rows, trained["medians"], columns=columns)

    reg = trained.get("regressor")
    clf = trained.get("classifier")

    # A forest fit on a DataFrame (the Colab notebook) records feature_names_in_
    # and warns on a bare ndarray. Scoring a DataFrame with those exact column
    # names keeps the run silent and the column order pinned.
    probe = reg or clf
    if probe is not None and getattr(probe, "feature_names_in_", None) is not None:
        try:
            import pandas as pd
        except ImportError:
            # scikit-learn accepts the correctly ordered NumPy matrix too.
            # pandas is optional so the Vercel ML function stays below its
            # deployment size limit.
            pass
        else:
            X = pd.DataFrame(X, columns=columns)

    if clf is not None:
        labels = clf.predict(X)
        probabilities = clf.predict_proba(X)[:, 1]
        scores = np.clip(probabilities * 100.0, 0.0, 100.0)
    elif reg is not None:
        scores = reg.predict(X)
        # Regressor scores are 0-100 priority points; report them as a
        # probability so the UI's % column stays on a 0-1 scale.
        probabilities = np.clip(np.asarray(scores, dtype=float) / 100.0, 0.0, 1.0)
        labels = (
            np.asarray(scores, dtype=float) >= _config.HIGH_NEED_LABEL_SCORE
        ).astype(int)
    else:
        raise ValueError("trained model has neither a classifier nor a regressor")

    ranked: List[Dict] = []
    for row, score, label, proba in zip(rows, scores, labels, probabilities):
        trust = _features.itr_trust(row)
        ranked.append(
            {
                **{k: row.get(k) for k in (
                    "application_id",
                    "student_name",
                    "student_number",
                    "scholarship",
                    "program",
                    "year_level",
                    "sex",
                    "declared_income",
                    "annual_income_family",
                    "ocr_income",
                    "ocr_error",
                    "ocr_scan_failed",
                    "income_used",
                    "income_source",
                    "income_delta",
                    "ocr_income_differs",
                    "ocr_exact_match",
                    "ocr_status",
                    "financial_need_score",
                    "itr_path",
                    "itr_path_p2",
                    "priority_target",
                    "pwd_flag",
                    "ip_flag",
                    "solo_parent_flag",
                    "four_ps_flag",
                    "first_gen_flag",
                    "priority_bonus",
                )},
                "ocr_match_pct": (
                    row.get("ocr_match_pct")
                    if row.get("ocr_status") != "not_comparable"
                    else None
                ),
                "itr_trust": trust,
                "itr_verified": trust == "verified",
                "priority_score": round(float(score), 2),
                "prediction": "High Need" if int(label) == 1 else "Low Need",
                "probability": round(float(proba), 4),
            }
        )

    # The trained model's predicted prioritized-class probability is the
    # ranking basis. Income used by the model breaks probability ties.
    ranked.sort(
        key=lambda item: (
            -item["probability"],
            _income_for_tiebreak(item),
            -item["priority_score"],
        )
    )
    for position, item in enumerate(ranked, start=1):
        item["rank"] = position
    return ranked
