import { useAppUpdater } from "../lib/useAppUpdater";
import { UpdatePanel } from "./UpdatePanel";

// v0.7.176+: 데스크톱 앱 자동 업데이트 체크 (tauri-plugin-updater).
// 브라우저/Docker 모드에서는 __TAURI_INTERNALS__가 없어 아무 것도 하지 않는다.
//
// v0.7.183+: 진행 상황 시각화를 UpdatePanel로 이관. 마운트 시 조용히 확인하고
// 새 버전이 있을 때만 우하단 토스트를 띄운다. "지금 업데이트"를 누르면 같은
// 자리에서 다운로드 진행률 → 설치 → 재시작 단계가 이어서 보인다.
export function UpdateChecker() {
  const updater = useAppUpdater({ autoCheck: true });

  // 확인 중 / 최신 / 미확인 상태에서는 사용자를 방해하지 않는다.
  const visible =
    updater.phase === "available" ||
    updater.phase === "downloading" ||
    updater.phase === "installing" ||
    updater.phase === "relaunching" ||
    (updater.phase === "error" && !!updater.version);

  if (!updater.desktop || !visible) return null;

  return (
    <div className="update-toast">
      <UpdatePanel
        state={updater}
        onDismiss={updater.busy ? undefined : updater.dismiss}
      />
    </div>
  );
}
