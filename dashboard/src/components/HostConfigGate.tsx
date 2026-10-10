// PR #35 review (Issue #32) — 원격 호스트 설정이 깨졌을 때 앱 대신 설정 오류를 보여 준다.
//
// 원격 호스트를 골라 둔 상태에서 호스트 목록이 없거나 손상됐거나, 선택한 호스트가 없거나 주소가
// 잘못됐으면 api-base가 이 탭의 /api 요청을 모두 거절한다(로컬 Core로 조용히 보내지 않는다).
// 여기서는 앱 화면(요청을 보내는 Layout·라우트)을 그리지 않고 이유를 알린다.
// 로컬로 바꾸는 것은 사용자가 버튼을 눌렀을 때만 — 자동 전환하지 않는다.
import type { ReactNode } from "react";
import { getTabHostError } from "../lib/api-base";
import { setActiveHostId } from "../lib/api";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";
import { EmptyIcon } from "../lib/emptyIcons";

export function HostConfigGate({
  children,
  reload = () => window.location.assign("/"),
}: {
  children: ReactNode;
  reload?: () => void;
}) {
  const error = getTabHostError();
  if (!error) return <>{children}</>;
  return (
    // Layout(테마 적용)을 그리지 않으므로 화면 전체를 canvas로 채운다 — 부트 화면 배경과 섞이지 않게.
    <div style={{ minHeight: "100vh", background: "var(--color-canvas)" }}>
      <div role="alert" style={{ maxWidth: 640, margin: "0 auto", padding: "64px 24px" }}>
        <EmptyState
          icon={<EmptyIcon.AlertTriangle />}
          title="원격 호스트 설정을 읽을 수 없습니다"
          description={`${error} 잘못된 곳에 저장되지 않도록 이 탭은 어떤 요청도 보내지 않습니다. 다른 탭에서 호스트 설정을 고쳤다면 이 탭을 새로고침하고, 아니면 로컬로 전환한 뒤 호스트를 다시 추가하세요.`}
          action={
            <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
              <Button
                variant="primary"
                onClick={() => {
                  setActiveHostId("local");
                  reload();
                }}
              >
                로컬로 전환
              </Button>
              <Button variant="secondary" onClick={reload}>
                새로고침
              </Button>
            </div>
          }
        />
      </div>
    </div>
  );
}
