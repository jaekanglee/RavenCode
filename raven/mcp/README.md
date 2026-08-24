# Wiki MCP Server

Model Context Protocol server for the wiki vault. Exposes 9 tools + 5 resources
backed by `wiki.db` (SQLite, SCHEMA v2.4).

## Install

```bash
cd /Users/jaekanglee/Desktop/Dev/Project/Raven
source scripts/.venv/bin/activate
pip install -r ../../requirements.txt   # MCP SDK 핀의 단일 진실 원천 (mcp>=2.0)
```

## Usage

### stdio (local process / desktop MCP client)

```bash
# Default — read-only
python -m mcp.cli

# With write access (wiki_update / wiki_ingest)
python -m mcp.cli --mode write

# With admin access (+ wiki_delete / wiki_rename)
python -m mcp.cli --mode admin
```

To run as a module from the vault root:

```bash
cd /Users/jaekanglee/Desktop/Dev/Project/Raven
scripts/.venv/bin/python -m mcp.cli --mode read
```

### HTTP (Tailscale remote)

```bash
python -m mcp.cli --transport http --host 127.0.0.1 --port 8766 --mode read
# Streamable-HTTP transport; bind to Tailscale IP for remote access.
```

### CLI flags

| Flag | Default | Notes |
|---|---|---|
| `--transport` | `stdio` | `stdio` (local) or `http` (remote) |
| `--host` | `127.0.0.1` | HTTP bind host (use Tailscale IP for remote) |
| `--port` | `8766` | HTTP bind port (8765는 API 몫 — 겹치면 bind 실패) |
| `--mode` | `read` | `read` / `write` / `admin` — access level for this process, applies across every vault it serves |

**v0.7.6x+: no `--vault` flag.** One server process serves every vault the
registry knows about (`WIKI_VAULTS_DIR`/`.registry.json`) — each tool call
picks its target vault via the `vault` argument (registered vault name),
mirroring `raven.api.server`'s `/api/vaults/{name}/...` routes. See
[ADR-2026-07-03](../../_meta/decisions/adr-2026-07-03-mcp-multi-vault.md).

## Tools (9)

Every tool takes `vault: str` (a name from `raven vault list`) as its first
argument; an unregistered name fails with a message listing what *is*
registered.

### Read (always available)

- `wiki_search(vault: str, query: str, top_k: int = 10) -> list[dict]` — FTS5 BM25 search.
- `wiki_get_page(vault: str, slug: str) -> dict | None` — single page with content, frontmatter, backlinks, outbound links, tags.
- `wiki_lint(vault: str) -> dict` — run `scripts/lint.py` and return `{critical, warning, info, total, issues[]}`.
- `wiki_graph(vault: str, project: str | None = None, fmt: str = "json") -> dict` — full link graph; optional substring filter on slug.
- `wiki_log(vault: str, tail_n: int = 20) -> list[dict]` — last N non-empty log.md lines.

### Write (requires `--mode write` or `--admin`)

- `wiki_update(vault: str, slug: str, content: str, frontmatter: dict | None = None) -> dict` — overwrite a vault page (slug must include a category, e.g. `concepts/wiki`).
- `wiki_ingest(vault: str, source: str, project: str | None = None, mode: str = "auto", *, user_command: bool = False) -> dict` — copy a raw source into `<vault>/raw/<project>/`. **v0.7.55+ (ADR-2026-07-02): raw/ 폴더는 사람 1차 운영 영역이므로 `user_command=True` 필수.** 에이전트 자율 호출은 `error: "user_command_required"`로 거부. 사람은 `raven raw ingest` (CLI) / Dashboard `/raw` 패널 경유.

### Admin (requires `--mode admin`)

- `wiki_delete(vault: str, slug: str) -> dict` — archives the page to `_archive/<slug>-<timestamp>.md` and rebuilds `wiki.db`. Reversible (revert via git, then rebuild).
- `wiki_rename(vault: str, old_slug: str, new_slug: str) -> dict` — moves the file, rewrites every inbound `[[old_slug]]` wikilink across the vault, and rebuilds `wiki.db`. Adds an `aliases:` entry to the renamed file's frontmatter so old links resolve.

## Resources (5, always read-only)

- `wiki://{vault}/index` — full page catalog.
- `wiki://{vault}/page/{slug}` — one page with envelope `{found, slug, page}`.
- `wiki://{vault}/graph` — full link graph + counts.
- `wiki://{vault}/log/recent` — last 5000 chars of `log.md`.
- `wiki://{vault}/schema` — raw `SCHEMA.md` text.

## Permission model

| Mode | Tools registered |
|---|---|
| `read` (default) | search, get_page, lint, graph, log |
| `write` | + update, ingest |
| `admin` | + delete, rename |

Permission checks live in `mcp/tools/__init__.py::check_permission()` and are
also enforced inside each write tool via `VaultContext.require()`.

## Architecture

```
mcp/
├── __init__.py
├── cli.py          # CLI entry, MCPServer bootstrap, transport, mode gating
├── resources.py     # 5 wiki:// resources
├── db.py            # read-only sqlite helpers (single connection per call)
├── tools/
│   ├── __init__.py  # VaultContext, PermissionError_, check_permission
│   ├── read.py      # 5 read tools (search / get_page / lint / graph / log)
│   └── write.py     # 2 write tools (update / ingest) + 2 admin tools (delete / rename)
└── tests/
    ├── conftest.py
    ├── test_db.py
    └── test_tools.py
```

## Tests

```bash
cd /Users/jaekanglee/Desktop/Dev/Project/Raven
scripts/.venv/bin/python -m pytest mcp/tests/ -v
```

Tests run against the live `wiki.db`. If absent, `pytest.skip` is invoked
from the `wiki_db` fixture.

## Notes on the `mcp` namespace

> **Note**: There is no `mcp/server.py` — the CLI entry point is `mcp/cli.py`.
> Earlier README drafts referenced a `server.py` module that was never written;
> this section and the tree above are the canonical source of truth.
> To run the server, use `python -m mcp.cli` (not `python -m mcp.server`).

Our local package is named `mcp` (sibling of `wiki.db`). The real MCP SDK
(`mcp` ≥ 2.0) also ships an `mcp` package and provides `mcp.server.mcpserver.MCPServer`
(2.0 removed the old `mcp.server.fastmcp.FastMCP`).

`mcp/cli.py` handles the namespace collision by deferring the MCPServer
import to runtime and temporarily un-registering our local `mcp.*` from
`sys.modules` so the SDK can be loaded. The local package is restored
afterwards so tool body imports (`from mcp.tools import …`) still resolve.

If you add new tools or resources, prefer placing imports **inside** the
register function rather than at module top level to avoid this dance.