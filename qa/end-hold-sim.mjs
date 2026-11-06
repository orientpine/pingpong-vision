// What the primary does with each point when one phone's picked end colour is turned (docs/multicam.md
// "End colours"), read straight from the app's own judging (multicam.js judgeRally, EndSync) on the
// public-video rallies in qa/end-sync-rallies.json. Both phones film from the same place, so the true near
// colour of both is blue; one phone's pick is set to red. For every rally and every case it prints what
// the primary would do: enter the right player, enter the wrong one, ask (누가 땄나요) or nothing; and
// how many shared rallies the end check needs before it warns. With --hold=1 the case runs again after
// the warning, through the tree's scoreAction (absent on a tree without the hold: auto as before).
//   bun qa/end-hold-sim.mjs [--out=<file.json>]
import { readFileSync, writeFileSync } from "node:fs";
import * as mc from "../public/js/multicam.js";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split(/=(.*)/s).slice(0, 2)));
const { EndSync, judgeRally, shareSegment } = mc;
const rallies = JSON.parse(readFileSync(new URL("./end-sync-rallies.json", import.meta.url), "utf8")).rallies.filter((r) => r.bounces.length >= 2);

// the rally engine's event for one fixture rally, starting at t0 s
const event = (r, t0) => ({ t: t0 + r.durS, durationS: r.durS, why: r.why, bounces: r.bounces.map((b) => ({ ...b, t: t0 + b.dt })), shotList: (r.shots || []).map((s) => ({ ...s, t: t0 + s.dt })) });
const seg = (e, near, cam) => shareSegment(e, { near, offset: 0, cam });
const dropLast = (e) => ({ ...e, bounces: e.bounces.slice(0, -1) });

// the colour (0 blue, 1 red) a judged near / far winner goes to, as tour.colourOf with the primary's pick
const colourOf = (side, near) => (side === "near" ? near : 1 - near);

// The primary's decision for one judged rally: the tree's scoreAction when it has one, else main's
// finishRally (ask only on a two-camera conflict).
const decide = (r, hold) => (mc.scoreAction ? mc.scoreAction(r, { hold }) : { ask: r.conflict, reason: r.conflict ? "카메라 2대 판정이 달라요" : null });

const CASES = {
  "correct-both-saw": { nearA: 0, nearB: 0, b: "full" },
  "secondary-turned-secondary-missed": { nearA: 0, nearB: 1, b: "none" },
  "secondary-turned-both-saw": { nearA: 0, nearB: 1, b: "full" },
  "secondary-turned-primary-missed-last": { nearA: 0, nearB: 1, b: "full", a: "dropLast" },
  "primary-turned-secondary-missed": { nearA: 1, nearB: 0, b: "none" },
  "primary-turned-both-saw": { nearA: 1, nearB: 0, b: "full" },
  "primary-turned-primary-missed-last": { nearA: 1, nearB: 0, b: "full", a: "dropLast" },
};

const out = { rallies: rallies.length, hasHold: !!mc.scoreAction, cases: {} };
for (const [name, c] of Object.entries(CASES)) {
  for (const hold of mc.scoreAction ? [false, true] : [false]) {
    const tally = { right: 0, wrong: 0, ask: 0, none: 0 };
    rallies.forEach((r, i) => {
      const e = event(r, 100 + i * 20);
      const truth = judgeRally([seg(e, 0, "self")], { primary: "self", near: 0 }).judged;
      if (!truth) return;
      const segs = [seg(c.a === "dropLast" ? dropLast(e) : e, c.nearA, "self")];
      if (c.b === "full") segs.push(seg(e, c.nearB, "B"));
      const j = judgeRally(segs, { primary: "self", near: c.nearA });
      if (!j.judged) return void tally.none++;
      const d = decide(j, hold);
      if (d.ask) return void tally.ask++;
      tally[colourOf(j.judged.winner, c.nearA) === colourOf(truth.winner, 0) ? "right" : "wrong"]++;
    });
    out.cases[`${name}${hold ? " (held)" : ""}`] = tally;
  }
}

// the end check on rallies both phones saw: how many until it warns, and which camera it names
const warnAfter = (nearA, nearB) => {
  const s = new EndSync();
  s.pick("B", nearB);
  for (let i = 0; i < rallies.length; i++) {
    const e = event(rallies[i], 100 + i * 20);
    const ch = s.observe([seg(e, nearA, "self"), seg(e, nearB, "B")]);
    if (ch.some((x) => x.state === "mismatch")) return { rallies: i + 1, names: ch.map((x) => x.cam) };
  }
  return { rallies: null };
};
out.warn = { secondaryTurned: warnAfter(0, 1), primaryTurned: warnAfter(1, 0), correct: warnAfter(0, 0) };
console.log(JSON.stringify(out, null, 1));
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2));
