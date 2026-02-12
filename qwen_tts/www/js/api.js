const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_WS_PING_INTERVAL_MS = 25000;
const DEFAULT_WS_SERVER_IDLE_TIMEOUT_MS = 65000;
const DEFAULT_WS_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_WS_MAX_BACKOFF_MS = 8000;
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

  // --- Persistent WebSocket state (per API instance) ---
  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {Promise<WebSocket>|null} */
  let wsConnecting = null;
  /** @type {number|null} */
  let wsPingTimer = null;
  /** @type {number|null} */
  let wsIdleTimer = null;
  /** @type {number|null} */
  let wsReconnectTimer = null;
  let wsBackoffMs = 250;
  let wsLastMessageAt = 0;
  let wsManuallyClosed = false;

  /** @type {Map<string, {resolve: Function, reject: Function, timer: number|null}>} */
  const wsPending = new Map();
  /** @type {Map<string, Array<Function>>} */
  const wsTypeListeners = new Map();
  /** @type {Set<Function>} */
  const wsAnyListeners = new Set();

  function wsNotify(ev) {
    for (const fn of wsAnyListeners) {
      try {
        fn(ev);
      } catch {
        // ignore listener errors
      }
    }
  }

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

  function jitter(ms) {
    const delta = ms * 0.2;
    return ms + (Math.random() * 2 - 1) * delta;
  }

  function clearTimer(id) {
    if (id === null || id === undefined) return null;
    clearTimeout(id);
    return null;
  }

  function wsArmPing() {
    wsPingTimer = clearTimer(wsPingTimer);
    wsPingTimer = setTimeout(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Keep-alive message. The backend may ignore unknown types; that's fine.
      // Prefer sending an object to keep it JSON.
      try {
        const payload = { type: "ping", data: { t: Date.now() } };
        const raw = JSON.stringify(payload);
        wsNotify({ kind: "message", direction: "out", at: Date.now(), raw, msg: payload });
        ws.send(raw);
      } catch {
        // ignore; close handler will reconnect if needed.
      }
      wsArmPing();
    }, DEFAULT_WS_PING_INTERVAL_MS);
  }

  function wsArmIdleWatchdog() {
    wsIdleTimer = clearTimer(wsIdleTimer);
    wsIdleTimer = setTimeout(() => {
      // If we haven't received any data in a while, force a reconnect.
      // This helps with silent network drops where the socket stays OPEN.
      const idleFor = Date.now() - (wsLastMessageAt || 0);
      if (ws && ws.readyState === WebSocket.OPEN && idleFor > DEFAULT_WS_SERVER_IDLE_TIMEOUT_MS) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      } else {
        wsArmIdleWatchdog();
      }
    }, DEFAULT_WS_SERVER_IDLE_TIMEOUT_MS);
  }

  function wsFailAllPending(err) {
    for (const [id, p] of wsPending.entries()) {
      if (p.timer) clearTimeout(p.timer);
      wsPending.delete(id);
      try {
        p.reject(err);
      } catch {
        // ignore
      }
    }
  }

  function wsScheduleReconnect() {
    if (wsManuallyClosed) return;
    if (wsReconnectTimer) return;
    const delay = Math.min(DEFAULT_WS_MAX_BACKOFF_MS, Math.max(250, jitter(wsBackoffMs)));
    wsBackoffMs = Math.min(DEFAULT_WS_MAX_BACKOFF_MS, wsBackoffMs * 2);
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      // Fire and forget; any send() will await connection.
      void ensureWebSocket();
    }, delay);
  }

  function wsOnMessage(ev) {
    wsLastMessageAt = Date.now();
    wsArmIdleWatchdog();

    const raw = ev?.data;

    let msg;
    try {
      msg = JSON.parse(String(raw || ""));
    } catch {
      wsNotify({ kind: "message", direction: "in", at: Date.now(), raw, msg: null });
      return;
    }
    if (!msg || typeof msg !== "object") return;

    wsNotify({ kind: "message", direction: "in", at: Date.now(), raw, msg });

    // NOTE: qwen3-server currently does NOT use request_id correlation.
    // Keep this path for forward compatibility in case it gets added later.
    const reqId =
      typeof msg.request_id === "string"
        ? msg.request_id
        : typeof msg.requestId === "string"
          ? msg.requestId
          : "";
    if (reqId && wsPending.has(reqId)) {
      const p = wsPending.get(reqId);
      wsPending.delete(reqId);
      if (p?.timer) clearTimeout(p.timer);
      if (msg.type === "error") {
        // Server sends: {type:'error', data:{message:string}}
        const data = msg.data;
        const message =
          data && typeof data === "object" && typeof data.message === "string"
            ? data.message
            : typeof data === "string"
              ? data
              : "WebSocket request failed.";
        p.reject(new Error(message));
      } else {
        p.resolve(msg);
      }
      return;
    }

    // Broadcast-by-type listeners.
    const type = typeof msg.type === "string" ? msg.type : "";
    if (type && wsTypeListeners.has(type)) {
      for (const fn of wsTypeListeners.get(type) || []) {
        try {
          fn(msg);
        } catch {
          // ignore listener errors
        }
      }
    }
  }

  function wsCleanupSocket() {
    if (!ws) return;
    try {
      ws.removeEventListener("message", wsOnMessage);
    } catch {
      // ignore
    }
    wsPingTimer = clearTimer(wsPingTimer);
    wsIdleTimer = clearTimer(wsIdleTimer);
    ws = null;
  }

  async function ensureWebSocket() {
    if (ws && ws.readyState === WebSocket.OPEN) return ws;
    if (wsConnecting) return wsConnecting;

    const wsUrl = resolveWsUrl("/ws");
    wsManuallyClosed = false;

    wsConnecting = new Promise((resolve, reject) => {
      let settled = false;
      const sock = new WebSocket(wsUrl);
      const connectTimeout = setTimeout(() => {
        try {
          sock.close();
        } catch {
          // ignore
        }
        if (settled) return;
        settled = true;
        reject(new Error("WebSocket connect timeout."));
      }, DEFAULT_WS_CONNECT_TIMEOUT_MS);

      sock.addEventListener("open", () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        ws = sock;
        wsBackoffMs = 250;
        wsLastMessageAt = Date.now();
        ws.addEventListener("message", wsOnMessage);
        wsArmPing();
        wsArmIdleWatchdog();
        wsNotify({ kind: "state", state: "open", at: Date.now(), url: wsUrl });
        resolve(ws);
      });

      sock.addEventListener("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimeout);
        wsNotify({ kind: "state", state: "error", at: Date.now(), url: wsUrl });
        reject(new Error("WebSocket error."));
      });

      sock.addEventListener("close", (closeEv) => {
        clearTimeout(connectTimeout);

        wsNotify({
          kind: "state",
          state: "closed",
          at: Date.now(),
          code: closeEv?.code,
          reason: closeEv?.reason,
          wasClean: closeEv?.wasClean,
          url: wsUrl,
        });

        // If we were currently connected, this is a disconnect; otherwise it's a failed connect.
        const wasActive = ws === sock;
        if (wasActive) {
          wsCleanupSocket();
          wsFailAllPending(new Error("WebSocket disconnected."));
          wsScheduleReconnect();
        }

        if (!settled) {
          settled = true;
          reject(new Error("WebSocket closed before open."));
        }
      });
    }).finally(() => {
      wsConnecting = null;
    });

    return wsConnecting;
  }

  function wsSendAndWait(payload, { expectType, timeoutMs = 120000 } = {}) {
    const expect = String(expectType || "").trim();

    // If the payload doesn't provide request_id (and the server doesn't send one),
    // fall back to type-based matching.
    const requestId =
      payload && typeof payload === "object" && typeof payload.request_id === "string"
        ? payload.request_id
        : payload && typeof payload === "object" && typeof payload.requestId === "string"
          ? payload.requestId
          : "";

    return new Promise(async (resolve, reject) => {
      let typeListener = null;
      let timer = null;

      // Always listen for server-side errors during this wait.
      // Server sends: {type:'error', data:{message:string}}
      const errorListener = (errMsg) => {
        const data = errMsg?.data;
        const message =
          data && typeof data === "object" && typeof data.message === "string"
            ? data.message
            : typeof data === "string"
              ? data
              : "WebSocket error.";
        cleanup();
        reject(new Error(message));
      };

      function cleanup() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (requestId) {
          wsPending.delete(requestId);
        }
        if (typeListener && expect) {
          const arr = wsTypeListeners.get(expect) || [];
          wsTypeListeners.set(
            expect,
            arr.filter((fn) => fn !== typeListener)
          );
        }

        const errArr = wsTypeListeners.get("error") || [];
        wsTypeListeners.set(
          "error",
          errArr.filter((fn) => fn !== errorListener)
        );
      }

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${expect || "response"}.`));
      }, timeoutMs);

      const existingErrorListeners = wsTypeListeners.get("error") || [];
      wsTypeListeners.set("error", [...existingErrorListeners, errorListener]);

      if (requestId) {
        wsPending.set(requestId, {
          resolve: (msg) => {
            cleanup();
            resolve(msg);
          },
          reject: (err) => {
            cleanup();
            reject(err);
          },
          timer,
        });
      }

      if (expect) {
        typeListener = (msg) => {
          cleanup();
          resolve(msg);
        };
        const arr = wsTypeListeners.get(expect) || [];
        wsTypeListeners.set(expect, [...arr, typeListener]);
      }

      try {
        const sock = await ensureWebSocket();
        const raw = JSON.stringify(payload);
        wsNotify({ kind: "message", direction: "out", at: Date.now(), raw, msg: payload });
        sock.send(raw);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
  }

  return {
    baseUrl: base,

    onWs(listener) {
      if (typeof listener !== "function") return () => {};
      wsAnyListeners.add(listener);
      return () => wsAnyListeners.delete(listener);
    },

    async wsConnect() {
      return ensureWebSocket();
    },

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

    async saveVoice({ name, description }) {
      const voiceName = String(name || "").trim();
      if (!voiceName) throw new Error("Voice name is required.");

      const desc = String(description || "").trim();
      const data = {
        name: voiceName,
        description: desc || null,
      };

      // Use (and keep) the shared WebSocket connection for this API instance.
      // This avoids connect/close churn and keeps the backend session warm.
      const payload = { type: "save_voice", data };
      const msg = await wsSendAndWait(payload, { expectType: "voice_saved", timeoutMs: 120000 });
      return (msg && typeof msg === "object" && msg.data) || {};
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

      const blob = await res.blob();
      // Server no longer uses session IDs; preview always updates the server's latest upload.
      return { blob };
    },
  };
}