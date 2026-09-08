import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchSystemInfo, type SystemInfo } from "../lib/api";
import { Button } from "./ui/Button";

// 팝오버는 document.body 포털 + position:fixed 로 렌더한다 (Modal-portal.test.tsx 규약, v0.6.18+).
// Layout의 <main overflow-hidden> / .page-content overflow-y-auto 안에서 position:absolute 로 두면
// 사이드바 경계에서 잘린다 (overflow-y:auto 는 overflow-x 도 auto 로 계산됨).
const POPOVER_WIDTH = 320;
const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;

const Icon = {
  Share: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={{ display: "block" }}>
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
      <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
    </svg>
  ),
};

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function ShareRow({
  label,
  url,
  copyLabel,
  onCopy,
  copied,
  failed,
  fallbackText,
}: {
  label: string;
  url: string | null;
  copyLabel: string;
  onCopy: (url: string) => void;
  copied: boolean;
  failed: boolean;
  fallbackText: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", marginBottom: 4 }}>
        {label}
      </div>
      {url && failed && (
        <div style={{ fontSize: 11, color: "var(--color-danger-text)", marginBottom: 4 }}>
          클립보드 접근이 거부되어 복사 실패 — 아래 링크를 직접 선택해 복사하세요.
        </div>
      )}
      {url ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span
            style={{
              flex: 1,
              fontFamily: "monospace",
              fontSize: 12,
              wordBreak: "break-all",
              color: "var(--color-ink)",
            }}
          >
            {url}
          </span>
          <Button
            type="button"
            variant="pill"
            size="sm"
            aria-label={copyLabel}
            onClick={() => onCopy(url)}
          >
            {copied ? "✅ 복사됨!" : failed ? "⚠️ 복사 실패" : "📋 복사"}
          </Button>
        </div>
      ) : (
        <span style={{ fontSize: 12, color: "var(--color-muted)" }}>
          {fallbackText}
        </span>
      )}
    </div>
  );
}

export function ShareButton({ vault, slug }: { vault: string; slug: string }) {
  const [open, setOpen] = useState(false);
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchSystemInfo()
      .then((info) => setSysInfo(info))
      .finally(() => setLoading(false));
  }, [open]);

  // 트리거 버튼 기준 viewport 좌표 계산 — 버튼 아래, 왼쪽 정렬, 우측 넘침은 클램프.
  useEffect(() => {
    if (!open) return;
    function place() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
      setPos({
        top: rect.bottom + POPOVER_GAP,
        left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft)),
      });
    }
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  // 포털로 빠진 팝오버는 containerRef 밖이므로 popoverRef 도 "안쪽" 으로 취급해야 한다.
  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      const t = e.target as Node;
      const inTrigger = containerRef.current?.contains(t) ?? false;
      const inPopover = popoverRef.current?.contains(t) ?? false;
      if (!inTrigger && !inPopover) setOpen(false);
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  const [failedKey, setFailedKey] = useState<string | null>(null);

  // 클립보드 쓰기는 실패할 수 있다 (WKWebView 권한 거부, http LAN 접속 같은
  // non-secure context 에서는 navigator.clipboard 자체가 없음). 예전에는 결과를
  // 기다리지 않고 "복사됨" 을 띄워서, 직전에 복사한 다른 링크가 클립보드에 남아
  // 있어도 성공처럼 보였다. 이제 성공을 확인한 뒤에만 복사됨을 표시한다.
  async function handleCopy(url: string, key: string) {
    setFailedKey(null);
    const ok = await copyToClipboard(url);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    } else {
      setCopiedKey(null);
      setFailedKey(key);
    }
  }

  const lanUrl = sysInfo?.lan_api ? `${sysInfo.lan_api}/page/${vault}/${slug}` : null;
  const tsUrl = sysInfo?.tailscale_api ? `${sysInfo.tailscale_api}/page/${vault}/${slug}` : null;

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        title="공유하기"
        aria-label="공유"
        style={{ minWidth: 36, padding: "0 8px" }}
      >
        <Icon.Share />
      </Button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          data-testid="share-popover"
          style={{
            position: "fixed",
            top: pos.top,
            left: pos.left,
            width: POPOVER_WIDTH,
            background: "var(--color-canvas)",
            border: "1px solid var(--color-hairline-strong)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-overlay)",
            padding: 14,
            zIndex: 100,
          }}
        >
          {loading && (
            <div style={{ fontSize: 12, color: "var(--color-muted)" }}>시스템 정보 조회 중…</div>
          )}
          {!loading && sysInfo?.bind_host === "127.0.0.1" && (
            <div
              style={{
                fontSize: 11,
                color: "var(--color-danger-text)",
                marginBottom: 10,
                lineHeight: 1.4,
              }}
            >
              ⚠️ 서버가 로컬 전용(127.0.0.1)으로 실행 중입니다. 다른 기기에서 열려면
              서버를 0.0.0.0으로 바인딩해야 합니다.
            </div>
          )}
          {!loading && (
            <>
              <ShareRow
                label="내부망 링크"
                url={lanUrl}
                copyLabel="내부망 링크 복사"
                onCopy={(url) => handleCopy(url, "lan")}
                copied={copiedKey === "lan"}
                failed={failedKey === "lan"}
                fallbackText="내부망 IP 감지 안 됨"
              />
              <ShareRow
                label="Tailscale 링크"
                url={tsUrl}
                copyLabel="Tailscale 링크 복사"
                onCopy={(url) => handleCopy(url, "ts")}
                copied={copiedKey === "ts"}
                failed={failedKey === "ts"}
                fallbackText="Tailscale IP 감지 안 됨"
              />
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
