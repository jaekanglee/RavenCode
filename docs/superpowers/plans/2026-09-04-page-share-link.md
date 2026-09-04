# 페이지별 공유하기 버튼 (내부망/Tailscale 링크) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 페이지 뷰에 "공유하기" 버튼을 추가해, 내부망(LAN) IP 또는 Tailscale IP 기반 딥링크(`http://<ip>:<port>/page/<vault>/<slug>`)를 만들어 복사할 수 있게 한다.

**Architecture:** 백엔드(`raven/api/main.py`)에 LAN IP 감지 함수를 추가하고 `/api/system/info`가 이를 함께 반환하도록 확장한다. 프론트엔드는 새 `ShareButton` 컴포넌트를 만들어 페이지 뷰 편집 툴바(`InlineMarkdownEditor.tsx`)에 꽂는다. 링크는 백엔드가 이미 같은 포트에서 서빙 중인 대시보드 SPA를 그대로 가리키므로 별도 라우팅/서버 변경은 필요 없다.

**Tech Stack:** Python 3 / FastAPI (백엔드), React + TypeScript + Vitest/@testing-library/react (프론트엔드)

**참고 스펙:** `docs/superpowers/specs/2026-09-04-page-share-link-design.md`

---

## Task 1: 백엔드 — `get_lan_ip()` 감지 함수

**Files:**
- Modify: `raven/api/main.py:1-22` (기존 `get_tailscale_ip()` 바로 아래)
- Test: `tests/test_page_share_lan_ip.py` (신규)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/test_page_share_lan_ip.py` 신규 생성:

```python
"""get_lan_ip() — LAN(192.168/10/172.16-31) IP 감지, Tailscale(100.64.0.0/10)과 구분.

배경: 페이지 공유 링크가 내부망 IP를 표시하려면 Tailscale IP와 겹치지 않는
전용 감지 로직이 필요하다 (docs/superpowers/specs/2026-09-04-page-share-link-design.md).
"""
from __future__ import annotations

import socket
from unittest.mock import MagicMock, patch

from raven.api.main import get_lan_ip


def _mock_socket_returning(ip: str) -> MagicMock:
    mock_sock = MagicMock()
    mock_sock.getsockname.return_value = (ip, 0)
    return mock_sock


def test_get_lan_ip_returns_192_168_address():
    with patch("socket.socket", return_value=_mock_socket_returning("192.168.1.42")):
        assert get_lan_ip() == "192.168.1.42"


def test_get_lan_ip_returns_10_x_address():
    with patch("socket.socket", return_value=_mock_socket_returning("10.0.0.5")):
        assert get_lan_ip() == "10.0.0.5"


def test_get_lan_ip_returns_172_16_31_address():
    with patch("socket.socket", return_value=_mock_socket_returning("172.20.3.9")):
        assert get_lan_ip() == "172.20.3.9"


def test_get_lan_ip_rejects_tailscale_address():
    """100.64.0.0/10 대역은 Tailscale IP이므로 LAN IP로 반환하면 안 된다."""
    with patch("socket.socket", return_value=_mock_socket_returning("100.64.0.1")):
        with patch("socket.gethostbyname_ex", return_value=("host", [], ["100.64.0.1"])):
            assert get_lan_ip() is None


def test_get_lan_ip_returns_none_when_no_network():
    with patch("socket.socket", side_effect=OSError("network unreachable")):
        with patch("socket.gethostbyname_ex", side_effect=OSError("no network")):
            assert get_lan_ip() is None
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_page_share_lan_ip.py -v`
Expected: FAIL — `ImportError: cannot import name 'get_lan_ip' from 'raven.api.main'`

- [ ] **Step 3: `get_lan_ip()` 구현**

`raven/api/main.py`의 `get_tailscale_ip()` 함수(현재 3~22행) 바로 아래에 추가:

```python
def get_lan_ip() -> str | None:
    """Detect this machine's LAN IP (192.168/10/172.16-31), distinct from Tailscale (100.64.0.0/10)."""
    def _is_lan(ip: str) -> bool:
        parts = ip.split(".")
        if len(parts) != 4:
            return False
        try:
            octets = [int(p) for p in parts]
        except ValueError:
            return False
        if octets[0] == 192 and octets[1] == 168:
            return True
        if octets[0] == 10:
            return True
        if octets[0] == 172 and 16 <= octets[1] <= 31:
            return True
        return False

    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if _is_lan(ip):
            return ip
    except Exception:
        pass
    try:
        _, _, ips = socket.gethostbyname_ex(socket.gethostname())
        for ip in ips:
            if _is_lan(ip):
                return ip
    except Exception:
        pass
    return None
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_page_share_lan_ip.py -v`
Expected: `5 passed`

- [ ] **Step 5: 커밋**

```bash
cd "/Users/ksdy234/Desktop/Dev/Project/Raven"
git add raven/api/main.py tests/test_page_share_lan_ip.py
git commit -m "feat: LAN IP 감지 함수 get_lan_ip() 추가 (Tailscale 대역과 구분)"
```

---

## Task 2: 백엔드 — `/api/system/info`에 `lan_ip`/`lan_api` 필드 추가

**Files:**
- Modify: `raven/api/server.py:205-224`
- Test: `tests/test_page_share_lan_ip.py` (Task 1 파일에 이어서 작성)

- [ ] **Step 1: 실패하는 테스트 작성**

`tests/test_page_share_lan_ip.py` 끝에 추가:

```python
from fastapi.testclient import TestClient

