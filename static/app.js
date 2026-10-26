/**
 * Music Playlist Downloader - Professional Client Controller
 */

const state = {
  systemStatus: {
    ffmpeg_installed: false,
    deno_installed: false,
    ytdlp_version: "...",
    ffmpeg_path: null,
    deno_path: null
  },
  currentPlaylist: null,
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

  // Toggles
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

  // Download action
  btnStartDownload: document.getElementById("btn-start-download"),
  btnDownloadLabel: document.getElementById("btn-download-label"),

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

    updateSysBadge(el.ffmpegPill, data.ffmpeg_installed, "FFmpeg");
    updateSysBadge(el.denoPill, data.deno_installed, "Deno");
    el.ytdlpVersionLabel.textContent = `yt-dlp v${data.ytdlp_version}`;

    if (!data.ffmpeg_installed || !data.deno_installed) {
      el.warningBanner.classList.remove("hidden");
      el.warningCommands.innerHTML = "";
      if (!data.ffmpeg_installed) {
        const c1 = document.createElement("code");
        c1.textContent = data.winget_ffmpeg_cmd;
        c1.onclick = () => copyText(data.winget_ffmpeg_cmd);
        el.warningCommands.appendChild(c1);
      }
      if (!data.deno_installed) {
        const c2 = document.createElement("code");
        c2.textContent = data.winget_deno_cmd;
        c2.onclick = () => copyText(data.winget_deno_cmd);
        el.warningCommands.appendChild(c2);
      }
    } else {
      el.warningBanner.classList.add("hidden");
    }
  } catch (err) {
    console.error("System status check error:", err);
  }
}

function updateSysBadge(badge, isOk, label) {
  badge.className = `sys-badge ${isOk ? "sys-ok" : "sys-bad"}`;
  badge.textContent = `${label} ${isOk ? "✓" : "Missing"}`;
  badge.title = isOk ? `${label} is ready` : `${label} is missing on PC`;
}

function copyText(txt) {
  navigator.clipboard.writeText(txt);
  showToast(`Copied: ${txt}`, "success");
}

