import os
import sys
import re
import json
import glob
import time
import shutil
import asyncio
import zipfile
import logging
import subprocess
from pathlib import Path
from typing import List, Optional, Dict, Any
from concurrent.futures import ThreadPoolExecutor

import yt_dlp
from fastapi import FastAPI, HTTPException, Request, BackgroundTasks
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

# Ensure UTF-8 output on Windows consoles
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("MusicPlaylistDownloader")

# Base directory
BASE_DIR = Path(__file__).resolve().parent
DOWNLOADS_DIR = BASE_DIR / "downloads"
DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------
# Windows & Environment Discovery (FFmpeg & Deno)
# ---------------------------------------------------------
def discover_and_inject_binaries():
    """
    Check if ffmpeg/deno are on PATH.
    If missing, scan WinGet Packages in %LOCALAPPDATA% to auto-inject without requiring terminal restart.
    """
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    if local_app_data:
        winget_pkg_dir = os.path.join(local_app_data, "Microsoft", "WinGet", "Packages")
        if os.path.exists(winget_pkg_dir):
            for binary_name in ["ffmpeg.exe", "deno.exe"]:
                cmd_name = binary_name.replace(".exe", "")
                if not shutil.which(cmd_name):
                    try:
                        matches = glob.glob(os.path.join(winget_pkg_dir, "**", binary_name), recursive=True)
                        if matches:
                            bin_dir = os.path.dirname(matches[0])
                            logger.info(f"Auto-discovered {binary_name} at {bin_dir}; adding to PATH.")
                            os.environ["PATH"] = bin_dir + os.pathsep + os.environ["PATH"]
                    except Exception as e:
                        logger.warning(f"Error scanning winget packages for {binary_name}: {e}")

discover_and_inject_binaries()

def check_system_tools() -> Dict[str, Any]:
    ffmpeg_path = shutil.which("ffmpeg")
    deno_path = shutil.which("deno")
    return {
        "ffmpeg_installed": bool(ffmpeg_path),
        "ffmpeg_path": ffmpeg_path,
        "deno_installed": bool(deno_path),
        "deno_path": deno_path,
        "ytdlp_version": yt_dlp.version.__version__,
        "winget_ffmpeg_cmd": "winget install Gyan.FFmpeg",
        "winget_deno_cmd": "winget install DenoLand.Deno",
    }


# ---------------------------------------------------------
# FastAPI App
# ---------------------------------------------------------
app = FastAPI(title="Music Playlist Downloader")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------------------------------------------------
# Models
# ---------------------------------------------------------
class PreviewRequest(BaseModel):
    url: str
    cookies_browser: Optional[str] = None

class TrackItem(BaseModel):
    id: str
    index: int
    title: str
    artist: Optional[str] = "Unknown"
    duration: Optional[int] = 0
    duration_formatted: Optional[str] = "0:00"
    thumbnail: Optional[str] = None
    available: Optional[bool] = True
    unavailable_reason: Optional[str] = None

class DownloadOptions(BaseModel):
    type: str = "audio"  # "audio" | "video"
    audio_format: str = "best"  # "best", "mp3", "m4a", "opus", "flac", "wav", "ogg"
    audio_quality: str = "best"  # "best", "320", "256", "192", "128"
    video_format: str = "mp4"  # "mp4", "webm", "mkv"
    video_quality: str = "best"  # "best", "2160", "1440", "1080", "720", "480", "360"
    embed_metadata: bool = True
    embed_cover_art: bool = True
    save_thumbnails: bool = False
    embed_subtitles: bool = False
    prefix_index: bool = True
    skip_existing: bool = True
    filename_template: str = "%(playlist_index)02d - %(title)s.%(ext)s"
    concurrency: int = Field(default=3, ge=1, le=5)
    retries: int = Field(default=3, ge=1, le=10)
    rate_limit: Optional[str] = None
    browser_cookies: Optional[str] = None

class StartDownloadRequest(BaseModel):
    playlist_title: str
    items: List[TrackItem]
    options: DownloadOptions

