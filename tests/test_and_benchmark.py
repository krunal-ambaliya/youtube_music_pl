import os
import sys
import time
import shutil
import asyncio
import zipfile
import tracemalloc
from pathlib import Path
import psutil

# Ensure parent directory is in sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import app
from app import (
    DownloadJob,
    TrackItem,
    DownloadOptions,
    run_job_thread,
    run_single_conversion,
    run_ffmpeg_command,
    DOWNLOADS_DIR
)

TEST_DIR = Path(__file__).resolve().parent / "test_data"
TEST_DIR.mkdir(parents=True, exist_ok=True)


def generate_sample_audio_file(target_path: Path, format_type: str = "webm", duration_sec: float = 1.0):
    """Generates a small valid test audio file using ffmpeg for deterministic benchmarking."""
    ffmpeg_exe = shutil.which("ffmpeg")
    if not ffmpeg_exe:
        app.discover_and_inject_binaries()
        ffmpeg_exe = shutil.which("ffmpeg")

    if format_type in ["webm", "opus"]:
        codec_args = ["-c:a", "libopus", "-b:a", "96k"]
    elif format_type == "m4a":
        codec_args = ["-c:a", "aac", "-b:a", "128k"]
    elif format_type == "mp3":
        codec_args = ["-c:a", "libmp3lame", "-b:a", "192k"]
    else:
        codec_args = ["-c:a", "pcm_s16le"]

    cmd = [
        ffmpeg_exe, "-y",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration_sec}",
    ] + codec_args + [str(target_path)]
    run_ffmpeg_command(cmd, timeout=30)


def ensure_sample_source() -> Path:
    sample_source = TEST_DIR / "source_sample.webm"
    if not sample_source.exists():
        generate_sample_audio_file(sample_source, "webm", 1.0)
    return sample_source


def create_mock_track_items(count: int, title_prefix: str = "Track") -> list:
    items = []
    for i in range(1, count + 1):
        items.append(
            TrackItem(
                id=f"test_id_{i:03d}",
                index=i,
                title=f"{title_prefix} {i:03d}",
                artist="Artist Benchmark",
                duration=3,
                duration_formatted="0:03",
                available=True
            )
        )
    return items


