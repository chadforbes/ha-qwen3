import { createApi } from "./api.js";
import { $, setLatency, setOnline, setPercent, setQueue, toast } from "./ui.js";

const STORAGE_KEY_URL = "qwen_tts_remote_url";
const STORAGE_KEY_SESSION = "qwen_tts_session_id";

const els = {
  statusDot: $("#statusDot"),
  statusText: $("#statusText"),
  latency: $("#latency"),
  sessionMeta: $("#sessionMeta"),
  refreshBtn: $("#refreshBtn"),

  sessionId: $("#sessionId"),
  referenceFile: $("#referenceFile"),
  uploadBtn: $("#uploadBtn"),
  previewText: $("#previewText"),
  generateBtn: $("#generateBtn"),
  playBtn: $("#playBtn"),
  audio: $("#audio"),

  cpuValue: $("#cpuValue"),
  cpuBar: $("#cpuBar"),
  ramValue: $("#ramValue"),
  ramBar: $("#ramBar"),
  queueValue: $("#queueValue"),

  serverUrl: $("#serverUrl"),
  saveUrlBtn: $("#saveUrlBtn"),
  clearUrlBtn: $("#clearUrlBtn"),

  toasts: $("#toasts")
};

let state = {
  audioObjectUrl: ""
};

function isHomeAssistantIngress() {
  const path = String(window.location?.pathname || "");
  return path.includes("/api/hassio_ingress/") || path.includes("/api/ingress/");
}

function createApiForCurrentContext() {
  // Under ingress, browser cross-origin fetch/ws commonly fails due to CORS/mixed-content.
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

function loadSavedSession() {
  try {
    return localStorage.getItem(STORAGE_KEY_SESSION) || "";
  } catch {
    return "";
  }
}

function saveSession(sessionId) {
  try {
    localStorage.setItem(STORAGE_KEY_SESSION, sessionId);
  } catch {
    // ignore
  }
}

function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY_SESSION);
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
  els.uploadBtn.disabled = isBusy;
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

function parsePercent(value) {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getMetric(data, keys) {
  for (const key of keys) {
    if (data && Object.prototype.hasOwnProperty.call(data, key)) return data[key];
  }
  return null;
}

function setSessionMeta(sessionId) {
  const sid = String(sessionId || "").trim();
  els.sessionMeta.textContent = sid ? "Set" : "—";
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

    // The updated backend health endpoint does not expose CPU/RAM/queue metrics.
    setPercent(els.cpuValue, els.cpuBar, NaN);
    setPercent(els.ramValue, els.ramBar, NaN);
    setQueue(els.queueValue, null);

    setSessionMeta(els.sessionId.value);
    setOnline(els.statusDot, els.statusText, online);
    setLatency(els.latency, online ? latencyMs : NaN);

    if (!api.baseUrl && !isHomeAssistantIngress()) {
      toast(els.toasts, "Set a remote server URL to connect.", { variant: "error" });
    }
    else if (!online) toast(els.toasts, "Server unreachable (Offline).", { variant: "error" });
  } catch (e) {
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
    setSessionMeta(els.sessionId.value);
    setPercent(els.cpuValue, els.cpuBar, NaN);
    setPercent(els.ramValue, els.ramBar, NaN);
    setQueue(els.queueValue, null);
    const msg = e?.message ? String(e.message) : "Refresh failed.";
    if (isHomeAssistantIngress() && /failed to fetch/i.test(msg)) {
      toast(els.toasts, "Fetch blocked by browser (CORS/mixed-content). Configure the add-on 'remote_url' option.", { variant: "error" });
    } else {
      toast(els.toasts, msg, { variant: "error" });
    }
  } finally {
    setBusy(false);
  }
}

