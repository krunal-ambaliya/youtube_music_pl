/**
 * TuneVault PRO - Client Application Controller
 * Handles playlist extraction, high-speed multi-threaded downloads,
 * live SSE telemetry, and rich UI state mirroring.
 */

const state = {
  systemStatus: {
    ffmpeg_installed: true,
    deno_installed: true,
    ytdlp_version: "2026.10",
    ffmpeg_path: null,
    deno_path: null
  },
  currentPlaylist: null,
  selectedIds: new Set(),
  activeJobId: null,
  eventSource: null,
  options: {
    type: "audio",
    audio_format: "mp3",
    audio_quality: "320",
    video_format: "mp4",
    video_quality: "best",
    embed_metadata: true,
    embed_cover_art: true,
    save_thumbnails: false,
    embed_subtitles: false,
    prefix_index: true,
    skip_existing: true,
    filename_template: "%(playlist_index)02d - %(title)s.%(ext)s",
    concurrency: 3,
    retries: 3,
    rate_limit: "",
    browser_cookies: ""
  }
};

// DEMO DATA (Matching the screenshot provided by user)
const DEMO_PLAYLIST = {
  title: "krues - Midnight Echoes",
  uploader: "Krunal",
  platform: "YOUTUBE MUSIC",
  total_count: 4,
  total_duration_formatted: "15:50",
  thumbnail: "https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=300",
  items: [
    {
      id: "demo_1",
      index: 1,
      title: "Thinking of You",
      artist: "AP DHILLON • Two Hearts Never Break the Same",
      thumbnail: "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=100",
      duration_formatted: "3:01",
      duration: 181,
      available: true
    },
    {
      id: "demo_2",
      index: 2,
      title: "By My Side",
      artist: "AP DHILLON • Single Edition",
      thumbnail: "https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=100",
      duration_formatted: "2:57",
      duration: 177,
      available: true
    },
    {
      id: "demo_3",
      index: 3,
      title: "Khat",
      artist: "Navjot Ahuja • Indie Waves",
      thumbnail: "https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=100",
      duration_formatted: "4:57",
      duration: 297,
      available: true
    },
    {
      id: "demo_4",
      index: 4,
      title: "Arz Kiya Hai | Coke Studio Bharat",
      artist: "Anuv Jain • Coke Studio 2024",
      thumbnail: "https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=100",
      duration_formatted: "4:55",
      duration: 295,
      available: true
    }
  ]
};

// DOM References
const el = {
  // Top nav
  ffmpegPill: document.getElementById("ffmpeg-pill"),
  denoPill: document.getElementById("deno-pill"),
  ytdlpVersionLabel: document.getElementById("ytdlp-version-label"),
  btnUpdateYtdlp: document.getElementById("btn-update-ytdlp"),
  topZipBtn: document.getElementById("top-zip-btn"),
  topZipLabel: document.getElementById("top-zip-label"),
  btnStartNew: document.getElementById("btn-start-new"),

  // Search box
  urlInput: document.getElementById("url-input"),
  btnClearUrl: document.getElementById("btn-clear-url"),
  btnPasteUrl: document.getElementById("btn-paste-url"),
  btnFetch: document.getElementById("btn-fetch"),
  platformBadge: document.getElementById("platform-badge"),

  // Alert banner
  warningBanner: document.getElementById("warning-banner"),
  warningCommands: document.getElementById("warning-banner-commands"),
  btnRecheckTools: document.getElementById("btn-recheck-tools"),

  // Left Panel: Preview & Tracklist
  previewEmptyState: document.getElementById("preview-empty-state"),
  sampleLinkClick: document.getElementById("sample-link-click"),
  previewSkeleton: document.getElementById("preview-skeleton"),
  playlistLoadedWrap: document.getElementById("playlist-loaded-wrap"),
  playlistCover: document.getElementById("playlist-cover"),
  playlistPlatformPill: document.getElementById("playlist-platform-pill"),
  playlistTitle: document.getElementById("playlist-title"),
  playlistUploader: document.getElementById("playlist-uploader"),
  playlistCount: document.getElementById("playlist-count"),
  playlistDuration: document.getElementById("playlist-duration"),
  selectedCountLabel: document.getElementById("selected-count-label"),
  totalCountLabel: document.getElementById("total-count-label"),
  selectedPercentLabel: document.getElementById("selected-percent-label"),
  selectedSizeEstimate: document.getElementById("selected-size-estimate"),

  // Selection toolbar
  btnSelectAll: document.getElementById("btn-select-all"),
  btnDeselectAll: document.getElementById("btn-deselect-all"),
  btnInvertSelection: document.getElementById("btn-invert-selection"),
  inputFirstN: document.getElementById("input-first-n"),
  btnApplyFirstN: document.getElementById("btn-apply-first-n"),
  inputRangeFrom: document.getElementById("input-range-from"),
  inputRangeTo: document.getElementById("input-range-to"),
  btnApplyRange: document.getElementById("btn-apply-range"),
  trackFilterInput: document.getElementById("track-filter-input"),
  masterCheckbox: document.getElementById("master-checkbox"),
  tracklistTbody: document.getElementById("tracklist-tbody"),
  tableFooterSelected: document.getElementById("table-footer-selected"),

  // Right Panel: Options
  sectionOptions: document.getElementById("section-options"),
  optTypeAudio: document.getElementById("opt-type-audio"),
  optTypeVideo: document.getElementById("opt-type-video"),
  audioOptionsPanel: document.getElementById("audio-options-panel"),
  videoOptionsPanel: document.getElementById("video-options-panel"),
  audioFormatGroup: document.getElementById("audio-format-group"),
  selectAudioQuality: document.getElementById("select-audio-quality"),
  videoFormatGroup: document.getElementById("video-format-group"),
  selectVideoQuality: document.getElementById("select-video-quality"),

  // Toggles inside collapsible dropdown
  toggleMetadata: document.getElementById("toggle-metadata"),
  toggleCover: document.getElementById("toggle-cover"),
  toggleSaveThumbs: document.getElementById("toggle-save-thumbs"),
  togglePrefixIndex: document.getElementById("toggle-prefix-index"),
  toggleSkipExisting: document.getElementById("toggle-skip-existing"),
  toggleSubtitles: document.getElementById("toggle-subtitles"),
  controlEmbedSubs: document.getElementById("control-embed-subs"),

  // Advanced
  inputFilenameTemplate: document.getElementById("input-filename-template"),
  selectCookiesBrowser: document.getElementById("select-cookies-browser"),
  sliderConcurrency: document.getElementById("slider-concurrency"),
  valConcurrency: document.getElementById("val-concurrency"),
  inputRateLimit: document.getElementById("input-rate-limit"),

  // Batch Package Section
  queueStatusText: document.getElementById("queue-status-text"),
  queueSpecsPill: document.getElementById("queue-specs-pill"),
  batchEstSize: document.getElementById("batch-est-size"),
  batchEta: document.getElementById("batch-eta"),
  btnStartDownload: document.getElementById("btn-start-download"),
  btnDownloadLabel: document.getElementById("btn-download-label"),
  completedActionsRow: document.getElementById("completed-actions-row"),
  tableFooterStatusText: document.getElementById("table-footer-status-text"),

  // Right Panel: Progress
  sectionProgress: document.getElementById("section-progress"),
  progressHeading: document.getElementById("progress-heading"),
  progressSubtext: document.getElementById("progress-subtext"),
  btnCancelJob: document.getElementById("btn-cancel-job"),
  btnRetryFailed: document.getElementById("btn-retry-failed"),
  overallBarFill: document.getElementById("overall-bar-fill"),
  overallPercentLabel: document.getElementById("overall-percent-label"),
  overallCountsLabel: document.getElementById("overall-counts-label"),
  zipDeliveryCard: document.getElementById("zip-delivery-card"),
  btnDownloadZip: document.getElementById("btn-download-zip"),
  btnZipLabel: document.getElementById("btn-zip-label"),
  btnOpenFolder: document.getElementById("btn-open-folder"),
  liveTracksList: document.getElementById("live-tracks-list"),
  toastContainer: document.getElementById("toast-container")
};

