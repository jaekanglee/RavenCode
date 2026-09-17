/**
 * RawPanel — raw/ 폴더 viewer/editor (v0.7.50+, ADR-2026-07-02)
 *
 * URL 패턴:
 *   /raw/{vault}            — raw 트리 선택 화면
 *   /raw/{vault}/{relPath}  — 선택 파일 viewer/editor 전체폭
 *
 * Layout: 파일 선택 전에는 raw 트리, 파일 선택 후에는 viewer만 표시.
 * 사이드바에도 raw 탐색기가 있으므로 파일 viewer 안에 중복 탐색기를 넣지 않는다.
 * 빈 raw/이거나 404면 EmptyState.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  deleteRaw,
  fetchRawContent,
  fetchRawList,
  writeRaw,
  type RawContent,
  type RawItem,
} from "../lib/api";
import { resolveNewRawFile } from "../lib/rawPath";
import { RawTree } from "../components/RawTree";
import { EmptyState } from "../components/ui/EmptyState";
import { EmptyIcon } from "../lib/emptyIcons";
import { PageHeader } from "../components/ui/PageHeader";
import { TextField } from "../components/ui/TextField";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";

export function RawPanel() {
  const { vault = "", "*": relPath = "" } = useParams<{ vault: string; "*": string }>();
  const navigate = useNavigate();

  const [items, setItems] = useState<RawItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [content, setContent] = useState<RawContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [newFileDir, setNewFileDir] = useState("raw");

  // raw list
  useEffect(() => {
    if (!vault) return;
    setLoading(true);
    setLoadError(false);
    fetchRawList(vault)
      .then((d) => setItems(d?.items ?? []))
      .catch(() => {
        setItems([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }, [vault]);

  // raw content: wait for the list so a directory URL is not fetched as a file.
  const selectedPath = relPath ? `raw/${relPath}` : null;
  useEffect(() => {
    if (!vault || !relPath || loading) {
      setContent(null);
      setEditMode(false);
      return;
    }
    if (items.some((item) => item.path === selectedPath && item.type === "dir")) {
      navigate(`/raw/${vault}`, { replace: true });
      return;
    }
    setContentLoading(true);
    setEditMode(false);
    setSaveError(null);
    fetchRawContent(vault, relPath)
      .then((d) => {
        setContent(d);
        setDraft(d?.content ?? "");
      })
      .catch(() => setContent(null))
      .finally(() => setContentLoading(false));
  }, [items, loading, navigate, relPath, selectedPath, vault]);

  const handleSelect = (path: string, type: "file" | "dir") => {
    // Directory clicks only expand/collapse RawTree. The raw content API accepts files.
    if (type === "dir") return;
    const rel = path.replace(/^raw\//, "");
    navigate(`/raw/${vault}/${rel}`);
  };

  const handleSave = async () => {
    if (!vault || !relPath) return;
    setSaving(true);
    setSaveError(null);
    try {
      await writeRaw(vault, relPath, draft);
      // refresh
      const c = await fetchRawContent(vault, relPath);
      setContent(c);
      setEditMode(false);
      // list 갱신 (size/modified)
      const list = await fetchRawList(vault);
      setItems(list?.items ?? []);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!vault || !relPath) return;
    setDeleting(true);
    try {
      await deleteRaw(vault, relPath);
      setContent(null);
      setEditMode(false);
      setDeleteConfirm(false);
      // list 갱신 + 트리로 이동
      const list = await fetchRawList(vault);
      setItems(list?.items ?? []);
      navigate(`/raw/${vault}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(false);
    }
  };

  const handleNewFile = async () => {
    if (!vault) return;
    setSaveError(null);
    // v0.7.181: Sidebar raw ＋와 같은 검증 (rawPath.resolveNewRawFile).
    // 기존 파일명을 입력하면 writeRaw(rel, "")가 내용을 날린다 — create-only
    // 의미는 이 UI에만 있으므로 가드도 여기.
    const { rel, error } = resolveNewRawFile({ name: newFileName, dir: newFileDir, items });
    if (error || !rel) {
      setSaveError(error);
      return;
    }
    try {
      await writeRaw(vault, rel, "");
      setNewFileOpen(false);
      setNewFileName("");
      const list = await fetchRawList(vault);
      setItems(list?.items ?? []);
      navigate(`/raw/${vault}/${rel}`);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    }
  };

  // parent dir 옵션 (root + 모든 dir)
  const dirOptions = useMemo(() => {
    const set = new Set<string>(["raw"]);
    for (const it of items) {
      if (it.type === "dir") set.add(it.path);
    }
    return [...set].sort();
  }, [items]);

  if (loading) {
    return (
      <EmptyState
        icon={<EmptyIcon.Loader />}
        title="raw/ 폴더를 불러오는 중"
        description="잠시만 기다려 주세요."
      />
    );
  }
  if (loadError) {
    return (
      <EmptyState
        icon={<EmptyIcon.AlertTriangle />}
        title="raw/ 폴더를 불러오지 못했습니다"
        description="vault에 raw/ 폴더가 없거나 API 응답 오류."
      />
    );
  }
  if (items.length === 0) {
    return (
      <div className="raw-panel-shell">
        <PageHeader
          title="raw"
          contextLabel={`${vault} 보관소`}
          bottomSpacing={0}
        />
        <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end" }}>
          <Button type="button" variant="primary" size="sm" onClick={() => setNewFileOpen(true)}>
            ＋ 새 파일
          </Button>
        </div>
        <EmptyState
          icon="📂"
          title="raw/ 폴더가 비어 있습니다"
          description="이 vault의 raw/ 폴더에 파일이 없습니다. 새 파일을 만들거나 OS 파일관리자로 자료를 떨어뜨리세요."
        />
        {newFileOpen && (
          <Modal open={newFileOpen} onClose={() => setNewFileOpen(false)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>raw/ 새 파일</h3>
              <TextField
                label="파일명"
                value={newFileName}
                onChange={(e) => setNewFileName(e.target.value)}
                placeholder="예: notes.md, source.txt"
                helper="확장자 포함. 예: my-notes.md"
              />
              <TextField
                label="부모 디렉토리"
                value={newFileDir}
                onChange={(e) => setNewFileDir(e.target.value)}
                helper="기본 raw/. 다른 디렉토리 경로 입력 가능 (예: raw/articles)."
              />
              <details style={{ fontSize: 12, color: "var(--color-muted)" }}>
                <summary style={{ cursor: "pointer" }}>기존 디렉토리 ({dirOptions.length})</summary>
                <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                  {dirOptions.map((d) => (
                    <li key={d} style={{ cursor: "pointer" }} onClick={() => setNewFileDir(d)}>
                      {d}
                    </li>
                  ))}
                </ul>
              </details>
              {saveError && (
                <div
                  style={{
                    background: "var(--color-danger-soft, #fee)",
                    color: "var(--color-danger, #c00)",
                    padding: "8px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                >
                  ❌ {saveError}
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  onClick={() => setNewFileOpen(false)}
                >
                  취소
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  onClick={handleNewFile}
                  disabled={!newFileName.trim()}
                >
                  만들기
                </Button>
              </div>
            </div>
          </Modal>
        )}
      </div>
    );
  }

  return (
    <div className="raw-panel-shell" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <PageHeader
          title="raw"
          contextLabel={`${vault} 보관소`}
          titleSize={22}
          bottomSpacing={0}
        />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Button type="button" variant="primary" size="sm" onClick={() => setNewFileOpen(true)}>
            ＋ 새 파일
          </Button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: relPath ? "minmax(0, 1fr)" : "minmax(240px, 1fr) minmax(0, 2.5fr)",
          gap: 16,
          alignItems: "stretch",
        }}
      >
        {/* 좌: 트리 — 파일 선택 전 전용. 파일을 열면 사이드바 탐색기와 중복되므로 숨김. */}
        {!relPath && (
          <div
            style={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-hairline)",
              borderRadius: 8,
              padding: 8,
              height: "calc(100vh - 220px)",
              overflowY: "auto",
            }}
          >
            <div
              className="sidebar-label"
              style={{
                padding: "0 0 6px",
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.32px",
                color: "var(--color-muted)",
                fontFamily: "var(--font-display)",
              }}
            >
              📂 raw ({items.length})
            </div>
            <RawTree
              items={items}
              selectedPath={selectedPath}
              onSelect={handleSelect}
              compact
            />
          </div>
        )}

        {/* 우: viewer/editor — 외부 box는 hairline만, 안쪽 border 제거로 1겹 정리 */}
        <div
          className="raw-panel-viewer"
          style={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-hairline)",
            borderRadius: 8,
            padding: 16,
            minHeight: 240,
            height: "calc(100vh - 220px)",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
          }}
        >
          {!relPath ? (
            <EmptyState
              icon="👈"
              title="왼쪽에서 파일을 선택하세요"
              description="raw/ 폴더 안의 파일을 클릭하면 내용을 보고 편집할 수 있습니다."
            />
          ) : contentLoading ? (
            <EmptyState icon="⏳" title="파일 로딩 중" description="잠시만 기다려 주세요." />
          ) : !content ? (
            <EmptyState
              icon="❓"
              title="파일을 찾을 수 없습니다"
              description={`raw/${relPath} (404)`}
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  paddingBottom: 10,
                  marginBottom: 12,
                  borderBottom: "1px solid var(--color-hairline)",
                  fontSize: 13,
                }}
              >
                <span style={{ fontWeight: 700 }}>raw/{relPath}</span>
                {content.size != null && (
                  <span style={{ color: "var(--color-muted)" }}>
                    ({content.size}B
                    {content.modified && ` · ${content.modified.slice(0, 19).replace("T", " ")}`})
                  </span>
                )}
                <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
                  {!editMode ? (
                    <Button type="button" variant="secondary" size="sm" onClick={() => setEditMode(true)}>
                      ✏ 편집
                    </Button>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditMode(false);
                          setDraft(content.content);
                          setSaveError(null);
                        }}
                        disabled={saving}
                      >
                        취소
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        onClick={handleSave}
                        disabled={saving}
                      >
                        {saving ? "저장 중…" : "💾 저장"}
                      </Button>
                    </>
                  )}
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => setDeleteConfirm(true)}
                    disabled={saving || deleting}
                  >
                    🗑 삭제
                  </Button>
                </div>
              </div>

              {saveError && (
                <div
                  style={{
                    background: "var(--color-danger-soft, #fee)",
                    color: "var(--color-danger, #c00)",
                    padding: "8px 12px",
                    borderRadius: 6,
                    fontSize: 12,
                    marginBottom: 8,
                  }}
                >
                  ❌ {saveError}
                </div>
              )}

              <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
                <textarea
                  value={editMode ? draft : content.content}
                  onChange={(e) => setDraft(e.target.value)}
                  readOnly={!editMode}
                  spellCheck={false}
                  className="raw-panel-viewer-textarea"
                  style={{
                    flex: 1,
                    width: "100%",
                    height: "100%",
                    padding: "12px 14px",
                    fontFamily: "ui-monospace, SFMono-Regular, monospace",
                    fontSize: 13,
                    lineHeight: 1.5,
                    color: "var(--color-ink)",
                    background: "var(--color-canvas)",
                    border: "none",
                    borderRadius: 6,
                    outline: "none",
                    resize: "none",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    tabSize: 2,
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {newFileOpen && (
        <Modal open={newFileOpen} onClose={() => setNewFileOpen(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>raw/ 새 파일</h3>
            <TextField
              label="파일명"
              value={newFileName}
              onChange={(e) => setNewFileName(e.target.value)}
              placeholder="예: notes.md, source.txt"
              helper="확장자 포함. 예: my-notes.md"
            />
            <TextField
              label="부모 디렉토리"
              value={newFileDir}
              onChange={(e) => setNewFileDir(e.target.value)}
              helper="기본 raw/. 다른 디렉토리 경로 입력 가능 (예: raw/articles)."
            />
            <details style={{ fontSize: 12, color: "var(--color-muted)" }}>
              <summary style={{ cursor: "pointer" }}>기존 디렉토리 ({dirOptions.length})</summary>
              <ul style={{ margin: "4px 0 0 16px", padding: 0 }}>
                {dirOptions.map((d) => (
                  <li key={d} style={{ cursor: "pointer" }} onClick={() => setNewFileDir(d)}>
                    {d}
                  </li>
                ))}
              </ul>
            </details>
            {saveError && (
              <div
                style={{
                  background: "var(--color-danger-soft, #fee)",
                  color: "var(--color-danger, #c00)",
                  padding: "8px 12px",
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                ❌ {saveError}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => setNewFileOpen(false)}
              >
                취소
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={handleNewFile}
                disabled={!newFileName.trim()}
              >
                만들기
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleteConfirm && (
        <Modal open={deleteConfirm} onClose={() => setDeleteConfirm(false)}>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>raw/ 파일 삭제</h3>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>
              <strong>raw/{relPath}</strong>을(를) 삭제할까요? 이 작업은 되돌릴 수 없습니다
              (OS 파일관리자로 복구 가능).
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 8 }}>
              <Button
                type="button"
                variant="ghost"
                size="md"
                onClick={() => setDeleteConfirm(false)}
                disabled={deleting}
              >
                취소
              </Button>
              <Button
                type="button"
                variant="danger"
                size="md"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? "삭제 중…" : "삭제"}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

