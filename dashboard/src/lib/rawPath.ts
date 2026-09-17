// rawPath — raw/ "새 파일" 입력 검증 (v0.7.181).
//
// 사용자 원칙 (§13.1): "재사용 컴포넌트 우선". Sidebar의 NewRawFileButton과
// RawPanel의 handleNewFile이 같은 경로 계산을 복사해 쓰면서 검증이 둘 다
// 없었다. 여기로 모아 한 곳에서 막는다.
//
// 가장 위험한 케이스는 overwrite다. writeRaw(vault, rel, "") 는 백엔드에서
// 기존 파일을 빈 내용으로 덮어쓴다 (server.py write_raw — "기존 파일 있으면
// overwrite"는 raw/ 편집의 의도된 계약). 그래서 "새 파일 만들기" UI에서
// 기존 파일명을 입력하면 그 파일 내용이 조용히 날아갔다. create-only 의미는
// 이 UI 쪽에만 있으므로 가드도 여기가 맞는 층이다.
//
// 나머지 규칙('..', ':', 절대경로, '~')은 백엔드 _safe_raw_path_or_400의
// 거부 사유를 미러링한 것 — 400 영문 detail 대신 한국어로 먼저 알려준다.
import type { RawItem } from "./api";

const RAW_ROOT = "raw";

export interface NewRawFileResult {
  /** writeRaw에 넘길 raw/ 기준 상대경로. error가 있으면 항상 null. */
  rel: string | null;
  /** 사용자에게 보여줄 한국어 사유. 통과면 null. */
  error: string | null;
}

export function resolveNewRawFile(args: {
  name: string;
  dir: string;
  items: RawItem[];
}): NewRawFileResult {
  const name = args.name.trim();
  const dir = args.dir.trim();

  if (!name) return { rel: null, error: "파일명을 입력해 주세요." };
  if (name.includes("/")) {
    return {
      rel: null,
      error: "파일명에 '/' 는 쓸 수 없습니다. 위치는 부모 디렉토리에 지정해 주세요.",
    };
  }
  if (name === ".") return { rel: null, error: "쓸 수 없는 파일명입니다." };

  for (const part of [name, dir]) {
    if (part.startsWith("/") || part.startsWith("~")) {
      return { rel: null, error: "경로는 raw/ 기준 상대경로여야 합니다." };
    }
    if (part.includes(":")) return { rel: null, error: "경로에 ':' 는 쓸 수 없습니다." };
    if (part.split("/").some((seg) => seg === "..")) {
      return { rel: null, error: "경로에 '..' 는 쓸 수 없습니다." };
    }
  }

  // 부모 디렉토리 정규화 — raw/ 접두는 생략 가능(이 패널은 전부 raw/ 안이다).
  const segments = dir
    .split("/")
    .map((seg) => seg.trim())
    .filter((seg) => seg !== "" && seg !== ".");
  if (segments[0] === RAW_ROOT) segments.shift();
  const parent = segments.join("/");
  const rel = parent ? `${parent}/${name}` : name;

  const clash = args.items.find((item) => item.path === `${RAW_ROOT}/${rel}`);
  if (clash) {
    return clash.type === "dir"
      ? { rel: null, error: "같은 이름의 디렉토리가 있습니다. 다른 이름을 써 주세요." }
      : {
          rel: null,
          error: "이미 있는 파일입니다. 다른 이름을 쓰거나 그 파일을 열어 편집해 주세요.",
        };
  }

  return { rel, error: null };
}