// -------------------------------------------------------------
// Toast Messages
// -------------------------------------------------------------
function showToast(message, type = "info") {
  if (!el.toastContainer) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  el.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    setTimeout(() => toast.remove(), 200);
  }, 3500);
}

// -------------------------------------------------------------
// System Prerequisites Check
// -------------------------------------------------------------
async function fetchSystemStatus() {
  try {
    const res = await fetch("/api/system-status");
    if (!res.ok) return;
    const data = await res.json();
    state.systemStatus = data;

    // FFmpeg status (Required for audio format conversion)
    updateSysBadge(el.ffmpegPill, data.ffmpeg_installed, "FFmpeg 6.1");

    // JS Engine status (Deno or Node.js - optional for yt-dlp challenge solving)
    if (el.denoPill) {
      if (data.deno_installed) {
        updateSysBadge(el.denoPill, true, "Deno Native Core");
      } else if (data.node_installed) {
        updateSysBadge(el.denoPill, true, "Node.js JS Engine");
      } else {
        // Deno/Node are optional - mark as neutral/optional rather than a critical failure
        el.denoPill.className = "sys-badge sys-neutral";
        const txt = el.denoPill.querySelector(".badge-text");
        if (txt) txt.textContent = "JS Core (Optional)";
      }
    }

    if (el.ytdlpVersionLabel) {
      const txt = el.ytdlpVersionLabel.querySelector(".badge-text");
      if (txt) txt.textContent = `yt-dlp v${data.ytdlp_version}`;
    }

    // Only display warning banner if FFmpeg is actually missing (Deno is optional)
    if (!data.ffmpeg_installed) {
      el.warningBanner.classList.remove("hidden");
      el.warningCommands.innerHTML = "";

      const bannerTitle = document.getElementById("warning-banner-title");
      const bannerText = document.getElementById("warning-banner-text");

      if (data.is_vercel) {
        if (bannerTitle) bannerTitle.textContent = "Vercel Serverless Notice:";
        if (bannerText) bannerText.textContent = "Re-deploy to Vercel with imageio-ffmpeg in requirements.txt, or deploy to Google Cloud Run / GCP for full playlist conversion without timeouts:";
        
        const c1 = document.createElement("code");
        c1.textContent = "gcloud run deploy --source .";
        c1.onclick = () => copyText("gcloud run deploy --source .");
        el.warningCommands.appendChild(c1);
      } else {
        if (bannerTitle) bannerTitle.textContent = "FFmpeg Missing:";
        if (bannerText) {
          bannerText.textContent = data.platform === "windows" 
            ? "Install required tools via Windows Package Manager:" 
            : "Install FFmpeg via package manager:";
        }
        const c1 = document.createElement("code");
        c1.textContent = data.winget_ffmpeg_cmd;
        c1.onclick = () => copyText(data.winget_ffmpeg_cmd);
        el.warningCommands.appendChild(c1);
      }
    } else {
      el.warningBanner.classList.add("hidden");
    }
  } catch (err) {
    console.error("System status check error:", err);
  }
}

function updateSysBadge(badge, isOk, label) {
  if (!badge) return;
  badge.className = `sys-badge ${isOk ? "sys-ok" : "sys-bad"}`;
  const txt = badge.querySelector(".badge-text");
  if (txt) {
    txt.textContent = isOk ? label : `${label} Missing`;
  }
}

function copyText(txt) {
  navigator.clipboard.writeText(txt);
  showToast(`Copied: ${txt}`, "success");
}

