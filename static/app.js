/**
 * Music Playlist Downloader - Frontend Controller
 */

// Application State
const state = {
  systemStatus: {
    ffmpeg_installed: false,
    deno_installed: false,
    ytdlp_version: "...",
    ffmpeg_path: null,
    deno_path: null
  },
  currentPlaylist: null, // { title, uploader, platform, total_count, items: [] }
  selectedIds: new Set(),
  activeJobId: null,
  eventSource: null,
  options: {
    type: "audio",
    audio_format: "best",
    audio_quality: "best",
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

// DOM Elements
const elements = {
  ffmpegPill: document.getElementById("ffmpeg-pill"),
  denoPill: document.getElementById("deno-pill"),
  ytdlpVersionLabel: document.getElementById("ytdlp-version-label"),
  btnUpdateYtdlp: document.getElementById("btn-update-ytdlp"),
  warningBanner: document.getElementById("warning-banner"),
  warningCommands: document.getElementById("warning-banner-commands"),
  btnRecheckTools: document.getElementById("btn-recheck-tools"),

  urlInput: document.getElementById("url-input"),
  btnClearUrl: document.getElementById("btn-clear-url"),
  btnFetch: document.getElementById("btn-fetch"),
  platformBadge: document.getElementById("platform-badge"),

  previewSkeleton: document.getElementById("preview-skeleton"),
  sectionPreview: document.getElementById("section-preview"),
  playlistCover: document.getElementById("playlist-cover"),
  playlistPlatformPill: document.getElementById("playlist-platform-pill"),
  playlistTitle: document.getElementById("playlist-title"),
  playlistUploader: document.getElementById("playlist-uploader"),
  playlistCount: document.getElementById("playlist-count"),
  playlistDuration: document.getElementById("playlist-duration"),
  selectedCountLabel: document.getElementById("selected-count-label"),
  selectedSizeEstimate: document.getElementById("selected-size-estimate"),

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

  sectionOptions: document.getElementById("section-options"),
  optTypeAudio: document.getElementById("opt-type-audio"),
  optTypeVideo: document.getElementById("opt-type-video"),
  audioOptionsPanel: document.getElementById("audio-options-panel"),
  videoOptionsPanel: document.getElementById("video-options-panel"),
  audioFormatGroup: document.getElementById("audio-format-group"),
  selectAudioQuality: document.getElementById("select-audio-quality"),
  videoFormatGroup: document.getElementById("video-format-group"),
  selectVideoQuality: document.getElementById("select-video-quality"),

  toggleMetadata: document.getElementById("toggle-metadata"),
  toggleCover: document.getElementById("toggle-cover"),
  toggleSaveThumbs: document.getElementById("toggle-save-thumbs"),
  togglePrefixIndex: document.getElementById("toggle-prefix-index"),
  toggleSkipExisting: document.getElementById("toggle-skip-existing"),
  toggleSubtitles: document.getElementById("toggle-subtitles"),
  controlEmbedSubs: document.getElementById("control-embed-subs"),

  inputFilenameTemplate: document.getElementById("input-filename-template"),
  selectCookiesBrowser: document.getElementById("select-cookies-browser"),
  sliderConcurrency: document.getElementById("slider-concurrency"),
  valConcurrency: document.getElementById("val-concurrency"),
  inputRateLimit: document.getElementById("input-rate-limit"),

  btnStartDownload: document.getElementById("btn-start-download"),
  btnDownloadLabel: document.getElementById("btn-download-label"),

  sectionProgress: document.getElementById("section-progress"),
  progressHeading: document.getElementById("progress-heading"),
  progressSubtext: document.getElementById("progress-subtext"),
  btnCancelJob: document.getElementById("btn-cancel-job"),
  btnRetryFailed: document.getElementById("btn-retry-failed"),
  overallBarFill: document.getElementById("overall-bar-fill"),
  overallPercentLabel: document.getElementById("overall-percent-label"),
  overallCountsLabel: document.getElementById("overall-counts-label"),
  zipDeliveryCard: document.getElementById("zip-delivery-card"),
  zipInfoText: document.getElementById("zip-info-text"),
  btnDownloadZip: document.getElementById("btn-download-zip"),
  btnZipLabel: document.getElementById("btn-zip-label"),
  btnOpenFolder: document.getElementById("btn-open-folder"),
  btnStartNew: document.getElementById("btn-start-new"),
  liveTracksList: document.getElementById("live-tracks-list"),
  toastContainer: document.getElementById("toast-container")
};

// -------------------------------------------------------------
// Toast Notifications
// -------------------------------------------------------------
function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

// -------------------------------------------------------------
// Initial System Tools Check
// -------------------------------------------------------------
async function fetchSystemStatus() {
  try {
    const res = await fetch("/api/system-status");
    if (!res.ok) throw new Error("Failed to read system status");
    const data = await res.json();
    state.systemStatus = data;

    // Update pills
    updatePill(elements.ffmpegPill, data.ffmpeg_installed, "FFmpeg");
    updatePill(elements.denoPill, data.deno_installed, "Deno (JS)");

    // Version label
    elements.ytdlpVersionLabel.textContent = `yt-dlp v${data.ytdlp_version}`;

    // Missing tools banner
    if (!data.ffmpeg_installed || !data.deno_installed) {
      elements.warningBanner.classList.remove("hidden");
      elements.warningCommands.innerHTML = "";
      if (!data.ffmpeg_installed) {
        const cmd = document.createElement("code");
        cmd.textContent = data.winget_ffmpeg_cmd;
        cmd.title = "Click to copy";
        cmd.onclick = () => copyText(data.winget_ffmpeg_cmd);
        elements.warningCommands.appendChild(cmd);
      }
      if (!data.deno_installed) {
        const cmd = document.createElement("code");
        cmd.textContent = data.winget_deno_cmd;
        cmd.title = "Click to copy";
        cmd.onclick = () => copyText(data.winget_deno_cmd);
        elements.warningCommands.appendChild(cmd);
      }
    } else {
      elements.warningBanner.classList.add("hidden");
    }
  } catch (err) {
    console.error("System status check error:", err);
  }
}

function updatePill(pill, isInstalled, label) {
  pill.className = `status-pill ${isInstalled ? "status-pill-ok" : "status-pill-bad"}`;
  pill.innerHTML = `<span class="pill-dot"></span> ${label} ${isInstalled ? "✓" : "Missing"}`;
  pill.title = isInstalled ? `${label} is available on your PC` : `${label} is not installed or not in PATH`;
}

function copyText(text) {
  navigator.clipboard.writeText(text);
  showToast(`Copied to clipboard: ${text}`, "success");
}

// Update yt-dlp handler
elements.btnUpdateYtdlp.addEventListener("click", async () => {
  const btn = elements.btnUpdateYtdlp;
  btn.disabled = true;
  const originalHtml = btn.innerHTML;
  btn.innerHTML = `<span class="btn-spinner"></span> Updating...`;

  try {
    const res = await fetch("/api/update-ytdlp", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast(`yt-dlp updated: ${data.old_version} ➔ ${data.new_version}`, "success");
      elements.ytdlpVersionLabel.textContent = `yt-dlp v${data.new_version}`;
    } else {
      showToast(`Update completed: ${data.output || "Already up to date"}`, "info");
    }
  } catch (e) {
    showToast(`Failed to update yt-dlp: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHtml;
  }
});

elements.btnRecheckTools.addEventListener("click", () => {
  fetchSystemStatus();
  showToast("Re-checked system tools.", "info");
});

// -------------------------------------------------------------
// Options Persistence (localStorage)
// -------------------------------------------------------------
function saveOptions() {
  try {
    localStorage.setItem("ymp_options", JSON.stringify(state.options));
  } catch (e) {
    console.warn("Could not save to localStorage", e);
  }
}

function loadSavedOptions() {
  try {
    const saved = localStorage.getItem("ymp_options");
    if (saved) {
      const parsed = JSON.parse(saved);
      state.options = { ...state.options, ...parsed };
    }
  } catch (e) {
    console.warn("Could not load from localStorage", e);
  }
  applyOptionsToUI();
}

function applyOptionsToUI() {
  const o = state.options;

  // Type
  if (o.type === "video") {
    elements.optTypeVideo.classList.add("active");
    elements.optTypeAudio.classList.remove("active");
    elements.audioOptionsPanel.classList.add("hidden");
    elements.videoOptionsPanel.classList.remove("hidden");
    elements.controlEmbedSubs.classList.remove("hidden");
  } else {
    elements.optTypeAudio.classList.add("active");
    elements.optTypeVideo.classList.remove("active");
    elements.audioOptionsPanel.classList.remove("hidden");
    elements.videoOptionsPanel.classList.add("hidden");
    elements.controlEmbedSubs.classList.add("hidden");
  }

  // Audio format
  document.querySelectorAll("#audio-format-group .format-pill").forEach(p => {
    p.classList.toggle("active", p.dataset.val === o.audio_format);
  });
  elements.selectAudioQuality.value = o.audio_quality;

  // Video format
  document.querySelectorAll("#video-format-group .format-pill").forEach(p => {
    p.classList.toggle("active", p.dataset.val === o.video_format);
  });
  elements.selectVideoQuality.value = o.video_quality;

  // Toggles
  elements.toggleMetadata.checked = o.embed_metadata;
  elements.toggleCover.checked = o.embed_cover_art;
  elements.toggleSaveThumbs.checked = o.save_thumbnails;
  elements.togglePrefixIndex.checked = o.prefix_index;
  elements.toggleSkipExisting.checked = o.skip_existing;
  elements.toggleSubtitles.checked = o.embed_subtitles;

  // Advanced
  elements.inputFilenameTemplate.value = o.filename_template;
  elements.selectCookiesBrowser.value = o.browser_cookies || "";
  elements.sliderConcurrency.value = o.concurrency;
  elements.valConcurrency.textContent = o.concurrency;
  elements.inputRateLimit.value = o.rate_limit || "";
}

// Attach Options Event Listeners
elements.optTypeAudio.addEventListener("click", () => {
  state.options.type = "audio";
  applyOptionsToUI();
  saveOptions();
  updateLiveCounter();
});

elements.optTypeVideo.addEventListener("click", () => {
  state.options.type = "video";
  applyOptionsToUI();
  saveOptions();
  updateLiveCounter();
});

document.querySelectorAll("#audio-format-group .format-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    state.options.audio_format = btn.dataset.val;
    applyOptionsToUI();
    saveOptions();
  });
});

elements.selectAudioQuality.addEventListener("change", (e) => {
  state.options.audio_quality = e.target.value;
  saveOptions();
  updateLiveCounter();
});

document.querySelectorAll("#video-format-group .format-pill").forEach(btn => {
  btn.addEventListener("click", () => {
    state.options.video_format = btn.dataset.val;
    applyOptionsToUI();
    saveOptions();
  });
});

elements.selectVideoQuality.addEventListener("change", (e) => {
  state.options.video_quality = e.target.value;
  saveOptions();
  updateLiveCounter();
});

elements.toggleMetadata.addEventListener("change", e => { state.options.embed_metadata = e.target.checked; saveOptions(); });
elements.toggleCover.addEventListener("change", e => { state.options.embed_cover_art = e.target.checked; saveOptions(); });
elements.toggleSaveThumbs.addEventListener("change", e => { state.options.save_thumbnails = e.target.checked; saveOptions(); });
elements.togglePrefixIndex.addEventListener("change", e => { state.options.prefix_index = e.target.checked; saveOptions(); });
elements.toggleSkipExisting.addEventListener("change", e => { state.options.skip_existing = e.target.checked; saveOptions(); });
elements.toggleSubtitles.addEventListener("change", e => { state.options.embed_subtitles = e.target.checked; saveOptions(); });

elements.inputFilenameTemplate.addEventListener("input", e => { state.options.filename_template = e.target.value; saveOptions(); });
elements.selectCookiesBrowser.addEventListener("change", e => { state.options.browser_cookies = e.target.value; saveOptions(); });
elements.sliderConcurrency.addEventListener("input", e => {
  state.options.concurrency = parseInt(e.target.value, 10);
  elements.valConcurrency.textContent = e.target.value;
  saveOptions();
});
elements.inputRateLimit.addEventListener("input", e => { state.options.rate_limit = e.target.value.trim(); saveOptions(); });

// -------------------------------------------------------------
// URL Input Handling & Auto-Fetch
// -------------------------------------------------------------
let fetchDebounceTimer = null;

function detectPlatform(url) {
  const lower = url.toLowerCase();
  if (lower.includes("music.youtube.com")) return "YouTube Music";
  if (lower.includes("youtube.com") || lower.includes("youtu.be")) return "YouTube";
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

elements.urlInput.addEventListener("input", (e) => {
  const raw = e.target.value;
  elements.btnClearUrl.classList.toggle("hidden", !raw);

  const platform = detectPlatform(raw);
  if (platform) {
    elements.platformBadge.textContent = platform;
    elements.platformBadge.classList.remove("hidden");
  } else {
    elements.platformBadge.classList.add("hidden");
  }

  // Debounce auto-fetch
  clearTimeout(fetchDebounceTimer);
  if (platform && (raw.includes("list=") || raw.includes("watch?v=") || raw.includes("youtu.be/"))) {
    fetchDebounceTimer = setTimeout(() => {
      fetchPlaylistPreview(raw);
    }, 450);
  }
});

elements.urlInput.addEventListener("paste", (e) => {
  setTimeout(() => {
    const raw = elements.urlInput.value;
    const platform = detectPlatform(raw);
    if (platform) {
      clearTimeout(fetchDebounceTimer);
      fetchPlaylistPreview(raw);
    }
  }, 50);
});

elements.btnClearUrl.addEventListener("click", () => {
  elements.urlInput.value = "";
  elements.btnClearUrl.classList.add("hidden");
  elements.platformBadge.classList.add("hidden");
  elements.urlInput.focus();
});

elements.btnFetch.addEventListener("click", () => {
  const url = elements.urlInput.value.trim();
  if (!url) {
    showToast("Please paste a YouTube or YouTube Music link.", "error");
    return;
  }
  fetchPlaylistPreview(url);
});

// -------------------------------------------------------------
// Fetch & Render Playlist Preview
// -------------------------------------------------------------
async function fetchPlaylistPreview(url) {
  const cleanUrl = cleanInputUrl(url);
  elements.urlInput.value = cleanUrl;

  // Show skeleton, hide existing preview
  elements.previewSkeleton.classList.remove("hidden");
  elements.sectionPreview.classList.add("hidden");
  elements.sectionOptions.classList.add("hidden");
  elements.sectionProgress.classList.add("hidden");

  const btnSpinner = elements.btnFetch.querySelector(".btn-spinner");
  const btnText = elements.btnFetch.querySelector(".btn-text");
  btnSpinner.classList.remove("hidden");
  btnText.textContent = "Fetching...";
  elements.btnFetch.disabled = true;

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
      const errData = await res.json();
      throw new Error(errData.detail || "Failed to load playlist.");
    }

    const data = await res.json();
    state.currentPlaylist = data;

    // Reset selection: select all available items by default
    state.selectedIds.clear();
    data.items.forEach(item => {
      if (item.available) {
        state.selectedIds.add(item.id);
      }
    });

    renderPlaylistPreview(data);
    elements.sectionPreview.classList.remove("hidden");
    elements.sectionOptions.classList.remove("hidden");
    showToast(`Loaded "${data.title}" with ${data.total_count} track(s)`, "success");

  } catch (err) {
    showToast(err.message, "error");
  } finally {
    elements.previewSkeleton.classList.add("hidden");
    btnSpinner.classList.add("hidden");
    btnText.textContent = "Fetch Preview";
    elements.btnFetch.disabled = false;
  }
}

function renderPlaylistPreview(data) {
  elements.playlistCover.src = data.thumbnail || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=300";
  elements.playlistPlatformPill.textContent = data.platform;
  elements.playlistTitle.textContent = data.title;
  elements.playlistUploader.textContent = data.uploader;
  elements.playlistCount.textContent = `${data.total_count} tracks`;
  elements.playlistDuration.textContent = data.total_duration_formatted;

  renderTracklistTable(data.items);
  updateLiveCounter();
}

function renderTracklistTable(items) {
  const tbody = elements.tracklistTbody;
  tbody.innerHTML = "";

  const filterText = elements.trackFilterInput.value.toLowerCase().trim();

  items.forEach(item => {
    // Check filter match
    const matchesFilter = !filterText || 
      item.title.toLowerCase().includes(filterText) || 
      (item.artist && item.artist.toLowerCase().includes(filterText));

    if (!matchesFilter) return;

    const tr = document.createElement("tr");
    if (!item.available) {
      tr.className = "row-disabled";
    }

    const isChecked = state.selectedIds.has(item.id);

    tr.innerHTML = `
      <td class="td-check">
        <input type="checkbox" class="track-checkbox" data-id="${item.id}" ${isChecked ? "checked" : ""} ${!item.available ? "disabled" : ""}>
      </td>
      <td class="td-index">${item.index}</td>
      <td class="td-thumb">
        <div class="track-thumb-box">
          <img src="${item.thumbnail || ''}" alt="" class="track-thumb-img" loading="lazy">
        </div>
      </td>
      <td class="td-title">
        <div class="track-title-box">
          <span class="track-title-text" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</span>
          <span class="track-artist-text">${escapeHtml(item.artist || 'Unknown')}</span>
        </div>
      </td>
      <td class="td-duration">${item.duration_formatted}</td>
      <td class="td-status">
        ${!item.available 
          ? `<span class="badge-unavailable" title="${item.unavailable_reason || 'Unavailable'}">${item.unavailable_reason || 'Unavailable'}</span>`
          : `<span class="meta-item" style="color: #34d399; font-size:0.75rem;">Available</span>`
        }
      </td>
    `;

    // Row click toggles checkbox if not disabled
    tr.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT" || !item.available) return;
      const chk = tr.querySelector(".track-checkbox");
      chk.checked = !chk.checked;
      toggleItemSelection(item.id, chk.checked);
    });

    const checkbox = tr.querySelector(".track-checkbox");
    checkbox.addEventListener("change", (e) => {
      toggleItemSelection(item.id, e.target.checked);
    });

    tbody.appendChild(tr);
  });

  updateMasterCheckboxState();
}

function toggleItemSelection(id, checked) {
  if (checked) {
    state.selectedIds.add(id);
  } else {
    state.selectedIds.delete(id);
  }
  updateLiveCounter();
  updateMasterCheckboxState();
}

function updateMasterCheckboxState() {
  if (!state.currentPlaylist || !state.currentPlaylist.items) return;
  const availableItems = state.currentPlaylist.items.filter(i => i.available);
  if (availableItems.length === 0) {
    elements.masterCheckbox.checked = false;
    return;
  }
  const allChecked = availableItems.every(i => state.selectedIds.has(i.id));
  elements.masterCheckbox.checked = allChecked;
}

function updateLiveCounter() {
  if (!state.currentPlaylist) return;
  const total = state.currentPlaylist.total_count || 0;
  const selectedCount = state.selectedIds.size;

  elements.selectedCountLabel.textContent = `${selectedCount} of ${total}`;
  elements.btnDownloadLabel.textContent = `Download Selected (${selectedCount})`;
  elements.btnStartDownload.disabled = selectedCount === 0;

  // Calculate size estimate
  let totalDurationSec = 0;
  state.currentPlaylist.items.forEach(item => {
    if (state.selectedIds.has(item.id)) {
      totalDurationSec += (item.duration || 180); // default 3 min if 0
    }
  });

  const totalMinutes = totalDurationSec / 60;
  let estimatedMB = 0;

  if (state.options.type === "audio") {
    // Audio estimate based on bitrate
    const br = state.options.audio_quality;
    const mbPerMin = br === "320" ? 2.4 : br === "256" ? 1.9 : br === "128" ? 1.0 : 1.5;
    estimatedMB = Math.round(totalMinutes * mbPerMin);
  } else {
    // Video estimate based on resolution
    const res = state.options.video_quality;
    const mbPerMin = res === "2160" ? 35 : res === "1440" ? 22 : res === "1080" ? 12 : res === "720" ? 7 : 4;
    estimatedMB = Math.round(totalMinutes * mbPerMin);
  }

  elements.selectedSizeEstimate.textContent = `~${estimatedMB} MB est.`;
}

// -------------------------------------------------------------
// Selection Controls (All, None, Invert, First N, Range, Filter)
// -------------------------------------------------------------
elements.masterCheckbox.addEventListener("change", (e) => {
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

elements.btnSelectAll.addEventListener("click", () => {
  if (!state.currentPlaylist) return;
  state.currentPlaylist.items.forEach(i => {
    if (i.available) state.selectedIds.add(i.id);
  });
  renderTracklistTable(state.currentPlaylist.items);
  updateLiveCounter();
});

elements.btnDeselectAll.addEventListener("click", () => {
  state.selectedIds.clear();
  if (state.currentPlaylist) {
    renderTracklistTable(state.currentPlaylist.items);
  }
  updateLiveCounter();
});

elements.btnInvertSelection.addEventListener("click", () => {
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

elements.btnApplyFirstN.addEventListener("click", () => {
  const n = parseInt(elements.inputFirstN.value, 10);
  if (isNaN(n) || n <= 0 || !state.currentPlaylist) return;
  state.selectedIds.clear();
  let count = 0;
  for (const item of state.currentPlaylist.items) {
    if (item.available && count < n) {
      state.selectedIds.add(item.id);
      count++;
    }
  }
  renderTracklistTable(state.currentPlaylist.items);
  updateLiveCounter();
  showToast(`Selected first ${count} available tracks`, "info");
});

elements.btnApplyRange.addEventListener("click", () => {
  const from = parseInt(elements.inputRangeFrom.value, 10);
  const to = parseInt(elements.inputRangeTo.value, 10);
  if (isNaN(from) || isNaN(to) || from > to || !state.currentPlaylist) return;

  state.selectedIds.clear();
  let count = 0;
  state.currentPlaylist.items.forEach(item => {
    if (item.available && item.index >= from && item.index <= to) {
      state.selectedIds.add(item.id);
      count++;
    }
  });
  renderTracklistTable(state.currentPlaylist.items);
  updateLiveCounter();
  showToast(`Selected ${count} tracks between #${from} and #${to}`, "info");
});

elements.trackFilterInput.addEventListener("input", () => {
  if (state.currentPlaylist) {
    renderTracklistTable(state.currentPlaylist.items);
  }
});

// -------------------------------------------------------------
// Step 4 & 5: Start Download & SSE Progress Streaming
// -------------------------------------------------------------
elements.btnStartDownload.addEventListener("click", async () => {
  if (!state.currentPlaylist || state.selectedIds.size === 0) {
    showToast("Please select at least 1 track to download.", "error");
    return;
  }

  const selectedTracks = state.currentPlaylist.items.filter(i => state.selectedIds.has(i.id));

  // Switch to progress view
  elements.sectionProgress.classList.remove("hidden");
  elements.zipDeliveryCard.classList.add("hidden");
  elements.btnRetryFailed.classList.add("hidden");
  elements.btnCancelJob.disabled = false;
  elements.btnCancelJob.classList.remove("hidden");

  // Reset overall bar
  elements.overallBarFill.style.width = "0%";
  elements.overallPercentLabel.textContent = "0%";
  elements.overallCountsLabel.textContent = `0 of ${selectedTracks.length} completed`;
  elements.progressHeading.textContent = `Downloading "${state.currentPlaylist.title}"`;
  elements.progressSubtext.textContent = `Processing ${selectedTracks.length} selected items...`;

  // Render initial live tracks rows
  renderLiveTracksInit(selectedTracks);

  // Scroll to progress card
  elements.sectionProgress.scrollIntoView({ behavior: "smooth" });

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

function renderLiveTracksInit(tracks) {
  const container = elements.liveTracksList;
  container.innerHTML = "";

  tracks.forEach(track => {
    const row = document.createElement("div");
    row.className = "live-track-row";
    row.id = `live-row-${track.id}`;

    row.innerHTML = `
      <div class="live-track-info">
        <span class="live-track-idx">#${track.index}</span>
        <div class="live-track-meta">
          <span class="live-track-name" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</span>
          <span class="live-track-artist">${escapeHtml(track.artist || 'Unknown')}</span>
        </div>
      </div>
      <div class="live-track-progress">
        <span class="live-track-speed" id="speed-${track.id}"></span>
        <span class="live-status-pill status-queued" id="pill-${track.id}">Queued</span>
      </div>
    `;

    container.appendChild(row);
  });
}

function connectEventSource(jobId) {
  if (state.eventSource) {
    state.eventSource.close();
  }

  const es = new EventSource(`/api/download/progress/${jobId}`);
  state.eventSource = es;

  es.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleSSEMessage(data);
    } catch (err) {
      console.warn("SSE parse error:", err);
    }
  };

  es.onerror = (err) => {
    console.warn("SSE connection error or completed:", err);
  };
}

function handleSSEMessage(data) {
  if (data.type === "init") {
    // Bulk initial state
    if (data.tracks) {
      Object.values(data.tracks).forEach(t => updateTrackUI(t));
    }
  } else if (data.type === "track_update") {
    updateTrackUI(data.track);
  } else if (data.type === "overall_update") {
    updateOverallUI(data);
  } else if (data.type === "cancelled") {
    elements.progressHeading.textContent = "Download Cancelled";
    elements.progressSubtext.textContent = "All operations stopped and temporary files cleaned.";
    elements.btnCancelJob.disabled = true;
    showToast("Download was cancelled.", "info");
    if (state.eventSource) state.eventSource.close();
  } else if (data.type === "completed") {
    handleJobCompleted(data);
  }
}

function updateTrackUI(t) {
  const pill = document.getElementById(`pill-${t.id}`);
  const speed = document.getElementById(`speed-${t.id}`);
  if (!pill) return;

  pill.className = `live-status-pill status-${t.status}`;
  
  if (t.status === "downloading") {
    pill.textContent = `${t.percent}%`;
    if (speed) speed.textContent = t.speed || "";
  } else if (t.status === "converting") {
    pill.textContent = t.eta || "Converting";
    if (speed) speed.textContent = "ffmpeg";
  } else if (t.status === "done") {
    pill.textContent = "Done ✓";
    if (speed) speed.textContent = "";
  } else if (t.status === "failed") {
    pill.textContent = "Failed ✕";
    pill.title = t.error || "Failed";
    if (speed) speed.textContent = t.error ? t.error.slice(0, 16) : "";
  } else if (t.status === "skipped") {
    pill.textContent = "Skipped";
    if (speed) speed.textContent = "";
  }
}

function updateOverallUI(data) {
  elements.overallBarFill.style.width = `${data.percent}%`;
  elements.overallPercentLabel.textContent = `${data.percent}%`;
  elements.overallCountsLabel.textContent = `${data.completed_count} of ${data.total_count} completed`;

  if (data.failed_count > 0) {
    elements.overallCountsLabel.textContent += ` (${data.failed_count} failed)`;
  }

  if (data.status === "zipping") {
    elements.progressHeading.textContent = "Packaging ZIP file...";
    elements.progressSubtext.textContent = "Bundling all tracks with no-recompression speed.";
  }
}

function handleJobCompleted(data) {
  elements.progressHeading.textContent = "Download Complete!";
  elements.progressSubtext.textContent = `Successfully saved ${data.successful} of ${data.total} tracks.`;
  elements.btnCancelJob.classList.add("hidden");

  if (state.eventSource) {
    state.eventSource.close();
  }

  // Format ZIP size
  const mb = (data.zip_size_bytes / (1024 * 1024)).toFixed(1);
  elements.btnZipLabel.textContent = `Download ZIP (${mb} MB)`;
  elements.btnDownloadZip.href = `/api/download/zip/${data.job_id}`;
  elements.zipDeliveryCard.classList.remove("hidden");

  // Open folder button
  elements.btnOpenFolder.onclick = async () => {
    try {
      await fetch("/api/download/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: data.download_dir })
      });
      showToast("Opened download folder in Windows Explorer.", "success");
    } catch (e) {
      showToast("Could not open folder automatically.", "error");
    }
  };

  // If there are failures, offer retry
  if (data.failed > 0) {
    elements.btnRetryFailed.classList.remove("hidden");
  }

  showToast(`ZIP ready! (${mb} MB)`, "success");
}

// Cancel Job
elements.btnCancelJob.addEventListener("click", async () => {
  if (!state.activeJobId) return;
  elements.btnCancelJob.disabled = true;
  elements.btnCancelJob.textContent = "Cancelling...";
  try {
    await fetch(`/api/download/cancel/${state.activeJobId}`, { method: "POST" });
  } catch (err) {
    showToast("Cancellation error: " + err.message, "error");
  }
});

// Retry Failed Tracks
elements.btnRetryFailed.addEventListener("click", async () => {
  if (!state.activeJobId) return;
  elements.btnRetryFailed.disabled = true;
  try {
    const res = await fetch(`/api/download/retry-failed/${state.activeJobId}`, { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast(`Retrying ${data.retry_count} failed track(s)...`, "info");
      elements.btnRetryFailed.classList.add("hidden");
      elements.btnCancelJob.classList.remove("hidden");
      elements.btnCancelJob.disabled = false;
      connectEventSource(state.activeJobId);
    } else {
      showToast(data.message || "No tracks to retry", "info");
    }
  } catch (e) {
    showToast("Failed to retry: " + e.message, "error");
  } finally {
    elements.btnRetryFailed.disabled = false;
  }
});

// Start New Playlist Reset
elements.btnStartNew.addEventListener("click", () => {
  state.currentPlaylist = null;
  state.selectedIds.clear();
  state.activeJobId = null;
  if (state.eventSource) state.eventSource.close();

  elements.sectionPreview.classList.add("hidden");
  elements.sectionOptions.classList.add("hidden");
  elements.sectionProgress.classList.add("hidden");
  elements.urlInput.value = "";
  elements.platformBadge.classList.add("hidden");
  elements.btnClearUrl.classList.add("hidden");

  window.scrollTo({ top: 0, behavior: "smooth" });
  elements.urlInput.focus();
});

// Escape HTML helper
function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// -------------------------------------------------------------
// Application Bootstrap
// -------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  loadSavedOptions();
  fetchSystemStatus();
});
