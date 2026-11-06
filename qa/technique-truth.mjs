// Usage: bun qa/technique-truth.mjs [--evidence=<dir>] [--truth=<annotation repo dir>] -- build annotation truth.
// Annotation truth is deliberately separate from independent Commons agent labels.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root=resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const repository=resolve(opt("truth","TRUTH_REPO",resolve(import.meta.dir,"truth-repo")));
const shots=JSON.parse(readFileSync(`${root}/shots.json`));
const summaries=JSON.parse(readFileSync(`${root}/pipeline-summary.json`));
const techniqueMap={serve:"serve",loop:"attack",flick:"attack",block:"defence",push:"defence",lob:"defence"};
const sources={test_2_head:"test_2",test_2_portrait:"test_2",test_5_portrait:"test_5"};
const maxDeltaSeconds=.15;
const labels=[],unmatchedDetections=[],unmatchedAnnotations=[],summary=[],files=[];
for(const [clip,sourceVideo] of Object.entries(sources)) {
  const file=`data/raw/game_data/test/${sourceVideo}.json`;
  const text=readFileSync(`${repository}/${file}`,"utf8");
  if(!files.some(x=>x.path===file))files.push({path:file,sha256:createHash("sha256").update(text).digest("hex")});
  const s=summaries.find(x=>x.clip===clip);
  if(!s)throw new Error(`Missing pipeline result ${clip}`);
  const duration=s.frames/s.fps;
  const annotations=Object.entries(JSON.parse(text)).flatMap(([frame,raw])=>{
    const m=raw.split(/\s+/)[0].match(/^(left|right)_(forehand|backhand)_([a-z]+)$/);
    const t=Number(frame)/120;
    if(!m || t>=duration)return [];
    return [{frame:Number(frame),t,side:m[1]==="left"?"near":"far",hand:m[2]==="forehand"?"fore":"back",technique:m[3],type:techniqueMap[m[3]]??null,raw}];
  }).sort((a,b)=>a.frame-b.frame);
  const detected=shots.filter(x=>x.clip===clip);
  const pairs=[];
  for(const shot of detected)for(const annotation of annotations) {
    const deltaSeconds=shot.sourceT-annotation.t;
    if(shot.side===annotation.side && Math.abs(deltaSeconds)<=maxDeltaSeconds)pairs.push({shot,annotation,deltaSeconds});
  }
  pairs.sort((a,b)=>Math.abs(a.deltaSeconds)-Math.abs(b.deltaSeconds)||a.shot.id.localeCompare(b.shot.id)||a.annotation.frame-b.annotation.frame);
  const usedShots=new Set(),usedFrames=new Set();
  for(const {shot,annotation,deltaSeconds} of pairs) {
    if(usedShots.has(shot.id)||usedFrames.has(annotation.frame))continue;
    usedShots.add(shot.id);usedFrames.add(annotation.frame);
    labels.push({id:shot.id,clip,source:"extended-openttgames",sourceVideo,detectedT:shot.sourceT,annotationFrame:annotation.frame,annotationT:annotation.t,deltaSeconds,side:annotation.side,hand:annotation.hand,type:annotation.type,technique:annotation.technique,raw:annotation.raw});
  }
  unmatchedDetections.push(...detected.filter(x=>!usedShots.has(x.id)).map(x=>({id:x.id,clip,t:x.sourceT,side:x.side,reason:"No unused same-side stroke within 0.15 seconds"})));
  unmatchedAnnotations.push(...annotations.filter(x=>!usedFrames.has(x.frame)).map(x=>({clip,sourceVideo,...x})));
  summary.push({clip,sourceVideo,duration,detected:detected.length,annotated:annotations.length,matched:usedShots.size,unmatchedDetections:detected.length-usedShots.size,unmatchedAnnotations:annotations.length-usedFrames.size,unmappedTechniques:[...new Set(annotations.filter(x=>x.type===null).map(x=>x.technique))]});
}
labels.sort((a,b)=>a.id.localeCompare(b.id));
writeFileSync(`${root}/dataset-truth.json`,JSON.stringify({
  version:1,source:{name:"Extended OpenTTGames",repository:"https://github.com/moamal01/table_tennis_data",commit:execFileSync("git",["-C",repository,"rev-parse","HEAD"],{encoding:"utf8"}).trim(),license:"CC BY-NC-SA 4.0",annotationFiles:files},
  rules:{sourceFps:120,frameIndexBase:0,maxDeltaSeconds,matching:"Closest absolute time difference first, same side, one-to-one within each clip; deterministic ID/frame tie breaks",sideMap:{left:"near",right:"far"},timeMap:"test_2_head begins at original t=0; portrait copies are letterboxed/resampled with unchanged wall time; sourceT uses decoded source PTS",techniqueMap,unknownTechnique:"Retain hand/side and raw technique; type is null and excluded from type scoring",copies:"Each crop/copy is scored separately, never pooled as independent source videos"},
  summary,labels,unmatchedDetections,unmatchedAnnotations
},null,2)+"\n");
console.log(`TRUTH_DONE ${JSON.stringify(summary)}`);
