"""Issue #15: path-taking and vault-destroying API endpoints are "this PC only".

The access gate (#14) lets a remote client with a valid Bearer token through;
these endpoints must still refuse it, because they point the server at
arbitrary directories on the server PC or remove a whole vault from disk.
Everything runs against temp vaults (WIKI_VAULTS_DIR → tmp_path, tokens too).
"""
from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import pytest
from fastapi.testclient import TestClient

from raven.api.server import app
from raven.core import access, mcp_tokens
from raven.core.db import build_db
from raven.core.registry import registry
from raven.core.vault import Vault

LOCAL = ("127.0.0.1", 50000)
LAN = ("192.168.0.20", 50000)


@dataclass
class Case:
    method: str
    url: str
    body: dict | None
    ok: int  # status from a local, allowed caller
    untouched: Callable[[], None]  # asserts the refused call changed nothing
    done: Callable[[], None] = lambda: None  # asserts the allowed call took effect


@pytest.fixture
def root(tmp_path, monkeypatch) -> Path:
    r = tmp_path / "vaults"
    r.mkdir()
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(r))
    return r


def _registered() -> set[str]:
    return {m.name for m in registry().list()}


def _make(root: Path, tmp_path: Path, endpoint: str) -> Case:
    """Build one endpoint's request against a fresh temp vault ``alpha``."""
    alpha = Vault.create("alpha", root / "alpha")
    outside = tmp_path / "outside"
    if endpoint == "create":
        return Case("POST", "/api/vaults", {"name": "beta", "path": str(outside / "beta")}, 200,
                    lambda: (_assert(not (outside / "beta").exists()), _assert("beta" not in _registered())),
                    lambda: _assert("beta" in _registered()))
    if endpoint == "register":
        (outside / "existing").mkdir(parents=True)
        return Case("POST", "/api/vaults/register", {"name": "beta", "path": str(outside / "existing")}, 200,
                    lambda: _assert("beta" not in _registered()), lambda: _assert("beta" in _registered()))
    if endpoint == "workspace":
        outside.mkdir()
        return Case("POST", "/api/vaults/alpha/workspace", {"workspace_path": str(outside)}, 200,
                    lambda: _assert(not (registry().get("alpha").workspace_path or "")),
                    lambda: _assert(registry().get("alpha").workspace_path == str(outside.resolve())))
    if endpoint == "repair":
        shutil.copytree(alpha.root, outside / "moved")  # a real vault dir elsewhere on the server
        return Case("POST", "/api/vaults/alpha/repair", {"path": str(outside / "moved")}, 200,
                    lambda: _assert(Path(registry().get("alpha").path).resolve() == alpha.root.resolve()),
                    lambda: _assert(Path(registry().get("alpha").path).resolve() == (outside / "moved").resolve()))
    if endpoint == "clone":
        return Case("POST", "/api/vaults/alpha/clone", {"name": "beta", "path": str(outside / "beta")}, 200,
                    lambda: (_assert(not (outside / "beta").exists()), _assert("beta" not in _registered())),
                    lambda: _assert((outside / "beta").is_dir()))
    if endpoint == "export-out-dir":
        build_db(alpha, run_lint=False)
        return Case("POST", f"/api/vaults/alpha/export?out_dir={outside / 'site'}", None, 200,
                    lambda: _assert(not (outside / "site").exists()), lambda: _assert((outside / "site").is_dir()))
    if endpoint == "delete-force":
        return Case("DELETE", "/api/vaults/alpha?force=true", None, 200,
                    lambda: (_assert(alpha.root.exists()), _assert("alpha" in _registered())),
                    lambda: _assert(not alpha.root.exists()))
    if endpoint == "archive-clean-apply":
        archived = alpha.root / "_archive" / "content" / "old-20200101-000000.md"
        archived.parent.mkdir(parents=True, exist_ok=True)
        archived.write_text("---\ntitle: old\n---\nold\n", encoding="utf-8")
        return Case("POST", "/api/vaults/alpha/archive/clean?older_than=0&apply=true", None, 200,
                    lambda: _assert(archived.exists()), lambda: _assert(not archived.exists()))
    raise AssertionError(endpoint)


def _assert(cond) -> None:
    assert cond


ENDPOINTS = ["create", "register", "workspace", "repair", "clone", "export-out-dir", "delete-force", "archive-clean-apply"]


