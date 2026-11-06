// One command to update a public install (README: Update) on Linux, macOS and Windows:
//   bun update.mjs
// 1. stops, changing nothing, if this checkout has local changes, local commits or no upstream
// 2. copies the data and the settings folder into ~/pingpong-vision-backups/<date>_<time>/
// 3. git merge --ff-only with the fetched upstream
// 4. the installer: install.sh, or install.ps1 on Windows
// 5. restarts the app the way it runs: the Linux service (start.sh --restart), the macOS LaunchAgent,
//    the Windows sign-in task; started by hand, it waits for you to restart it
// 6. checks /healthz and that the new version answers; if a step after the backup fails, it prints
//    the lines that go back to the old commit
// Exit 0: updated or already new. 2: stopped before changing anything. 1: failed after changing.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readEnvFile } from "./update-check.js";

const ROOT = import.meta.dir;
const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";
const DEPLOY_ENV = process.env.PPV_DEPLOY_ENV || join(homedir(), ".config/pingpong-vision/deploy.env");
const vars = readEnvFile(DEPLOY_ENV);
const setting = (name, fallback) => process.env[name] ?? vars[name] ?? fallback;
const PORT = Number(setting("PORT", "8791"));
const TOURNAMENT_PORT = Number(setting("TOURNAMENT_PORT", "8792"));
const APP_PORT = Number(setting("APP_PORT", "8780"));
const TOURNAMENT = existsSync(join(ROOT, "tournament/server.js")) && setting("PPV_TOURNAMENT_URL", "off") !== "off";
const BACKUPS = process.env.PPV_BACKUP_DIR || join(homedir(), "pingpong-vision-backups");
const MAC_LABEL = "local.pingpong-vision";
const MAC_PLIST = join(homedir(), "Library/LaunchAgents", `${MAC_LABEL}.plist`);
const WIN_TASK = "PingPong Vision";
const WAIT_BY_HAND_S = Number(process.env.PPV_UPDATE_WAIT || 600);

const say = (t) => console.log(`\n== ${t}`);
const line = (t) => console.log(`  ${t}`);
function stop(why, ...more) {
  console.log(`\nSTOPPED: ${why}`);
  for (const m of more) line(m);
  console.log("  Nothing was changed.");
  process.exit(2);
}
// Windows PowerShell 5.1 started from PowerShell 7 inherits 7's PSModulePath and then cannot load its
// own modules (Get-FileHash in install.ps1 is "not recognized"), so it starts with its default path.
const PS_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"));
function run(cmd, args, { quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: quiet ? "pipe" : "inherit", encoding: "utf8", ...(cmd === "powershell" ? { env: PS_ENV } : {}) });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() || r.error?.message || "" };
}
const git = (...args) => run("git", args, { quiet: true });
const versionOf = (text) => { try { return JSON.parse(text).version || "?"; } catch { return "?"; } };
const powershell = (script) => run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { quiet: true });

async function answers(url, timeoutMs = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  }
}
const runningVersion = async () => {
  const body = await answers(`http://127.0.0.1:${PORT}/vision/api/update`);
  try { return body ? JSON.parse(body).version : null; } catch { return null; }
};

// ---------- 1. checks: nothing changes until all pass ----------
say("1/6 check this copy");
if (!existsSync(join(ROOT, "release.json"))) {
  stop("this is not a public install (no release.json).", "The command updates a copy cloned from the public repository; a development checkout updates with git.");
}
if (!git("rev-parse", "--is-inside-work-tree").ok) stop("this folder is not a git clone.", "Clone it again as in README: Install, then copy your settings over.");
const branch = git("symbolic-ref", "--short", "-q", "HEAD").out;
if (!branch) stop("this copy is not on a branch (a detached commit).", "Go back to the main branch: git checkout main");
const upstream = git("rev-parse", "--abbrev-ref", "@{u}");
if (!upstream.ok) stop(`branch ${branch} follows no remote branch.`, "Set it once: git branch --set-upstream-to=origin/main");
const changed = git("status", "--porcelain", "--untracked-files=no").out;
if (changed) {
  stop("this copy has local changes, which an update could overwrite.",
    ...changed.split("\n").map((l) => `changed: ${l.slice(3)}`),
    "See them: git diff    Keep them aside: git stash    Throw them away: git checkout -- .");
}
const OLD = git("rev-parse", "HEAD").out;
const OLD_SHORT = OLD.slice(0, 12);
const OLD_VERSION = versionOf(readFileSync(join(ROOT, "package.json"), "utf8"));
line(`now: v${OLD_VERSION} (${OLD_SHORT}) on ${branch}, follows ${upstream.out}`);
const fetched = run("git", ["fetch", "--tags", "--quiet"], { quiet: true });
if (!fetched.ok) stop("could not reach the repository (no internet?).", fetched.err);
const ahead = Number(git("rev-list", "--count", "@{u}..HEAD").out);
const behind = Number(git("rev-list", "--count", "HEAD..@{u}").out);
if (ahead > 0) stop(`this copy has ${ahead} commit(s) of its own that the public repository does not have.`, "See them: git log @{u}..HEAD");
if (behind === 0) {
  console.log(`\nAlready the newest: v${OLD_VERSION}. Nothing to do.`);
  process.exit(0);
}
const NEW_VERSION = versionOf(git("show", "@{u}:package.json").out);
line(`new: v${NEW_VERSION} (${behind} commit(s)). What changed: CHANGELOG.md or the Releases page`);
const wasRunning = (await answers(`http://127.0.0.1:${PORT}/healthz`)) !== null;

