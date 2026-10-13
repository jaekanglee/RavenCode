/**
 * RawTree — raw/ 폴더 트리 컴포넌트 (v0.7.50+, ADR-2026-07-02)
 *
 * fetchRawList의 flat items를 parent-child 트리로 변환해서 표시한다.
 * Sidebar의 tree 컴포넌트와 별개로, raw/의 items는 (path, type) 만 있고
 * children 필드가 없으므로 flat → tree 변환을 자체적으로 처리한다.
 *
 * Props:
 *   - items: RawItem[]  (flat list from API, already sorted)
 *   - selectedPath: 현재 선택된 raw/ 하위 경로 (예: 'articles/foo.md')
 *   - onSelect(path: string): 노드 클릭 시 호출. dir도 클릭 가능 (선택 강조)
 *   - depth0Open: Set<string> — 처음 렌더 시 열려있을 폴더 path (default: 'raw/'만)
 *   - compact: true면 Sidebar용(좁은 폭), false면 RawPanel용(넓은 폭)
 */
import { useMemo, useState, type ReactElement } from "react";
import type { RawItem } from "../lib/api";

interface RawNode {
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number | null;
  modified?: string | null;
  children: RawNode[];
}

function buildTree(items: RawItem[]): RawNode | null {
  if (!items.length) return null;
  // root = 'raw/'
  const root: RawNode = { path: "raw", name: "raw", type: "dir", children: [] };
  const byPath = new Map<string, RawNode>();
  byPath.set("raw", root);
  for (const it of items) {
    // it.path 는 'raw/...' 또는 'raw' (raw/ 자체)
    const segments = it.path.split("/");
    const node: RawNode = {
      path: it.path,
      name: it.name,
      type: it.type,
      size: it.size,
      modified: it.modified,
      children: [],
    };
    byPath.set(it.path, node);
    // parent = 'raw/segments[1]/.../segments[len-2]'
    const parentPath = segments.slice(0, -1).join("/") || "raw";
    const parent = byPath.get(parentPath) ?? root;
    parent.children.push(node);
  }
  return root;
}

interface RawTreeProps {
  items: RawItem[];
  selectedPath?: string | null;
  onSelect: (path: string, type: "file" | "dir") => void;
  depth0Open?: Set<string>;
  compact?: boolean;
}

export function RawTree({
  items,
  selectedPath = null,
  onSelect,
  depth0Open,
  compact = true,
}: RawTreeProps) {
  const tree = useMemo(() => buildTree(items), [items]);
  const [open, setOpen] = useState<Set<string>>(() => {
    if (depth0Open) return new Set(depth0Open);
    return new Set(["raw"]);
  });

  if (!tree) {
    return (
      <div
        style={{
          fontSize: 12,
          color: "var(--color-muted)",
          padding: compact ? "4px 8px" : "8px 12px",
        }}
      >
        (비어있음)
      </div>
    );
  }

  function toggleFolder(path: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: RawNode, depth: number): ReactElement {
    const isOpen = open.has(node.path);
    const isSelected = selectedPath === node.path;
    const indent = compact ? depth * 12 : depth * 16;

    if (node.type === "dir") {
      return (
        <div key={node.path}>
          <button
            type="button"
            onClick={() => {
              toggleFolder(node.path);
              onSelect(node.path, "dir");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              width: "100%",
              padding: compact ? "4px 8px" : "6px 10px",
              paddingLeft: compact ? 8 + indent : 12 + indent,
              fontSize: compact ? 12 : 13,
              fontWeight: 600,
              color: isSelected ? "var(--color-primary)" : "var(--color-ink)",
              background: isSelected ? "var(--color-surface-soft)" : "transparent",
              border: 0,
              borderRadius: 4,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <span style={{ width: 12, display: "inline-block", textAlign: "center" }}>
              {node.children.length > 0 ? (isOpen ? "▾" : "▸") : "·"}
            </span>
            <span>📁</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {node.name}
            </span>
          </button>
          {isOpen &&
            node.children.map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    return (
      <button
        key={node.path}
        type="button"
        onClick={() => onSelect(node.path, "file")}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          padding: compact ? "4px 8px" : "6px 10px",
          paddingLeft: compact ? 8 + indent : 12 + indent,
          fontSize: compact ? 12 : 13,
          color: isSelected ? "var(--color-primary)" : "var(--color-ink)",
          background: isSelected ? "var(--color-surface-soft)" : "transparent",
          border: 0,
          borderRadius: 4,
          cursor: "pointer",
          textAlign: "left",
          fontWeight: isSelected ? 600 : 400,
        }}
        title={node.path}
      >
        <span style={{ width: 12, display: "inline-block" }}>·</span>
        <span>📄</span>
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {node.name}
        </span>
        {node.size != null && (
          <span
            style={{
              fontSize: 10,
              color: "var(--color-muted)",
              marginLeft: 4,
              flexShrink: 0,
            }}
          >
            {formatSize(node.size)}
          </span>
        )}
      </button>
    );
  }

  return <div>{renderNode(tree, 0)}</div>;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${(n / 1024 / 1024).toFixed(1)}M`;
}
