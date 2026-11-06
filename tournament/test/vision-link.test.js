import { expect, test } from 'bun:test';
import { STALE_MS, presenceOf } from '../vision-link.js';

const id = 'a'.repeat(64);

test('a camera that stopped saying hello shows as offline', () => {
  // Given
  const cams = new Map([[id, { online: true, lastSeen: 1000, mode: 'running', matchId: 'm1', linked: true }]]);
  // When / Then
  expect(presenceOf(cams, 1000 + STALE_MS - 1)[0].online).toBe(true);
  expect(presenceOf(cams, 1000 + STALE_MS)[0].online).toBe(false);
});

test('presence carries no approval any more: a camera is linked by the PIN or not at all', () => {
  // Given
  const cams = new Map([[id, { online: true, lastSeen: 1000, mode: 'intro', matchId: null, linked: false }]]);
  // When
  const [c] = presenceOf(cams, 1000);
  // Then
  expect(c).toEqual({ id, online: true, mode: 'intro', matchId: null, linked: false, lastSeen: 1000 });
});
