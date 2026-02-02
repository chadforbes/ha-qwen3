# Qwen TTS Add-on

This add-on provides a lightweight ingress dashboard inside Home Assistant.

## Ingress security

Per Home Assistant ingress requirements, the web server only allows connections from `172.30.32.2` and denies all others.

## Notes

- This add-on does **not** proxy requests to your remote Qwen TTS server; the dashboard runs in the browser and calls the remote server via fetch.
- Your remote server must be reachable from the client device and may require CORS configuration.
