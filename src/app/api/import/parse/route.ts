import { NextResponse } from "next/server";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const runtime = "nodejs";
// The ML service on Render may be asleep (free tier) when this route is hit:
// waking it costs ~50 s, so this budget has to cover the cold start plus the
// actual sheet parse instead of timing out mid-import.
export const maxDuration = 300;

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED = [".csv", ".xlsx", ".xlsm", ".xltx"];

/** Uploaded sheets are saved so they survive a refresh, exactly like the ML
 *  training-data panel. One bucket, one folder per page. */
const BUCKET = "imported-sheets";
const SCOPES = new Set(["applications", "approvals"]);

let cachedPython: string | null = null;

function resolvePython(): string {
  if (cachedPython) return cachedPython;
  const candidates: Array<{ bin: string; args: string[] }> = [];
  if (process.env.PYTHON_BIN) {
    candidates.push({ bin: process.env.PYTHON_BIN, args: ["-c", "import sys; print(sys.version)"] });
  }
  candidates.push({ bin: "python", args: ["-c", "import sys; print(sys.version)"] });
  candidates.push({ bin: "py", args: ["-3", "-c", "import sys; print(sys.version)"] });
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.bin, candidate.args, {
        windowsHide: true,
        timeout: 15000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (probe.status === 0 && probe.stdout && probe.stdout.toString().trim().startsWith("3")) {
        cachedPython = candidate.bin;
        return cachedPython;
      }
    } catch {
      // try the next candidate
    }
  }
  throw new Error("Python 3 was not found. Install Python 3 (or set PYTHON_BIN) so backend/ml/read_sheet.py can run.");
}

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

/** Only an Admin may upload or delete sheets. Authenticated CHED users may
 *  read approval-list references through GET. */
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
  if (!row || row.role !== "Admin") return "Only admins can manage uploaded files.";
  return true;
}

async function assertAuthenticated(req: Request) {
  const token = getToken(req);
  if (!token) return "Not authenticated.";
  const svc = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await svc.auth.getUser();
  return error || !data.user ? "Session expired. Please log in again." : true;
}

function serviceBucket() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return null;
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return sb.storage.from(BUCKET);
}

/** Keep the admin's own filename (stripped of separators / leading dots) so the
 *  card can show exactly what was uploaded. */
function objectNameFor(original: string): string {
  const base = original.split(/[\\/]/).pop() || "upload.csv";
  return base.replace(/^[.\s]+/, "").trim() || "upload.csv";
}

/** Each imported file gets a unique storage key; same-named uploads coexist. */
function objectsFor(scope: string, original: string, importId: string) {
  const safe = objectNameFor(original);
  const key = `${importId}-${safe}`;
  return { raw: `${scope}/${key}`, sidecar: `${scope}/${key}.json` };
}

