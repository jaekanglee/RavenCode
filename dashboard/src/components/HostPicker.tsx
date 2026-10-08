import { useEffect, useState } from "react";
import {
  getHosts,
  getActiveHostId,
  setActiveHostId,
  addHost,
  normalizeEndpoint,
  removeHost,
  testHostConnection,
  getActiveHost,
  type HostConnection,
} from "../lib/api";
import { TextField } from "./ui/TextField";
import { getHostToken, setHostToken } from "../lib/host-auth";
import { Button } from "./ui/Button";

export function HostPicker() {
  const [hosts, setHosts] = useState<HostConnection[]>([]);
  const [activeId, setActiveId] = useState<string>("local");
  const [modalOpen, setModalOpen] = useState(false);
  const [hostName, setHostName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  // Issue #24: 원격 호스트(tailnet 포함)는 토큰 필수. sessionStorage에만 보관된다.
  const [token, setToken] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeStatus, setActiveStatus] = useState<"checking" | "online" | "offline" | "local">("checking");
  const [activeError, setActiveError] = useState<string | null>(null);

  useEffect(() => {
    setHosts(getHosts());
    setActiveId(getActiveHostId());
  }, []);

  const checkActiveStatus = async () => {
    const activeHost = getActiveHost();
    if (activeHost.isLocal) {
      setActiveStatus("local");
      setActiveError(null);
      return;
    }
    setActiveStatus("checking");
    setActiveError(null);
    try {
      const res = await testHostConnection(activeHost.endpoint, getHostToken(activeHost.endpoint));
      if (res.ok) {
        setActiveStatus((prev) => {
          if (prev === "offline") {
            window.location.reload();
          }
          return "online";
        });
      } else {
        setActiveStatus("offline");
        setActiveError(res.error || "연결 실패");
      }
    } catch (e: any) {
      setActiveStatus("offline");
      setActiveError(e.message || String(e));
    }
  };

  useEffect(() => {
    if (hosts.length > 0) {
      checkActiveStatus();
    }
  }, [activeId, hosts]);

  // 오프라인 상태일 때 5초 간격으로 백그라운드 자동 재연결 시도
  useEffect(() => {
    if (activeStatus !== "offline") return;
    const interval = setInterval(() => {
      checkActiveStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [activeStatus]);

  function handleSelectHost(id: string) {
    setActiveHostId(id);
    setActiveId(id);
    // Reload dashboard to apply active host endpoint across all stores
    window.location.href = "/";
  }

  function handleRemove(id: string) {
    if (confirm("이 호스트 연결을 삭제하시겠습니까?")) {
      removeHost(id);
      setHosts(getHosts());
      setActiveId(getActiveHostId());
      if (activeId === id) {
        window.location.href = "/";
      }
    }
  }

  async function handleTest() {
    if (!endpoint.trim()) {
      setTestResult({ ok: false, message: "IP 또는 URL 주소를 입력하세요." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    const res = await testHostConnection(endpoint, token);
    setTesting(false);
    if (res.ok) {
      setTestResult({ ok: true, message: `✅ 연결 성공! (${res.vaultsCount}개 보관소 발견)` });
    } else {
      setTestResult({ ok: false, message: `❌ 연결 실패: ${res.error}` });
    }
  }

  function handleSave() {
    if (!endpoint.trim()) {
      setTestResult({ ok: false, message: "IP 또는 URL 주소를 입력하세요." });
      return;
    }
    setSubmitting(true);
    const newHost = addHost({
      name: hostName.trim() || endpoint.trim(),
      endpoint: endpoint.trim(),
      isLocal: false,
    });
    if (token.trim()) setHostToken(normalizeEndpoint(endpoint), token);
    setHosts(getHosts());
    setSubmitting(false);
    setModalOpen(false);
    setHostName("");
    setEndpoint("");
    setToken("");
    setTestResult(null);
    
    // Switch to newly added host
    handleSelectHost(newHost.id);
  }

  const currentHost = getActiveHost();

  return (
    <div className="sidebar-host-selector-container" style={{ marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "0 4px 6px",
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: "0.32px",
            color: "var(--color-muted)",
            fontFamily: "var(--font-display)",
          }}
        >
          호스트 PC ({hosts.length})
        </span>
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          style={{
            fontSize: 11,
            color: "var(--color-primary)",
            background: "none",
            border: "none",
            cursor: "pointer",
            fontWeight: 600,
          }}
          title="새 호스트 연결 추가"
        >
          + 추가
        </button>
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <select
          className="input-base"
          value={activeId}
          onChange={(e) => handleSelectHost(e.target.value)}
          aria-label="호스트 PC 선택"
          style={{ flex: 1, margin: 0 }}
        >
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.isLocal ? "💻 " : "🌐 "}
              {h.name} {!h.isLocal ? `(${h.endpoint})` : ""}
            </option>
          ))}
        </select>
        {!currentHost.isLocal && (
          <button
            type="button"
            onClick={() => handleRemove(currentHost.id)}
            className="sidebar-favorite-btn"
            title="현재 원격 호스트 삭제"
            style={{ color: "var(--color-danger-text)" }}
          >
            🗑
          </button>
        )}
      </div>

      <div style={{ marginTop: 6, paddingLeft: 4, display: "flex", alignItems: "center", gap: 6 }}>
        {activeStatus === "checking" && (
          <>
            <span
              className="status-dot checking"
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "var(--radius-full)",
                backgroundColor: "var(--color-muted-soft)",
              }}
            />
            <span style={{ fontSize: 11, color: "var(--color-muted)", fontFamily: "var(--font-display)" }}>
              연결 확인 중...
            </span>
          </>
        )}
        {activeStatus === "online" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span
              className="status-dot online"
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "var(--radius-full)",
                backgroundColor: "var(--color-success-border)",
                boxShadow: "0 0 4px var(--color-success-border)",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: "var(--color-success-text)",
                fontWeight: 600,
                fontFamily: "var(--font-display)",
              }}
            >
              정상 연결됨
            </span>
            <button
              type="button"
              onClick={checkActiveStatus}
              style={{
                fontSize: 11,
                padding: "1px 4px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                background: "transparent",
                color: "var(--color-muted)",
                cursor: "pointer",
              }}
              title="연결 상태 다시 확인"
            >
              🔄
            </button>
          </div>
        )}
        {activeStatus === "offline" && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span
              className="status-dot offline"
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "var(--radius-full)",
                backgroundColor: "var(--color-danger-text)",
                boxShadow: "0 0 4px var(--color-danger-text)",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: "var(--color-danger-text)",
                fontWeight: 600,
                fontFamily: "var(--font-display)",
              }}
            >
              연결 실패 {activeError ? `(${activeError})` : ""}
            </span>
            <button
              type="button"
              onClick={checkActiveStatus}
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--color-danger-text)",
                background: "var(--color-surface-soft)",
                color: "var(--color-danger-text)",
                cursor: "pointer",
                fontWeight: 600,
                fontFamily: "var(--font-display)",
              }}
              title="상대 PC 백엔드 연결 다시 확인"
            >
              🔄 재시도
            </button>
          </div>
        )}
        {activeStatus === "local" && (
          <>
            <span
              className="status-dot local"
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "var(--radius-full)",
                backgroundColor: "var(--color-primary)",
              }}
            />
            <span
              style={{
                fontSize: 11,
                color: "var(--color-primary)",
                fontWeight: 600,
                fontFamily: "var(--font-display)",
              }}
            >
              로컬 호스트
            </span>
          </>
        )}
      </div>

      {modalOpen && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 1000,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              background: "var(--color-canvas)",
              border: "1px solid var(--color-hairline)",
              borderRadius: "var(--radius-lg)",
              padding: 24,
              width: "100%",
              maxWidth: 440,
              boxShadow: "var(--shadow-overlay)",
            }}
          >
            <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>원격 Raven 호스트 추가</h2>
            <p style={{ fontSize: 13, color: "var(--color-muted)", marginBottom: 16 }}>
              다른 PC에서 실행 중인 Raven 백엔드(IP/Port)를 연결하여 해당 기기의 ~/Raven/ 보관소들을 열람합니다.
            </p>

            <TextField
              label="호스트 이름"
              placeholder="예: 집 데스크톱, 회사 NAS"
              value={hostName}
              onChange={(e) => setHostName(e.target.value)}
            />

            <TextField
              label="IP 주소 또는 URL"
              required
              placeholder="예: 192.168.0.15:8765 또는 http://100.x.y.z:8765"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              style={{ marginTop: 12 }}
            />

            <TextField
              label="접근 토큰"
              type="password"
              autoComplete="off"
              placeholder="rvn_... (상대 PC에서 raven mcp token add <이름>)"
              helper="tailnet·내부망 연결에 필요합니다. 이 창을 닫으면 지워집니다."
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{ marginTop: 12 }}
            />

            {testResult && (
              <div
                style={{
                  marginTop: 12,
                  fontSize: 13,
                  color: testResult.ok ? "var(--color-primary)" : "var(--color-danger-text)",
                }}
              >
                {testResult.message}
              </div>
            )}

            {/* ── 등록된 원격 호스트 목록 및 관리 ── */}
            {hosts.filter((h) => !h.isLocal).length > 0 && (
              <div style={{ marginTop: 16, borderTop: "1px solid var(--color-hairline)", paddingTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "var(--color-muted)", marginBottom: 8 }}>
                  등록된 원격 호스트 목록
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 140, overflowY: "auto" }}>
                  {hosts
                    .filter((h) => !h.isLocal)
                    .map((h) => (
                      <div
                        key={h.id}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          padding: "6px 8px",
                          borderRadius: "var(--radius-sm)",
                          background: "var(--color-surface-soft)",
                          fontSize: 12,
                        }}
                      >
                        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          <span style={{ fontWeight: 600 }}>{h.name}</span>{" "}
                          <span style={{ color: "var(--color-muted)", fontSize: 11 }}>({h.endpoint})</span>
                        </div>
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => handleRemove(h.id)}
                          title="이 호스트 삭제"
                        >
                          삭제
                        </Button>
                      </div>
                    ))}
                </div>
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 20 }}>
              <Button variant="pill" onClick={handleTest} disabled={testing}>
                {testing ? "테스트 중..." : "연결 테스트"}
              </Button>
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="pill" onClick={() => setModalOpen(false)}>
                  닫기
                </Button>
                <Button variant="pillPrimary" onClick={handleSave} disabled={submitting}>
                  추가 및 전환
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
