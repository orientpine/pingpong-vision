// Link to the tournament scoring app, which owns the root of the same origin (/api/..., /ws).
// The referee types the tournament PIN once (checked by /api/pin/verify, kept only on this
// phone) and picks the match and which end colour (blue / red end of the table) is nearer the
// camera. The ends stay put; the players move between them (ITTF 2.14: after every game, and at 5
// in the deciding game), and the tournament keeps who stands where (match.ends = [slot at the blue
// end, slot at the red end]) so every screen shows the same. After each point the
// vision app enters the judged winner through the tournament's normal /api/action (same PIN
// rules, lockout and seq check as a tap), shows a 3 s cancel (= the tournament's undo), and
// once the point's clip is uploaded attaches its share path to that point.
import { pointCallout } from "./voice.js";
import { L, both, errorText } from "./i18n.js";

const API = "/api";
export const SIDE_NAMES = [L("블루", "Blue"), L("레드", "Red")];
// the same names as pairs, for call-outs another screen may read in its own language
export const SIDE_PAIRS = [both("블루", "Blue"), both("레드", "Red")];
// what a score call-out says for each end: Korean "블루 사이드 5", English "Blue 5"
export const SIDE_CALL = [both("블루 사이드", "Blue"), both("레드 사이드", "Red")];
const CHANGE_ENDS = both(". 엔드를 바꾸세요", ". Change ends");
export const MANUAL = L("직접 고름", "picked by hand");
// a point the referee screen entered while this camera asked (확인 후 입력)
export const REFEREE = L("심판 입력", "entered by the referee");
const FAULT = L("서브 폴트", "serve fault");
const FAULT_SAY = both("서브 폴트. ", "Serve fault. ");

// What the camera calls the player at the near / far end: "레드 · <name>" when linked to a match,
// "레드 사이드" otherwise. view: TournamentLink.view().
export function sideLabel(view, side) {
  const near = view && view.near === 1 ? 1 : 0;
  const end = side === "near" ? near : 1 - near;
  const m = view && view.connected ? view.match : null;
  return m ? `${SIDE_NAMES[end]} · ${m.names[m.ends[end]]}` : `${SIDE_NAMES[end]} ${L("사이드", "side")}`;
}

const endsOf = (m) => (m && m.ends) || [0, 1];
const byEnd = (ends, pair) => [pair[ends[0]], pair[ends[1]]];
export const CANCEL_MS = 3000;
export const CHOICE_MS = 15000;
// How a judged point reaches the tournament (owner decision, 2026-11-01): "confirm" (확인 후 입력) puts every point on
// the 누가 땄나요 bar with the camera's call already chosen, entered on one tap here or on the referee screen;
// "auto" brings back the 자동 입력 setting (확실할 때만 / 모든 포인트 자동).
export const POINT_ENTRY = "confirm";
// the camera's call a person confirms (the pre-chosen colour tapped): entered as the camera's, not a hand pick
export const CONFIRMED = L("카메라 판정 확인", "camera's call confirmed");
export const SUSPECT_MS = 6000;

export class TournamentLink {
  constructor(store, onChange = () => {}, { say = () => {}, onPin = () => {}, onEnds = () => {}, entry = POINT_ENTRY } = {}) {
    this.entry = entry === "auto" ? "auto" : "confirm";
    this.store = store;
    this.onPin = onPin;
    this.onEnds = onEnds;
    this.endsAt = 0;
    this.onChange = onChange;
    this.sayFn = say;
    this.voice = store.get("tourVoice", true);
    this.pin = store.get("tourPin", null);
    // the referee-approved camera token is gone (owner decision, 2026-10-31): forget one left on this phone
    if (store.get("tourToken", null)) store.set("tourToken", null);
    this.ws = "none";
    this.needPick = false;
    this.matchId = store.get("tourMatch", null);
    // this phone's near end colour, picked by a person (calibration screen after the four corners, or settings)
    this.near = store.get("tourNear", 0);
    this.mode = store.get("tourMode", "sure");
    this.matches = [];
    this.error = null;
    this.errorAt = 0;
    this.notice = null;
    this.pending = null;
    this.fixing = false;
    this.fixTarget = null;
    this.prevMatchId = null;
    // one write at a time: an auto point arriving during a hand fix waits for it (seq stays right)
    this.queue = Promise.resolve();
  }

