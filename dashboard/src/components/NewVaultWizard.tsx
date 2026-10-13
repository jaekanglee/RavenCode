import { Link, useNavigate, useOutletContext } from "react-router-dom";
import { useEffect, useState } from "react";
import { setActiveVault, apiFetch } from "../lib/api";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";

const KEBAB_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function defaultPath(name: string) {
  return `~/Raven/${name}/`;
}

export function NewVaultWizard() {
  const navigate = useNavigate();
  const { refresh } = useOutletContext<{ refresh: () => void }>() || {};
  const [mode, setMode] = useState<"create" | "register">("create");
  
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [customPath, setCustomPath] = useState("");
  
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (mode === "create") {
      setPath(name ? defaultPath(name) : "");
    }
  }, [name, mode]);

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("vault 이름을 입력하세요.");
      return;
    }
    if (!KEBAB_RE.test(name)) {
      setError("이름은 kebab-case여야 합니다 (예: my-notes, work-2026).");
      return;
    }
    if (mode === "register" && !customPath.trim()) {
      setError("기존 vault 폴더의 절대 경로를 입력하세요.");
      return;
    }

    setSubmitting(true);
    try {
      const endpoint = mode === "create" ? "/api/vaults" : "/api/vaults/register";
      const payload = mode === "create" 
        ? {
            name,
            path,
            mode: "personal",
            description: "Created via Dashboard",
          }
        : {
            name,
            path: customPath,
            mode: "personal",
            owner: "user",
            workspace: "",
          };

      const r = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false) {
        throw new Error(data?.detail || data?.error || `HTTP ${r.status}`);
      }
      setActiveVault(name);
      refresh?.();
      navigate("/");
    } catch (e) {
      setError(`${mode === "create" ? "만들기" : "등록"} 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 560 }}>
      <h1 style={{ marginBottom: 8 }}>새 vault 추가</h1>
      <p className="text-muted" style={{ fontSize: 14, marginBottom: 24 }}>
        새로운 Markdown workspace를 만들거나, 기존 폴더를 보관소로 등록합니다.
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <button
          onClick={() => setMode("create")}
          style={{
            padding: "8px 16px",
            border: "1px solid var(--cds-border-subtle)",
            background: mode === "create" ? "var(--color-surface-soft)" : "transparent",
            color: mode === "create" ? "var(--color-primary)" : "var(--color-muted)",
            fontWeight: mode === "create" ? 600 : 400,
            borderRadius: 6,
            cursor: "pointer",
            flex: 1,
          }}
        >
          새로 만들기
        </button>
        <button
          onClick={() => setMode("register")}
          style={{
            padding: "8px 16px",
            border: "1px solid var(--cds-border-subtle)",
            background: mode === "register" ? "var(--color-surface-soft)" : "transparent",
            color: mode === "register" ? "var(--color-primary)" : "var(--color-muted)",
            fontWeight: mode === "register" ? 600 : 400,
            borderRadius: 6,
            cursor: "pointer",
            flex: 1,
          }}
        >
          기존 폴더 등록
        </button>
      </div>

      <TextField
        label="이름"
        required
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder="my-notes"
        helper="소문자, 숫자, 하이픈만 사용할 수 있습니다."
      />

      {mode === "create" ? (
        <TextField
          label="경로"
          readOnly
          value={path}
          placeholder="이름을 입력하면 자동으로 표시됩니다"
          helper="기본 위치 아래에 새 폴더를 만듭니다."
          style={{ marginTop: 16, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
        />
      ) : (
        <TextField
          label="경로"
          required
          value={customPath}
          onChange={(e) => setCustomPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          placeholder="예: /Users/username/Documents/my-notes"
          helper="기존에 존재하는 폴더의 절대 경로를 입력하세요."
          style={{ marginTop: 16, fontFamily: "ui-monospace, SFMono-Regular, monospace" }}
        />
      )}

      {error && (
        <p role="alert" style={{ marginTop: 16, color: "var(--color-danger-text)", fontSize: 13 }}>
          {error}
        </p>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
        <Link to="/" className="link-muted" style={{ fontSize: 13, alignSelf: "center" }}>
          ← 홈으로
        </Link>
        <Button variant="pillPrimary" onClick={() => void submit()} disabled={submitting}>
          {submitting ? "처리 중…" : mode === "create" ? "만들기" : "등록하기"}
        </Button>
      </div>
    </div>
  );
}
