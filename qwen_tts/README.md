# Qwen TTS (Dashboard)

Ingress dashboard for monitoring and previewing a **remote** Qwen TTS Server.

- Serves static files from `/www`.
- Runs no Qwen TTS process.

## Remote server API

The browser UI calls the remote server directly:

- `GET /status`
- `GET /voices`
- `POST /tts` with JSON body `{ "voice": "...", "text": "..." }`

For audio preview, `/tts` can return:

- `audio/*` response body (preferred), or
- JSON with one of:
  - `audio_url` / `url` (string)
  - `audio_base64` / `audioBase64` / `audio` (base64 string) and optional `content_type`

If the remote server is on a different origin than Home Assistant, it must allow browser access (CORS), otherwise the UI will show Offline/errors.
