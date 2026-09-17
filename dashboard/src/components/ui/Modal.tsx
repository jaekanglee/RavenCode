// Modal — 앱 공통 모달 (v0.6.26+).
//
// 사용자 원칙 (§13.1): "재사용 컴포넌트 우선". 여러 모달(NewPageButton/
// DeleteButton/EditButton 등)이 같은 backdrop/dim-click/Escape/z-index
// 패턴을 반복 — Modal로 추출.
//
// Contract:
//  - open=true면 body 직속 portal로 렌더 (v0.6.18 containing block 회피)
//  - backdrop 클릭 또는 Escape 키 → onClose 호출
//  - children 영역 클릭은 onClose 안 함 (stopPropagation)
//  - maxWidth (기본 720), zIndex (기본 80) 커스터마이즈
//
// 사용 예:
//   <Modal open={open} onClose={() => setOpen(false)} maxWidth={880}>
//     <h2>제목</h2>
//     <form>...</form>
//   </Modal>
import { useEffect } from "react";
import { createPortal } from "react-dom";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** 카드 max width. 기본 720. */
  maxWidth?: number;
  /** z-index. 기본 80. */
  zIndex?: number;
  /** dim 색. 기본 "var(--color-overlay)". */
  overlay?: string;
  /** true면 backdrop 클릭 시 onClose 안 함 (필수 액션 모달용). */
  disableBackdropClose?: boolean;
}

export function Modal({
  open,
  onClose,
  children,
  maxWidth = 720,
  zIndex = 80,
  overlay = "var(--color-overlay)",
  disableBackdropClose = false,
}: ModalProps) {
  // Escape 키로 닫기 (열려있을 때만 등록)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      onClick={() => !disableBackdropClose && onClose()}
      style={{
        position: "fixed",
        inset: 0,
        background: overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex,
        padding: 16,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{
          maxWidth,
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          padding: 32,
        }}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