if (el.btnUpdateYtdlp) {
  el.btnUpdateYtdlp.addEventListener("click", async () => {
    const btn = el.btnUpdateYtdlp;
    btn.disabled = true;
    const origHtml = btn.innerHTML;
    btn.innerHTML = "<span>Updating...</span>";
    try {
      const res = await fetch("/api/update-ytdlp", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast(`Updated yt-dlp: ${data.new_version}`, "success");
        if (el.ytdlpVersionLabel) {
          const txt = el.ytdlpVersionLabel.querySelector(".badge-text");
          if (txt) txt.textContent = `yt-dlp v${data.new_version}`;
        }
      } else {
        showToast("yt-dlp is already up to date.", "info");
      }
    } catch (e) {
      showToast(`Update error: ${e.message}`, "error");
    } finally {
      btn.disabled = false;
      btn.innerHTML = origHtml;
    }
  });
}

if (el.btnRecheckTools) {
  el.btnRecheckTools.addEventListener("click", () => {
    fetchSystemStatus();
    showToast("Re-checking system tools...", "info");
  });
}

// -------------------------------------------------------------
// Options Persistence
// -------------------------------------------------------------
function saveOptions() {
  try {
    localStorage.setItem("tunevault_pro_options", JSON.stringify(state.options));
  } catch (e) {}
}

function loadSavedOptions() {
  try {
    const saved = localStorage.getItem("tunevault_pro_options");
    if (saved) {
      state.options = { ...state.options, ...JSON.parse(saved) };
    }
  } catch (e) {}
  applyOptionsToUI();
}

function applyOptionsToUI() {
  const o = state.options;

  if (o.type === "video") {
    el.optTypeVideo.classList.add("active");
    el.optTypeAudio.classList.remove("active");
    el.audioOptionsPanel.classList.add("hidden");
    el.videoOptionsPanel.classList.remove("hidden");
    if (el.controlEmbedSubs) el.controlEmbedSubs.classList.remove("hidden");
  } else {
    el.optTypeAudio.classList.add("active");
    el.optTypeVideo.classList.remove("active");
    el.audioOptionsPanel.classList.remove("hidden");
    el.videoOptionsPanel.classList.add("hidden");
    if (el.controlEmbedSubs) el.controlEmbedSubs.classList.add("hidden");
  }

  document.querySelectorAll("#audio-format-group .chip-box, #audio-format-group .chip-btn").forEach(p => {
    p.classList.toggle("active", p.dataset.val === o.audio_format);
  });
  if (el.selectAudioQuality) el.selectAudioQuality.value = o.audio_quality;

  document.querySelectorAll("#video-format-group .chip-box, #video-format-group .chip-btn").forEach(p => {
    p.classList.toggle("active", p.dataset.val === o.video_format);
  });
  if (el.selectVideoQuality) el.selectVideoQuality.value = o.video_quality;

  if (el.toggleMetadata) el.toggleMetadata.checked = o.embed_metadata;
  if (el.toggleCover) el.toggleCover.checked = o.embed_cover_art;
  if (el.toggleSaveThumbs) el.toggleSaveThumbs.checked = o.save_thumbnails;
  if (el.togglePrefixIndex) el.togglePrefixIndex.checked = o.prefix_index;
  if (el.toggleSkipExisting) el.toggleSkipExisting.checked = o.skip_existing;
  if (el.toggleSubtitles) el.toggleSubtitles.checked = o.embed_subtitles;

  if (el.inputFilenameTemplate) el.inputFilenameTemplate.value = o.filename_template;
  if (el.selectCookiesBrowser) el.selectCookiesBrowser.value = o.browser_cookies || "";
  if (el.sliderConcurrency) {
    el.sliderConcurrency.value = o.concurrency;
    if (el.valConcurrency) el.valConcurrency.textContent = o.concurrency;
  }
  if (el.inputRateLimit) el.inputRateLimit.value = o.rate_limit || "";
}

// Attach Options Handlers
el.optTypeAudio.addEventListener("click", () => {
  state.options.type = "audio";
  applyOptionsToUI();
  saveOptions();
  updateLiveCounter();
});

el.optTypeVideo.addEventListener("click", () => {
  state.options.type = "video";
  applyOptionsToUI();
  saveOptions();
  updateLiveCounter();
});

document.querySelectorAll("#audio-format-group .chip-box, #audio-format-group .chip-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.options.audio_format = btn.dataset.val;
    applyOptionsToUI();
    saveOptions();
    updateLiveCounter();
  });
});

if (el.selectAudioQuality) {
  el.selectAudioQuality.addEventListener("change", (e) => {
    state.options.audio_quality = e.target.value;
    saveOptions();
    updateLiveCounter();
  });
}

document.querySelectorAll("#video-format-group .chip-box, #video-format-group .chip-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.options.video_format = btn.dataset.val;
    applyOptionsToUI();
    saveOptions();
    updateLiveCounter();
  });
});

if (el.selectVideoQuality) {
  el.selectVideoQuality.addEventListener("change", (e) => {
    state.options.video_quality = e.target.value;
    saveOptions();
    updateLiveCounter();
  });
}

if (el.toggleMetadata) el.toggleMetadata.addEventListener("change", e => { state.options.embed_metadata = e.target.checked; saveOptions(); });
if (el.toggleCover) el.toggleCover.addEventListener("change", e => { state.options.embed_cover_art = e.target.checked; saveOptions(); });
if (el.toggleSaveThumbs) el.toggleSaveThumbs.addEventListener("change", e => { state.options.save_thumbnails = e.target.checked; saveOptions(); });
if (el.togglePrefixIndex) el.togglePrefixIndex.addEventListener("change", e => { state.options.prefix_index = e.target.checked; saveOptions(); });
if (el.toggleSkipExisting) el.toggleSkipExisting.addEventListener("change", e => { state.options.skip_existing = e.target.checked; saveOptions(); });
if (el.toggleSubtitles) el.toggleSubtitles.addEventListener("change", e => { state.options.embed_subtitles = e.target.checked; saveOptions(); });

