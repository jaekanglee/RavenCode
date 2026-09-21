# raven — top-level Makefile
# v0.7.55+ — Docker deprecated. 기본은 local host stack (raven.sh / restart-all.sh).
# Self-documenting: `make` or `make help` lists targets.
#
# Conventions:
#   - All commands run from project root.
#   - 로컬 host 실행 (기본): make install && ./raven.sh start
#   - Docker (deprecated, 남겨두지만 신규 사용자는 비권장): cp .env.example.house .env && make docker-up
#   - PYTHONPATH=. so `python -m raven.*` works without install.

SHELL := /bin/bash
VENV := scripts/.venv
PY   := $(VENV)/bin/python
PIP  := $(VENV)/bin/pip

# 데스크톱 앱 버전 SOT = tauri.conf.json. DMG 이름·태그·latest.json 이 모두 여기서
# 파생된다 (하드코딩하면 버전 범프 때 조용히 어긋난다). 올릴 때는 make desktop-version.
GH_REPO := jaekanglee/RavenCode
DESKTOP_VERSION = $(shell python3 -c "import json;print(json.load(open('desktop/src-tauri/tauri.conf.json'))['version'])" 2>/dev/null)

# Default target — show help when user just runs `make`
.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help message
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

# ────────────────────────── setup ──────────────────────────

.PHONY: install
# v0.7.185+: venv 가 uv 로 만들어졌으면 pip 가 없다 (`uv venv` 는 pip 를 넣지 않는다).
# 예전 install/venv-check 는 pip 존재만 보고 "venv 없음"으로 단정해서,
#   - venv-check → 모든 타깃(up/test/…)이 "run 'make install' first" 로 막히고
#   - install    → `rm -rf $(VENV)` 로 멀쩡한 venv 를 지우려 들었다
# 그 바람에 의존성 동기화 명령이 아예 돌지 못해 mcp 가 1.29.0 에 멈춰 있었고,
# requirements.txt 가 mcp>=2.0 을 가리키는데도 아무도 모르고 있었다.
# → 이제 uv 가 있으면 uv 를, 없으면 pip 를 쓴다. 멀쩡한 venv 는 절대 지우지 않는다.
UV := $(shell command -v uv 2>/dev/null)

install: ## Create venv + install raven + dev deps (v0.7.55+ 기본 경로 — Docker는 deprecated)
	@if [ ! -x $(PY) ]; then \
		echo "📦 Creating Python venv in $(VENV)..."; \
		if [ -n "$(UV)" ]; then \
			uv venv $(VENV) || (echo "❌ uv venv 실패"; exit 1); \
		else \
			python3 -m venv $(VENV) || (echo "❌ python3 -m venv 실패"; exit 1); \
		fi; \
	fi
	@if [ -n "$(UV)" ]; then \
		echo "📦 uv 로 의존성 동기화..."; \
		VIRTUAL_ENV=$(VENV) uv pip install --quiet -e ./scripts; \
		VIRTUAL_ENV=$(VENV) uv pip install --quiet -r requirements.txt; \
		VIRTUAL_ENV=$(VENV) uv pip install --quiet pytest; \
	else \
		$(PIP) install --quiet --upgrade pip; \
		$(PIP) install --quiet -e ./scripts; \
		$(PIP) install --quiet -r requirements.txt; \
		$(PIP) install --quiet pytest; \
	fi
	@echo "✅ installed ($(VENV))"

.PHONY: venv-check deps-check
venv-check: ## Fail loudly if venv missing (so other targets work)
	@test -x $(PY) || (echo "❌ run 'make install' first"; exit 1)

deps-check: venv-check ## requirements.txt 핀과 실제 설치본이 어긋났는지 확인
	@$(PY) scripts/check-deps.py

# ────────────────────────── Docker (v0.7.55+ deprecated) ──────────────────────
# v0.7.12~54: Docker compose 표준이었음. v0.7.55+: local host stack(./raven.sh,
# scripts/restart-all.sh)이 기본으로 전환됨 — 아래 target들은 하위 호환/레거시
# 용도로 남겨두지만 신규 사용자는 `./raven.sh start`를 사용할 것.