  view() {
    const match = this.matches.find((m) => m.id === this.matchId) || null;
    const errorFresh = !!this.error && Date.now() - this.errorAt < 5000;
    return { connected: this.linked(), approval: this.pin ? "pin" : null, ws: this.ws, needPick: this.needPick, matchId: this.matchId, near: this.near, endsAt: this.endsAt, mode: this.mode, entry: this.entry, voice: this.voice, matches: this.matches, match, error: this.error, errorFresh, notice: this.notice, pending: this.pending, fix: { can: !!this.pin, busy: this.fixing, target: this.fixTarget } };
  }

  linked() {
    return !!this.pin;
  }

  // Scores are written with the tournament PIN only, as on the referee screen: typed on this phone or
  // shared from the tournament app on this origin (pp-pin).
  auth() {
    return this.pin ? { "x-pin": this.pin } : {};
  }

  setWs(status) {
    if (this.ws === status) return;
    this.ws = status;
    this.onChange();
  }

  async call(path, body, extra = {}) {
    const res = await fetch(API + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...this.auth(), ...extra },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    // The tournament PIN changed (or was fixed to a new value): drop the stale copy after one refusal,
    // as the tournament app does, instead of trying it on every point and locking the venue out.
    if (res.status === 403 && this.pin && path !== "/pin/verify") {
      this.dropPin();
      throw new Error(L("대회 PIN이 바뀌었어요. 새 PIN을 넣어야 점수가 기록돼요.", "The tournament PIN changed. Enter the new PIN to record points."));
    }
    if (!res.ok) throw new Error(errorText(data, L(`대회 응답 ${res.status}`, `Tournament replied ${res.status}`)));
    return data;
  }

  dropPin() {
    this.pin = null;
    this.store.set("tourPin", null);
    try {
      localStorage.removeItem("pp-pin");
    } catch {}
    this.matches = [];
    this.pending = null;
  }

  async run(task) {
    try {
      this.error = null;
      return await task();
    } catch (err) {
      this.error = String(err.message || err);
      this.errorAt = Date.now();
      return null;
    } finally {
      this.onChange();
    }
  }

  connect(pin) {
    return this.run(async () => {
      const p = String(pin || "").trim();
      await this.call("/pin/verify", { pin: p });
      this.pin = p;
      this.store.set("tourPin", p);
      // the same device memory as 심판 in the tournament app on this origin
      try {
        localStorage.setItem("pp-pin", p);
      } catch {}
      this.notice = L("대회에 연결했어요", "Linked to the tournament");
      this.onPin();
      this.apply(await this.call("/state"));
    });
  }

  disconnect() {
    this.pin = null;
    this.matches = [];
    this.pending = null;
    this.notice = L("대회 점수 연동을 껐어요", "Tournament scoring link is off");
    this.store.set("tourPin", null);
    this.onChange();
  }

  refresh() {
    return this.run(async () => this.apply(await this.call("/state")));
  }

  apply(state) {
    const t = state && state.tournament;
    const d = state && state.derived;
    if (!t || !d) {
      this.matches = [];
      throw new Error(L("진행 중인 대회가 없어요", "No tournament is running"));
    }
    // the tournament's id on the scoreboard PC (its createdAt), for the analysis desk's match reference
    this.tournamentId = t.createdAt || null;
    const before = this.matches.find((m) => m.id === this.matchId);
    this.matches = d.matches
      .filter((m) => m.status === "live" || m.status === "ready")
      .map((m) => ({ id: m.id, no: m.no, names: m.players.map((i) => t.players[i]), points: m.points.length, score: m.score, ends: endsOf(m), live: m.status === "live" }));
    const after = this.matches.find((m) => m.id === this.matchId);
    // the players changed ends (the rules, or a hand fix on any screen): the camera says so
    if (before && after && before.ends[0] !== after.ends[0]) {
      this.endsAt = Date.now();
      this.onEnds(after);
    }
    this.needPick = false;
    this.fixTarget = this.fixTargetOf(t, d);
    if (this.matches.some((m) => m.id === this.matchId)) return;
    // Follow the match being played. Two tables playing at once: this camera cannot know which
    // one it films, so it asks once (the pick is kept until that match ends).
    const live = this.matches.filter((m) => m.live);
    if (live.length > 1) {
      this.needPick = true;
      this.matchId = null;
      return;
    }
    const current = live[0] || this.matches.find((m) => d.current && m.id === d.current.id) || this.matches[0];
    this.setMatch(current ? current.id : null);
  }

