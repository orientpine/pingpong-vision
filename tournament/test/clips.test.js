import { expect, test } from 'bun:test';
import { RuleError, addPoint, attachClip, createTournament, derive, undoPoint } from '../public/engine.js';

const url = `/vision/s/${'A'.repeat(43)}`;
const replacement = `/vision/s/${'B'.repeat(43)}`;
const make = () => addPoint(createTournament({ players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] }), 'm1', 0, 0);
const match = (t) => derive(t).matches[0];

test('attaches a clip without changing scoring when its point exists', () => {
  // Given
  const t = make();
  // When
  const next = attachClip(t, 'm1', 0, url);
  // Then
  expect(match(next).clips).toEqual({ 0: url });
  expect(match(next).score).toEqual(match(t).score);
  expect(match(t).clips).toEqual({});
});

test.each([-1, 1, 0.5, '0', null])('rejects clip index %p when it is outside existing points', (index) => {
  // Given
  const t = make();
  // When / Then
  expect(() => attachClip(t, 'm1', index, url)).toThrow(RuleError);
});

test.each([
  'https://example.com/video', '/other', `${url}/video`, `${url}?x=1`,
  `${url}\n`, `${url}\r`, '/vision/s/short', `/vision/s/${'A'.repeat(44)}`, null,
])('rejects clip URL %p when it is not an exact vision share path', (bad) => {
  // Given
  const t = make();
  // When / Then
  expect(() => attachClip(t, 'm1', 0, bad)).toThrow(RuleError);
});

test('replaces a clip when its point already has one', () => {
  // Given
  const t = attachClip(make(), 'm1', 0, url);
  // When
  const next = attachClip(t, 'm1', 0, replacement);
  // Then
  expect(match(next).clips).toEqual({ 0: replacement });
});

test('truncates clips when the last point is undone', () => {
  // Given
  const t = attachClip(addPoint(attachClip(make(), 'm1', 0, url), 'm1', 1, 1), 'm1', 1, replacement);
  // When
  const next = undoPoint(t, 'm1', 2);
  // Then
  expect(match(next).clips).toEqual({ 0: url });
  expect(match(next).points).toEqual([0]);
});
