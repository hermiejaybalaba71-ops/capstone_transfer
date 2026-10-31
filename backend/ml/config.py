"""Configuration, environment loading and tunable ranking weights."""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional

ML_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = ML_DIR.parent
_runtime_model_dir = os.environ.get("ML_RUNTIME_MODEL_DIR")
if _runtime_model_dir:
    MODEL_DIR = Path(_runtime_model_dir)
elif os.environ.get("VERCEL") or str(ML_DIR).startswith("/var/task"):
    MODEL_DIR = Path("/tmp/ml-models")
else:
    MODEL_DIR = ML_DIR / "models"
REPOSITORY_ROOT = PROJECT_ROOT.parent
ENV_FILES = (
    PROJECT_ROOT / ".env.local",
    REPOSITORY_ROOT / ".env.local",
)

# --- model defaults -------------------------------------------------------
DEFAULT_SEED = 2026
DEFAULT_N_TREES = 100
DEFAULT_SYNTH_SAMPLES = 800
DEFAULT_MAX_DEPTH = 8
# Serverless and non-Windows runtimes cannot create joblib workers reliably.
RF_N_JOBS = 1 if os.environ.get("VERCEL") or os.name != "nt" else -1

# --- externally trained model (Google Colab export) ------------------------
# A forest fitted by Execute Training Data is deployed as
# scholarship_rf_model.joblib. ML_EXTERNAL_MODEL points at an exact file;
# otherwise the deployed model is preferred, followed by older Colab artifacts.
# ML_MODEL_MODE picks the
# behaviour:
#   auto   (default) - use the external model when one exists, else train here
#   external         - require it; missing file is an error, never a silent
#                      fallback to a locally trained forest
#   local            - ignore any exported model and always retrain
EXTERNAL_MODEL_ENV = "ML_EXTERNAL_MODEL"
MODEL_MODE_ENV = "ML_MODEL_MODE"


def external_model_path(required: bool = False) -> Optional[Path]:
    """File for a model trained outside this process, or None when absent."""
    mode = (os.environ.get(MODEL_MODE_ENV) or "auto").strip().lower()
    if mode == "local":
        if required:
            raise FileNotFoundError(
                f"{MODEL_MODE_ENV}=local - external model loading is disabled"
            )
        return None

    explicit = os.environ.get(EXTERNAL_MODEL_ENV, "").strip().strip('"').strip("'")
    candidates: List[Path] = []
    if explicit:
        candidates.append(Path(explicit))
    else:
        # Prefer the model most recently deployed by Execute Training Data.
        # Older Colab exports remain supported as a fallback.
        patterns = (
            "scholarship_rf_model.joblib",
            "scholarship_*model*.joblib",
            "*colab*.joblib",
        )
        for folder in (MODEL_DIR, PROJECT_ROOT):
            if folder.is_dir():
                for pattern in patterns:
                    candidates.extend(sorted(folder.glob(pattern)))

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    if required:
        hint = f"{EXTERNAL_MODEL_ENV}=<file>" if not explicit else explicit
        raise FileNotFoundError(
            "no externally trained model found - expected a *colab*.joblib in "
            f"ml/models/ or the project root (set {hint} to point at one)"
        )
    return None

# --- financial-need scaling (pesos) ---------------------------------------
INCOME_FLOOR = 100_000.0       # annual family income -> need score 100
INCOME_CEIL = 600_000.0        # annual family income -> need score 0
HIGH_NEED_INCOME = 150_000.0   # app-wide "High Need" cut-off (matches lib/ml)

# --- composite priority target (what the regressor learns) ---------------
# Colab-aligned ranking uses the trained classifier probability on declared
# annual-income features. OCR match is a separate validation signal and does
# not change model inputs or priority ordering.
W_NEED = 1.00                  # financial need score (driven by the ITR income)
W_OCR = 0.00                   # comparison is for review, not a score component
W_ACADEMIC = 0.00              # academics excluded on purpose

OCR_TRUST_MIN_PCT = 90.0       # typed vs ITR align >= this % = "ITR verified"

# --- statutory priority flags (the no-ITR / no-income fallback) ------------
# Points added to the priority target for every historical row (and for live
# applicants) that carries a declared priority status. Legal basis:
#   PWD  +15  RA 7277 (Magna Carta for Disabled Persons)
#   IP   +15  RA 8371 (Indigenous Peoples Rights Act)
#   Solo +10  RA 8972 (Solo Parents' Welfare Act)
#   4Ps  +10  DSWD Pantawid Pamilyang Pilipino Program (poverty indicator)
#   1st  +5   CHED first-generation college priority
# When no ITR / income exists these flags - not a guess - drive the score.
W_PWD = 15.0
W_IP = 15.0
W_SOLO_PARENT = 10.0
W_FOUR_PS = 10.0
W_FIRST_GEN = 5.0

# Where the dataset-based score is applied:
#   True  -> ONLY the rows of the uploaded historical training file are scored
#            with it (neutral need baseline + statutory priority flags). The
#            old income / ITR ranking for live applicants is left untouched.
#   False -> every row uses the original income-driven formula.
HISTORICAL_DATASET_RANKING = True

HIGH_NEED_LABEL_SCORE = 55.0   # classifier label threshold
NEUTRAL_NEED_SCORE = 50.0      # baseline when no income signal is used

# --- storage --------------------------------------------------------------
STORAGE_BUCKET = "itr-documents"
MODEL_STORAGE_BUCKET = "training-data"
MODEL_STORAGE_PATH = "models/scholarship_rf_model.joblib"

# --- OCR limits -----------------------------------------------------------
OCR_MAX_VARIANTS = 3           # preprocessing candidates tried before giving up
OCR_LINE_PREVIEW = 8           # OCR lines returned per document for the UI
OCR_MIN_CONFIDENCE = 0.30


def load_env(path: Optional[Path] = None) -> dict:
    """Read ``.env.local`` style KEY=VALUE lines into a dict (never logged)."""
    out: dict = {}
    env_paths = (Path(path),) if path else ENV_FILES
    for env_path in env_paths:
        try:
            for raw in env_path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                out[key.strip()] = value.strip().strip('"').strip("'")
        except OSError:
            continue
    # Process env always wins.
    for key, value in os.environ.items():
        if value:
            out.setdefault(key, value)
    return out


def supabase_config(env: Optional[dict] = None) -> tuple:
    env = env if env is not None else load_env()
    url = env.get("NEXT_PUBLIC_SUPABASE_URL", "").rstrip("/")
    key = env.get("SUPABASE_SERVICE_ROLE_KEY") or env.get("NEXT_PUBLIC_SUPABASE_ANON_KEY") or ""
    return url, key


def stack_info() -> dict:
    """Versions of every library used - surfaced in the UI analytics panel.

    Reads distribution metadata only: importing onnxruntime/rapidocr just to
    print a version string costs ~28 s on this machine.
    """
    from importlib.metadata import PackageNotFoundError, version as _dist_version

    info = {"python": ".".join(str(v) for v in __import__("sys").version_info[:3])}
    for dist_name in (
        "numpy",
        "scikit-learn",
        "joblib",
        "pillow",
        "rapidocr-onnxruntime",
        "onnxruntime-directml",
        "opencv-python",
        "opencv-python-headless",
    ):
        try:
            info[dist_name] = _dist_version(dist_name)
        except PackageNotFoundError:
            continue
    if "onnxruntime-directml" in info:
        info["onnxruntime"] = info["onnxruntime-directml"]
    if "opencv-python" not in info and "opencv-python-headless" in info:
        info["opencv-python"] = info["opencv-python-headless"]
    return info