  // The match a hand fix applies to: the one this camera films, or, right after a match ended on
  // a point (the camera already follows the next one, still at 0), that finished match.
  fixTargetOf(t, d) {
    const cur = d.matches.find((m) => m.id === this.matchId);
    const prev = d.matches.find((m) => m.id === this.prevMatchId);
    const m = cur && cur.points.length ? cur : prev && prev.status === "done" ? prev : cur;
    if (!m) return null;
    return { id: m.id, no: m.no, names: m.players.map((i) => t.players[i]), log: m.points.slice(), score: m.score, ends: endsOf(m), status: m.status };
  }

  setMatch(id) {
    if (id !== this.matchId && this.matchId) this.prevMatchId = this.matchId;
    this.matchId = id;
    if (id) this.needPick = false;
    this.store.set("tourMatch", id);
    this.onChange();
  }

  setNear(side) {
    this.near = side === 1 ? 1 : 0;
    this.store.set("tourNear", this.near);
    this.onChange();
  }

  setVoice(on) {
    this.voice = !!on;
    this.store.set("tourVoice", this.voice);
    this.onChange();
  }

  say(text) {
    if (this.voice && text) this.sayFn(text);
  }

  // End colour (0 blue, 1 red) of the near / far end: fixed, the players move.
  colourOf(side) {
    return side === "near" ? this.near : 1 - this.near;
  }

  match() {
    return this.matches.find((m) => m.id === this.matchId) || null;
  }

  // Tournament player slot standing at an end colour / at the near or far end right now.
  slotAtEnd(end) {
    return endsOf(this.match())[end === 1 ? 1 : 0];
  }

  slotOf(side) {
    return this.slotAtEnd(this.colourOf(side));
  }

  // 자리 교체 while linked: the two players trade ends for every screen (the ends keep their colours).
  // Resolves false when there is no match to write to (the camera then swaps on its own).
  swapEnds() {
    const m = this.match();
    if (!this.linked() || !m) return Promise.resolve(false);
    return this.serial(() => this.run(async () => {
      this.apply(await this.call("/state"));
      const cur = this.match();
      if (!cur) throw new Error(L("고른 경기가 끝났거나 없어요", "The chosen match is finished or gone"));
      this.apply((await this.call("/action", { type: "ends", matchId: cur.id, blue: cur.ends[1] })).state);
      return true;
    }));
  }

  setMode(mode) {
    this.mode = mode === "all" ? "all" : "sure";
    this.store.set("tourMode", this.mode);
    this.onChange();
  }

  // Enter one judged point ({ winner: "near" | "far", label, sure }). In "sure" mode an unsure
  // call is not entered: the bar offers one-tap [블루 득점] / [레드 득점] until the next rally
  // starts (or CHOICE_MS), and the tapped side is entered the same way, clip included.
  // Resolves to the entry the clip is attached to, or null when nothing was entered.
  // Two cameras that disagree (카메라 여러 대) pass ask: the bar asks whatever the mode.
  // hold (점수 보류, the end colours may be turned): the bar says so instead of an unsure call.
  // 확인 후 입력 (POINT_ENTRY "confirm"): every point asks, with pre = the camera's call (an end colour), except
  // when the camera cannot be trusted (hold) or two cameras disagree (ask): then nothing is pre-chosen. Such a
  // choice stays until it is answered here or on the referee screen, or the next judged point replaces it
  // (it is not dropped when the next rally starts: the players serve again long before anyone taps).
  // point.js marks a one-bounce rally or a short fragment judged.ask: asked in every mode, and with
  // 확인 후 입력 shown with nothing pre-chosen (the camera's call there is often a phantom).
  // rally ({ why, startMs, endMs }, wall-clock ms) only goes into the judge log (logCall).
  score(judged, suspect = null, { ask = false, reason = null, hold = false, rally = null } = {}) {
    if (!this.linked() || !this.matchId || !judged) return Promise.resolve(null);
    const sus = suspect && suspect.server && (suspect.fault || suspect.let) ? { fault: suspect.fault, let: suspect.let, server: this.slotOf(suspect.server) } : null;
    const confirm = this.entry === "confirm";
    const m = this.match();
    const seq = m ? m.points : null;
    if (confirm || (this.mode === "sure" && !judged.sure) || ask || judged.ask) {
      return new Promise((resolve) => {
        const pre = confirm && !hold && !ask && !judged.ask ? this.colourOf(judged.winner) : null;
        const guess = judged.ask && !hold && !ask ? this.colourOf(judged.winner) : null; // a weak call: shown in words, not pre-chosen
        const left = this.pending && this.pending.choice && this.pending.keep ? this.pending : null;
        this.dropChoice("replaced");
        const judgeId = this.logCall(judged, seq, { pre, guess, hold, disagree: ask && !hold, rally });
        const choice = { choice: true, reason: reason || judged.label, hold: !!hold, pre, guess, sure: !!judged.sure, keep: confirm, matchId: this.matchId, seq, until: confirm ? null : Date.now() + CHOICE_MS, resolve, suspect: sus, judgeId };
        if (left) this.notice = L("앞 포인트는 입력하지 않았어요 · 심판 화면에서 넣어 주세요", "The previous point was not entered · enter it on the referee screen");
        this.pending = choice;
        if (!confirm) setTimeout(() => this.pending === choice && this.dropChoice("timeout"), CHOICE_MS);
        this.onChange();
      });
    }
    this.logCall(judged, seq, { pre: null, guess: null, hold, disagree: false, rally });
    return this.enter(this.slotOf(judged.winner), judged.label, sus);
  }

