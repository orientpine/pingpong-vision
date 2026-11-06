// Usage: bun qa/label-tool-check.mjs [--evidence=<dir>] -- browser (playwright) check of qa/label-tool.mjs; copies one shot into a scratch fixture.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";
import assert from "node:assert/strict";

const opt=(n,env,def)=>process.argv.find(a=>a.startsWith(`--${n}=`))?.slice(n.length+3)||process.env[env]||def;
const root = resolve(opt("evidence","EVIDENCE_DIR",resolve(import.meta.dir,"evidence")));
const fixture = new URL("./.label-tool-check/", import.meta.url).pathname;
const shots = JSON.parse(await readFile(`${root}/shots.json`,"utf8"));
const agent = JSON.parse(await readFile(`${root}/labels-gpt.json`,"utf8"));
const humanBefore = await readFile(`${root}/labels-human.json`,"utf8");
let child, browser;
async function serve(dir) {
  child = spawn("bun",["qa/label-tool.mjs"],{env:{...process.env,LABEL_DATA_DIR:dir,LABEL_PORT:"8898"},stdio:["ignore","pipe","inherit"]});
  await new Promise((resolve,reject)=>{
    let out="";
    const timer=setTimeout(()=>reject(new Error("Server startup timed out")),10000);
    child.on("error",e=>{clearTimeout(timer);reject(e)});
    child.on("exit",code=>{clearTimeout(timer);reject(new Error(`Server exited ${code}`))});
    child.stdout.on("data",b=>{out+=b;if(out.includes("LABEL_TOOL_READY")){clearTimeout(timer);resolve()}});
  });
}
async function stop() {
  if(child && child.exitCode === null){const done=once(child,"exit");child.kill();await done;}
}
try {
  browser=await chromium.launch({args:["--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
  await serve(root);
  const page=await browser.newPage();
  for(const [name,width,height] of [["desktop",1280,900],["mobile",390,844]]) {
    await page.setViewportSize({width,height});
    await page.goto("http://127.0.0.1:8898");
    await page.locator("#title").filter({hasText:/1\//}).waitFor();
    await page.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({path:`${root}/label-tool-${name}.png`,fullPage:true});
  }
  assert.equal((await (await fetch("http://127.0.0.1:8898/api/data")).json()).shots.length,shots.length);
  assert.equal((await fetch("http://127.0.0.1:8898/frames/not-allowed.jpg")).status,404);
  assert.equal((await fetch("http://127.0.0.1:8898/api/label",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).status,403);
  await stop();
  await mkdir(`${fixture}/frames`,{recursive:true});
  await writeFile(`${fixture}/shots.json`,JSON.stringify([shots[0]]));
  await writeFile(`${fixture}/labels-gpt.json`,JSON.stringify(agent.filter(a=>a.id===shots[0].id)));
  for(const p of Object.values(shots[0].frames))await copyFile(p,`${fixture}/frames/${basename(p)}`);
  await serve(fixture);
  await page.goto("http://127.0.0.1:8898");
  await page.locator("#title").filter({hasText:/1\/1/}).waitFor();
  await page.locator("#hand").selectOption("back");
  await page.locator("#type").selectOption("defence");
  const saved=page.waitForResponse(r=>r.url().endsWith("/api/label") && r.request().method()==="POST");
  await page.locator("#save").click();
  assert.equal((await saved).status(),200);
  assert.equal(JSON.parse(await readFile(`${fixture}/labels-human.json`,"utf8"))[0].hand,"back");
  await page.reload();
  await page.locator("#source").filter({hasText:"사람이 확인한 표시예요."}).waitFor();
  assert.equal(await page.locator("#hand").inputValue(),"back");
  const bad=await page.evaluate(async()=> (await fetch("/api/label",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:"unknown",hand:"fore",type:"attack"})})).status);
  assert.equal(bad,400);
  assert.equal(await readFile(`${root}/labels-human.json`,"utf8"),humanBefore);
  console.log(`LABEL_TOOL_CHECK_PASS shots=${shots.length} desktop+mobile render, isolated correction persistence, invalid-input checks; actual human labels unchanged`);
} finally {
  await browser?.close();
  await stop();
  await rm(fixture,{recursive:true,force:true});
}
