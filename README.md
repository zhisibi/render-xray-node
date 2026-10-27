# render-xray

Node supervisor + Xray (VLESS + WebSocket, edge-terminated TLS) for a free
Render web service. Adapted from the Velixir deployment of 2026-10-26.

Layout:
- `index.js` — HTTP camouflage page, `/health`, `/sub/<token>`, `/link/<token>`,
  WS-upgrade forwarding to Xray on 127.0.0.1:10000, Xray supervisor.
- `setup-xray.sh` — build step: downloads the official Xray v26.10.21
  linux-64 zip from XTLS GitHub releases and verifies it against the
  official `.dgst` SHA2-256 before unpacking to `core/xray`.
- `render.yaml` — Blueprint: free plan, singapore region,
  build `bash setup-xray.sh`, start `node index.js`, health check `/health`.
- Secrets are NOT in this repo. They are supplied as Render env vars
  (`NODE_UUID`, `WS_PATH`, `SUB_TOKEN`, `REMARK`), prompted at Blueprint
  creation because they are marked `sync: false`.

Free-plan behaviour (Render docs): spins down after 15 min without inbound
traffic (HTTP or WS), wakes in about 1 min on the next request/connection,
750 free instance hours per workspace per month.
