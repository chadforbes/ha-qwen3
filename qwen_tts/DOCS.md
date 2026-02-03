# Qwen TTS Add-on

This add-on provides a lightweight ingress dashboard inside Home Assistant.

## Ingress security

Per Home Assistant ingress requirements, the web server only allows connections from `172.30.32.2` and denies all others.

## Notes

- This add-on can proxy requests to your remote Qwen3 server under `/api/*` (same-origin), which avoids browser CORS + mixed-content issues under Home Assistant ingress.
- Configure the remote server URL via the add-on option `remote_url`.
