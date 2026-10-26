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
import threading
import queue
from pathlib import Path
from typing import List, Optional, Dict, Any, Tuple
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

# Serverless environment detection (Vercel, AWS Lambda, Cloud Run serverless)
IS_SERVERLESS = bool(os.environ.get("VERCEL") or os.environ.get("AWS_LAMBDA_FUNCTION_NAME"))
SERVERLESS_MAX_SAFE_TRACKS = 15

# Support serverless read-only filesystems (e.g., Vercel / AWS Lambda use /tmp) or custom DOWNLOADS_DIR
if IS_SERVERLESS:
    DOWNLOADS_DIR = Path("/tmp/downloads")
else:
    DOWNLOADS_DIR = Path(os.environ.get("DOWNLOADS_DIR", BASE_DIR / "downloads"))

DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)
STATIC_DIR = BASE_DIR / "static"
STATIC_DIR.mkdir(parents=True, exist_ok=True)



# ---------------------------------------------------------
# Windows & Environment Discovery (FFmpeg & Deno)
# ---------------------------------------------------------
def discover_and_inject_binaries():
    """
    Check if ffmpeg/deno/node are on PATH.
    1. If on Windows, scan WinGet Packages in %LOCALAPPDATA% to auto-inject without requiring terminal restart.
    2. If ffmpeg is missing, check imageio-ffmpeg (crucial for Vercel & serverless environments).
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

    # Fallback to imageio-ffmpeg if ffmpeg is still not found (e.g. on Vercel or minimal Linux)
    if not shutil.which("ffmpeg"):
        try:
            import importlib
            imageio_ffmpeg = None
            try:
                imageio_ffmpeg = importlib.import_module("imageio_ffmpeg")
            except (ImportError, ModuleNotFoundError):
                pass

            if imageio_ffmpeg and hasattr(imageio_ffmpeg, "get_ffmpeg_exe"):
                ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
                if ffmpeg_exe and os.path.exists(ffmpeg_exe):
                    ffmpeg_dir = os.path.dirname(ffmpeg_exe)
                    base_name = os.path.basename(ffmpeg_exe).lower()
                    expected_name = "ffmpeg.exe" if sys.platform == "win32" else "ffmpeg"
                    
                    # If the binary has a version suffix (like ffmpeg-linux64-v4.1), link or copy to standard 'ffmpeg'
                    if base_name != expected_name:
                        target_dir = Path("/tmp/bin") if os.environ.get("VERCEL") else Path(ffmpeg_dir)
                        target_dir.mkdir(parents=True, exist_ok=True)
                        target_bin = target_dir / expected_name
                        if not target_bin.exists():
                            try:
                                target_bin.symlink_to(ffmpeg_exe)
                            except Exception:
                                try:
                                    shutil.copy2(ffmpeg_exe, target_bin)
                                    if sys.platform != "win32":
                                        os.chmod(target_bin, 0o755)
                                except Exception:
                                    pass
                        if target_bin.exists():
                            os.environ["PATH"] = str(target_dir) + os.pathsep + os.environ["PATH"]
                        else:
                            os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ["PATH"]
                    else:
                        os.environ["PATH"] = ffmpeg_dir + os.pathsep + os.environ["PATH"]
                    logger.info(f"Auto-injected imageio-ffmpeg at {ffmpeg_exe} into PATH.")
        except Exception as e:
            logger.warning(f"imageio-ffmpeg injection error: {e}")

discover_and_inject_binaries()

def cleanup_legacy_na_files():
    """Scans DOWNLOADS_DIR and deletes all obsolete 'NA - *' files to reclaim disk space."""
    try:
        count = 0
        freed_bytes = 0
        for p in DOWNLOADS_DIR.rglob("*"):
            if p.is_file() and p.name.startswith(("NA - ", "NA_", "NA.")):
                try:
                    sz = p.stat().st_size
                    p.unlink(missing_ok=True)
                    count += 1
                    freed_bytes += sz
                except Exception:
                    pass
        if count > 0:
            mb = freed_bytes / (1024 * 1024)
            logger.info(f"Cleaned up {count} obsolete NA file(s), freed {mb:.1f} MB disk space.")
    except Exception as e:
        logger.warning(f"Error during legacy NA files cleanup: {e}")

cleanup_legacy_na_files()

def check_system_tools() -> Dict[str, Any]:
    discover_and_inject_binaries()
    ffmpeg_path = shutil.which("ffmpeg")
    deno_path = shutil.which("deno")
    node_path = shutil.which("node")
    is_win = sys.platform == "win32"
    is_vercel = bool(os.environ.get("VERCEL"))
    
    has_js_engine = bool(deno_path or node_path)
    js_engine_name = "Deno" if deno_path else ("Node.js" if node_path else None)

    # Determine platform and recommended install commands
    if is_win:
        platform_name = "windows"
        ffmpeg_cmd = "winget install Gyan.FFmpeg"
        deno_cmd = "winget install DenoLand.Deno"
    elif is_vercel:
        platform_name = "vercel"
        ffmpeg_cmd = "imageio-ffmpeg in requirements.txt"
        deno_cmd = "Node.js (Serverless built-in)"
    else:
        platform_name = "linux"
        ffmpeg_cmd = "sudo apt update && sudo apt install -y ffmpeg"
        deno_cmd = "curl -fsSL https://deno.land/install.sh | sh"

    return {
        "ffmpeg_installed": bool(ffmpeg_path),
        "ffmpeg_path": ffmpeg_path,
        "deno_installed": bool(deno_path),
        "deno_path": deno_path,
        "node_installed": bool(node_path),
        "node_path": node_path,
        "has_js_engine": has_js_engine,
        "js_engine_name": js_engine_name,
        "ytdlp_version": yt_dlp.version.__version__,
        "is_vercel": is_vercel,
        "is_serverless": IS_SERVERLESS,
        "serverless_limit_notice": "Serverless platform detected. Execution limits may terminate jobs taking >60s. For large playlists (50-200 tracks), run via Docker or VM." if IS_SERVERLESS else None,
        "platform": platform_name,
        "winget_ffmpeg_cmd": ffmpeg_cmd,
        "winget_deno_cmd": deno_cmd,
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
    concurrency: int = Field(default=3, ge=1, le=8)
    conversion_concurrency: int = Field(default=2, ge=1, le=8)
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
# FFmpeg Subprocess Optimizer & Helpers
# ---------------------------------------------------------
def run_ffmpeg_command(cmd: List[str], timeout: int = 180) -> None:
    """
    Executes FFmpeg with:
    - stdout discarded (DEVNULL) to avoid memory accumulation
    - bounded stderr capture (tail only) to avoid unbounded buffer growth
    - -nostats -loglevel error flags for minimal I/O and process overhead
    """
    optimized_cmd = [cmd[0], "-nostats", "-loglevel", "error"] + cmd[1:]
    
    proc = subprocess.Popen(
        optimized_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL
    )
    
    try:
        _, stderr_bytes = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise RuntimeError(f"FFmpeg process timed out after {timeout} seconds.")
    
    if proc.returncode != 0:
        tail_stderr = (stderr_bytes or b"")[-2048:].decode("utf-8", errors="replace").strip()
        raise subprocess.CalledProcessError(
            proc.returncode,
            optimized_cmd,
            output=None,
            stderr=tail_stderr
        )


# ---------------------------------------------------------
# Download Job Manager (Bounded Producer-Consumer Pipeline)
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
        
        # Auto-clean legacy temp and NA files to optimize resources and disk storage
        self.cleanup_temp_files()
        
        # Track statuses: key is item.id
        self.track_status = {}
        for item in items:
            self.track_status[item.id] = {
                "id": item.id,
                "index": item.index,
                "title": item.title,
                "artist": item.artist,
                "status": "queued",  # queued, downloading, conversion_queued, converting, done, skipped, failed
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

        # Configurable concurrency for bounded pipeline
        self.download_workers = max(1, options.concurrency)
        self.convert_workers = max(1, getattr(options, "conversion_concurrency", 2))

        # Observability & timing metrics
        self.active_downloads = 0
        self.active_conversions = 0
        self.start_time = time.time()
        self.total_download_time = 0.0
        self.total_convert_time = 0.0
        self.total_zip_time = 0.0

        # Bounded queue for pipeline backpressure
        self.convert_queue: queue.Queue = queue.Queue(maxsize=max(4, self.convert_workers * 2))
        self._lock = threading.Lock()

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
        queued_conv = self.convert_queue.qsize() if hasattr(self, "convert_queue") else 0
        self.broadcast({
            "type": "overall_update",
            "completed_count": self.completed_count,
            "failed_count": self.failed_count,
            "total_count": self.total_count,
            "percent": percent,
            "status": self.status,
            "active_downloads": self.active_downloads,
            "active_conversions": self.active_conversions,
            "queued_conversions": queued_conv
        })

    def cancel(self):
        if self.cancelled:
            return
        self.cancelled = True
        self.status = "cancelled"
        logger.info(f"Job {self.job_id} marked as cancelled by user.")

        # Drain convert_queue immediately to release any blocked workers
        if hasattr(self, "convert_queue"):
            try:
                while not self.convert_queue.empty():
                    self.convert_queue.get_nowait()
                    self.convert_queue.task_done()
            except Exception:
                pass

        # Mark all pending / active tracks as cancelled immediately so UI reflects stopped state
        with self._lock:
            for item in self.items:
                st = self.track_status.get(item.id, {}).get("status")
                if st in ["queued", "downloading", "conversion_queued", "converting"]:
                    self.track_status[item.id]["status"] = "cancelled"
                    self.track_status[item.id]["eta"] = "Cancelled"
                    self.track_status[item.id]["error"] = "Cancelled by user"

        # Clean only incomplete temporary files (.part, .temp, .ytdl), PRESERVING completed media files!
        self.cleanup_temp_files()

        # If any tracks finished successfully, package them into a ZIP archive right now
        zip_name = None
        if self.completed_count > 0:
            try:
                zip_p = self.safe_zip()
                zip_name = zip_p.name
            except Exception as e:
                logger.warning(f"Could not create partial ZIP on cancel: {e}")

        # Broadcast cancelled event with details about preserved tracks
        self.broadcast({
            "type": "cancelled",
            "message": "Download cancelled by user.",
            "job_id": self.job_id,
            "completed_count": self.completed_count,
            "total_count": self.total_count,
            "zip_filename": zip_name,
            "zip_size_bytes": self.zip_size_bytes,
            "download_dir": str(self.download_dir.resolve())
        })

    def cleanup_temp_files(self):
        """Remove partial download files (.part, .ytdl, etc.) and purge any obsolete NA files to optimize storage."""
        try:
            for ext in ["*.part", "*.ytdl", "*.temp"]:
                for temp_file in self.download_dir.glob(ext):
                    try:
                        temp_file.unlink(missing_ok=True)
                    except Exception as e:
                        logger.warning(f"Could not remove temp file {temp_file}: {e}")

            # Clean any obsolete NA files to reclaim disk space and prevent inclusion in archives
            for pattern in ["NA - *", "NA_*", "NA.*"]:
                for na_file in self.download_dir.glob(pattern):
                    try:
                        logger.info(f"Removing obsolete NA file to reclaim storage: {na_file.name}")
                        na_file.unlink(missing_ok=True)
                    except Exception as e:
                        logger.warning(f"Could not remove NA file {na_file}: {e}")

            # If not saving standalone thumbnails, purge leftover webp/html files (preserve jpg/png for tags)
            if not self.options.save_thumbnails:
                for img_pattern in ["*.webp", "*.html", "*.htm"]:
                    for img_file in self.download_dir.glob(img_pattern):
                        try:
                            img_file.unlink(missing_ok=True)
                        except Exception:
                            pass
        except Exception as e:
            logger.warning(f"Error cleaning up temp files in {self.download_dir}: {e}")

    def safe_zip(self) -> Path:
        """Create ZIP stored archive containing ONLY the media files for the selected tracks in this job."""
        zip_start = time.time()
        zip_filename = f"{self.clean_title}.zip"
        target_zip = DOWNLOADS_DIR / zip_filename
        
        # Cleanup temporary, obsolete NA, and non-audio files before archiving
        self.cleanup_temp_files()
        
        AUDIO_EXTENSIONS = {".mp3", ".m4a", ".opus", ".flac", ".wav", ".ogg", ".aac", ".webm"}
        VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov"}
        
        valid_indices = {f"{itm.index:02d}" for itm in self.items}
        valid_titles = {sanitize_filename(itm.title).lower() for itm in self.items}
        
        files_to_zip: list[Path] = []
        for file_path in sorted(self.download_dir.iterdir()):
            if not file_path.is_file():
                continue
            name = file_path.name
            ext = file_path.suffix.lower()

            # Strictly filter by allowed media extension: NO .webp, .html, etc.
            if self.options.type == "audio":
                if ext not in AUDIO_EXTENSIONS:
                    if not (self.options.save_thumbnails and ext in [".jpg", ".png"]):
                        continue
            else:
                if ext not in VIDEO_EXTENSIONS:
                    if not (self.options.save_thumbnails and ext in [".jpg", ".png"]):
                        continue

            if name.endswith((".part", ".ytdl", ".temp", ".zip")) or name.startswith(("NA -", "NA_", "NA.")):
                continue
            
            if self.options.prefix_index:
                prefix = name[:2]
                if prefix in valid_indices and (len(name) > 2 and name[2] in [" ", "-", "."]):
                    files_to_zip.append(file_path)
            else:
                if any(t in name.lower() for t in valid_titles):
                    files_to_zip.append(file_path)

        if not files_to_zip:
            for file_path in sorted(self.download_dir.iterdir()):
                ext = file_path.suffix.lower()
                is_media = ext in AUDIO_EXTENSIONS if self.options.type == "audio" else ext in VIDEO_EXTENSIONS
                if file_path.is_file() and is_media and not file_path.name.startswith(("NA -", "NA_")):
                    files_to_zip.append(file_path)

        # Optimization: Avoid redundant duplicate ZIP creation if existing archive is fresh and complete
        if target_zip.exists() and files_to_zip:
            try:
                zip_mtime = target_zip.stat().st_mtime
                if all(f.stat().st_mtime <= zip_mtime for f in files_to_zip):
                    with zipfile.ZipFile(target_zip, "r") as zf:
                        if len(zf.namelist()) == len(files_to_zip):
                            logger.info(f"Reusing existing valid ZIP archive: {target_zip.name} ({len(files_to_zip)} files)")
                            self.zip_path = target_zip
                            self.zip_size_bytes = target_zip.stat().st_size
                            self.total_zip_time = time.time() - zip_start
                            return target_zip
            except Exception:
                pass

        # Write ZIP_STORED (zero re-compression, instant speed for already-compressed media)
        for attempt in range(5):
            try:
                with zipfile.ZipFile(target_zip, "w", compression=zipfile.ZIP_STORED) as zf:
                    for file_path in files_to_zip:
                        zf.write(file_path, arcname=file_path.name)
                break
            except (PermissionError, OSError) as e:
                logger.warning(f"Windows file lock encountered creating ZIP (attempt {attempt+1}/5): {e}")
                time.sleep(0.5)

        self.zip_path = target_zip
        if target_zip.exists():
            self.zip_size_bytes = target_zip.stat().st_size
        self.total_zip_time = time.time() - zip_start
        return target_zip

# Active jobs storage
jobs: Dict[str, DownloadJob] = {}


def check_existing_target(job: DownloadJob, item: TrackItem) -> Optional[Path]:
    """Check if a valid output file already exists for this track to skip re-downloading."""
    if not job.options.skip_existing:
        return None
    idx_str = f"{item.index:02d}"
    AUDIO_EXTENSIONS = {".mp3", ".m4a", ".opus", ".flac", ".wav", ".ogg", ".aac"}
    VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm"}
    allowed_exts = AUDIO_EXTENSIONS if job.options.type == "audio" else VIDEO_EXTENSIONS
    if job.options.type == "audio" and job.options.audio_format != "best":
        allowed_exts = {f".{job.options.audio_format}"}

    for p in job.download_dir.iterdir():
        if not p.is_file():
            continue
        if p.suffix.lower() not in allowed_exts:
            continue
        if p.name.endswith((".part", ".ytdl", ".temp", ".zip")):
            continue
        if p.stat().st_size < 10240:
            continue
        if job.options.prefix_index:
            if p.name.startswith((f"{idx_str} -", f"{idx_str}.", f"{idx_str}_", f"{idx_str} ")):
                return p
        else:
            clean_title = sanitize_filename(item.title).lower()
            if clean_title and clean_title in p.name.lower():
                return p
    return None


def find_downloaded_file(job: DownloadJob, item: TrackItem, info: Dict[str, Any]) -> Optional[Path]:
    """Robustly locate the downloaded media file for a track."""
    if info.get("requested_downloads"):
        for req in info["requested_downloads"]:
            fp = req.get("filepath")
            if fp and os.path.exists(fp):
                return Path(fp)

    fn = info.get("_filename")
    if fn and os.path.exists(fn):
        return Path(fn)

    idx_prefix = f"{item.index:02d}"
    for p in job.download_dir.iterdir():
        if not p.is_file():
            continue
        if p.name.endswith((".part", ".ytdl", ".temp", ".zip", ".jpg", ".png", ".webp")):
            continue
        if p.name.startswith((f"{idx_prefix} -", f"{idx_prefix}.", f"{idx_prefix}_", f"{idx_prefix} ")):
            return p

    clean_title = sanitize_filename(item.title).lower()
    for p in job.download_dir.iterdir():
        if not p.is_file():
            continue
        if p.name.endswith((".part", ".ytdl", ".temp", ".zip", ".jpg", ".png", ".webp")):
            continue
        if item.id in p.name or (clean_title and clean_title in p.name.lower()):
            return p

    return None


def run_single_download(job: DownloadJob, item: TrackItem) -> Tuple[Optional[Path], Optional[Dict[str, Any]]]:
    """Worker function executed in download pool for one track. Returns (raw_path, info)."""
    if job.cancelled:
        job.update_track(item.id, status="cancelled", eta="Cancelled", error="Download cancelled.")
        return None, None

    # Check cache / existing completed track
    existing_path = check_existing_target(job, item)
    if existing_path:
        logger.info(f"Skipping track {item.id} ({item.title}): already exists at {existing_path.name}")
        job.update_track(item.id, status="done", percent=100.0, speed="", eta="Existing", file_path=str(existing_path))
        with job._lock:
            job.completed_count += 1
            job.update_overall()
        return None, None

    job.update_track(item.id, status="downloading", percent=0.0, speed="", eta="")
    
    opts = job.options
    video_url = f"https://www.youtube.com/watch?v={item.id}"
    
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
            job.update_track(item.id, status="conversion_queued", percent=100.0, speed="", eta="Convert-Q")

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
        # Prevent collisions if playlist contains tracks with duplicate titles
        clean_title = sanitize_filename(item.title).lower()
        title_occurrences = sum(1 for itm in job.items if sanitize_filename(itm.title).lower() == clean_title)
        if title_occurrences > 1:
            template = f"{template} (%(id)s)"

    template = re.sub(r'^NA\s*[-_.]\s*', '', template)
    outtmpl = str(job.download_dir / template)

    ffmpeg_exe = shutil.which("ffmpeg")
    ffmpeg_dir = os.path.dirname(ffmpeg_exe) if ffmpeg_exe else None

    ydl_opts: Dict[str, Any] = {
        "outtmpl": outtmpl,
        "outtmpl_na_placeholder": "",
        "quiet": True,
        "no_warnings": True,
        "nocheckcertificate": True,
        "windowsfilenames": True,
        "restrictfilenames": False,
        "progress_hooks": [progress_hook],
        "retries": opts.retries,
        "fragment_retries": opts.retries,
    }

    if ffmpeg_dir:
        ydl_opts["ffmpeg_location"] = ffmpeg_dir

    ydl_opts["extractor_args"] = {
        "youtube": {
            "player_client": ["android", "ios", "web"],
            "player_skip": ["webpage", "configs"],
        }
    }
    ydl_opts["http_headers"] = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
    }

    cookie_env = os.environ.get("YOUTUBE_COOKIES") or os.environ.get("COOKIES")
    cookies_file = BASE_DIR / "cookies.txt"
    if cookie_env and cookie_env.strip():
        target_cookie = Path("/tmp/cookies.txt") if os.environ.get("VERCEL") else BASE_DIR / "cookies.txt"
        try:
            target_cookie.write_text(cookie_env.strip(), encoding="utf-8")
            ydl_opts["cookiefile"] = str(target_cookie)
        except Exception as e:
            logger.warning(f"Failed to write cookiefile from env: {e}")
    elif cookies_file.exists():
        ydl_opts["cookiefile"] = str(cookies_file)
    elif opts.browser_cookies and opts.browser_cookies.lower() in ["chrome", "edge", "firefox"]:
        if sys.platform == "win32" or not os.environ.get("VERCEL"):
            try:
                ydl_opts["cookiesfrombrowser"] = (opts.browser_cookies.lower(), None, None, None)
            except Exception:
                pass

    if opts.rate_limit and opts.rate_limit.strip():
        ydl_opts["ratelimit"] = opts.rate_limit.strip()

    if opts.skip_existing:
        ydl_opts["nooverwrites"] = True

    if opts.type == "audio":
        ydl_opts["format"] = "bestaudio/best"
    else:
        if opts.video_quality == "best":
            ydl_opts["format"] = "bestvideo+bestaudio/best"
        else:
            ydl_opts["format"] = f"bestvideo[height<={opts.video_quality}]+bestaudio/best[height<={opts.video_quality}]/best"

    # Optimization: Do NOT download thumbnails if neither cover art embedding nor saving thumbnails is requested
    if opts.embed_cover_art or opts.save_thumbnails:
        ydl_opts["writethumbnail"] = True

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(video_url, download=True, extra_info={"playlist_index": item.index})
            raw_path = find_downloaded_file(job, item, info)
            return raw_path, info

    except DownloadCancelledException:
        logger.info(f"Track {item.id} download cancelled.")
        job.update_track(item.id, status="cancelled", eta="Cancelled", error="Cancelled by user.")
        return None, None

    except Exception as e:
        if job.cancelled:
            job.update_track(item.id, status="cancelled", eta="Cancelled", error="Cancelled by user.")
            return None, None

        err_msg = str(e)
        logger.warning(f"Error downloading track {item.id} ({item.title}): {err_msg}")

        # Automatic fallback retry for datacenter/cloud bot blocks using mobile player clients
        if ("not a bot" in err_msg.lower() or "sign in to confirm" in err_msg.lower()) and not getattr(job, "_retried_bot_" + item.id, False):
            setattr(job, "_retried_bot_" + item.id, True)
            logger.info(f"Retrying track {item.id} using android/ios fallback client...")
            try:
                fallback_opts = dict(ydl_opts)
                fallback_opts["extractor_args"] = {
                    "youtube": {
                        "player_client": ["android", "ios"]
                    }
                }
                fallback_opts["format"] = "bestaudio/best"
                with yt_dlp.YoutubeDL(fallback_opts) as fallback_ydl:
                    info = fallback_ydl.extract_info(video_url, download=True, extra_info={"playlist_index": item.index})
                    raw_path = find_downloaded_file(job, item, info)
                    return raw_path, info
            except Exception as retry_err:
                err_msg = str(retry_err)
                logger.warning(f"Fallback retry failed for track {item.id}: {err_msg}")

        if job.cancelled:
            job.update_track(item.id, status="cancelled", eta="Cancelled", error="Cancelled by user.")
            return None, None

        if "Video unavailable" in err_msg:
            clean_err = "Video unavailable or deleted"
        elif "Private video" in err_msg:
            clean_err = "Private video (needs login cookies)"
        elif "Sign in to confirm your age" in err_msg:
            clean_err = "Age-restricted (requires cookies)"
        elif "not a bot" in err_msg.lower() or "sign in to confirm" in err_msg.lower():
            clean_err = "Cloud IP Bot Block: Set YOUTUBE_COOKIES env var"
        elif "WinError 32" in err_msg:
            clean_err = "Windows file lock error - retrying"
        else:
            clean_err = err_msg.split("\n")[0][:80]

        job.update_track(item.id, status="failed", error=clean_err)
        with job._lock:
            job.failed_count += 1
            job.update_overall()
        return None, None


def run_single_conversion(job: DownloadJob, item: TrackItem, raw_path: Path, info: Dict[str, Any]):
    """Background worker executing CPU audio conversion & metadata tagging in parallel."""
    if job.cancelled:
        return

    # Track now transitions from 'conversion_queued' to active 'converting'
    job.update_track(item.id, status="converting", speed="", eta="Converting")

    opts = job.options
    ffmpeg_exe = shutil.which("ffmpeg")
    if not ffmpeg_exe:
        discover_and_inject_binaries()
        ffmpeg_exe = shutil.which("ffmpeg")

    try:
        if opts.type == "audio":
            raw_ext = raw_path.suffix.lower()
            
            # Format optimization: determine target extension
            if opts.audio_format == "best":
                target_ext = raw_ext
            else:
                target_ext = f".{opts.audio_format}"
            
            target_path = raw_path.with_suffix(target_ext)

            is_best = (opts.audio_format == "best")
            is_matching_codec = (raw_ext == target_ext)
            can_stream_copy = is_best or is_matching_codec

            # If matching extension / best, and neither metadata nor cover art is requested:
            # Skip FFmpeg entirely! (0% CPU, 0 seconds transcode time)
            if can_stream_copy and not opts.embed_metadata and not opts.embed_cover_art:
                logger.info(f"Preserving original stream without transcoding for track {item.id} ({raw_path.name})")
                target_path = raw_path
            else:
                # If target_path is the same path as raw_path, FFmpeg cannot write directly to it!
                # We use an intermediate temp file for the output, then atomically replace.
                same_path = (raw_path.resolve() == target_path.resolve())
                if same_path:
                    ffmpeg_out = raw_path.with_name(f"{raw_path.stem}.tmp_out{target_ext}")
                else:
                    ffmpeg_out = target_path

                base_cmd = [ffmpeg_exe, "-y", "-i", str(raw_path)]
                
                audio_codec_args = []
                if can_stream_copy:
                    # Stream copy: 30x faster, zero quality loss, preserves original codec
                    audio_codec_args = ["-c:a", "copy"]
                else:
                    # Optimized transcoding with chosen codec and quality
                    fmt = opts.audio_format
                    q = opts.audio_quality
                    if fmt == "mp3":
                        audio_codec_args.extend(["-c:a", "libmp3lame"])
                        if q != "best":
                            audio_codec_args.extend(["-b:a", f"{q}k"])
                        else:
                            audio_codec_args.extend(["-q:a", "0"])
                    elif fmt == "m4a":
                        audio_codec_args.extend(["-c:a", "aac"])
                        if q != "best":
                            audio_codec_args.extend(["-b:a", f"{q}k"])
                        else:
                            audio_codec_args.extend(["-b:a", "256k"])
                    elif fmt == "opus":
                        audio_codec_args.extend(["-c:a", "libopus"])
                        if q != "best":
                            audio_codec_args.extend(["-b:a", f"{q}k"])
                        else:
                            audio_codec_args.extend(["-b:a", "192k"])
                    elif fmt == "flac":
                        audio_codec_args.extend(["-c:a", "flac"])
                    elif fmt == "wav":
                        audio_codec_args.extend(["-c:a", "pcm_s16le"])
                    elif fmt == "ogg":
                        audio_codec_args.extend(["-c:a", "libvorbis"])
                        if q != "best":
                            audio_codec_args.extend(["-b:a", f"{q}k"])
                        else:
                            audio_codec_args.extend(["-q:a", "6"])

                # Metadata tags (optional)
                metadata_args = []
                if opts.embed_metadata:
                    title = item.title or info.get("title") or ""
                    artist = item.artist or info.get("uploader") or ""
                    album = job.playlist_title or ""
                    metadata_args.extend([
                        "-metadata", f"title={title}",
                        "-metadata", f"artist={artist}",
                        "-metadata", f"album_artist={artist}",
                        "-metadata", f"album={album}",
                        "-metadata", f"track={item.index}",
                    ])

                # Cover art thumbnail (optional)
                thumb_file = None
                thumb_args = []
                if opts.embed_cover_art and (fmt in ["mp3", "m4a", "flac"] if not is_best else target_ext in [".mp3", ".m4a", ".flac"]):
                    stem = raw_path.stem
                    parent = raw_path.parent
                    for cand_ext in [".jpg", ".jpeg", ".png", ".webp"]:
                        cand = parent / f"{stem}{cand_ext}"
                        if cand.exists():
                            thumb_file = cand
                            break
                    if thumb_file:
                        thumb_args.extend(["-i", str(thumb_file), "-map", "0:a", "-map", "1:v"])
                        if fmt == "mp3" or target_ext == ".mp3":
                            thumb_args.extend([
                                "-c:v", "mjpeg",
                                "-disposition:v:0", "attached_pic",
                                "-id3v2_version", "3",
                                "-metadata:s:v", "title=Album cover",
                                "-metadata:s:v", "comment=Cover (front)"
                            ])
                        else:
                            thumb_args.extend([
                                "-c:v", "copy",
                                "-disposition:v:0", "attached_pic"
                            ])

                full_cmd = list(base_cmd)
                if thumb_args:
                    full_cmd.extend(thumb_args)
                else:
                    full_cmd.append("-vn")
                full_cmd.extend(audio_codec_args)
                full_cmd.extend(metadata_args)
                full_cmd.append(str(ffmpeg_out))

                try:
                    run_ffmpeg_command(full_cmd, timeout=180)
                except subprocess.CalledProcessError as cp_err:
                    if thumb_args:
                        logger.warning(f"FFmpeg with thumbnail failed ({cp_err.stderr[:100] if cp_err.stderr else cp_err}), retrying audio-only...")
                        fallback_cmd = base_cmd + ["-vn"] + audio_codec_args + metadata_args + [str(ffmpeg_out)]
                        run_ffmpeg_command(fallback_cmd, timeout=180)
                    else:
                        raise

                # Verify output file exists and is valid before deleting raw intermediate
                if ffmpeg_out.exists() and ffmpeg_out.stat().st_size > 1024:
                    if same_path:
                        raw_path.unlink(missing_ok=True)
                        ffmpeg_out.replace(target_path)
                    else:
                        raw_path.unlink(missing_ok=True)
                    if thumb_file and not opts.save_thumbnails:
                        thumb_file.unlink(missing_ok=True)
                else:
                    raise RuntimeError(f"Output verification failed: {ffmpeg_out} is missing or empty.")

        else:
            # Video mode
            target_ext = f".{opts.video_format}"
            target_path = raw_path.with_suffix(target_ext)
            if raw_path.suffix.lower() != target_ext:
                cmd = [ffmpeg_exe, "-y", "-i", str(raw_path), "-c", "copy", str(target_path)]
                run_ffmpeg_command(cmd, timeout=300)
                if target_path.exists() and target_path.stat().st_size > 1024:
                    raw_path.unlink(missing_ok=True)

        if job.cancelled:
            return

        job.update_track(item.id, status="done", percent=100.0, speed="", eta="", file_path=str(target_path))
        with job._lock:
            job.completed_count += 1
            job.update_overall()

    except Exception as e:
        if job.cancelled:
            return
        err_msg = str(e)
        logger.error(f"Conversion error for track {item.id} ({item.title}): {err_msg}")
        job.update_track(item.id, status="failed", error="Conversion failed")
        with job._lock:
            job.failed_count += 1
            job.update_overall()


def run_job_thread(job: DownloadJob):
    """
    Optimized bounded producer-consumer pipeline:
    - Bounded download pool (default 3 workers)
    - Bounded conversion pool (default 2 workers)
    - Bounded conversion queue with backpressure so disk and RAM are not overwhelmed
    - Real-time duration logging and queue observability
    """
    job_start_time = time.time()
    logger.info(
        f"Starting optimized pipeline for job {job.job_id} "
        f"({job.total_count} tracks, format: {job.options.audio_format if job.options.type == 'audio' else job.options.video_format}, "
        f"dl_workers: {job.download_workers}, conv_workers: {job.convert_workers})"
    )

    # Queue of items to be downloaded
    item_queue: queue.Queue = queue.Queue()
    for item in job.items:
        item_queue.put(item)

    # Bounded queue of downloaded raw files ready for conversion
    # maxsize creates backpressure: download workers wait if conversion queue is full!
    convert_queue: queue.Queue = queue.Queue(maxsize=max(4, job.convert_workers * 2))
    job.convert_queue = convert_queue

    # Download workers
    def download_worker():
        while not job.cancelled:
            try:
                item = item_queue.get_nowait()
            except queue.Empty:
                break
            
            with job._lock:
                job.active_downloads += 1
                job.update_overall()

            t0 = time.time()
            try:
                raw_path, info = run_single_download(job, item)
                duration = time.time() - t0
                with job._lock:
                    job.total_download_time += duration
                
                if raw_path and raw_path.exists() and not job.cancelled:
                    # Enqueue for conversion with backpressure (blocks if convert_queue is full)
                    job.update_track(item.id, status="conversion_queued", eta="Convert-Q", percent=100.0)
                    while not job.cancelled:
                        try:
                            convert_queue.put((item, raw_path, info), timeout=0.25)
                            break
                        except queue.Full:
                            continue
            except Exception as e:
                logger.error(f"Download worker error on track {item.id}: {e}")
            finally:
                item_queue.task_done()
                with job._lock:
                    job.active_downloads = max(0, job.active_downloads - 1)
                    job.update_overall()

    # Conversion workers
    def convert_worker():
        while not job.cancelled:
            try:
                entry = convert_queue.get(timeout=0.25)
            except queue.Empty:
                # If download queue is also empty and active downloads is 0, we are done
                if item_queue.empty() and job.active_downloads == 0 and convert_queue.empty():
                    break
                continue

            if entry is None or job.cancelled:
                convert_queue.task_done()
                break

            item, raw_path, info = entry
            with job._lock:
                job.active_conversions += 1
                job.update_overall()

            t0 = time.time()
            try:
                run_single_conversion(job, item, raw_path, info)
                duration = time.time() - t0
                with job._lock:
                    job.total_convert_time += duration
            except Exception as e:
                logger.error(f"Convert worker error on track {item.id}: {e}")
            finally:
                convert_queue.task_done()
                with job._lock:
                    job.active_conversions = max(0, job.active_conversions - 1)
                    job.update_overall()

    # Launch download and conversion threads
    dl_threads = []
    for i in range(job.download_workers):
        t = threading.Thread(target=download_worker, name=f"DL-Worker-{i+1}", daemon=True)
        t.start()
        dl_threads.append(t)

    conv_threads = []
    for i in range(job.convert_workers):
        t = threading.Thread(target=convert_worker, name=f"Conv-Worker-{i+1}", daemon=True)
        t.start()
        conv_threads.append(t)

    # Wait for download threads with responsive cancellation check
    for t in dl_threads:
        while t.is_alive():
            t.join(timeout=0.2)
            if job.cancelled:
                break

    # Wait for conversion threads with responsive cancellation check
    for t in conv_threads:
        while t.is_alive():
            t.join(timeout=0.2)
            if job.cancelled:
                break

    total_job_time = time.time() - job_start_time

    if job.cancelled:
        job.status = "cancelled"
        job.cleanup_temp_files()
        if job.completed_count > 0:
            try:
                job.safe_zip()
            except Exception as e:
                logger.warning(f"Error packaging partial zip on cancel: {e}")
        logger.info(f"Job {job.job_id} cancelled after {total_job_time:.2f}s ({job.completed_count} preserved).")
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

    zip_start = time.time()
    try:
        zip_path = job.safe_zip()
        job.total_zip_time = time.time() - zip_start
        job.status = "completed"
        logger.info(
            f"Job {job.job_id} COMPLETED in {total_job_time:.2f}s! "
            f"Metrics: Successful: {job.completed_count}/{job.total_count}, "
            f"Download sum: {job.total_download_time:.2f}s, "
            f"Conversion sum: {job.total_convert_time:.2f}s, "
            f"ZIP packaging: {job.total_zip_time:.2f}s ({job.zip_size_bytes / (1024*1024):.1f} MB)"
        )
        job.broadcast({
            "type": "completed",
            "job_id": job.job_id,
            "total": job.total_count,
            "successful": job.completed_count,
            "failed": job.failed_count,
            "zip_filename": zip_path.name,
            "zip_size_bytes": job.zip_size_bytes,
            "download_dir": str(job.download_dir.resolve()),
            "metrics": {
                "total_time_seconds": round(total_job_time, 2),
                "download_time_sum": round(job.total_download_time, 2),
                "convert_time_sum": round(job.total_convert_time, 2),
                "zip_time_seconds": round(job.total_zip_time, 2),
                "avg_conversion_time": round(job.total_convert_time / max(1, job.completed_count), 2)
            }
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
        "extractor_args": {
            "youtube": {
                "player_client": ["android", "ios", "web"],
            }
        },
        "http_headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
        }
    }

    # Cookie support for preview
    cookie_env = os.environ.get("YOUTUBE_COOKIES") or os.environ.get("COOKIES")
    cookies_file = BASE_DIR / "cookies.txt"
    if cookie_env and cookie_env.strip():
        target_cookie = Path("/tmp/cookies.txt") if os.environ.get("VERCEL") else BASE_DIR / "cookies.txt"
        try:
            target_cookie.write_text(cookie_env.strip(), encoding="utf-8")
            ydl_opts["cookiefile"] = str(target_cookie)
        except Exception:
            pass
    elif cookies_file.exists():
        ydl_opts["cookiefile"] = str(cookies_file)
    elif req.cookies_browser and req.cookies_browser.lower() in ["chrome", "edge", "firefox"]:
        if sys.platform == "win32" or not os.environ.get("VERCEL"):
            try:
                ydl_opts["cookiesfrombrowser"] = (req.cookies_browser.lower(), None, None, None)
            except Exception:
                pass

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

    serverless_warning = None
    if IS_SERVERLESS and len(req.items) > SERVERLESS_MAX_SAFE_TRACKS:
        serverless_warning = f"Serverless warning: {len(req.items)} tracks requested. Serverless execution limits may terminate jobs taking >60s. For large playlists, deploy via Docker/VM."
        logger.warning(serverless_warning)

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

    return {
        "job_id": job_id,
        "total": len(req.items),
        "playlist_title": job.playlist_title,
        "serverless_warning": serverless_warning
    }


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
    old_job.items = failed_items  # Process only the retried items

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
            # Linux: Check if GUI display server is available
            if os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
                subprocess.Popen(["xdg-open", str(target_path.resolve())])
            else:
                logger.info(f"Headless server environment: target folder exists at {target_path}")
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
    print(f" * ffmpeg: {'Found (' + str(status['ffmpeg_path']) + ')' if status['ffmpeg_installed'] else 'NOT FOUND'}")
    print(f" * deno:   {'Found (' + str(status['deno_path']) + ')' if status['deno_installed'] else 'NOT FOUND'}")
    
    # In cloud environments (GCP Cloud Run, VMs, Docker), HOST and PORT are provided via env
    host = os.environ.get("HOST", "0.0.0.0" if (os.environ.get("PORT") or sys.platform != "win32") else "127.0.0.1")
    port = int(os.environ.get("PORT", 8000))
    print(f"\n Server running at: http://{host}:{port}")
    print(" Press CTRL+C to quit.\n" + "="*60 + "\n")
    
    uvicorn.run("app:app", host=host, port=port, reload=False)
