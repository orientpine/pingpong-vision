#!/usr/bin/env bash
# Builds the public tree from a commit of the private repo and leak-checks it.
#   scripts/export-public.sh <rev> <empty dest dir> <tournament checkout> <tournament rev> <version>
# Takes the committed files of <rev> (git archive, so nothing uncommitted or gitignored), drops
# the private-only paths below, puts README.public.md / README.public.ko.md in place of README.md /
# README.ko.md, then runs
# scripts/scan-public.sh on the result. Exits non-zero if the scan finds anything. With a tournament
# checkout, its own export (private paths dropped) goes to tournament/ before the scan.
# Before anything is written it checks there is one version number: <version> (the tag without v),
# package.json of both commits and the V the running tournament app shows (RELEASING.md). Any
# difference, or a running app that does not answer, stops it with exit 3.
set -euo pipefail

USAGE="usage: export-public.sh <rev> <dest> <tournament checkout> <tournament rev> <version>"
REV="${1:?$USAGE}"
DEST="${2:?$USAGE}"
TOURNAMENT="${3:?$USAGE}"
TOURNAMENT_REV="${4:?$USAGE}"
VERSION="${5:?$USAGE}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# shellcheck disable=SC1090
DEPLOY_ENV="${PPV_DEPLOY_ENV:-$HOME/.config/pingpong-vision/deploy.env}"
[[ -f "$DEPLOY_ENV" ]] && source "$DEPLOY_ENV"
json_version() { bun -e 'const t=await Bun.stdin.text();try{console.log(JSON.parse(t).version??"")}catch{console.log("")}'; }
vision_pkg="$(git -C "$ROOT" show "$REV:package.json" | json_version)"
tournament_pkg="$(git -C "$TOURNAMENT" show "$TOURNAMENT_REV:package.json" | json_version)"
running="$(curl -sf --max-time 5 "${PPV_TOURNAMENT_URL:-http://127.0.0.1:1}/api/state" | json_version || true)"
printf 'version check\n  tag                  %s\n  vision package.json  %s\n  tournament package   %s\n  running app (V)      %s\n' "$VERSION" "$vision_pkg" "$tournament_pkg" "${running:-no answer}"
if [[ "$vision_pkg" != "$VERSION" || "$tournament_pkg" != "$VERSION" || "$running" != "$VERSION" ]]; then
  echo "versions differ: stopping. There is one number (RELEASING.md): deploy that version first, then export it." >&2
  exit 3
fi

mkdir -p "$DEST"
[[ -z "$(ls -A "$DEST")" ]] || { echo "dest not empty: $DEST" >&2; exit 2; }
git -C "$ROOT" archive "$REV" | tar -x -C "$DEST"

PRIVATE_ONLY=(
  'REPORT*.md' 'BRIEF*.md' .omo reference evidence data public-url.txt
  qa/demo.html qa/demo-state.js qa/ui-demo.js qa/make-home-clips.sh qa/fixtures qa/desk-handoff-e2e.mjs
  public/bench/frame.jpg
)
( cd "$DEST" && for p in "${PRIVATE_ONLY[@]}"; do rm -rf -- $p; done )
mv "$DEST/README.public.md" "$DEST/README.md"
mv "$DEST/README.public.ko.md" "$DEST/README.ko.md"
# Only the public tree asks GitHub for a newer release (update-check.js); this repository never does.
printf '{"repo": "orientpine/pingpong-vision"}\n' > "$DEST/release.json"

bash "$TOURNAMENT/scripts/export-public.sh" "$TOURNAMENT_REV" "$DEST/tournament"

echo "exported $(git -C "$ROOT" rev-parse --short=12 "$REV") -> $DEST ($(find "$DEST" -type f | wc -l) files)"
bash "$ROOT/scripts/scan-public.sh" "$DEST"
