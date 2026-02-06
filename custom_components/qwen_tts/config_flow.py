from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urljoin

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import (
    CONF_BASE_URL,
    CONF_REFERENCE_AUDIO_URL,
    CONF_REFERENCE_TRANSCRIPTION,
    CONF_SESSION_ID,
    CONF_VOICE_ID,
    CONF_VOICE_NAME,
    DOMAIN,
    HEALTH_TIMEOUT_SECONDS,
)


def _is_valid_http_url(value: str) -> bool:
    from urllib.parse import urlparse

    u = urlparse(str(value).strip())
    return u.scheme in ("http", "https") and bool(u.netloc)


def _normalize_http_url(value: str) -> str:
    """Normalize user-provided URL.

    Home Assistant users commonly enter `host:port` without a scheme.
    Treat that as `http://host:port`.
    """
    from urllib.parse import urlparse

    value = str(value).strip()
    if not value:
        return value

    parsed = urlparse(value)
    if not parsed.scheme:
        return f"http://{value}"

    return value


@asynccontextmanager
async def _maybe_timeout(seconds: int) -> AsyncIterator[None]:
    if seconds and seconds > 0:
        timeout_cm = getattr(asyncio, "timeout", None)
        if timeout_cm is not None:
            async with timeout_cm(seconds):
                yield
            return

        # Fallback for very old Python builds.
        import async_timeout  # type: ignore[import-not-found]

        async with async_timeout.timeout(seconds):
            yield
        return

    yield


async def _async_check_health(hass: HomeAssistant, base_url: str) -> bool:
    session = async_get_clientsession(hass)
    health_url = urljoin(f"{base_url.rstrip('/')}/", "health")
    try:
        async with _maybe_timeout(HEALTH_TIMEOUT_SECONDS):
            async with session.get(health_url) as resp:
                if resp.status != 200:
                    return False
                data = await resp.json(content_type=None)
                return data.get("status") == "ok"
    except Exception:
        return False


class QwenTTSConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> FlowResult:
        errors: dict[str, str] = {}

        if user_input is not None:
            base_url: str = _normalize_http_url(user_input[CONF_BASE_URL]).rstrip("/")
            voice_id: str = (user_input.get(CONF_VOICE_ID) or "").strip()
            session_id: str = (user_input.get(CONF_SESSION_ID) or "").strip()
            reference_audio_url: str = _normalize_http_url(
                (user_input.get(CONF_REFERENCE_AUDIO_URL) or "").strip()
            )
            reference_transcription: str = (
                user_input.get(CONF_REFERENCE_TRANSCRIPTION) or ""
            ).strip()
            voice_name: str = (user_input.get(CONF_VOICE_NAME) or "").strip()

            if not _is_valid_http_url(base_url):
                errors[CONF_BASE_URL] = "invalid_url"

            if reference_audio_url and not _is_valid_http_url(reference_audio_url):
                errors[CONF_REFERENCE_AUDIO_URL] = "invalid_url"

            # URL-only setup is allowed. If no voice is specified, the runtime
            # will select a default saved voice from the server (if available).
            if not errors:
                ok = await _async_check_health(self.hass, base_url)
                if not ok:
                    errors["base"] = "cannot_connect"

            if not errors:
                # Allow multiple entries per server when using saved voices.
                unique = base_url
                if voice_id:
                    unique = f"{base_url}::voice::{voice_id}"
                await self.async_set_unique_id(unique)
                self._abort_if_unique_id_configured()

                data: dict[str, Any] = {CONF_BASE_URL: base_url}
                if voice_id:
                    data[CONF_VOICE_ID] = voice_id
                if session_id:
                    data[CONF_SESSION_ID] = session_id
                if reference_audio_url:
                    data[CONF_REFERENCE_AUDIO_URL] = reference_audio_url
                if reference_transcription:
                    data[CONF_REFERENCE_TRANSCRIPTION] = reference_transcription
                if voice_name:
                    data[CONF_VOICE_NAME] = voice_name

                # The entry title is what users will see in many UI surfaces.
                # Use an optional per-voice name so multiple entries can be selected in Assist.
                return self.async_create_entry(title=voice_name or voice_id or "Qwen TTS", data=data)

        schema = vol.Schema(
            {
                # Use plain strings here (voluptuous_serialize must be able to convert the schema).
                # We validate URL format manually in `async_step_user`.
                vol.Required(CONF_BASE_URL): str,
                vol.Optional(CONF_VOICE_ID): str,
                vol.Optional(CONF_VOICE_NAME): str,
                vol.Optional(CONF_SESSION_ID): str,
                vol.Optional(CONF_REFERENCE_AUDIO_URL): str,
                vol.Optional(CONF_REFERENCE_TRANSCRIPTION): str,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)
