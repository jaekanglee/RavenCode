# Issue #67 — Loopback token enforcement (opt-in)

Docker Desktop on macOS may forward `host.docker.internal` connections to the host with an apparent TCP peer of `127.0.0.1`. A container can supply `Host: 127.0.0.1:<port>`, bypassing the default loopback exception. Neither Host/Origin headers nor the ASGI peer address prove that the caller is a trusted local process.

## Hardened mode

Set `RAVEN_REQUIRE_LOOPBACK_TOKEN=1` **in the environment of every Core API and MCP HTTP server process**, then restart those processes. The shared `TokenGate` requires a valid `Authorization: Bearer <token>` on *all* HTTP and WebSocket requests, including loopback. Existing token creation and revocation mechanisms are reused.

Truthy values: `1`, `true`, `yes`, `on` (case-insensitive). When unset, existing behavior is preserved for compatibility.

**Important:** Do not enable this on an active deployment until all local clients (desktop WebView, dashboard/Vite proxy, CLI, health checks and MCP clients) are configured to authenticate. The default remains vulnerable to the documented Docker Desktop spoofing path. This opt-in does **not** by itself close #67 for default installations.

## Validation

- With the mode enabled, tokenless loopback and spoofed Host requests must return 401 for both Core and MCP.
- A valid Bearer token must succeed, and a revoked token must fail.
- With the mode unset, current loopback clients must remain functional.
- Test actual macOS Docker Desktop forwarding and client compatibility before enabling in production.

## Remaining work

Provide secure credentials to all first-party local clients, migrate the default policy to fail-closed, and independently verify that Docker-hosted requests cannot bypass it. Until then, avoid running untrusted containers on the same host as a sensitive Raven vault.
