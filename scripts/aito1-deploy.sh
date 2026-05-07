#!/usr/bin/env bash
# AITO1-specific deploy: build artifacts in this dev clone, copy to ~/.aito1/, restart launchd services.
#
# Usage:
#   ./scripts/aito1-deploy.sh             # frontend + backend
#   ./scripts/aito1-deploy.sh frontend
#   ./scripts/aito1-deploy.sh backend
#
# Pre-reqs: AITO1 already installed (~/.aito1/ + launchd plists in place).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AITO1_HOME="${AITO1_HOME:-$HOME/.aito1}"
TARGET="${1:-all}"

deploy_frontend() {
  echo "==> frontend: build (STANDALONE=true)"
  cd "$REPO_ROOT"
  STANDALONE=true pnpm --filter web build

  echo "==> frontend: pack to $AITO1_HOME/web"
  rm -rf "$AITO1_HOME/web"
  mkdir -p "$AITO1_HOME/web"
  cp -R apps/web/.next/standalone/. "$AITO1_HOME/web/"
  cp -R apps/web/.next/static "$AITO1_HOME/web/apps/web/.next/static"
  [ -d apps/web/public ] && cp -R apps/web/public "$AITO1_HOME/web/apps/web/public"

  echo "==> frontend: restart"
  launchctl kickstart -k "gui/$(id -u)/ai.aito1.multica.frontend"
}

deploy_backend() {
  echo "==> backend: build server + daemon CLI + migrate"
  cd "$REPO_ROOT/server"
  mkdir -p "$AITO1_HOME/multica/bin"
  go build -o "$AITO1_HOME/multica/bin/multica-server" ./cmd/server
  go build -o "$AITO1_HOME/multica/bin/multica"        ./cmd/multica
  go build -o "$AITO1_HOME/multica/bin/multica-migrate" ./cmd/migrate

  echo "==> backend: restart server + daemon"
  launchctl kickstart -k "gui/$(id -u)/ai.aito1.multica.backend"
  launchctl kickstart -k "gui/$(id -u)/ai.aito1.multica.daemon"
}

case "$TARGET" in
  frontend) deploy_frontend ;;
  backend)  deploy_backend ;;
  all)      deploy_frontend; deploy_backend ;;
  *)        echo "usage: $0 [frontend|backend|all]" >&2; exit 2 ;;
esac

echo "done."
