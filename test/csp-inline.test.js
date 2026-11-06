import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

// The server's Content-Security-Policy allows scripts from this origin only (script-src 'self'), so an
// inline <script> in a page never runs (the language boot script once did not, and the camera pages
// stayed lang="ko"). Every script tag in the pages and in the share page the save server writes has a src.
const root = new URL("..", import.meta.url).pathname;
const inline = (src) => [...src.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1])).map((m) => m[0]);

test("the CSP still forbids inline scripts", () => {
  expect(readFileSync(`${root}server.js`, "utf8")).toContain(`"script-src 'self' 'wasm-unsafe-eval'"`);
});

test("no page and no server-written page has an inline script", () => {
  const pages = readdirSync(`${root}public`).filter((f) => f.endsWith(".html")).map((f) => [f, readFileSync(`${root}public/${f}`, "utf8")]);
  pages.push(["save-server.js", readFileSync(`${root}save-server.js`, "utf8")]);
  expect(pages.flatMap(([f, src]) => inline(src).map((tag) => `${f}: ${tag}`))).toEqual([]);
});
