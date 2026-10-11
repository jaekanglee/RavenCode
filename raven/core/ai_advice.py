"""raven.core.ai_advice — LLM 연동을 통한 지식 네트워크 진단 맞춤형 조언 생성 모듈."""
from __future__ import annotations

import os
import json
from typing import Any, List, Dict
from .gemini_client import generate_content
from .vault import Vault
from .advice import get_advice

def generate_ai_advice(vault: Vault) -> List[Dict[str, Any]]:
    """지식 네트워크 진단 목록을 가져와 LLM을 통해 실시간 맞춤형 큐레이션 해결책을 생성하여 반환합니다.
    API Key가 없거나 실패 시 템플릿 기반의 구체적인 Fallback 조언을 제공합니다.
    """
    raw_advices = get_advice(vault)
    if not raw_advices:
        return []

    # API key 확인 (vendor neutrality 준수)
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("API_KEY")
    
    if api_key:
        try:
            # 프롬프트 구성
            prompt = (
                "너는 지식 네트워크 분석 및 Curation 전문가야. 아래의 규칙 기반 진단 목록을 바탕으로, "
                "각 진단 항목에 대해 상황에 밀착된 구체적인 맞춤형 큐레이션 해결 가이드 문장(한글)을 작성해줘.\n"
                "해결책 문장은 다음 예시처럼 친근하면서도 전문적이어야 해:\n"
                "예시(bridge): '이 문서는 핵심 브릿지 역할을 하나 최근 3개월간 갱신되지 않아 지식 전파 병목 리스크가 있습니다. X 문서와 관계를 동기화하세요.'\n"
                "예시(community_split): '이 Collection은 너무 비대합니다. 하위 토픽 A와 B를 별도 문서로 분리하고, 각 도메인에 맞는 인덱스 페이지를 만들어 주세요.'\n\n"
                "진단 목록:\n"
                f"{json.dumps(raw_advices, ensure_ascii=False, indent=2)}\n\n"
                "응답 형식: 반드시 각 진단 항목의 'id'와 새로 생성된 해결책 문장 'ai_message'를 포함하는 JSON 리스트 형식이어야 해. "
                "그 외의 인사말이나 설명은 절대 생략하고 순수 JSON만 반환해줘. 예: [{\"id\": \"bridge-xxx\", \"ai_message\": \"...\"}]"
            )
            
            # Gemini API 호출 (Direct HTTP Call)
            payload = {
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {"responseMimeType": "application/json"}
            }
            
            resp = generate_content(api_key, payload)
            if resp.status_code == 200:
                resp_json = resp.json()
                text = resp_json["candidates"][0]["content"]["parts"][0]["text"]
                # JSON block parsing (markdown backticks if any)
                if "```json" in text:
                    text = text.split("```json")[1].split("```")[0].strip()
                elif "```" in text:
                    text = text.split("```")[1].split("```")[0].strip()
                updates = json.loads(text.strip())
                
                # 매핑 및 적용
                update_dict = {item["id"]: item["ai_message"] for item in updates if "id" in item and "ai_message" in item}
                
                enriched_advices = []
                for adv in raw_advices:
                    adv_copy = dict(adv)
                    adv_copy["ai_message"] = update_dict.get(adv["id"], adv["message"])
                    enriched_advices.append(adv_copy)
                return enriched_advices
        except Exception as e:
            import sys
            sys.stderr.write(f"⚠️  [generate_ai_advice] LLM API call failed, falling back: {e}\n")

    # API key가 없거나 LLM 호출 실패 시 구체적인 Fallback 생성
    enriched_advices = []
    for adv in raw_advices:
        adv_copy = dict(adv)
        adv_type = adv.get("type")
        slug = adv.get("slug", "")
        title = adv.get("title", "")
        message = adv.get("message", "")
        
        # 각 진단별 상황 밀착형 Fallback 가이드 생성
        if adv_type == "bridge":
            adv_copy["ai_message"] = (
                f"이 문서('{title}')는 여러 도메인을 연결하는 핵심 브릿지 역할을 하고 있습니다. "
                "최근 3개월간 정보 갱신 여부를 확인하고, 연결된 도메인들의 문서들과 관계 및 최신 스펙을 동기화하여 "
                "지식 전파 병목 리스크를 예방하세요."
            )
        elif adv_type == "bloated":
            adv_copy["ai_message"] = (
                f"감지된 컬렉션('{slug}')은 지식의 양이 지나치게 집중되어 있어 인지적 과부하를 유발합니다. "
                "하위 토픽을 별도의 문서로 분리하거나, 공통 개념을 추출하여 핵심 노드로 재구조화할 것을 권장합니다."
            )
        elif adv_type == "orphan":
            adv_copy["ai_message"] = (
                f"'{title}' 문서는 다른 지식과 격리되어 있어 고립될 위험이 큽니다. "
                "해당 개념이 의존하거나 사용하는 다른 핵심 문서와 관계를 맺어 지식 네트워크에 통합하세요."
            )
        elif adv_type == "underlinked":
            adv_copy["ai_message"] = (
                f"'{title}' 문서는 높은 중요도를 가지지만 참조가 부족하여 지식이 사장될 리스크가 있습니다. "
                "이 문서를 활용하는 하위 구현체나 연관 문서에서 이 문서를 명시적으로 참조하도록 관계를 설정하세요."
            )
        elif adv_type == "community_split":
            community_size = adv.get("community_size", "?")
            adv_copy["ai_message"] = (
                f"이 Collection은 너무 비대합니다 ({community_size}개 노드). "
                f"서로 다른 서브 토픽이 하나의 군집으로 뭉쳐 있으므로 분리가 필요합니다. "
                f"도메인 내 문서들을 주제별로 묶어 하위 폴더나 인덱스 페이지로 재구조화하세요."
            )
        else:
            adv_copy["ai_message"] = message
            
        enriched_advices.append(adv_copy)
        
    return enriched_advices
