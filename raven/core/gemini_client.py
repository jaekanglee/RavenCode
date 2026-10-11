"""Gemini generateContent transport. Never put credentials in request URLs."""

import httpx


GEMINI_GENERATE_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    "gemini-2.5-flash:generateContent"
)


def generate_content(api_key: str, payload: dict) -> httpx.Response:
    """Post to Gemini using its documented API-key header."""
    return httpx.post(
        GEMINI_GENERATE_URL,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        json=payload,
        timeout=15.0,
    )
