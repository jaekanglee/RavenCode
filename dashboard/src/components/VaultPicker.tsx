import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiFetch, setActiveVault } from "../lib/api";

interface VaultMeta {
  name: string;
  path: string;
  mode: string;
  owner: string;
  default: boolean;
}

// Issue #32 잔여: 활성 vault 선택은 호스트별 키에 저장한다 (api.setActiveVault가 소유).
export function VaultPicker({
  active,
  onChange,
}: {
  active: string;
  onChange: (name: string) => void;
}) {
  const [vaults, setVaults] = useState<VaultMeta[]>([]);
  const [vaultsRoot, setVaultsRoot] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  // v0.6.7: new vault creation moved entirely to the NewVaultWizard
  // (`/vault/new`). The inline form used to live here (with path
  // input + mode select 3개) but duplicated the wizard and violated
  // the "user only types a name" rule from v0.6.6. The button
  // below is just a Link to the wizard — single source of truth.

  const wrapperRef = useRef<HTMLDivElement>(null);

  // ─── load vaults ────────────────────────────────────────
  function loadVaults() {
    setLoading(true);
    apiFetch("/api/vaults")
      .then((r) => (r.ok ? r.json() : { vaults: [] }))
      .then((d) => {
        setVaults(d.vaults || []);
        // v0.6.3+: server returns resolved vaults_root so the picker
        // can show "Vaults root: ~/Raven" (or whatever RAVEN_VAULTS_DIR / legacy
        // WIKI_VAULTS_DIR resolves to).
        if (typeof d.vaults_root === "string") {
          setVaultsRoot(d.vaults_root);
        }
        setLoading(false);
        if (!active && d.vaults?.length) {
          const def = d.vaults.find((v: VaultMeta) => v.default) || d.vaults[0];
          if (def) {
            onChange(def.name);
            setActiveVault(def.name);
          }
        }
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    loadVaults();
  }, []);

  // ─── close on outside click ──────────────────────────────
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent | PointerEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onDoc, { capture: true });
    document.addEventListener("mousedown", onDoc, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onDoc, { capture: true } as any);
      document.removeEventListener("mousedown", onDoc, { capture: true } as any);
    };
  }, [open]);

  // ─── select vault ────────────────────────────────────────
  const navigate = useNavigate();

  async function select(name: string) {
    onChange(name);
    setActiveVault(name);
    setOpen(false);
    try {
      await apiFetch(`/api/vaults/${name}/select`, { method: "POST" });
    } catch (e) {
      console.error("Failed to select vault on backend", e);
    }

    try {
      const r = await apiFetch(
        `/api/vaults/${encodeURIComponent(name)}/pages?top_k=1`
      );
      const d = await r.json();
      const slug = d?.pages?.[0]?.slug;
      if (slug) {
        navigate(`/page/${encodeURIComponent(name)}/${slug}`);
      } else {
        navigate(`/vault/manage`);
      }
    } catch {
      navigate(`/vault/manage`);
    }
  }

  const current = vaults.find((v) => v.name === active);

  return (
    <div className="relative" ref={wrapperRef}>
      <button
        onClick={() => setOpen(!open)}
        disabled={loading}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          height: 32,
          background: "transparent",
          border: "1px solid var(--cds-border-subtle)",
          borderRadius: 16,
          color: "var(--color-ink)",
          fontSize: 13,
          fontWeight: 600,
          cursor: loading ? "wait" : "pointer",
          fontFamily: "inherit",
        }}
      >
        <span aria-hidden>📁</span>
        <span>{current ? current.name : loading ? "loading…" : "—"}</span>
        <span aria-hidden style={{ fontSize: 10, opacity: 0.6 }}>▾</span>
      </button>

      {open && (
        <div
          role="listbox"
          aria-label="vault picker"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: 240,
            maxHeight: 360,
            overflowY: "auto",
            background: "var(--color-canvas)",
            border: "1px solid var(--cds-border-subtle)",
            borderRadius: 8,
            boxShadow: "var(--shadow-overlay)",
            zIndex: 100,
            fontSize: 14,
          }}
        >
          <div
            style={{
              padding: "12px 16px 8px",
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: "0.32px",
              textTransform: "uppercase",
              color: "var(--color-muted)",
            }}
          >
            Vaults ({vaults.length})
          </div>

          {vaultsRoot && (
            <div
              style={{
                fontSize: 11,
                color: "var(--color-muted)",
                padding: "0 16px 8px",
                fontFamily: "ui-monospace, SFMono-Regular, monospace",
              }}
              data-testid="vaults-root-label"
            >
              root: {vaultsRoot}
            </div>
          )}

          {vaults.length === 0 ? (
            <div style={{ padding: 16, fontSize: 13, color: "var(--color-muted)" }}>
              no vaults registered.
            </div>
          ) : (
            vaults.map((v) => (
              <button
                key={v.name}
                role="option"
                aria-selected={v.name === active}
                onClick={() => select(v.name)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  padding: "10px 16px",
                  background:
                    v.name === active
                      ? "var(--color-surface-soft)"
                      : "transparent",
                  border: "none",
                  textAlign: "left",
                  fontSize: 14,
                  color: "var(--color-ink)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
                onMouseEnter={(e) => {
                  if (v.name === active) return;
                  (e.currentTarget as HTMLElement).style.background =
                    "var(--color-hairline-strong)";
                }}
                onMouseLeave={(e) => {
                  if (v.name === active) return;
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {v.default && (
                    <span
                      style={{
                        fontSize: 9,
                        color: "var(--color-primary)",
                        fontWeight: 700,
                      }}
                      aria-label="default"
                    >
                      ★
                    </span>
                  )}
                  {v.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: "var(--color-muted)",
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                  }}
                >
                  {v.mode}
                </span>
              </button>
            ))
          )}

          {/* v0.6.7: vault creation is handled by the NewVaultWizard
              (`/vault/new`). The button below is a single Link — the
              inline form (path input + mode select 3개) that used to
              live here is removed for consistency. v0.6.10: vault
              management (rename/delete/stats) lives at `/vault/manage`. */}
          <div style={{ borderTop: "1px solid var(--color-hairline)" }}>
            <Link
              to="/vault/new"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 500,
                color: "var(--color-primary)",
                textDecoration: "none",
              }}
            >
              ➕ 새 vault 만들기
            </Link>
            <Link
              to="/vault/manage"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                padding: "10px 16px",
                fontSize: 14,
                fontWeight: 500,
                color: "var(--color-muted)",
                textDecoration: "none",
              }}
            >
              ⚙ vault 관리 (이름변경/삭제)
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
