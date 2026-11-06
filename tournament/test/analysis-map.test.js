import { expect, test } from 'bun:test';
import { mapPoint } from '../public/analysis.js';

// the sheet's bounce map shows the table as the camera sees it: a bounce near the far long edge (ty 1.13 of
// 1.525 m) is in the top half (y < 76.25 cm), one near the camera in the bottom half; tx keeps left to right
test('a far-side bounce is in the top half of the bounce map, a near-side one in the bottom half', () => {
  expect(mapPoint({ tx: 2.17, ty: 1.13 }).y).toBeLessThan(152.5 / 2);
  expect(mapPoint({ tx: 0.5, ty: 0.2 }).y).toBeGreaterThan(152.5 / 2);
  expect(mapPoint({ tx: 2.17, ty: 1.13 }).x).toBeCloseTo(217, 6);
});
