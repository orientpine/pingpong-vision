import { L, EN } from './i18n.js';

// The whole tournament is derived by replaying the point log, so undo is just "pop a point".

// A rule broken by a request: the Korean message (shown by older screens and read in the tests) and its
// English half, which the server sends as "en" beside "error".
// Text the engine made and stored in Korean (match labels, reset labels, "3경기 승자" sources, the default
// tournament name) shown in this screen's language. Anything it does not recognise (a player's or a
// tournament's own name) comes back unchanged.
export function labelText(text) {
  if (!EN) return text;
  const fixed = {
    '탁구 대회': 'Table tennis tournament', // i18n-data: stored label
    '읽을 수 없는 기록': 'Unreadable record', // i18n-data: server.js broken-record name
    '이름 없음': 'Unknown', // i18n-data: trends.js server-made opponent name
    '그랜드 파이널': 'Grand final', // i18n-data: stored label
    '그랜드 파이널 리셋 매치': 'Grand final reset', // i18n-data: stored label
    '패자조 최종전': 'Losers decider', // i18n-data: stored label
    '패자조 최종전 리셋 매치': 'Losers decider reset', // i18n-data: stored label
    '결승': 'Final', // i18n-data: stored label
  };
  if (text in fixed) return fixed[text];
  let m = String(text).match(/^(\d+)라운드$/); // i18n-data: stored label
  if (m) return `Round ${m[1]}`;
  m = String(text).match(/^(\d+)경기 (승자|패자)$/); // i18n-data: derived source
  if (m) return `${m[2] === '승자' ? 'Winner' : 'Loser'} of match ${m[1]}`; // i18n-data: derived source
  m = String(text).match(/^(승자조|패자조[AB]?) (결승|(\d+)라운드)(?: \((\d)패\))?$/); // i18n-data: stored label
  if (m) {
    const side = { 승자조: 'Winners', 패자조: 'Losers', 패자조A: 'Losers A', 패자조B: 'Losers B' }[m[1]]; // i18n-data: stored label
    const round = m[3] ? `R${m[3]}` : 'final';
    const loss = m[4] ? ` (${m[4]} ${m[4] === '1' ? 'loss' : 'losses'})` : '';
    return `${side} ${round}${loss}`;
  }
  m = String(text).match(/^(.+) 승자$/); // i18n-data: derived source
  if (m && labelText(m[1]) !== m[1]) return `${labelText(m[1])} winner`;
  return text;
}

export class RuleError extends Error {
  constructor(message, en) {
    super(message);
    this.en = en;
  }
}

const seed = (i) => ({ seed: i });
const W = (id) => ({ winner: id });
const Lo = (id) => ({ loser: id });
const S = (series) => ({ survivor: series });

// Bracket templates for exactly 4 players. A `series` entry repeats matches between the same
// two players until one of them reaches the elimination loss count (grand final + reset, etc).
export const TEMPLATES = {
  double: [
    { id: 'm1', stage: 'W', label: '승자조 1라운드', a: seed(0), b: seed(3) }, // i18n-data: stored label
    { id: 'm2', stage: 'W', label: '승자조 1라운드', a: seed(1), b: seed(2) }, // i18n-data: stored label
    { id: 'm3', stage: 'L', label: '패자조 1라운드', a: Lo('m1'), b: Lo('m2') }, // i18n-data: stored label
    { id: 'm4', stage: 'W', label: '승자조 결승', a: W('m1'), b: W('m2') }, // i18n-data: stored label
    { id: 'm5', stage: 'L', label: '패자조 결승', a: Lo('m4'), b: W('m3') }, // i18n-data: stored label
    { series: 'gf', stage: 'F', label: '그랜드 파이널', resetLabel: '그랜드 파이널 리셋 매치', a: W('m4'), b: W('m5') }, // i18n-data: stored label
  ],
  triple: [
    { id: 'm1', stage: 'W', label: '승자조 1라운드', a: seed(0), b: seed(3) }, // i18n-data: stored label
    { id: 'm2', stage: 'W', label: '승자조 1라운드', a: seed(1), b: seed(2) }, // i18n-data: stored label
    { id: 'm3', stage: 'L', label: '패자조A 1라운드 (1패)', a: Lo('m1'), b: Lo('m2') }, // i18n-data: stored label
    { id: 'm4', stage: 'W', label: '승자조 결승', a: W('m1'), b: W('m2') }, // i18n-data: stored label
    { id: 'm5', stage: 'L', label: '패자조A 결승 (1패)', a: Lo('m4'), b: W('m3') }, // i18n-data: stored label
    { id: 'm6', stage: 'L2', label: '패자조B 1라운드 (2패)', a: Lo('m3'), b: Lo('m5') }, // i18n-data: stored label
    { series: 'lf', stage: 'L2', label: '패자조 최종전', resetLabel: '패자조 최종전 리셋 매치', a: W('m5'), b: W('m6') }, // i18n-data: stored label
    { series: 'gf', stage: 'F', label: '그랜드 파이널', resetLabel: '그랜드 파이널 리셋 매치', a: W('m4'), b: S('lf') }, // i18n-data: stored label
  ],
};

