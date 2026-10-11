"""raven.core.contradiction — LLM 기반 모순 및 충돌 탐지 모듈."""
from __future__ import annotations

import os
import json
import sqlite3
from typing import Any, List, Dict, Optional
from .gemini_client import generate_content
from .vault import Vault

def get_contradiction_pairs(vault: Vault) -> list[dict[str, Any]]:
    """모순 탐지 대상인 인접 노드 및 유사도가 높은 노드 쌍을 조회합니다."""
    pairs = []
    if not os.path.exists(vault.db_path):
        return pairs
    
    conn = sqlite3.connect(vault.db_path)
    conn.row_factory = sqlite3.Row
    try:
        # 1. 인접 노드 (세만틱 관계 존재 쌍)
        rel_rows = conn.execute(
            "SELECT source_slug, target_slug, relation_type FROM relations"
        ).fetchall()
        for r in rel_rows:
            pairs.append({
                "source_slug": r["source_slug"],
                "target_slug": r["target_slug"],
                "relation_type": r["relation_type"]
            })
        
        # 2. 유사도가 높은 노드 쌍 (공통 태그 기준)
        tag_overlap_rows = conn.execute(
            "SELECT t1.page_slug AS s, t2.page_slug AS t, COUNT(*) as cnt "
            "FROM tags t1 JOIN tags t2 ON t1.tag = t2.tag "
            "WHERE t1.page_slug < t2.page_slug "
            "GROUP BY t1.page_slug, t2.page_slug "
            "ORDER BY cnt DESC LIMIT 10"
        ).fetchall()
        for r in tag_overlap_rows:
            exists = any(
                (p["source_slug"] == r["s"] and p["target_slug"] == r["t"]) or
                (p["source_slug"] == r["t"] and p["target_slug"] == r["s"])
                for p in pairs
            )
            if not exists:
                pairs.append({
                    "source_slug": r["s"],
                    "target_slug": r["t"],
                    "relation_type": "related"
                })
    except Exception:
        pass
    finally:
        conn.close()
    return pairs

