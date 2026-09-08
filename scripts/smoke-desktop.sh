#!/usr/bin/env bash
# Smoke-test the *installed* Raven.app: launch it if needed, then hit the
# endpoints the dashboard depends on through the real Tauri-managed Python Core.
#
# Catches what in-process API tests cannot — failures that only appear once the
# core runs under the shell (e.g. the dropped-stderr-pipe 500 on /hybrid-search).
#
# Usage: bash scripts/smoke-desktop.sh   (or: make desktop-smoke)
#   RAVEN_SMOKE_VAULT=<name>  vault to probe (default: registry default vault)
#   RAVEN_SMOKE_PORT=<port>   API port (default: 8765)
set -uo pipefail

PORT="${RAVEN_SMOKE_PORT:-8765}"
BASE="http://127.0.0.1:${PORT}"
APP="/Applications/Raven.app"

if ! curl -sf -m 2 -o /dev/null "$BASE/api/vaults"; then
  [ -d "$APP" ] || { echo "❌ $APP not installed (make desktop-install)"; exit 1; }
  echo "▶ launching $APP ..."
  open "$APP"
  for _ in $(seq 1 40); do
    curl -sf -m 2 -o /dev/null "$BASE/api/vaults" && break
    sleep 1
  done
fi
curl -sf -m 2 -o /dev/null "$BASE/api/vaults" || { echo "❌ API not reachable on $BASE"; exit 1; }

VAULT="${RAVEN_SMOKE_VAULT:-}"
if [ -z "$VAULT" ]; then
  VAULT="$(curl -s "$BASE/api/vaults" | python3 -c '
import json, sys
vs = json.load(sys.stdin)["vaults"]
print(next((v["name"] for v in vs if v.get("default")), vs[0]["name"] if vs else ""))')"
fi
[ -n "$VAULT" ] || { echo "❌ no vault registered"; exit 1; }
echo "▶ API $BASE · vault '$VAULT'"

fail=0
probe() {  # method path [json-body]
  local method="$1" path="$2" body="${3:-}" code
  if [ -n "$body" ]; then
    code=$(curl -s -m 60 -o /dev/null -w "%{http_code}" -X "$method" -H "Content-Type: application/json" -d "$body" "$BASE$path")
  else
    code=$(curl -s -m 60 -o /dev/null -w "%{http_code}" -X "$method" "$BASE$path")
  fi
  if [ "$code" = "200" ]; then
    printf "  ✅ %-6s %-45s %s\n" "$method" "$path" "$code"
  else
    printf "  ❌ %-6s %-45s %s\n" "$method" "$path" "$code"; fail=1
  fi
}

V="/api/vaults/$VAULT"
probe GET  "/api/vaults"
probe GET  "$V/search?q=raven"
probe GET  "$V/hybrid-search?query=raven&limit=3"
probe GET  "$V/rag/query?query=raven"
probe POST "$V/suggest-tags" '{"content":"raven vault search","title":"smoke"}'
probe GET  "$V/lint/contradictions"
probe GET  "$V/ai-advice"
probe GET  "$V/stats"
probe GET  "$V/graph"
probe GET  "$V/pages"

if [ "$fail" -eq 0 ]; then echo "✅ desktop smoke passed"; else echo "❌ desktop smoke FAILED"; exit 1; fi
