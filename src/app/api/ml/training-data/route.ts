import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const maxDuration = 60;

const BUCKET = "training-data";
const MAX_BYTES = 10 * 1024 * 1024;

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
  const svc = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await svc.auth.getUser();
  if (error || !data.user) return "Session expired. Please log in again.";
  const { data: row } = await svc.from("users").select("role").eq("auth_user_id", data.user.id).maybeSingle();
  if (!row || row.role !== "Admin") return "Only admins can manage training data.";
  return true;
}

/** Keep the admin's own filename so the panel shows exactly what was uploaded
 *  (e.g. "FIES_PUF_2025_TRAIN.xlsx"), instead of a hardcoded placeholder.
 *  Only strip what a storage path cannot carry: separators and leading dots. */
function objectNameFor(original: string): string {
  const base = original.split(/[\\/]/).pop() || "training_data.xlsx";
  const safe = base.replace(/^[.\s]+/, "").trim();
  return safe || "training_data.xlsx";
}

/** One file per folder: clear whatever is in `historical/` before writing, so
 *  a newly named upload never leaves a stale sibling the loader could pick. */
async function clearHistorical(bucket: Awaited<ReturnType<typeof serviceBucket>>) {
  if (!bucket) return;
  const { data } = await bucket.list("historical", { limit: 100 });
  // `list()` returns `name` relative to the prefix it was called with.
  const paths = (data || []).map((f) => `historical/${f.name}`);
  if (paths.length) await bucket.remove(paths);
}

function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function serviceBucket() {
  const sb = serviceClient();
  if (!sb) return null;

  // Storage buckets are project resources and are not created by a Vercel
  // deployment. Create the private bucket on first use when it is missing.
  const { data: existing, error: lookupError } = await sb.storage.getBucket(BUCKET);
  if (lookupError && !/not found|does not exist/i.test(lookupError.message)) {
    throw new Error(`Could not access Supabase Storage bucket "${BUCKET}": ${lookupError.message}`);
  }
  if (!existing) {
    const { error: createError } = await sb.storage.createBucket(BUCKET, { public: false });
    if (createError && !/already exists/i.test(createError.message)) {
      throw new Error(`Could not create Supabase Storage bucket "${BUCKET}": ${createError.message}`);
    }
  }
  return sb.storage.from(BUCKET);
}

export async function GET(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });
  let bucket;
  try {
    bucket = await serviceBucket();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not access training-data storage." }, { status: 500 });
  }
  if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
  const { data, error } = await bucket.list("historical", { limit: 10 });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const file = (data || []).find((f) => f.metadata) || null;
  if (!file?.metadata) return NextResponse.json({ file: null });
  return NextResponse.json({
    file: {
      name: file.name,
      size: file.metadata.size,
      mimetype: file.metadata.mimetype,
      updated_at: file.updated_at ?? file.created_at,
    },
  });
}

export async function POST(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  // Large workbooks can exceed Vercel's request-body limit before a multipart
  // request reaches this function. Prepare a signed Supabase upload instead.
  if (new URL(req.url).searchParams.get("mode") === "prepare") {
    let input: { name?: unknown; size?: unknown };
    try {
      input = (await req.json()) as { name?: unknown; size?: unknown };
    } catch {
      return NextResponse.json({ error: "Upload metadata must be valid JSON." }, { status: 400 });
    }
    const name = typeof input.name === "string" ? input.name : "";
    const size = typeof input.size === "number" ? input.size : 0;
    const lower = name.toLowerCase();
    const isCsv = lower.endsWith(".csv");
    const isXlsx = lower.endsWith(".xlsx");
    if (!isCsv && !isXlsx) return NextResponse.json({ error: "Only .csv or .xlsx files are accepted." }, { status: 400 });
    if (!Number.isFinite(size) || size <= 0 || size > MAX_BYTES) {
      return NextResponse.json({ error: "File must be larger than 0 and 10 MB or smaller." }, { status: 400 });
    }

    let bucket;
    try {
      bucket = await serviceBucket();
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Could not access training-data storage." }, { status: 500 });
    }
    if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });

    await clearHistorical(bucket);
    const objectPath = `historical/${objectNameFor(name)}`;
    const sb = serviceClient();
    if (!sb) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(objectPath);
    if (error || !data?.token) {
      return NextResponse.json({ error: `Could not prepare training-data upload: ${error?.message || "No upload token returned."}` }, { status: 502 });
    }
    return NextResponse.json({ ok: true, path: objectPath, token: data.token, name, size });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Upload must be multipart/form-data." }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file chosen." }, { status: 400 });

  const lower = file.name.toLowerCase();
  const isCsv = lower.endsWith(".csv");
  const isXlsx = lower.endsWith(".xlsx");
  if (!isCsv && !isXlsx) return NextResponse.json({ error: "Only .csv or .xlsx files are accepted." }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "File must be 10 MB or smaller." }, { status: 400 });

  const text = isCsv ? await file.text() : null;
  let warning: string | undefined;
  if (isCsv) {
    const header = (text || "").split(/\r?\n/, 1)[0]?.toLowerCase() || "";
    const incomeLike = ["income", "annual", "salary", "family", "gross", "amount"].some((k) => header.includes(k));
    if (!incomeLike) {
      warning =
        "No income column detected. The file was saved, but its rows will train with a neutral need score. Ranking still works normally.";
    }
  }

  let bucket;
  try {
    bucket = await serviceBucket();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not access training-data storage." }, { status: 500 });
  }
  if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });

  await clearHistorical(bucket);
  // Store under the file's own name so the panel (and the scan log) show
  // exactly which file is being trained, e.g. FIES_PUF_2025_TRAIN.xlsx.
  const objectPath = `historical/${objectNameFor(file.name)}`;
  const bytes = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await bucket.upload(objectPath, bytes, {
    contentType: isCsv ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    upsert: true,
  });
  if (upErr) {
    return NextResponse.json(
      { error: `Training-data upload failed in Supabase Storage: ${upErr.message}` },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true, name: file.name, size: file.size, ...(warning ? { warning } : {}) });
}

export async function DELETE(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });
  let bucket;
  try {
    bucket = await serviceBucket();
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not access training-data storage." }, { status: 500 });
  }
  if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });
  // Clear the whole folder - the stored name now tracks the upload, so the
  // old fixed names cannot be relied on to find it.
  await clearHistorical(bucket);
  return NextResponse.json({ ok: true });
}