class OpenFolderRequest(BaseModel):
    folder_path: str


# ---------------------------------------------------------
# Helper Functions
# ---------------------------------------------------------
def sanitize_filename(name: str) -> str:
    """Sanitize string for Windows filesystem safety."""
    if not name:
        return "untitled"
    # Replace illegal Windows characters: < > : " / \ | ? *
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", name)
    cleaned = re.sub(r'[\s_]+', ' ', cleaned).strip()
    return cleaned[:120] if cleaned else "playlist"

def format_seconds(seconds: Optional[int]) -> str:
    if not seconds or seconds < 0:
        return "0:00"
    m, s = divmod(int(seconds), 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"

def clean_youtube_url(url: str) -> str:
    """Strip tracking query parameters like si=, pp=, feature="""
    url = url.strip()
    url = re.sub(r'[\?&]si=[^&]*', '', url)
    url = re.sub(r'[\?&]feature=[^&]*', '', url)
    url = re.sub(r'[\?&]pp=[^&]*', '', url)
    # Fix ? or & if dangling
    if "?" not in url and "&" in url:
        url = url.replace("&", "?", 1)
    return url

def detect_platform(url: str) -> str:
    lower = url.lower()
    if "music.youtube.com" in lower:
        return "YouTube Music"
    elif "youtube.com" in lower or "youtu.be" in lower:
        return "YouTube"
    return "YouTube"


# ---------------------------------------------------------
# Download Job Manager
# ---------------------------------------------------------
class DownloadCancelledException(Exception):
    pass

class DownloadJob:
    def __init__(self, job_id: str, playlist_title: str, items: List[TrackItem], options: DownloadOptions, loop: asyncio.AbstractEventLoop):
        self.job_id = job_id
        self.playlist_title = playlist_title
        self.clean_title = sanitize_filename(playlist_title)
        self.items = items
        self.options = options
        self.loop = loop
        self.cancelled = False
        self.status = "running"
        self.download_dir = DOWNLOADS_DIR / self.clean_title
        self.download_dir.mkdir(parents=True, exist_ok=True)
        self.zip_path: Optional[Path] = None
        self.zip_size_bytes = 0
        
        # Track statuses: key is item.id
        self.track_status = {}
        for item in items:
            self.track_status[item.id] = {
                "id": item.id,
                "index": item.index,
                "title": item.title,
                "artist": item.artist,
                "status": "queued",  # queued, downloading, converting, done, skipped, failed
                "percent": 0.0,
                "speed": "",
                "eta": "",
                "error": None,
                "file_path": None
            }
            
        self.completed_count = 0
        self.failed_count = 0
        self.total_count = len(items)
        self.listeners: List[asyncio.Queue] = []
        self._executor = ThreadPoolExecutor(max_workers=options.concurrency)

    def add_listener(self, queue: asyncio.Queue):
        self.listeners.append(queue)

    def remove_listener(self, queue: asyncio.Queue):
        if queue in self.listeners:
            self.listeners.remove(queue)

    def broadcast(self, data: dict):
        """Threadsafe broadcast to all active SSE queues."""
        if not self.loop or self.loop.is_closed():
            return
        for q in list(self.listeners):
            self.loop.call_soon_threadsafe(q.put_nowait, data)

    def update_track(self, item_id: str, **kwargs):
        if item_id in self.track_status:
            self.track_status[item_id].update(kwargs)
            self.broadcast({
                "type": "track_update",
                "track": self.track_status[item_id]
            })

    def update_overall(self):
        percent = round(((self.completed_count + self.failed_count) / self.total_count) * 100, 1) if self.total_count > 0 else 100
        self.broadcast({
            "type": "overall_update",
            "completed_count": self.completed_count,
            "failed_count": self.failed_count,
            "total_count": self.total_count,
            "percent": percent,
            "status": self.status
        })

    def cancel(self):
        self.cancelled = True
        self.status = "cancelled"
        logger.info(f"Job {self.job_id} marked as cancelled.")
        self.broadcast({
            "type": "cancelled",
            "message": "Download cancelled by user."
        })
        self.cleanup_temp_files()

    def cleanup_temp_files(self):
        """Remove partial download files (.part, .ytdl, etc.)"""
        try:
            for ext in ["*.part", "*.ytdl", "*.temp"]:
                for temp_file in self.download_dir.glob(ext):
                    try:
                        temp_file.unlink(missing_ok=True)
                    except Exception as e:
                        logger.warning(f"Could not remove temp file {temp_file}: {e}")
        except Exception as e:
            logger.warning(f"Error cleaning up temp files in {self.download_dir}: {e}")

    def safe_zip(self) -> Path:
        """Create ZIP stored archive without re-compressing already compressed media."""
        zip_filename = f"{self.clean_title}.zip"
        target_zip = DOWNLOADS_DIR / zip_filename
        
        # Retry logic for Windows file lock (WinError 32)
        for attempt in range(5):
            try:
                with zipfile.ZipFile(target_zip, "w", compression=zipfile.ZIP_STORED) as zf:
                    for file_path in self.download_dir.iterdir():
                        if file_path.is_file() and not file_path.name.endswith((".part", ".ytdl", ".temp", ".zip")):
                            zf.write(file_path, arcname=file_path.name)
                break
            except (PermissionError, OSError) as e:
                logger.warning(f"Windows file lock encountered creating ZIP (attempt {attempt+1}/5): {e}")
                time.sleep(0.5)

        self.zip_path = target_zip
        if target_zip.exists():
            self.zip_size_bytes = target_zip.stat().st_size
        return target_zip


# Active jobs storage
jobs: Dict[str, DownloadJob] = {}


def run_single_download(job: DownloadJob, item: TrackItem):
    """Worker function executed in thread pool for one track."""
    if job.cancelled:
        job.update_track(item.id, status="failed", error="Download cancelled.")
        return

    job.update_track(item.id, status="downloading", percent=0.0, speed="", eta="")
    
    # Build yt-dlp options
    opts = job.options
    video_url = f"https://www.youtube.com/watch?v={item.id}"
    
    # Progress hook callback
    def progress_hook(d):
        if job.cancelled:
            raise DownloadCancelledException("Download cancelled by user.")
        
        status = d.get("status")
        if status == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
            downloaded = d.get("downloaded_bytes") or 0
            pct = 0.0
            if total > 0:
                pct = round((downloaded / total) * 100, 1)
            else:
                pct_str = d.get("_percent_str", "").replace("%", "").strip()
                try:
                    pct = float(pct_str)
                except Exception:
                    pct = 50.0

            speed = d.get("_speed_str", "").strip()
            eta = d.get("_eta_str", "").strip()
            job.update_track(item.id, status="downloading", percent=pct, speed=speed, eta=eta)

        elif status == "finished":
            job.update_track(item.id, status="converting", percent=100.0, speed="", eta="processing")

    def postprocessor_hook(d):
        if job.cancelled:
            raise DownloadCancelledException("Download cancelled by user.")
        pp_status = d.get("status")
        if pp_status == "started":
            job.update_track(item.id, status="converting", speed="", eta="converting")
        elif pp_status == "finished":
            job.update_track(item.id, status="converting", speed="", eta="finalizing")

    # Determine outtmpl and eliminate NA by resolving playlist_index explicitly
    template = opts.filename_template.strip()
    if not template:
        template = "%(playlist_index)02d - %(title)s.%(ext)s" if opts.prefix_index else "%(title)s.%(ext)s"

    idx_str = f"{item.index:02d}"
    if opts.prefix_index:
        if "%(playlist_index)" in template:
            template = re.sub(r'%\(playlist_index\)(?:0?\d*d|s)?', idx_str, template)
        else:
            template = f"{idx_str} - {template}"
    else:
        template = re.sub(r'%\(playlist_index\)(?:0?\d*d|s)?\s*[-_]?\s*', '', template)

    outtmpl = str(job.download_dir / template)

    # Detect ffmpeg directory
    ffmpeg_exe = shutil.which("ffmpeg")
    ffmpeg_dir = os.path.dirname(ffmpeg_exe) if ffmpeg_exe else None

    ydl_opts: Dict[str, Any] = {
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": True,
        "windowsfilenames": True,
        "restrictfilenames": False,
        "progress_hooks": [progress_hook],
        "postprocessor_hooks": [postprocessor_hook],
        "retries": opts.retries,
        "fragment_retries": opts.retries,
    }

    if ffmpeg_dir:
        ydl_opts["ffmpeg_location"] = ffmpeg_dir

    # Browser cookies
    if opts.browser_cookies and opts.browser_cookies.lower() in ["chrome", "edge", "firefox"]:
        ydl_opts["cookiesfrombrowser"] = (opts.browser_cookies.lower(), None, None, None)

    # Rate limit
    if opts.rate_limit and opts.rate_limit.strip():
        # E.g. "5M" -> yt-dlp accepts integer bytes/sec or string with k/m suffix
        ydl_opts["ratelimit"] = opts.rate_limit.strip()

    # Skip existing
    if opts.skip_existing:
        ydl_opts["nooverwrites"] = True

    postprocessors = []

    if opts.type == "audio":
        if opts.audio_format == "best":
            # No re-encoding
            ydl_opts["format"] = "bestaudio/best"
        else:
            ydl_opts["format"] = "bestaudio/best"
            pp_audio = {
                "key": "FFmpegExtractAudio",
                "preferredcodec": opts.audio_format,
            }
            if opts.audio_quality != "best":
                pp_audio["preferredquality"] = opts.audio_quality
            postprocessors.append(pp_audio)

        if opts.embed_metadata:
            postprocessors.append({"key": "FFmpegMetadata", "add_metadata": True})

        if opts.embed_cover_art and opts.audio_format in ["mp3", "m4a", "flac", "opus", "ogg"]:
            ydl_opts["writethumbnail"] = True
            postprocessors.append({"key": "EmbedThumbnail", "already_have_thumbnail": False})
        elif opts.embed_cover_art or opts.save_thumbnails:
            # Save thumbnail alongside for formats where container does not support embedded tags
            ydl_opts["writethumbnail"] = True

    else:
        # Video
        if opts.video_quality == "best":
            ydl_opts["format"] = "bestvideo+bestaudio/best"
        else:
            ydl_opts["format"] = f"bestvideo[height<={opts.video_quality}]+bestaudio/best[height<={opts.video_quality}]/best"

        ydl_opts["merge_output_format"] = opts.video_format

        if opts.embed_metadata:
            postprocessors.append({"key": "FFmpegMetadata", "add_metadata": True})

        if opts.embed_subtitles:
            ydl_opts["writesubtitles"] = True
            ydl_opts["subtitleslangs"] = ["en", "all", "-live_chat"]
            postprocessors.append({"key": "FFmpegEmbedSubtitle"})

        if opts.save_thumbnails:
            ydl_opts["writethumbnail"] = True

    if postprocessors:
        ydl_opts["postprocessors"] = postprocessors

    # Inject playlist_index into yt-dlp metadata
    ydl_opts["postprocessor_args"] = []

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            # Pass playlist_index in extra_info so outtmpl resolves %(playlist_index)
            info = ydl.extract_info(video_url, download=True, extra_info={"playlist_index": item.index})
            job.update_track(item.id, status="done", percent=100.0, speed="", eta="")
            job.completed_count += 1
            job.update_overall()

    except DownloadCancelledException:
        logger.info(f"Track {item.id} cancelled.")
        job.update_track(item.id, status="failed", error="Cancelled by user.")
        job.failed_count += 1
        job.update_overall()

    except Exception as e:
        err_msg = str(e)
        logger.warning(f"Error downloading track {item.id} ({item.title}): {err_msg}")
        # Clean user-facing error message
        if "Video unavailable" in err_msg:
            clean_err = "Video unavailable or deleted"
        elif "Private video" in err_msg:
            clean_err = "Private video (needs login cookies)"
        elif "Sign in to confirm your age" in err_msg:
            clean_err = "Age-restricted (select browser cookies)"
        elif "WinError 32" in err_msg:
            clean_err = "Windows file lock error - retrying"
        else:
            clean_err = err_msg.split("\n")[0][:100]

        job.update_track(item.id, status="failed", error=clean_err)
        job.failed_count += 1
        job.update_overall()


def run_job_thread(job: DownloadJob):
    """Master worker running in background for the entire job."""
    logger.info(f"Starting job {job.job_id} for playlist '{job.playlist_title}' with {job.total_count} tracks.")
    futures = []
    for item in job.items:
        if job.cancelled:
            break
        futures.append(job._executor.submit(run_single_download, job, item))

    # Wait for all submitted tasks
    for f in futures:
        try:
            f.result()
        except Exception as e:
            logger.error(f"Task error: {e}")

    job._executor.shutdown(wait=True)

    if job.cancelled:
        job.status = "cancelled"
        job.cleanup_temp_files()
        job.broadcast({"type": "cancelled", "message": "Download cancelled."})
        return

    # Create ZIP archive
    job.status = "zipping"
    job.broadcast({
        "type": "overall_update",
        "completed_count": job.completed_count,
        "failed_count": job.failed_count,
        "total_count": job.total_count,
        "percent": 100.0,
        "status": "zipping"
    })

    try:
        zip_path = job.safe_zip()
        job.status = "completed"
        logger.info(f"Job {job.job_id} completed. ZIP size: {job.zip_size_bytes} bytes.")
        job.broadcast({
            "type": "completed",
            "job_id": job.job_id,
            "total": job.total_count,
            "successful": job.completed_count,
            "failed": job.failed_count,
            "zip_filename": zip_path.name,
            "zip_size_bytes": job.zip_size_bytes,
            "download_dir": str(job.download_dir.resolve())
        })
    except Exception as e:
        logger.error(f"Error packing ZIP for job {job.job_id}: {e}")
        job.status = "completed"
        job.broadcast({
            "type": "completed",
            "job_id": job.job_id,
            "total": job.total_count,
            "successful": job.completed_count,
            "failed": job.failed_count,
            "zip_filename": None,
            "zip_size_bytes": 0,
            "error": f"Failed to create ZIP: {e}",
            "download_dir": str(job.download_dir.resolve())
        })


# ---------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------
@app.get("/", response_class=HTMLResponse)
async def serve_index():
    index_file = STATIC_DIR / "index.html"
    if not index_file.exists():
        return HTMLResponse("<h1>Music Playlist Downloader</h1><p>Frontend static files not found.</p>")
    with open(index_file, "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())


@app.get("/api/system-status")
async def get_system_status():
    discover_and_inject_binaries()
    return check_system_tools()


@app.post("/api/update-ytdlp")
async def update_ytdlp():
    try:
        old_ver = yt_dlp.version.__version__
        proc = subprocess.run(
            [sys.executable, "-m", "pip", "install", "-U", "yt-dlp"],
            capture_output=True,
            text=True,
            timeout=120
        )
        # Check new version via fresh subprocess
        check_proc = subprocess.run(
            [sys.executable, "-c", "import yt_dlp; print(yt_dlp.version.__version__)"],
            capture_output=True,
            text=True,
            timeout=15
        )
        new_ver = check_proc.stdout.strip() or old_ver
        return {
            "success": proc.returncode == 0,
            "old_version": old_ver,
            "new_version": new_ver,
            "output": proc.stdout[-500:] if proc.stdout else proc.stderr[-500:]
        }
    except Exception as e:
        logger.error(f"Failed to update yt-dlp: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/preview")
async def extract_preview(req: PreviewRequest):
    raw_url = req.url.strip()
    if not raw_url:
        raise HTTPException(status_code=400, detail="Please enter a valid link.")

    clean_url = clean_youtube_url(raw_url)
    platform = detect_platform(clean_url)

    ydl_opts = {
        "extract_flat": True,
        "skip_download": True,
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": True,
    }

    if req.cookies_browser and req.cookies_browser.lower() in ["chrome", "edge", "firefox"]:
        ydl_opts["cookiesfrombrowser"] = (req.cookies_browser.lower(), None, None, None)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(clean_url, download=False)
    except Exception as e:
        logger.error(f"Flat extraction failed for {clean_url}: {e}")
        raise HTTPException(status_code=400, detail=f"Failed to load preview: {str(e)}")

    if not info:
        raise HTTPException(status_code=404, detail="No playlist or track information found.")

    is_playlist = info.get("_type") == "playlist" or "entries" in info
    raw_entries = info.get("entries") if is_playlist else [info]

    playlist_title = info.get("title") or "YouTube Playlist"
    uploader = info.get("uploader") or info.get("channel") or info.get("artist") or "YouTube Music"
    
    # Extract best cover art thumbnail
    thumbnails = info.get("thumbnails") or []
    cover_url = None
    if thumbnails:
        # Choose highest width/resolution
        sorted_thumbs = sorted(thumbnails, key=lambda t: (t.get("width") or 0, t.get("height") or 0), reverse=True)
        cover_url = sorted_thumbs[0].get("url")

    items: List[Dict[str, Any]] = []
    total_duration_sec = 0

    idx = 1
    for entry in (raw_entries or []):
        if not entry:
            continue
        item_id = entry.get("id") or entry.get("url")
        if not item_id:
            continue

        title = entry.get("title") or f"Track {idx}"
        artist = entry.get("uploader") or entry.get("channel") or uploader
        duration = entry.get("duration") or 0
        total_duration_sec += duration

        # Thumbnails for track
        entry_thumbs = entry.get("thumbnails") or []
        track_thumb = None
        if entry_thumbs:
            sorted_entry_thumbs = sorted(entry_thumbs, key=lambda t: (t.get("width") or 0), reverse=True)
            track_thumb = sorted_entry_thumbs[0].get("url")
        elif item_id:
            track_thumb = f"https://i.ytimg.com/vi/{item_id}/hqdefault.jpg"

        # Check availability
        availability = entry.get("availability")
        is_available = True
        unavailable_reason = None
        if availability in ["private", "unlisted_or_private", "subscriber_only"]:
            is_available = False
            unavailable_reason = f"Marked as {availability}"
        elif "[Deleted video]" in title or "[Private video]" in title:
            is_available = False
            unavailable_reason = "Deleted or Private"

        items.append({
            "index": idx,
            "id": item_id,
            "title": title,
            "artist": artist,
            "duration": duration,
            "duration_formatted": format_seconds(duration),
            "thumbnail": track_thumb,
            "available": is_available,
            "unavailable_reason": unavailable_reason
        })
        idx += 1

    if not cover_url and items and items[0].get("thumbnail"):
        cover_url = items[0]["thumbnail"]

    return {
        "title": playlist_title,
        "uploader": uploader,
        "platform": platform,
        "total_count": len(items),
        "total_duration_seconds": total_duration_sec,
        "total_duration_formatted": format_seconds(total_duration_sec),
        "thumbnail": cover_url,
        "items": items
    }


@app.post("/api/download/start")
async def start_download(req: StartDownloadRequest, background_tasks: BackgroundTasks):
    if not req.items:
        raise HTTPException(status_code=400, detail="No tracks selected for download.")

    job_id = f"job_{int(time.time())}_{len(req.items)}"
    loop = asyncio.get_running_loop()
    
    job = DownloadJob(
        job_id=job_id,
        playlist_title=req.playlist_title,
        items=req.items,
        options=req.options,
        loop=loop
    )
    jobs[job_id] = job

    # Launch background thread
    background_tasks.add_task(run_job_thread, job)

    return {"job_id": job_id, "total": len(req.items), "playlist_title": job.playlist_title}


@app.get("/api/download/progress/{job_id}")
async def download_progress_stream(job_id: str, request: Request):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")

    job = jobs[job_id]

    async def event_generator():
        queue: asyncio.Queue = asyncio.Queue()
        job.add_listener(queue)
        
        # Send initial snapshot of all tracks and overall progress
        yield f"data: {json.dumps({'type': 'init', 'tracks': job.track_status, 'completed_count': job.completed_count, 'failed_count': job.failed_count, 'total_count': job.total_count, 'status': job.status})}\n\n"

        try:
            while True:
                # Disconnect check
                if await request.is_disconnected():
                    break
                try:
                    data = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {json.dumps(data)}\n\n"
                    if data.get("type") in ["completed", "cancelled"]:
                        break
                except asyncio.TimeoutError:
                    # Keep-alive heartbeat
                    yield ": ping\n\n"
        finally:
            job.remove_listener(queue)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


@app.post("/api/download/cancel/{job_id}")
async def cancel_download(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")
    job = jobs[job_id]
    job.cancel()
    return {"success": True, "message": "Job cancellation initiated."}


@app.post("/api/download/retry-failed/{job_id}")
async def retry_failed_downloads(job_id: str, background_tasks: BackgroundTasks):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")
    
    old_job = jobs[job_id]
    failed_items = [item for item in old_job.items if old_job.track_status.get(item.id, {}).get("status") == "failed"]
    
    if not failed_items:
        return {"success": False, "message": "No failed items to retry."}

    # Reset failed tracks in current job and relaunch thread
    for item in failed_items:
        old_job.update_track(item.id, status="queued", percent=0.0, speed="", eta="", error=None)
    
    old_job.failed_count = max(0, old_job.failed_count - len(failed_items))
    old_job.status = "running"
    old_job.cancelled = False
    old_job._executor = ThreadPoolExecutor(max_workers=old_job.options.concurrency)

    background_tasks.add_task(run_job_thread, old_job)
    return {"success": True, "retry_count": len(failed_items)}


@app.get("/api/download/zip/{job_id}")
async def download_zip(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found.")
    job = jobs[job_id]
    
    if not job.zip_path or not job.zip_path.exists():
        # Try safe_zip again if completed
        job.safe_zip()

    if not job.zip_path or not job.zip_path.exists():
        raise HTTPException(status_code=404, detail="ZIP file not ready or not found.")

    clean_filename = f"{job.clean_title}.zip"
    return FileResponse(
        path=str(job.zip_path),
        filename=clean_filename,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{clean_filename}"'}
    )


@app.post("/api/download/open-folder")
async def open_download_folder(req: OpenFolderRequest):
    target_path = Path(req.folder_path)
    if not target_path.exists():
        # Fallback to DOWNLOADS_DIR
        target_path = DOWNLOADS_DIR

    try:
        if sys.platform == "win32":
            os.startfile(str(target_path.resolve()))
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(target_path.resolve())])
        else:
            subprocess.Popen(["xdg-open", str(target_path.resolve())])
        return {"success": True, "path": str(target_path.resolve())}
    except Exception as e:
        logger.error(f"Failed to open folder {target_path}: {e}")
        return {"success": False, "error": str(e), "path": str(target_path.resolve())}


# ---------------------------------------------------------
# Main Entry Point
# ---------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    print("\n" + "="*60)
    print(" [Music Playlist Downloader] (FastAPI + yt-dlp)")
    print("="*60)
    status = check_system_tools()
    print(f" * yt-dlp: {status['ytdlp_version']}")
    print(f" * ffmpeg: {'Found (' + str(status['ffmpeg_path']) + ')' if status['ffmpeg_installed'] else 'NOT FOUND - run: winget install Gyan.FFmpeg'}")
    print(f" * deno:   {'Found (' + str(status['deno_path']) + ')' if status['deno_installed'] else 'NOT FOUND - run: winget install DenoLand.Deno'}")
    print(f"\n Server running at: http://localhost:8000 (bind 127.0.0.1)")
    print(" Press CTRL+C to quit.\n" + "="*60 + "\n")
    
    uvicorn.run(app, host="127.0.0.1", port=8000)
