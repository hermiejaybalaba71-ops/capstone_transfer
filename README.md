# Scholarship Management System

A full-stack scholarship management system for a college (SPC). Students apply to
scholarship programs, submit supporting documents and CHED application forms, and are
ranked by a Machine Learning (Random Forest) model written in Python. CHED personnel
and an Administrator review, approve, and notify applicants.

## Tech Stack

- **Frontend:** Next.js (App Router), React, Tailwind CSS, TypeScript, in `src/` (repo root)
- **Backend:** FastAPI and Python, in `backend/`
- **Database & Auth:** Supabase (PostgreSQL + RLS) — main project + a separate registrar project
- **ML Ranking:** Python — OCR (RapidOCR / onnxruntime-DirectML) + scikit-learn Random Forest, in `backend/ml/`

## Project structure

```text
src/                     # Next.js user interface (repo root)
├── app/                 # Pages and temporary compatibility route adapters
├── components/          # React components
└── lib/                 # Frontend utilities and shared TypeScript code
public/                  # Static assets

backend/                  # Python server and backend processing
├── app/main.py           # FastAPI entrypoint
├── ml/                   # OCR, ranking, and spreadsheet processing
└── requirements.txt      # Python dependencies

tools/                    # Optional Colab and local training utilities
├── colab/
└── training/
```

The backend service is available at `http://localhost:8000` and currently exposes
the ML pipeline at `POST /pipeline`. The Next.js app runs at `http://localhost:3000`.
The existing `src/app/api/` files are compatibility adapters for the current
UI and will call the FastAPI service as backend endpoints are migrated.

## Features

- **Student:** register, apply to scholarship programs, upload documents (COR, Valid ID,
  Signature Form, Academic Record) and academic records, view application status & notifications.
- **Admin:** manage applications (status filter, batch approve/reject/notify, notify missing
  documents, full detail view, CSV export), run ML ranking, approve beneficiaries.
- **CHED:** review ranking result, manage applications (mirrors Admin), approve beneficiaries,
  export final list.
- **Faculty:** early warning alerts and interventions.
- **Business rule:** a student may apply to multiple programs, but approving **one** application
  automatically marks all their other applications as **Not Approved** and notifies them.
- **Notifications:** bell with unread badge across all dashboards.

## Roles

| Role | Access |
|------|--------|
| Student | Apply, upload docs, view status |
| Faculty | Alerts, interventions |
| CHED | Applications (manage), Ranking Result, Approvals |
| Admin | Applications (manage), Ranking, Approvals, Programs, Users |

## Getting Started (local)

```powershell
npm install
npm run dev        # app on http://localhost:3000

cd backend
py -3 -m pip install -r requirements.txt
py -3 -m uvicorn app.main:app --reload --port 8000
```

Copy `.env.local.example` to `.env.local` and fill in the Supabase values
(see `DEPLOYMENT.md`). Without them every page fails with
`Supabase is not configured`.

## Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for the Vercel deployment guide.