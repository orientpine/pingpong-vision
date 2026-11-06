// Usage: bun qa/label-tool.mjs [--evidence=<dir>] [--port=8897] -- local frame-correction tool (env: LABEL_DATA_DIR, LABEL_PORT); reads only the evidence dir.
import { readFile, writeFile, rename } from "node:fs/promises";
import { resolve, basename } from "node:path";

const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root = resolve(opt("evidence","LABEL_DATA_DIR",resolve(import.meta.dir,"evidence")));
const shots = JSON.parse(await readFile(`${root}/shots.json`, "utf8"));
const ids = new Set(shots.map(s => s.id));
const allowedFrames = new Set(shots.flatMap(s => Object.values(s.frames).map(v => basename(v))));
const hands = new Set(["fore", "back", "unsure"]);
const types = new Set(["serve", "attack", "defence", "unsure"]);
let human;
try { human = JSON.parse(await readFile(`${root}/labels-human.json`, "utf8")); }
catch (e) { if (e.code !== "ENOENT") throw e; human = []; }
let saving = Promise.resolve();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(opt("port","LABEL_PORT",8897)),
  maxRequestBodySize: 4096,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/") return new Response(Bun.file(new URL("./label-tool.html", import.meta.url)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (req.method === "GET" && url.pathname === "/api/data") {
      const agent = JSON.parse(await readFile(`${root}/labels-gpt.json`, "utf8"));
      return Response.json({ shots: shots.map(({id,clip,t,side,frames})=>({id,clip,t,side,frames:Object.fromEntries(Object.entries(frames).map(([k,v])=>[k,`/frames/${basename(v)}`]))})), agent, human });
    }
    if (req.method === "GET" && url.pathname.startsWith("/frames/")) {
      const name = decodeURIComponent(url.pathname.slice(8));
      if (!allowedFrames.has(name)) return new Response("Not found", {status:404});
      return new Response(Bun.file(`${root}/frames/${name}`), {headers:{"Cache-Control":"no-store"}});
    }
    if (req.method === "POST" && url.pathname === "/api/label") {
      if (req.headers.get("origin") !== url.origin) return new Response("Origin rejected", {status:403});
      if (!req.headers.get("content-type")?.startsWith("application/json")) return new Response("JSON required", {status:415});
      let row;
      try { row = await req.json(); } catch { return new Response("Invalid JSON", {status:400}); }
      if (!row || !ids.has(row.id) || !hands.has(row.hand) || !types.has(row.type)) return new Response("Invalid label", {status:400});
      const correction = {id:row.id,hand:row.hand,type:row.type,source:"human",reviewedAt:new Date().toISOString()};
      const task = saving.then(async () => {
        const updated = [...human.filter(x=>x.id !== row.id), correction].sort((a,b)=>a.id.localeCompare(b.id));
        const tmp = `${root}/labels-human.json.tmp`;
        await writeFile(tmp, JSON.stringify(updated,null,2)+"\n");
        await rename(tmp,`${root}/labels-human.json`);
        human = updated;
      });
      saving = task.catch(()=>{});
      await task;
      return Response.json(correction);
    }
    return new Response("Not found", {status:404});
  },
});
console.log(`LABEL_TOOL_READY http://${server.hostname}:${server.port}`);
