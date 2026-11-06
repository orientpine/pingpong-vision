// Usage: bun qa/technique-verify.mjs [--evidence=<dir>] [--videos=<dir>] [--truth=<annotation repo dir>] -- consistency checks on the evidence files.
import { readFile, stat } from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root = resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const videoRoot = resolve(opt("videos","VIDEOS_DIR",resolve(import.meta.dir,"../data/videos")));
const truthRepo = resolve(opt("truth","TRUTH_REPO",resolve(import.meta.dir,"truth-repo")));
const load = async name => JSON.parse(await readFile(`${root}/${name}`, "utf8"));
const shots = await load("shots.json");
const labels = await load("labels-gpt.json");
const human = await load("labels-human.json");
const summaries = await load("pipeline-summary.json");
const truth = await load("dataset-truth.json");
const annotationFiles = new Map();
for(const file of truth.source.annotationFiles) {
  const text=await readFile(`${truthRepo}/${file.path}`,"utf8");
  assert.equal(createHash("sha256").update(text).digest("hex"),file.sha256);
  annotationFiles.set(file.path,JSON.parse(text));
}
const ids = new Set(shots.map(s=>s.id));
assert.equal(ids.size,shots.length,"Shot IDs must be unique");
const commonsShots = shots.filter(s=>s.video.includes("/commons/"));
assert.equal(labels.length,commonsShots.length,"One independent agent label per Commons shot");
assert.equal(new Set(labels.map(l=>l.id)).size,commonsShots.length);
for(const l of labels) {
  assert(commonsShots.some(s=>s.id===l.id));
  assert(["fore","back","unsure"].includes(l.hand));
  assert(["serve","attack","defence","unsure"].includes(l.type));
  assert.equal(l.source,"agent");
}
const matched = new Set();
for(const l of truth.labels) {
  assert(ids.has(l.id));
  assert(!commonsShots.some(s=>s.id===l.id));
  assert.equal(l.source,"extended-openttgames");
  assert(Math.abs(l.deltaSeconds)<=truth.rules.maxDeltaSeconds);
  assert.equal(shots.find(s=>s.id===l.id).side,l.side);
  assert.equal(l.annotationT,l.annotationFrame/120);
  assert.equal(annotationFiles.get(`data/raw/game_data/test/${l.sourceVideo}.json`)[l.annotationFrame],l.raw);
  const [side,hand,technique]=l.raw.split(/\s+/)[0].split("_");
  assert.equal(l.side,truth.rules.sideMap[side]);
  assert.equal(l.hand,hand==="forehand"?"fore":"back");
  assert.equal(l.type,truth.rules.techniqueMap[technique]??null);
  const key=`${l.clip}:${l.annotationFrame}`;
  assert(!matched.has(key),"An annotation must not match two detections in one clip");
  matched.add(key);
}
assert.equal(truth.labels.length+truth.unmatchedDetections.length,shots.length-commonsShots.length);
assert.equal(human.length,0,"Nobody has reviewed this dataset");
for(const s of shots) {
  assert(s.video.startsWith(videoRoot+"/"));
  assert(!s.video.includes("owner"));
  assert(Number.isFinite(s.t) && Number.isFinite(s.sourceT));
  for(const p of Object.values(s.frames)){
    assert(p.startsWith(`${root}/frames/`));
    assert((await stat(p)).size>0,p);
  }
}
for(const s of summaries)assert.equal(s.shots,shots.filter(x=>x.clip===s.clip).length);
const counts = summaries.map(s=>({clip:s.clip,frames:s.frames,shots:s.shots,hand:Object.fromEntries(["fore","back","unsure"].map(k=>[k,labels.filter(l=>l.id.startsWith(`${s.clip}-`) && l.hand===k).length])),type:Object.fromEntries(["serve","attack","defence","unsure"].map(k=>[k,labels.filter(l=>l.id.startsWith(`${s.clip}-`) && l.type===k).length]))}));
console.log(JSON.stringify(counts,null,2));
console.log(`DATASET_FILES_PASS shots=${shots.length} agentLabels=${labels.length} datasetMatches=${truth.labels.length} frames=${shots.length*2} human=${human.length}`);
const missing = summaries.filter(s=>s.shots===0).map(s=>s.clip);
console.log(missing.length ? `COVERAGE_UNMET zero-shot clips=${missing.join(",")}` : "COVERAGE_PASS");