export const FORMAT_LIVES = { double: 2, triple: 3 };
export const FORMAT_NAMES = { double: L('더블 엘리미네이션', 'Double elimination'), triple: L('트리플 엘리미네이션', 'Triple elimination'), league: L('리그전', 'Round robin') };
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;

export const NAME_MAX = 20;
export const PLAYER_CODE_EXAMPLE = L('홍길동,0712', 'Alex,0712');
const CODE_HINT = L(`이름 뒤에 쉼표와 네 자리 숫자를 붙여 주세요. 예: ${PLAYER_CODE_EXAMPLE}`, `Add a comma and four digits after the name. Example: ${PLAYER_CODE_EXAMPLE}`);
// A player-entry error: `error` is shown on screen in this language; ko and en feed RuleError.
const entryError = (ko, en) => ({ error: L(ko, en), ko, en });

// One player entry as typed: a name, then a comma, full-width comma or space, then exactly 4 digits.
// The 4 digits only tell apart people with the same name; they are not a PIN.
export function parsePlayerEntry(text) {
  const s = String(text ?? '').normalize('NFKC').trim();
  if (!s) return entryError('이름을 입력해 주세요.', 'Enter a name.'); // i18n-data: both halves kept for RuleError
  const m = s.match(/^(.*?)[\s,，]+(\d{4})$/u);
  if (!m) return { error: CODE_HINT, ko: `이름 뒤에 쉼표와 네 자리 숫자를 붙여 주세요. 예: 홍길동,0712`, en: `Add a comma and four digits after the name. Example: Alex,0712` }; // i18n-data: both halves kept for RuleError
  const name = m[1].trim();
  if (!name) return entryError('네 자리 앞에 이름을 입력해 주세요.', 'Enter a name before the four digits.'); // i18n-data: both halves kept for RuleError
  if (name.length > NAME_MAX) return entryError(`이름은 ${NAME_MAX}자까지 쓸 수 있어요.`, `Names can be up to ${NAME_MAX} characters.`); // i18n-data: both halves kept for RuleError
  return { name, code: m[2] };
}

function checkCount(players) {
  if (!Array.isArray(players) || players.length < MIN_PLAYERS || players.length > MAX_PLAYERS) {
    throw new RuleError(`참가자는 ${MIN_PLAYERS}~${MAX_PLAYERS}명이어야 합니다.`, `There must be ${MIN_PLAYERS}-${MAX_PLAYERS} players.`);
  }
}

// Tournaments made before player codes (no `codes`): names only, as they always were.
function plainRoster(players) {
  checkCount(players);
  const cleaned = players.map((p) => String(p ?? '').trim().slice(0, NAME_MAX));
  if (cleaned.some((p) => !p)) throw new RuleError('참가자 이름을 모두 입력해 주세요.', 'Enter every player name.');
  if (new Set(cleaned).size !== cleaned.length) throw new RuleError('참가자 이름이 서로 달라야 합니다.', 'Player names must all be different.');
  return { players: cleaned };
}

// keep(text, i) gives the person an entry without its own code stands for (a rename or setup edit
// of a coded tournament), or null when the entry must carry a code.
function codedRoster(entries, keep) {
  checkCount(entries);
  const people = entries.map((text, i) => {
    const p = parsePlayerEntry(text);
    if (!('error' in p)) return p;
    const kept = keep(String(text ?? '').normalize('NFKC').trim(), i);
    if (kept?.name && kept.name.length <= NAME_MAX) return kept;
    throw new RuleError(`${i + 1}번 참가자: ${p.ko}`, `Player ${i + 1}: ${p.en}`);
  });
  const keys = people.map((p) => `${p.name},${p.code}`);
  const twice = people.find((p, i) => keys.indexOf(keys[i]) !== i);
  if (twice) throw new RuleError(`${twice.name} 선수가 두 번 들어갔어요. 이름과 네 자리가 같은 사람은 한 번만 넣어 주세요.`, `${twice.name} was entered twice. Enter each person with the same name and four digits only once.`);
  // Two people with one name show the last two digits; when those match too, all four.
  const tail = (p) => {
    const same = people.filter((q) => q !== p && q.name === p.name);
    if (!same.length) return '';
    return same.some((q) => q.code.slice(-2) === p.code.slice(-2)) ? `·${p.code}` : `·${p.code.slice(-2)}`;
  };
  const players = people.map((p) => p.name + tail(p));
  if (new Set(players).size !== players.length) throw new RuleError('참가자 이름이 서로 달라야 합니다.', 'Player names must all be different.');
  return { players, codes: people.map((p) => p.code) };
}

// Names without the '·12' (or '·0712') tail that codedRoster adds when two players share a name.
export function baseNames(t) {
  const strip = (p, i) => {
    const tail = [`·${t.codes[i]}`, `·${t.codes[i].slice(-2)}`].find((s) => p.endsWith(s));
    return tail ? p.slice(0, -tail.length) : p;
  };
  const stripped = t.players.map(strip);
  return t.players.map((p, i) => (stripped.some((s, j) => j !== i && s === stripped[i]) ? stripped[i] : p));
}

