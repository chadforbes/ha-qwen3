const DEFAULT_TIMEOUT_MS = 12000;
// IMPORTANT: no leading slash.
// Under Home Assistant ingress, the add-on is mounted at a tokenized path like:
//   /api/hassio_ingress/<token>/
// Using absolute paths ("/api/...") would hit Home Assistant Core API instead.
const PROXY_PREFIX = "api";

function normalizeBaseUrl(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "";
  const withoutTrailing = trimmed.replace(/\/+$/, "");
  if (/^https?:\/\//i.test(withoutTrailing)) return withoutTrailing;
  // Allow entering bare host:port (e.g. 192.168.30.185:8000)
  if (/^[^\s/]+(:\d+)?(\/.*)?$/i.test(withoutTrailing)) return `http://${withoutTrailing}`;
  return withoutTrailing;
}

function withTimeout(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(id) };
}

function toWebSocketUrl(httpUrl) {
  const u = new URL(String(httpUrl), window.location.href);
  if (u.protocol === "https:") u.protocol = "wss:";
  else u.protocol = "ws:";
  return u.toString();
}

function headerGetCaseInsensitive(headers, name) {
  if (!headers || typeof headers.get !== "function") return "";
  const direct = headers.get(name);
  if (direct) return direct;
  // Some runtimes normalize header casing; try a few common variants.
  const variants = [
    String(name || ""),
    String(name || "").toLowerCase(),
    String(name || "").toUpperCase(),
  ];
  for (const v of variants) {
    const val = headers.get(v);
    if (val) return val;
  }
  return "";
}

function extractPreviewSessionId(res) {
  if (!res || !res.headers) return "";
  // Not (yet) standardized in docs; support a few reasonable header names.
  const candidates = [
    "x-session-id",
    "x-preview-session-id",
    "x-upload-session-id",
    "x-qwen-session-id",
    "session-id",
  ];
  for (const name of candidates) {
    const raw = headerGetCaseInsensitive(res.headers, name);
    const sid = String(raw || "").trim();
    if (sid) return sid;
  }
  return "";
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function createApi(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = normalizeBaseUrl(baseUrl);
  const isProxy = !base;

  function proxyJoin(path) {
    const p = String(path || "").replace(/^\/+/, "");
    return `${PROXY_PREFIX}/${p}`;
  }

  async function request(path, { method = "GET" } = {}) {
    const url = isProxy ? proxyJoin(path) : `${base}${path}`;
    const t = withTimeout(timeoutMs);
    try {
      const res = await fetch(url, { method, signal: t.signal });
      return res;
    } finally {
      t.cancel();
    }
  }

  function resolveHttpUrl(path) {
    return isProxy ? new URL(proxyJoin(path), window.location.href).toString() : `${base}${path}`;
  }

  function resolveWsUrl(path) {
    return toWebSocketUrl(resolveHttpUrl(path));
  }

  return {
    baseUrl: base,

    async health() {
      const res = await request("/health");
      if (!res.ok) throw new Error(`Health request failed (${res.status})`);
      const data = await safeJson(res);
      return data ?? {};
    },

    async voices() {
      const res = await request("/voices");
      if (!res.ok) throw new Error(`Voices request failed (${res.status})`);
      const data = await safeJson(res);
      return data ?? {};
    },

    async upload({ file, transcription }) {
      if (!(file instanceof Blob)) throw new Error("Reference audio file is required.");

      const form = new FormData();
      form.append("file", file, file.name || "source.wav");
      // Best-effort: newer servers may accept transcription alongside upload.
      const t = String(transcription || "").trim();
      if (t) form.append("transcription", t);

      const url = resolveHttpUrl("/upload");
      // Upload can be slow; do not impose a client-side timeout here.
      const res = await fetch(url, { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Upload failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
      }
      const data = await safeJson(res);
      const sessionId = data && typeof data.session_id === "string" ? data.session_id : "";
      if (!sessionId) throw new Error("Upload did not return a session_id.");
      return sessionId;
    },

    async saveVoice({ sessionId, file, transcription, name, description }) {
      const voiceName = String(name || "").trim();
      if (!voiceName) throw new Error("Voice name is required.");

      let sid = String(sessionId || "").trim();
      if (!sid) {
        // Back-compat: older servers had /upload.
        sid = await this.upload({ file, transcription });
      }

      const wsUrl = resolveWsUrl("/ws");

      const desc = String(description || "").trim();
      const payload = {
        type: "save_voice",
        data: {
          session_id: sid,
          name: voiceName,
          description: desc || null,
        },
      };

      const result = await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error("Timed out waiting for voice_saved."));
        }, 120000);

        ws.addEventListener("open", () => {
          try {
            ws.send(JSON.stringify(payload));
          } catch (e) {
            clearTimeout(timeout);
            reject(e);
          }
        });

        ws.addEventListener("message", (ev) => {
          let msg;
          try {
            msg = JSON.parse(String(ev.data || ""));
          } catch {
            return;
          }
          if (!msg || typeof msg !== "object") return;

          if (msg.type === "voice_saved") {
            clearTimeout(timeout);
            try {
              ws.close();
            } catch {
              // ignore
            }
            resolve(msg.data || {});
            return;
          }

          if (msg.type === "error") {
            clearTimeout(timeout);
            try {
              ws.close();
            } catch {
              // ignore
            }
            reject(new Error(String(msg.data || "Voice save failed.")));
          }
        });

        ws.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("WebSocket error."));
        });

        ws.addEventListener("close", () => {
          // If it closes before we resolve/reject, treat as failure.
          // (No-op if already resolved/rejected.)
        });
      });

      return result;
    },

    async preview({ file, transcription, responseText }) {
      if (!(file instanceof Blob)) throw new Error("Reference audio file is required.");
      const t = String(transcription || "").trim();
      const rt = String(responseText || "").trim();
      if (!t) throw new Error("Reference transcription is required.");
      if (!rt) throw new Error("Response transcript is required.");

      const form = new FormData();
      form.append("audio", file, file.name || "reference.wav");
      form.append("transcription", t);
      form.append("response_text", rt);

      const url = isProxy ? proxyJoin("/preview") : `${base}/preview`;
      // Preview generation can be slow; do not impose a client-side timeout here.
      // (Health checks still use `timeoutMs`.)
      const res = await fetch(url, { method: "POST", body: form });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Preview failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
      }

      const sessionId = extractPreviewSessionId(res);
      const blob = await res.blob();
      return { blob, sessionId };
    },
  };
}