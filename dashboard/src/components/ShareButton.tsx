import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fetchSystemInfo, type SystemInfo } from "../lib/api";
import { downloadPageMarkdown } from "../lib/pageExport";
import { Button } from "./ui/Button";

// 팝오버는 document.body 포털 + position:fixed 로 렌더한다 (Modal-portal.test.tsx 규약, v0.6.18+).
// Layout의 <main overflow-hidden> / .page-content overflow-y-auto 안에서 position:absolute 로 두면
// 사이드바 경계에서 잘린다 (overflow-y:auto 는 overflow-x 도 auto 로 계산됨).
const POPOVER_WIDTH = 320;
const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;
// 첫 렌더에는 아직 실측 높이가 없다 — 대략값으로 배치하고 rAF에서 실측 보정.
const POPOVER_ESTIMATED_HEIGHT = 340;

const Icon = {
  Download: () => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" style={{ display: "block" }}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  ),
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

export interface ShareButtonProps {
  vault: string;
  slug: string;
}

export function ShareButton({ vault, slug }: ShareButtonProps) {
  const [open, setOpen] = useState(false);
  const [sysInfo, setSysInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);
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
  // v0.7.184+: 내보내기 섹션이 붙어 팝오버가 길어졌다. 아래 공간이 부족하면
  // 트리거 위로 뒤집고, 그래도 안 들어가면 maxHeight + 내부 스크롤로 가둔다
  // (이전에는 그대로 뷰포트 아래로 잘려 내보내기 버튼이 보이지 않았다).
  useEffect(() => {
    if (!open) return;
    let raf = 0;
    function place() {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const height = popoverRef.current?.offsetHeight || POPOVER_ESTIMATED_HEIGHT;
      const viewport = window.innerHeight;
      const maxHeight = viewport - VIEWPORT_MARGIN * 2;
      const spaceBelow = viewport - rect.bottom - POPOVER_GAP - VIEWPORT_MARGIN;
      const spaceAbove = rect.top - POPOVER_GAP - VIEWPORT_MARGIN;
      const flipUp = height > spaceBelow && spaceAbove > spaceBelow;
      const top = flipUp
        ? Math.max(VIEWPORT_MARGIN, rect.top - POPOVER_GAP - height)
        : Math.max(
            VIEWPORT_MARGIN,
            Math.min(rect.bottom + POPOVER_GAP, viewport - height - VIEWPORT_MARGIN)
          );
      const maxLeft = window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN;
      const left = Math.max(VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));
      setPos((prev) =>
        prev && prev.top === top && prev.left === left && prev.maxHeight === maxHeight
          ? prev
          : { top, left, maxHeight }
      );
    }
    place();
    // 두 번째 패스 — 팝오버가 마운트된 뒤 실측 높이로 다시 배치 (paint 전).
    raf = requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      cancelAnimationFrame(raf);
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

  // ── 내보내기 (v0.7.184+) ──
  // md = API의 export.md (vault 원본 그대로, frontmatter 포함).
  // PDF(인쇄)는 제거 — 데스크톱 WKWebView가 iframe print()를 무시한다. 브라우저는 ⌘P.
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  // 데스크톱은 저장 경로를 돌려주므로 어디에 떨어졌는지 알려준다.
  const [savedPath, setSavedPath] = useState<string | null>(null);

  async function handleExportMarkdown() {
    setExporting(true);
    setExportError(null);
    setSavedPath(null);
    try {
      const saved = await downloadPageMarkdown(vault, slug);
      setSavedPath(saved.path ?? saved.filename);
      setTimeout(() => setSavedPath(null), 6000);
    } catch (e) {
      setExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
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
            maxHeight: pos.maxHeight,
            overflowY: "auto",
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

          {/* ── 파일로 내보내기 (v0.7.184+) ── */}
          <div className="share-export">
            <div className="share-export-label">파일로 내보내기</div>
            <div className="share-export-actions">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                fullWidth
                disabled={exporting}
                onClick={() => void handleExportMarkdown()}
                aria-label="Markdown 파일로 저장"
                style={{ justifyContent: "flex-start", gap: 8 }}
              >
                <Icon.Download />
                {exporting ? "내보내는 중…" : "Markdown (.md) 파일로 저장"}
              </Button>
            </div>
            {exportError ? (
              <div className="share-export-error">{exportError}</div>
            ) : savedPath ? (
              <div className="share-export-saved">✅ 저장됨: {savedPath}</div>
            ) : null}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
