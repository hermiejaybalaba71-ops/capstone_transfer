import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Plain-JSON twin of the deployed joblib (written by rank_model.train()).
// The panel cannot unpickle a joblib - that needs Python + scikit-learn - so
// this sidecar is how the analytics UI reports what the saved model actually
// is, even when the NDJSON stream of a long run dropped mid-way.
const MODEL_DIR = path.join(process.cwd(), "..", "backend", "ml", "models");
const MODEL_NAME = "scholarship_rf_model.joblib";
const SIDECAR_NAME = "scholarship_rf_model.meta.json";

function cookieName() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const match = url.match(/https?:\/\/([^./]+)/);
  return `sb-${match ? match[1] : "xflsxzmniseetvkrddmj"}-auth-token`;
}

function getToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice(7);
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === cookieName()) {
      try {
        const parsed = JSON.parse(decodeURIComponent(rest.join("=")));
        if (parsed?.access_token) return parsed.access_token;
      } catch {
        return rest.join("=");
      }
    }
  }
  return null;
}

async function assertAdmin(req: Request) {
  const token = getToken(req);
  if (!token) return "Not authenticated.";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return "Session expired. Please log in again.";
  const { data: row } = await sb.from("users").select("role").eq("auth_user_id", data.user.id).maybeSingle();
  if (!row || row.role !== "Admin") return "Only admins can view model analytics.";
  return true;
}

export async function GET(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  const sidecarPath = path.join(MODEL_DIR, SIDECAR_NAME);
  const modelPath = path.join(MODEL_DIR, MODEL_NAME);

  let sidecar: Record<string, unknown> | null = null;
  try {
    sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  } catch {
    sidecar = null;
  }

  // The joblib itself is the ground truth for "does a model exist?" - the
  // sidecar may be missing if the model came from an older run or a Colab
  // export, in which case we still report what we can.
  let modelSizeKb: number | null = null;
  let modelMtime: string | null = null;
  try {
    const info = await stat(modelPath);
    modelSizeKb = Math.round((info.size / 1024) * 10) / 10;
    modelMtime = info.mtime.toISOString();
  } catch {
    return NextResponse.json(
      { available: false, error: "No trained model yet. Run Execute Training Data first." },
      { status: 404 },
    );
  }

  if (!sidecar) {
    return NextResponse.json({
      available: true,
      sidecar: false,
      model_size_kb: modelSizeKb,
      model_mtime: modelMtime,
      note: "Model file present but metrics sidecar missing - re-run Execute Training Data to regenerate it.",
    });
  }

  return NextResponse.json({
    available: true,
    sidecar: true,
    ...sidecar,
    // Always override with the live file stat so the panel shows reality even
    // if the sidecar was copied from another machine.
    model_size_kb: modelSizeKb,
    model_mtime: modelMtime,
  });
}
