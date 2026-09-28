"""#24 운영 지침 계약 — 정책 파일의 값을 제품의 실제 계약과 대조한다.

ADR: _meta/decisions/adr-2026-09-25-vault-policy-slot-and-mcp-delivery.md (4단계)

정책 repo 검증기는 type 9종·stale 90일을 상수로 들고 있어 제품이 바뀌면 낡았다.
이 체크는 제품 코드의 상수를 그대로 쓴다. 정책의 판단 내용(저장 기준 등)은
사용자 소유라 검사하지 않고, ```yaml 블록의 제품 계약 값만 본다.
"""
from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pytest

from raven.core import lint as lint_module
from raven.core.contracts import PAGE_TYPES
from raven.core.vault import VAULT_POLICY_RELPATH, Vault


@pytest.fixture
def vault(monkeypatch):
    reg_root = Path(tempfile.mkdtemp(prefix="raven-polint-reg-"))
    target_root = Path(tempfile.mkdtemp(prefix="raven-polint-target-"))
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(reg_root))
    v = Vault.create("polint", target_root / "polint")
    yield v
    shutil.rmtree(reg_root, ignore_errors=True)
    shutil.rmtree(target_root, ignore_errors=True)


def write_policy(v: Vault, yaml_block: str, prose: str = "# 지침\n\n자유 서술.\n") -> None:
    path = v.root / VAULT_POLICY_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{prose}\n```yaml\n{yaml_block}```\n", encoding="utf-8")


def issues(v: Vault) -> list[dict]:
    return lint_module.check_policy_contract(v)


def test_no_policy_file_means_no_issues(vault):
    assert issues(vault) == []


def test_prose_only_policy_is_not_judged(vault):
    path = vault.root / VAULT_POLICY_RELPATH
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# 지침\n\n재사용 가치가 있을 때만 남긴다.\n", encoding="utf-8")
    assert issues(vault) == []


def test_valid_contract_values_pass(vault):
    write_policy(vault, (
        "classification:\n  types: [concept, rule, journal]\n"
        "metadata:\n  required_fields: [title, type, created, updated]\n"
        f"gardening:\n  stale_threshold_days: {lint_module.STALE_DAYS}\n"
    ))
    assert issues(vault) == []


def test_type_outside_product_enum_is_warning(vault):
    write_policy(vault, "classification:\n  types: [concept, decision]\n")
    found = issues(vault)
    assert [i["severity"] for i in found] == ["warning"]
    assert "decision" in found[0]["message"]
    assert found[0]["slug"] == VAULT_POLICY_RELPATH[:-3]


def test_owner_approved_type_exception_is_honored(vault):
    write_policy(vault, (
        "classification:\n  types: [concept, lesson]\n"
        "validator_exceptions:\n"
        "  - rule: core-types\n    values: [lesson]\n"
        "    approved_by: owner\n    approved_at: 2026-07-31\n"
    ))
    assert issues(vault) == []


def test_exception_without_approval_is_not_honored(vault):
    write_policy(vault, (
        "classification:\n  types: [lesson]\n"
        "validator_exceptions:\n  - rule: core-types\n    values: [lesson]\n"
    ))
    assert len(issues(vault)) == 1


def test_stale_threshold_must_match_product(vault):
    write_policy(vault, "gardening:\n  stale_threshold_days: 30\n")
    found = issues(vault)
    assert [i["severity"] for i in found] == ["warning"]
    assert str(lint_module.STALE_DAYS) in found[0]["message"]


def test_required_fields_missing_product_field_is_info(vault):
    write_policy(vault, "metadata:\n  required_fields: [title, type]\n")
    found = issues(vault)
    assert [i["severity"] for i in found] == ["info"]
    assert "created" in found[0]["message"] and "updated" in found[0]["message"]


def test_page_types_is_the_single_source(vault):
    assert PAGE_TYPES == frozenset(
        {"concept", "person", "comparison", "project", "tool", "rule", "query", "journal", "issue"}
    )


def test_run_all_includes_policy_check(vault):
    write_policy(vault, "classification:\n  types: [decision]\n")
    result = lint_module.run_all(vault)
    assert result["by_check"].get("#24") == 1
    assert "#24" in lint_module.CHECK_REGISTRY