function checkRules({ format, bestOf, pointsToWin, winBy }) {
  if (!FORMAT_NAMES[format]) throw new RuleError('방식은 더블·트리플 엘리미네이션 또는 리그전이어야 합니다.', 'The format must be double or triple elimination, or round robin.');
  bestOf = Number(bestOf);
  if (bestOf !== 3 && bestOf !== 5) throw new RuleError('3판 2선승 또는 5판 3선승만 지원합니다.', 'Only best of 3 or best of 5 is supported.');
  pointsToWin = Number(pointsToWin);
  winBy = Number(winBy);
  if (!Number.isInteger(pointsToWin) || pointsToWin < 1 || pointsToWin > 50) throw new RuleError('게임 점수가 올바르지 않습니다.', 'The game score is not valid.');
  if (!Number.isInteger(winBy) || winBy < 1 || winBy > 5) throw new RuleError('점수 차 설정이 올바르지 않습니다.', 'The win-by setting is not valid.');
  return { format, bestOf, pointsToWin, winBy };
}

// Every new tournament takes players as '이름,네자리' (parsePlayerEntry).
export function createTournament({ name, players, format = 'double', bestOf = 3, pointsToWin = 11, winBy = 2 }) {
  const roster = codedRoster(players, () => null);
  return {
    name: String(name ?? '').trim().slice(0, 40) || '탁구 대회', // i18n-data: stored label
    ...checkRules({ format, bestOf, pointsToWin, winBy }),
    ...roster,
    log: {},
    createdAt: new Date().toISOString(),
  };
}

// Standard bracket seeding for a power-of-two size: 1 v P, then the halves keep top seeds apart.
function seedOrder(size) {
  let order = [0];
  for (let m = 1; m < size; m *= 2) order = order.flatMap((s) => [s, 2 * m - 1 - s]);
  return order;
}

const BYE = { bye: true };

// Elimination bracket for any player count, double (2 lives) or triple (3 lives). The winners
// bracket is built for the next power of two and matches that contain a bye (a missing seed, or the
// loser of a bye) are removed up front: the other slot advances and that match has no loser.
// Losers bracket A (1 loss) is the standard double-elimination losers bracket. For triple, players
// who lose in A enter losers bracket B (2 losses) batch by batch (see TRIPLE_RULE), then the A and
// B winners play a series until one has 3 losses, and its survivor meets the winners-bracket
// champion in the grand final series. The 4-player TEMPLATES follow the same rules.
export function eliminationBracket(n, lives) {
  // Two players: one final series, played again until one of them has `lives` losses (no reset label:
  // every match of it is 결승).
  if (n === 2) return [{ series: 'gf', stage: 'F', label: '결승', a: seed(0), b: seed(1) }]; // i18n-data: stored label
  const size = 2 ** Math.ceil(Math.log2(n));
  const rounds = Math.log2(size);
  const triple = lives === 3;
  const out = [];
  const alias = {};
  const norm = (ref) => {
    if (ref.bye || ('seed' in ref && ref.seed >= n)) return BYE;
    if ('winner' in ref && alias[ref.winner]) return alias[ref.winner].w;
    if ('loser' in ref && alias[ref.loser]) return alias[ref.loser].l;
    return ref;
  };
  const add = (id, side, round, a, b) => {
    a = norm(a);
    b = norm(b);
    if (a.bye || b.bye) alias[id] = { w: a.bye ? b : a, l: BYE };
    else out.push({ id, stage: side, round, a, b });
    return id;
  };

  let waiting = [];
  let bRound = 0;
  const pairB = (pairs) => {
    bRound++;
    return pairs.map(([x, y], i) => W(add(`b${bRound}-${i + 1}`, 'L2', bRound, x, y)));
  };
  const feedB = (aMatches) => {
    if (!triple) return;
    const incoming = aMatches.map((id) => norm(Lo(id))).filter((r) => !r.bye);
    if (!incoming.length) return;
    if (!waiting.length) {
      const pairs = [];
      for (let i = 0; i + 1 < incoming.length; i += 2) pairs.push([incoming[i], incoming[i + 1]]);
      const rest = incoming.length % 2 ? [incoming[incoming.length - 1]] : [];
      waiting = [...(pairs.length ? pairB(pairs) : []), ...rest];
      return;
    }
    const k = Math.min(waiting.length, incoming.length);
    const pairs = Array.from({ length: k }, (_, i) => [waiting[i], incoming[i]]);
    waiting = [...pairB(pairs), ...waiting.slice(k), ...incoming.slice(k)];
  };

  const order = seedOrder(size);
  let wb = [];
  for (let i = 0; i < size / 2; i++) wb.push(add(`w1-${i + 1}`, 'W', 1, seed(order[2 * i]), seed(order[2 * i + 1])));
  let lb = [];
  for (let i = 0; i < size / 4; i++) lb.push(add(`l1-${i + 1}`, 'L', 1, Lo(wb[2 * i]), Lo(wb[2 * i + 1])));
  feedB(lb);
  let lbRound = 1;
  for (let r = 2; r <= rounds; r++) {
    const prevWb = wb;
    wb = [];
    for (let i = 0; i < prevWb.length / 2; i++) wb.push(add(`w${r}-${i + 1}`, 'W', r, W(prevWb[2 * i]), W(prevWb[2 * i + 1])));
    lbRound++;
    const drop = [];
    // Losers drop in reversed order so they do not meet the player who just beat them.
    for (let i = 0; i < lb.length; i++) drop.push(add(`l${lbRound}-${i + 1}`, 'L', lbRound, Lo(wb[wb.length - 1 - i]), W(lb[i])));
    lb = drop;
    feedB(lb);
    if (r < rounds) {
      lbRound++;
      const next = [];
      for (let i = 0; i < lb.length / 2; i++) next.push(add(`l${lbRound}-${i + 1}`, 'L', lbRound, W(lb[2 * i]), W(lb[2 * i + 1])));
      lb = next;
      feedB(lb);
    }
  }
  while (waiting.length > 1) {
    const pairs = [];
    for (let i = 0; i + 1 < waiting.length; i += 2) pairs.push([waiting[i], waiting[i + 1]]);
    waiting = [...pairB(pairs), ...(waiting.length % 2 ? [waiting[waiting.length - 1]] : [])];
  }

  const names = { W: '승자조', L: triple ? '패자조A' : '패자조', L2: '패자조B' }; // i18n-data: stored label
  const suffix = { W: '', L: triple ? ' (1패)' : '', L2: ' (2패)' }; // i18n-data: stored label
  const label = (side, round) => {
    const same = [...new Set(out.filter((m) => m.stage === side).map((m) => m.round))];
    const no = same.indexOf(round) + 1;
    return `${names[side]} ${no === same.length ? '결승' : `${no}라운드`}${suffix[side]}`; // i18n-data: stored label
  };
  const tpls = out.map((m) => ({ id: m.id, stage: m.stage, label: label(m.stage, m.round), a: m.a, b: m.b }));
  const final = { series: 'gf', stage: 'F', label: '그랜드 파이널', resetLabel: '그랜드 파이널 리셋 매치', a: norm(W(wb[0])) }; // i18n-data: stored label
  if (!triple) return [...tpls, { ...final, b: norm(W(lb[0])) }];
  return [
    ...tpls,
    { series: 'lf', stage: 'L2', label: '패자조 최종전', resetLabel: '패자조 최종전 리셋 매치', a: norm(W(lb[0])), b: norm(waiting[0]) }, // i18n-data: stored label
    { ...final, b: S('lf') },
  ];
}

