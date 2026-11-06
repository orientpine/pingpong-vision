import { expect, test } from 'bun:test';
import { join } from 'node:path';

// i18n.js reads the stored language once, when it is first imported, and other test files in this
// process have already loaded it in Korean. So the English run is a child process.
const SCRIPT = `
globalThis.localStorage = { getItem: () => 'en' };
const { bracketFor, createTournament, derive, labelText } = await import(${JSON.stringify(join(import.meta.dir, '..', 'public', 'engine.js'))});
const entries = 'ABCDEFGH'.split('').map((n, i) => n + ',' + (1001 + i));
const bad = [];
let checked = 0;
for (const format of ['double', 'triple', 'league']) {
  for (let n = 2; n <= 8; n++) {
    const t = createTournament({ name: 't', players: entries.slice(0, n), format });
    const texts = [];
    for (const m of derive(t).matches) texts.push(m.label, ...m.slotLabels.filter((s) => !t.players.includes(s)));
    for (const tpl of bracketFor(t)) texts.push(tpl.resetLabel);
    for (const text of texts.filter(Boolean)) {
      checked++;
      if (/[가-힣]/u.test(labelText(text))) bad.push(text);
    }
  }
}
console.log(JSON.stringify({
  bad, checked,
  exact: [labelText('패자조A 1라운드 (1패)'), labelText('3경기 승자'), labelText('그랜드 파이널 리셋 매치'), labelText('홍길동')],
}));
`;

test('English labelText leaves no Korean in any label the engine makes', async () => {
  const proc = Bun.spawn(['bun', '-e', SCRIPT], { stdout: 'pipe', stderr: 'inherit' });
  const out = JSON.parse(await new Response(proc.stdout).text());
  expect(await proc.exited).toBe(0);
  expect(out.checked).toBeGreaterThan(100);
  expect(out.bad).toEqual([]);
  expect(out.exact).toEqual(['Losers A R1 (1 loss)', 'Winner of match 3', 'Grand final reset', '홍길동']);
});
