import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { deletePage } from "../lib/api";
import { isGuestTab } from "../lib/guest";
import { ShareButton } from "./ShareButton";
import { ConfirmDialog } from "./ui/ConfirmDialog";

// 메뉴가 화면 밖으로 나가지 않게 클램프할 때 쓰는 추정 크기 (항목 2개 기준).
const MENU_WIDTH = 160;
const MENU_HEIGHT = 84;
const VIEWPORT_MARGIN = 8;

type Mode = "menu" | "share" | "confirm";

/** 사이드바 문서 우클릭 메뉴 — 공유하기 / 삭제. 삭제는 owner 전용이라 손님 탭에서는 숨긴다. */
export function PageContextMenu({
  vault,
  slug,
  title,
  x,
  y,
  onClose,
  onDeleted,
}: {
  vault: string;
  slug: string;
  title: string;
  x: number;
  y: number;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [mode, setMode] = useState<Mode>("menu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const canDelete = !isGuestTab();

  useEffect(() => {
    if (mode !== "menu") return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    function onOutside(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onOutside);
    return () => document.removeEventListener("mousedown", onOutside);
  }, [mode, onClose]);

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      await deletePage(vault, slug);
      onDeleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  if (mode === "share") {
    return <ShareButton vault={vault} slug={slug} anchorPoint={{ x, y }} onClose={onClose} />;
  }

  if (mode === "confirm") {
    return (
      <ConfirmDialog
        open
        tone="danger"
        title="문서 삭제"
        description={`'${title}'을(를) 삭제할까요? 아카이브로 옮겨지며 되돌릴 수 있습니다.`}
        confirmLabel="삭제"
        busy={busy}
        onConfirm={() => void confirmDelete()}
        onClose={onClose}
      >
        {error && <p role="alert" className="page-context-menu-error">❌ 삭제 실패: {error}</p>}
      </ConfirmDialog>
    );
  }

  const left = Math.max(VIEWPORT_MARGIN, Math.min(x, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN));
  const top = Math.max(VIEWPORT_MARGIN, Math.min(y, window.innerHeight - MENU_HEIGHT - VIEWPORT_MARGIN));

  return createPortal(
    <div
      ref={menuRef}
      className="page-context-menu"
      role="menu"
      aria-label="문서 메뉴"
      style={{ top, left }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button type="button" role="menuitem" className="page-context-menu-item" onClick={() => setMode("share")}>
        공유하기
      </button>
      {canDelete && (
        <button
          type="button"
          role="menuitem"
          className="page-context-menu-item page-context-menu-item-danger"
          onClick={() => setMode("confirm")}
        >
          삭제
        </button>
      )}
    </div>,
    document.body
  );
}
