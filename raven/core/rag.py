"""raven.core.rag — 하이브리드 검색 결과를 기반으로 출처 인용이 포함된 AI 답변을 생성하는 RAG 핵심 모듈."""
from __future__ import annotations

import os
import json
import sqlite3
from typing import Any, Dict, List, Optional
from pathlib import Path

from .gemini_client import generate_content
from .vault import Vault
from .hybrid_search import hybrid_search

def query_rag(vault: Vault, query_text: str) -> dict[str, Any]:
    """하이브리드 검색을 통해 관련 문서 최대 5개를 추출하여 컨텍스트를 구성하고,
    Gemini API 또는 Fallback 가이드라인을 통해 답변을 도출합니다.
    """
    # 1. hybrid_search를 통한 관련 문서 5개 검색
    results = hybrid_search(vault, query_text, limit=5)

    # 2. 검색된 페이지 데이터 조회
    slugs = [r["slug"] for r in results]
    pages_data = {}
    if slugs:
        conn = sqlite3.connect(vault.db_path)
        conn.row_factory = sqlite3.Row
        try:
            placeholders = ",".join("?" for _ in slugs)
            rows = conn.execute(
                f"SELECT slug, title, path, raw_content FROM pages WHERE slug IN ({placeholders})",
                slugs
            ).fetchall()
            for row in rows:
                pages_data[row["slug"]] = {
                    "title": row["title"],
                    "path": row["path"],
                    "raw_content": row["raw_content"]
                }
        finally:
            conn.close()

    # 3. Context 구성 및 Citations 리스트 생성
    context_parts = []
    citations = []
    for r in results:
        slug = r["slug"]
        pdata = pages_data.get(slug)
        if pdata:
            title = pdata["title"]
            content = pdata["raw_content"]
            abs_path = (vault.root / pdata["path"]).resolve().as_posix()
            file_url = f"file://{abs_path}"
            
            context_parts.append(
                f"Document Title: {title}\n"
                f"Wikilink: [[{slug}]]\n"
                f"File Link: [{title}]({file_url})\n"
                f"Content:\n{content}\n"
                f"---"
            )
            citations.append({
                "slug": slug,
                "title": title,
                "path": pdata["path"],
                "file_url": file_url,
                "score": r["score"],
                "method": r["method"]
            })

    context = "\n\n".join(context_parts)

    # 4. LLM 호출 시도
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("API_KEY")
    answer = ""
    used_llm = False

    if api_key and context:
        try:
            import httpx
            prompt = (
                "너는 사용자의 질문에 답하는 지식 탐색 AI 조언자이다. 아래 제공된 Context를 바탕으로 질문에 친절하고 상세하게 한글로 답변해줘.\n"
                "답변은 반드시 제공된 Context만을 근거로 삼아야 하며, Context에서 답을 찾을 수 없거나 관련 내용이 전혀 없는 경우 사실에 기반하여 솔직하게 모른다고 답변해야 해.\n"
                "답변 중 정보를 인용한 부분에는 해당 정보의 출처 파일 링크를 반드시 Context에 주어진 File Link 형식인 [Title](file://절대경로) 형태로 삽입해라.\n\n"
                "Context:\n"
                f"{context}\n\n"
                f"질문: {query_text}\n"
                "답변:"
            )

            
            payload = {
                "contents": [{"parts": [{"text": prompt}]}]
            }

            resp = generate_content(api_key, payload)
            if resp.status_code == 200:
                resp_json = resp.json()
                answer = resp_json["candidates"][0]["content"]["parts"][0]["text"].strip()
                used_llm = True
            else:
                import sys
                sys.stderr.write(f"⚠️ [query_rag] Gemini API call returned status {resp.status_code}: {resp.text}\n")
        except Exception as e:
            import sys
            sys.stderr.write(f"⚠️ [query_rag] LLM call failed, falling back: {e}\n")

    # 5. LLM 미사용 시 Fallback 생성
    if not answer:
        if not context:
            answer = "검색 쿼리와 매칭되는 관련 문서를 찾을 수 없습니다."
        else:
            fallback_parts = [
                "⚠️ **[RAG Fallback]** API Key가 설정되지 않았거나 호출에 실패하여 AI 답변을 생성할 수 없습니다. 대신 하이브리드 검색으로 매칭된 상위 문서들을 추천해 드립니다:\n"
            ]
            for cit in citations:
                fallback_parts.append(
                    f"- [{cit['title']}]({cit['file_url']}) (`{cit['slug']}`, 스코어: {cit['score']:.4f})"
                )
            answer = "\n".join(fallback_parts)

    return {
        "ok": True,
        "query": query_text,
        "answer": answer,
        "citations": citations,
        "used_llm": used_llm
    }
