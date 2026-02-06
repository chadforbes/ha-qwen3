# Qwen TTS Home Assistant Add-on Repository

This is a Home Assistant **add-on repository**.

- Repository config: `repository.yaml`
- Add-on folder: `qwen_tts/`

## Custom integration (TTS)

This repo also includes a **custom Home Assistant integration** at `custom_components/qwen_tts/`.

- It connects to a `qwen3-server` backend (`GET /health`, `GET /voices`, `POST /preview`, `POST /preview-from-voice`, `WS /ws`).
- Config requires your backend `base_url`. Optional: set `voice_id` (preferred) or `reference_audio_url` + `reference_transcription` for voice cloning. `session_id` is supported for legacy/advanced flows.

See `qwen_tts/README.md` and `qwen_tts/DOCS.md` for the add-on details.
