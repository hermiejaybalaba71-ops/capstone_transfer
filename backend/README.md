# Backend

This folder contains the Python backend for the scholarship system.

## Run locally

From the repository root:

```powershell
py -3 -m pip install -r backend\requirements.txt
cd backend
py -3 -m uvicorn app.main:app --reload --port 8000
```

The FastAPI service is available at `http://localhost:8000`.

## Endpoints

- `GET /` - backend health check
- `POST /pipeline` - OCR and Random Forest ranking stream

The OCR, ranking, storage, and spreadsheet processing code is in `backend/ml/`.

### OCR resource use

OCR scans the original page by default and checks both confidence thresholds.
For difficult or low-quality scans, enable additional preprocessing retries by
setting `OCR_MAX_VARIANTS=3` before starting the backend. More retries can
improve recovery, but increase scan time and memory use. Values from `0` to
`3` are supported; `0` is the lightweight default.