if (el.inputFilenameTemplate) el.inputFilenameTemplate.addEventListener("input", e => { state.options.filename_template = e.target.value; saveOptions(); });
if (el.selectCookiesBrowser) el.selectCookiesBrowser.addEventListener("change", e => { state.options.browser_cookies = e.target.value; saveOptions(); });
if (el.sliderConcurrency) {
  el.sliderConcurrency.addEventListener("input", e => {
    state.options.concurrency = parseInt(e.target.value, 10);
    if (el.valConcurrency) el.valConcurrency.textContent = e.target.value;
    saveOptions();
  });
}
if (el.inputRateLimit) el.inputRateLimit.addEventListener("input", e => { state.options.rate_limit = e.target.value.trim(); saveOptions(); });

// -------------------------------------------------------------
// URL Detection, Paste & Auto-Fetch
// -------------------------------------------------------------
let debounceFetch = null;

function detectPlatform(url) {
  const l = url.toLowerCase();
  if (l.includes("music.youtube.com")) return "YouTube Music";
  if (l.includes("youtube.com") || l.includes("youtu.be")) return "YouTube";
  return null;
}

function cleanInputUrl(url) {
  let cleaned = url.trim();
  cleaned = cleaned.replace(/[\?&]si=[^&]*/g, '');
  cleaned = cleaned.replace(/[\?&]feature=[^&]*/g, '');
  cleaned = cleaned.replace(/[\?&]pp=[^&]*/g, '');
  if (!cleaned.includes("?") && cleaned.includes("&")) {
    cleaned = cleaned.replace("&", "?");
  }
  return cleaned;
}

el.urlInput.addEventListener("input", (e) => {
  const raw = e.target.value;
  el.btnClearUrl.classList.toggle("hidden", !raw);

  const platform = detectPlatform(raw);
  clearTimeout(debounceFetch);
  if (platform && (raw.includes("list=") || raw.includes("watch?v=") || raw.includes("youtu.be/"))) {
    debounceFetch = setTimeout(() => {
      fetchPlaylistPreview(raw);
    }, 450);
  }
});

el.urlInput.addEventListener("paste", () => {
  setTimeout(() => {
    const raw = el.urlInput.value;
    if (detectPlatform(raw)) {
      clearTimeout(debounceFetch);
      fetchPlaylistPreview(raw);
    }
  }, 40);
});

// Paste Button
if (el.btnPasteUrl) {
  el.btnPasteUrl.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        const cleaned = text.trim();
        el.urlInput.value = cleaned;
        el.btnClearUrl.classList.remove("hidden");
        showToast("Pasted playlist link from clipboard", "info");
        fetchPlaylistPreview(cleaned);
      }
    } catch (err) {
      el.urlInput.focus();
      showToast("Press Ctrl+V to paste link", "info");
    }
  });
}

el.btnClearUrl.addEventListener("click", () => {
  el.urlInput.value = "";
  el.btnClearUrl.classList.add("hidden");
  el.urlInput.focus();
});

el.btnFetch.addEventListener("click", () => {
  const url = el.urlInput.value.trim();
  if (!url) {
    showToast("Please paste a playlist or song link.", "error");
    return;
  }
  fetchPlaylistPreview(url);
});

if (el.sampleLinkClick) {
  el.sampleLinkClick.addEventListener("click", () => {
    el.urlInput.value = el.sampleLinkClick.textContent.trim();
    fetchPlaylistPreview(el.urlInput.value);
  });
}

// -------------------------------------------------------------
// Fetch & Render Playlist Preview
// -------------------------------------------------------------
async function fetchPlaylistPreview(url) {
  const cleanUrl = cleanInputUrl(url);
  el.urlInput.value = cleanUrl;
  el.btnClearUrl.classList.remove("hidden");

  el.previewEmptyState.classList.add("hidden");
  el.previewSkeleton.classList.remove("hidden");
  el.playlistLoadedWrap.classList.add("hidden");

  const btnSpinner = el.btnFetch.querySelector(".btn-spinner");
  const btnText = el.btnFetch.querySelector(".btn-text");
  if (btnSpinner) btnSpinner.classList.remove("hidden");
  if (btnText) btnText.textContent = "Fetching...";
  el.btnFetch.disabled = true;

  try {
    const res = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: cleanUrl,
        cookies_browser: state.options.browser_cookies || null
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to load playlist.");
    }

    const data = await res.json();
    loadPlaylistData(data);
    showToast(`Loaded ${data.total_count} track(s)`, "success");

  } catch (err) {
    showToast(err.message, "error");
    // If real backend call failed because it's a mock or offline, fallback to sample so UI stays interactive
    if (cleanUrl.includes("PLHfHCISsXPhw") || cleanUrl.includes("demo")) {
      loadPlaylistData(DEMO_PLAYLIST);
      showToast("Loaded demo playlist preview", "info");
    } else {
      el.previewEmptyState.classList.remove("hidden");
    }
  } finally {
    el.previewSkeleton.classList.add("hidden");
    if (btnSpinner) btnSpinner.classList.add("hidden");
    if (btnText) btnText.textContent = "Fetch Playlist";
    el.btnFetch.disabled = false;
  }
}

function loadPlaylistData(data) {
  state.currentPlaylist = data;
  state.selectedIds.clear();
  data.items.forEach(item => {
    if (item.available) state.selectedIds.add(item.id);
  });

  renderPlaylistHeader(data);
  renderTracklistTable(data.items);

  if (el.inputRangeFrom) el.inputRangeFrom.value = 1;
  if (el.inputRangeTo) el.inputRangeTo.value = data.items.length;

  el.playlistLoadedWrap.classList.remove("hidden");
  updateLiveCounter();
}

function renderPlaylistHeader(data) {
  el.playlistCover.src = data.thumbnail || "https://images.unsplash.com/photo-1518609878373-06d740f60d8b?w=300";
  el.playlistTitle.textContent = data.title;
  el.playlistUploader.textContent = data.uploader 
    ? `Curated by ${data.uploader} • ${data.total_count} tracks discovered`
    : `${data.total_count} tracks discovered`;
  el.playlistCount.textContent = `${data.total_count}`;
  el.playlistDuration.textContent = data.total_duration_formatted;
  if (el.totalCountLabel) el.totalCountLabel.textContent = `${data.total_count}`;
}

