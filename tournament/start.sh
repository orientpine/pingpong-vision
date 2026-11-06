#!/usr/bin/env bash
# Starts the tournament app as a systemd user service and mounts it at / of a Tailscale serve or
# Funnel port. Host-specific values live outside the repo in
# ${PPV_DEPLOY_ENV:-~/.config/pingpong-vision/deploy.env}, the same file the vision app uses:
#   TOURNAMENT_PORT=8792        local port (no default: ports are shared per host)
#   FUNNEL_PORT=443             HTTPS port on your Tailscale name (443, 8443 or 10000)
#   PPV_TS_MODE=serve           serve (tailnet only) or funnel (internet); no default
#   TOURNAMENT_SERVICE=...      systemd unit name, default pingpong-scoreboard
#   ./start.sh            start (no-op if already running)
#   ./start.sh --restart  restart the app (the URL does not change)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DEPLOY_ENV="${PPV_DEPLOY_ENV:-$HOME/.config/pingpong-vision/deploy.env}"
for tool in systemctl tailscale; do
  command -v "$tool" >/dev/null || { echo "start.sh needs $tool (Linux with systemd and Tailscale). Otherwise run bun server.js and tailscale serve by hand (README: Install on your PC)." >&2; exit 1; }
done
# shellcheck disable=SC1090
[[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV"
# Checked before anything changes. No defaults: the wrong guess could expose another app.
PORT="${TOURNAMENT_PORT:?set TOURNAMENT_PORT in $DEPLOY_ENV or the environment}"
FUNNEL_PORT="${FUNNEL_PORT:?set FUNNEL_PORT (443, 8443 or 10000) in $DEPLOY_ENV or the environment}"
TS_MODE="${PPV_TS_MODE:?set PPV_TS_MODE in $DEPLOY_ENV: serve (only your tailnet, the default in deploy.env.example) or funnel (the whole internet, README: Open it to the internet)}"
[[ "$TS_MODE" == serve || "$TS_MODE" == funnel ]] || { echo "PPV_TS_MODE must be serve or funnel, not $TS_MODE" >&2; exit 2; }
SERVICE="${TOURNAMENT_SERVICE:-pingpong-scoreboard}"
BUN="$(command -v bun || echo "$HOME/.bun/bin/bun")"
[[ -x "$BUN" ]] || { echo "bun not found" >&2; exit 1; }
UNIT_DIR="$HOME/.config/systemd/user"

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$SERVICE.service" <<EOF
[Unit]
Description=Table tennis tournament app (port ${PORT})
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
Environment=PORT=${PORT}
ExecStart=${BUN} ${ROOT}/server.js
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable "$SERVICE.service" >/dev/null 2>&1
if [[ "${1:-}" == "--restart" ]]; then
  systemctl --user restart "$SERVICE.service"
else
  systemctl --user start "$SERVICE.service"
fi

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null || { echo "app did not start: journalctl --user -u $SERVICE -n 50" >&2; exit 1; }

# Persisted by tailscaled (survives reboot); this is idempotent.
tailscale "$TS_MODE" --bg --https="${FUNNEL_PORT}" "http://127.0.0.1:${PORT}" >/dev/null
DNS="$(tailscale status --json | "$BUN" -e 'const j=await Bun.stdin.json();console.log(j.Self.DNSName.replace(/\.$/,""))')"
URL="https://${DNS}:${FUNNEL_PORT}"
printf '%s\n' "$URL" > "$ROOT/public-url.txt"

echo "URL: $URL/"
echo "PIN: shown once when you create a tournament; see the README to set or change it."
echo "undo: $ROOT/stop.sh"
