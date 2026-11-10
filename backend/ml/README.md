# AI OCR + Random Forest ranking pipeline

Python side of the ranking feature. It reads every ITR image uploaded to the
`itr-documents` Supabase bucket with OCR, compares the figure it reads against the
income the applicant typed, then scores applicants with a Random Forest trained
on the uploaded PSA FIES 2025 dataset.

## Tools used

| Step | Tool | Version |
| --- | --- | --- |
| Runtime | Python | 3.14.3 |
| Image preprocessing (decode, upscale, normalize, Otsu, deskew) | Pillow | 12.3.0 |
| Numerics, feature matrix, median imputation | NumPy | 2.5.3 |
| Median/rank maths inside the preprocessor | SciPy | 1.18.1 |
| Text detection + recognition (OCR) | rapidocr-onnxruntime (PP-OCRv3) | 1.2.3 |
| OCR inference runtime | ONNX Runtime (CPU on Vercel, DirectML GPU on Windows) | 1.24.4+ |
| OCR image operations | OpenCV | 5.0.0.93 locally; headless 4.10.0.84 on Vercel |
| Random Forest classifier (+ regressor for non-Colab local runs), metrics | scikit-learn | 1.9.1 |
| Model persistence (`rf_ranking_seed2026.joblib`) | joblib | 1.6.0 |
| Storage, streaming, process bridge | FastAPI service | `backend/app/main.py` and `backend/ml/service.py` |

Install dependencies locally with `py -3 -m pip install -r backend\requirements.txt`
(install `onnxruntime-directml` last so it replaces the stock ONNX Runtime).
Vercel uses the same `backend/requirements.txt` manifest through its default
Python dependency installation and function-bundle optimization. Keep custom
install/build commands out of `vercel.json`; they disable the automatic bundle
optimization needed by the OCR and machine-learning dependencies.

The ML service root health response reports `ocr_ready`, the loaded runtime
versions, and any import errors. A healthy service with `ocr_ready: false` can
still serve non-OCR requests, but ITR scans will report the specific runtime
failure instead of claiming that no income was found.

## Files

- `config.py` - `.env.local` loader, priority weights, income limits, stack versions.
- `preproc.py` - image decode / enhancement / candidate variants.
- `ocr_engine.py` - RapidOCR wrapper: DirectML execution provider, extraction
  from common BIR family-income and compensation-income labels, plus separately
  labeled 1701-MS income and tax/payment candidates. The annual compensation
  figure is kept distinct from taxable income and tax due; tax/payment amounts
  are never substitutes for income. OCR extraction is best-effort and requires
  manual verification before treating a candidate as ground truth.
- `cache.py` - OCR result cache keyed by `path|size|updated_at` (skips unchanged files).
- `features.py` - the model feature set, financial-need score, priority target.
- `rank_model.py` - synthetic training rows, RandomForest fit, metrics, joblib dump.
- `storage.py` - recursive bucket listing + signed URL download (service role key).
- `pipeline.py` - NDJSON CLI: `echo '{...}' | python ml\pipeline.py`.
- `service.py` - internal FastAPI endpoints for the ranking pipeline and CSV / Excel sheet parsing (`POST /parse-sheet`). Vercel's Node.js app delegates sheet parsing here instead of requiring Python in its runtime.

## Contract

Input (stdin JSON): `mode` (`scan` | `rank` | `full`), `seed`, `n_trees`, `n_synth`,
`applicants[]` (`application_id`, `student_name`, `declared_income`, `itr_path`,
`year_level`, `sex`, `shs_gwa`, `college_gpa`), optional `ocr_results[]`.

Output (stdout, one JSON object per line): `start`, `log`, `doc`, `doc_result`,
`scan_progress`, `scan_analytics`, `preprocess`, `train`, `rank`, `done`, `error`.
Every event carries `t` = seconds since the process started.

## Training and applicant ranking

The uploaded-file training uses the Colab notebook's five income-derived
features and binary target (`NPCINC <= 4`), with the same 80/20 stratified
split, seed 42, 200 trees, depth 3, minimum leaf size 200, and classifier
defaults. A training file must contain valid `TOINC` and `NPCINC` values for
every row; incomplete labels are rejected rather than silently replaced by an
income-derived proxy. The saved classifier is reused for later AI Ranking.
With a program selected when **Execute AI Ranking** is clicked, the pipeline
scans that program's ITRs and scores those applicants using the saved model.
With no program selected, the action performs file-only training and displays
its evaluation and dataset analytics.

The classifier's predicted probability of the prioritized class is the primary
ranking value, so the model that was trained from the dataset also determines
the applicant order. Highest probability ranks first. The applicant's declared
annual family income is mapped to the `TOINC` feature and breaks probability
ties, lowest declared income first. OCR reads the ITR as a separate audit check:
the detected amount and match percentage are displayed, but OCR does not
replace model input or affect the model probability.

The PSA FIES PUF's `TOINC` is total annual family income; `FSIZE` supplies
household size and the `NPCINC <= 4` label is based on per-capita income. The
monthly feature is calculated as `TOINC / 12`; it is not read as a separate
monthly value from the annual 1701-MS return. A tax return reports the filer's
income, which may not equal the whole household income. The 1701-MS Page 2
income candidates (including Gross Compensation Income, taxable compensation,
and business-income fields) are therefore shown with their labels and kept
separate. Page 1 tax due, payable, and payment values are classified as tax
fields, never as income. The current RapidOCR model is pretrained: these
form-specific extraction rules and regression tests do not fine-tune its
recognizer. Genuine OCR training/evaluation needs varied images with manually
verified field labels.

Academic grades (SHS GWA and college GPA) are not ranking inputs. New locally
trained models omit the academic feature, and older saved models that include
grade features are rejected until retrained.

The dataset summary and model analytics are stored inside the deployed model
artifact in Supabase Storage. Accuracy, precision, recall, F1, and ROC-AUC are
evaluated only on held-out rows with an observed `NPCINC` target. R² and RMSE
are only available on the non-Colab regressor path; the Colab-aligned training
fits only the classifier. Incomplete uploaded TOINC/NPCINC data is rejected
rather than scored with proxy labels. Model-evaluation analytics and live
OCR/ranking analytics are displayed separately so training-label validation
isn't confused with the current applicants' OCR match results. The dashboard
shows a persistent model ID in both panels when available, so an admin can
confirm that the ranking run used the same saved artifact whose training
analytics are displayed. Legacy model files without an ID are marked
unconfirmed. Training-data income coverage counts usable income values only;
it does not claim that training rows contain ITR images or were OCR-verified.

## Performance on the reference machine (AMD Athlon 300GE, 2C/4T)

| Path | Time |
| --- | --- |
| Cold scan of a real 2-page ITR (fast pass, `box_thresh=0.75`) | ~60-75 s |
| Full-detail retry (`box_thresh=0.5`) | ~50 s extra |
| Cached scan (unchanged file) | instant |
| `from sklearn.ensemble import ...` first import | 7-41 s (warmed in background during the scan) |
| Random Forest training (801 rows, 100 trees) | ~5-10 s |
| End-to-end cold `mode=full` | ~85 s |
| End-to-end warm `mode=full` | ~39 s |

Optimisations already applied: DirectML execution provider, angle classification
disabled, strict-first/threshold escalation (`0.75 -> 0.5`), OCR result cache,
sub-500 px files skipped, scikit-learn import warmed in a background thread.