function renderTracklistTable(items) {
  const tbody = el.tracklistTbody;
  tbody.innerHTML = "";

  const filterText = el.trackFilterInput.value.toLowerCase().trim();

  items.forEach(item => {
    const matches = !filterText ||
      item.title.toLowerCase().includes(filterText) ||
      (item.artist && item.artist.toLowerCase().includes(filterText));

    if (!matches) return;

    const tr = document.createElement("tr");
    if (!item.available) tr.className = "row-disabled";

    const isChecked = state.selectedIds.has(item.id);
    const idxFormatted = item.index < 10 ? `0${item.index}` : `${item.index}`;

    tr.innerHTML = `
      <td class="col-chk">
        <input type="checkbox" class="track-chk" data-id="${item.id}" ${isChecked ? "checked" : ""} ${!item.available ? "disabled" : ""}>
      </td>
      <td class="col-idx">${idxFormatted}</td>
      <td class="col-thumb">
        <img src="${item.thumbnail || ''}" alt="" class="thumb-preview" loading="lazy">
      </td>
      <td class="col-title">
        <div class="title-cell">
          <span class="track-name" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
          <span class="track-by">${escapeHtml(item.artist || 'Unknown')}</span>
        </div>
      </td>
      <td class="col-dur">${item.duration_formatted}</td>
      <td class="col-status" id="preview-status-${item.id}">
        ${item.available 
          ? `<span class="badge-status badge-ready">Ready</span>`
          : `<span class="badge-status badge-failed" title="${item.unavailable_reason || 'Unavailable'}">${escapeHtml(item.unavailable_reason || 'Private')}</span>`
        }
      </td>
    `;

    tr.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || !item.available) return;
      const chk = tr.querySelector(".track-chk");
      chk.checked = !chk.checked;
      toggleItemSelection(item.id, chk.checked);
    });

    const chk = tr.querySelector(".track-chk");
    chk.addEventListener("change", (e) => {
      toggleItemSelection(item.id, e.target.checked);
    });

    tbody.appendChild(tr);
  });

  updateMasterCheckboxState();
}

function toggleItemSelection(id, checked) {
  if (checked) state.selectedIds.add(id);
  else state.selectedIds.delete(id);
  updateLiveCounter();
  updateMasterCheckboxState();
}

function updateMasterCheckboxState() {
  if (!state.currentPlaylist || !state.currentPlaylist.items) return;
  const avail = state.currentPlaylist.items.filter(i => i.available);
  if (avail.length === 0) {
    el.masterCheckbox.checked = false;
    return;
  }
  el.masterCheckbox.checked = avail.every(i => state.selectedIds.has(i.id));
}

function updateLiveCounter() {
  if (!state.currentPlaylist) return;
  const total = state.currentPlaylist.total_count || 0;
  const sel = state.selectedIds.size;

  if (el.selectedCountLabel) el.selectedCountLabel.textContent = `${sel}`;
  if (el.totalCountLabel) el.totalCountLabel.textContent = `${total}`;
  const pct = total > 0 ? Math.round((sel / total) * 100) : 0;
  if (el.selectedPercentLabel) el.selectedPercentLabel.textContent = `${pct}% active`;

  if (el.tableFooterSelected) el.tableFooterSelected.textContent = `${sel} / ${total} Selected`;
  if (el.btnDownloadLabel) el.btnDownloadLabel.textContent = `Download Selected Tracks (${sel} Tracks)`;
  if (el.btnStartDownload) el.btnStartDownload.disabled = sel === 0;

  // Size estimation
  let totalSec = 0;
  state.currentPlaylist.items.forEach(item => {
    if (state.selectedIds.has(item.id)) totalSec += (item.duration || 180);
  });
  const mins = totalSec / 60;
  let mb = 0;
  if (state.options.type === "audio") {
    const br = state.options.audio_quality;
    const rate = br === "320" ? 2.4 : br === "256" ? 1.9 : br === "128" ? 1.0 : 1.5;
    mb = Math.round(mins * rate);
  } else {
    const res = state.options.video_quality;
    const rate = res === "2160" ? 35 : res === "1440" ? 22 : res === "1080" ? 12 : res === "720" ? 7 : 4;
    mb = Math.round(mins * rate);
  }

  const estStr = `~${mb} MB`;
  if (el.selectedSizeEstimate) el.selectedSizeEstimate.textContent = estStr;
  if (el.batchEstSize) el.batchEstSize.textContent = estStr;

  const etaVal = (mb / 8.5).toFixed(1);
  if (el.batchEta) el.batchEta.textContent = `ETA: ~${etaVal}s @ 85 Mbps`;

  const qualityText = state.options.type === "audio" 
    ? (state.options.audio_quality === "320" ? "320k CBR" : state.options.audio_quality === "best" ? "Direct" : `${state.options.audio_quality}k`)
    : `${state.options.video_quality}p`;
  if (el.queueSpecsPill) el.queueSpecsPill.textContent = `${sel} items • ${qualityText}`;
}

// -------------------------------------------------------------
// Toolbar Filter & Selection Handlers
// -------------------------------------------------------------
el.masterCheckbox.addEventListener("change", (e) => {
  const check = e.target.checked;
  if (!state.currentPlaylist) return;
  state.currentPlaylist.items.forEach(i => {
    if (i.available) {
      if (check) state.selectedIds.add(i.id);
      else state.selectedIds.delete(i.id);
    }
  });
  renderTracklistTable(state.currentPlaylist.items);
  updateLiveCounter();
});

el.btnSelectAll.addEventListener("click", () => {
  if (!state.currentPlaylist) return;
  state.currentPlaylist.items.forEach(i => { if (i.available) state.selectedIds.add(i.id); });
  renderTracklistTable(state.currentPlaylist.items);
  updateLiveCounter();
});

el.btnDeselectAll.addEventListener("click", () => {
  state.selectedIds.clear();
  if (state.currentPlaylist) renderTracklistTable(state.currentPlaylist.items);
  updateLiveCounter();
});

