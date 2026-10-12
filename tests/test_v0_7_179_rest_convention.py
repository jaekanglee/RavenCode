"""REST 관례 정리 — clone 경로 + 에러 envelope (docs/issues/ 2건 마감).

`docs/issues/vaults-clone-rest-네이밍-위반.md`: `POST /api/vaults/clone`은 동작을
경로 세그먼트로 노출한다. v0.7.68이 `POST /api/vaults/create` → `POST /api/vaults`로
고친 것과 동일한 위반이 형제 엔드포인트에 남아 있었다. 소스 vault를 경로
파라미터로 식별하는 `POST /api/vaults/{name}/clone`으로 옮긴다.

`docs/issues/server-전역-에러-envelope-불일치.md`: 진짜 실패를 200 + `{ok: false}`로
표현하던 사이트만 HTTPException으로 전환한다. 조회 결과·graceful degrade는
성공 형태가 계약이므로 건드리지 않는다 — 그 경계를 여기서 고정한다.
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
from raven.core import log as log_module
from raven.core.vault import Vault, VaultMeta


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def isolated_env(monkeypatch):
    reg_root = Path(tempfile.mkdtemp(prefix="raven-rest-reg-"))
    target_root = Path(tempfile.mkdtemp(prefix="raven-rest-target-"))
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    yield {"reg_root": reg_root, "target_root": target_root}
    shutil.rmtree(reg_root, ignore_errors=True)
    shutil.rmtree(target_root, ignore_errors=True)


def _make_source(client, isolated_env, name: str) -> Path:
    src = isolated_env["target_root"] / name
    client.post("/api/vaults", json={"name": name, "path": str(src), "bootstrap": False})
    (src / "content").mkdir(parents=True, exist_ok=True)
    (src / "content" / "hello.md").write_text("# Hi\n", encoding="utf-8")
    return src


class TestCloneRestPath:
    def test_clone_uses_source_vault_as_path_parameter(self, client, isolated_env):
        _make_source(client, isolated_env, "csrc")
        dst = isolated_env["target_root"] / "cdst"

        resp = client.post(
            "/api/vaults/csrc/clone", json={"name": "cdst", "path": str(dst)}
        )

        assert resp.status_code == 200, resp.text
        assert (dst / "content" / "hello.md").is_file()
        assert resp.json()["vault"]["src"] == "csrc"

    def test_action_as_path_segment_is_gone(self, client, isolated_env):
        """`POST /api/vaults/clone`은 더 이상 존재하지 않아야 한다.

        FastAPI는 이 경로를 `/api/vaults/{name}` DELETE/GET과 헷갈릴 수 있어
        '사라졌다'를 status로만 판정하면 약하다. 등록된 route 목록으로 확인한다.
        """
        paths = {getattr(r, "path", "") for r in app.routes}
        assert "/api/vaults/clone" not in paths
        assert "/api/vaults/{name}/clone" in paths

    def test_unknown_source_vault_rejected(self, client, isolated_env):
        dst = isolated_env["target_root"] / "cdst-unknown"
        resp = client.post(
            "/api/vaults/nonexistent/clone", json={"name": "cdst3", "path": str(dst)}
        )
        assert resp.status_code == 404

    def test_duplicate_target_name_rejected(self, client, isolated_env):
        _make_source(client, isolated_env, "csrc2")
        dst = isolated_env["target_root"] / "cdst2"
        client.post("/api/vaults", json={"name": "cdst2", "path": str(dst), "bootstrap": False})

        resp = client.post(
            "/api/vaults/csrc2/clone", json={"name": "cdst2", "path": str(dst)}
        )
        assert resp.status_code == 409


class TestErrorEnvelopeConverted:
    @pytest.fixture
    def registered_vault(self, tmp_path, monkeypatch):
        reg_root = Path(tempfile.mkdtemp(prefix="raven-envelope-reg-"))
        monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
        from raven.core.registry import registry as _registry

        (tmp_path / "content").mkdir()
        meta = VaultMeta(name="envelope-test", path=tmp_path, mode="personal", owner="user")
        v = Vault.load(meta)
        log_module.ensure_log(v)
        _registry().add(meta)
        yield v
        shutil.rmtree(reg_root, ignore_errors=True)

    def test_log_rotate_refusal_is_a_client_error(self, client, registered_vault):
        """500 entries 미만 rotate 거부는 클라이언트 오류다 — 200 + ok:false ❌."""
        resp = client.post(f"/api/vaults/{registered_vault.meta.name}/log/rotate")

        assert resp.status_code == 409
        detail = resp.json()["detail"]
        assert "500" in str(detail)

    def test_log_rotate_force_still_succeeds(self, client, registered_vault):
        """거부가 409가 되어도 force 경로의 성공 계약은 그대로다."""
        resp = client.post(
            f"/api/vaults/{registered_vault.meta.name}/log/rotate?force=true"
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is True
        assert "rotated_to" in body

    def test_dead_error_helper_is_removed(self):
        """호출자가 0개였던 `_err()`가 남아 있으면 envelope 통일이 무의미해진다."""
        from raven.api import server

        assert not hasattr(server, "_err")


class TestErrorEnvelopePreserved:
    """성공 형태가 계약인 사이트는 전환 대상이 아니다 — 과잉 전환 방지 가드."""

    @pytest.fixture
    def registered_vault(self, tmp_path, monkeypatch):
        reg_root = Path(tempfile.mkdtemp(prefix="raven-preserve-reg-"))
        monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
        from raven.core.registry import registry as _registry

        (tmp_path / "content").mkdir()
        meta = VaultMeta(name="preserve-test", path=tmp_path, mode="personal", owner="user")
        v = Vault.load(meta)
        _registry().add(meta)
        yield v
        shutil.rmtree(reg_root, ignore_errors=True)

    def test_crosslink_miss_stays_a_lookup_result(self, client, registered_vault):
        """'못 찾았다'는 조회 결과다 — 404로 바꾸면 federation 계약이 깨진다."""
        resp = client.post(
            f"/api/crosslink/{registered_vault.meta.name}",
            json={"slug": "missing-everywhere"},
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is False
        assert body["not_found"] is True

    def test_debug_log_write_failure_never_becomes_5xx(self, client, monkeypatch):
        """전역 에러 보고 채널이 500을 던지면 에러 보고가 에러를 부른다."""
        def explode(*_args, **_kwargs):
            raise OSError("disk full")

        monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
        monkeypatch.setattr(Path, "mkdir", explode)
        resp = client.post("/api/debug-log", json={"level": "error", "message": "x"})

        assert resp.status_code == 200
        assert resp.json()["ok"] is False

    def test_lint_failure_degrades_gracefully(self, client, registered_vault, monkeypatch):
        """AGENTS.md §9: lint 실패는 빈 counts로 degrade하고 500으로 새지 않는다."""
        from raven.core import lint as lint_module

        monkeypatch.setattr(
            lint_module, "run_all", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("boom"))
        )
        resp = client.get(f"/api/vaults/{registered_vault.meta.name}/lint")

        assert resp.status_code == 200
        body = resp.json()
        assert body["ok"] is False
        assert body["counts"]["total"] == 0
