"""Issue #19: /api/debug-log is opt-in, size-bounded and cannot forge log lines."""
from __future__ import annotations

import json
import threading

import pytest
from fastapi.testclient import TestClient

import raven.api.server as server


@pytest.fixture
def log_path(monkeypatch, tmp_path):
    path = tmp_path / "dashboard-client.log"
    monkeypatch.setattr(server, "_DEBUG_LOG_PATH", path)
    return path


@pytest.fixture
def client():
    return TestClient(server.app)


@pytest.mark.parametrize("value", [None, "", "0", "false", "off", "no", "garbage"])
def test_endpoint_is_refused_unless_opted_in(client, log_path, monkeypatch, value) -> None:
    if value is None:
        monkeypatch.delenv("RAVEN_DEBUG_LOG", raising=False)
    else:
        monkeypatch.setenv("RAVEN_DEBUG_LOG", value)
    resp = client.post("/api/debug-log", json={"message": "hello"})
    assert resp.status_code == 404
    assert not log_path.exists()


@pytest.mark.parametrize("value", ["1", "true", "YES", " on "])
def test_endpoint_writes_when_opted_in(client, log_path, monkeypatch, value) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", value)
    resp = client.post("/api/debug-log", json={"level": "error", "source": "fetch", "message": "boom"})
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}  # no server path in the answer
    record = json.loads(log_path.read_text(encoding="utf-8"))
    assert record["level"] == "error" and record["source"] == "fetch" and record["message"] == "boom"


FORGERIES = [
    "real error\n[2026-01-01 00:00:00] ERROR forged line",
    "a\r\nb",
    "a\rb",
    "a\x0bb\x0cc",
    "a\x1cb\x1dc\x1ed",
    "a\x85b",
    "a b c",
    "a\x00b\x1bc",
]


@pytest.mark.parametrize("message", FORGERIES)
def test_newlines_and_control_characters_cannot_forge_lines(client, log_path, monkeypatch, message) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    payload = {"message": message, "source": message, "level": message, "url": message, "vault": message, "stack": message}
    assert client.post("/api/debug-log", json=payload).status_code == 200
    text = log_path.read_text(encoding="utf-8")
    assert text.endswith("\n")
    lines = text.splitlines()  # splits on every line boundary Python knows, U+2028 included
    assert len(lines) == 1, lines
    record = json.loads(lines[0])
    assert record["message"] == message[: server._DEBUG_FIELD_MAX["message"]]
    assert "\n" not in text[:-1] and "\r" not in text


def test_each_entry_is_one_line_and_korean_stays_readable(client, log_path, monkeypatch) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    for i in range(3):
        client.post("/api/debug-log", json={"message": f"오류 {i}", "stack": "at a\nat b"})
    lines = log_path.read_text(encoding="utf-8").splitlines()
    assert len(lines) == 3
    assert "오류 0" in lines[0]
    assert json.loads(lines[2])["stack"] == ["at a", "at b"]


def test_fields_are_capped(client, log_path, monkeypatch) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    payload = {"message": "m" * 100_000, "url": "u" * 10_000, "stack": "\n".join(["s" * 5000] * 50)}
    client.post("/api/debug-log", json=payload)
    record = json.loads(log_path.read_text(encoding="utf-8"))
    assert len(record["message"]) == server._DEBUG_FIELD_MAX["message"]
    assert len(record["url"]) == server._DEBUG_FIELD_MAX["url"]
    assert len(record["stack"]) == server._DEBUG_STACK_LINES
    assert all(len(line) == server._DEBUG_STACK_LINE_MAX for line in record["stack"])
    assert log_path.stat().st_size < 8 * 1024


def test_log_rotates_once_and_never_grows_without_bound(client, log_path, monkeypatch) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    monkeypatch.setattr(server, "DEBUG_LOG_MAX_BYTES", 20_000)
    backup = log_path.with_name(log_path.name + ".1")
    for i in range(200):
        assert client.post("/api/debug-log", json={"message": f"{i:04d} " + "x" * 1500}).json()["ok"] is True
        assert log_path.stat().st_size <= 20_000
        if backup.exists():
            assert backup.stat().st_size <= 20_000
    assert sorted(p.name for p in log_path.parent.iterdir()) == [log_path.name, backup.name]
    # The newest entry is in the live file, the one before the rotation in the backup.
    last = json.loads(log_path.read_text(encoding="utf-8").splitlines()[-1])
    assert last["message"].startswith("0199 ")
    for line in backup.read_text(encoding="utf-8").splitlines():
        json.loads(line)  # rotation never splits a record


def test_concurrent_posts_never_interleave_records(client, log_path, monkeypatch) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    monkeypatch.setattr(server, "DEBUG_LOG_MAX_BYTES", 30_000)

    def post(n: int) -> None:
        for i in range(25):
            client.post("/api/debug-log", json={"message": f"t{n}-{i} " + "y" * 900})

    threads = [threading.Thread(target=post, args=(n,)) for n in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    files = [log_path, log_path.with_name(log_path.name + ".1")]
    for path in files:
        for line in path.read_text(encoding="utf-8").splitlines():
            json.loads(line)
        assert path.stat().st_size <= 30_000


def test_endpoint_is_gated_on_every_request(client, log_path, monkeypatch) -> None:
    """The switch is read per request: turning it off stops writing at once."""
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    assert client.post("/api/debug-log", json={"message": "a"}).status_code == 200
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "0")
    assert client.post("/api/debug-log", json={"message": "b"}).status_code == 404
    assert len(log_path.read_text(encoding="utf-8").splitlines()) == 1