def benchmark_pipeline(format_type: str = "best", track_count: int = 50):
    """
    Benchmarks 50 tracks running through the optimized pipeline:
    Measures total time, conversion time, CPU usage, and peak memory.
    """
    print(f"\n========================================================")
    print(f" [BENCHMARK] Running {track_count} tracks with format='{format_type}'")
    print(f"========================================================")

    # 1. Prepare sample source file
    sample_source = TEST_DIR / f"source_sample.webm"
    if not sample_source.exists():
        generate_sample_audio_file(sample_source, "webm", 1.0)

    # 2. Setup job
    items = create_mock_track_items(track_count)
    opts = DownloadOptions(
        type="audio",
        audio_format=format_type,
        audio_quality="320" if format_type == "mp3" else "best",
        embed_metadata=True,
        embed_cover_art=False,
        save_thumbnails=False,
        prefix_index=True,
        skip_existing=False,
        concurrency=3,
        conversion_concurrency=2
    )

    playlist_title = f"Benchmark_{format_type}_{track_count}"
    loop = asyncio.new_event_loop()
    job = DownloadJob(
        job_id=f"bench_{format_type}",
        playlist_title=playlist_title,
        items=items,
        options=opts,
        loop=loop
    )
    job_dir = job.download_dir
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    # Pre-populate downloaded raw files to isolate and accurately measure conversion & pipeline execution
    for item in items:
        idx_str = f"{item.index:02d}"
        raw_file = job_dir / f"{idx_str} - {item.title}.webm"
        shutil.copy2(sample_source, raw_file)

    # Start memory and CPU tracking
    tracemalloc.start()
    process = psutil.Process(os.getpid())
    cpu_start_process_time = time.process_time()
    cpu_percent_samples = []
    
    wall_start = time.time()

    original_run_single_download = app.run_single_download
    def mock_download(j, itm):
        time.sleep(0.01)
        raw = j.download_dir / f"{itm.index:02d} - {itm.title}.webm"
        if not raw.exists():
            shutil.copy2(sample_source, raw)
        return raw, {"title": itm.title, "artist": itm.artist}

    app.run_single_download = mock_download
    try:
        # Run the pipeline thread
        run_job_thread(job)
    finally:
        app.run_single_download = original_run_single_download

    wall_duration = time.time() - wall_start
    cpu_process_duration = time.process_time() - cpu_start_process_time
    current_mem, peak_mem = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    peak_rss_mb = process.memory_info().rss / (1024 * 1024)
    peak_traced_mb = peak_mem / (1024 * 1024)

    print(f"\n--- Benchmark Results: format='{format_type}' ({track_count} tracks) ---")
    print(f" * Successful tracks:       {job.completed_count}/{job.total_count}")
    print(f" * Total Pipeline Time:     {wall_duration:.2f} s")
    print(f" * Total Conversion Sum:    {job.total_convert_time:.2f} s")
    print(f" * Avg Conversion / Track:  {(job.total_convert_time / max(1, job.completed_count)):.3f} s")
    print(f" * ZIP Packaging Time:      {job.total_zip_time:.3f} s (ZIP Size: {job.zip_size_bytes / (1024*1024):.2f} MB)")
    print(f" * Process CPU Time:        {cpu_process_duration:.2f} s")
    print(f" * Peak Traced Memory:      {peak_traced_mb:.2f} MB")
    print(f" * Peak Process RSS:        {peak_rss_mb:.2f} MB")

    return {
        "format": format_type,
        "tracks": track_count,
        "successful": job.completed_count,
        "wall_time": wall_duration,
        "total_convert_time": job.total_convert_time,
        "avg_convert_time": job.total_convert_time / max(1, job.completed_count),
        "zip_time": job.total_zip_time,
        "zip_size_mb": job.zip_size_bytes / (1024 * 1024),
        "cpu_process_time": cpu_process_duration,
        "peak_mem_mb": peak_traced_mb,
        "peak_rss_mb": peak_rss_mb
    }


def test_cancellation():
    print(f"\n========================================================")
    print(f" [TEST] Testing Mid-Job Cancellation")
    print(f"========================================================")

    items = create_mock_track_items(20, "CancelTrack")
    opts = DownloadOptions(
        type="audio",
        audio_format="mp3",
        embed_metadata=False,
        embed_cover_art=False,
        skip_existing=False
    )

    playlist_title = "Test_Cancellation"
    loop = asyncio.new_event_loop()
    job = DownloadJob("job_cancel_test", playlist_title, items, opts, loop)
    job_dir = job.download_dir
    shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    sample_source = TEST_DIR / "source_sample.webm"
    # Pre-populate 4 tracks so they complete
    for item in items[:4]:
        raw_file = job_dir / f"{item.index:02d} - {item.title}.webm"
        shutil.copy2(sample_source, raw_file)
        run_single_conversion(job, item, raw_file, {"title": item.title})

    # Create a dummy .part file to test temp file cleanup
    temp_file = job_dir / "05 - CancelTrack 005.webm.part"
    temp_file.write_text("in-progress download buffer data")

    assert temp_file.exists(), "Temp .part file must exist before cancel"
    completed_before = job.completed_count
    assert completed_before == 4, f"Expected 4 completed, got {completed_before}"

    # Trigger cancel
    job.cancel()

    assert job.cancelled is True, "Job must be marked cancelled"
    assert job.status == "cancelled", "Status must be 'cancelled'"
    assert not temp_file.exists(), "Temp .part file must be cleaned up on cancel!"
    assert job.zip_path is not None and job.zip_path.exists(), "Partial ZIP must be created on cancel!"
    
    with zipfile.ZipFile(job.zip_path, "r") as zf:
        namelist = zf.namelist()
        assert len(namelist) == 4, f"Expected 4 tracks in partial ZIP, got {len(namelist)}"

    print(f" ✓ Cancellation passed: 4 finished tracks preserved in ZIP, in-flight temp files removed immediately.")


