const DEFAULT_TIMEOUT_MS = 6000;

function normalizeBaseUrl(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/\/+$/, "");
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
  if (!base) {
    return {
      baseUrl: "",
      async status() {
        throw new Error("Remote server URL is not set.");
      },
      async voices() {
        throw new Error("Remote server URL is not set.");
      },
      async tts() {
        throw new Error("Remote server URL is not set.");
      }
    };
  }

  async function request(path, { method = "GET", body, headers } = {}) {
    const url = `${base}${path}`;
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

  return {
    baseUrl: base,

    async status() {
      const res = await request("/status");
      if (!res.ok) throw new Error(`Status request failed (${res.status})`);
      const data = await safeJson(res);
      return data ?? {};
    },

    async voices() {
      const res = await request("/voices");
      if (!res.ok) throw new Error(`Voices request failed (${res.status})`);
      const data = await safeJson(res);
      return data ?? [];
    },

    async tts({ voice, text }) {
      const res = await request("/tts", { method: "POST", body: { voice, text } });
      if (!res.ok) throw new Error(`TTS request failed (${res.status})`);

      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (contentType.startsWith("audio/")) {
        const blob = await res.blob();
        return { kind: "blob", blob, contentType };
      }

      const data = await safeJson(res);
      if (!data) throw new Error("Unexpected TTS response.");

      const audioUrl = data.audio_url || data.url;
      if (typeof audioUrl === "string" && audioUrl.trim()) {
        const resolved = new URL(audioUrl, base).toString();
        return { kind: "url", url: resolved };
      }

      const b64 = data.audio_base64 || data.audioBase64 || data.audio;
      if (typeof b64 === "string" && b64.trim()) {
        const mime = data.content_type || data.mime || data.mimeType || "audio/wav";
        const blob = base64ToBlob(b64, mime);
        return { kind: "blob", blob, contentType: mime };
      }

      throw new Error("TTS response did not include audio.");
    }
  };
}
