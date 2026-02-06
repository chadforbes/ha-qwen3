import { createApi } from "./api.js";
import {
  $,
  renderVoices,
  setLatency,
  setOnline,
  setPercent,
  setQueue,
  setVoiceCount,
  toast,
} from "./ui.js";

const STORAGE_KEY_URL = "qwen_tts_remote_url";

const els = {
  statusDot: $("#statusDot"),
  statusText: $("#statusText"),
  latency: $("#latency"),
  sessionMeta: $("#sessionMeta"),
  voiceCount: $("#voiceCount"),
  refreshBtn: $("#refreshBtn"),

  referenceFile: $("#referenceFile"),
  referenceTranscript: $("#referenceTranscript"),
  responseTranscript: $("#responseTranscript"),
  generateBtn: $("#generateBtn"),
  playBtn: $("#playBtn"),
  audio: $("#audio"),
  generating: $("#generating"),

  voiceName: $("#voiceName"),
  voiceDescription: $("#voiceDescription"),
  saveVoiceBtn: $("#saveVoiceBtn"),
  savingVoice: $("#savingVoice"),
  voicesList: $("#voicesList"),

  cpuValue: $("#cpuValue"),
  cpuBar: $("#cpuBar"),
  ramValue: $("#ramValue"),
  ramBar: $("#ramBar"),
  queueValue: $("#queueValue"),

  serverUrl: $("#serverUrl"),
  saveUrlBtn: $("#saveUrlBtn"),
  clearUrlBtn: $("#clearUrlBtn"),
  connectionHint: $("#connectionHint"),

  toasts: $("#toasts"),
};

let state = {
  audioObjectUrl: "",
  hasPreview: false,
  isBusy: false,
  voices: [],
};

function computeReferenceReady() {
  const file = els.referenceFile.files && els.referenceFile.files[0];
  const transcript = String(els.referenceTranscript.value || "").trim();
  return Boolean(file && transcript);
}

function updateReferenceMeta() {
  els.sessionMeta.textContent = computeReferenceReady() ? "Set" : "\u2014";
}

function isHomeAssistantIngress() {
  const path = String(window.location?.pathname || "");
  return (
    path.includes("/api/hassio_ingress/") ||
    path.includes("/api/ingress/") ||
    path.includes("/hassio/ingress/") ||
    /\/ingress(\/|$)/i.test(path)
  );
}

function createApiForCurrentContext() {
  // Under ingress, browser cross-origin fetch commonly fails due to CORS/mixed-content.
  // Use the add-on's same-origin /api proxy (configured via add-on options.remote_url).

  // Memoize to avoid creating multiple API instances, each with its own persistent WebSocket.
  // Recreate only when the effective base URL changes.
  const effectiveBaseUrl = isHomeAssistantIngress() ? "" : String(els.serverUrl.value || "").trim();
  if (!createApiForCurrentContext._cache) {
    createApiForCurrentContext._cache = { key: null, api: null };
  }
  const cache = createApiForCurrentContext._cache;
  if (!cache.api || cache.key !== effectiveBaseUrl) {
    cache.key = effectiveBaseUrl;
    cache.api = createApi(effectiveBaseUrl);
  }
  return cache.api;
}

function loadSavedUrl() {
  try {
    return localStorage.getItem(STORAGE_KEY_URL) || "";
  } catch {
    return "";
  }
}

function saveUrl(url) {
  try {
    localStorage.setItem(STORAGE_KEY_URL, url);
  } catch {
    // ignore
  }
}

function clearUrl() {
  try {
    localStorage.removeItem(STORAGE_KEY_URL);
  } catch {
    // ignore
  }
}

function setBusy(isBusy) {
  state.isBusy = Boolean(isBusy);
  els.refreshBtn.disabled = isBusy;
  els.saveUrlBtn.disabled = isBusy;
  els.clearUrlBtn.disabled = isBusy;
  els.generateBtn.disabled = isBusy;
  updateSaveVoiceEnabled();
}

function updateSaveVoiceEnabled() {
  els.saveVoiceBtn.disabled = state.isBusy || !state.hasPreview;
}

function resetAudio() {
  els.playBtn.disabled = true;
  els.audio.pause();
  els.audio.removeAttribute("src");
  els.audio.load();

  if (state.audioObjectUrl) {
    URL.revokeObjectURL(state.audioObjectUrl);
    state.audioObjectUrl = "";
  }
}

