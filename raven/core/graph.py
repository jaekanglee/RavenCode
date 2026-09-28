"""raven.core.graph — deterministic graph layout algorithms.

Relocated from `raven/api/server.py` (v0.7.68, 평가 B#3) — these are pure
functions (no FastAPI/HTTP dependency) that computed the `/api/vaults/{name}/graph`
node positions inline in the HTTP handler file. `server.py` now imports them.
"""
from __future__ import annotations

import hashlib
from collections import OrderedDict
from pathlib import Path
from typing import Any


GRAPH_POSITIONS_FILENAME = ".graph_positions.json"


def barnes_hut_theta(avg_degree: float) -> float:
    """그래프 밀도에 따라 Barnes-Hut 근사 theta를 결정한다.

    밀도가 높을수록 (edge가 많아 attraction이 강할수록) 지나치게 거친 근사는
    군집 경계를 뭉개기 쉬우므로 theta를 낮춘다. sparse graph는 0.9 유지.
    """
    if avg_degree >= 10.0:
        return 0.82
    if avg_degree >= 6.0:
        return 0.86
    return 0.90


def should_use_barnes_hut(node_count: int, avg_degree: float) -> bool:
    """노드 수와 밀도를 함께 보고 Barnes-Hut 전환 여부를 결정한다.

    v0.7.127은 `n >= 180` 고정이었지만, 실제 PKM 그래프는 all-vault dense map에서
    더 작은 n에도 edge 수가 많아 O(n²) cost가 먼저 체감된다. 반대로 sparse graph는
    180 근처에서도 exact pairwise가 충분히 빠르다.
    """
    if node_count >= 180:
        return True
    if node_count >= 140 and avg_degree >= 6.0:
        return True
    if node_count >= 110 and avg_degree >= 10.0:
        return True
    return False


def load_user_positions(vault_root: Path | str) -> dict[str, tuple[float, float]]:
    """vault 루트의 `.graph_positions.json`에서 사용자 지정 좌표를 읽는다.

    v0.7.126+: dashboard GraphCanvas의 노드 드래그 위치를 영구 저장하기 위한
    sidecar. 파일이 없거나 손상되면 빈 dict 반환 (forceatlas 결과 그대로 사용).

    결정론: 같은 파일 내용이면 항상 같은 dict. JSON 스키마는 ``{"positions":
    {"<slug>": {"x": float, "y": float}}}``. slug 외 키는 무시.
    """
    import json

    p = Path(vault_root) / GRAPH_POSITIONS_FILENAME
    if not p.exists():
        return {}
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}
    positions = raw.get("positions") if isinstance(raw, dict) else None
    if not isinstance(positions, dict):
        return {}
    out: dict[str, tuple[float, float]] = {}
    for slug, xy in positions.items():
        if not isinstance(slug, str) or not isinstance(xy, dict):
            continue
        raw_x: object = xy.get("x")  # type: ignore[arg-type]
        raw_y: object = xy.get("y")  # type: ignore[arg-type]
        if not isinstance(raw_x, (int, float)) or not isinstance(raw_y, (int, float)):
            continue
        out[slug] = (float(raw_x), float(raw_y))
    return out


def save_user_positions(
    vault_root: Path | str,
    positions: dict[str, tuple[float, float]],
) -> dict[str, Any]:
    """`.graph_positions.json`에 사용자 좌표를 저장.

    결정론: 입력 dict 순서대로 JSON 직렬화 (Python 3.7+ dict는 insertion order
    보존). v.root 자체에는 절대 손대지 않고 sidecar만 갱신.
    """
    import json
    import time

    p = Path(vault_root) / GRAPH_POSITIONS_FILENAME
    payload = {
        "schema": 1,
        "updated_at": time.time(),
        "positions": {slug: {"x": float(x), "y": float(y)} for slug, (x, y) in positions.items()},
    }
    p.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return {"ok": True, "count": len(payload["positions"]), "path": str(p)}


