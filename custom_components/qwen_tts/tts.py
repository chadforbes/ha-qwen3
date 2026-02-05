from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin, urlparse

import aiohttp
import async_timeout

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
    DEFAULT_LANGUAGE,
    DOWNLOAD_TIMEOUT_SECONDS,
    PREVIEW_TIMEOUT_SECONDS,
    DOMAIN,
)


def _timeout_ctx(seconds: int) -> async_timeout.Timeout:
    # Use 0 to mean "no timeout".
    return async_timeout.timeout(seconds if seconds and seconds > 0 else None)


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


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([QwenTTSEntity(hass, config_entry)])


class QwenTTSEntity(TextToSpeechEntity):
    _attr_name = "Qwen TTS"
    _attr_default_language = DEFAULT_LANGUAGE
    _attr_supported_languages = [DEFAULT_LANGUAGE]
    _attr_supported_options: list[str] = []

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self._entry = entry
        self._attr_unique_id = entry.entry_id
        self._base_url: str = entry.data[CONF_BASE_URL].rstrip("/")
        self._session_id: str | None = entry.data.get(CONF_SESSION_ID)
        self._reference_audio_url: str | None = entry.data.get(CONF_REFERENCE_AUDIO_URL)
        self._reference_transcription: str | None = entry.data.get(
            CONF_REFERENCE_TRANSCRIPTION
        )

    async def _async_download_reference_audio(self) -> tuple[bytes, str]:
        if not self._reference_audio_url:
            raise HomeAssistantError(
                "No session_id configured and no reference_audio_url available."
            )

        session = async_get_clientsession(self.hass)
        async with _timeout_ctx(DOWNLOAD_TIMEOUT_SECONDS):
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
            raise HomeAssistantError(
                "Missing reference transcription. Configure reference_transcription."
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
        async with _timeout_ctx(PREVIEW_TIMEOUT_SECONDS):
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
            async with _timeout_ctx(PREVIEW_TIMEOUT_SECONDS):
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
        except asyncio.TimeoutError as err:
            raise HomeAssistantError("Timed out waiting for TTS audio") from err

    async def _async_download_audio(self, audio_url: str) -> bytes:
        session = async_get_clientsession(self.hass)
        absolute = audio_url
        if not absolute.startswith("http://") and not absolute.startswith("https://"):
            absolute = urljoin(f"{self._base_url.rstrip('/')}/", audio_url.lstrip("/"))

        async with _timeout_ctx(DOWNLOAD_TIMEOUT_SECONDS):
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
        if self._session_id:
            complete = await self._async_generate_preview(message, self._session_id)
            audio_bytes = await self._async_download_audio(complete.audio_url)
            return "wav", audio_bytes

        audio_bytes = await self._async_generate_preview_http(message)
        return "wav", audio_bytes
