"""raven.core.draft — AI-assisted Draft Generator 및 Commit 파이프라인."""
from __future__ import annotations

import os
import json
import sqlite3
import re
import unicodedata
from pathlib import Path
from typing import Any, List, Optional

from .gemini_client import generate_content
from .vault import Vault
from .db import build_db

def slugify(s: str) -> str:
    s = unicodedata.normalize("NFC", s)
    s = re.sub(r"[^\w\s가-힣\-\+\(\)]", "-", s, flags=re.UNICODE)
    s = re.sub(r"[\s_]+", "-", s)
    s = s.replace("+-", "plus").replace("+", "-")
    s = re.sub(r"-+", "-", s).strip("-")
    out = []
    for c in s:
        if c.isascii() and c.isalpha():
            out.append(c.lower())
        else:
            out.append(c)
    return "".join(out)

def generate_draft(
    vault: Vault,
    topic: str,
    outline: str,
    associated_pages: Optional[list[str]] = None,
) -> dict[str, Any]:
    """사용자가 제공한 주제(Topic), 아웃라인(Outline), 연관 페이지를 기반으로
    고품질 마크다운 초안 문서를 작성하여 <vault>/drafts/ 하위에 저장합니다.
    """
    associated_pages = associated_pages or []
    drafts_dir = vault.root / "drafts"
    drafts_dir.mkdir(parents=True, exist_ok=True)

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("OPENAI_API_KEY") or os.environ.get("API_KEY")
    used_llm = False
    title = topic
    tags = ["draft"]
    body_content = ""
    file_content = ""

    # associated pages 위키링크 준비
    wikilinks = [f"[[{p}]]" for p in associated_pages]
    wikilinks_str = ", ".join(wikilinks)

    if api_key:
        try:
            prompt = (
                "너는 지식 보관소(Vault)의 문서를 작성하는 AI 작가이다.\n"
                "사용자가 제공한 주제(Topic), 예상 아웃라인(Outline), 그리고 연관 페이지 목록을 바탕으로 고품질 마크다운 초안 문서를 작성해라.\n\n"
                "규칙:\n"
                "1. 문서는 Frontmatter와 본문으로 구성되어야 한다.\n"
                "2. Frontmatter는 반드시 아래 형식을 정확히 지켜야 한다:\n"
                "   ---\n"
                "   title: <문서 제목>\n"
                "   type: concept\n"
                "   tags: [<태그1>, <태그2>]\n"
                "   created: <오늘날짜 YYYY-MM-DD>\n"
                "   updated: <오늘날짜 YYYY-MM-DD>\n"
                "   ---\n"
                "3. 본문에는 아웃라인의 내용을 풍부하게 서술하고, 제공된 연관 페이지 위키링크를 본문 중간에 자연스럽게 삽입하거나 아웃바운드 [[wikilink]] 형태로 포함해야 한다. 최소 2개 이상의 위키링크가 본문에 들어가도록 배치하라.\n"
                "4. 반드시 최종 마크다운 형식의 결과물만 출력해라. 다른 설명 텍스트를 추가하지 말라.\n\n"
            )

            prompt += (
                f"주제 (Topic): {topic}\n"
                f"예상 아웃라인 (Outline):\n{outline}\n"
                f"연관 페이지 (Associated Pages): {wikilinks_str}\n\n"
                "마크다운 초안 문서:"
            )

            payload = {
                "contents": [{"parts": [{"text": prompt}]}]
            }

            resp = generate_content(api_key, payload)
            if resp.status_code == 200:
                resp_json = resp.json()
                answer = resp_json["candidates"][0]["content"]["parts"][0]["text"].strip()
                
                # 마크다운 코드 블록 청소
                clean_text = answer.strip()
                if clean_text.startswith("```markdown"):
                    clean_text = clean_text[11:].strip()
                elif clean_text.startswith("```"):
                    clean_text = clean_text[3:].strip()
                if clean_text.endswith("```"):
                    clean_text = clean_text[:-3].strip()

                # Frontmatter 파싱을 시도해서 title, type, tags 추출
                fm_pattern = re.compile(r"^---\s*\n(.*?)\n---\s*\n(.*)$", re.DOTALL)
                match = fm_pattern.match(clean_text)
                if match:
                    fm_text, body_content = match.groups()
                    import yaml
                    try:
                        fm_data = yaml.safe_load(fm_text) or {}
                        if "title" in fm_data:
                            title = str(fm_data["title"]).strip()
                        if "tags" in fm_data:
                            if isinstance(fm_data["tags"], list):
                                tags = [str(t).strip() for t in fm_data["tags"]]
                            else:
                                tags = [str(fm_data["tags"]).strip()]
                    except Exception:
                        pass
                
                file_content = clean_text
                used_llm = True
            else:
                import sys
                sys.stderr.write(f"⚠️ [generate_draft] Gemini API call returned status {resp.status_code}: {resp.text}\n")
        except Exception as e:
            import sys
            sys.stderr.write(f"⚠️ [generate_draft] LLM call failed, falling back: {e}\n")

    # LLM을 안 썼거나 실패한 경우 Fallback 생성
    if not used_llm:
        import datetime
        today = datetime.date.today().isoformat()
        
        tags = ["draft", "concept"]

        body_lines = [
            f"# {title}",
            "",
            f"이 문서는 {topic}에 대한 AI 초안입니다.",
            "",
            "## 아웃라인",
            outline,
            "",
            "## 연관 문서",
        ]
        for p in associated_pages:
            body_lines.append(f"- [[{p}]]")
        body_content = "\n".join(body_lines)
        
        fm_lines = [
            "---",
            f"title: {title}",
            "type: concept",
            f"tags: {json.dumps(tags, ensure_ascii=False)}",
            f"created: {today}",
            f"updated: {today}",
            "---",
            "",
            body_content
        ]
        file_content = "\n".join(fm_lines)

    # slugify 해서 파일 저장
    slug_name = slugify(title)
    if not slug_name:
        slug_name = "untitled-draft"
    
    filepath = drafts_dir / f"{slug_name}.md"

    # Advisory Lock 획득 후 쓰기
    from .lock import lock_for_file
    try:
        with lock_for_file(vault.root, filepath, timeout=5.0):
            filepath.write_text(file_content, encoding="utf-8")
    except TimeoutError:
        return {
            "ok": False,
            "error": f"Failed to acquire lock for generating draft: {filepath.name}. Another process might be writing to it."
        }

    # log.md 에 기록 남기기
    try:
        from . import log as _log
        _log.append(vault, action="create", slug=f"drafts/{slug_name}", details={"topic": topic})
    except Exception:
        pass

    return {
        "ok": True,
        "title": title,
        "slug": f"drafts/{slug_name}",
        "path": str(filepath),
        "content": file_content,
        "used_llm": used_llm
    }