def normalize_layout(
    ids: list[str],
    pos_x: list[float],
    pos_y: list[float],
    target: float = 500.0,
) -> dict[str, tuple[float, float]]:
    """그래프 좌표를 center=0, scale=±target 으로 정규화한다."""
    n = len(ids)
    if n == 0:
        return {}
    if n == 1:
        return {ids[0]: (0.0, 0.0)}
    min_x, max_x = min(pos_x), max(pos_x)
    min_y, max_y = min(pos_y), max(pos_y)
    cx = (min_x + max_x) / 2.0
    cy = (min_y + max_y) / 2.0
    span_x = max(abs(min_x - cx), abs(max_x - cx))
    span_y = max(abs(min_y - cy), abs(max_y - cy))
    span = max(span_x, span_y) or 1.0
    return {
        ids[i]: (
            round((pos_x[i] - cx) / span * target, 1),
            round((pos_y[i] - cy) / span * target, 1),
        )
        for i in range(n)
    }


def stable_unit(slug: str, salt: str = "") -> float:
    """slug 기반 deterministic jitter: [0, 1)."""
    import hashlib

    h = hashlib.sha256(f"{salt}:{slug}".encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big") / float(1 << 64)


def louvain_communities(
    ids: list[str],
    edges: list[tuple[str, str]],
    weights: list[float] | None = None,
    seed: int = 0,
) -> dict[str, int]:
    """Louvain-style community detection (v0.6.15+).

    Delegates calculation to raven.core.analytics to avoid duplication.
    """
    from .analytics import louvain_communities as _louvain
    return _louvain(ids, edges, weights)



def constellation_layout(
    ids: list[str],
    edges: list[tuple[str, str]],
    weights: dict[str, int] | None = None,
) -> dict[str, tuple[float, float]]:
    """Obsidian식 별자리/신경망 감각의 deterministic graph layout.

    v1 기준:
    - degree/weight 높은 hub는 component 중심부에 배치
    - hub의 1-hop 이웃은 hub 주변 궤도, leaf/low-degree는 바깥 ring에 배치
    - connected components는 큰 원 둘레에 분리
    - slug hash 기반 각도 jitter로 입력이 같으면 항상 같은 좌표
    - 최종 좌표는 기존 graph contract처럼 center=0, scale=±500
    """
    import math

    # v0.7.127+: large graph에서 O(n²) repulsion이 병목이므로 Barnes-Hut quadtree
    # 근사를 자동 사용한다. 작은 그래프(<180 nodes)는 exact pairwise가 더 단순하고
    # 안정적이므로 유지. self-force approximation 방지를 위해 현재 노드를 포함하는
    # cell은 항상 더 내려가고, 충분히 멀어진 타 cell만 size/d < theta 조건으로 근사.
    def barnes_hut_repulsion(
        xs: list[float],
        ys: list[float],
        masses: list[float],
        strength: float,
        theta: float = 0.9,
    ) -> tuple[list[float], list[float]]:
        n_local = len(xs)
        out_dx = [0.0] * n_local
        out_dy = [0.0] * n_local
        if n_local <= 1:
            return out_dx, out_dy

        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        size = max(max_x - min_x, max_y - min_y, 1.0) + 1e-6

        def build(indices: list[int], x0: float, y0: float, cell_size: float) -> dict[str, Any]:
            total_mass = sum(masses[i] for i in indices)
            com_x = sum(xs[i] * masses[i] for i in indices) / max(total_mass, 1e-9)
            com_y = sum(ys[i] * masses[i] for i in indices) / max(total_mass, 1e-9)
            node: dict[str, Any] = {
                "x0": x0,
                "y0": y0,
                "size": cell_size,
                "mass": total_mass,
                "com_x": com_x,
                "com_y": com_y,
                "indices": indices,
            }
            if len(indices) <= 4 or cell_size <= 1.0:
                node["leaf"] = True
                return node

            half = cell_size / 2.0
            mid_x = x0 + half
            mid_y = y0 + half
            buckets: list[list[int]] = [[], [], [], []]
            for i in indices:
                east = 1 if xs[i] >= mid_x else 0
                south = 2 if ys[i] >= mid_y else 0
                buckets[east + south].append(i)
            if any(len(bucket) == len(indices) for bucket in buckets):
                node["leaf"] = True
                return node

            children: list[dict[str, Any]] = []
            for q, bucket in enumerate(buckets):
                if not bucket:
                    continue
                child_x0 = x0 + (half if (q & 1) else 0.0)
                child_y0 = y0 + (half if (q & 2) else 0.0)
                children.append(build(bucket, child_x0, child_y0, half))
            node["children"] = children
            return node

        root = build(list(range(n_local)), min_x - 1e-6, min_y - 1e-6, size)

        def apply(i: int, node: dict[str, Any]) -> None:
            node_mass = float(node.get("mass", 0.0) or 0.0)
            if node_mass <= 0.0:
                return

            x0 = float(node["x0"])
            y0 = float(node["y0"])
            cell_size = float(node["size"])
            contains_i = x0 <= xs[i] <= x0 + cell_size and y0 <= ys[i] <= y0 + cell_size

            if node.get("leaf"):
                for j in node.get("indices", []):
                    if j == i:
                        continue
                    vx = xs[i] - xs[j]
                    vy = ys[i] - ys[j]
                    d2 = vx * vx + vy * vy + 0.01
                    d = math.sqrt(d2)
                    f = strength * masses[i] * masses[j] / d2
                    fx = (vx / d) * f
                    fy = (vy / d) * f
                    min_dist = 20.0
                    if d < min_dist:
                        overlap = min_dist - d
                        col_f = (overlap * overlap) * 12.0
                        fx += (vx / d) * col_f
                        fy += (vy / d) * col_f
                    out_dx[i] += fx
                    out_dy[i] += fy
                return

            vx = xs[i] - float(node["com_x"])
            vy = ys[i] - float(node["com_y"])
            d2 = vx * vx + vy * vy + 0.01
            d = math.sqrt(d2)
            if (not contains_i) and (cell_size / d) < theta:
                f = strength * masses[i] * node_mass / d2
                out_dx[i] += (vx / d) * f
                out_dy[i] += (vy / d) * f
                return

            for child in node.get("children", []):
                apply(i, child)

        for i in range(n_local):
            apply(i, root)
        return out_dx, out_dy

    n = len(ids)
    if n == 0:
        return {}
    if n == 1:
        return {ids[0]: (0.0, 0.0)}

    weights = weights or {}
    idx = {s: i for i, s in enumerate(ids)}
    adj: dict[str, set[str]] = {s: set() for s in ids}
    for s, t in edges:
        if s in idx and t in idx and s != t:
            adj[s].add(t)
            adj[t].add(s)

    # connected components — 큰 component를 먼저 배치해 전체 별자리의 주 구조를 잡는다.
    remaining = set(ids)
    components: list[list[str]] = []
    while remaining:
        start = min(remaining)
        stack = [start]
        remaining.remove(start)
        comp: list[str] = []
        while stack:
            cur = stack.pop()
            comp.append(cur)
            for nb in sorted(adj[cur]):
                if nb in remaining:
                    remaining.remove(nb)
                    stack.append(nb)
        components.append(comp)

    def node_score(slug: str) -> tuple[int, int, float, str]:
        degree = len(adj[slug])
        weight = int(weights.get(slug, 0) or 0)
        # degree가 가장 중요하고, in-degree/weight가 hub tie-breaker 역할.
        return (degree * 10 + weight * 3, degree, stable_unit(slug, "hub"), slug)

    components.sort(key=lambda c: (-len(c), -max(node_score(s)[0] for s in c), min(c)))
    comp_count = len(components)
    global_pos: dict[str, tuple[float, float]] = {}

    for comp_i, comp in enumerate(components):
        comp_size = len(comp)
        hub = max(comp, key=node_score)

        # Component 중심: 단일/최대 component는 원점, 나머지는 큰 원 둘레에 deterministic 분리.
        if comp_count == 1:
            comp_cx = comp_cy = 0.0
        else:
            outer_r = 520.0 + 170.0 * math.sqrt(comp_count)
            if comp_i == 0 and comp_size > 1:
                comp_cx = comp_cy = 0.0
            else:
                angle = (2.0 * math.pi * (comp_i - 1) / max(comp_count - 1, 1))
                angle += (stable_unit(hub, "component") - 0.5) * 0.28
                comp_cx = math.cos(angle) * outer_r
                comp_cy = math.sin(angle) * outer_r

        if comp_size == 1:
            angle = 2.0 * math.pi * stable_unit(hub, "isolated")
            # 완전 고립 노드가 너무 멀리 이탈해 전체 레이아웃 정규화 스케일을 쪼그려트리지 않도록 반지름 조정
            r = 160.0 + 25.0 * math.sqrt(comp_i)
            global_pos[hub] = (comp_cx + math.cos(angle) * r, comp_cy + math.sin(angle) * r)
            continue

        # Hub 중심. weight가 높은 hub가 시각 중심을 잡고, 주변 node는 level ring에 배치.
        global_pos[hub] = (comp_cx, comp_cy)

        # BFS level: hub 주변 1-hop ring, 그 밖은 더 외곽 ring.
        levels: dict[str, int] = {hub: 0}
        queue = [hub]
        for cur in queue:
            for nb in sorted(adj[cur]):
                if nb in comp and nb not in levels:
                    levels[nb] = levels[cur] + 1
                    queue.append(nb)

        rings: dict[int, list[str]] = {}
        for slug in comp:
            if slug == hub:
                continue
            level = levels.get(slug, 2)
            degree = len(adj[slug])
            # leaf/low-degree는 같은 level에서도 한 단계 바깥으로 밀어 별자리 꼬리를 만든다.
            ring = level
            if degree <= 1:
                ring += 1
            rings.setdefault(ring, []).append(slug)

        base_angle = 2.0 * math.pi * stable_unit(hub, "base-angle")
        for ring, slugs in sorted(rings.items()):
            slugs.sort(key=lambda s: (stable_unit(s, f"ring-{ring}"), s))
            count = len(slugs)
            # 1-hop orbit은 촘촘히, leaf/outer ring은 넓게.
            radius = 85.0 + 80.0 * ring + 12.0 * math.sqrt(comp_size)
            for j, slug in enumerate(slugs):
                angle = base_angle + 2.0 * math.pi * j / max(count, 1)
                angle += (stable_unit(slug, "angle-jitter") - 0.5) * (0.45 / max(ring, 1))
                radial_jitter = (stable_unit(slug, "radius-jitter") - 0.5) * 36.0
                degree = len(adj[slug])
                if degree >= 3:
                    radial_jitter -= 45.0  # secondary hub는 안쪽으로
                elif degree <= 1:
                    radial_jitter += 55.0  # leaf는 바깥으로
                r = radius + radial_jitter
                global_pos[slug] = (comp_cx + math.cos(angle) * r, comp_cy + math.sin(angle) * r)

    pos_x = [global_pos.get(s, (0.0, 0.0))[0] for s in ids]
    pos_y = [global_pos.get(s, (0.0, 0.0))[1] for s in ids]
    return normalize_layout(ids, pos_x, pos_y)


def folder_group_for_slug(slug: str) -> tuple[str, str]:
    """slug 경로에서 4대 대분류 폴더 그룹명과 사용자 표시 라벨을 반환합니다.

    결과: (group_id, group_label)
    """
    parts = slug.split('/')
    if not parts or parts[0] == "":
        return "root", "루트 폴더 (root)"

    first = parts[0]
    # 슬래시가 없는 루트 레벨 파일 처리 (예: log, readme 등)
    if len(parts) == 1 and not first.endswith("/") and first not in ("_meta", "content", "raw"):
        return "root", "루트 폴더 (root)"

    if first == "_meta":
        return "_meta", "시스템 및 설정 (_meta)"
    if first == "content":
        return "content", "본문 지식 (content)"
    if first == "raw":
        return "raw", "참조 자료 (raw)"

    return first, first


def _forceatlas_layout_uncached(
    ids: list[str],
    edges: list[tuple[str, str]],
    weights: dict[str, int] | None = None,
    # v0.7.49+: iterations 기본값 320→400. community_hub 강화(repulsion↓)로
    # 수렴 시간이 더 필요해짐. deterministic & iterations 상한(500) 내.
    iterations: int = 400,
    communities: dict[str, int] | None = None,
    edge_weights: list[float] | None = None,
) -> dict[str, tuple[float, float]]:
    """ForceAtlas2 / LinLog hybrid v2 — PKM 문서 그래프 가독성 우선.

    v1 (0b71e5e) 대비 개선점 (v2):
      - attraction: log1p(d)·d → d (선형) — 같은 군집이 더 강하게 뭉친다.
      - per-node mass = 1 + degree + 0.6·sqrt(weight) — hub가 너무 커지지 않게 cap.
      - repulsion: mass-스케일 + 1/r (degenerate 막기 위해 +1 jitter) — 큰 hub 주변이 비좁지 않게.
      - per-component seed offset: connected component별로 ±R 떨어뜨려서 seed에서도
        군집 간 분리가 시작되게 한다. 그 후 force로 다듬는다.
      - iterations 220 → 320 (deterministic, 출력 안정).
      - output은 기존 graph contract: center=0, scale=±500.

    v0.7.6x+ (다른 layout 전부 제거하고 atlas 단일화하며 밀도 튠업):
      - mass의 degree cap 6→12: 촘촘한 실사용 vault(평균 degree 6.8)에서
        degree 8~17인 진짜 허브가 cap 6짜리와 동급 취급되어 이웃을 충분히
        못 밀어내던 문제 수정.
      - repulsion이 그래프 평균 degree에 비례해서 커짐 (1100 * (1+avg/20)) —
        성긴 그래프는 기존과 거의 동일, 촘촘한 그래프는 그만큼 더 벌어짐.
    결정론: random 없음. 입력과 시드가 같으면 같은 좌표.
    """
    import math

    # v0.7.127+: large graph에서 O(n²) repulsion이 병목이므로 Barnes-Hut quadtree
    # 근사를 자동 사용한다. 작은 그래프(<180 nodes)는 exact pairwise가 더 단순하고
    # 안정적이므로 유지. self-force approximation 방지를 위해 현재 노드를 포함하는
    # cell은 항상 더 내려가고, 충분히 멀어진 타 cell만 size/d < theta 조건으로 근사.
    def barnes_hut_repulsion(
        xs: list[float],
        ys: list[float],
        masses: list[float],
        strength: float,
        theta: float = 0.9,
    ) -> tuple[list[float], list[float]]:
        n_local = len(xs)
        out_dx = [0.0] * n_local
        out_dy = [0.0] * n_local
        if n_local <= 1:
            return out_dx, out_dy

        min_x, max_x = min(xs), max(xs)
        min_y, max_y = min(ys), max(ys)
        size = max(max_x - min_x, max_y - min_y, 1.0) + 1e-6

        def build(indices: list[int], x0: float, y0: float, cell_size: float) -> dict[str, Any]:
            total_mass = sum(masses[i] for i in indices)
            com_x = sum(xs[i] * masses[i] for i in indices) / max(total_mass, 1e-9)
            com_y = sum(ys[i] * masses[i] for i in indices) / max(total_mass, 1e-9)
            node: dict[str, Any] = {
                "x0": x0, "y0": y0, "size": cell_size, "mass": total_mass,
                "com_x": com_x, "com_y": com_y, "indices": indices,
            }
            if len(indices) <= 4 or cell_size <= 1.0:
                node["leaf"] = True
                return node

            half = cell_size / 2.0
            mid_x = x0 + half
            mid_y = y0 + half
            buckets: list[list[int]] = [[], [], [], []]
            for i in indices:
                east = 1 if xs[i] >= mid_x else 0
                south = 2 if ys[i] >= mid_y else 0
                buckets[east + south].append(i)
            if any(len(bucket) == len(indices) for bucket in buckets):
                node["leaf"] = True
                return node

            children: list[dict[str, Any]] = []
            for q, bucket in enumerate(buckets):
                if not bucket:
                    continue
                child_x0 = x0 + (half if (q & 1) else 0.0)
                child_y0 = y0 + (half if (q & 2) else 0.0)
                children.append(build(bucket, child_x0, child_y0, half))
            node["children"] = children
            return node

        root = build(list(range(n_local)), min_x - 1e-6, min_y - 1e-6, size)

        def apply(i: int, node: dict[str, Any]) -> None:
            node_mass = float(node.get("mass", 0.0) or 0.0)
            if node_mass <= 0.0:
                return
            x0 = float(node["x0"]); y0 = float(node["y0"]); cell_size = float(node["size"])
            contains_i = x0 <= xs[i] <= x0 + cell_size and y0 <= ys[i] <= y0 + cell_size

            if node.get("leaf"):
                for j in node.get("indices", []):
                    if j == i:
                        continue
                    vx = xs[i] - xs[j]; vy = ys[i] - ys[j]
                    d2 = vx * vx + vy * vy + 0.01
                    d = math.sqrt(d2)
                    f = strength * masses[i] * masses[j] / d2
                    fx = (vx / d) * f; fy = (vy / d) * f
                    min_dist = 20.0
                    if d < min_dist:
                        overlap = min_dist - d
                        col_f = (overlap * overlap) * 12.0
                        fx += (vx / d) * col_f; fy += (vy / d) * col_f
                    out_dx[i] += fx; out_dy[i] += fy
                return

            vx = xs[i] - float(node["com_x"]); vy = ys[i] - float(node["com_y"])
            d2 = vx * vx + vy * vy + 0.01
            d = math.sqrt(d2)
            if (not contains_i) and (cell_size / d) < theta:
                f = strength * masses[i] * node_mass / d2
                out_dx[i] += (vx / d) * f
                out_dy[i] += (vy / d) * f
                return

            for child in node.get("children", []):
                apply(i, child)

        for i in range(n_local):
            apply(i, root)
        return out_dx, out_dy

    n = len(ids)
    if n == 0:
        return {}
    if n == 1:
        return {ids[0]: (0.0, 0.0)}

    weights = weights or {}
    idx = {s: i for i, s in enumerate(ids)}
    valid_edges = [(s, t) for s, t in edges if s in idx and t in idx and s != t]

    # Seed: 기존 constellation 결과를 사용하되, 연결 컴포넌트별 중심을 멀리 떨어뜨려
    # force가 시작부터 군집을 분리할 수 있게 한다. → LinLog의 핵심.
    seed = constellation_layout(ids, valid_edges, weights=weights)
    pos_x = [seed.get(s, (0.0, 0.0))[0] for s in ids]
    pos_y = [seed.get(s, (0.0, 0.0))[1] for s in ids]

    # Connected components — 각 컴포넌트의 centroid를 0 주변에서 ring으로 배치.
    from collections import deque
    seen = [False] * n
    components: list[list[int]] = []
    for start in range(n):
        if seen[start]:
            continue
        seen[start] = True
        comp: list[int] = [start]
        dq = deque([start])
        while dq:
            u = dq.popleft()
            for s, t in valid_edges:
                su, tu = idx[s], idx[t]
                for v in (su, tu):
                    if v == u or seen[v]:
                        continue
                    seen[v] = True
                    comp.append(v)
                    dq.append(v)
        components.append(comp)
    if len(components) > 1:
        ring_r = 180.0 + 30.0 * (len(components) - 1)
        for k, comp in enumerate(components):
            ang = (2 * math.pi * k) / max(len(components), 1)
            cx = ring_r * math.cos(ang)
            cy = ring_r * math.sin(ang)
            for v in comp:
                pos_x[v] += cx
                pos_y[v] += cy

    degree = [0] * n
    for s, t in valid_edges:
        degree[idx[s]] += 1
        degree[idx[t]] += 1
    # 고립 노드(degree=0)는 척력을 극히 덜 받게 하여 중심부 중력으로 묶이게 mass를 0.3으로 억제
    # v0.7.6x+: degree cap 6→12. PKM 위키는 평균 degree가 6~7대까지 촘촘한 경우가
    # 흔한데(hub-control-room 실측 6.8), cap이 6이면 degree 8~17짜리 진짜 허브가
    # degree 6짜리와 똑같은 mass를 받아 이웃을 충분히 못 밀어냄 — 허브 주변만
    # 유독 빽빽해지는 원인이었다. cap을 올려서 진짜 허브가 이웃을 더 세게 밀어내게.
    mass = [
        0.3 if degree[i] == 0 else
        1.0 + min(degree[i], 12) * 0.55 + math.sqrt(max(int(weights.get(ids[i], 0) or 0), 0)) * 0.6
        for i in range(n)
    ]

    steps = max(40, min(iterations, 500))
    # v0.7.49+: 성운 군집화 강화. community_hub 0.10→0.25 (은하 핵 인력 2.5배),
    # repulsion 1400→1100 (척력 약화 → 더 조밀). iterations 320→400 (수렴 안정).
    # 결정론/normalize_layout contract 유지. frontend 무변경.
    # v0.7.6x+: repulsion을 그래프 밀도(평균 degree)에 비례해서 올림. 성긴
    # 그래프(평균 degree ≲2)는 기존 1100 근처를 유지하고, 촘촘한 그래프일수록
    # (attraction이 그만큼 많은 edge로 강하게 당기므로) 더 벌어지게 보정한다.
    avg_degree = (sum(degree) / n) if n else 0.0
    repulsion = 1100.0 * (1.0 + avg_degree / 20.0)
    use_barnes_hut = should_use_barnes_hut(n, avg_degree)
    bh_theta = barnes_hut_theta(avg_degree)
    attraction = 0.15
    gravity = 0.045
    # v0.7.6x+: 28→50. repulsion을 올린 것만으론 부족했다 — 실측(hub-control-room,
    # 36 nodes) 결과 max_step0=28 그대로면 iterations=500 예산 안에서 더 강해진
    # 힘이 충분히 수렴 못 해 오히려 튜닝 전보다 더 뭉쳐 보였다(회귀). max_step0을
    # 같이 올려야 같은 iterations 예산으로도 새 힘의 크기에 맞게 수렴한다.
    # (iterations 자체를 올리는 방향은 O(n²)이라 n=300에서 20s, n=600에서 82s로
    # 폭증해 기각 — 성능 예산은 그대로 두고 수렴 속도만 개선.)
    max_step0 = 50.0

    edge_indices = [(idx[s], idx[t]) for s, t in valid_edges]

    for it in range(steps):
        temp = max_step0 * (1.0 - (it / max(steps - 1, 1))) + 1.0
        dx = [0.0] * n
        dy = [0.0] * n

        # 각 커뮤니티의 Centroid 계산 (매 iteration 마다)
        comm_centroids: dict[int, list[float]] = {}
        if communities:
            for i in range(n):
                c = communities.get(ids[i], -1)
                if c >= 0:
                    data = comm_centroids.setdefault(c, [0.0, 0.0, 0.0])
                    data[0] += pos_x[i]
                    data[1] += pos_y[i]
                    data[2] += 1.0
            for c, data in comm_centroids.items():
                if data[2] > 0:
                    data[0] /= data[2]
                    data[1] /= data[2]

        # Repulsion (mass-scaled) & Collision (겹침 방지).
        # small/sparse graph = exact O(n²), large or dense graph = Barnes-Hut O(n log n) 근사.
        if use_barnes_hut:
            rep_dx, rep_dy = barnes_hut_repulsion(pos_x, pos_y, mass, repulsion, theta=bh_theta)
            for i in range(n):
                dx[i] += rep_dx[i]
                dy[i] += rep_dy[i]
        else:
            for i in range(n):
                for j in range(i + 1, n):
                    vx = pos_x[i] - pos_x[j]
                    vy = pos_y[i] - pos_y[j]
                    d2 = vx * vx + vy * vy + 0.01
                    d = math.sqrt(d2)

                    # 기본 ForceAtlas 척력
                    f = repulsion * mass[i] * mass[j] / d2
                    fx = (vx / d) * f
                    fy = (vy / d) * f

                    # Collision Guard: 옵시디언 감성을 위한 겹침 방지 탄성 (노드 최소 반경 약 20px 보장)
                    min_dist = 20.0
                    if d < min_dist:
                        overlap = min_dist - d
                        col_f = (overlap * overlap) * 12.0  # 탄성 강도
                        fx += (vx / d) * col_f
                        fy += (vy / d) * col_f

                    dx[i] += fx
                    dy[i] += fy
                    dx[j] -= fx
                    dy[j] -= fy

        # Linear attraction: 거리 비례 — 짧은 edge는 강하게, 긴 edge는 약하게.
        # LinLog와 다른 선택이지만 PKM 위키처럼 군집이 응집되어 있을 때 더 예쁘게 모임.
        for idx_edge, (i, j) in enumerate(edge_indices):
            vx = pos_x[i] - pos_x[j]
            vy = pos_y[i] - pos_y[j]
            d = math.sqrt(vx * vx + vy * vy) + 0.001
            edge_w = edge_weights[idx_edge] if edge_weights is not None and idx_edge < len(edge_weights) else 1.0
            f = attraction * d * edge_w
            fx = (vx / d) * f
            fy = (vy / d) * f
            dx[i] -= fx
            dy[i] -= fy
            dx[j] += fx
            dy[j] += fy

        # Gravity: center 방향으로 약한 인력 & 커뮤니티 중심 중력 (은하 핵 인력)
        for i in range(n):
            dx[i] -= pos_x[i] * gravity
            dy[i] -= pos_y[i] * gravity
            if communities:
                c = communities.get(ids[i], -1)
                if c >= 0 and c in comm_centroids:
                    cx, cy, _ = comm_centroids[c]
                    # v0.7.49+: 자신 소속 커뮤니티 중심(은하 핵)으로 인력 0.10→0.25.
                    # 같은 community 노드들이 더 강하게 centroid로 빨려들어
                    # "성운 군집" 효과가 뚜렷해진다.
                    dx[i] -= (pos_x[i] - cx) * 0.25
                    dy[i] -= (pos_y[i] - cy) * 0.25

        for i in range(n):
            disp = math.sqrt(dx[i] * dx[i] + dy[i] * dy[i])
            if disp <= 0.0001:
                continue
            scale = min(disp, temp) / disp
            pos_x[i] += dx[i] * scale
            pos_y[i] += dy[i] * scale

    return normalize_layout(ids, pos_x, pos_y)


# ─────────────── 레이아웃 메모이제이션 ───────────────
# forceatlas_layout은 결정적이다(random 없음) — 입력이 같으면 좌표도 같다. 본문만 고친
# 편집은 노드·링크·가중치가 그대로라, 문서 수정 직후 GET /graph가 같은 레이아웃을 매번
# 다시 계산했다(169문서 60회 ~0.3초). 입력 해시로 최근 몇 개를 기억한다.
_LAYOUT_CACHE_MAX = 8
_layout_cache: "OrderedDict[str, dict[str, tuple[float, float]]]" = OrderedDict()


def clear_layout_cache() -> None:
    _layout_cache.clear()


def _layout_cache_key(
    ids: list[str],
    edges: list[tuple[str, str]],
    weights: dict[str, int] | None,
    iterations: int,
    communities: dict[str, int] | None,
    edge_weights: list[float] | None,
) -> str:
    payload = repr((
        tuple(ids),
        tuple((str(a), str(b)) for a, b in edges),
        tuple(sorted((weights or {}).items())),
        int(iterations),
        tuple(sorted((communities or {}).items())),
        tuple(edge_weights) if edge_weights is not None else None,
    ))
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def forceatlas_layout(
    ids: list[str],
    edges: list[tuple[str, str]],
    weights: dict[str, int] | None = None,
    iterations: int = 400,
    communities: dict[str, int] | None = None,
    edge_weights: list[float] | None = None,
) -> dict[str, tuple[float, float]]:
    """_forceatlas_layout_uncached의 입력 해시 캐시. 결과는 복사본 — 호출자가 사용자
    저장 좌표를 덮어써도 캐시 원본은 바뀌지 않는다.

    입력을 정렬해 표준 순서로 만든 뒤 계산한다. 서버는 노드·링크를 DB 행 순서로 넘기는데
    증분 재빌드가 고친 페이지를 맨 뒤로 다시 넣어 순서가 바뀐다 — 순서에 기대면 본문만
    고쳐도 캐시가 빗나가고 좌표가 매번 조금씩 흔들렸다.
    """
    ids = sorted(ids)
    # 가중치가 링크와 1:1일 때만 같이 재배열한다 (길이가 다르면 짝이 깨지므로 순서 유지).
    if edge_weights is None or len(edge_weights) == len(edges):
        edge_order = sorted(range(len(edges)), key=lambda i: (str(edges[i][0]), str(edges[i][1])))
        edges = [edges[i] for i in edge_order]
        if edge_weights is not None:
            edge_weights = [edge_weights[i] for i in edge_order]
    key = _layout_cache_key(ids, edges, weights, iterations, communities, edge_weights)
    cached = _layout_cache.get(key)
    if cached is None:
        cached = _forceatlas_layout_uncached(
            ids,
            edges,
            weights=weights,
            iterations=iterations,
            communities=communities,
            edge_weights=edge_weights,
        )
        _layout_cache[key] = cached
        while len(_layout_cache) > _LAYOUT_CACHE_MAX:
            _layout_cache.popitem(last=False)
    else:
        _layout_cache.move_to_end(key)
    return dict(cached)
