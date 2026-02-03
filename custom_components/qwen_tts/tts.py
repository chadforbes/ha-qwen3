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
    CONF_SESSION_ID,
    DEFAULT_LANGUAGE,
    DEFAULT_TIMEOUT_SECONDS,
    DOMAIN,
)


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

    async def _async_upload_reference_audio(self) -> str:
        if not self._reference_audio_url:
            raise HomeAssistantError(
                "No session_id configured and no reference_audio_url available to upload."
            )

        session = async_get_clientsession(self.hass)

        async with async_timeout.timeout(DEFAULT_TIMEOUT_SECONDS):
            async with session.get(self._reference_audio_url) as resp:
                if resp.status != 200:
                    raise HomeAssistantError(
                        f"Failed to download reference audio (HTTP {resp.status})."
                    )
                reference_bytes = await resp.read()

        form = aiohttp.FormData()
        form.add_field(
            "file",
            reference_bytes,
            filename="reference.wav",
            content_type="audio/wav",
        )

        upload_url = urljoin(f"{self._base_url.rstrip('/')}/", "upload")
        async with async_timeout.timeout(DEFAULT_TIMEOUT_SECONDS):
            async with session.post(upload_url, data=form) as resp:
                if resp.status != 200:
                    text = await resp.text()
                    raise HomeAssistantError(
                        f"Upload failed (HTTP {resp.status}): {text[:200]}"
                    )
                data = await resp.json(content_type=None)

        session_id = data.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise HomeAssistantError("Upload response missing session_id")

        self._session_id = session_id
        self.hass.config_entries.async_update_entry(
            self._entry,
            data={**self._entry.data, CONF_SESSION_ID: session_id},
        )
        return session_id

    async def _async_ensure_session_id(self) -> str:
        if self._session_id:
            return self._session_id
        return await self._async_upload_reference_audio()

    async def _async_generate_preview(self, message: str, session_id: str) -> _TTSComplete:
        session = async_get_clientsession(self.hass)
        ws_url = _ws_url_from_http(self._base_url, "/ws")

        payload = {
            "type": "generate_preview",
            "data": {"session_id": session_id, "text": message},
        }

        try:
            async with async_timeout.timeout(DEFAULT_TIMEOUT_SECONDS):
                async with session.ws_connect(ws_url, heartbeat=30) as ws:
                    await ws.send_json(payload)

                    while True:
                        msg = await ws.receive(timeout=DEFAULT_TIMEOUT_SECONDS)
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

        async with async_timeout.timeout(DEFAULT_TIMEOUT_SECONDS):
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
        try:
            session_id = await self._async_ensure_session_id()
        except HomeAssistantError:
            raise
        except Exception as err:  # noqa: BLE001
            raise HomeAssistantError("Failed to prepare TTS session") from err

        complete = await self._async_generate_preview(message, session_id)
        audio_bytes = await self._async_download_audio(complete.audio_url)

        # The backend returns WAV previews.
        return "wav", audio_bytes
