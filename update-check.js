// The "new version" line in settings (README: Update). Only a public install asks: its tree has
// release.json ({"repo": "<owner>/<name>"}), which scripts/export-public.sh writes and the private
// repository does not have, so a development or production checkout never asks GitHub.
// The question is one GET of GitHub's public API for that repository's latest release, at most once a
// day: the time of the last try (a failed one too) is kept in a small cache file, so restarts do not
// ask again. Nothing about the user, the tournament or this PC is sent. A failure is quiet: no line.
// PPV_UPDATE_CHECK=off in the environment or in deploy.env turns it off.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

export function isNewer(a, b) {
  const x = VERSION_RE.exec(String(a)), y = VERSION_RE.exec(String(b));
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d > 0;
  }
  return false;
}

export function readEnvFile(file) {
  const vars = {};
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { return vars; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)=([^#]*)/);
    if (m) vars[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return vars;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

export function createUpdateCheck({
  root,
  env = process.env,
  fetch: fetchFn = globalThis.fetch,
  now = Date.now,
  envFile = env.PPV_DEPLOY_ENV || join(homedir(), ".config/pingpong-vision/deploy.env"),
  cacheFile = env.PPV_UPDATE_CACHE || join(homedir(), ".cache/pingpong-vision/update-check.json"),
  timeoutMs = 5000,
} = {}) {
  const version = readJson(join(root, "package.json"))?.version || "";
  const marked = readJson(join(root, "release.json"))?.repo;
  const repo = typeof marked === "string" && REPO_RE.test(marked) ? marked : null;
  const setting = env.PPV_UPDATE_CHECK ?? readEnvFile(envFile).PPV_UPDATE_CHECK ?? "on";
  const on = !!repo && setting !== "off";
  let cache = readJson(cacheFile);
  if (!cache || cache.repo !== repo || !Number.isFinite(cache.checkedAt)) cache = null;
  let pending = null;

  function save() {
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(cache));
    } catch {}
  }

  async function ask() {
    const at = now();
    // the try counts before the answer, so a crash or a hang still waits a day
    cache = { repo, checkedAt: at, latest: cache?.latest ?? null };
    save();
    try {
      const res = await fetchFn(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { accept: "application/vnd.github+json", "user-agent": "pingpong-vision-update-check" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return;
      const tag = (await res.json())?.tag_name;
      if (typeof tag === "string" && VERSION_RE.test(tag)) cache = { repo, checkedAt: at, latest: tag };
    } catch {
      // offline, GitHub down, rate limit or a bad answer: no line, try again tomorrow
    } finally {
      save();
    }
  }

  async function status() {
    if (!on) return { version, check: false };
    // a clock that went back more than a day also asks again
    if (!cache || Math.abs(now() - cache.checkedAt) >= DAY_MS) {
      pending ??= ask().finally(() => { pending = null; });
      await pending;
    }
    const tag = cache?.latest;
    if (!tag || !isNewer(tag, version)) return { version, check: true, latest: null };
    return { version, check: true, latest: tag.replace(/^v/, ""), url: `https://github.com/${repo}/releases/tag/${tag}` };
  }

  return { version, on, repo, status };
}