  // 카메라 판정 기록 (the tournament's data/judge-log.jsonl): the camera's call for this rally, before anyone
  // answers it. The answer is written by the tournament itself when the point is entered (here or on the
  // referee screen), so only the call and an unanswered drop travel from here. Numbers and ids only.
  // Fire and forget: a lost or refused write never touches scoring. Returns the call's id.
  logCall(judged, seq, { pre, guess, hold, disagree, rally }) {
    if (seq == null) return null;
    // short: the tournament takes ids of at most 64 characters, and a camera id alone is 64
    const id = `${(this.cameraId || "cam").slice(0, 12)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.logJudge({
      t: "call",
      id,
      matchId: this.matchId,
      index: seq,
      call: { end: this.colourOf(judged.winner), slot: this.slotOf(judged.winner), sure: !!judged.sure, weak: !!judged.ask, why: rally && rally.why ? rally.why : null, reason: judged.reason || null, shots: judged.shots || 0, bounces: judged.bounces || 0 },
      pre,
      guess,
      hold: !!hold,
      disagree: !!disagree,
      rally: rally ? { startMs: Math.round(rally.startMs), endMs: Math.round(rally.endMs) } : null,
      camera: this.cameraId || null,
      mode: this.entry,
    });
    return id;
  }

  logJudge(body) {
    if (!this.linked()) return;
    fetch(API + "/judge", { method: "POST", headers: { "content-type": "application/json", ...this.auth() }, body: JSON.stringify(body) })
      .then((res) => res.ok || console.warn("ppv: judge log refused", res.status))
      .catch((err) => console.warn("ppv: judge log failed", err));
  }

  // Points entered by themselves before the end check warned (점수 보류): each gets the tournament's
  // "끝 색 확인" mark so the referee screen can flip or clear it. { index, side } as entered; the server
  // refuses a mark whose point has changed since (undone, or a hand fix), and that one is left out.
  // Resolves to the number marked.
  mark(matchId, points) {
    if (!this.linked() || !matchId || !points.length) return Promise.resolve(0);
    return this.serial(async () => {
      let n = 0;
      for (const p of points) {
        try {
          this.apply((await this.call("/action", { type: "mark", matchId, index: p.index, side: p.side, on: true })).state);
          n++;
        } catch (err) {
          console.warn("ppv: end mark refused", p, err);
        }
      }
      this.onChange();
      return n;
    });
  }

  // The referee tapped [블루 득점] / [레드 득점] (an end colour) for an unsure point.
  // The camera's own call tapped (확인 후 입력) is entered as the camera's call, the other colour as a hand pick.
  pick(end) {
    const choice = this.pending && this.pending.choice ? this.pending : null;
    return this.pickSlot(this.slotAtEnd(end), "", choice && choice.pre === (end === 1 ? 1 : 0) ? CONFIRMED : null);
  }

  pickSlot(side, prefix = "", reason = null) {
    const choice = this.pending && this.pending.choice ? this.pending : null;
    if (!choice) return Promise.resolve(null);
    this.pending = null;
    return this.enter(side === 1 ? 1 : 0, prefix ? FAULT : reason || MANUAL, null, prefix).then((entry) => {
      choice.resolve(entry);
      return entry;
    });
  }

  // The tournament's state from the socket: a choice whose point was entered elsewhere (the referee screen,
  // 확인 후 입력) is answered with that point, so this camera's clip still goes on it.
  seen(state) {
    const choice = this.pending && this.pending.choice ? this.pending : null;
    const m = choice && choice.seq != null && state && state.derived ? state.derived.matches.find((x) => x.id === choice.matchId) : null;
    if (!m || m.points.length <= choice.seq) return;
    this.pending = null;
    const side = m.points[choice.seq];
    choice.resolve({ matchId: m.id, index: choice.seq, seq: choice.seq + 1, side, end: endsOf(m)[0] === side ? 0 : 1, name: "", reason: REFEREE, suspect: null, cancelled: false });
    this.notice = L("심판 화면에서 점수를 넣었어요", "The referee entered the point");
    this.onChange();
  }

  // why: what took the question away unanswered, for the judge log (replaced, let, rally, timeout, fix)
  dropChoice(why = "rally") {
    const choice = this.pending && this.pending.choice ? this.pending : null;
    if (!choice) return;
    this.pending = null;
    if (choice.judgeId) this.logJudge({ t: "drop", id: choice.judgeId, why });
    choice.resolve(null);
    this.onChange();
  }

  serial(task) {
    const p = this.queue.then(task, task);
    this.queue = p.catch(() => {});
    return p;
  }

  enter(side, reason, suspect = null, prefix = "") {
    return this.serial(() => this.run(async () => {
      this.apply(await this.call("/state"));
      const m = this.matches.find((x) => x.id === this.matchId);
      if (!m) throw new Error(L("고른 경기가 끝났거나 없어요. 설정에서 경기를 다시 골라 주세요", "The chosen match is finished or gone. Pick a match again in settings"));
      // an automatic point says which camera sent it: the server refuses one from a secondary camera
      // x-ppv-by: who entered it, for the judge log (a 폴트 re-entry is the camera's correction of a point)
      const by = { "x-ppv-by": prefix ? "camera-fix" : "camera" };
      const res = await this.call("/action", { type: "point", matchId: m.id, side, seq: m.points }, this.cameraId && reason !== MANUAL && reason !== CONFIRMED && !prefix ? { "x-ppv-camera": this.cameraId, ...by } : by);
      this.apply(res.state);
      const after = res.state.derived.matches.find((x) => x.id === m.id);
      const s = after && after.score;
      const g = s && (s.lastGame || s.current);
      // called with the ends the point was played at; then the players change ends if the rules say so
      const ends = m.ends;
      const end = ends[0] === side ? 0 : 1;
      const flip = !!(after && after.status !== "done" && endsOf(after)[0] !== ends[0]);
      const call = pointCallout({ side: end, score: g ? byEnd(ends, [g.a, g.b]) : null, gameEnded: !!(s && s.lastGame), gameNo: s && s.lastGame ? s.lastGame.no : null, won: s ? byEnd(ends, s.won) : [0, 0], matchOver: !!(after && after.status === "done"), endChange: flip });
      this.say(prefix ? both(prefix.ko + call.ko, prefix.en + call.en) : call);
      const entry = {
        matchId: m.id,
        index: m.points,
        seq: m.points + 1,
        side,
        end,
        name: m.names[side],
        reason,
        score: g ? [g.a, g.b] : null,
        gameEnded: !!(s && s.lastGame),
        flipped: flip,
        suspect,
        until: Date.now() + (suspect ? SUSPECT_MS : CANCEL_MS),
        cancelled: false,
      };
      this.pending = entry;
      setTimeout(() => {
        if (this.pending === entry) {
          this.pending = null;
          this.onChange();
          // state from the socket is skipped during the window: catch up on a referee's change now
          this.refresh();
        }
      }, entry.until - Date.now());
      return entry;
    }));
  }

  cancel(text = both("취소", "Cancel")) {
    const p = this.pending;
    if (!p || p.choice) return Promise.resolve(null);
    p.cancelled = true;
    this.pending = null;
    return this.serial(() => this.run(async () => {
      const res = await this.call("/action", { type: "undo", matchId: p.matchId, seq: p.seq }, { "x-ppv-by": "camera" });
      this.apply(res.state);
      this.notice = L(`${SIDE_NAMES[p.end]} 득점을 취소했어요`, `${SIDE_NAMES[p.end]} point cancelled`);
      this.say(text);
    }));
  }

  // Hand fixes on the camera screen, so one phone can correct the score and keep filming. Only a
  // phone that holds the tournament PIN writes at all, so it gets them too. A fix is the tournament's own undo / point actions with the
  // same seq check (the record format and rules do not change): undo back to the point that
  // changes, enter the rest again, and put their clips back.
  //   fix("plus", end)   one more point to the player at that end colour (0 blue, 1 red)
  //   fix("undo")        take the last point back
  //   fix("flip", index, seen) that point goes to the other side (seen: the side the screen showed)
  fix(kind, arg, seen = null) {
    if (!this.pin) return Promise.resolve(null);
    if (kind === "plus" && this.pending && this.pending.choice) return this.pick(arg);
    this.fixing = true;
    this.onChange();
    return this.serial(() => this.run(async () => {
      try {
        const st = await this.call("/state");
        this.apply(st);
        const target = this.fixTarget;
        const m = target && st.derived.matches.find((x) => x.id === target.id);
        if (!m || m.status === "pending") throw new Error(L("고칠 경기가 없어요", "No match to fix"));
        const log = m.points.slice();
        let want;
        if (kind === "plus") want = [...log, endsOf(m)[arg === 1 ? 1 : 0]];
        else if (kind === "undo") {
          if (!log.length) throw new Error(L("되돌릴 점수가 없어요", "No point to take back"));
          want = log.slice(0, -1);
        } else if (kind === "flip") {
          if (!Number.isInteger(arg) || arg < 0 || arg >= log.length) throw new Error(L("고칠 점수가 없어요", "No point to fix"));
          // the screen showed that point for this side; if the score moved since, do not guess
          if (seen != null && log[arg] !== seen) throw new Error(L("점수가 방금 바뀌었어요. 다시 눌러 주세요", "The score just changed. Tap again"));
          want = log.slice();
          want[arg] = 1 - want[arg];
        } else throw new Error(L("모르는 고치기", "Unknown fix"));
        if (this.pending) {
          if (this.pending.choice) this.dropChoice("fix");
          this.pending = null;
        }
        const { score, ends } = await this.rewrite(m, want);
        // a finished match reopened by the fix is the one being played again
        if (m.id !== this.matchId && score && score.winner == null) this.setMatch(m.id);
        const moved = ends[0] !== endsOf(m)[0];
        const g = score && score.current;
        const at = g ? byEnd(ends, [g.a, g.b]) : null;
        const line = at ? `${SIDE_NAMES[0]} ${at[0]} : ${at[1]} ${SIDE_NAMES[1]}` : "";
        this.notice = L(`점수를 고쳤어요 · ${line}`, `Score fixed · ${line}`);
        const sc = at ? { ko: `${SIDE_CALL[0].ko} ${at[0]}, ${SIDE_CALL[1].ko} ${at[1]}`, en: `${SIDE_CALL[0].en} ${at[0]}, ${SIDE_CALL[1].en} ${at[1]}` } : { ko: "", en: "" };
        this.say(both(`점수 고침. ${sc.ko}${moved ? CHANGE_ENDS.ko : ""}`, `Score fixed. ${sc.en}${moved ? CHANGE_ENDS.en : ""}`));
        return want;
      } finally {
        this.fixing = false;
      }
    }));
  }

  // Turn match m's point list into want: undo back to where they part, then enter the rest.
  // Resolves to the score and the ends (who stands where) after it.
  async rewrite(m, want) {
    let cur = m.points.slice();
    let score = m.score;
    let ends = endsOf(m);
    let same = 0;
    while (same < cur.length && same < want.length && cur[same] === want[same]) same++;
    const step = async (body) => {
      const res = await this.call("/action", body, { "x-ppv-by": "camera-fix" });
      const after = res.state.derived.matches.find((x) => x.id === m.id);
      ends = endsOf(after);
      score = after.score;
      cur = after.points.slice();
      this.apply(res.state);
    };
    while (cur.length > same) await step({ type: "undo", matchId: m.id, seq: cur.length });
    while (cur.length < want.length) await step({ type: "point", matchId: m.id, side: want[cur.length], seq: cur.length });
    for (const [i, url] of Object.entries(m.clips || {})) {
      const index = Number(i);
      if (index >= same && index < want.length) await this.call("/action", { type: "clip", matchId: m.id, index, url });
    }
    if (Object.keys(m.clips || {}).length) this.apply(await this.call("/state"));
    return { score, ends };
  }

  // The referee confirmed "렛?": no point, the serve is replayed.
  confirmLet() {
    const p = this.pending;
    if (!p) return Promise.resolve(null);
    if (p.choice) {
      this.dropChoice("let");
      this.notice = L("렛: 다시 서브", "Let: serve again");
      this.say(both("렛, 다시 서브", "Let, serve again"));
      return Promise.resolve(null);
    }
    return this.cancel(both("렛, 다시 서브", "Let, serve again")).then(() => {
      this.notice = L("렛: 다시 서브", "Let: serve again");
      this.onChange();
    });
  }

  // The referee confirmed "폴트?": the receiver wins the point. Resolves to the entry the clip
  // goes with.
  confirmFault() {
    const p = this.pending;
    if (!p || !p.suspect) return Promise.resolve(null);
    const receiver = 1 - p.suspect.server;
    if (p.choice) return this.pickSlot(receiver, FAULT_SAY);
    if (p.side === receiver) {
      this.pending = { ...p, suspect: null };
      this.say(both("서브 폴트", "Serve fault"));
      this.onChange();
      return Promise.resolve(p);
    }
    p.cancelled = true;
    this.pending = null;
    return this.run(async () => {
      this.apply((await this.call("/action", { type: "undo", matchId: p.matchId, seq: p.seq }, { "x-ppv-by": "camera-fix" })).state);
    }).then(() => this.enter(receiver, FAULT, null, FAULT_SAY)).then((entry) => {
      p.replacedBy = entry;
      return entry;
    });
  }

  attachClip(entry, sharePath) {
    while (entry && entry.replacedBy) entry = entry.replacedBy;
    if (!entry || entry.cancelled || !this.linked()) return Promise.resolve(null);
    return this.run(() => this.call("/action", { type: "clip", matchId: entry.matchId, index: entry.index, url: sharePath }));
  }

  // The rally saved on the tournament PC, handed to its analysis desk as a job for that point: only the
  // save id, the point, the camera's end and the table corners travel (the clip is already on the PC).
  // One save makes one job there, so a retry is harmless. Outside the point queue and run(): a lost
  // request is tried again after each wait, then only logged; the score and the clip link stay.
  async deskFromSave(entry, save, corners, waits = [2000, 8000]) {
    while (entry && entry.replacedBy) entry = entry.replacedBy;
    if (!entry || entry.cancelled || !this.linked() || !this.tournamentId) return null;
    const body = JSON.stringify({
      save,
      matchRef: { tournament: this.tournamentId, matchId: entry.matchId, index: entry.index },
      nearEnd: this.near === 1 ? "red" : "blue",
      corners: corners && corners.length === 4 ? corners.map(({ x, y }) => ({ x, y })) : null,
    });
    for (let i = 0; ; i++) {
      try {
        const res = await fetch(API + "/desk/jobs/from-save", { method: "POST", headers: { "content-type": "application/json", ...this.auth() }, body });
        if (res.ok) return (await res.json()).job;
        if (res.status < 500 || i >= waits.length) {
          console.warn("ppv: desk hand-off refused", res.status);
          return null;
        }
      } catch (err) {
        if (!(err instanceof TypeError)) throw err;
        if (i >= waits.length) {
          console.warn("ppv: desk hand-off failed", err);
          return null;
        }
      }
      await new Promise((r) => setTimeout(r, waits[i]));
    }
  }

  // The rally's shot summary for the analysis sheet, sent after its point with the same PIN. Outside
  // the point queue and run(): a refused or lost write is only logged, the score and the bar stay.
  async postAnalysis(entry, rally) {
    if (!entry || entry.cancelled || !this.linked()) return;
    try {
      const res = await fetch(API + "/analysis/rally", {
        method: "POST",
        headers: { "content-type": "application/json", ...this.auth() },
        body: JSON.stringify({ matchId: entry.matchId, index: entry.index, rally }),
      });
      if (!res.ok) console.warn("ppv: analysis write refused", res.status);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      console.warn("ppv: analysis write failed", err);
    }
  }
}
