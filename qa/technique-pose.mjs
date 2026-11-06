// Usage: bun qa/technique-pose.mjs [--evidence=<dir>] [--videos=<dir>] -- pose-on browser run (playwright).
// Gated browser run of the existing, unmodified qa/eval.js; no application save server.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root=resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const repo=resolve(import.meta.dir,"..");
const videos=resolve(opt("videos","VIDEOS_DIR",resolve(import.meta.dir,"../data/videos")));
const prior=JSON.parse(readFileSync(`${root}/pipeline-summary.json`));
const paths={test_2_head:"test_2_head.webm",cozza:"commons/cozza.webm",portrait_game:"commons/portrait_game.webm",landscape_game:"commons/landscape_game.webm",training_480:"commons/training_480.webm",test_2_portrait:"portrait/test_2_portrait.mp4",test_5_portrait:"portrait/test_5_portrait.mp4"};
const out=`${root}/pose-on`;
mkdirSync(out,{recursive:true});
const vendor=resolve(repo,"node_modules/@mediapipe/tasks-vision");
const flush='flush(t,e){if(this.error)e?.("net-send-failed")';
const source=readFileSync(`${vendor}/vision_bundle.mjs`,"utf8");
if(source.split(flush).length!==2)throw new Error("Unexpected MediaPipe bundle logger");
const bundle=source.replace(flush,`flush(t,e){this.i=[];return void t?.();${flush.slice("flush(t,e){".length)}`);
const types={js:"text/javascript",mjs:"text/javascript",html:"text/html",wasm:"application/wasm",task:"application/octet-stream",mp4:"video/mp4",webm:"video/webm"};
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(req) {
  const url=new URL(req.url);
  let p=decodeURIComponent(url.pathname);
  if(p.includes(".."))return new Response(null,{status:404});
  let file;
  if(p.startsWith("/clips/")) {
    const name=p.slice(7);
    if(!(name in paths))return new Response(null,{status:404});
    file=`${videos}/${paths[name]}`;
  } else if(p.startsWith("/vendor/mediapipe/"))file=`${vendor}/${p.slice(18)}`;
  else if(p.startsWith("/qa/"))file=`${repo}${p}`;
  else if(p.startsWith("/js/") || p.startsWith("/models/"))file=`${repo}/public${p}`;
  else return new Response(null,{status:404});
  const body=file===`${vendor}/vision_bundle.mjs` ? new Blob([bundle]) : Bun.file(file);
  if(typeof body.exists==="function" && !(await body.exists()))return new Response(null,{status:404});
  const headers={"Content-Type":types[file.split(".").pop()]||"application/octet-stream","Accept-Ranges":"bytes"};
  const range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.get("range")||"");
  if(range) {
    const start=Number(range[1]),end=range[2]?Math.min(Number(range[2]),body.size-1):body.size-1;
    if(start> end ||start>=body.size)return new Response(null,{status:416});
    return new Response(body.slice(start,end+1),{status:206,headers:{...headers,"Content-Range":`bytes ${start}-${end}/${body.size}`}});
  }
  return new Response(body,{headers});
}});
let browser;
const summaries=[],shots=[];
try {
  browser=await chromium.launch({args:["--use-angle=swiftshader","--enable-unsafe-swiftshader","--autoplay-policy=no-user-gesture-required"]});
  const priority=["test_2_portrait","test_5_portrait"];
  const ordered=[...prior.filter(c=>!priority.includes(c.clip) && existsSync(`${out}/${c.clip}.json`)),...priority.map(name=>prior.find(c=>c.clip===name)),...prior.filter(c=>!priority.includes(c.clip) && !existsSync(`${out}/${c.clip}.json`))];
  for(const c of ordered) {
    let result;
    const cached=existsSync(`${out}/${c.clip}.json`);
    if(cached) {
      result=JSON.parse(readFileSync(`${out}/${c.clip}.json`,"utf8"));
      if(result.error || !Array.isArray(result.events) || !Array.isArray(result.frames))throw new Error(`Invalid cached pose result: ${c.clip}`);
      console.log(`POSE_CLIP_REUSED ${c.clip}`);
    } else {
    console.log(`WORKING: pose-lite ${c.clip}`);
    const page=await browser.newPage();
    // Network is loopback-only, including model/wasm requests.
    await page.route("**/*",route=>new URL(route.request().url()).hostname==="127.0.0.1" ? route.continue() : route.abort());
    let timer;
    const complete=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error(`Pose evaluation timed out: ${c.clip}`)),1200000);
      page.on("pageerror",reject);
      page.exposeFunction("__poseFinished",resolve).then(()=>page.addInitScript(()=>{
        let result;
        Object.defineProperty(window,"__result",{get(){return result},set(value){result=value;window.__poseFinished(value)}});
      })).then(async()=>{
        const q=new URLSearchParams({video:`/clips/${c.clip}`,srcFps:String(c.fps),step:"1",pose:"1",poseModel:"lite",numPoses:"2",poseEvery:"1",delegate:"CPU",procWidth:"640",corners:JSON.stringify(c.corners)});
        await page.goto(`http://127.0.0.1:${server.port}/qa/eval.html?${q}`);
      }).catch(reject);
    });
    try {result=await complete;}finally{clearTimeout(timer);}
    if(result.error)throw new Error(result.error);
    writeFileSync(`${out}/${c.clip}.json`,JSON.stringify(result)+"\n");
    await page.close();
    }
    const latest=new Map();
    for(const e of result.events)if(e.type==="shot"||e.type==="shotUpdate")latest.set(`${e.shot.side}:${e.shot.t}`,e.shot);
    let i=0;
    for(const s of latest.values())shots.push({
      id:`pose-${c.clip}-${String(++i).padStart(3,"0")}`,clip:c.clip,video:`${videos}/${paths[c.clip]}`,t:s.t,sourceT:s.t,side:s.side,
      stroke:s.stroke,kind:s.kind,speedKmh:s.speedKmh,predicted:{hand:s.stroke==="포핸드"?"fore":s.stroke==="백핸드"?"back":null,type:s.kind==="서브"?"serve":["스매시","드라이브"].includes(s.kind)?"attack":["푸시","로빙"].includes(s.kind)?"defence":null},
    });
    const row={clip:c.clip,frames:result.frames.length,fps:c.fps,duration:result.frames.length/c.fps,shots:latest.size,pose:"1",poseModel:"lite",poseEvery:1,step:1,delegate:result.delegate,framesAnyPose:result.frames.filter(f=>f.poses>0).length,framesBothPoses:result.frames.filter(f=>f.poses===2).length,knownHand:shots.filter(s=>s.clip===c.clip&&s.predicted.hand).length,wallMs:result.wallMs};
    summaries.push(row);
    writeFileSync(`${root}/pose-on-shots.json`,JSON.stringify(shots,null,2)+"\n");
    writeFileSync(`${root}/pose-on-summary.json`,JSON.stringify(summaries,null,2)+"\n");
    console.log(`POSE_CLIP_DONE ${JSON.stringify(row)}`);
  }
  console.log(`POSE_DATASET_DONE clips=${summaries.length} shots=${shots.length} knownHand=${shots.filter(s=>s.predicted.hand).length}`);
}finally {
  await browser?.close();
  server.stop(true);
}
