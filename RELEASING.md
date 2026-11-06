# Releasing

How versions and releases work for the public repository `orientpine/pingpong-vision`.

## Version numbers

**There is one version number.** The `V x.y.z` on the app's start screen, `package.json` of the tournament app and of the camera app, and the public tag are always the same.

- Every production deploy raises it: 1.1.0, then 1.1.1, 1.1.2. A big change raises the middle number. The deploy bumps both `package.json` files, also when only one app changed.
- A public release uses the number production has then. So tags can skip numbers: the next one may be v1.1.3, not v1.1.0. Add one line to the CHANGELOG for the skipped numbers, for example *1.1.1 and 1.1.2 were not published; their changes are listed here*.
- `scripts/export-public.sh` stops with exit 3 if the tag, the two `package.json` files and the running app's V are not all the same. Deploy first, then export. Never edit a number to get past it.
- **0.1.0** (2026-10-29, commit `56bb9e8`) has no tag, and the history is never rewritten to add one. **v1.0.0 to v1.0.2** came before this rule, so they do not match the start screen of that time.
- A sync that changes only docs, tests or QA scripts does not need a new tag. It can wait for the next release.

`package.json`'s `version` is the release number: tag `vX.Y.Z` is cut from a tree whose `package.json` says `X.Y.Z`. The *New version* line in Settings compares that number with the latest GitHub release, and `bun update.mjs` reads it before and after updating.

`export-public.sh` writes `release.json` (`{"repo": "orientpine/pingpong-vision"}`) into the public tree. Only a tree with that file asks GitHub for a newer release or lets `update.mjs` run, so the private repository and the production PC never do.

## What goes public

Only code that runs in production. Work still on an open branch waits for its merge and its deploy.

## Deploying on this PC

`./start.sh --restart` deploys the committed HEAD into `releases/<sha>`, points `current` at it and restarts `pingpong-vision`. The analysis desk worker runs from `current` as it was when it started, so after a vision deploy it must restart too: `systemctl --user restart pingpong-desk-worker`. `start.sh --restart` does that when the worker is running (an analysis in progress stops and resumes from its checkpoint, see docs/analysis-desk.md).

## Release steps

`tournament/` is exported from the private scoreboard repository, so a release names one commit of each. The public history gets only the new release commit. Set `PPV_SCAN_PATTERNS` to the tournament pattern file, which also lists the club's player names and PINs.

Run these on the maintainer's machine. It holds the scan patterns and the private checkout.

1. **Export and scan.** Build the public tree from the deployed private commit. `export-public.sh` runs the leak scan and exits non-zero if any count is not 0.

   ```bash
   R=$(mktemp -d)
   bash scripts/export-public.sh <deployed commit> "$R/tree" <tournament checkout> <deployed tournament commit> x.y.z
   ```

2. **Write the notes.** Add the new version to `CHANGELOG.md` and `CHANGELOG.ko.md` under a heading `## [x.y.z] - YYYY-MM-DD`. Write it in user words: what changed on screen and what to do differently. Leave out internal PR numbers and names. Move `[Unreleased]` items into it and update the compare links at the bottom.

3. **Commit on top of the public history.** Never force-push.

   ```bash
   git clone https://github.com/orientpine/pingpong-vision "$R/pub"
   rsync -a --delete --exclude .git "$R/tree/" "$R/pub/"
   cd "$R/pub" && git add -A && git status --short
   git commit -m "Release vX.Y.Z: <one line>"
   bash scripts/scan-public.sh . --git      # tree and full history, every count must be 0
   git push origin main
   ```

4. **Tag and publish.** The release body is that version's CHANGELOG section (English) plus a short Korean summary.

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-file notes.md
   ```

   GitHub attaches the source zip and tarball by itself. No other assets are uploaded.

5. **Check from a fresh clone.** Clone, run the README quick start (`bun install`, `bash scripts/fetch-models.sh`, `bun server.js`), check `curl -i http://127.0.0.1:8791/healthz` is `200`, and run `scan-public.sh <clone> --git` again.

## Keeping secrets out

- Never commit camera recordings, frames of people other than public datasets, keys, host or account names, or internal addresses.
- The scan's private patterns live only in the maintainer's `~/.config/pingpong-vision/scan-patterns`. They are never committed, and the scanner reads its own file too.
- If something slips out, do not force-push. Make the repository private, tell the maintainer, and publish a clean new repository.
