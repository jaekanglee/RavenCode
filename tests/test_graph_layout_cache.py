"""ForceAtlas 레이아웃 메모이제이션 — 본문만 고친 편집은 그래프 입력이 같아 재계산이 필요 없다.

레이아웃은 결정적(입력이 같으면 좌표도 같음)이므로 입력 해시로 캐시해도 결과가 바뀌지
않는다. 문서 수정 직후 GET /graph의 ~0.3초가 이 재계산이었다.
"""
from __future__ import annotations

from raven.core import graph as graph_module


IDS = [f"n{i}" for i in range(12)]
EDGES = [(IDS[i], IDS[(i + 1) % 12]) for i in range(12)] + [("n0", "n6"), ("n3", "n9")]
WEIGHTS = {s: i % 3 for i, s in enumerate(IDS)}
COMMS = {s: (0 if i < 6 else 1) for i, s in enumerate(IDS)}


def _layout(**overrides):
    kwargs = dict(weights=WEIGHTS, iterations=30, communities=COMMS, edge_weights=[1.0] * len(EDGES))
    kwargs.update(overrides)
    return graph_module.forceatlas_layout(IDS, overrides.pop("edges", EDGES), **{k: v for k, v in kwargs.items() if k != "edges"})


def test_layout_is_deterministic_without_cache():
    """캐시의 전제: 같은 입력이면 같은 좌표 (random 없음)."""
    graph_module.clear_layout_cache()
    first = _layout()
    graph_module.clear_layout_cache()
    assert _layout() == first


def test_same_input_reuses_cached_layout(monkeypatch):
    graph_module.clear_layout_cache()
    calls = []
    real = graph_module._forceatlas_layout_uncached
    monkeypatch.setattr(graph_module, "_forceatlas_layout_uncached", lambda *a, **k: calls.append(1) or real(*a, **k))

    first = _layout()
    second = _layout()

    assert second == first
    assert len(calls) == 1


def test_caller_mutation_does_not_poison_cache():
    """서버는 받은 좌표 dict에 사용자 저장 좌표를 덮어쓴다 — 캐시 원본이 바뀌면 안 된다."""
    graph_module.clear_layout_cache()
    first = _layout()
    first["n0"] = (999.0, 999.0)
    assert _layout()["n0"] != (999.0, 999.0)


def test_changed_links_recompute(monkeypatch):
    graph_module.clear_layout_cache()
    calls = []
    real = graph_module._forceatlas_layout_uncached
    monkeypatch.setattr(graph_module, "_forceatlas_layout_uncached", lambda *a, **k: calls.append(1) or real(*a, **k))

    _layout()
    _layout(edges=EDGES + [("n1", "n7")])
    _layout(iterations=31)

    assert len(calls) == 3


def test_layout_does_not_depend_on_input_order(monkeypatch):
    """서버는 노드·링크를 DB 행 순서로 넘기는데, 증분 재빌드가 고친 페이지를 맨 뒤로 다시
    넣어 순서가 바뀐다. 순서에 따라 좌표가 달라지면 본문만 고쳐도 캐시가 빗나가고
    그래프 모양이 매번 조금씩 흔들린다 (실 vault에서 확인)."""
    graph_module.clear_layout_cache()
    calls = []
    real = graph_module._forceatlas_layout_uncached
    monkeypatch.setattr(graph_module, "_forceatlas_layout_uncached", lambda *a, **k: calls.append(1) or real(*a, **k))

    edge_weights = [1.0 + i / 10 for i in range(len(EDGES))]
    first = graph_module.forceatlas_layout(
        IDS, EDGES, weights=WEIGHTS, iterations=30, communities=COMMS, edge_weights=edge_weights
    )
    shuffled = list(reversed(range(len(EDGES))))
    second = graph_module.forceatlas_layout(
        list(reversed(IDS)),
        [EDGES[i] for i in shuffled],
        weights=WEIGHTS,
        iterations=30,
        communities=COMMS,
        edge_weights=[edge_weights[i] for i in shuffled],
    )

    assert second == first
    assert len(calls) == 1

    graph_module.clear_layout_cache()
    uncached_shuffled = graph_module.forceatlas_layout(
        list(reversed(IDS)), [EDGES[i] for i in shuffled], weights=WEIGHTS, iterations=30,
        communities=COMMS, edge_weights=[edge_weights[i] for i in shuffled],
    )
    assert uncached_shuffled == first


def test_mutual_link_direction_survives_body_edit(tmp_path, monkeypatch):
    """A↔B 상호 링크는 한 방향만 남기는데, 어느 쪽이 남는지가 DB 행 순서를 따랐다.
    증분 재빌드가 고친 페이지의 링크를 맨 뒤로 다시 넣으면 방향이 뒤집혀, 본문만
    고쳐도 레이아웃 입력이 바뀌고(캐시 빗나감) 그래프가 흔들렸다."""
    import os
    import time

    from fastapi.testclient import TestClient

    from raven.api.server import app
    from raven.core.vault import Vault

    monkeypatch.setenv("WIKI_VAULTS_DIR", str(tmp_path / "registry"))
    v = Vault.create("mutual", tmp_path / "vault")
    content = v.root / "content"
    content.mkdir(parents=True, exist_ok=True)

    def page(title: str, body: str) -> str:
        return f"---\ntitle: {title}\ntype: concept\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n\n{body}\n"

    (content / "alpha.md").write_text(page("Alpha", "see [[content/beta]]"), encoding="utf-8")
    (content / "beta.md").write_text(page("Beta", "see [[content/alpha]]"), encoding="utf-8")

    # DB 분기를 타게 한다 (wiki.db가 없으면 파일을 직접 읽는 fallback 분기로 간다)
    from raven.core import db as db_module

    db_module.build_db(v, run_lint=False)

    client = TestClient(app)
    url = "/api/vaults/mutual/graph?iterations=5"

    def edges() -> list[tuple[str, str]]:
        return [(e["source"], e["target"]) for e in client.get(url).json()["edges"]]

    before = edges()
    mutual = [e for e in before if set(e) == {"content/alpha", "content/beta"}]
    assert len(mutual) == 1  # 상호 링크는 한 방향만 남는다 (목차 페이지 링크는 별도)

    # alpha를 본문만 고친다 → 증분 재빌드가 alpha의 링크를 맨 뒤로 다시 넣는다
    alpha = content / "alpha.md"
    alpha.write_text(page("Alpha", "see [[content/beta]] — 본문만 고침"), encoding="utf-8")
    future = time.time() + 5
    os.utime(alpha, (future, future))

    assert edges() == before
