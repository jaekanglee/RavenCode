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
    "a\x9b31mred\x9b0m",  # C1 CSI
    "a\u202eevil\u202c",  # bidi override
    "a\ud800b",  # lone surrogate: UTF-8 cannot encode it (was a 500)
]


@pytest.mark.parametrize("message", FORGERIES)
def test_newlines_and_control_characters_cannot_forge_lines(client, log_path, monkeypatch, message) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    payload = {"message": message, "source": message, "level": message, "url": message, "vault": message, "stack": message}
    body = json.dumps(payload)  # ASCII-escaped, as a browser's JSON.stringify sends lone surrogates
    assert client.post("/api/debug-log", content=body, headers={"content-type": "application/json"}).status_code == 200
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


INVISIBLE = ["\x7f", "\x85", "\x9b", "\u200e", "\u202e", "\u2066", "\u2028", "\u2029", "\ufeff", "\ud800", "\udfff",
             "\U000e0067", "\U0001d173", "\U000e0001"]  # format characters above U+FFFF


@pytest.mark.parametrize("ch", INVISIBLE)
def test_invisible_characters_are_written_escaped(client, log_path, monkeypatch, ch) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    resp = client.post("/api/debug-log", content=json.dumps({"message": f"x{ch}y"}), headers={"content-type": "application/json"})
    assert resp.status_code == 200 and resp.json() == {"ok": True}
    raw = log_path.read_bytes()
    assert ch.encode("utf-8", "surrogatepass") not in raw
    assert json.loads(raw.decode("utf-8"))["message"] == f"x{ch}y"  # escaped, not lost


def test_visible_text_is_left_as_is(client, log_path, monkeypatch) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    text = "한글 テスト émoji 😀 tab\tend"
    client.post("/api/debug-log", json={"message": text})
    raw = log_path.read_text(encoding="utf-8")
    assert "한글 テスト émoji 😀" in raw
    assert json.loads(raw)["message"] == text


@pytest.mark.parametrize("body", [b"not json", b'{"message": 123}', b"{}", b'{"message": "ok"}'])
def test_a_closed_endpoint_answers_404_whatever_the_body(client, log_path, monkeypatch, body) -> None:
    monkeypatch.delenv("RAVEN_DEBUG_LOG", raising=False)
    resp = client.post("/api/debug-log", content=body, headers={"content-type": "application/json"})
    assert resp.status_code == 404


@pytest.mark.parametrize("body", [b"not json", b'{"message": 123}', b"{}"])
def test_an_open_endpoint_still_validates_the_body(client, log_path, monkeypatch, body) -> None:
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    resp = client.post("/api/debug-log", content=body, headers={"content-type": "application/json"})
    assert resp.status_code == 422
    assert not log_path.exists()


def test_sendbeacon_style_blob_body_is_accepted(client, log_path, monkeypatch) -> None:
    """main.tsx posts a Blob typed application/json via sendBeacon."""
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    resp = client.post("/api/debug-log", content=json.dumps({"level": "error", "message": "m"}).encode(),
                       headers={"content-type": "application/json"})
    assert resp.status_code == 200


def test_text_with_astral_format_characters_survives_a_round_trip(client, log_path, monkeypatch) -> None:
    """The England flag is a black flag plus tag characters (U+E0067…U+E007F, category Cf)."""
    monkeypatch.setenv("RAVEN_DEBUG_LOG", "1")
    flag = "\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f"
    text = f"flag {flag} ok"
    client.post("/api/debug-log", content=json.dumps({"message": text}), headers={"content-type": "application/json"})
    raw = log_path.read_text(encoding="utf-8")
    assert json.loads(raw)["message"] == text
    assert "\U000e0067" not in raw  # escaped, as a surrogate pair
