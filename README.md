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

4. **High-Speed Pipelined Download & Conversion**:
   - **Decoupled Pipeline Architecture**: Network downloads and CPU FFmpeg conversions run in independent worker pools.
   - Once a track finishes raw streaming over the network (1–2 seconds), it is immediately queued into a background CPU conversion pool, freeing the network worker instantly to begin downloading the next track without blocking.
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
├── app.py              # FastAPI server, yt-dlp job manager, SSE streamer
├── requirements.txt    # Python package dependencies (cross-platform)
├── deploy_gcp.sh       # One-command automated GCP / Linux VM installer & service runner
├── start.sh            # Fast startup script for Linux / Cloud VMs
├── Dockerfile          # Container build for GCP Cloud Run, Docker Compose, VPS
├── docker-compose.yml  # Local / Server Docker container orchestration
├── vercel.json         # Vercel deployment routing configuration
├── api/
│   └── index.py        # Vercel Serverless Function entry point
├── static/
│   ├── index.html      # Responsive single-page UI (dark glassmorphic theme)
│   ├── style.css       # Clean stylesheet with responsive layout
│   └── app.js          # Interactive frontend controller & SSE progress handler
└── downloads/          # Downloaded tracks & generated ZIP archives
```

---

## ☁️ Cross-Platform Deployment Guide

### 1. Google Cloud Platform (GCP Compute Engine / Linux VM)

We provide a zero-effort automated bash installer (`deploy_gcp.sh`) that installs Python, FFmpeg, Deno, creates the virtualenv, installs `requirements.txt`, and sets up an auto-restarting background `systemd` service:

1. SSH into your GCP VM instance.
2. Clone or upload this repository to the VM:
   ```bash
   git clone <repo-url>
   cd youtube_music_pl
   ```
3. Make the script executable and run:
   ```bash
   chmod +x deploy_gcp.sh
   ./deploy_gcp.sh
   ```
4. **GCP Firewall Rule**: Open port 8000 in GCP Console or via Cloud Shell:
   ```bash
   gcloud compute firewall-rules create allow-tunevault --allow tcp:8000 --target-tags=tunevault-server
   ```
5. Open `http://<YOUR_VM_EXTERNAL_IP>:8000` in your browser.

*To start or restart manually anytime on Linux/GCP without re-running the installer:*
```bash
chmod +x start.sh
./start.sh
```

---

### 2. Google Cloud Run (Serverless Container)

Deploy to Google Cloud Run with autoscaling and zero server maintenance:

```bash
# Set your GCP Project ID
gcloud config set project YOUR_PROJECT_ID

# Deploy directly from source using the included Dockerfile
gcloud run deploy tunevault \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 1Gi \
  --timeout 300
```

---

### 3. Docker & Docker Compose (Any Cloud / Local)

Run anywhere Docker is installed:

```bash
# Build and start in the background
docker compose up -d

# View logs
docker compose logs -f

# Access in browser
http://localhost:8000
```

---

### 4. Vercel Deployment

TuneVault includes `vercel.json` and `api/index.py` for deployment to Vercel:

1. Install the Vercel CLI:
   ```bash
   npm i -g vercel
   ```
2. Deploy:
   ```bash
   vercel
   ```
3. For production:
   ```bash
   vercel --prod
   ```

> **Note on Vercel Serverless Limits:** Vercel functions run in an ephemeral serverless environment with a `/tmp` folder and function execution limits (10s on Hobby, 60s on Pro). While preview metadata extraction works seamlessly on Vercel, downloading large multi-track playlists is ideally suited for **GCP Compute Engine**, **Google Cloud Run**, or **Docker** where FFmpeg can process long conversions without execution timeouts.

---

## 🛡️ Resolving YouTube "Sign in to confirm you're not a bot" on Cloud / Vercel

When running on shared cloud datacenter IP ranges (AWS `iad1` / Vercel / DigitalOcean), YouTube may flag requests with:
`ERROR: [youtube] Sign in to confirm you’re not a bot. This helps protect our community.`

### How We Handle This Automatically
1. **Mobile Client Emulation**: The app automatically queries YouTube using mobile API endpoints (`android` and `ios`), which do not enforce the same strict web bot checks.
2. **Automated Fallback**: If a track triggers a bot check, the downloader automatically retries with alternative mobile player streams.

### Providing Authentication Cookies (100% Guaranteed Bypass)
If YouTube requires cookies for specific songs (e.g. private or age-restricted content):
1. **Export YouTube Cookies**: Install a browser extension such as [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc) on Chrome/Firefox and export your YouTube cookies.
2. **On Vercel**: 
   - Go to your Vercel Project Dashboard ➔ **Settings** ➔ **Environment Variables**.
   - Add a new variable:
     - **Key**: `YOUTUBE_COOKIES`
     - **Value**: (Paste the entire contents of your exported `cookies.txt`)
   - Click Save and redeploy.
3. **On Local / GCP / Docker**:
   - Simply place the exported `cookies.txt` file in the project root directory.

---

## ⚖️ Legal Disclaimer

Music Playlist Downloader is strictly intended for personal, offline archiving of content you own, have created, or have explicit permission to download. Please respect intellectual property rights, creator licenses, and YouTube's Terms of Service.


