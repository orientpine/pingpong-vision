#!/usr/bin/env bash
# Writes the analysis desk worker's systemd user unit. It does not enable or start it.
#   deploy/install-desk-worker.sh --data-dir <tournament DATA_DIR> --server <URL> --heavy <queue command> \
#     --heavy-queue-dir <queue folder> [--dry-run]
# The server address and the GPU job queue are this PC's own; nothing host-specific is defaulted here.
# --dry-run prints the unit instead of writing it.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
data_dir=""
server=""
heavy=""
heavy_queue_dir=""
dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --data-dir) data_dir=$2; shift 2 ;;
    --server) server=$2; shift 2 ;;
    --heavy) heavy=$2; shift 2 ;;
    --heavy-queue-dir) heavy_queue_dir=$2; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$data_dir" ] || [ -z "$server" ] || [ -z "$heavy" ] || [ -z "$heavy_queue_dir" ]; then
  echo "usage: $0 --data-dir <tournament DATA_DIR> --server <URL> --heavy <queue command> --heavy-queue-dir <queue folder> [--dry-run]" >&2
  exit 2
fi
bun=$(command -v bun) || { echo "bun is not on PATH" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe is not on PATH" >&2; exit 1; }
[ -f "$data_dir/desk/worker-token" ] || echo "note: $data_dir/desk/worker-token does not exist yet (the tournament server writes it)" >&2
unit=$(sed -e "s|@REPO@|$repo|" -e "s|@DATA_DIR@|$data_dir|" -e "s|@SERVER@|$server|" -e "s|@HEAVY@|$heavy|" -e "s|@HEAVY_QUEUE_DIR@|$heavy_queue_dir|" -e "s|@PATH@|$PATH|" -e "s|@BUN@|$bun|" "$repo/deploy/pingpong-desk-worker.service")
if [ "$dry_run" = 1 ]; then
  printf '%s\n' "$unit"
  exit 0
fi
dest="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/pingpong-desk-worker.service"
mkdir -p "$(dirname "$dest")"
printf '%s\n' "$unit" > "$dest"
echo "wrote $dest"
echo "start it with: systemctl --user daemon-reload && systemctl --user enable --now pingpong-desk-worker.service"
