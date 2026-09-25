"""test_lint_p1_regressions.py — 2026-07-04 제품 평가 P1 lint 회귀 가드.

P1#4  — #11 index 완전성: DB에만 존재하는 `log`(log.md는 페이지가 아니라 인프라)가
        몇 번을 빌드해도 "재build 필요" 영구 오탐을 냈음 → log 슬러그 면제.
P1#6  — build가 스스로 생성하는 content/index.md, content/_index/*의 태그
        (`index`, `home`)가 core taxonomy에 없어 새 vault부터 #9 self-noise.
P1#11 — `_core_tags()`가 옛 경로 `_meta/SCHEMA.md`를 읽어 vault SCHEMA.md의
        태그 승격(core 목록 추가)이 무효였음 → `_meta/agents/SCHEMA.md` + 실제
        템플릿 헤더(`### Core (...)`) 파싱.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from raven.core.vault import Vault
from raven.core.lint import (
    CORE_TAGS_FALLBACK,
    _core_tags,
    check_index_completeness,
    check_tag_audit,
)
from raven.core import db as db_module


@pytest.fixture
def vault(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Vault:
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path))
    vault = Vault.create("lintv", tmp_path / "lintv")
    schema = vault.root / "_meta" / "agents" / "SCHEMA.md"
    schema.parent.mkdir(parents=True)
    schema.write_text(
        "### Core\n- 도메인: `pkm`\n- 상태: `draft`\n\n### Custom (자유, lint 면제)\n",
        encoding="utf-8",
    )
    return vault


def test_log_slug_exempt_from_index_completeness(vault: Vault):
    """P1#4: log.md는 DB에 색인돼도 #11 'DB에만 있음' 오탐을 내지 않는다."""
    db_module.build_db(vault, run_lint=False)
    issues = check_index_completeness(vault)
    log_issues = [i for i in issues if i["slug"] in ("log",) or i["slug"].startswith("log-")]
    assert log_issues == [], log_issues


def test_system_index_tags_are_core(vault: Vault):
    """P1#6: 시스템 생성 index 페이지의 태그(index/home)는 core taxonomy에 포함."""
    assert "index" in CORE_TAGS_FALLBACK
    assert "home" in CORE_TAGS_FALLBACK


def test_vault_schema_core_tag_promotion_works(vault: Vault):
    """P1#11: vault의 _meta/agents/SCHEMA.md core 목록에 태그를 추가하면 #9가 침묵."""
    schema = vault.root / "_meta" / "agents" / "SCHEMA.md"
    text = schema.read_text(encoding="utf-8")
    assert "### Core" in text  # 템플릿 전제
    text = text.replace("### Core", "### Core", 1)  # no-op, 위치 확인용
    text = text.replace(
        "- 상태: `draft`",
        "- 도메인: `승격된태그`\n- 상태: `draft`",
        1,
    )
    schema.write_text(text, encoding="utf-8")

    core = _core_tags(vault)
    assert "승격된태그" in core, f"동적 파싱 실패 — core={sorted(core)[:10]}..."

    (vault.root / "content" / "승격확인.md").write_text(
        "---\ntitle: 승격확인\ntype: concept\ntags: [승격된태그]\n"
        "created: 2026-07-04\nupdated: 2026-07-04\n---\n\n본문\n",
        encoding="utf-8",
    )
    issues = [i for i in check_tag_audit(vault) if "승격된태그" in i["message"]]
    assert issues == [], issues


def test_custom_section_tags_not_promoted(vault: Vault):
    """### Custom 섹션의 예시 태그는 core로 흡수되지 않는다."""
    schema = vault.root / "_meta" / "agents" / "SCHEMA.md"
    text = schema.read_text(encoding="utf-8")
    text = text.replace(
        "### Custom (자유, lint 면제)",
        "### Custom (자유, lint 면제)\n- 예시: `커스텀예시태그`",
        1,
    )
    schema.write_text(text, encoding="utf-8")
    assert "커스텀예시태그" not in _core_tags(vault)


def test_build_converges_in_one_pass(vault: Vault):
    """P1#5: build 1회 직후 #11(FS↔DB 불일치)이 0건 — 두 번 빌드할 필요 없음."""
    (vault.root / "content" / "수렴확인.md").write_text(
        "---\ntitle: 수렴확인\ntype: concept\ntags: [pkm]\n"
        "created: 2026-07-04\nupdated: 2026-07-04\n---\n\n본문\n",
        encoding="utf-8",
    )
    db_module.build_db(vault, run_lint=False)
    issues = check_index_completeness(vault)
    assert issues == [], issues


def test_garden_detects_stale_db(vault: Vault):
    """P1#12: garden이 낡은 wiki.db 기준으로 '정리 대상 없음' 거짓 안심을 주지 않도록
    FS↔DB 신선도 감지 헬퍼 제공."""
    from raven.core.garden import db_is_stale

    assert db_is_stale(vault) is True  # DB 자체가 없음
    db_module.build_db(vault, run_lint=False)
    assert db_is_stale(vault) is False

    import os, time
    fp = vault.root / "content" / "새파일.md"
    fp.write_text(
        "---\ntitle: 새파일\ntype: concept\ncreated: 2026-07-04\nupdated: 2026-07-04\n---\n\n본문\n",
        encoding="utf-8",
    )
    future = time.time() + 5
    os.utime(fp, (future, future))
    assert db_is_stale(vault) is True


def test_connect_rebuilds_stale_db_without_running_lint(vault: Vault, monkeypatch: pytest.MonkeyPatch):
    """읽기 경로(connect)의 지연 재빌드는 lint를 돌리지 않는다.

    connect()는 build_db 결과를 버리므로 lint는 순수 낭비였다 — 그래프 탭을 여는
    읽기 요청마다 전체 lint(중복 제목 O(n²) 포함, 169문서 vault에서 수 초)가 돌았다.
    """
    import os, time
    from raven.core import lint as lint_module

    calls: list[str] = []
    monkeypatch.setattr(lint_module, "run_all", lambda v: calls.append(v.meta.name) or {})

    db_module.connect(vault).close()  # DB 없음 → 빌드
    fp = vault.root / "content" / "새파일.md"
    fp.write_text(
        "---\ntitle: 새파일\ntype: concept\ncreated: 2026-07-04\nupdated: 2026-07-04\n---\n\n본문\n",
        encoding="utf-8",
    )
    future = time.time() + 5
    os.utime(fp, (future, future))
    db_module.connect(vault).close()  # stale → 재빌드

    assert calls == []