export async function POST(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Upload must be multipart/form-data." }, { status: 400 });
  }

  const scope = String(form.get("scope") || "applications");
  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: `Unknown upload scope "${scope}".` }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "No file chosen." }, { status: 400 });

  const suffix = path.extname(file.name).toLowerCase();
  if (!ALLOWED.includes(suffix)) {
    return NextResponse.json(
      { error: `Unsupported file type "${suffix || "(none)"}". Use .csv or .xlsx.` },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json({ error: "File must be 20 MB or smaller." }, { status: 400 });
  }

  let payload: Record<string, unknown>;
  const fileBytes = Buffer.from(await file.arrayBuffer());
  if (process.env.ML_URL) {
    let response: Response;
    try {
      response = await fetch(`${process.env.ML_URL.replace(/\/+$/, "")}/parse-sheet`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-File-Name": encodeURIComponent(file.name),
        },
        body: fileBytes,
        // Cold start (~50 s, free tier) + reading a 20 MB workbook: the old
        // 50 s abort killed the import whenever Render was asleep.
        signal: AbortSignal.timeout(240_000),
      });
    } catch (err: unknown) {
      return NextResponse.json(
        { error: `Could not reach the ML sheet reader: ${err instanceof Error ? err.message : "request failed"}` },
        { status: 502 },
      );
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = await response.json() as Record<string, unknown>;
    } catch {
      return NextResponse.json({ error: "The ML sheet reader returned an invalid response." }, { status: 502 });
    }
    if (!response.ok || parsed.ok !== true) {
      const error = String(parsed.detail || parsed.error || "Could not read this file.");
      const status = response.status >= 400 && response.status < 500 ? response.status : 502;
      return NextResponse.json({ error }, { status });
    }
    payload = parsed;
  } else {
    if (process.env.VERCEL === "1" || process.env.VERCEL_ENV) {
      return NextResponse.json({ error: "The Vercel ML_URL service binding is not configured." }, { status: 503 });
    }
    let pythonBin: string;
    try {
      pythonBin = resolvePython();
    } catch (err: unknown) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Python unavailable." }, { status: 500 });
    }

    const workDir = mkdtempSync(path.join(tmpdir(), "sheet-"));
    // Keep the original extension: read_sheet.py dispatches on it.
    const savedPath = path.join(workDir, `upload${suffix}`);
    try {
      writeFileSync(savedPath, fileBytes);
      const projectRoot = path.resolve(process.cwd(), "..");
      const reader = path.join(projectRoot, "backend", "ml", "read_sheet.py");
      const result = spawnSync(/* turbopackIgnore: true */ pythonBin, [reader, savedPath], {
        windowsHide: true,
        timeout: 45000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf-8",
        cwd: projectRoot,
      });

      const stdout = (result.stdout || "").trim();
      if (!stdout) {
        const detail = (result.stderr || "").trim().split("\n").slice(-4).join(" ");
        return NextResponse.json(
          { error: detail || `Reader exited with code ${result.status ?? "unknown"}.` },
          { status: 500 },
        );
      }

      try {
        payload = JSON.parse(stdout) as Record<string, unknown>;
      } catch {
        return NextResponse.json({ error: "Reader returned unreadable output." }, { status: 500 });
      }
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {
        // temp cleanup is best-effort
      }
    }
  }

  if (payload.ok !== true) {
    return NextResponse.json({ error: String(payload.error || "Could not read this file.") }, { status: 400 });
  }

  const importId = randomUUID();
  const sheet = {
    ...payload,
    import_id: importId,
    file_name: file.name,
    file_size: file.size,
  } as Record<string, unknown>;

  // Keep the upload so it survives a refresh: the raw file plus a JSON
  // sidecar of the parsed sheet (restored by GET, removed by DELETE).
  let saveWarning: string | undefined;
  try {
    const bucket = serviceBucket();
    if (!bucket) throw new Error("Server is missing SUPABASE_SERVICE_ROLE_KEY.");
    const { raw, sidecar } = objectsFor(scope, file.name, importId);
    const { error: rawError } = await bucket.upload(raw, fileBytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
    if (rawError) throw new Error(rawError.message);
    const { error: sidecarError } = await bucket.upload(sidecar, JSON.stringify(sheet), {
      contentType: "application/json",
      upsert: false,
    });
    if (sidecarError) {
      await bucket.remove([raw]);
      throw new Error(sidecarError.message);
    }
  } catch (err: unknown) {
    saveWarning = `Could not save this file for later (a refresh will lose it): ${
      err instanceof Error ? err.message : "storage unavailable"
    }`;
  }

  return NextResponse.json({ ...sheet, saved: !saveWarning, warning: saveWarning });
}

interface RawEntry {
  name: string;
  metadata?: { size?: number; mimetype?: string } | null;
  updated_at?: string;
  created_at?: string;
}

type StorageBucket = ReturnType<SupabaseClient["storage"]["from"]>;

