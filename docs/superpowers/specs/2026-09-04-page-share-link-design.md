# 페이지별 공유하기 버튼 — 설계

- **작성일**: 2026-09-04
- **범위**: 대시보드에서 페이지(글)를 볼 때, 내부망 IP 또는 Tailscale IP 기반 링크를 만들어 복사할 수 있는 "공유하기" 버튼

## 배경

Raven 백엔드는 이미 단일 포트로 API와 대시보드 SPA를 함께 서빙하고(`raven/api/server.py` — `/assets` StaticFiles 마운트), `0.0.0.0` 바인딩과 Tailscale IP 자동 감지(`get_tailscale_ip()`, `raven/api/main.py`)를 지원한다. CORS도 사설망(`192.168.x.x`, `10.x.x.x`, `172.16-31.x.x`)과 Tailscale(`100.64.0.0/10`) 대역을 이미 허용한다(`server.py`의 `_cors_origin_regex`).

`/api/system/info` 엔드포인트는 현재 `tailscale_ip`/`tailscale_api`/`local_api`/`bind_host`/`port`를 반환하지만, **내부망(LAN) IP는 감지하지 않는다.** 이 설계는 (1) LAN IP 감지를 추가하고, (2) 페이지 뷰에 공유 버튼을 붙여 두 종류의 딥링크(내부망/Tailscale)를 만들어 복사하는 기능을 추가한다.

공유되는 링크는 `http://<ip>:<port>/page/<vault>/<slug>` 형태이며, 받는 사람은 Raven 앱 없이 일반 브라우저로 열어도 그 페이지가 바로 뜬다 (SPA가 같은 포트에서 서빙되고, `dashboard/src/lib/api-base.ts`의 fetch 래퍼는 `localStorage`에 다른 호스트가 지정돼 있지 않으면 same-origin으로 API를 호출하기 때문).

## 백엔드 변경

### `raven/api/main.py`

`get_tailscale_ip()` 바로 아래에 `get_lan_ip()`를 추가한다.

```python
def get_lan_ip() -> str | None:
    """Detect this machine's LAN IP (192.168/10/172.16-31) on local network interfaces."""
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

- Tailscale 대역(`100.64.0.0/10`)은 `_is_lan()`에 해당하지 않으므로 자연스럽게 분리된다.
- `get_tailscale_ip()`와 같은 방식(UDP connect + gethostbyname_ex fallback)을 그대로 따른다 — 기존 코드 스타일 일치.

### `raven/api/server.py` — `/api/system/info`

`get_tailscale_ip` import 옆에 `get_lan_ip`도 import하고, 응답에 필드를 추가한다.

```python
from raven.api.main import get_tailscale_ip, get_lan_ip
ts_ip = get_tailscale_ip()
lan_ip = get_lan_ip()
...
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

기존 필드는 순서/이름 그대로 유지하고 `lan_ip`/`lan_api` 두 필드만 추가한다 (하위 호환).

## 프론트엔드 변경

### `dashboard/src/lib/api.ts`

`SystemInfo` 인터페이스에 필드 추가:

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

`fetchSystemInfo()`는 수정 없음 (그대로 JSON 응답 캐스팅).

### `dashboard/src/components/ShareButton.tsx` (신규)

Props: `{ vault: string; slug: string }`.

- 🔗 아이콘 버튼. 스타일은 `InlineMarkdownEditor.tsx`의 `Icon.Edit`/`Icon.Trash`와 동일한 인라인 SVG + `<Button variant="ghost" size="sm">` 패턴을 따른다.
- 클릭 시:
  1. 버튼 토글 상태(`open`)를 켜고, `fetchSystemInfo()`를 호출해 `sysInfo` state에 저장 (버튼 클릭마다 새로 조회 — IP가 바뀌었을 수 있으므로 캐시하지 않음).
  2. 버튼 바로 아래 `position: absolute` 팝오버를 오픈 (버튼을 감싸는 `position: relative` 컨테이너 기준).
