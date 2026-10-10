// Issue #1 A-5 — 미등록 경로 안내.
//
// catch-all이 없으면 <Routes>가 아무것도 그리지 않아 #root가 비고, 데스크톱 셸의 blank 복구가
// 그것을 고장으로 보고 reload 3회 뒤 "앱을 다시 실행" 차단 안내로 끝난다. Layout 안에서
// 경로가 없다는 것과 홈으로 가는 길을 보여 준다.
import { useLocation, useNavigate } from "react-router-dom";
import { EmptyState } from "../components/ui/EmptyState";
import { Button } from "../components/ui/Button";
import { EmptyIcon } from "../lib/emptyIcons";

function displayPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export function NotFoundPage() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<EmptyIcon.Search />}
      title="페이지를 찾을 수 없습니다"
      description={`'${displayPath(pathname)}' 경로에 해당하는 화면이 없습니다. 링크가 잘못됐거나 주소가 바뀌었을 수 있습니다.`}
      action={
        <Button type="button" variant="primary" size="sm" onClick={() => navigate("/")}>
          홈으로 가기
        </Button>
      }
    />
  );
}
