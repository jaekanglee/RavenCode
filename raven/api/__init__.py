"""raven.api — FastAPI HTTP server.

Exposes the raven engine to the React dashboard (and any HTTP client).
Designed for local-first: binds to 127.0.0.1 (single-user). Non-loopback sources
need a Bearer token unless they are on the tailnet (raven/core/access.py, Issue #14).

Endpoints (all under /api):
    GET    /vaults                      list registered vaults
    GET    /vaults/{name}               vault metadata + stats
    POST   /vaults/{name}/select        set as active (writes registry)
    GET    /vaults/{name}/pages         list pages (optional ?type=, ?tag=)
    GET    /vaults/{name}/pages/{slug}  page content (frontmatter+body)
    POST   /vaults/{name}/pages         create page (json: slug, title, content, ...)
    PUT    /vaults/{name}/pages/{slug}  overwrite page
    DELETE /vaults/{name}/pages/{slug}  archive page
    GET    /vaults/{name}/search?q=     BM25-lite search (top_k default 10)
    GET    /vaults/{name}/link-check    broken/missing wikilinks
    POST   /vaults/{name}/build         rebuild wiki.db + run lint
    POST   /vaults/{name}/export        static JSON export for GUI

Run:
    python -m raven.api                    # default 127.0.0.1:8765
    python -m raven.api --host 0.0.0.0     # bind all (e.g. Tailscale)
"""
from .server import app

__all__ = ["app"]
