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

  return {
    baseUrl: base,

    async health() {
      const res = await request("/health");
      if (!res.ok) throw new Error(`Health request failed (${res.status})`);
      const data = await safeJson(res);
      return data ?? {};
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
      const tmo = withTimeout(timeoutMs);
      try {
        const res = await fetch(url, { method: "POST", body: form, signal: tmo.signal });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`Preview failed (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
        }
        return await res.blob();
      } finally {
        tmo.cancel();
      }
    },
  };
}