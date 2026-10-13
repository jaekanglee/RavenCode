// PageMetaRow — 페이지 헤더 아래 메타 row (v0.6.21+).
//
// 표시 항목:
//  - type chip-strong (예: concept, adr, person)
//  - 📑 Index 마커 (slug가 content/index 또는 index 일 때)
//  - updated YYYY-MM-DD
//  - tags #pill #pill
//
// 사용자 원칙 (2026-06-29): 재사용 컴포넌트 우선. PageView 인라인 메타 row를
// 추출해 다른 페이지에서도 재사용 가능하게.
//
// slug prefix tolerance: Sidebar.tsx와 동일하게 'content/index'와 'index' 둘 다
// 매칭 (v0.6.15 P15 결정).
export interface PageMetaRowProps {
  type: string;
  slug: string;
  tags: string;
  updated?: string;
  issueStatus?: string;
  onStatusChange?: (newStatus: string) => void;
}

function isIndexSlug(slug: string): boolean {
  if (!slug) return false;
  const normalized = slug.replace(/^content\//, "");
  return normalized === "index";
}

export function PageMetaRow({ type, slug, tags, updated, issueStatus, onStatusChange }: PageMetaRowProps) {
  const isIndex = isIndexSlug(slug);
  const tagList = (tags || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        marginBottom: 12,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span className="chip-strong">{type}</span>
      {isIndex && (
        <span
          className="chip"
          style={{
            background: "var(--color-primary-bg)",
            color: "var(--color-primary)",
          }}
        >
          📑 Index
        </span>
      )}
      {updated && (
        <span style={{ fontSize: 13, color: "var(--color-muted)" }}>
          updated {String(updated).slice(0, 10)}
        </span>
      )}
      {tagList.map((t) => (
        <span key={t} className="chip">
          #{t}
        </span>
      ))}

      {type.toLowerCase() === "issue" && onStatusChange && (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", marginLeft: "4px" }}>
          <span style={{ fontSize: 13, color: "var(--color-muted)" }}>이슈 상태:</span>
          <select
            value={issueStatus || "open"}
            onChange={(e) => onStatusChange(e.target.value)}
            style={{
              padding: "2px 6px",
              borderRadius: "4px",
              border: "1px solid var(--border-subtle)",
              backgroundColor: "var(--bg-surface)",
              color: "var(--fg-ink)",
              fontSize: "12px",
              outline: "none",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            <option value="open">🔴 단순 오픈</option>
            <option value="edit_requested">⚙️ 수정요청</option>
            <option value="feedback_done">💬 피드백완료</option>
            <option value="closed">✅ 클로즈</option>
          </select>
        </span>
      )}
    </div>
  );
}