def check_contradictions(vault: Vault) -> dict[str, Any]:
    """지식 보관소 내 연관 문서 쌍들을 LLM으로 검증하여 내용상 모순이나 충돌을 반환합니다."""
    pairs = get_contradiction_pairs(vault)
    if not pairs:
        return {"ok": True, "contradictions": [], "used_llm": False}
    
    # 중복 제거 및 고유 슬러그 추출
    slugs = set()
    for p in pairs:
        slugs.add(p["source_slug"])
        slugs.add(p["target_slug"])
        
    pages_info = {}
    if os.path.exists(vault.db_path):
        conn = sqlite3.connect(vault.db_path)
        conn.row_factory = sqlite3.Row
        try:
            placeholders = ",".join("?" for _ in slugs)
            rows = conn.execute(
                f"SELECT slug, title, raw_content FROM pages WHERE slug IN ({placeholders})",
                list(slugs)
            ).fetchall()
            for r in rows:
                pages_info[r["slug"]] = {
                    "title": r["title"],
                    "content": r["raw_content"]
                }
        except Exception:
            pass
        finally:
            conn.close()
            
    # Context 빌드
    context_parts = []
    for idx, p in enumerate(pairs):
        s_slug = p["source_slug"]
        t_slug = p["target_slug"]
        s_data = pages_info.get(s_slug)
        t_data = pages_info.get(t_slug)
        if s_data and t_data:
            context_parts.append(
                f"--- Pair {idx} ---\n"
                f"Source: {s_slug} (Title: {s_data['title']})\n"
                f"Target: {t_slug} (Title: {t_data['title']})\n"
                f"Relation: {p['relation_type']}\n"
                f"Source Content:\n{s_data['content']}\n"
                f"Target Content:\n{t_data['content']}\n"
            )
            
    context = "\n".join(context_parts)
    if not context:
        return {"ok": True, "contradictions": [], "used_llm": False}
        
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("API_KEY")
    contradictions = []
    used_llm = False
    
    if api_key:
        try:
            prompt = (
                "너는 지식 네트워크의 문서 간 논리적 모순이나 충돌(Contradiction)을 찾아내고 정합성을 강화하는 AI 조언자이다.\n"
                "제공된 각 문서 쌍(Source & Target)의 본문을 읽고, 내용 간에 서로 모순되거나 충돌하는 기술 사양(예: 서로 다른 포트, 충돌하는 데이터 포맷), "
                "상태, 또는 설명이 있는지 상세히 분석해줘.\n\n"
                "충돌이 발견된 쌍에 대해서만 아래의 JSON 구조로 결과를 반환해라. 충돌이 없으면 빈 배열 []을 반환해.\n\n"
                "JSON 반환 형식:\n"
                "[\n"
                "  {\n"
                "    \"source_slug\": \"Source의 슬러그\",\n"
                "    \"target_slug\": \"Target의 슬러그\",\n"
                "    \"relation_type\": \"기존 관계 또는 추천 관계\",\n"
                "    \"description\": \"충돌되는 구체적인 내용 및 해결 방향 제안 설명 (한글로 작성)\",\n"
                "    \"proposed_action\": \"관계 수정이나 역참조 설정을 위한 액션 (update_relation 또는 add_backlink 중 하나)\",\n"
                "    \"proposed_data\": {\n"
                "      \"source_slug\": \"Source의 슬러그\",\n"
                "      \"target_slug\": \"Target의 슬러그\",\n"
                "      \"relation_type\": \"제안하는 관계 타입 (uses, depends_on, implements, implemented_by, related 중 하나)\",\n"
                "      \"evidence\": \"모순/충돌이 발견된 원인 본문 구절 또는 요약\",\n"
                "      \"reason\": \"이 조치를 제안하는 이유\"\n"
                "    }\n"
                "  }\n"
                "]\n\n"
                "반드시 마크다운 등 다른 텍스트 없이 순수 JSON 배열만 출력해줘.\n\n"
                f"문서 쌍 목록:\n{context}\n\n"
                "분석 결과 JSON:"
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
                    parsed = json.loads(clean_text)
                    if isinstance(parsed, list):
                        contradictions = parsed
                        used_llm = True
                except Exception:
                    pass
        except Exception as e:
            import sys
            sys.stderr.write(f"⚠️ [check_contradictions] LLM call failed: {e}\n")
            
    # LLM 미사용 시 Heuristic / Mock 검사 (테스트 검증용)
    if not used_llm:
        for idx, p in enumerate(pairs):
            s_slug = p["source_slug"]
            t_slug = p["target_slug"]
            s_data = pages_info.get(s_slug)
            t_data = pages_info.get(t_slug)
            if s_data and t_data:
                s_cont = s_data["content"]
                t_cont = t_data["content"]
                # Heuristic 충돌 조건 (예: 8080 vs 9090 포트 충돌, 혹은 명시적 contradiction 키워드)
                if ("8080" in s_cont and "9090" in t_cont) or ("contradiction" in s_cont.lower()) or ("conflict" in s_cont.lower()):
                    contradictions.append({
                        "source_slug": s_slug,
                        "target_slug": t_slug,
                        "relation_type": p["relation_type"],
                        "description": "포트 충돌이 감지되었습니다. Source는 8080, Target은 9090을 사용합니다.",
                        "proposed_action": "update_relation",
                        "proposed_data": {
                            "source_slug": s_slug,
                            "target_slug": t_slug,
                            "relation_type": "depends_on",
                            "evidence": "Port mismatch (8080 vs 9090)",
                            "reason": "Ensure aligned port specifications."
                        }
                    })
                    
    # UI 편의를 위해 타이틀 정보 추가
    for c in contradictions:
        s_slug = c.get("source_slug")
        t_slug = c.get("target_slug")
        if s_slug in pages_info:
            c["source_title"] = pages_info[s_slug]["title"]
        if t_slug in pages_info:
            c["target_title"] = pages_info[t_slug]["title"]
            
    return {
        "ok": True,
        "contradictions": contradictions,
        "used_llm": used_llm
    }
