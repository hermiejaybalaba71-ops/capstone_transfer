# Deployment Guide

This project is separated into a Next.js frontend and a FastAPI backend. It deploys as
**one Vercel project with two services** (see `vercel.json`):

| Part | Tech | Where it runs |
|------|------|---------------|
| Frontend | Next.js + TypeScript in `src/` (repo root) | Vercel service `app` |
| Backend | Python FastAPI in `backend/app/main.py` | Vercel service `ml` |
| Database | PostgreSQL | Supabase (main + registrar projects) |

`vercel.json` binds the `ml` service to the frontend as the `ML_URL` environment variable.
The backend's ML pipeline is in `backend/ml/`.

**Local development** needs Python installed: `py -3 -m pip install -r backend/requirements.txt`.
If `ML_URL` is unset the route falls back to spawning local Python
(`PYTHON_BIN` → `python` → `py -3`), so no service binding is needed on your machine.

---

## 1. Create a GitHub repository

1. Go to https://github.com, sign in (create an account if needed).
2. Click **+ → New repository**.
3. Name it (e.g. `scholar-capstone`), make it **Private**, do **NOT** add a README.
4. Click **Create repository**.
5. On the next screen you'll see commands to push an existing repo.

Run these in your terminal (from this project folder) to upload the code:

```bash
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<YOUR_USERNAME>/scholar-capstone.git
git push -u origin main
```

> Make sure `servicerole.txt`, `.env.local`, and scratch `.txt`/`.log` files are NOT pushed
> (they are already ignored). Never push your Supabase service_role key.

---

## 2. Deploy to Vercel

1. Go to https://vercel.com and sign in with your GitHub account.
2. Click **Add New → Project**.
3. Select your `scholar-capstone` repo.
4. Vercel auto-detects Next.js. **Framework: Next.js**.
5. Leave the Vercel **Root Directory** at the repo root (it is no longer `frontend` — the app
   now lives at the root, and `vercel.json` sets `"root": "."`), then under **Environment Variables**, add these values for **Production** (and
   **Preview** if you test preview deployments):
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase project URL (`https://xxxx.supabase.co`)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your anon key
   - `NEXT_PUBLIC_REGISTRAR_SUPABASE_URL` = your registrar Supabase project URL
   - `NEXT_PUBLIC_REGISTRAR_SUPABASE_ANON_KEY` = your registrar anon key
   - `SUPABASE_SERVICE_ROLE_KEY` = **main project** service_role key (used server-side only by
     `/api/ml/training-data`, `/api/admin/delete-user`, `/api/faculty/scan-alerts` and by
     `ml/pipeline.py` to list/download ITR files)
   - `PYTHON_BIN` = optional, only if the runner's Python is not on `PATH`
6. Click **Deploy**. When done you get a URL like `https://scholar-capstone.vercel.app`.

> Do not upload `.env.local` or paste it into GitHub. Use [env.example](env.example)
> as the safe template, and add each real value separately in Vercel. After changing
> an environment variable, redeploy so the new value is available to server functions.

> The ML ranking page calls the same-origin `/api/ml/ocr-rank` route, which is bound to the
> `ml` service through `ML_URL` — no backend URL to configure by hand.

---

## Local `.env.local`

```bash
copy env.example .env.local
```

`.env.local` is gitignored — never commit it or the service_role key.

---

## Updating after changes

After you `git push`, Vercel auto-redeploys the app. That's it.

## Env vars recap

| Variable | Example | Where |
|----------|---------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://xflsxzmniseetvkrddmj.supabase.co` | Vercel + `.env.local` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `eyJ...` | Vercel + `.env.local` |
| `NEXT_PUBLIC_REGISTRAR_SUPABASE_URL` | `https://zcnqxuydwagecdvitdva.supabase.co` | Vercel + `.env.local` |
| `NEXT_PUBLIC_REGISTRAR_SUPABASE_ANON_KEY` | `eyJ...` | Vercel + `.env.local` |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJ...` (main project) | Vercel + `.env.local` |
| `PYTHON_BIN` | `C:\Program Files\Python314\python.exe` | optional, local only |
| `ML_URL` | injected by `vercel.json` | Vercel (do not set by hand) |

> ⚠️ Do **not** reuse a registrar service_role key here: the one on file for the registrar
> project has `iat` in the future (2029) and Supabase rejects it with **401**. The app only
> needs the **main** service_role key; the registrar project is accessed with its anon key.