from raven.api.server import app

client = TestClient(app)


def test_system_info_includes_lan_ip_when_detected():
    with patch("raven.api.main.get_lan_ip", return_value="192.168.1.42"):
        res = client.get("/api/system/info")
    assert res.status_code == 200
    data = res.json()
    assert data["lan_ip"] == "192.168.1.42"
    assert data["lan_api"] == f"http://192.168.1.42:{data['port']}"


def test_system_info_lan_api_is_none_when_lan_ip_not_detected():
    with patch("raven.api.main.get_lan_ip", return_value=None):
        res = client.get("/api/system/info")
    assert res.status_code == 200
    data = res.json()
    assert data["lan_ip"] is None
    assert data["lan_api"] is None
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_page_share_lan_ip.py -v`
Expected: FAIL — `KeyError: 'lan_ip'` (응답에 아직 필드가 없음)

- [ ] **Step 3: `/api/system/info` 확장**

`raven/api/server.py` 205~224행의 `system_info()`를 다음으로 교체:

```python
@app.get("/api/system/info")
def system_info():
    """Returns backend system info including auto-detected Tailscale/LAN IP and MCP endpoints."""
    from raven.api.main import get_tailscale_ip, get_lan_ip
    ts_ip = get_tailscale_ip()
    lan_ip = get_lan_ip()
    port = bound_port()
    local_api = f"http://127.0.0.1:{port}"
    local_mcp = f"http://127.0.0.1:{port}/mcp"

    ts_api = f"http://{ts_ip}:{port}" if ts_ip else None
    ts_mcp = f"http://{ts_ip}:{port}/mcp" if ts_ip else None
    lan_api = f"http://{lan_ip}:{port}" if lan_ip else None

    return {
        "ok": True,
        "tailscale_ip": ts_ip,
        "lan_ip": lan_ip,
        "local_api": local_api,
        "local_mcp": local_mcp,
        "lan_api": lan_api,
        "tailscale_api": ts_api,
        "tailscale_mcp": ts_mcp,
        "bind_host": bound_host(),
        "allow_all_cors": _allow_all_cors,
        "port": port,
    }
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `scripts/.venv/bin/python -m pytest tests/test_page_share_lan_ip.py -v`
Expected: `7 passed`

- [ ] **Step 5: 전체 백엔드 테스트 회귀 확인**

Run: `scripts/.venv/bin/python -m pytest tests/ -q`
Expected: 기존 실패 0건 유지 (이 변경으로 새로 깨지는 테스트 없음)

- [ ] **Step 6: 커밋**

```bash
cd "/Users/ksdy234/Desktop/Dev/Project/Raven"
git add raven/api/server.py tests/test_page_share_lan_ip.py
git commit -m "feat: /api/system/info에 lan_ip/lan_api 필드 추가"
```

---

## Task 3: 프론트엔드 — `SystemInfo` 타입에 필드 추가

**Files:**
- Modify: `dashboard/src/lib/api.ts:211-220`

- [ ] **Step 1: 타입 확장**

`dashboard/src/lib/api.ts`의 `SystemInfo` 인터페이스(211~220행)를 다음으로 교체:

```ts
export interface SystemInfo {
  ok: boolean;
  tailscale_ip: string | null;
  lan_ip: string | null;
  local_api: string;
  local_mcp: string;
  lan_api: string | null;
  tailscale_api: string | null;
  tailscale_mcp: string | null;
  bind_host: string;
  allow_all_cors: boolean;
  port: number;
}
```

`fetchSystemInfo()` 함수 본문은 수정하지 않는다 (그대로 JSON을 캐스팅).

- [ ] **Step 2: 타입체크로 확인**

