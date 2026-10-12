/**
 * Issue #16: what the API's real bind address means for who can reach it.
 * `bind_host` comes from `GET /api/system/info` (the address the Core actually
 * listens on). A specific address is *not* loopback-only: nothing listens on
 * 127.0.0.1 then, and a request to that address is not a loopback client even
 * from this PC, so the token gate asks for a token.
 */
export type BindExposure = {
  kind: "loopback" | "all" | "address";
  host: string;
  label: string;
  detail: string;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

export function describeBindExposure(bindHost?: string | null): BindExposure {
  const host = (bindHost ?? "").trim() || "127.0.0.1";
  if (LOOPBACK.has(host)) {
    return { kind: "loopback", host, label: "loopback 전용", detail: "이 PC에서만 접속할 수 있습니다" };
  }
  if (WILDCARD.has(host)) {
    return {
      kind: "all",
      host,
      label: "모든 네트워크 인터페이스",
      detail: "같은 PC만 토큰 없이 · LAN·tailnet 등 그 외 출처는 토큰 필요",
    };
  }
  return {
    kind: "address",
    host,
    label: `${host}에서만 수신`,
    detail: "loopback은 수신하지 않음 · 이 주소로 오는 요청은 같은 PC여도 토큰 필요",
  };
}
