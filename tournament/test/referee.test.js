import { describe, expect, test } from 'bun:test';
import { addPoint, createTournament, derive } from '../public/engine.js';
import { MIN_TAP_GAP_MS, acceptTap, detectTransition, endOf, endOrder, endsChanged, isHoldRelease, sideOrder } from '../public/referee.js';

const make = () => createTournament({ name: 't', players: ['A,1001', 'B,1002', 'C,1003', 'D,1004'] });
const m1 = (t) => derive(t).matches.find((m) => m.id === 'm1');
const play = (t, side, n) => {
  for (let i = 0; i < n; i++) t = addPoint(t, 'm1', side, m1(t).points.length);
  return t;
};

describe('referee tap guard', () => {
  test('first tap is accepted, a second tap inside the gap is ignored, after the gap accepted', () => {
    expect(acceptTap(null, 1000)).toBe(true);
    expect(acceptTap(1000, 1000 + MIN_TAP_GAP_MS - 1)).toBe(false);
    expect(acceptTap(1000, 1000 + MIN_TAP_GAP_MS)).toBe(true);
  });
});

describe('hold-to-undo release', () => {
  test('the click from the press that fired the hold is swallowed, a later tap is not', () => {
    expect(isHoldRelease(1000, 1600)).toBe(true);
    expect(isHoldRelease(1700, 1600)).toBe(false);
    expect(isHoldRelease(1000, null)).toBe(false);
  });
});

describe('court side mapping', () => {
  test('court change swaps which player is on the left', () => {
    expect(sideOrder(false)).toEqual([0, 1]);
    expect(sideOrder(true)).toEqual([1, 0]);
  });
});

describe('result transitions', () => {
  test('a point inside a game is not a transition', () => {
    const t = play(make(), 0, 3);
    expect(detectTransition(m1(t), m1(play(t, 1, 1)))).toBe(null);
  });

  test('the point that ends a game reports the game result', () => {
    const t = play(make(), 0, 10);
    const tr = detectTransition(m1(t), m1(play(t, 0, 1)));
    expect(tr).toEqual({ type: 'game', matchId: 'm1', gameNo: 1, won: [1, 0], game: { a: 11, b: 0, winner: 0 } });
  });

  test('the point that ends the match reports the match winner', () => {
    const t = play(make(), 1, 21);
    const tr = detectTransition(m1(t), m1(play(t, 1, 1)));
    expect(tr.type).toBe('match');
    expect(tr.winner).toBe(1);
    expect(tr.won).toEqual([0, 2]);
  });

  test('an undo back across a game boundary is not reported as a new result', () => {
    const t = play(make(), 0, 11);
    const undone = { ...m1(t), score: { ...m1(play(make(), 0, 10)).score } };
    expect(detectTransition(m1(t), undone)).toBe(null);
  });
});

describe('card colour is the end, not the player', () => {
  test('after a game the same player\'s card turns to the other end colour and moves to the other end slot', () => {
    let t = make();
    expect([endOf(m1(t), 0), endOf(m1(t), 1)]).toEqual([0, 1]);
    expect(endOrder(m1(t), false)).toEqual([0, 1]);
    const before = m1(t);
    t = play(t, 0, 11);
    expect([endOf(m1(t), 0), endOf(m1(t), 1)]).toEqual([1, 0]);
    expect(endOrder(m1(t), false)).toEqual([1, 0]);
    expect(endOrder(m1(t), true)).toEqual([0, 1]);
    expect(endsChanged(before, m1(t))).toBe(true);
    expect(endsChanged(m1(t), m1(play(t, 1, 1)))).toBe(false);
  });
});
