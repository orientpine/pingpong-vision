import { expect, test } from "bun:test";
import { withCodes } from "../qa/player-names.mjs";

const fakeFetch = (status) => { const calls = []; const f = async (url) => { calls.push(url); return { status }; }; f.calls = calls; return f; };

test("route answers 403 (new server): codes are appended, stable per index", async () => {
  const f = fakeFetch(403);
  expect(await withCodes("http://127.0.0.1:8960", ["A", "B", "C"], f)).toEqual(["A,1001", "B,1002", "C,1003"]);
  expect(f.calls).toEqual(["http://127.0.0.1:8960/api/players"]);
  expect(await withCodes("http://127.0.0.1:8960", ["A", "B", "C"], f)).toEqual(["A,1001", "B,1002", "C,1003"]);
});

test("route answers 200: codes are appended", async () => {
  expect(await withCodes("http://x", ["가"], fakeFetch(200))).toEqual(["가,1001"]);
});

test("route answers 404 (old server): names unchanged", async () => {
  const names = ["A", "B"];
  const out = await withCodes("http://x", names, fakeFetch(404));
  expect(out).toEqual(["A", "B"]);
  expect(out).not.toBe(names);
});
