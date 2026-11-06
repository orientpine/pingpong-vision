// Saved rally clips from before clip-retime.js moved onto their camera times, with a backup first and a way back.
//   bun scripts/retime-saves.mjs --dir=<saves dir>                          list what would change (nothing written)
//   bun scripts/retime-saves.mjs --dir=<saves dir> --apply --backup=<new dir> [--only=<id,id>]
//   bun scripts/retime-saves.mjs --dir=<saves dir> --restore=<backup dir>
// --apply copies every clip it will touch to <backup>/<id>/ and writes <backup>/SHA256SUMS before changing
// anything, then retimes, then checks each clip: same picture count, length = the camera's, every picture
// decodes. <backup>/report.json lists each clip. --restore checks SHA256SUMS and puts the originals back.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodedPictures, plan } from "../clip-retime.js";
import { retimeSaved } from "../save-server.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)).map(([k, v]) => [k, v ?? true]));
const dir = args.dir;
if (!dir || !existsSync(dir)) throw new Error("--dir=<saves dir> is required");
const ID_RE = /^[A-Za-z0-9_-]{43}$/;
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const times = (f) => {
  const r = spawnSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", f], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim().split("\n").filter(Boolean).map(Number) : null;
};
const videoOf = (d) => readdirSync(d).find((n) => n.startsWith("video."));
const trackOf = (d) => (existsSync(join(d, "overlay.json.gz")) ? JSON.parse(new TextDecoder().decode(Bun.gunzipSync(readFileSync(join(d, "overlay.json.gz"))))) : null);

if (args.restore) {
  const b = args.restore;
  const sums = readFileSync(join(b, "SHA256SUMS"), "utf8").trim().split("\n").map((l) => l.split("  "));
  for (const [h, rel] of sums) if (sha(join(b, rel)) !== h) throw new Error(`backup changed: ${rel}`);
  const ids = [...new Set(sums.map(([, rel]) => rel.split("/")[0]))];
  for (const id of ids) {
    const d = join(dir, id);
    if (existsSync(d)) for (const f of readdirSync(d)) rmSync(join(d, f));
    cpSync(join(b, id), d, { recursive: true });
  }
  console.log(`RESTORED ${ids.length} clips from ${b}`);
  process.exit(0);
}

const only = args.only ? new Set(args.only.split(",")) : null;
const rows = [];
for (const id of readdirSync(dir).filter((n) => ID_RE.test(n) && (!only || only.has(n)))) {
  const d = join(dir, id);
  const v = videoOf(d);
  const track = trackOf(d);
  if (!v || !track) { rows.push({ id, skip: !v ? "no-video" : "no-track" }); continue; }
  if (track.meta?.retimed) { rows.push({ id, skip: "done" }); continue; }
  const p = plan(track, times(join(d, v)));
  rows.push(p.skip ? { id, skip: p.skip } : { id, video: v, pictures: p.ms.length, shiftMs: p.shiftMs, lengthMs: p.ms.at(-1) });
}
const todo = rows.filter((r) => !r.skip);
if (!args.apply) {
  for (const r of rows) console.log(r.skip ? `SKIP ${r.id} ${r.skip}` : `WOULD ${r.id} pictures=${r.pictures} shiftMs=${r.shiftMs}`);
  console.log(`PLAN ${todo.length} of ${rows.length} clips`);
  process.exit(0);
}
const b = args.backup;
if (!b || existsSync(b)) throw new Error("--backup=<a new directory> is required with --apply");
mkdirSync(b, { recursive: true, mode: 0o700 });
const sums = [];
for (const r of todo) {
  cpSync(join(dir, r.id), join(b, r.id), { recursive: true });
  for (const f of readdirSync(join(b, r.id))) sums.push(`${sha(join(b, r.id, f))}  ${r.id}/${f}`);
}
writeFileSync(join(b, "SHA256SUMS"), `${sums.join("\n")}\n`, { mode: 0o600 });
for (const r of todo) {
  const d = join(dir, r.id);
  const videoPath = join(d, r.video);
  const type = r.video.endsWith(".mp4") ? "video/mp4" : "video/webm";
  const before = times(videoPath).length;
  const moved = await retimeSaved(d, videoPath, type, readFileSync(join(d, "overlay.json.gz")));
  if (moved.skip) { r.result = `skip:${moved.skip}`; continue; }
  writeFileSync(join(d, "overlay.json.gz"), moved.gz, { mode: 0o600 });
  const record = JSON.parse(readFileSync(join(d, "record.json"), "utf8"));
  writeFileSync(join(d, "record.json"), JSON.stringify({ ...record, videoBytes: statSync(videoPath).size, overlayBytes: moved.gz.length, retime: { pictures: moved.pictures, shiftMs: moved.shiftMs } }), { mode: 0o600 });
  const after = times(videoPath);
  // every picture decoded at its own time ("-f null" forces 60 fps and warned on clean phone clips)
  const dec = await decodedPictures(videoPath);
  const lengthMs = Math.round((after.at(-1) - after[0]) * 1000);
  if (after.length === before && Math.abs(lengthMs - r.lengthMs) <= 1 && !dec.error && dec.pictures === before) {
    r.result = "ok";
    continue;
  }
  // a clip that fails the check goes back to its original at once, from the backup taken above
  for (const f of readdirSync(join(b, r.id))) cpSync(join(b, r.id, f), join(d, f));
  r.result = `restored: count ${before}->${after.length} length ${lengthMs}/${r.lengthMs} decoded ${dec.pictures}${dec.error ? ` (${dec.error.slice(0, 80)})` : ""}`;
}
writeFileSync(join(b, "report.json"), JSON.stringify(rows, null, 1), { mode: 0o600 });
for (const r of rows) console.log(r.skip ? `SKIP ${r.id} ${r.skip}` : `${r.result === "ok" ? "OK" : r.result.startsWith("restored") ? "RESTORED" : "SKIP"} ${r.id} ${r.result} pictures=${r.pictures} shiftMs=${r.shiftMs}`);
console.log(`APPLIED ${todo.filter((r) => r.result === "ok").length} of ${todo.length}; backup ${b} (${sums.length} files in SHA256SUMS); undo: bun scripts/retime-saves.mjs --dir=${dir} --restore=${b}`);
