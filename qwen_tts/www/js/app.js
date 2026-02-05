import { createApi } from "./api.js";
import { $, setLatency, setOnline, setPercent, setQueue, toast } from "./ui.js";

const STORAGE_KEY_URL = "qwen_tts_remote_url";

const els = {
  statusDot: $("#statusDot"),
  statusText: $("#statusText"),
  latency: $("#latency"),
  sessionMeta: $("#sessionMeta"),
  refreshBtn: $("#refreshBtn"),

  referenceFile: $("#referenceFile"),
  referenceTranscript: $("#referenceTranscript"),
  responseTranscript: $("#responseTranscript"),
  generateBtn: $("#generateBtn"),
  playBtn: $("#playBtn"),
  audio: $("#audio"),
  generating: $("#generating"),

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
  if (isHomeAssistantIngress()) return createApi("");

  const baseUrl = String(els.serverUrl.value || "").trim();
  return createApi(baseUrl);
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
  els.refreshBtn.disabled = isBusy;
  els.saveUrlBtn.disabled = isBusy;
  els.clearUrlBtn.disabled = isBusy;
  els.generateBtn.disabled = isBusy;
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
  setBusy(true);
  setGenerating(true);

  try {
    const api = createApiForCurrentContext();
    const blob = await api.preview({ file, transcription: transcript, responseText: text });
    state.audioObjectUrl = URL.createObjectURL(blob);
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

  setGenerating(false);

  els.refreshBtn.addEventListener("click", refresh);
  els.generateBtn.addEventListener("click", generate);
  els.playBtn.addEventListener("click", play);

  els.referenceFile.addEventListener("change", updateReferenceMeta);
  els.referenceTranscript.addEventListener("input", updateReferenceMeta);

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