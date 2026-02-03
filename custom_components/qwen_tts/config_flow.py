from __future__ import annotations

from typing import Any
from urllib.parse import urljoin

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .const import CONF_BASE_URL, CONF_REFERENCE_AUDIO_URL, CONF_SESSION_ID, DOMAIN


async def _async_check_health(hass: HomeAssistant, base_url: str) -> bool:
    session = async_get_clientsession(hass)
    health_url = urljoin(f"{base_url.rstrip('/')}/", "health")
    try:
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
            base_url: str = user_input[CONF_BASE_URL].rstrip("/")
            session_id: str = (user_input.get(CONF_SESSION_ID) or "").strip()
            reference_audio_url: str = (user_input.get(CONF_REFERENCE_AUDIO_URL) or "").strip()

            if not session_id and not reference_audio_url:
                errors["base"] = "missing_reference"
            else:
                ok = await _async_check_health(self.hass, base_url)
                if not ok:
                    errors["base"] = "cannot_connect"

            if not errors:
                await self.async_set_unique_id(base_url)
                self._abort_if_unique_id_configured()

                data: dict[str, Any] = {CONF_BASE_URL: base_url}
                if session_id:
                    data[CONF_SESSION_ID] = session_id
                if reference_audio_url:
                    data[CONF_REFERENCE_AUDIO_URL] = reference_audio_url

                return self.async_create_entry(title="Qwen TTS", data=data)

        schema = vol.Schema(
            {
                vol.Required(CONF_BASE_URL): cv.url,
                vol.Optional(CONF_SESSION_ID): str,
                vol.Optional(CONF_REFERENCE_AUDIO_URL): cv.url,
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema, errors=errors)