def commit_draft(
    vault: Vault, 
    draft_slug: str, 
    content: Optional[str] = None,
    overwrite: bool = False
) -> dict[str, Any]:
    """<vault>/drafts/ 하위의 초안 문서를 <vault>/content/ 하위로 승격시키고,
    정식 린트 및 DB Rebuild를 수행합니다.
    """
    base_name = draft_slug.split("/")[-1]
    draft_file = vault.root / "drafts" / f"{base_name}.md"
    
    if not draft_file.exists():
        if content is None:
            return {
                "ok": False,
                "error": f"Draft file not found: {draft_file}"
            }
        else:
            drafts_dir = vault.root / "drafts"
            drafts_dir.mkdir(parents=True, exist_ok=True)
            draft_file.write_text(content, encoding="utf-8")

    if content is not None:
        draft_file.write_text(content, encoding="utf-8")

    content_dir = vault.content_root
    content_dir.mkdir(parents=True, exist_ok=True)
    target_file = content_dir / f"{base_name}.md"

    from .lock import lock_for_file
    try:
        with lock_for_file(vault.root, target_file, timeout=5.0):
            # 충돌 방지: 파일이 이미 존재하고 overwrite 플래그가 꺼져 있는 경우
            if target_file.exists() and not overwrite:
                existing_content = target_file.read_text(encoding="utf-8")
                draft_content = draft_file.read_text(encoding="utf-8")
                return {
                    "ok": False,
                    "conflict": True,
                    "error": f"Content file '{base_name}.md' already exists in content/. Choose overwrite or version comparison merge.",
                    "existing_content": existing_content,
                    "draft_content": draft_content
                }

            import shutil
            shutil.move(str(draft_file), str(target_file))
    except TimeoutError:
        return {
            "ok": False,
            "error": f"Failed to acquire lock for committing draft: {target_file.name}. Another author might be modifying or committing this file."
        }

    # DB Rebuild 유발
    build_result = build_db(vault, run_lint=True)

    # log.md 에 기록
    try:
        from . import log as _log
        _log.append(vault, action="create", slug=f"content/{base_name}", details={"committed_from": draft_slug})
    except Exception:
        pass

    return {
        "ok": True,
        "slug": f"content/{base_name}",
        "path": str(target_file),
        "db_rebuild": build_result
    }
