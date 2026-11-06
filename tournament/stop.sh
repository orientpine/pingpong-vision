#!/usr/bin/env bash
# Stops the tournament service and removes its Tailscale mapping. Tournament records in data/ stay.
set -euo pipefail
DEPLOY_ENV="${PPV_DEPLOY_ENV:-$HOME/.config/pingpong-vision/deploy.env}"
# shellcheck disable=SC1090
[[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV"
FUNNEL_PORT="${FUNNEL_PORT:?set FUNNEL_PORT in $DEPLOY_ENV or the environment}"
TS_MODE="${PPV_TS_MODE:?set PPV_TS_MODE (serve or funnel) in $DEPLOY_ENV}"
SERVICE="${TOURNAMENT_SERVICE:-pingpong-scoreboard}"
tailscale "$TS_MODE" --https="${FUNNEL_PORT}" off 2>/dev/null || true
systemctl --user disable --now "$SERVICE.service" 2>/dev/null || true
echo "Stopped. Tournament records in data/ are kept."
