// PIN lockout. Per device: 5 misses lock that address for 1 minute. For everyone: the PIN is a fixed
// 4 digits on a public address, and one IPv6 /64 gives an attacker endless addresses, so 20 misses
// within a minute from all addresses together stop every address that has not passed the PIN for
// 1 minute; each new stop within an hour of the last one doubles, up to 1 hour. That caps guessing at
// about 20 an hour (half of 10000 PINs takes about 10 days). An address that passed the PIN in the last 12
// hours is never held by that global stop, so phones already scoring keep scoring through it.
export const MAX_FAILS = 5;
export const LOCK_MS = 60_000;
export const GLOBAL_FAILS = 20;
export const GLOBAL_WINDOW_MS = 60_000;
export const GLOBAL_MAX_LOCK_MS = 60 * 60_000;
export const TRUST_MS = 12 * 60 * 60_000;

const minutes = (ms) => Math.ceil(ms / 60_000);

export class PinGuard {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.failures = new Map();
    this.trusted = new Map();
    this.recent = [];
    this.globalUntil = 0;
    this.globalLevel = 0;
  }

  check(ip, correct) {
    const now = this.now();
    let f = this.failures.get(ip);
    if (f && f.until > now) return { ok: false, status: 429, error: 'PIN을 너무 많이 틀렸습니다. 1분 뒤에 다시 시도하세요.', en: 'Too many incorrect PIN attempts. Try again in 1 minute.' }; // i18n-data: error paired with English en field
    const trusted = now - (this.trusted.get(ip) ?? -Infinity) < TRUST_MS;
    if (this.globalUntil > now && !trusted) {
      return { ok: false, status: 429, error: `PIN 시도가 너무 많아 잠시 막았습니다. ${minutes(this.globalUntil - now)}분 뒤에 다시 시도하세요.`, en: `Too many PIN attempts. Try again in ${minutes(this.globalUntil - now)} minutes.` }; // i18n-data: error paired with English en field
    }
    if (correct) {
      this.failures.delete(ip);
      this.trusted.set(ip, now);
      return { ok: true };
    }
    if (!f || f.until) f = { fails: 0, until: 0 };
    f.fails++;
    if (f.fails >= MAX_FAILS) f.until = now + LOCK_MS;
    this.failures.set(ip, f);
    this.countGlobal(now);
    return { ok: false, status: 403, error: 'PIN이 맞지 않습니다.', en: 'Incorrect PIN.' }; // i18n-data: error paired with English en field
  }

  countGlobal(now) {
    this.recent = this.recent.filter((t) => now - t < GLOBAL_WINDOW_MS);
    this.recent.push(now);
    if (this.recent.length < GLOBAL_FAILS) return;
    const soonAfterLast = this.globalUntil && now - this.globalUntil < GLOBAL_MAX_LOCK_MS;
    this.globalLevel = soonAfterLast ? this.globalLevel + 1 : 0;
    this.globalUntil = now + Math.min(LOCK_MS * 2 ** this.globalLevel, GLOBAL_MAX_LOCK_MS);
    this.recent = [];
  }
}