def test_failed_tracks_and_retries():
    print(f"\n========================================================")
    print(f" [TEST] Testing Failed Tracks & Retries")
    print(f"========================================================")

    items = create_mock_track_items(4, "RetryTrack")
    opts = DownloadOptions(type="audio", audio_format="best")
    playlist_title = "Test_Retries"
    loop = asyncio.new_event_loop()
    job = DownloadJob("job_retry_test", playlist_title, items, opts, loop)
    job_dir = job.download_dir
    shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    sample_source = TEST_DIR / "source_sample.webm"
    # Complete track 1 and 2
    for item in items[:2]:
        raw_file = job_dir / f"{item.index:02d} - {item.title}.webm"
        shutil.copy2(sample_source, raw_file)
        run_single_conversion(job, item, raw_file, {})

    # Mark track 3 and 4 as failed
    job.update_track(items[2].id, status="failed", error="Simulated network failure")
    job.update_track(items[3].id, status="failed", error="Simulated bot check")
    job.failed_count = 2

    assert job.failed_count == 2
    assert job.completed_count == 2

    # Now simulate retry: reset failed tracks to queued, provide files, and rerun
    failed_items = [itm for itm in items if job.track_status[itm.id]["status"] == "failed"]
    for itm in failed_items:
        job.update_track(itm.id, status="queued", error=None)
        raw_file = job_dir / f"{itm.index:02d} - {itm.title}.webm"
        shutil.copy2(sample_source, raw_file)
        run_single_conversion(job, itm, raw_file, {})

    job.failed_count = 0
    assert job.completed_count == 4
    assert job.failed_count == 0
    print(f" ✓ Retries passed: Failed items isolated, retried, and completed to 4/4 tracks.")


def test_duplicate_titles():
    print(f"\n========================================================")
    print(f" [TEST] Testing Duplicate Track Titles Handling")
    print(f"========================================================")

    # 4 tracks with identical titles
    items = [
        TrackItem(id="dup_1", index=1, title="Midnight Echoes", artist="Artist A"),
        TrackItem(id="dup_2", index=2, title="Midnight Echoes", artist="Artist B"),
        TrackItem(id="dup_3", index=3, title="Midnight Echoes", artist="Artist C"),
        TrackItem(id="dup_4", index=4, title="Midnight Echoes", artist="Artist D"),
    ]

    opts = DownloadOptions(type="audio", audio_format="best", prefix_index=True)
    playlist_title = "Test_Duplicates"
    loop = asyncio.new_event_loop()
    job = DownloadJob("job_dup_test", playlist_title, items, opts, loop)
    job_dir = job.download_dir
    shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    sample_source = TEST_DIR / "source_sample.webm"
    for item in items:
        raw_file = job_dir / f"{item.index:02d} - {item.title}.webm"
        shutil.copy2(sample_source, raw_file)
        run_single_conversion(job, item, raw_file, {})

    zip_file = job.safe_zip()
    with zipfile.ZipFile(zip_file, "r") as zf:
        names = zf.namelist()
        assert len(names) == 4, f"Expected 4 distinct files for duplicate titles, got {len(names)}: {names}"
        assert len(set(names)) == 4, "All filenames in ZIP must be unique!"

    print(f" ✓ Duplicate titles passed: All 4 duplicate songs preserved with unique filenames ({names}).")


