"""Gemini generateContent transport. Never put credentials in request URLs."""

import os

import httpx


GEMINI_GENERATE_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)


GEMINI_API_KEY_ENV = "GEMINI_API_KEY"


def gemini_api_key() -> str | None:
    """The only credential Raven ever sends to Google.

    Issue #47: callers used to fall back to OPENAI_API_KEY or a generic API_KEY,
    which sent another service's key to Google. Without GEMINI_API_KEY the
    callers skip the request and use their non-LLM fallback. A blank value
    counts as unset.
    """
    key = os.environ.get(GEMINI_API_KEY_ENV)
    return key if key and key.strip() else None


def generate_content(api_key: str, payload: dict) -> httpx.Response:
    """Post to Gemini using its documented API-key header."""
    return httpx.post(
        GEMINI_GENERATE_URL,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        json=payload,
        timeout=15.0,
    )