export const TRIPLE_RULE = [
  L('세 번 지면 탈락합니다.', 'You are out after three losses.'),
  L('승자조(0패)는 시드 대진이고, 인원이 2의 거듭제곱이 아니면 상위 시드가 1라운드 부전승입니다.', 'The winners bracket (0 losses) follows the seeds; if the player count is not a power of two, the top seeds get a bye in round 1.'),
  L('승자조에서 지면 패자조A(1패)로, 패자조A에서 지면 패자조B(2패)로 내려갑니다.', 'Lose in the winners bracket and you drop to Losers A (1 loss); lose in Losers A and you drop to Losers B (2 losses).'),
  L('패자조B는 기다리던 선수가 새로 내려온 선수와 먼저 붙고, 짝이 없으면 다음 합류까지 부전승으로 기다립니다.', 'In Losers B the waiting player plays the newly dropped player first; with no partner you wait with a bye until the next join.'),
  L('패자조 최종전은 A 우승자(1패)와 B 우승자(2패)가 누군가 3패가 될 때까지 겨룹니다(A 우승자가 지면 리셋).', 'The losers decider pits the A winner (1 loss) against the B winner (2 losses) until someone reaches 3 losses (reset if the A winner loses).'),
  L('그랜드 파이널은 승자조 우승자(무패)와 최종전 승자가 누군가 3패가 될 때까지 겨룹니다(상대가 이길 때마다 리셋).', 'The grand final pits the winners-bracket champion (unbeaten) against the decider winner until someone reaches 3 losses (reset each time the opponent wins).'),
];

// Round robin by the circle method: everyone meets everyone once; with an odd count one player
// sits out each round.
function leagueSchedule(n) {
  const ids = Array.from({ length: n % 2 ? n + 1 : n }, (_, i) => i);
  const tpls = [];
  for (let r = 1; r < ids.length; r++) {
    let k = 0;
    for (let i = 0; i < ids.length / 2; i++) {
      const [x, y] = [ids[i], ids[ids.length - 1 - i]];
      if (x >= n || y >= n) continue;
      tpls.push({ id: `r${r}-${++k}`, stage: 'R', round: r, label: `${r}라운드`, a: seed(Math.min(x, y)), b: seed(Math.max(x, y)) }); // i18n-data: stored label
    }
    ids.splice(1, 0, ids.pop());
  }
  return tpls;
}

export function bracketFor(t) {
  const n = t.players.length;
  if (t.format === 'league') return leagueSchedule(n);
  if (n === 4) return TEMPLATES[t.format];
  return eliminationBracket(n, FORMAT_LIVES[t.format]);
}

// League order: wins, then head-to-head wins among the tied players, then game difference,
// then point difference, then seed.
export const LEAGUE_RULE = L('승수 → 승자승(동률인 선수끼리 승수) → 게임(세트) 득실 → 점수 득실 → 시드 순', 'Wins → head-to-head (wins among tied players) → game difference → point difference → seed order');