Run: `cd dashboard && npx tsc -b --noEmit`
Expected: 에러 없음 (이 인터페이스를 쓰는 `VaultManage.tsx`는 옵셔널 필드만 추가됐으므로 깨지지 않음)

- [ ] **Step 3: 커밋**

```bash
cd "/Users/ksdy234/Desktop/Dev/Project/Raven"
git add dashboard/src/lib/api.ts
git commit -m "feat: SystemInfo 타입에 lan_ip/lan_api 필드 추가"
```

---

## Task 4: 프론트엔드 — `ShareButton` 컴포넌트

**Files:**
- Create: `dashboard/src/components/ShareButton.tsx`
- Test: `dashboard/tests/ShareButton.test.tsx` (신규)

- [ ] **Step 1: 실패하는 테스트 작성**

`dashboard/tests/ShareButton.test.tsx` 신규 생성:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ShareButton } from "../src/components/ShareButton";
import * as api from "../src/lib/api";

describe("ShareButton", () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
  });

  it("클릭하면 팝오버가 열리고 내부망/Tailscale 링크가 렌더된다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: "100.64.1.2",
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: "http://100.64.1.2:8765",
      tailscale_mcp: "http://100.64.1.2:8765/mcp",
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));

    await waitFor(() => {
      expect(
        screen.getByText("http://192.168.1.42:8765/page/hub-control-room/concepts/foo")
      ).toBeTruthy();
      expect(
        screen.getByText("http://100.64.1.2:8765/page/hub-control-room/concepts/foo")
      ).toBeTruthy();
    });
  });

  it("IP가 감지되지 않으면 해당 행이 비활성 상태로 렌더된다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: null,
      lan_ip: null,
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: null,
      tailscale_api: null,
      tailscale_mcp: null,
      bind_host: "127.0.0.1",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));

    await waitFor(() => {
      expect(screen.getByText(/내부망 IP 감지 안 됨/)).toBeTruthy();
      expect(screen.getByText(/Tailscale IP 감지 안 됨/)).toBeTruthy();
    });
  });

  it("복사 버튼 클릭 시 clipboard.writeText가 올바른 URL로 호출된다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: null,
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: null,
      tailscale_mcp: null,
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));

    await waitFor(() => screen.getByLabelText("내부망 링크 복사"));
    fireEvent.click(screen.getByLabelText("내부망 링크 복사"));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "http://192.168.1.42:8765/page/hub-control-room/concepts/foo"
    );
  });

  it("바깥을 클릭하면 팝오버가 닫힌다", async () => {
    vi.spyOn(api, "fetchSystemInfo").mockResolvedValue({
      ok: true,
      tailscale_ip: "100.64.1.2",
      lan_ip: "192.168.1.42",
      local_api: "http://127.0.0.1:8765",
      local_mcp: "http://127.0.0.1:8765/mcp",
      lan_api: "http://192.168.1.42:8765",
      tailscale_api: "http://100.64.1.2:8765",
      tailscale_mcp: "http://100.64.1.2:8765/mcp",
      bind_host: "0.0.0.0",
      allow_all_cors: false,
      port: 8765,
    });

    render(<ShareButton vault="hub-control-room" slug="concepts/foo" />);
    fireEvent.click(screen.getByRole("button", { name: /공유/ }));
    await waitFor(() => screen.getByLabelText("내부망 링크 복사"));

    fireEvent.mouseDown(document.body);

    await waitFor(() => {
      expect(screen.queryByLabelText("내부망 링크 복사")).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd dashboard && npx vitest run tests/ShareButton.test.tsx`
Expected: FAIL — `Failed to resolve import "../src/components/ShareButton"`

- [ ] **Step 3: `ShareButton` 컴포넌트 구현**

`dashboard/src/components/ShareButton.tsx` 신규 생성:

```tsx
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
}: {
  label: string;
  url: string | null;
  copyLabel: string;
  onCopy: (url: string) => void;
  copied: boolean;
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
          {label.includes("내부망") ? "내부망 IP 감지 안 됨" : "Tailscale IP 감지 안 됨"}
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
              />
              <ShareRow
                label="Tailscale 링크"
                url={tsUrl}
                copyLabel="Tailscale 링크 복사"
                onCopy={(url) => handleCopy(url, "ts")}
                copied={copiedKey === "ts"}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 테스트 실행해서 통과 확인**

Run: `cd dashboard && npx vitest run tests/ShareButton.test.tsx`
Expected: `4 passed`

- [ ] **Step 5: 커밋**

```bash
cd "/Users/ksdy234/Desktop/Dev/Project/Raven"
git add dashboard/src/components/ShareButton.tsx dashboard/tests/ShareButton.test.tsx
git commit -m "feat: ShareButton 컴포넌트 추가 (내부망/Tailscale 공유 링크 팝오버)"
```

---

## Task 5: 페이지 뷰에 통합

**Files:**
- Modify: `dashboard/src/components/InlineMarkdownEditor.tsx:27-33` (import), `:399-410` (view 모드 액션 줄)

- [ ] **Step 1: import 추가**

`dashboard/src/components/InlineMarkdownEditor.tsx` 27~33행 import 블록에 한 줄 추가:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import MDEditor from "@uiw/react-md-editor";
import { useNavigate } from "react-router-dom";
import { deletePage, updatePage } from "../lib/api";
import { preprocessWikilinks } from "../lib/wikilink";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import { ShareButton } from "./ShareButton";
```

- [ ] **Step 2: view 모드 액션 줄 맨 앞에 배치**

399행 `{mode === "view" ? (` 다음 줄(현재 `<>` 다음, `<Button` 편집 버튼 앞)에 삽입:

```tsx
        {mode === "view" ? (
          <>
            <ShareButton vault={vault} slug={slug} />
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => setMode("edit")}
              title="편집 (Cmd+E)"
              aria-label="편집"
              style={{ minWidth: 36, padding: "0 8px" }}
            >
              <Icon.Edit />
            </Button>
```

(이후 삭제 버튼 등 나머지 코드는 그대로 유지)

- [ ] **Step 3: 프론트엔드 전체 테스트 회귀 확인**

Run: `cd dashboard && npx vitest run`
Expected: 기존 실패 0건 유지, 새 `ShareButton.test.tsx` 포함 전체 통과

- [ ] **Step 4: 타입체크**

Run: `cd dashboard && npx tsc -b --noEmit`
Expected: 에러 없음

- [ ] **Step 5: 커밋**

```bash
cd "/Users/ksdy234/Desktop/Dev/Project/Raven"
git add dashboard/src/components/InlineMarkdownEditor.tsx
git commit -m "feat: 페이지 뷰 툴바에 공유하기 버튼 통합"
```

---

## Task 6: 실제 대시보드에서 수동 검증

**Files:** 없음 (검증만)

- [ ] **Step 1: 개발 서버 기동**

Run: `cd "/Users/ksdy234/Desktop/Dev/Project/Raven" && make dev` (또는 `Makefile`에 정의된 로컬 실행 타겟 — 없으면 `scripts/.venv/bin/python -m raven.api --host 0.0.0.0` 백엔드 + `cd dashboard && npm run dev` 프론트를 각각 기동)

- [ ] **Step 2: 브라우저로 페이지 뷰 접속 후 공유 버튼 확인**

- 아무 vault의 페이지 하나를 열어 `[🔗] [✏] [🗑]` 순서로 버튼이 보이는지 확인
- 🔗 클릭 → 팝오버가 열리고 내부망/Tailscale 링크(또는 "감지 안 됨" 문구)가 보이는지 확인
- 복사 버튼 클릭 → "✅ 복사됨!" 표시 및 실제 클립보드에 URL이 들어갔는지 확인 (붙여넣기로 검증)
- 팝오버 바깥 클릭 → 닫히는지 확인

- [ ] **Step 3: (내부망 IP가 감지됐다면) 같은 네트워크의 다른 기기 브라우저에서 복사한 링크를 열어 페이지가 그대로 뜨는지 확인**

- [ ] **Step 4: 결과를 사용자에게 보고**

수동 검증 결과(정상 동작 여부, 스크린샷 필요 시 캡처)를 사용자에게 전달한다. 이 태스크는 코드 변경이 없으므로 커밋하지 않는다.

---

## Self-Review 체크리스트 (계획 작성자용, 완료됨)

- **스펙 커버리지**: 백엔드 LAN 감지(Task 1) / system_info 확장(Task 2) / 프론트 타입(Task 3) / ShareButton 컴포넌트(Task 4) / 통합(Task 5) / 수동 검증(Task 6) — 스펙의 모든 섹션이 태스크로 매핑됨. QR/만료/접근제한은 스펙에서 명시적으로 범위 밖.
- **플레이스홀더 스캔**: "TBD"/"구현 예정" 등 없음. 모든 스텝에 실제 코드 포함.
- **타입/이름 일관성**: `SystemInfo.lan_ip`/`lan_api`(Task 2~4), `ShareButton({ vault, slug })`(Task 4~5), `handleCopy(url, key)` 시그니처가 Task 4 전체에서 동일하게 사용됨.
