// Usage: bun qa/technique-dataset.mjs [--evidence=<dir>] [--videos=<dir>] -- extract frames for the public clips. Public clips only. Uses the same production processPixels path as phone-clips.mjs.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { Pipeline } from "../public/js/pipeline.js";

const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root = resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const videoRoot = resolve(opt("videos","VIDEOS_DIR",resolve(import.meta.dir,"../data/videos")));
mkdirSync(`${root}/frames`, { recursive: true });
const set = JSON.parse(readFileSync("qa/eval-set.json"));
const corners = name => set.videos.find(v => v.name === name).corners;
const clips = [
  { name: "test_2_head", path: "test_2_head.webm", corners: corners("test_2") },
  { name: "cozza", path: "commons/cozza.webm", corners: [[358,311],[615,320],[733,273],[551,268]].map(([x,y])=>({x,y})) },
  { name: "portrait_game", path: "commons/portrait_game.webm", corners: [[630,921],[1250,695],[150,865],[-500,1000]].map(([x,y])=>({x,y})) },
  { name: "landscape_game", path: "commons/landscape_game.webm" },
  { name: "training_480", path: "commons/training_480.webm" },
  { name: "test_2_portrait", path: "portrait/test_2_portrait.mp4" },
  { name: "test_5_portrait", path: "portrait/test_5_portrait.mp4" },
];
function ff(args) {
  const r = spawnSync("ffmpeg", ["-v","error","-threads","1",...args], {encoding:"utf8"});
  if (r.status) throw new Error(r.stderr);
}
function privacyFilter(clip) {
  // Conservative full-width head bands include both players and background people.
  // Public letterboxed copies put every head above the middle of the canvas.
  const fraction = clip.includes("portrait") ? .49 : clip === "training_480" ? .8 : clip === "landscape_game" ? .7 : clip === "test_2_head" ? .42 : .47;
  return `split[a][b];[b]crop=iw:trunc(ih*${fraction}/2)*2:0:0,gblur=sigma=24[heads];[a][heads]overlay=0:0,scale=960:-2`;
}
if (process.argv.includes("--extract")) {
  const shots = JSON.parse(readFileSync(`${root}/shots.json`)).filter(s => !process.argv.includes("--commons-only") || s.video.includes("/commons/"));
  for(const s of shots) for(const [key,t] of [["before",Math.max(0,s.sourceT-.3)],["hit",s.sourceT]]) {
    ff(["-ss",String(t),"-i",s.video,"-filter_complex",privacyFilter(s.clip),"-filter_complex_threads","1","-frames:v","1","-y",s.frames[key]]);
  }
  console.log(`FRAMES_DONE ${shots.length*2}`);
  process.exit(0);
}
if (process.argv.includes("--overview")) {
  for (const c of clips) {
    // Conservative full-frame blur for calibration previews, including bystanders.
    ff(["-ss","1","-i",`${videoRoot}/${c.path}`,"-vf","gblur=sigma=18,scale=640:-2","-filter_threads","1","-frames:v","1","-y",`${root}/frames/overview-${c.name}.jpg`]);
  }
  console.log("OVERVIEW_DONE");
  process.exit(0);
}
const overrides = JSON.parse(readFileSync(`${root}/calibration.json`));
const all = [], summaries = [];
for (const c of clips) {
  const video = `${videoRoot}/${c.path}`;
  const p = spawnSync("ffprobe",["-v","error","-select_streams","v:0","-show_frames","-show_streams","-show_format","-of","json",video], {encoding:"utf8",maxBuffer:32e6});
  if(p.status) throw new Error(p.stderr);
  const info = JSON.parse(p.stdout), stream = info.streams[0];
  const pts = info.frames.map(f => Number(f.best_effort_timestamp_time));
  const [num,den] = stream.avg_frame_rate.split("/").map(Number);
  const fps = num/den > 240 ? pts.length/Number(info.format.duration) : num/den;
  const shots = new Map(), states = {};
  const pipe = new Pipeline({ onEvent(e) {
    if(e.type === "shot" || e.type === "shotUpdate") shots.set(`${e.shot.side}:${e.shot.t}`,structuredClone(e.shot));
  }});
  pipe.setVideoSize(stream.width, stream.height);
  pipe.setCalibration(overrides[c.name]?.corners || c.corners);
  const proc = spawn("ffmpeg",["-v","error","-threads","1","-i",video,"-vf",`scale=${pipe.pw}:${pipe.ph}`,"-filter_threads","1","-fps_mode","passthrough","-f","rawvideo","-pix_fmt","rgba","-"]);
  let stderr = "";
  proc.stderr.on("data",b => stderr += b);
  const done = new Promise((resolve,reject)=>{proc.on("error",reject);proc.on("close",code=>code === 0 ? resolve() : reject(new Error(stderr)));});
  const frameSize = pipe.pw*pipe.ph*4;
  let buffer = Buffer.alloc(0), n = 0;
  console.log(`WORKING: ${c.name}`);
  for await(const chunk of proc.stdout) {
    buffer = Buffer.concat([buffer,chunk]);
    while(buffer.length >= frameSize) {
      const pixels = new Uint8ClampedArray(buffer.buffer.slice(buffer.byteOffset,buffer.byteOffset+frameSize));
      buffer = buffer.subarray(frameSize);
      pipe.processPixels(pixels,n/fps);
      states[pipe.tracking] = (states[pipe.tracking] || 0)+1;
      n++;
    }
  }
  await done;
  if(buffer.length || n !== pts.length) throw new Error(`Incomplete decode ${c.name}: ${n}/${pts.length}`);
  for(const shot of shots.values()) {
    const id = `${c.name}-${String(all.filter(s=>s.clip===c.name).length+1).padStart(3,"0")}`;
    const sourceT = pts[Math.min(pts.length-1,Math.round(shot.t*fps))];
    const framePaths = {before:`${root}/frames/${id}-before.jpg`,hit:`${root}/frames/${id}-hit.jpg`};
    all.push({id,clip:c.name,video,t:shot.t,sourceT,side:shot.side,stroke:shot.stroke,kind:shot.kind,speedKmh:shot.speedKmh,predicted:{hand:shot.stroke==="포핸드"?"fore":shot.stroke==="백핸드"?"back":null,type:shot.kind==="서브"?"serve":["스매시","드라이브"].includes(shot.kind)?"attack":["푸시","로빙"].includes(shot.kind)?"defence":null},frames:framePaths});
    for(const [key,t] of [["before",Math.max(0,sourceT-.3)],["hit",sourceT]]) {
      ff(["-ss",String(t),"-i",video,"-filter_complex",privacyFilter(c.name),"-filter_complex_threads","1","-frames:v","1","-y",framePaths[key]]);
    }
  }
  summaries.push({clip:c.name,frames:n,shots:shots.size,fps,corners:overrides[c.name]?.corners || c.corners,states});
  writeFileSync(`${root}/shots.json`,JSON.stringify(all,null,2)+"\n");
  writeFileSync(`${root}/pipeline-summary.json`,JSON.stringify(summaries,null,2)+"\n");
  console.log(`CLIP_DONE ${c.name} frames=${n} shots=${shots.size}`);
}
console.log(`DATASET_DONE shots=${all.length}`);
