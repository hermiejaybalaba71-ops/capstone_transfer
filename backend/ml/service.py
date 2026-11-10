"""HTTP entrypoint for the OCR + Random Forest pipeline on Vercel Services.

Runs as an internal FastAPI service (never publicly routed). The Next.js app
calls it over the ML_URL service binding; requests POST the pipeline payload
as JSON and receive the same NDJSON event stream pipeline.py writes to stdout.

    POST /pipeline   {mode, seed, n_trees, n_synth, applicants, ocr_results}
"""

from __future__ import annotations

import asyncio
import collections
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Iterator
from importlib.metadata import PackageNotFoundError, version

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

ML_DIR = Path(__file__).resolve().parent
NDJSON_MEDIA = "application/x-ndjson; charset=utf-8"
NDJSON_HEADERS = {
    "Content-Type": NDJSON_MEDIA,
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
}
_EOF = object()

app = FastAPI(title="scholar-capstone2 ML pipeline", version="1.0.0")
MAX_SHEET_BYTES = 20 * 1024 * 1024
SHEET_EXTENSIONS = {".csv", ".xlsx", ".xlsm", ".xltx"}


def _runtime_python() -> tuple[str, dict[str, str]]:
    """Run the child pipeline with packages installed by Vercel's Python runtime."""
    runtime_env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    # Render's free instance is 0.1 CPU / 512 MB. Letting BLAS/ONNX/OpenCV each
    # spawn a thread pool buys no speed behind that quota but costs thread stacks
    # and allocator arenas - enough to tip a 1-document OCR run into an OOM kill.
    for key, value in (
        ("OMP_NUM_THREADS", "1"),
        ("OPENBLAS_NUM_THREADS", "1"),
        ("MKL_NUM_THREADS", "1"),
        ("NUMEXPR_NUM_THREADS", "1"),
        ("MALLOC_ARENA_MAX", "2"),
    ):
        runtime_env.setdefault(key, value)
    site_packages = [
        path
        for root in (Path("/tmp/_vc_deps/lib"), Path("/var/task/.venv/lib"))
        if root.exists()
        for path in root.glob("python*/site-packages")
        if path.is_dir()
    ]
    if site_packages:
        existing = runtime_env.get("PYTHONPATH", "")
        runtime_env["PYTHONPATH"] = os.pathsep.join(
            [*(str(path) for path in site_packages), existing] if existing else [str(path) for path in site_packages]
        )

    virtualenv_python = Path("/tmp/_vc_deps/bin/python")
    return (str(virtualenv_python) if virtualenv_python.exists() else sys.executable), runtime_env


_OCR_PROBE: dict | None = None
_OCR_PROBE_AT = 0.0
OCR_PROBE_TTL = 300.0


def _probe_ocr_runtime() -> dict:
    """Verify the OCR stack in a throwaway child process.

    Importing cv2 + onnxruntime here would keep ~250 MB resident in the API
    process for the lifetime of the container. Render's free instance has
    512 MB shared by this server *and* the pipeline child it spawns, so the
    parent has to stay small or the OCR run gets the container OOM-killed
    (that is what made /pipeline's stream end before ``done``).
    """
    global _OCR_PROBE, _OCR_PROBE_AT
    now = time.monotonic()
    if _OCR_PROBE is not None and now - _OCR_PROBE_AT < OCR_PROBE_TTL:
        return dict(_OCR_PROBE)

    ocr_runtime: dict[str, str] = {}
    errors: list[str] = []
    for name in ("opencv-python", "onnxruntime", "rapidocr-onnxruntime", "scikit-learn"):
        try:
            ocr_runtime[name.split("-")[0]] = version(name)
        except PackageNotFoundError:
            errors.append(f"{name}: not installed")

    if not errors:
        python_bin, runtime_env = _runtime_python()
        probe = (
            "import json, cv2, onnxruntime, rapidocr_onnxruntime, sklearn;"
            "print(json.dumps({'opencv': cv2.__version__,"
            " 'onnxruntime': onnxruntime.__version__,"
            " 'sklearn': sklearn.__version__}))"
        )
        try:
            result = subprocess.run(
                [python_bin, "-c", probe],
                env=runtime_env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=90,
                check=False,
            )
        except subprocess.TimeoutExpired:
            errors.append("ocr: import probe timed out")
        else:
            if result.returncode != 0:
                detail = (result.stderr or "").strip().splitlines()
                errors.append(f"ocr: {detail[-1] if detail else 'import failed'}")
            else:
                try:
                    ocr_runtime.update(json.loads(result.stdout.strip().splitlines()[-1]))
                except (json.JSONDecodeError, IndexError):
                    errors.append("ocr: import probe returned unreadable output")

    _OCR_PROBE = {"ocr_runtime": ocr_runtime, "ocr_errors": errors}
    _OCR_PROBE_AT = now
    return dict(_OCR_PROBE)


