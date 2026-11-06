import { describe, expect, test } from "bun:test";
import { arrowSpot, bodyBox, coverOf, endLines, panelEdge, panelLabelSpot } from "../public/js/end-marks.js";
import { insidePolygon } from "../public/js/geom.js";

// a side-on table on a 1280x720 screen, blue end on the left, red on the right
const corners = [{ x: 350, y: 520 }, { x: 420, y: 420 }, { x: 900, y: 420 }, { x: 980, y: 520 }];
const id = (p) => p;
const L = endLines(corners, id, 5);

describe("end marks", () => {
  test("end lines sit outside the table quad", () => {
    for (const side of ["near", "far"]) for (const p of L[side]) expect(insidePolygon(p, L.quad)).toBe(false);
  });

  test("cover: how much of a line is hidden and by which rect", () => {
    const panel = { x: 300, y: 380, w: 200, h: 200, id: "players" };
    expect(coverOf(L.near, [panel], 1280, 720)).toEqual({ covered: 1, by: "players" });
    expect(coverOf(L.far, [panel], 1280, 720)).toEqual({ covered: 0, by: null });
    expect(coverOf(L.far, [], 900, 720).by).toBe("off");
  });

  test("a panel marks the edge nearest the hidden line that stays off the table", () => {
    // covers the near end and reaches over the table: its right edge would sit on the table, and the label
    // reaching 70 px in from its left edge crosses the near side too, so the top edge carries the mark
    const panel = { x: 300, y: 380, w: 200, h: 200 };
    expect(insidePolygon({ x: 370, y: 500 }, L.quad)).toBe(true);
    const deep = { h: 30, v: 70 };
    expect(panelEdge(panel, L.near, L.quad, deep)).toBe("top");
    // over the red end with its nearest edge (left, facing the net) on the table, and the top label strip
    // (y 400-430) dipping into the table's corner: the nearest clear one is the bottom edge
    const over = { x: 880, y: 400, w: 200, h: 150 };
    expect(insidePolygon({ x: 880, y: 470 }, L.quad)).toBe(true);
    expect(insidePolygon({ x: 895, y: 428 }, L.quad)).toBe(true);
    expect(panelEdge(over, L.far, L.quad, deep)).toBe("bottom");
    // the edge line is off the table but the label strip under it is not: that edge is skipped
    const below = { x: 880, y: 390, w: 200, h: 200 };
    expect(insidePolygon({ x: 890, y: 390 }, L.quad)).toBe(false);
    expect(insidePolygon({ x: 900, y: 430 }, L.quad)).toBe(true);
    expect(panelEdge(below, L.far, L.quad, deep)).not.toBe("top");
    // and a panel whose nearest edge is clear takes that edge
    expect(panelEdge({ x: 990, y: 380, w: 200, h: 200 }, L.far, L.quad)).toBe("left");
  });

  test("a covering panel's label sits just outside its marked edge, off the table and other boxes", () => {
    const panel = { x: 300, y: 380, w: 200, h: 200, id: "players" };
    const button = { x: 360, y: 345, w: 60, h: 30 };
    const s = panelLabelSpot(panel, "top", L.quad, [button], { w: 70, h: 20, cw: 1280, ch: 720 });
    expect(s).not.toBeNull();
    expect(s.y + s.h).toBeLessThanOrEqual(panel.y);
    expect(s.x).toBeGreaterThanOrEqual(panel.x);
    expect(s.x + s.w).toBeLessThanOrEqual(panel.x + panel.w);
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) expect(insidePolygon({ x: s.x + (s.w * i) / 8, y: s.y + (s.h * j) / 4 }, L.quad)).toBe(false);
    expect(s.x < button.x + button.w && button.x < s.x + s.w && s.y < button.y + button.h && button.y < s.y + s.h).toBe(false);
    expect(s.dir).toEqual({ x: 0, y: 1 });
    // nowhere along that edge is free: no label (the border alone still marks the panel)
    expect(panelLabelSpot(panel, "top", L.quad, [{ x: 0, y: 0, w: 1280, h: 380 }], { w: 70, h: 20, cw: 1280, ch: 720 })).toBeNull();
  });

  test("an arrow tag lands off the table and off every avoid rect, pointing at its line", () => {
    const avoid = [{ x: 0, y: 600, w: 1280, h: 120 }];
    for (const side of ["near", "far"]) {
      const s = arrowSpot(L[side], L.quad, avoid, { w: 90, h: 20, cw: 1280, ch: 720 });
      expect(s).not.toBeNull();
      for (let i = 0; i <= 8; i++) for (let j = 0; j <= 4; j++) expect(insidePolygon({ x: s.x + (s.w * i) / 8, y: s.y + (s.h * j) / 4 }, L.quad)).toBe(false);
      expect(avoid.some((r) => s.x < r.x + r.w && r.x < s.x + s.w && s.y < r.y + r.h && r.y < s.y + s.h)).toBe(false);
      const m = { x: (L[side][0].x + L[side][1].x) / 2 - (s.x + s.w / 2), y: (L[side][0].y + L[side][1].y) / 2 - (s.y + s.h / 2) };
      expect(s.dir.x * m.x + s.dir.y * m.y).toBeGreaterThan(0);
    }
  });

  test("a player's body: the box around the shown joints and the foot ellipse, padded", () => {
    const pts = [{ x: 100, y: 50 }, null, { x: 140, y: 210 }, { x: 90.5, y: 120 }];
    expect(bodyBox(pts, 3)).toEqual({ x: 87, y: 47, w: 56, h: 166 });
    expect(bodyBox(pts, 3, [{ x: 60, y: 200, w: 120, h: 30 }, null])).toEqual({ x: 57, y: 47, w: 126, h: 186 });
    expect(bodyBox([null, null], 3)).toBeNull();
  });

  test("end labels keep off a player's body (landscape: the red end label sat on the player)", () => {
    // a panel right of the red end, a player standing over the middle of its top edge
    const panel = { x: 990, y: 400, w: 260, h: 200, id: "court" };
    const body = bodyBox([{ x: 1080, y: 250 }, { x: 1060, y: 330 }, { x: 1110, y: 330 }, { x: 1075, y: 420 }, { x: 1100, y: 420 }], 3);
    const opts = { w: 70, h: 20, cw: 1280, ch: 720 };
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    // without the body the label takes the middle of the edge, right on the player
    expect(hit(panelLabelSpot(panel, "top", L.quad, [], opts), body)).toBe(true);
    const s = panelLabelSpot(panel, "top", L.quad, [body], opts);
    expect(s).not.toBeNull();
    expect(hit(s, body)).toBe(false);
    expect(s.y + s.h).toBeLessThanOrEqual(panel.y);
    // the player fills the whole edge: no label (the panel border alone marks the end)
    expect(panelLabelSpot(panel, "top", L.quad, [{ x: 980, y: 200, w: 290, h: 220 }], opts)).toBeNull();
    // an arrow tag keeps off the body as well
    const a = arrowSpot(L.far, L.quad, [body], { w: 90, h: 20, cw: 1280, ch: 720 });
    expect(a).not.toBeNull();
    expect(hit(a, body)).toBe(false);
  });

  test("no free spot off the table: no tag", () => {
    expect(arrowSpot(L.near, L.quad, [{ x: 0, y: 0, w: 1280, h: 720 }], { w: 90, h: 20, cw: 1280, ch: 720 })).toBeNull();
  });
});
