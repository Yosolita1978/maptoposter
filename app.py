"""
Web API for maptoposter.

This is a thin wrapper around the existing command-line generator in
create_map_poster.py. It does NOT reimplement any poster logic — it imports
that module and calls its functions directly.

Design notes (kept deliberately simple for a first version):

  * A single background worker thread pulls jobs from a queue and generates
    one poster at a time. Doing one at a time is intentional: matplotlib is
    not thread-safe, and the OpenStreetMap services we call (Nominatim,
    Overpass) must be used politely / rate-limited. Serializing the work
    keeps both happy on a small server.

  * Jobs are tracked in an in-memory dictionary. This is the simplest thing
    that works. Tradeoff: if the server restarts, in-progress/finished jobs
    are forgotten, and it assumes a single server process. Good enough for a
    public hobby tool; swap in Redis + a real queue later if it grows.

Endpoints:
  GET  /health              -> simple liveness check
  GET  /themes              -> list of available theme names
  POST /generate            -> start a job, returns {"job_id": ...}
  GET  /status/{job_id}     -> {"status": "queued|running|done|error", ...}
  GET  /result/{job_id}     -> the finished image (png/svg/pdf)
"""

import os
import queue
import threading
import uuid
from contextlib import asynccontextmanager
from typing import Optional

# Force a headless matplotlib backend BEFORE importing the generator, because
# create_map_poster.py imports matplotlib.pyplot at module load time and a
# server has no display.
os.environ.setdefault("MPLBACKEND", "Agg")
import matplotlib  # noqa: E402

matplotlib.use("Agg")

import create_map_poster as cmp  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402


# ---------------------------------------------------------------------------
# Configuration and shared state
# ---------------------------------------------------------------------------

# Themes are read once at startup from the themes/ directory.
AVAILABLE_THEMES: list[str] = cmp.get_available_themes()
ALLOWED_FORMATS = {"png", "svg", "pdf"}

# Media type to return for each output format.
MEDIA_TYPES = {
    "png": "image/png",
    "svg": "image/svg+xml",
    "pdf": "application/pdf",
}

# Reject new work if too many jobs are already waiting, so the public
# endpoint cannot be flooded into an ever-growing backlog.
MAX_PENDING_JOBS = 20

# In-memory job store. Access is guarded by JOBS_LOCK because the web thread
# and the worker thread both touch it.
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()

# Monotonically increasing number stamped on each job as it arrives, so we can
# tell which queued job came first and report a "you are #N in line" position.
JOB_SEQ = 0

# Work queue and the single worker thread that drains it.
WORK_QUEUE: "queue.Queue[str]" = queue.Queue()
_worker_stop = threading.Event()


# ---------------------------------------------------------------------------
# Request model
# ---------------------------------------------------------------------------

class GenerateRequest(BaseModel):
    """Inputs for one poster. Mirrors the most-used CLI arguments."""

    city: str = Field(..., min_length=1, max_length=100)
    country: str = Field(..., min_length=1, max_length=100)
    theme: str = "terracotta"
    output_format: str = Field("png")
    distance: int = Field(18000, ge=1000, le=30000)
    width: float = Field(12, gt=0, le=20)
    height: float = Field(16, gt=0, le=20)


# ---------------------------------------------------------------------------
# The worker: turns queued jobs into image files
# ---------------------------------------------------------------------------

def _process_job(job_id: str) -> None:
    """Generate one poster. Runs on the worker thread, never the web thread."""
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            return
        job["status"] = "running"
        city = job["city"]
        country = job["country"]
        theme = job["theme"]
        output_format = job["output_format"]
        distance = job["distance"]
        width = job["width"]
        height = job["height"]

    try:
        # Set the module-level THEME global the generator reads, then reuse
        # the exact same functions the CLI uses.
        cmp.THEME = cmp.load_theme(theme)
        coords = cmp.get_coordinates(city, country)
        output_file = cmp.generate_output_filename(city, theme, output_format)
        cmp.create_poster(
            city,
            country,
            coords,
            distance,
            output_file,
            output_format,
            width,
            height,
        )
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "done"
            JOBS[job_id]["file"] = output_file
    except Exception as exc:  # noqa: BLE001 - surface any failure to the client
        with JOBS_LOCK:
            JOBS[job_id]["status"] = "error"
            JOBS[job_id]["error"] = str(exc)


def _worker_loop() -> None:
    """Continuously pull job ids off the queue until asked to stop."""
    while not _worker_stop.is_set():
        try:
            job_id = WORK_QUEUE.get(timeout=0.5)
        except queue.Empty:
            continue
        try:
            _process_job(job_id)
        finally:
            WORK_QUEUE.task_done()


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the worker thread on startup, stop it on shutdown."""
    worker = threading.Thread(target=_worker_loop, name="poster-worker", daemon=True)
    worker.start()
    try:
        yield
    finally:
        _worker_stop.set()
        worker.join(timeout=2)


app = FastAPI(title="maptoposter API", version="1.0.0", lifespan=lifespan)

# Allow browser calls from anywhere for now. Step 3 will lock this down to
# your Vercel domain.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.get("/themes")
def themes() -> dict:
    return {"themes": AVAILABLE_THEMES}


@app.post("/generate")
def generate(req: GenerateRequest) -> dict:
    output_format = req.output_format.lower()
    if output_format not in ALLOWED_FORMATS:
        raise HTTPException(
            status_code=422,
            detail=f"format must be one of {sorted(ALLOWED_FORMATS)}",
        )
    if req.theme not in AVAILABLE_THEMES:
        raise HTTPException(
            status_code=422,
            detail=f"unknown theme '{req.theme}'. See GET /themes.",
        )
    if WORK_QUEUE.qsize() >= MAX_PENDING_JOBS:
        raise HTTPException(
            status_code=429,
            detail="Server is busy. Please try again in a minute.",
        )

    job_id = uuid.uuid4().hex
    global JOB_SEQ
    with JOBS_LOCK:
        JOB_SEQ += 1
        JOBS[job_id] = {
            "status": "queued",
            "seq": JOB_SEQ,
            "city": req.city,
            "country": req.country,
            "theme": req.theme,
            "output_format": output_format,
            "distance": req.distance,
            "width": req.width,
            "height": req.height,
            "file": None,
            "error": None,
        }
    WORK_QUEUE.put(job_id)
    return {"job_id": job_id, "status": "queued"}


@app.get("/status/{job_id}")
def status(job_id: str) -> dict:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown job_id")

        # queue_position = how many jobs must finish before this one starts.
        # 0 means it is being generated now (or already finished/failed).
        # Counts the job currently running plus any earlier-queued jobs.
        position = 0
        if job["status"] == "queued":
            my_seq = job["seq"]
            for other in JOBS.values():
                if other["status"] == "running":
                    position += 1
                elif other["status"] == "queued" and other["seq"] < my_seq:
                    position += 1

        return {
            "job_id": job_id,
            "status": job["status"],
            "error": job["error"],
            "queue_position": position,
        }


@app.get("/result/{job_id}")
def result(job_id: str) -> FileResponse:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="unknown job_id")
        job_status = job["status"]
        output_file = job["file"]
        output_format = job["output_format"]

    if job_status != "done" or not output_file:
        raise HTTPException(
            status_code=409,
            detail=f"result not ready (status: {job_status})",
        )
    if not os.path.exists(output_file):
        raise HTTPException(status_code=410, detail="result file no longer exists")

    return FileResponse(
        output_file,
        media_type=MEDIA_TYPES[output_format],
        filename=os.path.basename(output_file),
    )