function leagueOrder(stats, matches) {
  const done = matches.filter((m) => m.status === 'done');
  const sorted = [...stats].sort((x, y) => y.wins - x.wins);
  const result = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && sorted[j].wins === sorted[i].wins) j++;
    const group = sorted.slice(i, j);
    const inGroup = new Set(group.map((s) => s.player));
    const h2h = (s) => done.filter((m) => m.winnerPlayer === s.player && inGroup.has(m.loserPlayer)).length;
    group.sort((x, y) => h2h(y) - h2h(x)
      || (y.gamesWon - y.gamesLost) - (x.gamesWon - x.gamesLost)
      || (y.pointsWon - y.pointsLost) - (x.pointsWon - x.pointsLost)
      || x.player - y.player);
    for (const s of group) result.push({ ...s, h2h: group.length > 1 ? h2h(s) : null });
    i = j;
  }
  return result;
}

// Index (0 = first server, 1 = receiver) of who serves at displayed score a:b of a game.
// Only rallies actually played count (handicap start points excluded): serve changes every
// 2 rallies, and once both scores reach pointsToWin-1 (deuce) it changes every rally.
export function serveTurn(a, b, pointsToWin, handicap = [0, 0]) {
  const rallies = a + b - handicap[0] - handicap[1];
  const deuceAt = 2 * (pointsToWin - 1) - handicap[0] - handicap[1];
  const k = rallies < deuceAt ? Math.floor(rallies / 2) : Math.floor(deuceAt / 2) + (rallies - deuceAt);
  return k % 2;
}

export function scoreMatch(points, firstServer, { pointsToWin, winBy, bestOf }, handicap = [0, 0]) {
  const need = Math.ceil(bestOf / 2);
  const games = [];
  const won = [0, 0];
  let cur = [handicap[0], handicap[1]];
  let winner = null;
  // The game ended by the latest point. With a handicap the next game restarts at the same
  // score (10:0 -> 11:0 -> 10:0), so the UI needs this to show that the point won a game.
  let lastGame = null;
  // ITTF 2.14: in the deciding game the players change ends when one of them first reaches 5.
  let deciderSwitch = false;
  for (let i = 0; i < points.length && winner === null; i++) {
    const p = points[i];
    const top = Math.max(cur[0], cur[1]);
    cur[p]++;
    if (won[0] === need - 1 && won[1] === need - 1 && top < 5 && cur[p] >= 5) deciderSwitch = true;
    if (cur[p] >= pointsToWin && cur[p] - cur[1 - p] >= winBy) {
      games.push({ a: cur[0], b: cur[1], winner: p });
      won[p]++;
      if (i === points.length - 1) lastGame = { no: games.length, a: cur[0], b: cur[1], winner: p };
      cur = [handicap[0], handicap[1]];
      if (won[p] === need) winner = p;
    }
  }
  let server = null;
  const flags = { deuce: false, gamePoint: null, matchPoint: null };
  if (winner === null) {
    const gameFirst = games.length % 2 === 0 ? firstServer : 1 - firstServer;
    server = serveTurn(cur[0], cur[1], pointsToWin, handicap) === 0 ? gameFirst : 1 - gameFirst;
    flags.deuce = cur[0] >= pointsToWin - 1 && cur[1] >= pointsToWin - 1;
    for (const s of [0, 1]) {
      if (cur[s] + 1 >= pointsToWin && cur[s] + 1 - cur[1 - s] >= winBy) {
        flags.gamePoint = s;
        if (won[s] === need - 1) flags.matchPoint = s;
      }
    }
  }
  // Ends change after every game except the one that wins the match (ITTF 2.14.1).
  const endSwitches = games.length - (winner === null ? 0 : 1) + (deciderSwitch ? 1 : 0);
  return { games, won, current: { a: cur[0], b: cur[1] }, server, winner, gameNo: games.length + 1, need, lastGame, endSwitches, ...flags };
}