function setGenerating(isGenerating) {
  els.generating.hidden = !isGenerating;
}

function setSavingVoice(isSaving) {
  els.savingVoice.hidden = !isSaving;
}

function setVoices(raw) {
  const list = Array.isArray(raw?.voices) ? raw.voices : Array.isArray(raw) ? raw : [];
  state.voices = list;
  const voices = renderVoices(null, els.voicesList, list);
  setVoiceCount(els.voiceCount, voices.length);
}

async function refresh() {
  resetAudio();

  const api = createApiForCurrentContext();

  setBusy(true);
  let online = false;
  let latencyMs = null;

  try {
    const start = performance.now();
    const healthRes = await api.health();

    online = Boolean(healthRes && healthRes.status === "ok");
    latencyMs = performance.now() - start;

    // The backend health endpoint does not expose CPU/RAM/queue metrics.
    setPercent(els.cpuValue, els.cpuBar, NaN);
    setPercent(els.ramValue, els.ramBar, NaN);
    setQueue(els.queueValue, null);

    try {
      const voicesRes = await api.voices();
      setVoices(voicesRes);
    } catch {
      setVoiceCount(els.voiceCount, NaN);
      renderVoices(null, els.voicesList, []);
    }

    updateReferenceMeta();
    setOnline(els.statusDot, els.statusText, online);
    setLatency(els.latency, online ? latencyMs : NaN);

    if (!api.baseUrl && !isHomeAssistantIngress()) {
      toast(els.toasts, "Set a remote server URL to connect.", { variant: "error" });
    } else if (!online) {
      toast(els.toasts, "Server unreachable (Offline).", { variant: "error" });
    }
  } catch (e) {
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
    updateReferenceMeta();
    setPercent(els.cpuValue, els.cpuBar, NaN);
    setPercent(els.ramValue, els.ramBar, NaN);
    setQueue(els.queueValue, null);
    setVoiceCount(els.voiceCount, NaN);
    renderVoices(null, els.voicesList, []);

    const msg = e?.message ? String(e.message) : "Refresh failed.";
    if (isHomeAssistantIngress() && /failed to fetch/i.test(msg)) {
      toast(
        els.toasts,
        "Fetch blocked by browser (CORS/mixed-content). Configure the add-on 'remote_url' option.",
        { variant: "error" }
      );
    } else {
      toast(els.toasts, msg, { variant: "error" });
    }
  } finally {
    setBusy(false);
  }
}

async function saveVoice() {
  if (!isHomeAssistantIngress()) {
    const baseUrl = String(els.serverUrl.value || "").trim();
    if (!baseUrl) return toast(els.toasts, "Remote server URL is required.", { variant: "error" });
  }

  if (!state.hasPreview) {
    return toast(els.toasts, "Generate a preview first, then save the voice.", { variant: "error" });
  }

  const name = String(els.voiceName.value || "").trim();
  if (!name) return toast(els.toasts, "Voice name is required.", { variant: "error" });

  const description = String(els.voiceDescription.value || "").trim();

  setBusy(true);
  setSavingVoice(true);

  try {
    const api = createApiForCurrentContext();
    const saved = await api.saveVoice({ name, description });
    const vid =
      saved && typeof saved === "object"
        ? typeof saved.voice_id === "string"
          ? saved.voice_id
          : typeof saved.voiceId === "string"
            ? saved.voiceId
            : typeof saved.id === "string"
              ? saved.id
              : ""
        : "";
    toast(els.toasts, `Voice saved${vid ? `: ${vid}` : ""}.`, { variant: "ok" });

    // Update the UI immediately from the WS response.
    // This keeps the dashboard responsive even if GET /voices is slow/unavailable.
    if (vid) {
      const exists = state.voices.some(
        (v) => v && typeof v === "object" && String(v.voice_id || v.voiceId || v.id || "") === vid
      );
      if (!exists) {
        state.voices = [...state.voices, { voice_id: vid, name, description }];
        setVoices(state.voices);
      }
    }

    // Session upload folder is consumed/moved by save_voice; require a new preview for another save.
    state.hasPreview = false;
    updateSaveVoiceEnabled();

    try {
      const voicesRes = await api.voices();
      setVoices(voicesRes);
    } catch (e) {
      const msg = e?.message ? String(e.message) : "Failed to refresh voices.";
      toast(els.toasts, `Voice saved, but voice list refresh failed: ${msg}`, { variant: "error" });
    }
  } catch (e) {
    const msg = e?.message ? String(e.message) : "Save voice failed.";
    if (isHomeAssistantIngress() && /failed to fetch/i.test(msg)) {
      toast(
        els.toasts,
        "Fetch blocked by browser (CORS/mixed-content). Configure the add-on 'remote_url' option.",
        { variant: "error" }
      );
    } else {
      toast(els.toasts, msg, { variant: "error" });
    }
  } finally {
    setSavingVoice(false);
    setBusy(false);
  }
}

