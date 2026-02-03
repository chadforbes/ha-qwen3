# Qwen TTS Home Assistant Add-on Repository

This is a Home Assistant **add-on repository**.

- Repository config: `repository.yaml`
- Add-on folder: `qwen_tts/`

## Custom integration (TTS)

This repo also includes a **custom Home Assistant integration** at `custom_components/qwen_tts/`.

- It connects to a `qwen3-server`-style backend (`GET /health`, `POST /upload`, `WS /ws`, `GET /previews/...`).
- Config requires your backend `base_url` and either a `session_id` or a `reference_audio_url` (used to upload and obtain a session automatically).

See `qwen_tts/README.md` and `qwen_tts/DOCS.md` for the add-on details.