- 팝오버 내용:
  - 로딩 중: "시스템 정보 조회 중…"
  - `bound_host === "127.0.0.1"`일 때 상단에 경고: "⚠️ 서버가 로컬 전용(127.0.0.1)으로 실행 중입니다. 다른 기기에서 열려면 서버를 0.0.0.0으로 바인딩해야 합니다."
  - **내부망 링크** 행: `sysInfo.lan_api`가 있으면 `${lan_api}/page/${vault}/${slug}`를 monospace 텍스트로 보여주고 옆에 복사 버튼. 없으면 회색 텍스트 "내부망 IP 감지 안 됨" + 복사 버튼 비활성화.
  - **Tailscale 링크** 행: 동일 패턴, `sysInfo.tailscale_api` 사용.
  - 복사는 `navigator.clipboard.writeText(url)` 후 해당 행에 "✅ 복사됨!" 2초 표시 — `VaultManage.tsx`의 `handleCopy`/`copiedKey` 패턴을 그대로 재사용(작은 로컬 state로 이 컴포넌트 안에 복제, 공용 훅으로 뽑아내지 않음 — 사용처가 2곳뿐이라 추상화는 YAGNI).
- 팝오버 바깥 클릭 시 닫힘 (`useEffect` + `mousedown` 리스너, 컴포넌트 루트에 `ref`).
- `slug`에 이미 `/`가 포함된 경우(하위 폴더 문서)도 그대로 URL에 이어붙인다 — 별도 인코딩 불필요 (기존 라우팅에서도 동일하게 처리 중).

### `dashboard/src/components/InlineMarkdownEditor.tsx`

view 모드 액션 줄(현재 `[✏ 편집] [🗑 삭제]` 순서, line ~397 부근)의 맨 앞에 `<ShareButton vault={vault} slug={slug} />`를 추가한다. 최종 순서: `[🔗 공유] [✏ 편집] [🗑 삭제]`.

edit 모드에는 추가하지 않는다 (공유는 view 액션).

## 에러/엣지 케이스

| 상황 | 동작 |
|---|---|
| LAN IP 감지 실패 (네트워크 미연결 등) | 해당 행 비활성 + "감지 안 됨" 문구 |
| Tailscale 미설치/미연결 | 동일하게 해당 행만 비활성 (기존 `tailscale_ip: null` 그대로 활용) |
| `/api/system/info` 호출 실패 (네트워크 오류) | 팝오버에 "시스템 정보를 불러올 수 없습니다" + 재시도 없음 (버튼 다시 클릭하면 재조회) |
| `bound_host`가 `127.0.0.1` | 두 링크 모두 만들어지긴 하지만(로컬 개발 중에도 LAN IP 자체는 감지될 수 있음) 상단 경고로 "실제로는 안 열릴 수 있음"을 고지 |
| slug에 한글/공백 등 URL 인코딩 필요한 문자 | 기존 라우팅과 동일하게 처리 — 별도 인코딩 로직 추가하지 않음 (범위 밖) |

## 테스트 계획

- **백엔드**: `tests/`에 `get_lan_ip()`용 유닛 테스트 추가 — `socket.socket`을 몽키패치해 `getsockname()`이 `192.168.1.5`를 반환하면 그 값을, `100.64.0.1`(Tailscale 대역)을 반환하면 `None`을 반환하는지 확인.
- **프론트**: `dashboard/tests/ShareButton.test.tsx` 신규 —
  - 아이콘 클릭 → 팝오버 오픈 확인
  - `fetchSystemInfo`를 mock해 `lan_api`/`tailscale_api`가 있을 때 두 링크 텍스트가 렌더되는지 확인
  - 하나가 `null`일 때 해당 행이 비활성 상태로 렌더되는지 확인
  - 복사 버튼 클릭 시 `navigator.clipboard.writeText`가 올바른 URL로 호출되는지 확인
  - 바깥 클릭 시 팝오버가 닫히는지 확인

## 범위 밖 (Out of scope)

- QR 코드 생성, 만료 링크, 접근 제한(비밀번호/토큰) — 요청되지 않음, YAGNI.
- `EditButton.tsx`/`DeleteButton.tsx` (미사용 legacy 컴포넌트) 정리 — 이번 작업과 무관, 언급만 하고 손대지 않음.
- 페이지 뷰 외 다른 곳(검색 결과, Archive 목록 등)에 공유 버튼 추가 — 요청 범위는 페이지 뷰 하나.