export function derive(t) {
  const lives = FORMAT_LIVES[t.format] ?? null;
  const tpls = bracketFor(t);
  const n = t.players.length;
  const matches = [];
  const byId = {};
  const seriesWinner = {};
  const seriesLabel = {};
  const losses = t.players.map(() => 0);
  const eliminated = [];
  let champion = null;

  const resolve = (ref) => {
    if ('seed' in ref) return ref.seed;
    if ('winner' in ref) return byId[ref.winner]?.winnerPlayer ?? null;
    if ('loser' in ref) return byId[ref.loser]?.loserPlayer ?? null;
    return seriesWinner[ref.survivor] ?? null;
  };
  const refLabel = (ref) => {
    if ('seed' in ref) return t.players[ref.seed];
    if ('winner' in ref) return `${byId[ref.winner].no}경기 승자`; // i18n-data: derived source
    if ('loser' in ref) return `${byId[ref.loser].no}경기 패자`; // i18n-data: derived source
    return `${seriesLabel[ref.survivor]} 승자`; // i18n-data: derived source
  };

  const push = (id, tpl, label, series) => {
    const pa = resolve(tpl.a);
    const pb = resolve(tpl.b);
    const log = t.log[id] ?? { points: [], firstServer: 0 };
    const m = {
      id,
      no: matches.length + 1,
      stage: tpl.stage,
      label,
      series: series ?? null,
      round: tpl.round ?? null,
      players: [pa, pb],
      slotLabels: [refLabel(tpl.a), refLabel(tpl.b)],
      points: log.points,
      clips: log.clips ?? {},
      // 끝 색 확인: points the vision camera entered by itself before it warned that the two phones' end colours
      // look opposite ({ index: 'ends' }); the referee screen flips or clears each, nothing changes by itself
      marks: log.marks ?? {},
      firstServer: log.firstServer ?? 0,
      handicap: log.handicap ?? [0, 0],
      status: 'pending',
      score: null,
      ends: [0, 1],
      winnerPlayer: null,
      loserPlayer: null,
    };
    if (pa !== null && pb !== null) {
      m.score = scoreMatch(m.points, m.firstServer, t, m.handicap);
      // The table's blue and red ends stay put; the players move. ends = [slot at blue end, slot at red end].
      const blue = ((log.endsFlip ? 1 : 0) + m.score.endSwitches) % 2;
      m.ends = [blue, 1 - blue];
      if (m.score.winner !== null) {
        m.status = 'done';
        m.winnerPlayer = m.players[m.score.winner];
        m.loserPlayer = m.players[1 - m.score.winner];
        losses[m.loserPlayer]++;
        if (lives !== null && losses[m.loserPlayer] === lives) eliminated.push(m.loserPlayer);
      } else {
        m.status = m.points.length ? 'live' : 'ready';
      }
    }
    matches.push(m);
    byId[id] = m;
    return m;
  };

  for (const tpl of tpls) {
    if (!tpl.series) {
      push(tpl.id, tpl, tpl.label);
      continue;
    }
    seriesLabel[tpl.series] = tpl.label;
    for (let i = 1; ; i++) {
      const m = push(`${tpl.series}${i}`, tpl, i === 1 || !tpl.resetLabel ? tpl.label : i === 2 ? tpl.resetLabel : `${tpl.resetLabel} ${i - 1}`, tpl.series);
      if (m.status !== 'done') break;
      if (losses[m.loserPlayer] >= lives) {
        seriesWinner[tpl.series] = m.winnerPlayer;
        break;
      }
    }
  }
  if (seriesWinner.gf !== undefined) champion = seriesWinner.gf;

  const stats = t.players.map((name, i) => ({
    player: i, name, wins: 0, losses: 0, gamesWon: 0, gamesLost: 0, pointsWon: 0, pointsLost: 0,
  }));
  for (const m of matches) {
    if (m.score === null) continue;
    const [pa, pb] = m.players;
    if (m.status === 'done') {
      stats[m.winnerPlayer].wins++;
      stats[m.loserPlayer].losses++;
    }
    for (const g of m.score.games) {
      stats[g.winner === 0 ? pa : pb].gamesWon++;
      stats[g.winner === 0 ? pb : pa].gamesLost++;
    }
    for (const p of m.points) {
      stats[p === 0 ? pa : pb].pointsWon++;
      stats[p === 0 ? pb : pa].pointsLost++;
    }
  }

  if (t.format === 'league') {
    const finished = matches.every((m) => m.status === 'done');
    const standings = leagueOrder(stats, matches).map((s, i) => ({
      ...s,
      lossCount: losses[s.player],
      rank: i + 1,
      place: finished ? i + 1 : null,
      status: finished ? (i === 0 ? 'champion' : 'finished') : 'alive',
    }));
    if (finished) champion = standings[0].player;
    const live = matches.find((m) => m.status === 'live') ?? null;
    const next = matches.find((m) => m.status === 'ready') ?? null;
    return { lives, matches, losses, eliminated, champion, finished, standings, current: live ?? next };
  }

  const standings = stats.map((s) => {
    const elimIdx = eliminated.indexOf(s.player);
    let status = 'alive';
    let place = null;
    if (champion === s.player) { status = 'champion'; place = 1; }
    else if (elimIdx >= 0) { status = 'eliminated'; place = n - elimIdx; }
    return { ...s, lossCount: losses[s.player], status, place, elimIdx };
  });
  standings.sort((x, y) => {
    const rank = (s) => (s.status === 'champion' ? 0 : s.status === 'alive' ? 1 : 2);
    if (rank(x) !== rank(y)) return rank(x) - rank(y);
    if (x.status === 'eliminated') return y.elimIdx - x.elimIdx;
    return x.lossCount - y.lossCount || y.wins - x.wins
      || (y.pointsWon - y.pointsLost) - (x.pointsWon - x.pointsLost);
  });
  standings.forEach((s, i) => { s.rank = i + 1; });

  const live = matches.find((m) => m.status === 'live') ?? null;
  const next = matches.find((m) => m.status === 'ready') ?? null;
  return { lives, matches, losses, eliminated, champion, finished: champion !== null, standings, current: live ?? next };
}

const clone = (t) => structuredClone(t);

