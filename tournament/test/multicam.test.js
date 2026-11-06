import { expect, test } from 'bun:test';
import { Multicam } from '../multicam.js';
import { cameraEnds, cameraMode } from '../public/role.js';

const first = { id: 'a'.repeat(64), matchId: 'm1' };
const second = { id: 'b'.repeat(64), matchId: 'm1' };

test('roster preserves attachment order and promotes the next camera on detach', () => {
  // Given
  const mc = new Multicam();
  mc.attach('a', first, 0);
  mc.attach('b', second, 1);
  // When
  mc.attach('a', first, 2);
  // Then
  expect(mc.roster().m1.map(({ id, primary }) => ({ id, primary }))).toEqual([
    { id: 'aaaaaaaa', primary: true }, { id: 'bbbbbbbb', primary: false },
  ]);
  mc.detach('a');
  expect(mc.primaryOf('m1')).toBe('b');
  expect(mc.roster().m1[0].primary).toBe(true);
});

test('a reconnect replaces the old connection and one connection belongs to one match', () => {
  // Given
  const mc = new Multicam();
  mc.attach('a', first, 0);
  // When
  mc.attach('new', first, 1);
  mc.attach('new', { ...first, matchId: 'm2' }, 2);
  // Then
  expect(mc.isAttached('a', 'm1')).toBe(false);
  expect(mc.roster().m1).toBeUndefined();
  expect(mc.isAttached('new', 'm2')).toBe(true);
});

test('sweep removes only cameras silent for more than fifteen seconds', () => {
  // Given
  const mc = new Multicam();
  mc.attach('a', first, 0);
  mc.attach('b', second, 1);
  // When
  mc.sweep(15001);
  // Then
  expect(mc.primaryOf('m1')).toBe('b');
});

test.each([{ matchId: 'm2', linked: true }, { matchId: 'm1', linked: false }])('hello detaches when membership ends: %j', (hello) => {
  // Given
  const mc = new Multicam();
  mc.attach('a', first, 0);
  // When
  mc.onCameraHello('a', hello);
  // Then
  expect(mc.roster()).toEqual({});
});

test('only the full primary id can write while cameras are attached', () => {
  // Given
  const mc = new Multicam();
  mc.attach('a', first, 0);
  mc.attach('b', second, 0);
  // When / Then
  expect(mc.canWritePoint(first.id, 'm1')).toBe(true);
  expect(mc.canWritePoint(second.id, 'm1')).toBe(false);
  expect(mc.canWritePoint(second.id, 'm2')).toBe(true);
  expect(mc.canWritePoint('unknown', 'm1')).toBe(false);
  expect(mc.canWritePoint(first.id.slice(0, 8), 'm1')).toBe(false);
  mc.detach('a');
  expect(mc.canWritePoint(first.id, 'm1')).toBe(false);
  mc.detach('b');
  expect(mc.canWritePoint(first.id, 'm1')).toBe(true);
});

test('status is fresh through fifteen seconds and touch does not freshen status', () => {
  // Given
  const mc = new Multicam();
  mc.attach('a', first, 0);
  mc.status('a', { ball: 'seen', active: true, rttMs: 20, clockMs: 10 }, 100);
  // When / Then
  mc.touch('a', 15100);
  expect(mc.roster().m1[0]).toEqual({ id: 'aaaaaaaa', primary: true, ball: 'seen', active: true, rttMs: 20, running: true, fresh: true, near: null, nearAuto: false, hold: false, ask: null });
  mc.sweep(15101);
  expect(mc.roster().m1[0].fresh).toBe(false);
});

test('a camera that has not reported running is listed but not live, and is primary only while none runs', () => {
  const mc = new Multicam();
  mc.attach('a', first, 0);
  mc.attach('b', second, 0);
  mc.touch('a', 1000);
  // neither has reported yet: both listed, neither live, the first attached is primary
  expect(mc.roster().m1.map((c) => [c.fresh, c.primary])).toEqual([[false, true], [false, false]]);
  // b runs (a still loading its model): b is live and becomes the primary
  mc.status('b', { ball: 'lost', active: false, running: true, rttMs: 20, clockMs: 10 }, 2000);
  expect(mc.roster().m1.map((c) => [c.fresh, c.primary])).toEqual([[false, false], [true, true]]);
  // a reports it is still calibrating: listed, not live
  mc.status('a', { ball: 'lost', active: false, running: false, rttMs: 20, clockMs: 10 }, 2500);
  expect(mc.roster().m1[0].fresh).toBe(false);
  // a runs: both live, a (attached first) is primary again
  mc.status('a', { ball: 'seen', active: false, running: true, rttMs: 20, clockMs: 10 }, 3000);
  expect(mc.roster().m1.map((c) => [c.fresh, c.primary])).toEqual([[true, true], [true, false]]);
});

test('camera mode labels follow the attached count', () => {
  // Given / When / Then
  expect(cameraMode([{ fresh: true }, { fresh: false }])).toEqual({ count: 1, merged: false, label: '카메라 1대' });
  expect(cameraMode([{ fresh: false }])).toBeNull();
  expect(cameraMode([])).toBeNull();
  expect(cameraMode([{}])).toEqual({ count: 1, merged: false, label: '카메라 1대' });
  expect(cameraMode([{}, {}])).toEqual({ count: 2, merged: true, label: '카메라 2대 합치기' });
});

test('roster exposes each camera end and automatic assignment when status changes', () => {
  // Given
  const mc = new Multicam();
  mc.attach('a', first, 0);
  mc.attach('b', second, 0);
  // When
  mc.status('a', { near: 0, nearAuto: true }, 1);
  mc.status('b', { near: 1, nearAuto: false }, 1);
  // Then
  expect(mc.roster().m1.map(({ near, nearAuto }) => ({ near, nearAuto }))).toEqual([
    { near: 0, nearAuto: true }, { near: 1, nearAuto: false },
  ]);
});

test('camera ends number live cameras primary first while preserving unknown ends and roster order', () => {
  // Given
  const cameras = [
    { fresh: true, primary: false, near: 0 },
    { fresh: false, primary: false, near: 1 },
    { fresh: true, primary: true, near: 0 },
    { fresh: true, primary: false, near: null },
    { fresh: true, primary: false, near: 1 },
  ];
  // When
  const ends = cameraEnds(cameras);
  // Then: the first number is the name-tag choice; the map retains both cameras at a disputed end.
  expect(ends).toEqual([[1, 2], [4]]);
});