.PHONY: docker-build docker-up docker-down docker-logs docker-ps
docker-build: ## Build Raven Docker image (multi-stage: dashboard + Python runtime)
	@if [ ! -f .env ]; then \
		echo "📋 .env 없음. .env.example.house → .env 복사. RAVEN_VAULTS_DIR 조정 후 사용."; \
		cp .env.example.house .env; \
	fi
	# v0.7.17+: 순차 빌드 강제 (병렬 image 빌드 시 같은 tag 충돌 ❌)
	$(MAKE) --no-print-directory docker-build-api
	$(MAKE) --no-print-directory docker-build-mcp-http
	$(MAKE) --no-print-directory docker-build-dashboard
	@echo ""
	@echo "✅ raven:latest built (3 services: api, mcp-http, dashboard)"

docker-build-api: ## Build api service image only
	docker compose build api

docker-build-mcp-http: ## Build mcp-http service image only
	docker compose build mcp-http

docker-build-dashboard: ## Build dashboard service image only
	docker compose build dashboard

docker-up: ## Start 4 services (API + MCP HTTP + Dashboard, stdio is docker exec)
	@if [ ! -f .env ]; then \
		echo "📋 .env 없음. .env.example.house → .env 복사. RAVEN_VAULTS_DIR 조정 후 사용."; \
		cp .env.example.house .env; \
	fi
	docker compose up -d
	@echo ""
	@echo "🟢 Raven Docker stack running:"
	@echo "   • API    → http://localhost:8765        (curl http://localhost:8765/api/vaults)"
	@echo "   • MCP    → http://localhost:8766/mcp    (MCP HTTP client config)"
	@echo "   • UI     → http://localhost:5173        (Dashboard)"
	@echo "   • CLI    → docker compose exec api docker-entrypoint.sh cli <args>"
	@echo "   • MCP stdio → docker compose exec api docker-entrypoint.sh mcp-stdio"
	@echo "🛑 down: make docker-down  |  logs: make docker-logs  |  ps: make docker-ps"

docker-down: ## Stop and remove Raven Docker containers
	docker compose down

docker-logs: ## Follow logs from all Raven services
	docker compose logs -f

docker-ps: ## Show Raven container status
	docker compose ps

# ────────────────────────── test ──────────────────────────

.PHONY: test
test: venv-check ## Run full pytest suite
	$(PY) -m pytest tests/ -q

.PHONY: test-quick
test-quick: venv-check ## Run pytest with stop-on-first-failure
	$(PY) -m pytest tests/ -q -x

.PHONY: test-one
test-one: venv-check ## Run a single pytest file (usage: make test-one F=tests/test_foo.py)
	$(PY) -m pytest $(F) -v

.PHONY: typecheck
typecheck: ## Typecheck the dashboard (v0.7.67: AGENTS.md §6 referenced this before it existed)
	cd dashboard && npx tsc -b --noEmit

# ────────────────────────── cleanup ──────────────────────────

.PHONY: clean
clean: ## Remove build artifacts (wiki.db, __pycache__, .pytest_cache) — KEEPS vault content
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	rm -rf .pytest_cache
	@echo "✅ clean (vault content preserved)"

.PHONY: nuke
nuke: ## ⚠️ Remove venv + ALL build artifacts (asks for confirmation)
	@echo "⚠️  This will remove scripts/.venv + __pycache__ + .pytest_cache"
	@read -p "Continue? [y/N] " r && [[ $$r =~ ^[Yy]$$ ]]
	rm -rf $(VENV) .pytest_cache
	find . -type d -name __pycache__ -prune -exec rm -rf {} +
	@echo "✅ nuked"

# ────────────────────────── run / stop shortcuts ──────────────────────────

.PHONY: up down restart status
up: venv-check ## Start Raven locally in the background (API + Dashboard dev server)
	@./raven.sh start

down: ## Stop local background processes (API + Dashboard)
	@./raven.sh stop

restart: ## Restart local background processes
	@./raven.sh restart

status: ## Show status of local background processes
	@./raven.sh status

.PHONY: docker-restart rebuild restart-all
docker-restart: docker-down docker-up ## Restart Raven via Docker compose
rebuild: docker-build docker-restart ## Rebuild Docker images and restart Docker containers
# v0.7.60+: Docker 무관. local host stack (./raven.sh)을 완전히 내리고
#           모든 캐시(Vite pre-bundle / python __pycache__ / pytest / 구 로그)를
#           비운 뒤 재시작. 디자인 시스템 토큰, CSS, node_modules 의존성 변경
#           후 UI가 stale하게 갱신 안 될 때 사용. 기본 재시작은 `make restart`.
restart-all: ## Full local restart: wipe caches (Vite/__pycache__/pytest/logs) + restart
	@bash scripts/restart-all.sh