async function listScopeEntries(bucket: StorageBucket, scope: string): Promise<RawEntry[]> {
  const all: RawEntry[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const { data, error } = await bucket.list(scope, { limit, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(error.message);
    const page = (data || []) as RawEntry[];
    all.push(...page);
    if (page.length < limit) return all;
  }
}

/** Re-run the reader over a stored upload, used when the JSON sidecar is
 *  missing. Same call shape as the POST handler above. */
function readStoredFile(bytes: Buffer, name: string): Record<string, unknown> | null {
  const suffix = path.extname(name).toLowerCase();
  if (!ALLOWED.includes(suffix)) return null;
  let pythonBin: string;
  try {
    pythonBin = resolvePython();
  } catch {
    return null;
  }
  const workDir = mkdtempSync(path.join(tmpdir(), "sheet-"));
  const savedPath = path.join(workDir, `stored${suffix}`);
  try {
    writeFileSync(savedPath, bytes);
    const projectRoot = path.resolve(process.cwd(), "..");
    const reader = path.join(projectRoot, "backend", "ml", "read_sheet.py");
    const result = spawnSync(/* turbopackIgnore: true */ pythonBin, [reader, savedPath], {
      windowsHide: true,
      timeout: 45000,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf-8",
      cwd: projectRoot,
    });
    const stdout = (result.stdout || "").trim();
    if (!stdout) return null;
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    return payload.ok === true ? payload : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  }
}

/** Restore every uploaded sheet for a page. Sidecars avoid re-parsing workbooks. */
export async function GET(req: Request) {
  const auth = await assertAuthenticated(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  const scope = new URL(req.url).searchParams.get("scope") || "applications";
  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: `Unknown upload scope "${scope}".` }, { status: 400 });
  }

  const bucket = serviceBucket();
  if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });

  let entries: RawEntry[];
  try {
    entries = await listScopeEntries(bucket, scope);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not list imported files." }, { status: 500 });
  }

  const sidecars = entries.filter((e) => e.name.endsWith(".json"))
    .sort((a, b) => Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || ""));
  const raws = entries
    .filter((e) => !e.name.endsWith(".json"))
    .sort(
      (a, b) =>
        Date.parse(b.updated_at || b.created_at || "") - Date.parse(a.updated_at || a.created_at || ""),
    );

  const sheets: Record<string, unknown>[] = [];
  const restoredRawNames = new Set<string>();
  for (const entry of sidecars) {
    try {
      const { data, error: dlErr } = await bucket.download(`${scope}/${entry.name}`);
      if (dlErr || !data) continue;
      const parsed = JSON.parse(await data.text()) as Record<string, unknown>;
      if (Array.isArray(parsed.columns) && Array.isArray(parsed.rows)) {
        sheets.push({
          ...parsed,
          import_id: parsed.import_id || entry.name.slice(0, -".json".length),
          updated_at: entry.updated_at || entry.created_at,
          restored: true,
        });
        restoredRawNames.add(entry.name.slice(0, -".json".length));
      }
    } catch {
      // Use the corresponding raw file as a recovery path below.
    }
  }

  // Recover raw uploads whose sidecar was missing or unreadable.
  for (const raw of raws) {
    if (restoredRawNames.has(raw.name)) continue;
    try {
      const { data, error: dlErr } = await bucket.download(`${scope}/${raw.name}`);
      if (dlErr || !data) continue;
      const bytes = Buffer.from(await data.arrayBuffer());
      const storedName = raw.name.replace(/\\/g, "/").split("/").pop() || raw.name;
      const parsed = readStoredFile(bytes, storedName);
      if (!parsed) continue;
      const uniqueName = /^([0-9a-f-]{36})-(.+)$/i.exec(storedName);
      sheets.push({
        ...parsed,
        import_id: uniqueName?.[1] || storedName,
        restored: true,
        file_name: uniqueName?.[2] || storedName,
        file_size: raw.metadata?.size ?? bytes.byteLength,
        updated_at: raw.updated_at || raw.created_at,
      });
    } catch {
      continue;
    }
  }
  sheets.sort(
    (a, b) =>
      Date.parse(String(b.updated_at || "")) - Date.parse(String(a.updated_at || "")),
  );
  return NextResponse.json({ ok: true, restored: true, sheets });
}

/** Delete one saved upload, or all uploads when no import_id is supplied. */
export async function DELETE(req: Request) {
  const auth = await assertAdmin(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  const scope = new URL(req.url).searchParams.get("scope") || "applications";
  if (!SCOPES.has(scope)) {
    return NextResponse.json({ error: `Unknown upload scope "${scope}".` }, { status: 400 });
  }

  const bucket = serviceBucket();
  if (!bucket) return NextResponse.json({ error: "Server is missing SUPABASE_SERVICE_ROLE_KEY." }, { status: 500 });

  let entries: RawEntry[];
  try {
    entries = await listScopeEntries(bucket, scope);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not list imported files." }, { status: 500 });
  }
  const importId = new URL(req.url).searchParams.get("import_id");
  const paths = entries
    .filter((entry) => !importId
      || entry.name.startsWith(`${importId}-`)
      || entry.name === `${importId}.json`
      || entry.name === importId)
    .map((e) => `${scope}/${e.name}`);
  if (paths.length) {
    const { error } = await bucket.remove(paths);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, deleted: paths.length });
}
