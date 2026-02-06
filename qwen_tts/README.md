# Qwen TTS (Dashboard)

Ingress dashboard for monitoring and previewing a **remote** Qwen TTS Server.

- Serves static files from `/www`.
- Runs no Qwen TTS process.

## Remote server API (qwen3-server)

The backend contract this dashboard targets:

- `GET /health` → `{ "status": "ok" }`
- `GET /voices` → `{ "voices": [...] }`
- `POST /preview` (multipart fields `audio`, `transcription`, `response_text`) → WAV audio response
- `WS /ws` (JSON `{type,data}` messages)

Note: saving a voice via `WS /ws save_voice` saves the most recent preview session on the server.

## Proxy mode (recommended for Home Assistant ingress)

When the dashboard is loaded via Home Assistant ingress, it uses the add-on's same-origin proxy under `/api/*` to avoid browser CORS/mixed-content blocks.

- Set the add-on option `remote_url` to your qwen3-server base URL (example: `http://192.168.30.185:8000`).