export PATH := $(HOME)/.cargo/bin:$(PATH)

# ────────────────────────── desktop ──────────────────────────

.PHONY: desktop-check desktop-dev desktop-rebuild desktop-bundle desktop-build desktop-dmg desktop-key-save desktop-release-preflight desktop-release

desktop-check: ## Check required tools (python venv, cargo, node, npm) for desktop app development and auto-install if missing
	@if ! command -v python3 >/dev/null 2>&1; then \
		echo "❌ Python3(python3)가 설치되어 있지 않습니다. Python 3.10 이상을 설치해 주세요."; \
		exit 1; \
	fi
	@if [ ! -f scripts/.venv/bin/python ]; then \
		echo "📦 개발용 파이썬 환경(scripts/.venv)이 없습니다. 'make install'을 자동으로 실행합니다..."; \
		$(MAKE) install || exit 1; \
	fi
	@if ! command -v cargo >/dev/null 2>&1; then \
		echo "🦀 Rust(cargo)가 설치되어 있지 않아 rustup을 통해 자동 설치를 진행합니다..."; \
		curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable || exit 1; \
		if [ -f "$$HOME/.cargo/env" ]; then \
			source "$$HOME/.cargo/env"; \
		fi; \
	fi
	@if ! command -v cargo >/dev/null 2>&1 && [ ! -f "$$HOME/.cargo/bin/cargo" ]; then \
		echo "❌ Rust(cargo) 설치 실패 또는 PATH 등록 문제 발생."; \
		exit 1; \
	fi
	@if ! command -v node >/dev/null 2>&1; then \
		if command -v brew >/dev/null 2>&1; then \
			echo "📦 Node.js가 설치되어 있지 않아 Homebrew로 자동 설치합니다..."; \
			brew install node || exit 1; \
		else \
			echo "❌ Node.js(node)가 설치되어 있지 않습니다. https://nodejs.org 에서 설치해 주세요."; \
			exit 1; \
		fi; \
	fi
	@if ! command -v npm >/dev/null 2>&1; then \
		echo "❌ npm이 설치되어 있지 않습니다."; \
		exit 1; \
	fi
	@if [ ! -d dashboard/node_modules ]; then \
		echo "📦 dashboard/node_modules가 없습니다. 'npm install'을 실행합니다..."; \
		cd dashboard && npm install; \
	fi

desktop-dev: desktop-check desktop-bundle-check ## Run desktop app in dev mode with live reload
	cd dashboard && npm run desktop:dev

desktop-bundle-check: ## Ensure desktop bundle resources exist
	@if [ ! -d desktop/src-tauri/resources/raven ] || [ ! -d desktop/src-tauri/resources/python ]; then \
		echo "📦 번들 자원(desktop/src-tauri/resources)이 준비되어 있지 않아 prepare-bundle.sh를 먼저 실행합니다..."; \
		$(MAKE) desktop-bundle; \
	fi

desktop-rebuild: desktop-build ## Rebuild desktop app (.app binary) from latest source
	@echo "✅ Rebuilt desktop app: desktop/src-tauri/target/release/raven-desktop"

desktop-bundle: ## Prepare bundled Python + Raven source for Tauri .app
	@bash scripts/prepare-bundle.sh

desktop-build: desktop-check desktop-bundle ## Build Tauri desktop app (release binary + .app)
	cd dashboard && npm ci && npm run build
	cd desktop/src-tauri && cargo build --release
	@echo "✅ Binary: desktop/src-tauri/target/release/raven-desktop"

desktop-version: ## Bump desktop app version (usage: make desktop-version VERSION=0.2.0)
	@test -n "$(VERSION)" || (echo "❌ usage: make desktop-version VERSION=0.2.0"; exit 1)
	@bash scripts/bump-desktop-version.sh "$(VERSION)"

desktop-dmg: desktop-build ## Build DMG installer from release binary
	@bash scripts/make-dmg.sh
	@echo "✅ DMG: desktop/src-tauri/target/release/bundle/dmg/Raven_$(DESKTOP_VERSION)_aarch64.dmg"