function findMatch(t, matchId) {
  const d = derive(t);
  const m = d.matches.find((x) => x.id === matchId);
  if (!m) throw new RuleError('존재하지 않는 경기입니다.', 'That match does not exist.');
  return { d, m };
}

export function addPoint(t, matchId, side, seq) {
  if (side !== 0 && side !== 1) throw new RuleError('잘못된 선수 지정입니다.', 'Invalid player.');
  const { m } = findMatch(t, matchId);
  if (m.status === 'pending') throw new RuleError('아직 대진이 확정되지 않은 경기입니다.', 'This match is not set yet.');
  if (m.status === 'done') throw new RuleError('이미 끝난 경기입니다.', 'This match is already finished.');
  if (seq !== m.points.length) throw new RuleError('다른 기기에서 점수가 먼저 바뀌었습니다. 화면을 갱신했습니다.', 'The score changed on another device. The screen was refreshed.');
  const n = clone(t);
  const entry = n.log[matchId] ?? { points: [], firstServer: m.firstServer };
  entry.points = [...entry.points, side];
  n.log[matchId] = entry;
  return n;
}

export function attachClip(t, matchId, index, url) {
  const { m } = findMatch(t, matchId);
  if (!Number.isInteger(index) || index < 0 || index >= m.points.length) throw new RuleError('잘못된 포인트 번호입니다.', 'Invalid point number.');
  if (typeof url !== 'string' || url.length !== 53 || !/^\/vision\/s\/[A-Za-z0-9_-]{43}$/.test(url)) throw new RuleError('잘못된 영상 경로입니다.', 'Invalid video path.');
  const n = clone(t);
  n.log[matchId].clips = { ...n.log[matchId].clips, [index]: url };
  return n;
}

export function undoPoint(t, matchId, seq) {
  const { d, m } = findMatch(t, matchId);
  if (m.points.length === 0) throw new RuleError('되돌릴 점수가 없습니다.', 'No points to undo.');
  if (seq !== m.points.length) throw new RuleError('다른 기기에서 점수가 먼저 바뀌었습니다. 화면을 갱신했습니다.', 'The score changed on another device. The screen was refreshed.');
  const n = clone(t);
  n.log[matchId].points = n.log[matchId].points.slice(0, -1);
  n.log[matchId].clips = Object.fromEntries(Object.entries(m.clips).filter(([index]) => Number(index) < n.log[matchId].points.length));
  if (n.log[matchId].marks) n.log[matchId].marks = Object.fromEntries(Object.entries(m.marks).filter(([index]) => Number(index) < n.log[matchId].points.length));
  const nd = derive(n);
  for (const old of d.matches) {
    if (old.id === matchId) continue;
    const now = nd.matches.find((x) => x.id === old.id);
    if (now && now.players[0] === old.players[0] && now.players[1] === old.players[1]) continue;
    if (old.points.length) {
      throw new RuleError(`이 경기 결과로 정해진 ${old.no}경기가 이미 시작되어 되돌릴 수 없습니다. 그 경기 점수를 먼저 모두 취소하세요.`, `Match ${old.no}, set by this result, has already started, so this cannot be undone. Cancel all of that match's points first.`);
    }
    // Handicap and first serve were chosen for the old pairing; they must not carry over.
    delete n.log[old.id];
  }
  return n;
}

// The camera's "끝 색 확인" mark on one point (on), or the referee clearing it (off: the point was right).
// side: the slot the camera saw that point go to; a point changed since (undone, fixed) is refused.
export function markPoint(t, matchId, index, side, on) {
  const { m } = findMatch(t, matchId);
  if (!Number.isInteger(index) || index < 0 || index >= m.points.length) throw new RuleError('잘못된 포인트 번호입니다.', 'Invalid point number.');
  if (on && m.points[index] !== side) throw new RuleError('그 포인트는 이미 바뀌었습니다.', 'That point has already changed.');
  const n = clone(t);
  const marks = { ...(n.log[matchId].marks ?? {}) };
  if (on) marks[index] = 'ends';
  else delete marks[index];
  n.log[matchId].marks = marks;
  return n;
}

// The referee's fix of one point: it goes to the other player, every later point stays as it was (each
// entered again by the rules, so a match that would have ended earlier is refused), clips stay on their
// points, and that point's mark is cleared. seq: the point count the screen showed.
export function flipPoint(t, matchId, index, seq) {
  const { d, m } = findMatch(t, matchId);
  if (m.status === 'pending') throw new RuleError('아직 대진이 확정되지 않은 경기입니다.', 'This match is not set yet.');
  if (seq !== m.points.length) throw new RuleError('다른 기기에서 점수가 먼저 바뀌었습니다. 화면을 갱신했습니다.', 'The score changed on another device. The screen was refreshed.');
  if (!Number.isInteger(index) || index < 0 || index >= m.points.length) throw new RuleError('잘못된 포인트 번호입니다.', 'Invalid point number.');
  const want = m.points.slice();
  want[index] = 1 - want[index];
  let n = clone(t);
  n.log[matchId].points = want.slice(0, index);
  try {
    for (let i = index; i < want.length; i++) n = addPoint(n, matchId, want[i], i);
  } catch (err) {
    if (err instanceof RuleError) throw new RuleError('이 포인트를 바꾸면 경기가 더 일찍 끝나요. 점수 취소로 고쳐 주세요.', 'Swapping this point would end the match earlier. Fix it with undo.');
    throw err;
  }
  const marks = { ...(m.marks ?? {}) };
  delete marks[index];
  // clips stay on their points: entering the points again keeps the log's clips
  n.log[matchId] = { ...n.log[matchId], marks };
  const nd = derive(n);
  for (const old of d.matches) {
    if (old.id === matchId) continue;
    const now = nd.matches.find((x) => x.id === old.id);
    if (now && now.players[0] === old.players[0] && now.players[1] === old.players[1]) continue;
    if (old.points.length) {
      throw new RuleError(`이 경기 결과로 정해진 ${old.no}경기가 이미 시작되어 바꿀 수 없습니다. 그 경기 점수를 먼저 모두 취소하세요.`, `Match ${old.no}, set by this result, has already started, so this point cannot be swapped. Cancel all of that match's points first.`);
    }
    delete n.log[old.id];
  }
  return n;
}