el.btnUpdateYtdlp.addEventListener("click", async () => {
  const btn = el.btnUpdateYtdlp;
  btn.disabled = true;
  btn.textContent = "Updating...";
  try {
    const res = await fetch("/api/update-ytdlp", { method: "POST" });
    const data = await res.json();
    if (data.success) {
      showToast(`Updated yt-dlp: ${data.new_version}`, "success");
      el.ytdlpVersionLabel.textContent = `yt-dlp v${data.new_version}`;
    } else {
      showToast("yt-dlp is already up to date.", "info");
    }
  } catch (e) {
    showToast(`Update error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Update";
  }
});

el.btnRecheckTools.addEventListener("click", () => {
  fetchSystemStatus();
  showToast("Re-checking system tools...", "info");
});

// -------------------------------------------------------------
// Options Persistence
// -------------------------------------------------------------
function saveOptions() {
  try {
    localStorage.setItem("ymp_options_v2", JSON.stringify(state.options));
  } catch (e) {}
}

function loadSavedOptions() {
  try {
    const saved = localStorage.getItem("ymp_options_v2");
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
    el.controlEmbedSubs.classList.remove("hidden");
  } else {
    el.optTypeAudio.classList.add("active");
    el.optTypeVideo.classList.remove("active");
    el.audioOptionsPanel.classList.remove("hidden");
    el.videoOptionsPanel.classList.add("hidden");
    el.controlEmbedSubs.classList.add("hidden");
  }

  document.querySelectorAll("#audio-format-group .chip-btn").forEach(p => {
    p.classList.toggle("active", p.dataset.val === o.audio_format);
  });
  el.selectAudioQuality.value = o.audio_quality;

  document.querySelectorAll("#video-format-group .chip-btn").forEach(p => {
    p.classList.toggle("active", p.dataset.val === o.video_format);
  });
  el.selectVideoQuality.value = o.video_quality;

  el.toggleMetadata.checked = o.embed_metadata;
  el.toggleCover.checked = o.embed_cover_art;
  el.toggleSaveThumbs.checked = o.save_thumbnails;
  el.togglePrefixIndex.checked = o.prefix_index;
  el.toggleSkipExisting.checked = o.skip_existing;
  el.toggleSubtitles.checked = o.embed_subtitles;

  el.inputFilenameTemplate.value = o.filename_template;
  el.selectCookiesBrowser.value = o.browser_cookies || "";
  el.sliderConcurrency.value = o.concurrency;
  el.valConcurrency.textContent = o.concurrency;
  el.inputRateLimit.value = o.rate_limit || "";
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

document.querySelectorAll("#audio-format-group .chip-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.options.audio_format = btn.dataset.val;
    applyOptionsToUI();
    saveOptions();
  });
});

el.selectAudioQuality.addEventListener("change", (e) => {
  state.options.audio_quality = e.target.value;
  saveOptions();
  updateLiveCounter();
});

document.querySelectorAll("#video-format-group .chip-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    state.options.video_format = btn.dataset.val;
    applyOptionsToUI();
    saveOptions();
  });
});

el.selectVideoQuality.addEventListener("change", (e) => {
  state.options.video_quality = e.target.value;
  saveOptions();
  updateLiveCounter();
});

el.toggleMetadata.addEventListener("change", e => { state.options.embed_metadata = e.target.checked; saveOptions(); });
el.toggleCover.addEventListener("change", e => { state.options.embed_cover_art = e.target.checked; saveOptions(); });
el.toggleSaveThumbs.addEventListener("change", e => { state.options.save_thumbnails = e.target.checked; saveOptions(); });
el.togglePrefixIndex.addEventListener("change", e => { state.options.prefix_index = e.target.checked; saveOptions(); });
el.toggleSkipExisting.addEventListener("change", e => { state.options.skip_existing = e.target.checked; saveOptions(); });
el.toggleSubtitles.addEventListener("change", e => { state.options.embed_subtitles = e.target.checked; saveOptions(); });

el.inputFilenameTemplate.addEventListener("input", e => { state.options.filename_template = e.target.value; saveOptions(); });
el.selectCookiesBrowser.addEventListener("change", e => { state.options.browser_cookies = e.target.value; saveOptions(); });
el.sliderConcurrency.addEventListener("input", e => {
  state.options.concurrency = parseInt(e.target.value, 10);
  el.valConcurrency.textContent = e.target.value;
  saveOptions();
});
el.inputRateLimit.addEventListener("input", e => { state.options.rate_limit = e.target.value.trim(); saveOptions(); });

// -------------------------------------------------------------
// URL Detection & Auto-Fetch
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
  if (platform) {
    el.platformBadge.textContent = platform;
    el.platformBadge.classList.remove("hidden");
  } else {
    el.platformBadge.classList.add("hidden");
  }

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

el.btnClearUrl.addEventListener("click", () => {
  el.urlInput.value = "";
  el.btnClearUrl.classList.add("hidden");
  el.platformBadge.classList.add("hidden");
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

  el.previewEmptyState.classList.add("hidden");
  el.previewSkeleton.classList.remove("hidden");
  el.playlistLoadedWrap.classList.add("hidden");

  const btnSpinner = el.btnFetch.querySelector(".btn-spinner");
  const btnText = el.btnFetch.querySelector(".btn-text");
  btnSpinner.classList.remove("hidden");
  btnText.textContent = "...";
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
    state.currentPlaylist = data;

    state.selectedIds.clear();
    data.items.forEach(item => {
      if (item.available) state.selectedIds.add(item.id);
    });

    renderPlaylistHeader(data);
    renderTracklistTable(data.items);

    el.playlistLoadedWrap.classList.remove("hidden");
    showToast(`Loaded ${data.total_count} track(s)`, "success");

  } catch (err) {
    showToast(err.message, "error");
    el.previewEmptyState.classList.remove("hidden");
  } finally {
    el.previewSkeleton.classList.add("hidden");
    btnSpinner.classList.add("hidden");
    btnText.textContent = "Fetch";
    el.btnFetch.disabled = false;
  }
}

function renderPlaylistHeader(data) {
  el.playlistCover.src = data.thumbnail || "https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=200";
  el.playlistPlatformPill.textContent = data.platform;
  el.playlistTitle.textContent = data.title;
  el.playlistUploader.textContent = data.uploader;
  el.playlistCount.textContent = `${data.total_count} tracks`;
  el.playlistDuration.textContent = data.total_duration_formatted;
  updateLiveCounter();
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
      <td class="col-status">
        ${item.available 
          ? `<span class="badge-ok">Ready</span>`
          : `<span class="badge-err" title="${item.unavailable_reason || 'Unavailable'}">${escapeHtml(item.unavailable_reason || 'Private')}</span>`
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

  el.selectedCountLabel.textContent = `${sel} of ${total} selected`;
  el.btnDownloadLabel.textContent = `Download Selected (${sel} Tracks)`;
  el.btnStartDownload.disabled = sel === 0;

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
  el.selectedSizeEstimate.textContent = `~${mb} MB est.`;
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

el.btnApplyFirstN.addEventListener("click", () => {
  const n = parseInt(el.inputFirstN.value, 10);
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
});

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

el.trackFilterInput.addEventListener("input", () => {
  if (state.currentPlaylist) {
    renderTracklistTable(state.currentPlaylist.items);
  }
});

// -------------------------------------------------------------
// Start Download & SSE Progress Streaming
// -------------------------------------------------------------
el.btnStartDownload.addEventListener("click", async () => {
  if (!state.currentPlaylist || state.selectedIds.size === 0) return;

  const selectedTracks = state.currentPlaylist.items.filter(i => state.selectedIds.has(i.id));

  // Show progress section in right panel
  el.sectionProgress.classList.remove("hidden");
  el.zipDeliveryCard.classList.add("hidden");
  el.btnRetryFailed.classList.add("hidden");
  el.btnCancelJob.disabled = false;
  el.btnCancelJob.classList.remove("hidden");

  // Reset progress bar
  el.overallBarFill.style.width = "0%";
  el.overallPercentLabel.textContent = "0%";
  el.overallCountsLabel.textContent = `0 of ${selectedTracks.length} finished`;
  el.progressHeading.textContent = `Downloading "${state.currentPlaylist.title}"`;
  el.progressSubtext.textContent = `Processing ${selectedTracks.length} selected items...`;

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
    // Connection finished or disconnected
  };
}

function handleSSEMessage(data) {
  if (data.type === "init") {
    if (data.tracks) {
      Object.values(data.tracks).forEach(t => updateLiveQueueRow(t));
    }
  } else if (data.type === "track_update") {
    updateLiveQueueRow(data.track);
  } else if (data.type === "overall_update") {
    updateOverallProgress(data);
  } else if (data.type === "cancelled") {
    el.progressHeading.textContent = "Download Cancelled";
    el.progressSubtext.textContent = "Active downloads halted and temporary files cleaned.";
    el.btnCancelJob.disabled = true;
    showToast("Download cancelled.", "info");
    if (state.eventSource) state.eventSource.close();
  } else if (data.type === "completed") {
    handleJobCompleted(data);
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
  } else if (t.status === "converting") {
    pill.textContent = t.eta || "Converting";
    if (speed) speed.textContent = "ffmpeg";
  } else if (t.status === "done") {
    pill.textContent = "Done ✓";
    if (speed) speed.textContent = "";
  } else if (t.status === "failed") {
    pill.textContent = "Failed ✕";
    pill.title = t.error || "Failed";
    if (speed) speed.textContent = t.error ? t.error.slice(0, 14) : "";
  } else if (t.status === "skipped") {
    pill.textContent = "Skipped";
    if (speed) speed.textContent = "";
  }
}

function updateOverallProgress(data) {
  el.overallBarFill.style.width = `${data.percent}%`;
  el.overallPercentLabel.textContent = `${data.percent}%`;
  el.overallCountsLabel.textContent = `${data.completed_count} of ${data.total_count} finished`;

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
  el.btnCancelJob.classList.add("hidden");

  if (state.eventSource) state.eventSource.close();

  const mb = (data.zip_size_bytes / (1024 * 1024)).toFixed(1);
  const zipUrl = `/api/download/zip/${data.job_id}`;

  // Update Top ZIP Button (User Request: "and zip download button at top")
  el.topZipLabel.textContent = `Download ZIP (${mb} MB)`;
  el.topZipBtn.href = zipUrl;
  el.topZipBtn.classList.remove("hidden");

  // Also update progress card button
  el.btnZipLabel.textContent = `Download ZIP (${mb} MB)`;
  el.btnDownloadZip.href = zipUrl;
  el.zipDeliveryCard.classList.remove("hidden");

  // Open Folder handler
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

// Retry Failed
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

// Start New
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
  el.platformBadge.classList.add("hidden");
  el.btnClearUrl.classList.add("hidden");

  el.btnDownloadLabel.textContent = "Download Selected (0 Tracks)";
  el.btnStartDownload.disabled = true;
  el.urlInput.focus();
});

// Escape HTML helper
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
});
