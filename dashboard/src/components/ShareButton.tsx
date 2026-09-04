import { useEffect, useRef, useState } from "react";
import { fetchSystemInfo, type SystemInfo } from "../lib/api";
import { Button } from "./ui/Button";

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

function ShareRow({
  label,
  url,
  copyLabel,
  onCopy,
  copied,
  fallbackText,
}: {
  label: string;
  url: string | null;
  copyLabel: string;
  onCopy: (url: string) => void;
  copied: boolean;
  fallbackText: string;
}) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--color-muted)", marginBottom: 4 }}>
        {label}
      </div>
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
            {copied ? "✅ 복사됨!" : "📋 복사"}
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
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchSystemInfo()
      .then((info) => setSysInfo(info))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onOutsideClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onOutsideClick);
    return () => document.removeEventListener("mousedown", onOutsideClick);
  }, [open]);

  function handleCopy(url: string, key: string) {
    navigator.clipboard.writeText(url);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
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

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 320,
            background: "var(--color-canvas)",
            border: "1px solid var(--color-hairline-strong)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-overlay)",
            padding: 14,
            zIndex: 50,
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
                fallbackText="내부망 IP 감지 안 됨"
              />
              <ShareRow
                label="Tailscale 링크"
                url={tsUrl}
                copyLabel="Tailscale 링크 복사"
                onCopy={(url) => handleCopy(url, "ts")}
                copied={copiedKey === "ts"}
                fallbackText="Tailscale IP 감지 안 됨"
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
