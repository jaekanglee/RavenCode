"""vault 운영 지침 REST 표면 — Dashboard 편집기의 백엔드.

ADR: _meta/decisions/adr-2026-09-25-vault-policy-slot-and-mcp-delivery.md (3단계)

사람이 Dashboard에서 지침을 읽고 쓴다. 쓰기는 본문을 그대로 저장한다 —
페이지와 달리 frontmatter를 끼워 넣지 않는다. 읽기는 파일을 만들지 않는다.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from raven.api.server import app
from raven.core.vault import VAULT_POLICY_RELPATH, Vault

POLICY_TEXT = "# 운영 지침\n\n저장 기준: 재사용 가치가 있을 때만.\n"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def vault(monkeypatch):
    reg_root = Path(tempfile.mkdtemp(prefix="raven-policy-reg-"))
    target_root = Path(tempfile.mkdtemp(prefix="raven-policy-target-"))
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    v = Vault.create("policy-api", target_root / "policy-api")
    yield v
    shutil.rmtree(reg_root, ignore_errors=True)
    shutil.rmtree(target_root, ignore_errors=True)


def url(v: Vault) -> str:
    return f"/api/vaults/{v.meta.name}/policy"


def test_get_without_policy_offers_template_but_creates_nothing(client, vault):
    resp = client.get(url(vault))
    assert resp.status_code == 200
    body = resp.json()
    assert body["content"] is None
    assert body["precondition"] == ""
    assert body["template"].strip(), "빈 vault에서 '템플릿에서 시작'할 양식이 있어야 한다"
    assert not (vault.root / VAULT_POLICY_RELPATH).exists()


def test_put_saves_content_verbatim(client, vault):
    resp = client.put(url(vault), json={"content": POLICY_TEXT, "precondition": ""})
    assert resp.status_code == 200, resp.text
    saved = (vault.root / VAULT_POLICY_RELPATH).read_text(encoding="utf-8")
    assert saved == POLICY_TEXT, "페이지처럼 frontmatter를 끼워 넣으면 안 된다"

    body = client.get(url(vault)).json()
    assert body["content"] == POLICY_TEXT
    assert body["precondition"] == resp.json()["precondition"]
    assert "template" not in body or body["template"] is None


def test_put_with_stale_precondition_is_rejected(client, vault):
    first = client.put(url(vault), json={"content": POLICY_TEXT, "precondition": ""}).json()
    client.put(url(vault), json={"content": "다른 탭의 저장\n", "precondition": first["precondition"]})

    resp = client.put(url(vault), json={"content": "내 저장\n", "precondition": first["precondition"]})

    assert resp.status_code == 409
    assert (vault.root / VAULT_POLICY_RELPATH).read_text(encoding="utf-8") == "다른 탭의 저장\n"


def test_create_assertion_fails_when_policy_already_exists(client, vault):
    client.put(url(vault), json={"content": POLICY_TEXT, "precondition": ""})
    resp = client.put(url(vault), json={"content": "덮어쓰기\n", "precondition": ""})
    assert resp.status_code == 409


def test_put_records_create_then_update_in_log(client, vault):
    client.put(url(vault), json={"content": POLICY_TEXT, "precondition": ""})
    token = client.get(url(vault)).json()["precondition"]
    client.put(url(vault), json={"content": POLICY_TEXT + "추가\n", "precondition": token})

    log = (vault.root / "log.md").read_text(encoding="utf-8")
    assert f"create | {VAULT_POLICY_RELPATH}" in log
    assert f"update | {VAULT_POLICY_RELPATH}" in log


def test_unknown_vault_is_404(client, vault):
    assert client.get("/api/vaults/no-such-vault/policy").status_code == 404
    assert client.put("/api/vaults/no-such-vault/policy", json={"content": "x"}).status_code == 404
