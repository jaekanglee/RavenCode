// PropertiesPanel — Obsidian-style 메타데이터 인라인 편집 패널 (v0.7.200+)
// type 드롭다운, tags pill 편집기, 문서 검색 기반 relation 연결 UI.
// 변경 즉시 저장 (blur/select 이벤트), 저장 성공 시 onSaved() 콜백.

import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { updatePage, addRelation } from "../lib/api";
import { useHybridSearch } from "../lib/useHybridSearch";
import type { Page } from "../types";

const PAGE_TYPES = [
  "concept", "rule", "journal", "issue",
  "project", "tool", "person", "comparison", "query",
] as const;

const RELATION_TYPES: { value: string; label: string }[] = [
  { value: "references",   label: "참조함" },
  { value: "uses",         label: "사용함" },
  { value: "extends",      label: "확장함" },
  { value: "related",      label: "관련 있음" },
  { value: "contradicts",  label: "반박함" },
  { value: "implements",   label: "구현함" },
];

interface Props {
  vault: string;
  page: Page;
  onSaved: () => void;
}

// ── 단일 pill (tags/aliases 공용) ────────────────────────────────────────────
function Pill({ text, prefix = "", removeLabel, onRemove }: {
  text: string; prefix?: string; removeLabel: string; onRemove: () => void;
}) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 12, fontSize: 12, fontWeight: 500,
      background: "rgba(99,102,241,0.12)", color: "var(--color-primary)",
      border: "1px solid rgba(99,102,241,0.25)",
    }}>
      {prefix}{text}
      <button
        type="button"
        aria-label={removeLabel}
        onClick={onRemove}
        style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, color: "var(--color-muted)", fontSize: 13 }}
      >×</button>
    </span>
  );
}