async function uploadReference() {
  if (!isHomeAssistantIngress()) {
    const baseUrl = String(els.serverUrl.value || "").trim();
    if (!baseUrl) return toast(els.toasts, "Remote server URL is required.", { variant: "error" });
  }

  const file = els.referenceFile.files && els.referenceFile.files[0];
  if (!file) return toast(els.toasts, "Choose a reference audio file first.", { variant: "error" });

  setBusy(true);
  try {
    const api = createApiForCurrentContext();
    const { sessionId } = await api.uploadReference(file);
    els.sessionId.value = sessionId;
    saveSession(sessionId);
    setSessionMeta(sessionId);
    toast(els.toasts, "Uploaded. Session ID saved.", { variant: "ok" });
  } catch (e) {
    toast(els.toasts, e?.message ? String(e.message) : "Upload failed.", { variant: "error" });
  } finally {
    setBusy(false);
  }
}

async function ensureSessionId(api) {
  const current = String(els.sessionId.value || "").trim();
  if (current) return current;

  const file = els.referenceFile.files && els.referenceFile.files[0];
  if (!file) {
    throw new Error("Session ID is required (upload reference audio to get one).");
  }

  const { sessionId } = await api.uploadReference(file);
  els.sessionId.value = sessionId;
  saveSession(sessionId);
  setSessionMeta(sessionId);
  return sessionId;
}

async function generate() {
  const text = String(els.previewText.value || "").trim();

  if (!isHomeAssistantIngress()) {
    const baseUrl = String(els.serverUrl.value || "").trim();
    if (!baseUrl) return toast(els.toasts, "Remote server URL is required.", { variant: "error" });
  }
  if (!text) return toast(els.toasts, "Enter some text to preview.", { variant: "error" });

  resetAudio();
  setBusy(true);

  try {
    const api = createApiForCurrentContext();

    const sessionId = await ensureSessionId(api);
    try {
      const result = await api.generatePreview({ sessionId, text });
      els.audio.src = result.audioUrl;
    } catch (err) {
      // If session is stale/invalid and a reference file exists, refresh session once and retry.
      const file = els.referenceFile.files && els.referenceFile.files[0];
      const msg = err?.message ? String(err.message) : "";
      const looksSessionRelated = /session|invalid|not[_\s-]?found/i.test(msg);
      if (file && looksSessionRelated) {
        const { sessionId: newSession } = await api.uploadReference(file);
        els.sessionId.value = newSession;
        saveSession(newSession);
        setSessionMeta(newSession);
        const result2 = await api.generatePreview({ sessionId: newSession, text });
        els.audio.src = result2.audioUrl;
      } else {
        throw err;
      }
    }

    els.playBtn.disabled = false;
    toast(els.toasts, "Audio generated.", { variant: "ok" });
  } catch (e) {
    const msg = e?.message ? String(e.message) : "Generate failed.";
    if (isHomeAssistantIngress() && /failed to fetch/i.test(msg)) {
      toast(els.toasts, "Fetch blocked by browser (CORS/mixed-content). Configure the add-on 'remote_url' option.", { variant: "error" });
    } else {
      toast(els.toasts, msg, { variant: "error" });
    }
  } finally {
    setBusy(false);
  }
}

function play() {
  if (els.playBtn.disabled) return;
  els.audio.play().catch(() => toast(els.toasts, "Unable to play audio.", { variant: "error" }));
}

function init() {
  els.previewText.value = "Hello from Qwen TTS.";

  els.refreshBtn.addEventListener("click", refresh);
  els.uploadBtn.addEventListener("click", uploadReference);
  els.generateBtn.addEventListener("click", generate);
  els.playBtn.addEventListener("click", play);

  els.sessionId.addEventListener("input", () => {
    const sid = String(els.sessionId.value || "").trim();
    setSessionMeta(sid);
    if (sid) saveSession(sid);
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
    els.sessionId.value = "";
    clearSession();
    setSessionMeta(els.sessionId.value);
    toast(els.toasts, "Cleared.", { variant: "ok" });
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
  });

  const saved = loadSavedUrl();
  els.serverUrl.value = saved;
  els.sessionId.value = loadSavedSession();
  setSessionMeta(els.sessionId.value);

  if (saved) refresh();
}

init();
