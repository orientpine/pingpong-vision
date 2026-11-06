// Usage: bun qa/technique-pose-truth.mjs [--evidence=<dir>] -- rematch pose-on detections against pinned annotations.
// Rematch new production detections against the unchanged, already-pinned annotations.
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { resolve } from "node:path";
const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root=resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const base=JSON.parse(readFileSync(`${root}/dataset-truth.json`));
const shots=JSON.parse(readFileSync(`${root}/pose-on-shots.json`));
const runs=JSON.parse(readFileSync(`${root}/pose-on-summary.json`));
assert.deepEqual(runs.map(r=>r.clip).sort(),["cozza","test_2_head","test_2_portrait","test_5_portrait"]);
const labels=[],unmatchedDetections=[],unmatchedAnnotations=[],summary=[];
for(const old of base.summary) {
  const run=runs.find(r=>r.clip===old.clip);
  assert(run && run.pose==="1" && run.poseModel==="lite");
  const annotations=[
    ...base.labels.filter(l=>l.clip===old.clip).map(l=>({frame:l.annotationFrame,t:l.annotationT,side:l.side,hand:l.hand,type:l.type,technique:l.technique,raw:l.raw})),
    ...base.unmatchedAnnotations.filter(l=>l.clip===old.clip).map(({clip,sourceVideo,...a})=>a),
  ].sort((a,b)=>a.frame-b.frame);
  assert.equal(annotations.length,old.annotated);
  assert.equal(new Set(annotations.map(a=>a.frame)).size,annotations.length);
  const detected=shots.filter(s=>s.clip===old.clip);
  const candidates=[];
  for(const shot of detected)for(const a of annotations) {
    const delta=shot.sourceT-a.t;
    if(shot.side===a.side && Math.abs(delta)<=base.rules.maxDeltaSeconds)candidates.push({shot,a,delta});
  }
  candidates.sort((a,b)=>Math.abs(a.delta)-Math.abs(b.delta)||a.shot.id.localeCompare(b.shot.id)||a.a.frame-b.a.frame);
  const usedShots=new Set(),usedFrames=new Set();
  for(const {shot,a,delta} of candidates) {
    if(usedShots.has(shot.id)||usedFrames.has(a.frame))continue;
    usedShots.add(shot.id);usedFrames.add(a.frame);
    labels.push({id:shot.id,clip:old.clip,source:"extended-openttgames",sourceVideo:old.sourceVideo,detectedT:shot.sourceT,annotationFrame:a.frame,annotationT:a.t,deltaSeconds:delta,side:a.side,hand:a.hand,type:a.type,technique:a.technique,raw:a.raw});
  }
  unmatchedDetections.push(...detected.filter(s=>!usedShots.has(s.id)).map(s=>({id:s.id,clip:s.clip,t:s.sourceT,side:s.side,reason:"No unused same-side stroke within 0.15 seconds"})));
  unmatchedAnnotations.push(...annotations.filter(a=>!usedFrames.has(a.frame)).map(a=>({clip:old.clip,sourceVideo:old.sourceVideo,...a})));
  summary.push({...old,detected:detected.length,matched:usedShots.size,unmatchedDetections:detected.length-usedShots.size,unmatchedAnnotations:annotations.length-usedFrames.size});
}
labels.sort((a,b)=>a.id.localeCompare(b.id));
writeFileSync(`${root}/pose-on-truth.json`,JSON.stringify({version:1,run:"pose-on",source:base.source,rules:{...base.rules,annotationReference:"dataset-truth.json; same annotated events and evaluated intervals; new detections rematched"},summary,labels,unmatchedDetections,unmatchedAnnotations},null,2)+"\n");
console.log(`POSE_TRUTH_DONE ${JSON.stringify(summary)}`);
