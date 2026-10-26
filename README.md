# 🎵 Music Playlist Downloader

A modern, high-fidelity local web application for Windows (Python 3.10+) that downloads YouTube Music and YouTube playlists, albums, and single tracks using `yt-dlp` and `FFmpeg`, and bundles everything into one clean, ready-to-stream ZIP file.

---

## ⚡ Quick Start (Windows)

### 1. Prerequisites (FFmpeg & Deno)
On Windows, install FFmpeg (for audio extraction & video merging) and Deno (JavaScript runtime for YouTube signature solving) using Windows Package Manager (`winget`):

```powershell
winget install Gyan.FFmpeg
winget install DenoLand.Deno
```

> **Note:** Music Playlist Downloader automatically detects FFmpeg and Deno in both your system PATH and standard WinGet directories (`%LOCALAPPDATA%\Microsoft\WinGet\Packages`). If either is missing, a warning banner will appear in the UI with copyable install commands.

### 2. Install Python Dependencies
```powershell
pip install -r requirements.txt
```

### 3. Run the App
```powershell
python app.py
```
Then open your browser at **[http://localhost:8000](http://localhost:8000)** (bound strictly to `127.0.0.1` for local privacy).

---

## 🚀 Step-by-Step User Flow

1. **Paste Link & Automatic Preview**:
   - Paste any `music.youtube.com` or `youtube.com` URL (playlist, album, or single song).
   - Link detection runs immediately on paste/input (stripping tracking parameters like `si=`).
   - Fast flat extraction fetches playlist artwork, title, creator, total tracks, and individual track info without heavy network requests.
   - Platform badge automatically indicates **YouTube Music** or **YouTube**.

2. **Choose What to Download**:
   - Checkbox next to each track with thumbnail, title, artist, and duration.
   - Bulk actions: **Select All**, **Deselect All**, and **Invert**.
   - Quick range selectors: **"First N"** (e.g. download first 10) and **"Range #5 to #15"**.
   - Real-time search/filter input to filter songs by title or artist.
   - Live counter shows: `e.g. 12 of 30 selected, ~48 MB est.`
   - Unavailable/private tracks are clearly marked and disabled with reason tooltips.

3. **Choose Options**:
   - **Type**: Audio Only or Video + Audio.
   - **Audio Formats**: `Best original (no re-encode)`, `MP3`, `M4A (AAC)`, `OPUS`, `FLAC`, `WAV`, `OGG`.
   - **Audio Bitrates**: `Best (default)`, `320 kbps`, `256 kbps`, `192 kbps`, `128 kbps`.
   - **Video Formats**: `MP4`, `WEBM`, `MKV` at up to `2160p (4K UHD)`.
   - **Smart Quality Rule**: YouTube Music sources max out at ~128–256 kbps Opus/AAC. Converting to FLAC/WAV or 320 kbps MP3 inflates file size without improving fidelity. *Best original* keeps the exact untouched source stream.
   - **Toggles**: Embed metadata, embed cover art, save standalone thumbnails, prefix playlist index (`01 - Title.mp3`), and skip already-downloaded files.
   - **Advanced Configuration**: Windows-safe filename templates, concurrency slider (1–5 simultaneous downloads), rate limiting, and optional browser cookie import (`Chrome`, `Edge`, `Firefox`) for private or age-restricted content.
   - All settings persist automatically across reloads using `localStorage`.

4. **Live Download & Monitoring**:
   - Click **Download Selected (N)** to launch the background job.
   - Real-time Server-Sent Events (SSE) stream overall progress and individual track progress (speed in MiB/s, percent, ETA, conversion stage).
   - Windows file lock errors (`WinError 32`) from antivirus scanners are retried automatically with exponential backoff.
   - If any track fails, remaining tracks continue uninterrupted, and a **"Retry Failed Tracks"** button is provided.
   - Dedicated **Cancel** button safely terminates active downloads and purges partial (`.part`/`.ytdl`) files.

5. **Download ZIP & Open Folder**:
   - When finished, backend packages files into `<playlist_title>.zip` using stored compression (fast, low CPU overhead since media files are already compressed).
   - Prominent **"Download ZIP (<size>)"** button streams the archive directly.
   - Click **"Open Folder in Explorer"** to reveal downloaded media files in Windows File Explorer.
   - Click **"Start New Playlist"** to reset and start another download.

---

## 🧪 Testing with the Sample Link

You can test the application with the sample playlist:
```
https://music.youtube.com/playlist?list=PLHfHCISsXPhw&si=tNMyWLmu1DjHBPuH
```

1. Open `http://localhost:8000`.
2. Paste the URL into the input field.
3. The preview will automatically extract the playlist **"krues"** with 4 tracks:
   - *1. Thinking of You*
   - *2. By My Side*
   - *3. Khat*
   - *4. Arz Kiya Hai | Coke Studio Bharat*
4. Select desired tracks, choose format (e.g. *Best original* or *MP3*), and click **Download Selected**.
5. Once complete, click **Download ZIP** or **Open Folder in Explorer**.

---

## 📁 Project Structure

```
youtube_music_pl/
├── app.py              # FastAPI server, yt-dlp job manager, SSE streamer, WinGet discovery
├── requirements.txt    # Python package dependencies
├── README.md           # Documentation & Windows setup guide
├── .gitignore          # Git exclusion rules (venv, downloads, temp, zips)
└── static/
    ├── index.html      # Responsive single-page UI (no build step needed)
    ├── style.css       # Premium dark glassmorphism stylesheet
    └── app.js          # Interactive frontend controller & SSE progress handler
```

---

## ⚖️ Legal Disclaimer

Music Playlist Downloader is strictly intended for personal, offline archiving of content you own, have created, or have explicit permission to download. Please respect intellectual property rights, creator licenses, and YouTube's Terms of Service.
