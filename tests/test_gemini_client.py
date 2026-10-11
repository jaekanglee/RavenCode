"""Issue #20: API credentials must not appear in Gemini request URLs."""

from unittest.mock import patch

from raven.core.gemini_client import GEMINI_GENERATE_URL, generate_content


def test_gemini_key_is_only_in_header():
    key = "test-secret-not-for-url"
    payload = {"contents": [{"parts": [{"text": "hello"}]}]}
    with patch("raven.core.gemini_client.httpx.post") as post:
        generate_content(key, payload)
    post.assert_called_once_with(
        GEMINI_GENERATE_URL,
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        json=payload,
        timeout=15.0,
    )
    assert key not in post.call_args.args[0]
    assert "?" not in post.call_args.args[0]