// ---------- how this PC runs it ----------
function serviceKind() {
  if (WIN) return powershell(`if (Get-ScheduledTask -TaskName '${WIN_TASK}' -ErrorAction SilentlyContinue) { 'task' }`).out === "task" ? "task" : "hand";
  if (MAC) return existsSync(MAC_PLIST) ? "launchagent" : "hand";
  return run("systemctl", ["--user", "cat", "pingpong-vision.service"], { quiet: true }).ok ? "systemd" : "hand";
}
const SERVICE = serviceKind();
const installLine = WIN ? "powershell -ExecutionPolicy Bypass -File install.ps1" : "bash install.sh";
const restartLine = {
  systemd: "./start.sh --restart",
  launchagent: `launchctl kickstart -k gui/${process.getuid?.() ?? "$(id -u)"}/${MAC_LABEL}`,
  task: `powershell -Command "Stop-ScheduledTask '${WIN_TASK}'; Start-ScheduledTask '${WIN_TASK}'"`,
  hand: `stop the app (Ctrl+C in its window) and start it again: ${existsSync(join(ROOT, "run.mjs")) ? "bun run.mjs" : "bun server.js"}`,
}[SERVICE];

// ---------- 2. backup ----------
say("2/6 back up the data and the settings");
const stampNow = new Date();
const pad = (n) => String(n).padStart(2, "0");
const STAMP = `${stampNow.getFullYear()}-${pad(stampNow.getMonth() + 1)}-${pad(stampNow.getDate())}_${pad(stampNow.getHours())}${pad(stampNow.getMinutes())}${pad(stampNow.getSeconds())}`;
const BACKUP = join(BACKUPS, STAMP);
const tournamentData = setting("PPV_TOURNAMENT_DATA", "") ? dirname(setting("PPV_TOURNAMENT_DATA", "")) : join(ROOT, "tournament/data");
const CONFIG_DIR = join(homedir(), ".config/pingpong-vision");
const items = [
  ["settings", CONFIG_DIR],
  ...(dirname(DEPLOY_ENV) === CONFIG_DIR ? [] : [["deploy.env", DEPLOY_ENV]]),
  ["tournament-data", tournamentData],
  ["rally-saves", setting("PPV_SAVE_DIR", join(homedir(), "pingpong-vision-saves"))],
].filter(([, src]) => existsSync(src));
mkdirSync(BACKUP, { recursive: true, mode: 0o700 });
const restoreLines = [];
try {
  for (const [name, src] of items) {
    cpSync(src, join(BACKUP, name), { recursive: true, preserveTimestamps: true });
    line(`${name}: ${src}`);
    const file = name === "deploy.env";
    restoreLines.push(WIN
      ? `Copy-Item -Recurse -Force "${join(BACKUP, name)}${file ? "" : "\\*"}" "${src}"`
      : file ? `cp -a "${join(BACKUP, name)}" "${src}"` : `cp -a "${join(BACKUP, name)}/." "${src}/"`);
  }
} catch (e) {
  stop(`the backup failed: ${e.message}`, `Free some space or set PPV_BACKUP_DIR, then run it again. Partial copy: ${BACKUP}`);
}
writeFileSync(join(BACKUP, "manifest.txt"), [
  `from v${OLD_VERSION} ${OLD}`,
  `to v${NEW_VERSION}`,
  `checkout ${ROOT}`,
  ...items.map(([name, src]) => `${name} <- ${src}`),
  "",
].join("\n"));
line(`copy: ${BACKUP}`);
if (!items.length) line("(no data folders yet: nothing but this note)");