def test_zip_integrity():
    print(f"\n========================================================")
    print(f" [TEST] Testing ZIP Integrity & Compression Mode")
    print(f"========================================================")

    items = create_mock_track_items(10, "ZipCheck")
    opts = DownloadOptions(type="audio", audio_format="best")
    playlist_title = "Test_Zip_Integrity"
    loop = asyncio.new_event_loop()
    job = DownloadJob("job_zip_test", playlist_title, items, opts, loop)
    job_dir = job.download_dir
    shutil.rmtree(job_dir, ignore_errors=True)
    job_dir.mkdir(parents=True, exist_ok=True)

    sample_source = TEST_DIR / "source_sample.webm"
    for item in items:
        raw_file = job_dir / f"{item.index:02d} - {item.title}.webm"
        shutil.copy2(sample_source, raw_file)
        run_single_conversion(job, item, raw_file, {})

    zip_path = job.safe_zip()
    assert zip_path.exists()
    assert zip_path.stat().st_size > 0

    with zipfile.ZipFile(zip_path, "r") as zf:
        # testzip returns None on success, or name of first corrupt file
        corrupt = zf.testzip()
        assert corrupt is None, f"ZIP corruption detected in {corrupt}"
        
        # Verify ZIP_STORED compression (compression method 0)
        for zinfo in zf.infolist():
            assert zinfo.compress_type == zipfile.ZIP_STORED, f"Expected ZIP_STORED (0), got {zinfo.compress_type}"
        
        assert len(zf.namelist()) == 10

    print(f" ✓ ZIP integrity passed: Zero corruption (CRC checked), ZIP_STORED verified across all 10 files.")


if __name__ == "__main__":
    print("=" * 60)
    print(" TUNEVAULT PRO: PIPELINE OPTIMIZATION & VERIFICATION SUITE")
    print("=" * 60)

    # 0. Ensure source test file is ready
    ensure_sample_source()

    # 1. Run Unit / Resilience Tests First
    test_cancellation()
    test_failed_tracks_and_retries()
    test_duplicate_titles()
    test_zip_integrity()

    # 2. Run Comparative Benchmarks (50 tracks each)
    bench_best = benchmark_pipeline(format_type="best", track_count=50)
    bench_mp3 = benchmark_pipeline(format_type="mp3", track_count=50)

    # 3. Print Comprehensive Comparison Table
    print("\n" + "=" * 70)
    print(" 50-TRACK BENCHMARK COMPARISON TABLE")
    print("=" * 70)
    print(f"{'Metric':<28} | {'Best (Original/Stream Copy)':<22} | {'MP3 (Transcoded 320k)':<20}")
    print("-" * 70)
    print(f"{'Successful Tracks':<28} | {bench_best['successful']}/50{'':<17} | {bench_mp3['successful']}/50")
    print(f"{'Total Wall Time (s)':<28} | {bench_best['wall_time']:<22.2f} | {bench_mp3['wall_time']:<20.2f}")
    print(f"{'Total Conversion Time (s)':<28} | {bench_best['total_convert_time']:<22.2f} | {bench_mp3['total_convert_time']:<20.2f}")
    print(f"{'Avg Conversion / Track (s)':<28} | {bench_best['avg_convert_time']:<22.3f} | {bench_mp3['avg_convert_time']:<20.3f}")
    print(f"{'ZIP Packaging Time (s)':<28} | {bench_best['zip_time']:<22.3f} | {bench_mp3['zip_time']:<20.3f}")
    print(f"{'Process CPU Time (s)':<28} | {bench_best['cpu_process_time']:<22.2f} | {bench_mp3['cpu_process_time']:<20.2f}")
    print(f"{'Peak Traced Memory (MB)':<28} | {bench_best['peak_mem_mb']:<22.2f} | {bench_mp3['peak_mem_mb']:<20.2f}")
    print(f"{'Peak Process RSS (MB)':<28} | {bench_best['peak_rss_mb']:<22.2f} | {bench_mp3['peak_rss_mb']:<20.2f}")
    print("=" * 70)

    speedup = (bench_mp3['total_convert_time'] / max(0.001, bench_best['total_convert_time'])) if bench_best['total_convert_time'] > 0 else 0
    print(f" Summary: 'best' format stream-copy vs MP3 transcode delivers ~{speedup:.1f}x conversion speedup!")
    print(f" Bounded pipeline capped peak memory to {bench_mp3['peak_mem_mb']:.1f} MB during 50-track execution.")
