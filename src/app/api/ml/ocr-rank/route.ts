import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export const OcrRankEvent = {
  start: "start",
  log: "log",
  doc: "doc",
  docResult: "doc_result",
  scanProgress: "scan_progress",
  scanAnalytics: "scan_analytics",
  preprocess: "preprocess",
  train: "train",
  rank: "rank",
  done: "done",
  error: "error",
};

interface PipelinePayload {
  mode?: "scan" | "rank" | "full" | "train";
  seed?: number;
  n_trees?: number;
  n_synth?: number;
  max_depth?: number;
  min_samples_leaf?: number;
  train_uploaded?: boolean;
  applicants?: Array<Record<string, unknown>>;
  ocr_results?: Array<Record<string, unknown>>;
}

let cachedPython: { bin: string; args: string[] } | null = null;

function resolvePython(): { bin: string; args: string[] } {
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
      if (probe.status === 0 && probe.stdout) {
        const version = probe.stdout.toString().trim();
        if (version.startsWith("3")) {
          cachedPython = { bin: candidate.bin, args: candidate.args.slice(0, -2) };
          return cachedPython;
        }
      }
    } catch {
      // try the next candidate
    }
  }

  throw new Error(
    "Python 3 was not found. Install Python 3 (or set PYTHON_BIN) so backend/ml/pipeline.py can run.",
  );
}

function ndjson(value: unknown): string {
  return JSON.stringify(value) + "\n";
}

export async function POST(req: Request) {
  let payload: PipelinePayload;
  try {
    payload = (await req.json()) as PipelinePayload;
  } catch {
    return new Response(ndjson({ type: "error", message: "Request body must be JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }

  const body = {
    mode: payload.mode ?? "full",
    seed: payload.seed ?? 2026,
    n_trees: payload.n_trees ?? 100,
    n_synth: payload.n_synth ?? 800,
    max_depth: payload.max_depth ?? 8,
    min_samples_leaf: payload.min_samples_leaf ?? 2,
    train_uploaded: payload.train_uploaded === true,
    applicants: Array.isArray(payload.applicants) ? payload.applicants : [],
    ocr_results: Array.isArray(payload.ocr_results) ? payload.ocr_results : [],
  };

  const ndjsonHeaders = {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  };

  // On Vercel the pipeline runs in the internal `ml` service; ML_URL is the
  // injected service-binding URL. Locally it stays undefined and Python runs here.
  const mlUrl = process.env.ML_URL;
  if (mlUrl) {
    try {
      const upstream = await fetch(new URL("pipeline", mlUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!upstream.ok || !upstream.body) {
        throw new Error(`ml service responded with HTTP ${upstream.status}`);
      }
      return new Response(upstream.body, {
        headers: ndjsonHeaders,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "ml service is unavailable";
      return new Response(
        ndjson({ type: "error", message: `ML service call failed: ${message}` }) +
          ndjson({ type: "done", ok: false, mode: body.mode }),
        { status: 502, headers: ndjsonHeaders },
      );
    }
  }

  let python: { bin: string; args: string[] };
  try {
    python = resolvePython();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Python is not available";
    return new Response(ndjson({ type: "error", message }) + ndjson({ type: "done", ok: false }), {
      status: 500,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }

  const projectRoot = path.resolve(process.cwd(), "..");
  const backendMlDir = path.join(projectRoot, "backend", "ml");
  const child = spawn(python.bin, [...python.args, path.join(backendMlDir, "pipeline.py")], {
    cwd: projectRoot,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const encoder = new TextEncoder();
  let sawDone = false;
  let settled = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (line: string) => {
        if (settled) return;
        try {
          controller.enqueue(encoder.encode(line.endsWith("\n") ? line : line + "\n"));
        } catch {
          settled = true;
        }
      };

      const pumpLines = (
        source: NodeJS.ReadableStream,
        onLine: (line: string) => void,
      ) => {
        let buffer = "";
        source.setEncoding("utf8");
        source.on("data", (chunk: string) => {
          buffer += chunk;
          let index = buffer.indexOf("\n");
          while (index >= 0) {
            const line = buffer.slice(0, index).replace(/\r$/, "");
            buffer = buffer.slice(index + 1);
            if (line.trim()) onLine(line.trim());
            index = buffer.indexOf("\n");
          }
        });
        source.on("end", () => {
          const rest = buffer.replace(/\r$/, "").trim();
          if (rest) onLine(rest);
        });
      };

      pumpLines(child.stdout, (line) => {
        if (!line.startsWith("{")) return;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.type === "done") sawDone = true;
          write(line);
        } catch {
          write(ndjson({ type: "log", msg: line }));
        }
      });

      pumpLines(child.stderr, (line) => {
        write(ndjson({ type: "log", msg: `[python] ${line}`, stream: "stderr" }));
      });

      child.on("error", (err) => {
        write(ndjson({ type: "error", message: `Failed to start Python: ${err.message}` }));
      });

      child.on("close", (code, signal) => {
        if (!sawDone) {
          if (code === 0) {
            write(ndjson({ type: "done", ok: true, mode: body.mode }));
          } else {
            write(
              ndjson({
                type: "error",
                message:
                  signal === "SIGTERM"
                    ? "The OCR/ML pipeline was terminated (timeout)."
                    : `The OCR/ML pipeline exited with code ${code}.`,
              }),
            );
            write(ndjson({ type: "done", ok: false, mode: body.mode }));
          }
        }
        settled = true;
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      });

      child.stdin.on("error", () => {
        // the child exited before reading its payload
      });
      child.stdin.write(JSON.stringify(body));
      child.stdin.end();
    },
    cancel() {
      settled = true;
      try {
        child.kill();
      } catch {
        // already gone
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
