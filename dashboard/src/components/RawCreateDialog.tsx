/* raw/ 새 파일 다이얼로그 — 공통 구현 (Issue #2 B-4).
 *
 * 같은 UI가 3곳에 복붙돼 있었다:
 *   1. RawPanel.tsx 비어 있는 상태 분기
 *   2. RawPanel.tsx 일반 분기
 *   3. Sidebar.tsx NewRawFileButton
 * 단순 중복이 아니라 비동기 보호 정책이 갈라져 있었다 — Sidebar만 busy 가드,
 * backdrop 닫기 차단, "만드는 중…" 표시가 있었고 RawPanel 두 복사본에는 없었다.
 * 그래서 더 엄격한 쪽(Sidebar)을 단일 구현으로 채택하고, 호출부 차이(목록 갱신 /
 * 상세로 이동)는 onCreated(rel) 콜백으로만 주입한다.
 *
 * 계약:
 *  - 열려 있는 동안에만 마운트한다(호출부가 `{open && <RawCreateDialog .../>}`).
 *    닫으면 상태가 사라져 이전 오류가 다시 뜨지 않는다.
 *  - 검증은 rawPath.resolveNewRawFile 한 곳 — 기존 파일을 writeRaw(rel, "")로
 *    덮어써 내용을 날리는 경로를 여기서 막는다 (v0.7.181).
 *  - onCreated는 생성 성공 후에만 호출된다.
 */
import { useMemo, useState } from "react";
import { Modal } from "./ui/Modal";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { resolveNewRawFile } from "../lib/rawPath";
import { writeRaw, type RawItem } from "../lib/api";

export function RawCreateDialog({
  vault,
  items,
  onClose,
  onCreated,
}: {
  vault: string;
  items: RawItem[];
  onClose: () => void;
  onCreated?: (rel: string) => void;
}) {
  const [name, setName] = useState("");
  const [dir, setDir] = useState("raw");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // parent dir 옵션 (root + 모든 dir)
  const dirOptions = useMemo(() => {
    const set = new Set<string>(["raw"]);
    for (const it of items) {
      if (it.type === "dir") set.add(it.path);
    }
    return [...set].sort();
  }, [items]);

  async function submit() {
    setErr(null);
    const { rel, error } = resolveNewRawFile({ name, dir, items });
    if (error || !rel) {
      setErr(error);
      return;
    }
    setBusy(true);
    try {
      await writeRaw(vault, rel, "");
      onCreated?.(rel);
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={() => !busy && onClose()} disableBackdropClose={busy}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>raw/ 새 파일</h3>
        <TextField
          label="파일명"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: notes.md, source.txt"
          helper="확장자 포함. 예: my-notes.md"
        />
        <TextField
          label="부모 디렉토리"
          value={dir}
          onChange={(e) => setDir(e.target.value)}
          helper="기본 raw/. 다른 디렉토리 경로 입력 가능 (예: raw/articles)."
        />
        <details style={{ fontSize: 12, color: "var(--color-muted)" }}>
          <summary style={{ cursor: "pointer" }}>기존 디렉토리 ({dirOptions.length})</summary>
          <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
            {dirOptions.map((d) => (
              <li key={d} style={{ cursor: "pointer" }} onClick={() => setDir(d)}>
                {d}
              </li>
            ))}
          </ul>
        </details>
        {err && (
          <div
            style={{
              background: "var(--color-danger-bg)",
              color: "var(--color-danger)",
              padding: "8px 12px",
              borderRadius: 6,
              fontSize: 12,
            }}
          >
            ❌ {err}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
          <Button type="button" variant="ghost" size="md" onClick={onClose} disabled={busy}>
            취소
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={submit}
            disabled={busy || !name.trim()}
          >
            {busy ? "만드는 중…" : "만들기"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