function rollback(step, why) {
  console.log(`\nFAILED at ${step}: ${why}`);
  console.log(`  Your data was not touched by the update, and a copy is in ${BACKUP}`);
  console.log(`  To go back to v${OLD_VERSION} (${OLD_SHORT}), run:`);
  console.log(`    cd "${ROOT}"`);
  console.log(`    git reset --hard ${OLD}`);
  console.log(`    ${installLine}`);
  console.log(`    ${restartLine}`);
  if (restoreLines.length) {
    console.log("  Only if the data looks wrong too, put the copy back (with the app stopped):");
    for (const l of restoreLines) console.log(`    ${l}`);
  }
  process.exit(1);
}

// ---------- 3. get it ----------
say(`3/6 get v${NEW_VERSION}`);
const merged = git("merge", "--ff-only", "@{u}");
if (!merged.ok) stop(`git could not move to the new version: ${merged.err}`, `The copy in ${BACKUP} is not needed; delete it if you like.`);
line(`${OLD_SHORT} -> ${git("rev-parse", "--short=12", "HEAD").out}`);

// ---------- 4. install ----------
say("4/6 install");
const installed = WIN
  ? existsSync(join(ROOT, "install.ps1")) ? run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "install.ps1"]) : { ok: false, err: "no install.ps1 in this version" }
  : run("bash", ["install.sh"]);
if (!installed.ok) rollback("install", installed.err || "the installer stopped (see above)");

// ---------- 5. restart ----------
say("5/6 restart");
let restarted = { ok: true };
if (SERVICE === "systemd") restarted = run("bash", ["start.sh", "--restart"]);
else if (SERVICE === "launchagent") restarted = run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${MAC_LABEL}`]);
else if (SERVICE === "task") {
  restarted = powershell([
    `Stop-ScheduledTask '${WIN_TASK}' -ErrorAction SilentlyContinue`,
    `Get-NetTCPConnection -State Listen -LocalPort ${APP_PORT},${PORT},${TOURNAMENT_PORT} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    `Start-ScheduledTask '${WIN_TASK}'`,
  ].join("; "));
} else if (wasRunning) {
  line(`The app runs by hand, so ${restartLine}.`);
  line(`Waiting up to ${Math.round(WAIT_BY_HAND_S / 60)} min for v${NEW_VERSION} to answer (Ctrl+C stops waiting; the update itself is done).`);
} else {
  line(`The app was not running. Start it: ${existsSync(join(ROOT, "run.mjs")) ? "bun run.mjs" : "bun server.js"}`);
  done();
}
if (!restarted.ok) rollback("restart", restarted.err || "the restart command failed (see above)");
if (SERVICE !== "hand") line(`restarted (${SERVICE})`);

// ---------- 6. health ----------
say("6/6 check it answers");
const deadline = Date.now() + (SERVICE === "hand" ? WAIT_BY_HAND_S : 90) * 1000;
let seen = null;
while (Date.now() < deadline) {
  seen = await runningVersion();
  if (seen === NEW_VERSION && (await answers(`http://127.0.0.1:${PORT}/healthz`)) !== null) break;
  await Bun.sleep(1000);
}
if (seen !== NEW_VERSION) rollback("health check", seen ? `the app still answers as v${seen}` : `nothing answers on http://127.0.0.1:${PORT}/healthz`);
line(`camera app: /healthz 200, v${seen}`);
if (TOURNAMENT) {
  const state = await answers(`http://127.0.0.1:${TOURNAMENT_PORT}/api/state`, 5000);
  if ((await answers(`http://127.0.0.1:${TOURNAMENT_PORT}/healthz`)) === null || !state) rollback("health check", `the tournament app does not answer on port ${TOURNAMENT_PORT}`);
  line(`tournament app: /healthz 200, v${versionOf(state)}`);
}
done();

function done() {
  console.log(`\nUpdated v${OLD_VERSION} -> v${NEW_VERSION}. Backup: ${BACKUP}`);
  console.log(`  To go back later: cd "${ROOT}" && git reset --hard ${OLD} && ${installLine}, then ${restartLine}`);
  process.exit(0);
}
