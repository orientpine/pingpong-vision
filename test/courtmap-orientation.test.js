import { expect, test } from "bun:test";
import { courtSvg } from "../public/js/ui.js";

// the map shows the table as the camera sees it: ty runs from the near long edge (0) to the far one (1.525),
// so a far-side spot is in the top half (svg y < 76.25) and a near-side spot in the bottom half
const H = 152.5;
const ringY = (svg) => Number(svg.match(/class="cm-ring[^"]*" cx="[\d.]+" cy="([\d.-]+)"/)[1]);
const standY = (svg, side) => Number(svg.match(new RegExp(`class="cm-stand cm-stand--${side}[^"]*" cx="[\\d.-]+" cy="([\\d.-]+)"`))[1]);

test("a bounce near the far long edge is drawn in the top half, one near the camera in the bottom half", () => {
  expect(ringY(courtSvg([{ tx: 2.17, ty: 1.13, side: "far" }], true, false))).toBeLessThan(H / 2);
  expect(ringY(courtSvg([{ tx: 0.5, ty: 0.2, side: "near" }], true, false))).toBeGreaterThan(H / 2);
});

test("player spots use the same up and down; left and right stay along the table", () => {
  const svg = courtSvg([], true, false, { near: { x: -0.4, y: 0.3 }, far: { x: 3.1, y: 1.3 } });
  expect(standY(svg, "far")).toBeLessThan(H / 2);
  expect(standY(svg, "near")).toBeGreaterThan(H / 2);
  const ring = courtSvg([{ tx: 2.17, ty: 1.13, side: "far" }], true, false).match(/class="cm-ring[^"]*" cx="([\d.]+)"/)[1];
  expect(Number(ring)).toBeCloseTo(217, 0);
});