def _send(client: TestClient, case: Case, headers: dict | None = None):
    return client.request(case.method, case.url, json=case.body, headers=headers or {})


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize(
    "origin", [None, "http://localhost:5173", "http://LOCALHOST:5173", "http://127.0.0.1:8765", "tauri://localhost", "http://tauri.localhost"]
)
def test_local_caller_keeps_working(root, tmp_path, endpoint, origin) -> None:
    """The Desktop webview, the local Dashboard (vite) and the CLI/curl are unaffected."""
    case = _make(root, tmp_path, endpoint)
    res = _send(TestClient(app, client=LOCAL), case, {"Origin": origin} if origin else None)
    assert res.status_code == case.ok, (origin, res.text)
    case.done()


@pytest.mark.parametrize("endpoint", ["archive-clean-apply", "delete-force"])
def test_local_dashboard_through_its_own_proxy_keeps_working(root, tmp_path, monkeypatch, endpoint) -> None:
    """vite on this PC adds X-Forwarded-For: 127.0.0.1 for a local browser (launcher mode)."""
    monkeypatch.setattr(access, "_socket_peer", True)
    case = _make(root, tmp_path, endpoint)
    headers = {"X-Forwarded-For": "127.0.0.1", "Origin": "http://localhost:5173"}
    assert _send(TestClient(app, client=LOCAL), case, headers).status_code == case.ok
    case.done()


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_remote_caller_with_a_valid_token_is_refused(root, tmp_path, endpoint) -> None:
    """Before #15 a LAN/tailnet client holding any API token could do all of these."""
    case = _make(root, tmp_path, endpoint)
    token = mcp_tokens.add_token("lan")
    res = _send(TestClient(app, client=LAN), case, {"Authorization": f"Bearer {token}"})
    assert res.status_code == 403, res.text
    assert "이 PC에서만" in res.json()["detail"] and "백업" not in res.json()["detail"]
    case.untouched()


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_remote_caller_without_a_token_never_reaches_the_handler(root, tmp_path, endpoint) -> None:
    case = _make(root, tmp_path, endpoint)
    assert _send(TestClient(app, client=LAN), case).status_code == 401
    case.untouched()


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_tailnet_via_the_local_dashboard_proxy_is_refused(root, tmp_path, monkeypatch, endpoint) -> None:
    """vite (xfwd) on this PC forwards a tailnet browser: socket peer is loopback, XFF is not."""
    monkeypatch.setattr(access, "_socket_peer", True)  # Raven launcher mode
    case = _make(root, tmp_path, endpoint)
    token = mcp_tokens.add_token("ts")
    headers = {"Authorization": f"Bearer {token}", "X-Forwarded-For": "100.101.1.2"}
    assert _send(TestClient(app, client=LOCAL), case, headers).status_code == 403
    case.untouched()


@pytest.mark.parametrize("endpoint", ENDPOINTS)
@pytest.mark.parametrize(
    "origin",
    ["http://evil.example", "http://192.168.0.5:5173", "http://100.101.1.2:5173", "null", "http://localhost@evil.example", "http://localhost.evil.example"],
)
def test_loopback_socket_with_a_foreign_origin_is_refused(root, tmp_path, endpoint, origin) -> None:
    """DNS rebinding / a LAN page through a local proxy: socket is loopback, Origin is not."""
    case = _make(root, tmp_path, endpoint)
    # Issue #28: without a token the access gate refuses it first (no tokenless loopback
    # trust for a foreign Origin) ...
    res = _send(TestClient(app, client=LOCAL), case, {"Origin": origin})
    assert res.status_code == 401 and "Host/Origin" in res.json()["detail"], res.text
    case.untouched()
    # ... and with a token this route's own guard still keeps it to this PC (#15).
    token = mcp_tokens.add_token("t28")
    res = _send(TestClient(app, client=LOCAL), case, {"Origin": origin, "Authorization": f"Bearer {token}"})
    assert res.status_code == 403 and "이 PC에서만" in res.json()["detail"], res.text
    case.untouched()


@pytest.mark.parametrize("endpoint", ENDPOINTS)
def test_unknown_source_with_a_token_is_refused(root, tmp_path, monkeypatch, endpoint) -> None:
    """Strict mode: a proxied request with a token passes the gate as source "unknown" — not this PC."""
    monkeypatch.setattr(access, "_socket_peer", False)
    case = _make(root, tmp_path, endpoint)
    token = mcp_tokens.add_token("t")
    headers = {"Authorization": f"Bearer {token}", "X-Forwarded-For": "127.0.0.1"}
    assert _send(TestClient(app, client=LOCAL), case, headers).status_code == 403
    case.untouched()


