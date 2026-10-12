"""raven.core.tagger — LLM 기반 자동 태깅 추천 모듈."""
from __future__ import annotations

import os
import json
import sqlite3
import re
from typing import Any, List, Optional
from .gemini_client import gemini_api_key, generate_content
from .vault import Vault

def suggest_tags(vault: Vault, content: str, title: Optional[str] = None) -> dict[str, Any]:
    """본문 텍스트와 제목을 인풋으로 받아, 기존 보관소 내 태그 셋과 대조 및 신규 추천 태그를 추출합니다."""
    # 1. 기존 태그 목록 조회
    existing_tags = []
    if os.path.exists(vault.db_path):
        conn = sqlite3.connect(vault.db_path)
        try:
            rows = conn.execute("SELECT DISTINCT tag FROM tags ORDER BY tag").fetchall()
            existing_tags = [r[0] for r in rows if r[0]]
        except Exception:
            pass
        finally:
            conn.close()

    # 2. LLM 호출 시도
    api_key = gemini_api_key()
    tags = []
    used_llm = False

    if api_key:
        try:
            prompt = (
                "너는 지식 보관소(Vault)의 문서를 분석하여 적절한 태그를 추천하는 AI 조언자이다.\n"
                "다음 문서의 제목(Title)과 본문(Content)을 분석하여, 문서의 핵심 주제를 가장 잘 나타내는 태그를 최대 5개 추천해줘.\n\n"
                "규칙:\n"
                "1. 아래 제공된 기존 태그 목록(Existing Tags) 중에서 어울리는 태그가 있다면 최우선적으로 선택해줘.\n"
                "2. 기존 태그로 표현하기 부족한 핵심 개념이 있다면 새로운 태그를 추가적으로 제안할 수 있어.\n"
                "3. 태그는 영문 소문자 또는 한글 단어 형태로 작성하고, 특수문자나 공백은 피해줘.\n"
                "4. 추천 태그의 총 개수는 1개 이상, 최대 5개 이하여야 해.\n"
                "5. 반드시 결과를 JSON array 형태로만 출력해줘. 예: [\"tag1\", \"tag2\"]\n\n"
                f"기존 태그 목록(Existing Tags): {existing_tags}\n\n"
                f"문서 제목: {title or '제목 없음'}\n"
                f"문서 본문:\n{content}\n\n"
                "추천 태그 JSON:"
            )

            payload = {
                "contents": [{"parts": [{"text": prompt}]}]
            }

            resp = generate_content(api_key, payload)
            if resp.status_code == 200:
                resp_json = resp.json()
                answer = resp_json["candidates"][0]["content"]["parts"][0]["text"].strip()
                
                # Clean code blocks
                clean_text = answer.strip()
                if clean_text.startswith("```"):
                    lines = clean_text.splitlines()
                    if lines[0].startswith("```"):
                        lines = lines[1:]
                    if lines and lines[-1].startswith("```"):
                        lines = lines[:-1]
                    clean_text = "\n".join(lines).strip()
                
                try:
                    suggested = json.loads(clean_text)
                    if isinstance(suggested, list):
                        tags = [str(t).strip().lower() for t in suggested if t][:5]
                        used_llm = True
                except Exception:
                    # Regex fallback
                    found = re.findall(r'"([^"\\]*(?:\\.[^"\\]*)*)"', clean_text)
                    if found:
                        tags = [t.strip().lower() for t in found][:5]
                        used_llm = True
            else:
                import sys
                sys.stderr.write(f"⚠️ [suggest_tags] Gemini API call returned status {resp.status_code}: {resp.text}\n")
        except Exception as e:
            import sys
            sys.stderr.write(f"⚠️ [suggest_tags] LLM call failed, falling back: {e}\n")

    # 3. LLM 미사용 또는 실패 시 Fallback
    if not used_llm:
        matched = []
        content_lower = content.lower()
        title_lower = (title or "").lower()
        for et in existing_tags:
            pattern = rf"\b{re.escape(et.lower())}\b"
            if et.isalnum():
                has_match = re.search(pattern, title_lower) or re.search(pattern, content_lower)
            else:
                has_match = (et.lower() in title_lower) or (et.lower() in content_lower)
            if has_match:
                matched.append(et)
        
        tags = matched[:5]
        if not tags:
            # Extract basic terms
            words = re.findall(r'[a-zA-Z가-힣0-9]+', title or content)
            candidates = []
            for w in words:
                w_low = w.lower()
                if len(w_low) > 1 and w_low not in candidates:
                    candidates.append(w_low)
            tags = candidates[:3]

    return {
        "ok": True,
        "tags": tags,
        "used_llm": used_llm
    }
