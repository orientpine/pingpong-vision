# 카메라 판정 기록 (judge log)

Every point the camera judges is written next to what the referee entered, so after a match you can see how often the camera was right and where it was not. The record stays on this PC.

## Where it is

`data/judge-log.jsonl` beside `tournament.json`, separate from `action.log`. One JSON object per line, oldest first. Above 4 MB it moves to `judge-log.jsonl.1` (one old file kept). Every line has `v` (1), `at` (server time, ms), and `tour` (the tournament's `createdAt`), so one file holds several tournaments and the summary reads the current one.

Only numbers, sides (match slots 0/1, end colours 0 blue / 1 red) and ids are written. No names, no PIN, no picture. Player names come from the tournament record when the page is drawn.

## Lines

| `t` | written by | fields |
|---|---|---|
| `call` | the camera, `POST /api/judge` (tournament PIN) when a rally is judged | `id`, `matchId`, `index` (the point number it would become, 0-based), `call: { end, slot, sure, weak, why, reason, shots, bounces }`, `pre` (end colour pre-chosen on 누가 땄나요, or null), `guess` (end colour named for a weak call), `hold` (end colour hold on), `disagree` (two cameras disagreed), `rally: { startMs, endMs }`, `camera`, `mode` (`confirm` or `auto`) |
| `drop` | the camera, when its question goes away unanswered | `id`, `why`: `replaced` (the next call came first), `let`, `rally` (the next rally started, old modes), `timeout`, `fix` (a hand fix on the camera phone) |
| `point` | the server, on `/api/action` `point` | `matchId`, `index`, `side`, `end` (end colour it went to, from the ends it was played at), `by` |
| `undo` | the server, on `undo` | `matchId`, `index`, `side` (taken back), `by` |
| `flip` | the server, on `flip` | `matchId`, `index`, `side` (after the flip), `by` |
| `clip` | the server, on `clip` | `matchId`, `index`, `clip` (share path) |

`by` comes from the `x-ppv-by` header the camera app sends: `camera` (the camera phone entered or cancelled it), `camera-fix` (the camera phone's hand fix or 폴트, which undoes and enters points again), and anything else is `referee` (the referee screen).

The camera's posts are not written to `action.log`. The `point`, `undo`, `flip` and `clip` actions are still written there as before.

A judge log that cannot be written (disk full, a folder in the way) is logged on the server console. The point is entered anyway, and the camera ignores a refused or lost post.

## Comparison (`public/judge-compare.js`)

A call is joined to the point entered at its match and index while it waits. A call that reaches the server up to 10 s after an uncalled point at its index is that point's call (the referee screen beat it). A `camera-fix` undo and the point that puts the index back keep the call that point had. Outcomes:

| outcome | meaning |
|---|---|
| same / different | entered, and the final side (after any later fix) is / is not the camera's call |
| cancelled | a fake call: the camera's cancel within 7 s of entry, or 렛 on an unanswered call |
| undone | entered, then taken back later |
| ignored | never entered: replaced by the next call, the next rally, or a timeout |
| open | still waiting on 누가 땄나요 |
| no_call | a point entered with no camera call (카메라 판정 없음, the camera missed it) |

Per match and in total: camera calls, same, different, sure calls right (%), weak calls by the side the referee picked (the camera's guess / the other side / not entered), points the camera missed, fake calls (cancelled + undone), calls not entered, waiting, points fixed later, and the average time from the call to the entry.

## Screen

On the match screen, **카메라 판정 비교** (under 분석) opens the page: the totals, a table by match, and each point of the picked match (the camera's call, what went in, who entered it, time to confirm, later fixes, the clip). **CSV로 받기** saves the match table or the point list as CSV in the screen's language (UTF-8 with BOM, so a spreadsheet reads Korean).

`GET /api/judge/summary` answers the same numbers as JSON for the current tournament (no PIN, like the scores).
