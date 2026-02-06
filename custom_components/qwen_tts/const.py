DOMAIN = "qwen_tts"

CONF_BASE_URL = "base_url"
CONF_REFERENCE_AUDIO_URL = "reference_audio_url"
CONF_REFERENCE_TRANSCRIPTION = "reference_transcription"
CONF_VOICE_NAME = "voice_name"
CONF_VOICE_ID = "voice_id"

# Timeouts
# - Health checks should fail fast.
# - Audio downloads should be bounded.
# - Preview synthesis can legitimately take a long time; set to 0 for no timeout.
HEALTH_TIMEOUT_SECONDS = 10
DOWNLOAD_TIMEOUT_SECONDS = 30
PREVIEW_TIMEOUT_SECONDS = 0

DEFAULT_LANGUAGE = "en"