async function generate() {
  if (!isHomeAssistantIngress()) {
    const baseUrl = String(els.serverUrl.value || "").trim();
    if (!baseUrl) return toast(els.toasts, "Remote server URL is required.", { variant: "error" });
  }

  const file = els.referenceFile.files && els.referenceFile.files[0];
  if (!file) return toast(els.toasts, "Choose a reference audio file first.", { variant: "error" });

  const transcript = String(els.referenceTranscript.value || "").trim();
  if (!transcript) return toast(els.toasts, "Reference transcription is required.", { variant: "error" });

  const text = String(els.responseTranscript.value || "").trim();
  if (!text) return toast(els.toasts, "Enter a response transcript.", { variant: "error" });

  resetAudio();
  state.hasPreview = false;
  setBusy(true);
  setGenerating(true);

  try {
    const api = createApiForCurrentContext();
    const result = await api.preview({ file, transcription: transcript, responseText: text });
    state.hasPreview = true;
    updateSaveVoiceEnabled();
    state.audioObjectUrl = URL.createObjectURL(result.blob);
    els.audio.src = state.audioObjectUrl;

    els.playBtn.disabled = false;
    toast(els.toasts, "Audio generated.", { variant: "ok" });
  } catch (e) {
    const msg = e?.message ? String(e.message) : "Generate failed.";
    if (isHomeAssistantIngress() && /failed to fetch/i.test(msg)) {
      toast(
        els.toasts,
        "Fetch blocked by browser (CORS/mixed-content). Configure the add-on 'remote_url' option.",
        { variant: "error" }
      );
    } else {
      toast(els.toasts, msg, { variant: "error" });
    }
  } finally {
    setGenerating(false);
    setBusy(false);
  }
}

function play() {
  if (els.playBtn.disabled) return;
  els.audio.play().catch(() => toast(els.toasts, "Unable to play audio.", { variant: "error" }));
}

function init() {
  els.referenceTranscript.value = "";
  els.responseTranscript.value = "Hello from Qwen TTS.";
  els.voiceName.value = "";
  els.voiceDescription.value = "";

  setGenerating(false);
  setSavingVoice(false);
  setVoiceCount(els.voiceCount, NaN);
  renderVoices(null, els.voicesList, []);

  els.refreshBtn.addEventListener("click", refresh);
  els.generateBtn.addEventListener("click", generate);
  els.playBtn.addEventListener("click", play);
  els.saveVoiceBtn.addEventListener("click", saveVoice);

  els.referenceFile.addEventListener("change", () => {
    state.hasPreview = false;
    updateReferenceMeta();
    updateSaveVoiceEnabled();
  });
  els.referenceTranscript.addEventListener("input", () => {
    state.hasPreview = false;
    updateReferenceMeta();
    updateSaveVoiceEnabled();
  });

  els.saveUrlBtn.addEventListener("click", () => {
    const url = String(els.serverUrl.value || "").trim();
    saveUrl(url);
    toast(els.toasts, "Saved.", { variant: "ok" });
    refresh();
  });

  els.clearUrlBtn.addEventListener("click", () => {
    els.serverUrl.value = "";
    clearUrl();
    resetAudio();
    updateReferenceMeta();
    toast(els.toasts, "Cleared.", { variant: "ok" });
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
  });

  const saved = loadSavedUrl();
  els.serverUrl.value = saved;
  updateReferenceMeta();
  updateSaveVoiceEnabled();

  if (isHomeAssistantIngress()) {
    els.serverUrl.disabled = true;
    els.saveUrlBtn.disabled = true;
    els.clearUrlBtn.disabled = true;
    els.serverUrl.value = "";
    els.serverUrl.placeholder = "Configured in add-on settings";
    if (els.connectionHint) {
      els.connectionHint.textContent = "Under Home Assistant ingress, this is configured in the add-on options (remote_url).";
    }
  }

  if (saved) refresh();
}

init();