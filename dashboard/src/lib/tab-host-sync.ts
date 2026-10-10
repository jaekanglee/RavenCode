// Issue #32 — 다른 탭이 활성 호스트를 바꾸면 이 탭도 같은 탭 전환(HostPicker)처럼 처리한다:
// 캐시를 비우고 "/"로 전체 재로드. 재로드 전이나 재로드가 막힌 동안(편집 중 beforeunload 취소)에도
// 이 탭의 요청은 api-base가 로드 때 고정한 호스트로만 가므로, 보이는 화면과 요청 대상이 어긋나지 않는다.
import { watchTabHostChange } from "./api-base";
import { invalidateCache } from "./api";

export function installTabHostSync(navigate: (to: string) => void = (to) => window.location.assign(to)): () => void {
  let fired = false;
  return watchTabHostChange(() => {
    invalidateCache();
    if (fired) return;
    fired = true;
    navigate("/");
  });
}
