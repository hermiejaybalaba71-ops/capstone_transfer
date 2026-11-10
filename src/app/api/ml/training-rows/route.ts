import { NextResponse } from "next/server";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 180;

/**
 * Row count for the uploaded "Machine learning train data" file.
 *
 * The panel needs to tell the admin how many rows their upload has (and
 * whether TOINC + NPCINC are present on all of them) BEFORE spending minutes
 * on training. The report is produced by backend/ml/rows_report.py and is
 * strictly aggregate - row counts, column names and per-column population
 * counts. No row values are ever returned, so no household record leaks.
 *
 * Reaches the ML service (ML_URL) when one is configured - the same service
 * Execute Training Data streams from - and otherwise runs Python locally.
 */

async function assertAdminLocal(req: Request): Promise<string | true> {
  const { createClient } = await import("@supabase/supabase-js");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const match = url.match(/https?:\/\/([^./]+)/);
  const cookieName = `sb-${match ? match[1] : "xflsxzmniseetvkrddmj"}-auth-token`;

  const header = req.headers.get("authorization");
  let token = header?.toLowerCase().startsWith("bearer ") ? header.slice(7) : null;
  if (!token) {
    const cookie = req.headers.get("cookie");
    if (cookie) {
      for (const part of cookie.split(";")) {
        const [k, ...rest] = part.trim().split("=");
        if (k === cookieName) {
          try {
            const parsed = JSON.parse(decodeURIComponent(rest.join("=")));
            if (parsed?.access_token) token = parsed.access_token;
          } catch {
            token = rest.join("=");
          }
        }
      }
    }
  }
  if (!token) return "Not authenticated.";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const sb = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.getUser();
  if (error || !data.user) return "Session expired. Please log in again.";
  const { data: row } = await sb.from("users").select("role").eq("auth_user_id", data.user.id).maybeSingle();
  if (!row || row.role !== "Admin") return "Only admins can inspect training data.";
  return true;
}

function projectRoot(): string {
  // The ML directory must be reachable either from the repo root or from a
  // parent, so this works whichever directory Next was started in.
  let dir = process.cwd();
  for (let i = 0; i < 4; i += 1) {
    if (existsSync(path.join(dir, "backend", "ml", "rows_report.py"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(process.cwd(), "..");
}

function resolvePython(root: string): { bin: string; args: string[] } | null {
  const candidates: Array<{ bin: string; args: string[] }> = [];
  if (process.env.PYTHON_BIN) {
    candidates.push({ bin: process.env.PYTHON_BIN, args: ["-c", "import sys; print(sys.version)"] });
  }
  candidates.push({
    bin: path.join(root, ".venv", "Scripts", "python.exe"),
    args: ["-c", "import sys; print(sys.version)"],
  });
  candidates.push({ bin: path.join(root, ".venv", "bin", "python"), args: ["-c", "import sys; print(sys.version)"] });
  candidates.push({ bin: "python", args: ["-c", "import sys; print(sys.version)"] });
  candidates.push({ bin: "py", args: ["-3", "-c", "import sys; print(sys.version)"] });

  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate.bin, candidate.args, {
        windowsHide: true,
        timeout: 15000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (probe.status === 0 && probe.stdout?.toString().trim().startsWith("3")) {
        return { bin: candidate.bin, args: candidate.args.slice(0, -2) };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function runLocally(): Promise<Response> {
  const root = projectRoot();
  const python = resolvePython(root);
  if (!python) {
    return Promise.resolve(
      NextResponse.json(
        { available: false, error: "Python 3 was not found, so the row count cannot be read." },
        { status: 503 },
      ),
    );
  }

  return new Promise((resolve) => {
    const child = spawn(python.bin, [...python.args, path.join(root, "backend", "ml", "rows_report.py")], {
      cwd: path.join(root, "backend", "ml"),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (response: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(response as Response);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(
        NextResponse.json(
          { available: false, error: "Reading the training file took too long (over 180s)." },
          { status: 504 },
        ),
      );
    }, 180_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      finish(NextResponse.json({ available: false, error: err.message }, { status: 500 }));
    });
    child.on("close", () => {
      const line = stdout
        .split(/\r?\n/)
        .map((raw) => raw.trim())
        .filter((raw) => raw.startsWith("{"))
        .pop();
      if (line) {
        try {
          finish(NextResponse.json(JSON.parse(line)));
          return;
        } catch {
          /* fall through to the error below */
        }
      }
      const detail = stderr.trim().split(/\r?\n/).pop() || "The row report returned no output.";
      finish(NextResponse.json({ available: false, error: detail }, { status: 500 }));
    });
  });
}

export async function GET(req: Request) {
  const auth = await assertAdminLocal(req);
  if (auth !== true) return NextResponse.json({ error: auth }, { status: 401 });

  const mlUrl = process.env.ML_URL;
  if (mlUrl) {
    try {
      const upstream = await fetch(new URL("training-rows", mlUrl), {
        method: "GET",
        signal: AbortSignal.timeout(180_000),
      });
      const payload = await upstream.json().catch(() => null);
      if (upstream.ok && payload && typeof payload === "object") {
        return NextResponse.json(payload);
      }
      const detail =
        payload && typeof payload === "object" && "detail" in payload
          ? String((payload as { detail: unknown }).detail)
          : `ML service responded with HTTP ${upstream.status}`;
      // Fall through to a local read - the panel should still get a row count.
      if (!process.env.FORCE_ML_SERVICE) {
        const local = await runLocally();
        if (local.ok) return local;
      }
      return NextResponse.json({ available: false, error: detail }, { status: 502 });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "ML service is unavailable";
      if (!process.env.FORCE_ML_SERVICE) {
        const local = await runLocally();
        if (local.ok) return local;
      }
      return NextResponse.json({ available: false, error: message }, { status: 502 });
    }
  }

  return runLocally();
}
