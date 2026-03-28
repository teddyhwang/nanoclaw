#!/usr/bin/env bash
# Cleanly restart all nanoclaw launchd services.
# Usage: ./scripts/restart.sh [--build]
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
UID_NUM="$(id -u)"
DASHBOARD_PORT="${DASHBOARD_PORT:-3002}"

SERVICES=(
  com.nanoclaw
  com.nanoclaw.dev-agent
  com.nanoclaw.dashboard
)

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}▸${NC} $*"; }
warn()  { echo -e "${YELLOW}▸${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; }

# Build if requested
if [[ "${1:-}" == "--build" ]]; then
  info "Building..."
  cd "$REPO_DIR"
  npm run build
  echo ""
fi

# Stop all services
info "Stopping services..."
for svc in "${SERVICES[@]}"; do
  plist="$HOME/Library/LaunchAgents/${svc}.plist"
  if [[ -f "$plist" ]]; then
    launchctl unload "$plist" 2>/dev/null || true
  fi
done

# Wait for ports to free up (dashboard binds to a port)
if lsof -ti:"$DASHBOARD_PORT" &>/dev/null; then
  warn "Waiting for port $DASHBOARD_PORT to free..."
  lsof -ti:"$DASHBOARD_PORT" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

# Start all services
info "Starting services..."
for svc in "${SERVICES[@]}"; do
  plist="$HOME/Library/LaunchAgents/${svc}.plist"
  if [[ -f "$plist" ]]; then
    launchctl load "$plist" 2>/dev/null
  else
    warn "Skipping $svc (no plist found)"
  fi
done

# Verify
sleep 2
echo ""
info "Service status:"
all_ok=true
for svc in "${SERVICES[@]}"; do
  status=$(launchctl list | grep -E "\\b${svc}$" || true)
  if [[ -z "$status" ]]; then
    error "  $svc — not running"
    all_ok=false
  else
    pid=$(echo "$status" | awk '{print $1}')
    exit_code=$(echo "$status" | awk '{print $2}')
    if [[ "$exit_code" == "0" && "$pid" != "-" ]]; then
      info "  $svc — running (pid $pid)"
    else
      error "  $svc — exit code $exit_code (pid $pid)"
      all_ok=false
    fi
  fi
done

if $all_ok; then
  echo ""
  info "All services running ✓"
else
  echo ""
  error "Some services failed — check logs in $REPO_DIR/logs/"
  exit 1
fi
