"""Issue #47: only GEMINI_API_KEY may be sent to Google.

The five Gemini callers used to fall back to OPENAI_API_KEY / API_KEY and send
that value to generativelanguage.googleapis.com. Every HTTP request is caught
at the httpx transport here, so "0 requests" means nothing left the process.
Keys are fake.
"""
from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from raven.core import db as db_module
from raven.core.vault import Vault

KEY_VARS = ("GEMINI_API_KEY", "OPENAI_API_KEY", "API_KEY", "GOOGLE_API_KEY")
FAKE = {name: f"fake-{name.lower()}-value" for name in KEY_VARS}


@pytest.fixture
def vault(tmp_path: Path, monkeypatch) -> Vault:
    for name in KEY_VARS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    v = Vault.create("gemini-key-scope", tmp_path / "vault")
    (v.root / "content").mkdir(parents=True, exist_ok=True)
    return v


@pytest.fixture
def transport(monkeypatch):
    """Record every outgoing httpx request; answer with ``transport.reply`` text."""

    class Recorder:
        def __init__(self) -> None:
            self.requests: list[httpx.Request] = []
            self.reply = ""

    recorder = Recorder()

    def handle_request(_transport, request: httpx.Request) -> httpx.Response:
        recorder.requests.append(request)
        body = {"candidates": [{"content": {"parts": [{"text": recorder.reply}]}}]}
        return httpx.Response(200, json=body, request=request)

    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", handle_request)
    return recorder


def _write(v: Vault, name: str, text: str) -> None:
    (v.root / "content" / name).write_text(text, encoding="utf-8")


# Each feature: set up the vault, run it, return (result, llm reply text).

def _tagger(v: Vault):
    from raven.core.tagger import suggest_tags

    return lambda: suggest_tags(v, "User auth system using JWT token", title="Authentication"), '["jwt", "auth"]'


def _rag(v: Vault):
    from raven.core.rag import query_rag

    _write(v, "auth.md", "---\ntitle: Authentication Guide\ntype: concept\ntags: [auth]\n---\nJWT token authentication details\n")
    db_module.build_db(v, run_lint=False)
    return lambda: query_rag(v, "JWT"), "LLM-ANSWER"


def _ai_advice(v: Vault):
    from raven.core.advice import get_advice
    from raven.core.ai_advice import generate_ai_advice

    _write(v, "orphan-page.md", "---\ntitle: Orphan Page\ntype: concept\ntags: []\n---\nOrphan\n")
    db_module.build_db(v, run_lint=False)
    reply = json.dumps([{"id": a["id"], "ai_message": "LLM-MESSAGE"} for a in get_advice(v)])
    return lambda: generate_ai_advice(v), reply


def _contradiction(v: Vault):
    from raven.core.contradiction import check_contradictions

    _write(v, "service_a.md", "---\ntitle: Service A\ntype: concept\ntags: [service]\nrelations:\n"
           "  - type: depends_on\n    target: content/service_b\n    evidence: depends on B\n    reason: logic\n"
           "---\nService A runs on port 8080\n")
    _write(v, "service_b.md", "---\ntitle: Service B\ntype: concept\ntags: [service]\n---\nService B runs on port 9090\n")
    db_module.build_db(v, run_lint=False)
    reply = json.dumps([{"source_slug": "content/service_a", "target_slug": "content/service_b",
                         "relation_type": "depends_on", "description": "LLM-CONFLICT",
                         "proposed_action": "none", "proposed_data": {}}])
    return lambda: check_contradictions(v), reply


def _draft(v: Vault):
    from raven.core.draft import generate_draft

    reply = "---\ntitle: Key Scope\ntype: concept\ntags: [ai]\n---\n\nLLM body [[some-page]].\n"
    return lambda: generate_draft(v, topic="Key Scope", outline="1. Intro", associated_pages=["some-page"]), reply


def _used_llm(name: str, result) -> bool:
    if name == "ai_advice":
        return any(a["ai_message"] == "LLM-MESSAGE" for a in result)
    return result["used_llm"]


FEATURES = {"tagger": _tagger, "rag": _rag, "ai_advice": _ai_advice, "contradiction": _contradiction, "draft": _draft}


@pytest.mark.parametrize("other_key", ["OPENAI_API_KEY", "API_KEY", "GOOGLE_API_KEY"])
@pytest.mark.parametrize("feature", list(FEATURES))
def test_other_service_keys_are_never_sent_to_google(vault, transport, monkeypatch, feature, other_key) -> None:
    """Before #47, OPENAI_API_KEY / API_KEY went to Google in x-goog-api-key."""
    run, transport.reply = FEATURES[feature](vault)
    monkeypatch.setenv(other_key, FAKE[other_key])
    result = run()
    assert transport.requests == []
    assert _used_llm(feature, result) is False
    if feature == "ai_advice":
        assert result and all(a["ai_message"] != "LLM-MESSAGE" for a in result)
    else:
        assert result["ok"] is True


@pytest.mark.parametrize("feature", list(FEATURES))
def test_gemini_key_alone_is_used_when_other_keys_are_also_set(vault, transport, monkeypatch, feature) -> None:
    run, transport.reply = FEATURES[feature](vault)
    for name in KEY_VARS:
        monkeypatch.setenv(name, FAKE[name])
    result = run()
    assert len(transport.requests) == 1
    request = transport.requests[0]
    assert request.url.host == "generativelanguage.googleapis.com"
    assert request.headers["x-goog-api-key"] == FAKE["GEMINI_API_KEY"]
    sent = str(request.url) + request.content.decode("utf-8", "replace")
    assert not any(FAKE[n] in sent for n in KEY_VARS)  # no key in URL or body
    assert _used_llm(feature, result) is True


@pytest.mark.parametrize("blank", ["", "   "])
def test_blank_gemini_key_counts_as_unset(vault, transport, monkeypatch, blank) -> None:
    run, transport.reply = FEATURES["tagger"](vault)
    monkeypatch.setenv("GEMINI_API_KEY", blank)
    monkeypatch.setenv("OPENAI_API_KEY", FAKE["OPENAI_API_KEY"])
    assert run()["used_llm"] is False
    assert transport.requests == []


def test_key_selection_lives_only_in_gemini_client() -> None:
    """Acceptance criterion 4: no caller reads a key from the environment itself."""
    package = Path(__file__).resolve().parents[1] / "raven"
    readers = [
        str(p.relative_to(package)) for p in package.rglob("*.py")
        if p.name != "gemini_client.py"
        and any(name in p.read_text(encoding="utf-8") for name in ("GEMINI_API_KEY", "OPENAI_API_KEY", '"API_KEY"'))
    ]
    assert readers == []


def test_gemini_api_key_reads_only_gemini_api_key(monkeypatch) -> None:
    from raven.core.gemini_client import gemini_api_key

    for name in KEY_VARS:
        monkeypatch.setenv(name, FAKE[name])
    assert gemini_api_key() == FAKE["GEMINI_API_KEY"]
    monkeypatch.delenv("GEMINI_API_KEY")
    assert gemini_api_key() is None
