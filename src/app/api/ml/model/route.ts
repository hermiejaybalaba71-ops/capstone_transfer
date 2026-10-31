import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";

// The trained model the "Execute Training Data" button deploys. The main
// Execute AI Ranking loads this exact file, so admins can download it as the
// Colab-equivalent artifact (scholarship_rf_model.joblib).
const MODEL_DIR = path.join(process.cwd(), "..", "backend", "ml", "models");
const MODEL_NAME = "scholarship_rf_model.joblib";

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
  if (!row || row.role !== "Admin") return "Only admins can download the model.";
  return true;
}

export async function GET(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  const modelPath = path.join(MODEL_DIR, MODEL_NAME);
  try {
    const info = await stat(modelPath);
    const bytes = await readFile(modelPath);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(info.size),
        // Force a download with the canonical Colab-export filename.
        "Content-Disposition": `attachment; filename="${MODEL_NAME}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "No trained model yet. Run Execute Training Data first." },
      { status: 404 },
    );
  }
}