export function setFirstServer(t, matchId, side) {
  if (side !== 0 && side !== 1) throw new RuleError('잘못된 선수 지정입니다.', 'Invalid player.');
  const { m } = findMatch(t, matchId);
  if (m.status === 'pending') throw new RuleError('아직 대진이 확정되지 않은 경기입니다.', 'This match is not set yet.');
  if (m.status === 'done') throw new RuleError('이미 끝난 경기입니다.', 'This match is already finished.');
  const n = clone(t);
  n.log[matchId] = { points: [], ...n.log[matchId], firstServer: side };
  return n;
}

// A hand fix of who stands at the blue end now (blue = that player's slot). Later automatic changes go on from it.
export function setEnds(t, matchId, blue) {
  if (blue !== 0 && blue !== 1) throw new RuleError('잘못된 선수 지정입니다.', 'Invalid player.');
  const { m } = findMatch(t, matchId);
  if (m.status === 'pending') throw new RuleError('아직 대진이 확정되지 않은 경기입니다.', 'This match is not set yet.');
  if (m.status === 'done') throw new RuleError('이미 끝난 경기입니다.', 'This match is already finished.');
  const n = clone(t);
  n.log[matchId] = { points: [], firstServer: m.firstServer, ...n.log[matchId], endsFlip: (blue + m.score.endSwitches) % 2 === 1 };
  return n;
}

export function setHandicap(t, matchId, handicap) {
  const { m } = findMatch(t, matchId);
  if (m.status === 'pending') throw new RuleError('아직 대진이 확정되지 않은 경기입니다.', 'This match is not set yet.');
  if (m.points.length) throw new RuleError('핸디캡은 경기 시작 전(첫 점수 전)에만 정할 수 있습니다.', 'Handicap can only be set before the match starts (before the first point).');
  const ok = Array.isArray(handicap) && handicap.length === 2
    && handicap.every((h) => Number.isInteger(h) && h >= 0 && h <= t.pointsToWin - 1);
  if (!ok) throw new RuleError(`핸디캡은 0~${t.pointsToWin - 1}점 사이여야 합니다.`, `Handicap must be between 0 and ${t.pointsToWin - 1} points.`);
  const n = clone(t);
  n.log[matchId] = { points: [], firstServer: m.firstServer, handicap: [handicap[0], handicap[1]], ...(n.log[matchId]?.endsFlip ? { endsFlip: true } : {}) };
  return n;
}

export function hasStarted(t) {
  return Object.values(t.log).some((e) => e.points.length > 0);
}

export function renamePlayer(t, index, name) {
  const players = [...t.players];
  if (!Number.isInteger(index) || index < 0 || index >= players.length) throw new RuleError('잘못된 참가자입니다.', 'Invalid player.');
  if (!t.codes) {
    players[index] = name;
    return { ...clone(t), ...plainRoster(players) };
  }
  // The renamed slot keeps its code unless the new text brings one; the others keep theirs.
  const base = baseNames(t);
  const entries = players.map((_, j) => (j === index ? name : `${base[j]},${t.codes[j]}`));
  return { ...clone(t), ...codedRoster(entries, (text, i) => (i === index ? { name: text, code: t.codes[index] } : null)) };
}

// A setup edit sends the names it shows (no codes); a name still on the roster keeps that slot's code
// wherever it moved in the seed order. A new person needs '이름,네자리'.
export function updateSetup(t, { players, format, bestOf }) {
  if (hasStarted(t)) throw new RuleError('경기가 시작된 뒤에는 대진과 방식을 바꿀 수 없습니다.', 'The bracket and format cannot be changed once a match has started.');
  const rules = checkRules({ ...t, format: format ?? t.format, bestOf: bestOf ?? t.bestOf });
  const list = players ?? t.players;
  if (!t.codes) return { ...t, ...rules, ...plainRoster(list), log: {} };
  const base = baseNames(t);
  const keep = (text) => {
    const j = t.players.indexOf(text);
    return j < 0 ? null : { name: base[j], code: t.codes[j] };
  };
  return { ...t, ...rules, ...codedRoster(list, keep), log: {} };
}
