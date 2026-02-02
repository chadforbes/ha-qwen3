import { createApi } from "./api.js";
import { $, renderVoices, setLatency, setOnline, setPercent, setQueue, setVoiceCount, toast } from "./ui.js";

const STORAGE_KEY_URL = "qwen_tts_remote_url";

const els = {
  statusDot: $("#statusDot"),
  statusText: $("#statusText"),
  latency: $("#latency"),
  voiceCount: $("#voiceCount"),
  refreshBtn: $("#refreshBtn"),

  voiceSelect: $("#voiceSelect"),
  previewText: $("#previewText"),
  generateBtn: $("#generateBtn"),
  playBtn: $("#playBtn"),
  audio: $("#audio"),

  cpuValue: $("#cpuValue"),
  cpuBar: $("#cpuBar"),
  ramValue: $("#ramValue"),
  ramBar: $("#ramBar"),
  queueValue: $("#queueValue"),

  voicesList: $("#voicesList"),

  serverUrl: $("#serverUrl"),
  saveUrlBtn: $("#saveUrlBtn"),
  clearUrlBtn: $("#clearUrlBtn"),

  toasts: $("#toasts")
};

let state = {
  voices: [],
  audioObjectUrl: ""
};

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

async function refresh() {
  const baseUrl = String(els.serverUrl.value || "").trim();
  resetAudio();

  const api = createApi(baseUrl);

  setBusy(true);
  let online = false;
  let latencyMs = null;

  try {
    const start = performance.now();
    const [statusRes, voicesRes] = await Promise.allSettled([api.status(), api.voices()]);

    if (statusRes.status === "fulfilled") {
      online = true;
      latencyMs = performance.now() - start;

      const status = statusRes.value ?? {};
      const cpu = parsePercent(getMetric(status, ["cpu", "cpu_usage", "cpuPercent", "cpu_percent"]));
      const ram = parsePercent(getMetric(status, ["ram", "ram_usage", "memory", "memory_usage", "ramPercent", "ram_percent"]));
      const queue = getMetric(status, ["queue", "queue_size", "queueSize"]);

      setPercent(els.cpuValue, els.cpuBar, cpu ?? NaN);
      setPercent(els.ramValue, els.ramBar, ram ?? NaN);
      setQueue(els.queueValue, queue);
    } else {
      setPercent(els.cpuValue, els.cpuBar, NaN);
      setPercent(els.ramValue, els.ramBar, NaN);
      setQueue(els.queueValue, null);
    }

    state.voices = voicesRes.status === "fulfilled" ? voicesRes.value : [];
    const rendered = renderVoices(els.voiceSelect, els.voicesList, state.voices);

    setVoiceCount(els.voiceCount, rendered.length);
    setOnline(els.statusDot, els.statusText, online);
    setLatency(els.latency, online ? latencyMs : NaN);

    if (!baseUrl) toast(els.toasts, "Set a remote server URL to connect.", { variant: "error" });
    else if (!online) toast(els.toasts, "Server unreachable (Offline).", { variant: "error" });
  } catch (e) {
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
    setVoiceCount(els.voiceCount, NaN);
    setPercent(els.cpuValue, els.cpuBar, NaN);
    setPercent(els.ramValue, els.ramBar, NaN);
    setQueue(els.queueValue, null);
    state.voices = [];
    toast(els.toasts, e?.message ? String(e.message) : "Refresh failed.", { variant: "error" });
  } finally {
    setBusy(false);
  }
}

async function generate() {
  const baseUrl = String(els.serverUrl.value || "").trim();
  const voice = String(els.voiceSelect.value || "").trim();
  const text = String(els.previewText.value || "").trim();

  if (!baseUrl) return toast(els.toasts, "Remote server URL is required.", { variant: "error" });
  if (!voice) return toast(els.toasts, "Select a voice first.", { variant: "error" });
  if (!text) return toast(els.toasts, "Enter some text to preview.", { variant: "error" });

  resetAudio();
  setBusy(true);

  try {
    const api = createApi(baseUrl);
    const result = await api.tts({ voice, text });

    if (result.kind === "blob") {
      state.audioObjectUrl = URL.createObjectURL(result.blob);
      els.audio.src = state.audioObjectUrl;
    } else {
      els.audio.src = result.url;
    }

    els.playBtn.disabled = false;
    toast(els.toasts, "Audio generated.", { variant: "ok" });
  } catch (e) {
    toast(els.toasts, e?.message ? String(e.message) : "Generate failed.", { variant: "error" });
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
    toast(els.toasts, "Cleared.", { variant: "ok" });
    setOnline(els.statusDot, els.statusText, false);
    setLatency(els.latency, NaN);
    setVoiceCount(els.voiceCount, NaN);
  });

  const saved = loadSavedUrl();
  els.serverUrl.value = saved;
  renderVoices(els.voiceSelect, els.voicesList, []);

  if (saved) refresh();
}

init();
