from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp

from homeassistant.components.tts import TextToSpeechEntity, TtsAudioType
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import (
    CONF_BASE_URL,
    CONF_REFERENCE_AUDIO_URL,
    CONF_REFERENCE_TRANSCRIPTION,
    CONF_SESSION_ID,
    CONF_VOICE_ID,
    CONF_VOICE_NAME,
    DEFAULT_LANGUAGE,
    DOWNLOAD_TIMEOUT_SECONDS,
    PREVIEW_TIMEOUT_SECONDS,
    DOMAIN,
)

_LOGGER = logging.getLogger(__name__)


@dataclass
class _TTSComplete:
    audio_url: str


def _ws_url_from_http(base_url: str, path: str) -> str:
    parsed = urlparse(base_url)
    if parsed.scheme == "https":
        scheme = "wss"
    elif parsed.scheme == "http":
        scheme = "ws"
    else:
        raise HomeAssistantError(f"Invalid base URL scheme: {parsed.scheme}")

    base_ws = parsed._replace(scheme=scheme).geturl()
    return urljoin(f"{base_ws.rstrip('/')}/", path.lstrip("/"))


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


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([QwenTTSEntity(hass, config_entry)])


class QwenTTSEntity(TextToSpeechEntity):
    _attr_default_language = DEFAULT_LANGUAGE
    _attr_supported_languages = [DEFAULT_LANGUAGE]
    _attr_supported_options: list[str] = []

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self._entry = entry
        self._attr_unique_id = entry.entry_id
        # Show a distinct name per config entry (useful when selecting TTS engine per Assistant).
        self._attr_name = entry.title
        self._base_url: str = entry.data[CONF_BASE_URL].rstrip("/")
        self._voice_id: str | None = entry.data.get(CONF_VOICE_ID)
        self._session_id: str | None = entry.data.get(CONF_SESSION_ID)
        self._reference_audio_url: str | None = entry.data.get(CONF_REFERENCE_AUDIO_URL)
        self._reference_transcription: str | None = entry.data.get(
            CONF_REFERENCE_TRANSCRIPTION
        )
        self._voice_name: str | None = entry.data.get(CONF_VOICE_NAME)

    async def _async_generate_preview_saved_voice(self, message: str, voice_id: str) -> bytes:
        form = aiohttp.FormData()
        form.add_field("voice_id", voice_id)
        form.add_field("response_text", message)

        session = async_get_clientsession(self.hass)
        url = urljoin(f"{self._base_url.rstrip('/')}/", "preview-from-voice")
        async with _maybe_timeout(PREVIEW_TIMEOUT_SECONDS):
            async with session.post(url, data=form) as resp:
                if resp.status == 404:
                    text = await resp.text()
                    raise HomeAssistantError(
                        f"Saved voice not found (voice_id={voice_id}): {text[:200]}"
                    )
                if resp.status != 200:
                    text = await resp.text()
                    raise HomeAssistantError(
                        f"Preview-from-voice failed (HTTP {resp.status}): {text[:200]}"
                    )
                return await resp.read()

    async def _async_get_default_voice_id(self) -> str:
        """Return a default saved voice_id from the server.

        The qwen3-server exposes saved voices at `GET /voices`.
        We pick the first returned voice_id (sorted server-side).
        """

        session = async_get_clientsession(self.hass)
        url = urljoin(f"{self._base_url.rstrip('/')}/", "voices")
        async with _maybe_timeout(DOWNLOAD_TIMEOUT_SECONDS):
            async with session.get(url) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise HomeAssistantError(
                        f"Unable to list saved voices (HTTP {resp.status}): {text[:200]}"
                    )
                payload = await resp.json(content_type=None)

        voices = payload.get("voices") if isinstance(payload, dict) else None
        if not isinstance(voices, list) or not voices:
            raise HomeAssistantError(
                "No saved voices found on server. Create one first, or configure a voice_id/session_id/reference_audio_url."
            )

        for item in voices:
            if isinstance(item, dict):
                vid = item.get("voice_id")
                if isinstance(vid, str) and vid.strip():
                    return vid.strip()

        raise HomeAssistantError(
            "Saved voices list did not include a usable voice_id."
        )

    async def _async_download_reference_audio(self) -> tuple[bytes, str]:
        if not self._reference_audio_url:
            raise HomeAssistantError(
                "No session_id configured and no reference_audio_url available."
            )

        session = async_get_clientsession(self.hass)
        async with _maybe_timeout(DOWNLOAD_TIMEOUT_SECONDS):
            async with session.get(self._reference_audio_url) as resp:
                if resp.status != 200:
                    raise HomeAssistantError(
                        f"Failed to download reference audio (HTTP {resp.status})."
                    )
                content_type = resp.headers.get("Content-Type") or "audio/wav"
                return await resp.read(), content_type

    async def _async_generate_preview_http(self, message: str) -> bytes:
        transcription = (self._reference_transcription or "").strip()
        if not transcription:
            _LOGGER.warning(
                "No reference_transcription configured; proceeding without it. "
                "If the backend rejects the request or voice quality is poor, set reference_transcription or configure a session_id."
            )

        reference_bytes, content_type = await self._async_download_reference_audio()

        form = aiohttp.FormData()
        form.add_field(
            "audio",
            reference_bytes,
            filename="reference.wav",
            content_type=content_type,
        )
        form.add_field("transcription", transcription)
        form.add_field("response_text", message)

        session = async_get_clientsession(self.hass)
        preview_url = urljoin(f"{self._base_url.rstrip('/')}/", "preview")
        async with _maybe_timeout(PREVIEW_TIMEOUT_SECONDS):
            async with session.post(preview_url, data=form) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise HomeAssistantError(
                        f"Preview failed (HTTP {resp.status}): {text[:200]}"
                    )
                return await resp.read()

    async def _async_generate_preview(self, message: str, session_id: str) -> _TTSComplete:
        session = async_get_clientsession(self.hass)
        ws_url = _ws_url_from_http(self._base_url, "/ws")

        payload = {
            "type": "generate_preview",
            "data": {"session_id": session_id, "text": message},
        }

        try:
            async with _maybe_timeout(PREVIEW_TIMEOUT_SECONDS):
                async with session.ws_connect(ws_url, heartbeat=30) as ws:
                    await ws.send_json(payload)

                    while True:
                        msg = await ws.receive(timeout=None)
                        if msg.type == aiohttp.WSMsgType.TEXT:
                            try:
                                parsed = json.loads(msg.data)
                            except json.JSONDecodeError:
                                continue

                            msg_type = parsed.get("type")
                            if msg_type == "tts_complete":
                                data = parsed.get("data") or {}
                                audio_url = data.get("audio_url")
                                if not isinstance(audio_url, str) or not audio_url:
                                    raise HomeAssistantError("tts_complete missing audio_url")
                                return _TTSComplete(audio_url=audio_url)

                            if msg_type == "error":
                                data = parsed.get("data")
                                raise HomeAssistantError(f"Backend error: {data}")

                        if msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED):
                            raise HomeAssistantError("WebSocket closed before completion")
                        if msg.type == aiohttp.WSMsgType.ERROR:
                            raise HomeAssistantError("WebSocket error")
        except TimeoutError as err:
            raise HomeAssistantError("Timed out waiting for TTS audio") from err

    async def _async_download_audio(self, audio_url: str) -> bytes:
        session = async_get_clientsession(self.hass)
        absolute = audio_url
        if not absolute.startswith("http://") and not absolute.startswith("https://"):
            absolute = urljoin(f"{self._base_url.rstrip('/')}/", audio_url.lstrip("/"))

        async with _maybe_timeout(DOWNLOAD_TIMEOUT_SECONDS):
            async with session.get(absolute) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise HomeAssistantError(
                        f"Audio download failed (HTTP {resp.status}): {text[:200]}"
                    )
                return await resp.read()

    async def async_get_tts_audio(
        self, message: str, language: str, options: dict[str, Any]
    ) -> TtsAudioType:
        voice_id = (self._voice_id or "").strip()
        if voice_id:
            audio_bytes = await self._async_generate_preview_saved_voice(message, voice_id)
            return "wav", audio_bytes

        if self._session_id:
            complete = await self._async_generate_preview(message, self._session_id)
            audio_bytes = await self._async_download_audio(complete.audio_url)
            return "wav", audio_bytes

        if self._reference_audio_url:
            audio_bytes = await self._async_generate_preview_http(message)
            return "wav", audio_bytes

        # URL-only setup: default to the first saved voice on the server.
        voice_id = await self._async_get_default_voice_id()
        audio_bytes = await self._async_generate_preview_saved_voice(message, voice_id)
        return "wav", audio_bytes
