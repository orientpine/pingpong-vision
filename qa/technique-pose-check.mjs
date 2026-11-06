// Usage: bun qa/technique-pose-check.mjs [--evidence=<dir>] -- verify pose-on evidence hashes and consistency.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root=resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const read=name=>JSON.parse(readFileSync(`${root}/${name}`,"utf8"));
const runs=read("pose-on-summary.json"),shots=read("pose-on-shots.json"),truth=read("pose-on-truth.json"),accuracy=read("accuracy.json");
const originalHashes={
  "shots.json":"381a31f3f7ed5efc679dcae8d1ac283e6990a39cb8d6cd2241ed4b916fe73a9c",
  "dataset-truth.json":"45a491cc33decbd8a3ba15eab489924382a3a278c3421e92fe589b2dc24a20f6",
  "labels-gpt.json":"89d7026992c7245ddf8d87c8553b6a85f7dd7238457bc1df04dad6d9c3c82990",
  "labels-claude.json":"684d92595db13155571deb551a1d1887a16da998bd32a0ff1cdb865a388307f7",
};
for(const [name,hash] of Object.entries(originalHashes))assert.equal(createHash("sha256").update(readFileSync(`${root}/${name}`)).digest("hex"),hash,`Original ${name} changed`);
assert.deepEqual(runs.map(r=>r.clip).sort(),["cozza","test_2_head","test_2_portrait","test_5_portrait"]);
const byId=new Map(shots.map(s=>[s.id,s]));
assert.equal(byId.size,shots.length);
for(const run of runs) {
  assert.equal(run.pose,"1");assert.equal(run.poseModel,"lite");assert.equal(run.poseEvery,1);assert.equal(run.step,1);
  const raw=read(`pose-on/${run.clip}.json`);
  assert(!raw.error);assert.equal(raw.delegate,"CPU");assert.equal(run.frames,raw.frames.length);
  const events=new Map();
  for(const e of raw.events)if(e.type==="shot"||e.type==="shotUpdate")events.set(`${e.shot.side}:${e.shot.t}`,e.shot);
  const clipShots=shots.filter(s=>s.clip===run.clip);
  assert.equal(events.size,clipShots.length);
  assert.equal(clipShots.filter(s=>s.predicted.hand).length,run.knownHand);
  for(const s of clipShots) {
    const actual=events.get(`${s.side}:${s.t}`);
    assert(actual);
    assert.equal(actual.stroke,s.stroke);
    assert.equal(actual.kind,s.kind);
    assert.equal(actual.speedKmh,s.speedKmh);
    assert.equal(s.predicted.hand,actual.stroke==="포핸드"?"fore":actual.stroke==="백핸드"?"back":null);
  }
}
assert(shots.some(s=>s.predicted.hand),"Pose rerun must produce real hand predictions");
for(const clip of ["test_2_portrait","test_5_portrait"])assert(runs.find(r=>r.clip===clip).knownHand>0,`${clip}: missing hand predictions`);
for(const hand of ["fore","back"])assert(shots.some(s=>s.predicted.hand===hand),`${hand}: missing real predictions`);
const baseline=read("dataset-truth.json");
for(const summary of truth.summary) {
  const expected=baseline.summary.find(r=>r.clip===summary.clip);
  assert.equal(summary.annotated,expected.annotated);
  assert.equal(summary.matched+summary.unmatchedAnnotations,summary.annotated);
  assert.equal(summary.matched+summary.unmatchedDetections,summary.detected);
}
const used=new Set();
for(const l of truth.labels) {
  assert(byId.has(l.id));assert.equal(byId.get(l.id).side,l.side);
  assert(Math.abs(l.deltaSeconds)<=truth.rules.maxDeltaSeconds);
  const key=`${l.clip}:${l.annotationFrame}`;assert(!used.has(key));used.add(key);
}
const expectedKeys=["fore-attack","fore-defence","fore-serve","back-attack","back-defence","back-serve"];
assert.deepEqual(Object.keys(accuracy),expectedKeys);
for(const key of expectedKeys) {
  const row=accuracy[key], support=truth.labels.filter(l=>`${l.hand}-${l.type}`===key);
  const predicted=truth.labels.filter(l=>`${byId.get(l.id).predicted.hand}-${byId.get(l.id).predicted.type}`===key);
  const tp=predicted.filter(l=>`${l.hand}-${l.type}`===key).length;
  assert.deepEqual(Object.keys(row),["precision","recall","n"]);
  assert.equal(row.n,support.length);
  assert.equal(row.recall,support.length ? tp/support.length : null);
  assert.equal(row.precision,support.length && predicted.length ? tp/predicted.length : null);
}
assert.equal(Object.values(accuracy).reduce((sum,r)=>sum+r.n,0),truth.labels.length);
const report=readFileSync(`${root}/accuracy.md`,"utf8");
assert.equal(report,readFileSync(new URL("./technique-accuracy.md",import.meta.url),"utf8"));
console.log(`POSE_CHECK_PASS clips=${runs.length} shots=${shots.length} matched=${truth.labels.length} knownHand=${shots.filter(s=>s.predicted.hand).length}; raw production stroke parity, original hashes, six-key metrics and n=0 verified`);