desktop-key-save: ## 업데이터 서명 키 경로+비밀번호를 .env.release 에 기록 (최초 1회. 검증 후 저장, gitignore 대상)
	@bash scripts/save-release-key.sh

desktop-release-preflight: ## 릴리스 전제조건 검사 (서명 자격증명·태그·gh) — 빌드 전에 먼저 실패시킨다
	@set -e; \
	VERSION="$(DESKTOP_VERSION)"; \
	TAG="v$$VERSION"; \
	echo "=== Release preflight ($$TAG) ==="; \
	command -v gh >/dev/null 2>&1 || { \
	  echo "❌ gh CLI 가 없습니다 — brew install gh && gh auth login"; exit 1; }; \
	if [ ! -f .env.release ] && [ -z "$$TAURI_SIGNING_PRIVATE_KEY" ]; then \
	  echo "❌ 서명 자격증명이 없습니다 — 'make desktop-key-save' 를 먼저 실행하세요."; exit 1; \
	fi; \
	git rev-parse "$$TAG" >/dev/null 2>&1 || { \
	  echo "❌ 태그 $$TAG 가 없습니다 — 'make desktop-version VERSION=$$VERSION' 후 커밋/태그하세요."; exit 1; }; \
	git ls-remote --tags origin "refs/tags/$$TAG" | grep -q . || { \
	  echo "❌ 태그 $$TAG 가 원격에 없습니다 — 'git push origin --tags' 먼저 실행하세요."; exit 1; }; \
	echo "✅ preflight 통과 — 빌드를 시작합니다."

desktop-release: desktop-release-preflight desktop-dmg ## Build DMG + signed auto-update artifact, upload both to GitHub Release (requires gh CLI + .env.release — make desktop-key-save)
	@set -e; \
	VERSION="$(DESKTOP_VERSION)"; \
	TAG="v$$VERSION"; \
	DMG="desktop/src-tauri/target/release/bundle/dmg/Raven_$${VERSION}_aarch64.dmg"; \
	bash scripts/sign-update.sh "$$VERSION" "$(GH_REPO)"; \
	ARTIFACT="desktop/src-tauri/target/release/bundle/updater/Raven.app.tar.gz"; \
	MANIFEST="desktop/src-tauri/target/release/bundle/updater/latest.json"; \
	for f in "$$DMG" "$$ARTIFACT" "$$MANIFEST"; do \
	  [ -f "$$f" ] || { echo "❌ 업로드할 파일이 없습니다: $$f"; exit 1; }; \
	done; \
	gh release view "$$TAG" --repo "$(GH_REPO)" >/dev/null 2>&1 || { \
	  echo "📝 릴리스 $$TAG 가 없어 새로 만듭니다 ..."; \
	  gh release create "$$TAG" --repo "$(GH_REPO)" --title "Raven $$TAG" --generate-notes; }; \
	echo "📦 Uploading $$DMG + $$ARTIFACT + $$MANIFEST to release $$TAG ..."; \
	gh release upload "$$TAG" "$$DMG" "$$ARTIFACT" "$$MANIFEST" --repo "$(GH_REPO)" --clobber; \
	echo "✅ Release $$TAG updated (auto-update manifest included)"; \
	echo "   업데이터 엔드포인트: https://github.com/$(GH_REPO)/releases/latest/download/latest.json"
# ────────────────────────── mobile ──────────────────────────

.PHONY: deploy-dev deploy-prod deploy-qc

deploy-qc: ## Deploy mobile QC build via Fastlane (auto-increments .devX version)
	@bash scripts/deploy-qc.sh

deploy-dev: ## Deploy mobile Dev build via Fastlane
	cd mobile && bundle exec fastlane distribute_dev

deploy-prod: ## Deploy mobile Prod build via Fastlane
	cd mobile && bundle exec fastlane distribute_prod

desktop-install: ## Rebuild from current source and (re)install Raven.app to /Applications (no clone/pull)
	@bash scripts/install-desktop.sh

.PHONY: desktop-smoke
desktop-smoke: ## Smoke-test the installed Raven.app through its real Tauri-managed core (launches it if needed)
	@bash scripts/smoke-desktop.sh