@pytest.mark.parametrize("peer", ["::1", "::ffff:127.0.0.1", "127.0.0.2"])
def test_ipv6_and_mapped_loopback_count_as_this_pc(root, tmp_path, peer) -> None:
    case = _make(root, tmp_path, "archive-clean-apply")
    assert _send(TestClient(app, client=(peer, 50000)), case).status_code == 200


def test_delete_without_force_keeps_its_409_and_stays_open_to_remote(root, tmp_path) -> None:
    """force=false only unregisters and refuses a vault with pages — unchanged for everyone."""
    alpha = Vault.create("alpha", root / "alpha")
    (alpha.root / "content").mkdir(exist_ok=True)
    (alpha.root / "content" / "page.md").write_text("---\ntitle: p\n---\nbody\n", encoding="utf-8")
    token = mcp_tokens.add_token("lan")
    remote = TestClient(app, client=LAN)
    assert remote.delete("/api/vaults/alpha", headers={"Authorization": f"Bearer {token}"}).status_code == 409
    assert TestClient(app, client=LOCAL).delete("/api/vaults/alpha").status_code == 409
    assert alpha.root.exists() and "alpha" in _registered()


def test_archive_clean_dry_run_stays_open_to_remote(root, tmp_path) -> None:
    case = _make(root, tmp_path, "archive-clean-apply")
    token = mcp_tokens.add_token("lan")
    res = TestClient(app, client=LAN).post(
        "/api/vaults/alpha/archive/clean?older_than=0&apply=false", headers={"Authorization": f"Bearer {token}"}
    )
    assert res.status_code == 200, res.text
    case.untouched()


def test_export_to_the_default_location_stays_open_to_remote(root, tmp_path) -> None:
    Vault.create("alpha", root / "alpha")
    token = mcp_tokens.add_token("lan")
    res = TestClient(app, client=LAN).post("/api/vaults/alpha/export", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, res.text


def test_page_write_and_delete_stay_open_to_authenticated_remote(root, tmp_path) -> None:
    """In-vault page edits are the remote Dashboard's job; the token gate guards them (#15 scope note)."""
    Vault.create("alpha", root / "alpha")
    token = mcp_tokens.add_token("lan")
    remote = TestClient(app, client=LAN)
    auth = {"Authorization": f"Bearer {token}"}
    body = {"title": "Remote Note", "type": "concept", "content": "hello"}
    assert remote.post("/api/vaults/alpha/pages", json={"slug": "content/remote-note", **body}, headers=auth).status_code in (200, 201)
    assert remote.delete("/api/vaults/alpha/pages/content/remote-note", headers=auth).status_code == 200
    assert TestClient(app, client=LAN).delete("/api/vaults/alpha/pages/content/x").status_code == 401


@pytest.mark.parametrize("new_name", ["../escaped", "a/b", "..", ".", "a\\b", "ABSOLUTE"])
def test_rename_cannot_move_a_vault_out_of_its_folder(root, tmp_path, new_name) -> None:
    """#15 review: rename took any string, so "../x" or an absolute name moved the vault anywhere."""
    alpha = Vault.create("alpha", root / "alpha")
    if new_name == "ABSOLUTE":
        new_name = str(tmp_path / "escaped")
    token = mcp_tokens.add_token("lan")
    for client, headers in ((TestClient(app, client=LOCAL), {}), (TestClient(app, client=LAN), {"Authorization": f"Bearer {token}"})):
        assert client.put("/api/vaults/alpha", json={"name": new_name}, headers=headers).status_code == 400
    assert alpha.root.is_dir() and not (tmp_path / "escaped").exists() and not (root.parent / "escaped").exists()


def test_rename_does_not_replace_an_existing_directory(root) -> None:
    alpha = Vault.create("alpha", root / "alpha")
    (root / "taken").mkdir()
    assert TestClient(app, client=LOCAL).put("/api/vaults/alpha", json={"name": "taken"}).status_code == 409
    assert alpha.root.is_dir() and (root / "taken").is_dir()


def test_plain_rename_stays_open_to_authenticated_remote(root) -> None:
    Vault.create("alpha", root / "alpha")
    token = mcp_tokens.add_token("lan")
    res = TestClient(app, client=LAN).put("/api/vaults/alpha", json={"name": "renamed"}, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200, res.text
    assert (root / "renamed").is_dir() and "renamed" in _registered()
