import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { courtSvg, endColourVar } from "../public/js/ui.js";

// The court map draws the table's two ends (short edges) in their end colours: near (MY end, left) takes
// --c-me, far (right) --c-opp, and ui.js sets those two from each end's colour every frame.
const css = readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
const strokeOf = (cls) => css.match(new RegExp(`\\.${cls}\\s*\\{[^}]*stroke:\\s*([^;]+);`))?.[1].trim();
const ends = (svg) => [...svg.matchAll(/<line class="cm-end cm-end--(near|far)" x1="([\d.]+)" y1="0" x2="([\d.]+)" y2="([\d.]+)"\/>/g)]
  .map(([, side, x1, x2, y2]) => ({ side, x1: +x1, x2: +x2, y2: +y2 }));
const table = (svg) => svg.match(/<rect class="cm-table" x="0" y="0" width="([\d.]+)" height="([\d.]+)"\/>/).slice(1).map(Number);

describe("court map ends", () => {
  test("both short edges are drawn, near on the left and far on the right, live and in the history map", () => {
    for (const svg of [courtSvg([], true, false, { near: null, far: null }), courtSvg([], false, false), courtSvg([], true, true)]) {
      const [w, h] = table(svg);
      expect(ends(svg)).toEqual([{ side: "near", x1: 0, x2: 0, y2: h }, { side: "far", x1: w, x2: w, y2: h }]);
    }
  });

  test("each end takes its own end colour: near --c-me, far --c-opp", () => {
    expect(strokeOf("cm-end--near")).toBe("var(--c-me)");
    expect(strokeOf("cm-end--far")).toBe("var(--c-opp)");
  });

  test("the colour follows the end, and swapping the end colours swaps the two ends", () => {
    const vars = (players) => ({ me: endColourVar(players.near.end), opp: endColourVar(players.far.end) });
    expect(vars({ near: { end: 0 }, far: { end: 1 } })).toEqual({ me: "var(--c-blue)", opp: "var(--c-red)" });
    // ⇄ / settings: near is now the red end
    expect(vars({ near: { end: 1 }, far: { end: 0 } })).toEqual({ me: "var(--c-red)", opp: "var(--c-blue)" });
  });
});