// ── 메인 컴포넌트 ────────────────────────────────────────────────────────────
export function PropertiesPanel({ vault, page, onSaved }: Props) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(true);

  // ── type ──────────────────────────────────────────────────────────────────
  const [type, setType] = useState(page.type || "concept");
  const [typeSaving, setTypeSaving] = useState(false);

  // ── tags ──────────────────────────────────────────────────────────────────
  const [tags, setTags] = useState<string[]>(() =>
    (page.tags || "").split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean)
  );
  const [tagInput, setTagInput] = useState("");
  const [tagSaving, setTagSaving] = useState(false);

  // ── aliases ────────────────────────────────────────────────────────────────
  const [aliases, setAliases] = useState<string[]>(() => page.aliases || []);
  const [aliasInput, setAliasInput] = useState("");
  const [aliasSaving, setAliasSaving] = useState(false);

  // ── relation 연결 ──────────────────────────────────────────────────────────
  const [relQuery, setRelQuery] = useState("");
  const [relType, setRelType] = useState<string>("references");
  const [relSaving, setRelSaving] = useState(false);
  const [relToast, setRelToast] = useState<string | null>(null);
  // v0.7.201+: 사이드바 SearchBar와 동일한 훅 — 결과 100% 동일 보장.
  const relResults = useHybridSearch(vault, relQuery, { limit: 8, excludeSlug: page.slug });

  // page가 바뀌면 state 동기화
  useEffect(() => {
    setType(page.type || "concept");
    setTags((page.tags || "").split(",").map(t => t.trim().replace(/^#/, "")).filter(Boolean));
    setAliases(page.aliases || []);
  }, [page.slug]);

  // ── 저장 헬퍼 ─────────────────────────────────────────────────────────────
  const save = useCallback(async (patch: { type?: string; tags?: string[]; aliases?: string[] }) => {
    const tagArray = patch.tags ?? tags;
    const pageType = patch.type ?? type;
    const aliasArray = patch.aliases ?? aliases;
    await updatePage(vault, page.slug, {
      content: page.content,
      title: page.title,
      type: pageType,
      tags: tagArray,
      extra_meta: { aliases: aliasArray },
      precondition: page.precondition,
    });
    onSaved();
  }, [vault, page, type, tags, aliases, onSaved]);

  // ── type 변경 즉시 저장 ───────────────────────────────────────────────────
  async function handleTypeChange(newType: string) {
    setType(newType);
    setTypeSaving(true);
    try { await save({ type: newType }); } catch {} finally { setTypeSaving(false); }
  }

  // ── 태그 추가 ─────────────────────────────────────────────────────────────
  async function handleAddTag() {
    const t = tagInput.trim().replace(/^#/, "");
    if (!t || tags.includes(t)) { setTagInput(""); return; }
    const next = [...tags, t];
    setTags(next);
    setTagInput("");
    setTagSaving(true);
    try { await save({ tags: next }); } catch {} finally { setTagSaving(false); }
  }

  // ── 태그 삭제 ─────────────────────────────────────────────────────────────
  async function handleRemoveTag(tag: string) {
    const next = tags.filter(t => t !== tag);
    setTags(next);
    setTagSaving(true);
    try { await save({ tags: next }); } catch {} finally { setTagSaving(false); }
  }

  // ── alias 추가 ─────────────────────────────────────────────────────────────
  async function handleAddAlias() {
    const a = aliasInput.trim();
    if (!a || aliases.includes(a)) { setAliasInput(""); return; }
    const next = [...aliases, a];
    setAliases(next);
    setAliasInput("");
    setAliasSaving(true);
    try { await save({ aliases: next }); } catch {} finally { setAliasSaving(false); }
  }

  // ── alias 삭제 ─────────────────────────────────────────────────────────────
  async function handleRemoveAlias(alias: string) {
    const next = aliases.filter(a => a !== alias);
    setAliases(next);
    setAliasSaving(true);
    try { await save({ aliases: next }); } catch {} finally { setAliasSaving(false); }
  }

  // ── relation 추가 ─────────────────────────────────────────────────────────
  async function handleAddRelation(target: { slug: string; title: string }) {
    setRelSaving(true);
    try {
      await addRelation(vault, {
        source_slug: page.slug,
        target_slug: target.slug,
        relation_type: relType,
        actor: "user",
        precondition: page.precondition,
      });
      setRelToast(`✅ ${target.title} 연결됨`);
      setTimeout(() => setRelToast(null), 2400);
      setRelQuery("");
      onSaved();
    } catch (e: any) {
      setRelToast(`오류: ${e.message}`);
      setTimeout(() => setRelToast(null), 2400);
    } finally {
      setRelSaving(false);
    }
  }

  return (
    <div style={{
      border: "1px solid var(--color-hairline)",
      borderRadius: 10,
      background: "var(--bg-soft)",
      overflow: "hidden",
      marginBottom: 16,
    }}>
      {/* 헤더 */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%", display: "flex", alignItems: "center", gap: 6,
          padding: "10px 14px", background: "none", border: "none",
          cursor: "pointer", textAlign: "left",
          borderBottom: open ? "1px solid var(--color-hairline)" : "none",
        }}
      >
        <svg viewBox="0 0 12 12" width="11" height="11" style={{
          transform: open ? "rotate(90deg)" : "rotate(0deg)",
          transition: "transform 0.15s", color: "var(--color-muted)", flexShrink: 0,
        }}>
          <path d="M4 2 L8 6 L4 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--color-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
          속성
        </span>
      </button>

      {open && (
        <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 14 }}>

          {/* Type */}
          <Row label="type" saving={typeSaving}>
            <select
              value={type}
              onChange={e => handleTypeChange(e.target.value)}
              style={{
                fontSize: 12, fontWeight: 600, padding: "3px 8px",
                borderRadius: 6, border: "1px solid var(--color-hairline)",
                background: "var(--bg-surface)", color: "var(--color-ink)",
                cursor: "pointer", appearance: "none",
              }}
            >
              {PAGE_TYPES.map(t => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Row>

          {/* Tags */}
          <Row label="tags" saving={tagSaving}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
              {tags.map(t => (
                <Pill key={t} text={t} prefix="#" removeLabel={`태그 ${t} 제거`} onRemove={() => handleRemoveTag(t)} />
              ))}
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  type="text"
                  value={tagInput}
                  onChange={e => setTagInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddTag(); } }}
                  placeholder="태그 추가..."
                  style={{
                    fontSize: 12, padding: "3px 8px", borderRadius: 6,
                    border: "1px solid var(--color-hairline)",
                    background: "var(--bg-surface)", color: "var(--color-ink)",
                    width: 90, outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={handleAddTag}
                  style={{
                    fontSize: 12, padding: "3px 8px", borderRadius: 6,
                    background: "var(--color-primary)", color: "#fff",
                    border: "none", cursor: "pointer", fontWeight: 600,
                  }}
                >+</button>
              </div>
            </div>
          </Row>

          {/* Aliases */}
          <Row label="aliases" saving={aliasSaving}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
              {aliases.map(a => (
                <Pill key={a} text={a} removeLabel={`별칭 ${a} 제거`} onRemove={() => handleRemoveAlias(a)} />
              ))}
              <div style={{ display: "flex", gap: 4 }}>
                <input
                  type="text"
                  value={aliasInput}
                  onChange={e => setAliasInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); handleAddAlias(); } }}
                  placeholder="별칭 추가..."
                  style={{
                    fontSize: 12, padding: "3px 8px", borderRadius: 6,
                    border: "1px solid var(--color-hairline)",
                    background: "var(--bg-surface)", color: "var(--color-ink)",
                    width: 90, outline: "none",
                  }}
                />
                <button
                  type="button"
                  onClick={handleAddAlias}
                  style={{
                    fontSize: 12, padding: "3px 8px", borderRadius: 6,
                    background: "var(--color-primary)", color: "#fff",
                    border: "none", cursor: "pointer", fontWeight: 600,
                  }}
                >+</button>
              </div>
            </div>
          </Row>

          {/* Updated (읽기 전용) */}
          {page.updated && (
            <Row label="updated">
              <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
                {String(page.updated).slice(0, 10)}
              </span>
            </Row>
          )}

          {/* 문서 연결 */}
          <div style={{ borderTop: "1px solid var(--color-hairline)", paddingTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: "var(--color-muted)", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              문서 연결
            </div>

            {/* 관계 타입 선택 */}
            <select
              value={relType}
              onChange={e => setRelType(e.target.value)}
              style={{
                fontSize: 12, padding: "3px 8px", borderRadius: 6,
                border: "1px solid var(--color-hairline)",
                background: "var(--bg-surface)", color: "var(--color-muted)",
                cursor: "pointer",
              }}
            >
              {RELATION_TYPES.map(r => (
                <option key={r.value} value={r.value}>{r.label}</option>
              ))}
            </select>

            {/* 검색창 */}
            <input
              type="text"
              value={relQuery}
              onChange={e => setRelQuery(e.target.value)}
              placeholder="🔍 연결할 문서 검색..."
              style={{
                fontSize: 12, padding: "6px 10px", borderRadius: 6,
                border: "1px solid var(--color-hairline)",
                background: "var(--bg-surface)", color: "var(--color-ink)",
                outline: "none", width: "100%", boxSizing: "border-box",
              }}
            />

            {/* 검색 결과 */}
            {relResults.length > 0 && (
              <div style={{
                display: "flex", flexDirection: "column", gap: 2,
                border: "1px solid var(--color-hairline)", borderRadius: 6,
                overflow: "hidden", background: "var(--bg-surface)",
              }}>
                {relResults.map(r => (
                  <button
                    key={r.slug}
                    type="button"
                    disabled={relSaving}
                    onClick={() => handleAddRelation(r)}
                    style={{
                      display: "flex", alignItems: "center", gap: 8,
                      padding: "7px 10px", background: "none", border: "none",
                      cursor: "pointer", textAlign: "left",
                      transition: "background 0.1s",
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = "var(--hover-overlay)")}
                    onMouseLeave={e => (e.currentTarget.style.background = "none")}
                  >
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                      background: "rgba(99,102,241,0.12)", color: "var(--color-primary)",
                      flexShrink: 0,
                    }}>{r.type}</span>
                    <span style={{ fontSize: 12, color: "var(--color-ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {r.title || r.slug}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--color-muted)", flexShrink: 0 }}>연결 +</span>
                  </button>
                ))}
              </div>
            )}

            {/* 연결 토스트 */}
            {relToast && (
              <div style={{ fontSize: 12, color: relToast.startsWith("✅") ? "var(--color-success-text)" : "var(--color-danger)", fontWeight: 600 }}>
                {relToast}
              </div>
            )}

            {/* 기존 relations */}
            {page.relations && page.relations.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <div style={{ fontSize: 11, color: "var(--color-muted)", fontWeight: 600, marginTop: 4 }}>연결됨</div>
                {page.relations.map((rel: any, i: number) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => navigate(`/page/${vault}/${rel.target || rel.slug}`)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6,
                      padding: "4px 0", background: "none", border: "none",
                      cursor: "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ fontSize: 10, color: "var(--color-muted)", fontStyle: "italic" }}>
                      {RELATION_TYPES.find(r => r.value === (rel.type || rel.relation_type))?.label ?? (rel.type || rel.relation_type)}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--color-primary)", textDecoration: "underline", textDecorationColor: "transparent" }}
                      onMouseEnter={e => (e.currentTarget.style.textDecorationColor = "var(--color-primary)")}
                      onMouseLeave={e => (e.currentTarget.style.textDecorationColor = "transparent")}
                    >
                      {rel.title || rel.target || rel.slug}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── 레이블 + 값 레이아웃 헬퍼 ────────────────────────────────────────────────
function Row({ label, saving, children }: { label: string; saving?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
      <span style={{
        fontSize: 11, fontWeight: 600, color: "var(--color-muted)",
        width: 54, flexShrink: 0, paddingTop: 4,
        letterSpacing: "0.02em",
      }}>
        {label}
        {saving && <span style={{ marginLeft: 4, opacity: 0.5 }}>…</span>}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}