@app.get("/")
def health() -> JSONResponse:
    probe = _probe_ocr_runtime()
    current = peak = None
    try:
        with open("/proc/self/status", "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("VmRSS:"):
                    current = round(int(line.split()[1]) / 1024, 1)
                elif line.startswith("VmHWM:"):
                    peak = round(int(line.split()[1]) / 1024, 1)
    except (OSError, ValueError, IndexError):
        pass
    return JSONResponse(
        {
            "ok": True,
            "service": "ml",
            "python": sys.version.split()[0],
            "ocr_ready": not probe["ocr_errors"],
            "ocr_runtime": probe["ocr_runtime"],
            "ocr_errors": probe["ocr_errors"],
            "rss_mb": current,
            "peak_mb": peak,
        }
    )


@app.get("/health", include_in_schema=False)
def health_alias() -> JSONResponse:
    """/health alias for `/` - local and deployed health checks probe it."""
    return health()


def _parse_sheet(filename: str, contents: bytes) -> dict:
    safe_name = filename.replace("\\", "/").rsplit("/", 1)[-1]
    suffix = Path(safe_name).suffix.lower()
    if suffix not in SHEET_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Unsupported file type. Use .csv or .xlsx.")
    if len(contents) > MAX_SHEET_BYTES:
        raise HTTPException(status_code=413, detail="File must be 20 MB or smaller.")

    python_bin, runtime_env = _runtime_python()
    with tempfile.TemporaryDirectory(prefix="sheet-") as work_dir:
        upload_path = Path(work_dir) / f"upload{suffix}"
        upload_path.write_bytes(contents)
        try:
            result = subprocess.run(
                [python_bin, str(ML_DIR / "read_sheet.py"), str(upload_path)],
                cwd=str(ML_DIR),
                env=runtime_env,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=45,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise HTTPException(status_code=504, detail="Reading this file took too long.") from exc

    if not result.stdout.strip():
        errors = result.stderr.strip().splitlines()
        raise HTTPException(
            status_code=500,
            detail=errors[-1] if errors else "The sheet reader returned no output.",
        )
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="The sheet reader returned invalid JSON.") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=500, detail="The sheet reader returned an invalid response.")
    if result.returncode != 0 or payload.get("ok") is not True:
        raise HTTPException(status_code=400, detail=str(payload.get("error") or "Could not read this file."))
    return payload


@app.post("/parse-sheet")
async def parse_sheet(request: Request) -> JSONResponse:
    filename = request.headers.get("x-file-name", "")
    if not filename:
        raise HTTPException(status_code=400, detail="Missing x-file-name header.")
    contents = await request.body()
    return JSONResponse(await asyncio.to_thread(_parse_sheet, filename, contents))


@app.get("/training-rows")
def training_rows() -> JSONResponse:
    """Row report for the uploaded training file - counts only, no row values.

    Lets the "Machine learning train data" panel say how many rows the file
    has (and whether TOINC / NPCINC are on every one of them) without the
    panel ever seeing a single household record.
    """
    python_bin, runtime_env = _runtime_python()
    try:
        result = subprocess.run(
            [python_bin, str(ML_DIR / "rows_report.py")],
            cwd=str(ML_DIR),
            env=runtime_env,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=180,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Reading the training file took too long.") from exc

    line = next(
        (raw for raw in reversed((result.stdout or "").splitlines()) if raw.strip().startswith("{")),
        "",
    )
    if not line:
        errors = (result.stderr or "").strip().splitlines()
        raise HTTPException(
            status_code=500,
            detail=errors[-1] if errors else "The row report returned no output.",
        )
    try:
        payload = json.loads(line)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="The row report returned invalid JSON.") from exc
    return JSONResponse(payload)


@app.post("/pipeline")
def pipeline(payload: dict) -> StreamingResponse:
    return StreamingResponse(_stream_pipeline(payload), media_type=NDJSON_MEDIA, headers=NDJSON_HEADERS)


def _stream_pipeline(payload: dict) -> Iterator[str]:
    python_bin, runtime_env = _runtime_python()
    proc = subprocess.Popen(
        [python_bin, str(ML_DIR / "pipeline.py")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(ML_DIR),
        env=runtime_env,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    events: "queue.Queue" = queue.Queue(maxsize=1024)
    stderr_tail: "collections.deque[str]" = collections.deque(maxlen=30)

    def pump(stream, wrap=None, capture_tail=None) -> None:
        try:
            for line in stream:
                line = line.rstrip("\n")
                if not line.strip():
                    continue
                if capture_tail is not None:
                    capture_tail.append(line)
                events.put(wrap(line) if wrap else json.dumps({"type": "log", "msg": line}) + "\n"
                           if not line.startswith("{") else line + "\n")
        except (ValueError, OSError):
            pass
        finally:
            events.put(_EOF)

    threading.Thread(target=pump, args=(proc.stdout,), daemon=True).start()
    threading.Thread(
        target=pump,
        args=(proc.stderr, lambda line: json.dumps({"type": "log", "msg": f"[python] {line}", "stream": "stderr"}) + "\n",
              stderr_tail),
        daemon=True,
    ).start()

    try:
        assert proc.stdin is not None
        proc.stdin.write(json.dumps(payload))
        proc.stdin.close()
    except (BrokenPipeError, ValueError, OSError):
        pass

    eof_count = 0
    saw_done = False
    while eof_count < 2:
        item = events.get()
        if item is _EOF:
            eof_count += 1
        else:
            if '"type": "done"' in item:
                saw_done = True
            yield item

    try:
        returncode = proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        proc.kill()
        returncode = proc.wait(timeout=5)

    # A child that dies silently (segfault, SIGKILL, unhandled native error)
    # used to end the NDJSON stream with no `done` at all, and the UI could
    # only say "the pipeline closed before it finished". Surface the real cause.
    if returncode != 0 and not saw_done:
        tail = " | ".join(line for line in list(stderr_tail)[-6:] if line.strip())
        error_event = {
            "type": "error",
            "message": (
                f"The pipeline process exited with code {returncode} before emitting done."
            ),
            "returncode": returncode,
            "stderr_tail": tail,
        }
        yield json.dumps(error_event) + "\n"
        yield json.dumps({"type": "done", "ok": False, "crashed": True, "returncode": returncode}) + "\n"
