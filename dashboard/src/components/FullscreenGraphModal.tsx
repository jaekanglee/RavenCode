import { useEffect } from "react";
import { createPortal } from "react-dom";
import { GraphCanvas } from "./GraphCanvas";
import type { GraphNode, GraphEdge } from "../types";

interface FullscreenGraphModalProps {
  vault: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  currentNodeId?: string | null;
  centerTitle: string;
  onClose: () => void;
}

/**
 * FullscreenGraphModal — overlay that shows the page's related graph at full
 * viewport scale. The user stays on the same page; only this modal opens on
 * top, so they can read more of the structure without losing context.
 */
export function FullscreenGraphModal({
  vault,
  nodes,
  edges,
  currentNodeId,
  centerTitle,
  onClose,
}: FullscreenGraphModalProps) {
  // Escape closes the modal; lock body scroll while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="fullscreen-graph-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`${centerTitle} 관련 그래프`}
      onClick={onClose}
    >
      <div
        className="fullscreen-graph-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="fullscreen-graph-modal-header">
          <div className="fullscreen-graph-modal-title">
            <strong>{centerTitle}</strong>
            <span>
              {nodes.length} nodes · {edges.length} edges
            </span>
          </div>
          <button
            type="button"
            className="fullscreen-graph-modal-close"
            onClick={onClose}
            aria-label="닫기"
            title="닫기 (Esc)"
          >
            ✕
          </button>
        </header>
        <div className="fullscreen-graph-modal-frame">
          <GraphCanvas
            nodes={nodes}
            edges={edges}
            focusNodeId={currentNodeId}
            persistentHighlightNodeId={currentNodeId}
            onNodeClick={(slug) => window.location.assign(`/page/${vault}/${slug}`)}
            onNodeDoubleClick={(slug) => window.location.assign(`/page/${vault}/${slug}`)}
          />
        </div>
        <footer className="fullscreen-graph-modal-footer">
          <span className="text-muted">Esc 또는 바깥 클릭으로 닫기</span>
        </footer>
      </div>
    </div>,
    document.body
  );
}