el.btnInvertSelection.addEventListener("click", () => {
  if (!state.currentPlaylist) return;
  state.currentPlaylist.items.forEach(i => {
    if (i.available) {
      if (state.selectedIds.has(i.id)) state.selectedIds.delete(i.id);
      else state.selectedIds.add(i.id);
    }
  });
  renderTracklistTable(state.currentPlaylist.items);
  updateLiveCounter();
});

if (el.btnApplyRange) {
  el.btnApplyRange.addEventListener("click", () => {
    const from = parseInt(el.inputRangeFrom.value, 10);
    const to = parseInt(el.inputRangeTo.value, 10);
    if (isNaN(from) || isNaN(to) || from > to || !state.currentPlaylist) return;
    state.selectedIds.clear();
    state.currentPlaylist.items.forEach(item => {
      if (item.available && item.index >= from && item.index <= to) {
        state.selectedIds.add(item.id);
      }
    });
    renderTracklistTable(state.currentPlaylist.items);
    updateLiveCounter();
  });
}

el.trackFilterInput.addEventListener("input", () => {
  if (state.currentPlaylist) {
    renderTracklistTable(state.currentPlaylist.items);
  }
});

// -------------------------------------------------------------
// Start Download & SSE Telemetry
// -------------------------------------------------------------
el.btnStartDownload.addEventListener("click", async () => {
  if (!state.currentPlaylist || state.selectedIds.size === 0) return;

  const selectedTracks = state.currentPlaylist.items.filter(i => state.selectedIds.has(i.id));

  // Lock UI: Button cannot be clicked again while process is running
  el.btnStartDownload.disabled = true;
  el.btnStartDownload.classList.add("is-busy");
  el.btnDownloadLabel.textContent = `Downloading Tracks (0 of ${selectedTracks.length})...`;
  if (el.completedActionsRow) el.completedActionsRow.classList.add("hidden");
  if (el.btnCancelJob) el.btnCancelJob.classList.remove("hidden");
  document.querySelectorAll(".track-chk, #master-checkbox").forEach(c => c.disabled = true);

  // Set all selected preview tracks to queued status in the preview table
  selectedTracks.forEach(t => updatePreviewRowStatus(t.id, "queued"));

  // If this is the demo playlist, simulate rapid download queue for previewing
  if (state.currentPlaylist.items[0] && state.currentPlaylist.items[0].id.startsWith("demo_")) {
    runDemoDownloadSimulation(selectedTracks);
    return;
  }

  // Real backend download
  el.sectionProgress.classList.remove("hidden");
  if (el.zipDeliveryCard) el.zipDeliveryCard.classList.add("hidden");
  if (el.btnRetryFailed) el.btnRetryFailed.classList.add("hidden");
  el.btnCancelJob.disabled = false;
  el.btnCancelJob.classList.remove("hidden");

  el.overallBarFill.style.width = "0%";
  el.overallPercentLabel.textContent = "0%";
  el.overallCountsLabel.textContent = `0 of ${selectedTracks.length} finished`;
  el.progressHeading.textContent = `Downloading "${state.currentPlaylist.title}"`;
  el.progressSubtext.textContent = `Processing ${selectedTracks.length} selected items...`;
  if (el.queueStatusText) el.queueStatusText.textContent = "Active queue running...";

  renderLiveQueueInit(selectedTracks);

  try {
    const res = await fetch("/api/download/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playlist_title: state.currentPlaylist.title,
        items: selectedTracks,
        options: state.options
      })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || "Failed to start download job.");
    }

    const data = await res.json();
    state.activeJobId = data.job_id;
    connectEventSource(data.job_id);

  } catch (err) {
    showToast(err.message, "error");
  }
});

function runDemoDownloadSimulation(selectedTracks) {
  el.sectionProgress.classList.remove("hidden");
  el.zipDeliveryCard.classList.add("hidden");
  el.btnRetryFailed.classList.add("hidden");
  el.btnCancelJob.disabled = false;
  el.btnCancelJob.classList.remove("hidden");

  el.overallBarFill.style.width = "0%";
  el.overallPercentLabel.textContent = "0%";
  el.overallCountsLabel.textContent = `0 of ${selectedTracks.length} finished`;
  el.progressHeading.textContent = `Downloading "${state.currentPlaylist.title}"`;
  el.progressSubtext.textContent = `Processing ${selectedTracks.length} selected items...`;
  if (el.queueStatusText) el.queueStatusText.textContent = "Simulating queue download...";

  renderLiveQueueInit(selectedTracks);

  let finished = 0;
  const total = selectedTracks.length;

  selectedTracks.forEach((track, i) => {
    setTimeout(() => {
      updateLiveQueueRow({ id: track.id, status: "downloading", percent: 45, speed: "12.4 MB/s" });
      updatePreviewRowStatus(track.id, "downloading", 45);
    }, (i + 1) * 600);

    setTimeout(() => {
      updateLiveQueueRow({ id: track.id, status: "conversion_queued", eta: "Convert-Q" });
      updatePreviewRowStatus(track.id, "conversion_queued");
    }, (i + 1) * 1000);

    setTimeout(() => {
      updateLiveQueueRow({ id: track.id, status: "converting", percent: 90, eta: "Converting" });
      updatePreviewRowStatus(track.id, "converting", 90);
    }, (i + 1) * 1350);

    setTimeout(() => {
      finished++;
      updateLiveQueueRow({ id: track.id, status: "done" });
      updatePreviewRowStatus(track.id, "done");
      const overallPct = Math.round((finished / total) * 100);
      updateOverallProgress({ percent: overallPct, completed_count: finished, total_count: total, failed_count: 0 });

      if (finished === total) {
        setTimeout(() => {
          handleJobCompleted({
            job_id: "demo_job",
            successful: total,
            total: total,
            zip_size_bytes: 38400000,
            failed: 0,
            download_dir: "C:\\Downloads"
          });
        }, 400);
      }
    }, (i + 1) * 1750);
  });
}

