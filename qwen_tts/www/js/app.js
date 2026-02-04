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

  referenceFile: $("#referenceFile"),
  referenceTranscript: $("#referenceTranscript"),
  uploadBtn: $("#uploadBtn"),
  responseTranscript: $("#responseTranscript"),
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
  connectionHint: $("#connectionHint"),

  toasts: $("#toasts")
};

let state = {
  audioObjectUrl: "",
  sessionId: ""
};

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

function setSessionId(sessionId) {
  const sid = String(sessionId || "").trim();
  state.sessionId = sid;
  setSessionMeta(sid);
  if (sid) saveSession(sid);
  else clearSession();
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

    setSessionMeta(state.sessionId);
    setOnline(els.statusDot, els.statusText, online);
    setLatency(els.latency, online ? latencyMs : NaN);

    if (!api.baseUrl && !isHomeAssistantIngress()) {
      toast(els.toasts, "Set a remote server URL to connect.", { variant: "error" });
    }
    else if (!online) toast(els.toasts, "Server unreachable (Offline).", { variant: "error" });
  } catch (e) {
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
    setSessionMeta(state.sessionId);
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

  const transcript = String(els.referenceTranscript.value || "").trim();
  if (!transcript) return toast(els.toasts, "Reference transcription is required.", { variant: "error" });

  const responseTranscript = String(els.responseTranscript.value || "").trim();

  setBusy(true);
  try {
    const api = createApiForCurrentContext();
    const { sessionId } = await api.uploadReference(file, { transcript, responseTranscript });
    setSessionId(sessionId);
    toast(els.toasts, "Uploaded. Session ID saved.", { variant: "ok" });
  } catch (e) {
    toast(els.toasts, e?.message ? String(e.message) : "Upload failed.", { variant: "error" });
  } finally {
    setBusy(false);
  }
}

async function ensureSessionId(api) {
  const current = String(state.sessionId || "").trim();
  if (current) return current;

  const file = els.referenceFile.files && els.referenceFile.files[0];
  if (!file) {
    throw new Error("Session ID is required (upload reference audio to get one).");
  }

  const transcript = String(els.referenceTranscript.value || "").trim();
  if (!transcript) {
    throw new Error("Reference transcription is required (needed for upload).");
  }

  const responseTranscript = String(els.responseTranscript.value || "").trim();

  const { sessionId } = await api.uploadReference(file, { transcript, responseTranscript });
  setSessionId(sessionId);
  return sessionId;
}

async function generate() {
  const text = String(els.responseTranscript.value || "").trim();

  if (!isHomeAssistantIngress()) {
    const baseUrl = String(els.serverUrl.value || "").trim();
    if (!baseUrl) return toast(els.toasts, "Remote server URL is required.", { variant: "error" });
  }
  if (!text) return toast(els.toasts, "Enter a response transcript.", { variant: "error" });

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
        const transcript = String(els.referenceTranscript.value || "").trim();
        const responseTranscript = String(els.responseTranscript.value || "").trim();
        const { sessionId: newSession } = await api.uploadReference(file, { transcript, responseTranscript });
        setSessionId(newSession);
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
  els.referenceTranscript.value = "";
  els.responseTranscript.value = "Hello from Qwen TTS.";

  els.refreshBtn.addEventListener("click", refresh);
  els.uploadBtn.addEventListener("click", uploadReference);
  els.generateBtn.addEventListener("click", generate);
  els.playBtn.addEventListener("click", play);

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
    setSessionId("");
    toast(els.toasts, "Cleared.", { variant: "ok" });
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
  });

  const saved = loadSavedUrl();
  els.serverUrl.value = saved;
  setSessionId(loadSavedSession());

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
