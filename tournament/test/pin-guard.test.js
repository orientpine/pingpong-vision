import { expect, test } from 'bun:test';
import { GLOBAL_FAILS, GLOBAL_MAX_LOCK_MS, LOCK_MS, PinGuard } from '../pin-guard.js';

const clock = () => {
  const c = { t: 1_000_000 };
  c.now = () => c.t;
  return c;
};

const flood = (g, tag) => {
  for (let i = 0; i < GLOBAL_FAILS; i++) expect(g.check(`${tag}-${i}`, false).status).toBe(403);
};

test('one device: five misses lock only it for one minute, then it may try again', () => {
  const c = clock();
  const g = new PinGuard({ now: c.now });
  for (let i = 0; i < 5; i++) expect(g.check('phone', false).status).toBe(403);
  expect(g.check('phone', true).status).toBe(429);
  expect(g.check('friend', true).ok).toBe(true);
  c.t += LOCK_MS;
  expect(g.check('phone', true).ok).toBe(true);
});

test('misses older than a minute do not add up to the global stop', () => {
  const c = clock();
  const g = new PinGuard({ now: c.now });
  for (let i = 0; i < GLOBAL_FAILS - 1; i++) g.check(`a-${i}`, false);
  c.t += 60_001;
  g.check('late', false);
  expect(g.check('new-phone', true).ok).toBe(true);
});

test('the global stop doubles while the guessing goes on, tops out at an hour, and resets after a quiet hour', () => {
  const c = clock();
  const g = new PinGuard({ now: c.now });
  const waits = [];
  for (let round = 0; round < 8; round++) {
    flood(g, `r${round}`);
    const start = c.t;
    while (g.check(`new-phone-${round}`, true).status === 429) c.t += 1000;
    waits.push(c.t - start);
  }
  expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60].map((m) => Math.min(m * LOCK_MS, GLOBAL_MAX_LOCK_MS)));
  c.t += GLOBAL_MAX_LOCK_MS;
  flood(g, 'after-quiet');
  expect(g.check('other-phone', true).error).toContain('1분');
});

test('a device that passed the PIN keeps working through the global stop; a stranger with the right PIN waits', () => {
  const c = clock();
  const g = new PinGuard({ now: c.now });
  expect(g.check('referee', true).ok).toBe(true);
  flood(g, 'bot');
  expect(g.check('stranger', true).status).toBe(429);
  expect(g.check('referee', true).ok).toBe(true);
  c.t += 12 * 60 * 60_000;
  flood(g, 'bot-later');
  expect(g.check('referee', true).status).toBe(429);
});