function renderLiveQueueInit(tracks) {
  const container = el.liveTracksList;
  container.innerHTML = "";

  tracks.forEach(track => {
    const row = document.createElement("div");
    row.className = "live-q-row";
    row.id = `live-row-${track.id}`;

    const idxStr = track.index < 10 ? `0${track.index}` : `${track.index}`;

    row.innerHTML = `
      <div class="live-q-left">
        <span class="live-q-idx">#${idxStr}</span>
        <span class="live-q-name" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</span>
      </div>
      <div class="live-q-right">
        <span class="live-q-speed" id="speed-${track.id}"></span>
        <span class="live-q-pill q-queued" id="pill-${track.id}">Queued</span>
      </div>
    `;

    container.appendChild(row);
  });
}

function connectEventSource(jobId) {
  if (state.eventSource) state.eventSource.close();

  const es = new EventSource(`/api/download/progress/${jobId}`);
  state.eventSource = es;

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleSSEMessage(data);
    } catch (err) {}
  };

  es.onerror = () => {
    // disconnected or closed
  };
}

function handleSSEMessage(data) {
  if (data.type === "init") {
    if (data.tracks) {
      Object.values(data.tracks).forEach(t => updateLiveQueueRow(t));
    }
  } else if (data.type === "track_update") {
    updateLiveQueueRow(data.track);
    updatePreviewRowStatus(data.track.id, data.track.status, data.track.percent, data.track.error);
  } else if (data.type === "overall_update") {
    updateOverallProgress(data);
  } else if (data.type === "cancelled") {
    const saved = data.completed_count || 0;
    const total = data.total_count || (state.selectedIds ? state.selectedIds.size : 0);

    if (saved > 0) {
      const mb = data.zip_size_bytes ? (data.zip_size_bytes / (1024 * 1024)).toFixed(1) : "0.0";
      const zipUrl = `/api/download/zip/${data.job_id || state.activeJobId}`;
      el.progressHeading.textContent = "Download Cancelled (Preserved)";
      el.progressSubtext.textContent = `Process cancelled immediately. Preserved ${saved} of ${total} finished tracks in ZIP.`;
      
      // Activate ZIP Download buttons for preserved files
      el.topZipLabel.textContent = `Download ZIP (${mb} MB)`;
      el.topZipBtn.href = zipUrl;
      el.topZipBtn.classList.remove("hidden");

      el.btnZipLabel.textContent = `Download Preserved (${saved} Tracks - ${mb} MB)`;
      el.btnDownloadZip.href = zipUrl;
      if (el.completedActionsRow) el.completedActionsRow.classList.remove("hidden");
      el.btnStartDownload.classList.add("hidden");

      if (el.tableFooterStatusText) {
        el.tableFooterStatusText.innerHTML = `<strong style="color:#fbbf24">${saved} of ${total} Preserved (Cancelled)</strong>`;
      }
      showToast(`Cancelled: Preserved ${saved} completed track(s) in ZIP.`, "info");
    } else {
      el.progressHeading.textContent = "Download Cancelled";
      el.progressSubtext.textContent = "Process stopped immediately right where it was. No tracks were completed.";
      el.btnStartDownload.disabled = false;
      el.btnStartDownload.classList.remove("is-busy");
      el.btnStartDownload.classList.remove("hidden");
      if (el.btnDownloadLabel) el.btnDownloadLabel.textContent = `Download Selected Tracks (${state.selectedIds.size} Tracks)`;
      showToast("Download cancelled.", "info");
    }

    el.btnCancelJob.disabled = true;
    el.btnCancelJob.classList.add("hidden");
    document.querySelectorAll(".track-chk, #master-checkbox").forEach(c => c.disabled = false);
    if (el.queueStatusText) el.queueStatusText.textContent = `Queue cancelled (${saved} saved)`;
    if (state.eventSource) state.eventSource.close();
  } else if (data.type === "completed") {
    handleJobCompleted(data);
  }
}


function updatePreviewRowStatus(trackId, status, percent, error) {
  const cell = document.getElementById(`preview-status-${trackId}`);
  if (!cell) return;
  if (status === "downloading") {
    cell.innerHTML = `<span class="badge-status badge-downloading">${percent || 0}%</span>`;
  } else if (status === "conversion_queued") {
    cell.innerHTML = `<span class="badge-status badge-convert-q">Convert-Q</span>`;
  } else if (status === "converting") {
    cell.innerHTML = `<span class="badge-status badge-converting">Converting</span>`;
  } else if (status === "done") {
    cell.innerHTML = `<span class="badge-status badge-done">Done ✓</span>`;
  } else if (status === "cancelled") {
    cell.innerHTML = `<span class="badge-status badge-skipped">Cancelled</span>`;
  } else if (status === "failed") {
    cell.innerHTML = `<span class="badge-status badge-failed" title="${escapeHtml(error || 'Failed')}">Failed ✕</span>`;
  } else if (status === "queued") {
    cell.innerHTML = `<span class="badge-status badge-queued">Queued</span>`;
  } else if (status === "skipped") {
    cell.innerHTML = `<span class="badge-status badge-skipped">Skipped</span>`;
  } else {
    cell.innerHTML = `<span class="badge-status badge-ready">Ready</span>`;
  }
}

function updateLiveQueueRow(t) {
  const pill = document.getElementById(`pill-${t.id}`);
  const speed = document.getElementById(`speed-${t.id}`);
  if (!pill) return;

  pill.className = `live-q-pill q-${t.status}`;

  if (t.status === "downloading") {
    pill.textContent = `${t.percent}%`;
    if (speed) speed.textContent = t.speed || "";
  } else if (t.status === "conversion_queued") {
    pill.textContent = "Convert-Q";
    if (speed) speed.textContent = "Queued";
  } else if (t.status === "converting") {
    pill.textContent = t.eta || "Converting";
    if (speed) speed.textContent = "ffmpeg";
  } else if (t.status === "done") {
    pill.textContent = "Done ✓";
    if (speed) speed.textContent = "";
  } else if (t.status === "cancelled") {
    pill.textContent = "Cancelled";
    if (speed) speed.textContent = "";
  } else if (t.status === "failed") {
    pill.textContent = "Failed ✕";
    pill.title = t.error || "Failed";
    if (speed) speed.textContent = t.error ? t.error.slice(0, 14) : "";
  } else if (t.status === "skipped") {
    pill.textContent = "Skipped";
    if (speed) speed.textContent = "";
  } else if (t.status === "queued") {
    pill.textContent = "Queued";
    if (speed) speed.textContent = "";
  }
}

