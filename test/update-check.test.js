import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY_MS, createUpdateCheck, isNewer } from "../update-check.js";

let root;
let calls;
let clock;
const gh = (body, status = 200) => async (url, init) => {
  calls.push({ url, init });
  return new Response(JSON.stringify(body), { status });
};
const make = (opts = {}) => createUpdateCheck({
  root,
  env: {},
  envFile: join(root, "deploy.env"),
  cacheFile: join(root, "cache/update-check.json"),
  now: () => clock,
  ...opts,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ppv-update-"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.1.13" }));
  writeFileSync(join(root, "release.json"), JSON.stringify({ repo: "orientpine/pingpong-vision" }));
  calls = [];
  clock = 1_800_000_000_000;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("isNewer compares major, minor and patch as numbers", () => {
  expect(isNewer("1.1.14", "1.1.13")).toBe(true);
  expect(isNewer("v1.2.0", "1.1.13")).toBe(true);
  expect(isNewer("1.1.9", "1.1.13")).toBe(false);
  expect(isNewer("1.1.13", "1.1.13")).toBe(false);
  expect(isNewer("1.2.0-rc1", "1.1.13")).toBe(false);
});

test("a newer public release gives the line; the request is the public API with no user data", async () => {
  const s = await make({ fetch: gh({ tag_name: "v1.2.0" }) }).status();
  expect(s).toEqual({ version: "1.1.13", check: true, latest: "1.2.0", url: "https://github.com/orientpine/pingpong-vision/releases/tag/v1.2.0" });
  expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/orientpine/pingpong-vision/releases/latest"]);
  expect(calls[0].init.method ?? "GET").toBe("GET");
  expect(calls[0].init.body).toBeUndefined();
  expect(Object.keys(calls[0].init.headers).sort()).toEqual(["accept", "user-agent"]);
});

test("the same or an older release gives no line", async () => {
  expect((await make({ fetch: gh({ tag_name: "v1.1.13" }) }).status()).latest).toBeNull();
  rmSync(join(root, "cache"), { recursive: true });
  expect((await make({ fetch: gh({ tag_name: "v1.0.2" }) }).status()).latest).toBeNull();
});

test("at most one request a day, across restarts too", async () => {
  const fetch = gh({ tag_name: "v1.2.0" });
  const a = make({ fetch });
  await Promise.all([a.status(), a.status(), a.status()]);
  clock += DAY_MS - 1;
  await a.status();
  await make({ fetch }).status();
  expect(calls).toHaveLength(1);
  clock += 1;
  await make({ fetch }).status();
  expect(calls).toHaveLength(2);
});

test("a failure is quiet and also waits a day", async () => {
  const down = async (url) => { calls.push({ url }); throw new Error("offline"); };
  expect(await make({ fetch: down }).status()).toEqual({ version: "1.1.13", check: true, latest: null });
  await make({ fetch: down }).status();
  expect(calls).toHaveLength(1);
  clock += DAY_MS;
  const limited = make({ fetch: gh({ message: "API rate limit exceeded" }, 403) });
  expect((await limited.status()).latest).toBeNull();
  expect(calls).toHaveLength(2);
});

test("an answer that is not a version tag gives no line", async () => {
  expect((await make({ fetch: gh({ tag_name: "<script>" }) }).status()).latest).toBeNull();
});

test("a tree without release.json (development or production checkout) never asks", async () => {
  rmSync(join(root, "release.json"));
  const c = make({ fetch: gh({ tag_name: "v9.0.0" }) });
  expect(c.on).toBe(false);
  expect(await c.status()).toEqual({ version: "1.1.13", check: false });
  expect(calls).toHaveLength(0);
  expect(existsSync(join(root, "cache"))).toBe(false);
});

test("PPV_UPDATE_CHECK=off in deploy.env or the environment turns it off", async () => {
  writeFileSync(join(root, "deploy.env"), "PORT=8791\nPPV_UPDATE_CHECK=off   # no new-version line\n");
  expect(await make({ fetch: gh({ tag_name: "v9.0.0" }) }).status()).toEqual({ version: "1.1.13", check: false });
  rmSync(join(root, "deploy.env"));
  expect(await make({ env: { PPV_UPDATE_CHECK: "off" }, fetch: gh({ tag_name: "v9.0.0" }) }).status()).toEqual({ version: "1.1.13", check: false });
  expect(calls).toHaveLength(0);
});
