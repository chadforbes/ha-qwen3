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

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function base64ToBlob(base64, mimeType = "audio/wav") {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function createApi(baseUrl, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const base = normalizeBaseUrl(baseUrl);

  const isProxy = !base;

  function proxyJoin(path) {
    const p = String(path || "").replace(/^\/+/, "");
    return `${PROXY_PREFIX}/${p}`;
  }

  async function request(path, { method = "GET", body, headers } = {}) {
    const url = isProxy ? proxyJoin(path) : `${base}${path}`;
    const t = withTimeout(timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(headers ?? {})
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: t.signal
      });
      return res;
    } finally {
      t.cancel();
    }
  }

  function resolveUrl(pathOrUrl) {
    if (typeof pathOrUrl !== "string" || !pathOrUrl.trim()) return "";
    const raw = pathOrUrl.trim();
    if (/^https?:\/\//i.test(raw)) return raw;
    if (isProxy) {
      return new URL(proxyJoin(raw), window.location.href).toString();
    }
    return new URL(pathOrUrl, `${base}/`).toString();
  }

  function toWsUrl(path) {
    if (isProxy) {
      const baseUrl = new URL(window.location.href);
      if (baseUrl.protocol === "https:") baseUrl.protocol = "wss:";
      else if (baseUrl.protocol === "http:") baseUrl.protocol = "ws:";
      else throw new Error(`Unsupported protocol: ${baseUrl.protocol}`);
      // Use relative paths so we stay within the ingress token path.
      return new URL(String(path || "").replace(/^\/+/, ""), baseUrl).toString();
    }

    const u = new URL(`${base}/`);
    if (u.protocol === "https:") u.protocol = "wss:";
    else if (u.protocol === "http:") u.protocol = "ws:";
    else throw new Error(`Unsupported protocol: ${u.protocol}`);
    return new URL(path.replace(/^\//, ""), u).toString();
  }

  return {
    baseUrl: base,

    resolveUrl,

    async health() {
      const res = await request("/health");
      if (!res.ok) throw new Error(`Health request failed (${res.status})`);
      const data = await safeJson(res);
      return data ?? {};
    },

    async uploadReference(file) {
      if (!(file instanceof Blob)) throw new Error("Reference file is required.");

      const form = new FormData();
      form.append("file", file, file.name || "reference.wav");

      const url = isProxy ? proxyJoin("/upload") : `${base}/upload`;
      const t = withTimeout(timeoutMs);
      try {
        const res = await fetch(url, { method: "POST", body: form, signal: t.signal });
        if (!res.ok) throw new Error(`Upload failed (${res.status})`);
        const data = await safeJson(res);
        const sessionId = data?.session_id;
        if (typeof sessionId !== "string" || !sessionId.trim()) {
          throw new Error("Upload response missing session_id.");
        }
        return { sessionId: sessionId.trim() };
      } finally {
        t.cancel();
      }
    },

    async generatePreview({ sessionId, text }) {
      const sid = String(sessionId || "").trim();
      const ttsText = String(text || "").trim();
      if (!sid) throw new Error("Session ID is required.");
      if (!ttsText) throw new Error("Text is required.");

      const wsUrl = toWsUrl(isProxy ? proxyJoin("/ws") : "/ws");
      const ws = new WebSocket(wsUrl);
      let done = false;

      const sendPayload = { type: "generate_preview", data: { session_id: sid, text: ttsText } };

      return await new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          try {
            ws.close();
          } catch {
            // ignore
          }
          reject(new Error("Timed out waiting for preview."));
        }, timeoutMs);

        function cleanup() {
          clearTimeout(timeoutId);
          ws.removeEventListener("open", onOpen);
          ws.removeEventListener("message", onMessage);
          ws.removeEventListener("error", onError);
          ws.removeEventListener("close", onClose);
        }

        function onOpen() {
          try {
            ws.send(JSON.stringify(sendPayload));
          } catch (e) {
            cleanup();
            reject(e);
          }
        }

        function onMessage(ev) {
          let msg;
          try {
            msg = JSON.parse(String(ev.data || ""));
          } catch {
            return;
          }

          if (msg?.type === "tts_complete") {
            const audioUrl = msg?.data?.audio_url;
            if (typeof audioUrl === "string" && audioUrl.trim()) {
              done = true;
              cleanup();
              try {
                ws.close();
              } catch {
                // ignore
              }
              resolve({ audioUrl: resolveUrl(audioUrl.trim()) });
              return;
            }
          }

          if (msg?.type === "error") {
            const details = msg?.data?.message || msg?.data?.error || msg?.data;
            const text = typeof details === "string" ? details : JSON.stringify(details);
            cleanup();
            reject(new Error(text ? `Backend error: ${text}` : "Backend returned an error."));
          }
        }

        function onError() {
          cleanup();
          reject(new Error("WebSocket error."));
        }

        function onClose() {
          if (done) return;
          // If it closes before resolve/reject, treat as failure.
          cleanup();
          reject(new Error("WebSocket closed."));
        }

        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", onMessage);
        ws.addEventListener("error", onError);
        ws.addEventListener("close", onClose);
      });
    }
  };
}