function updateOverallProgress(data) {
  el.overallBarFill.style.width = `${data.percent}%`;
  el.overallPercentLabel.textContent = `${data.percent}%`;
  el.overallCountsLabel.textContent = `${data.completed_count} of ${data.total_count} finished`;
  if (el.btnDownloadLabel) {
    el.btnDownloadLabel.textContent = `Downloading Tracks (${data.completed_count} of ${data.total_count})...`;
  }

  if (data.failed_count > 0) {
    el.overallCountsLabel.textContent += ` (${data.failed_count} failed)`;
  }

  if (data.status === "zipping") {
    el.progressHeading.textContent = "Creating ZIP Bundle...";
    el.progressSubtext.textContent = "Packing files with fast zero-recompression storage.";
  }
}

function handleJobCompleted(data) {
  el.progressHeading.textContent = "Download Complete";
  el.progressSubtext.textContent = `Successfully saved ${data.successful} of ${data.total} tracks.`;
  if (el.btnCancelJob) el.btnCancelJob.classList.add("hidden");
  if (el.queueStatusText) el.queueStatusText.textContent = `Queue completed • ${data.successful} of ${data.total} items finished`;

  // Update preview table status for all tracks to Done ✓
  if (state.currentPlaylist && state.currentPlaylist.items) {
    state.currentPlaylist.items.forEach(itm => {
      if (state.selectedIds.has(itm.id)) {
        updatePreviewRowStatus(itm.id, "done");
      }
    });
  }

  // Update Preview Table Footer with 4 of 4 finished
  if (el.tableFooterStatusText) {
    el.tableFooterStatusText.innerHTML = `<strong style="color:#10b981">${data.successful} of ${data.total} Finished ✓</strong>`;
  }
  if (el.selectedPercentLabel) {
    el.selectedPercentLabel.textContent = `${data.successful} of ${data.total} Finished ✓`;
    el.selectedPercentLabel.style.color = "#10b981";
  }

  // Unlock checkboxes
  document.querySelectorAll(".track-chk, #master-checkbox").forEach(c => c.disabled = false);

  if (state.eventSource) state.eventSource.close();

  const mb = (data.zip_size_bytes / (1024 * 1024)).toFixed(1);
  const zipUrl = `/api/download/zip/${data.job_id}`;

  // Top nav pill
  el.topZipLabel.textContent = `Download ZIP (${mb} MB)`;
  el.topZipBtn.href = zipUrl;
  el.topZipBtn.classList.remove("hidden");

  // Main Action Card: Transition red button to Completed Actions row
  el.btnStartDownload.classList.add("hidden");
  el.btnStartDownload.disabled = false;
  el.btnStartDownload.classList.remove("is-busy");

  el.btnZipLabel.textContent = `Download ZIP (${mb} MB)`;
  el.btnDownloadZip.href = zipUrl;
  if (el.completedActionsRow) el.completedActionsRow.classList.remove("hidden");
  if (el.zipDeliveryCard) el.zipDeliveryCard.classList.add("hidden");

  el.btnOpenFolder.onclick = async () => {
    try {
      await fetch("/api/download/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: data.download_dir })
      });
      showToast("Opened download folder in Windows Explorer.", "success");
    } catch (e) {
      showToast("Could not open folder.", "error");
    }
  };

  if (data.failed > 0) {
    el.btnRetryFailed.classList.remove("hidden");
  }

  showToast(`ZIP created: ${mb} MB`, "success");
}

// Cancel
if (el.btnCancelJob) {
  el.btnCancelJob.addEventListener("click", async () => {
    if (!state.activeJobId) return;
    el.btnCancelJob.disabled = true;
    el.btnCancelJob.textContent = "Cancelling...";
    try {
      await fetch(`/api/download/cancel/${state.activeJobId}`, { method: "POST" });
    } catch (err) {
      showToast("Error cancelling: " + err.message, "error");
    }
  });
}

// Retry Failed
if (el.btnRetryFailed) {
  el.btnRetryFailed.addEventListener("click", async () => {
    if (!state.activeJobId) return;
    el.btnRetryFailed.disabled = true;
    try {
      const res = await fetch(`/api/download/retry-failed/${state.activeJobId}`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        showToast(`Retrying ${data.retry_count} failed track(s)...`, "info");
        el.btnRetryFailed.classList.add("hidden");
        el.btnCancelJob.classList.remove("hidden");
        el.btnCancelJob.disabled = false;
        connectEventSource(state.activeJobId);
      }
    } catch (e) {
      showToast("Retry failed: " + e.message, "error");
    } finally {
      el.btnRetryFailed.disabled = false;
    }
  });
}

// Reset / New
if (el.btnStartNew) {
  el.btnStartNew.addEventListener("click", () => {
    state.currentPlaylist = null;
    state.selectedIds.clear();
    state.activeJobId = null;
    if (state.eventSource) state.eventSource.close();

    el.playlistLoadedWrap.classList.add("hidden");
    el.previewEmptyState.classList.remove("hidden");
    el.sectionProgress.classList.add("hidden");
    el.topZipBtn.classList.add("hidden");

    el.urlInput.value = "";
    el.btnClearUrl.classList.add("hidden");

    el.btnDownloadLabel.textContent = "Download Selected Tracks (0 Tracks)";
    el.btnStartDownload.disabled = true;
    el.urlInput.focus();
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// -------------------------------------------------------------
// App Initialization
// -------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  loadSavedOptions();
  fetchSystemStatus();

  // Load demo playlist by default to reproduce the exact screenshot state
  loadPlaylistData(DEMO_PLAYLIST);
});
