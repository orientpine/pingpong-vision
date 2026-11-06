# 카메라 여러 대 (multicam)

Owner, 2026-10-31 12:40–12:41 KST: "2번 준비해줘 기능 구현 해봐", then "전체앱애서 2대 카메라 1대 카메라 모두 지원하게 해", "2대 카메라가 잡히면 자동으로 지원하게", "잡히는 카메라 대수에 따라 자동으로 전환되게 해. 전환여부도 표시하고 해".

There is no switch in settings. When one camera with the PIN is on a match, it judges exactly as before. When a second camera with the PIN joins the same match, the two merge automatically. When one leaves, the match goes back to one camera.

## Today's flow (one camera)

| step | where |
|---|---|
| frame time `t` = rVFC callback time / 1000 (performance clock), media time for files | `public/js/app.js` onFrame |
| 4 corners → homography, table metres x 0..2.74 from the near end, y 0..1.525 | `public/js/geom.js` makeCalibration / apply |
| ball tracker `tracking` = locked / searching (공 찾는 중) / unstable / no-table | `public/js/pipeline.js` processPixels |
| rally events rallyStart / shot / bounce / rallyEnd {t, why, shotList[{side,t,inferred}], bounces[{tx,ty,side,t}], serveNet, serveSeen} | `public/js/rally.js` RallyEngine |
| winner from bounces + shots, `sure` gate | `public/js/point.js` judgePoint, suspects |
| rallyEnd → judge → `tour.score` (sure-only choice bar 누가 땄나요, 3 s cancel) → clip upload → attach | `public/js/app.js` onEvent |
| write = POST /api/action {type:"point", matchId, side, seq = current point count}; serialized | `public/js/tournament.js` enter / serial |
| server rejects a stale seq (409) | tournament `public/engine.js` point/undo seq check |
| presence: WebSocket /ws, camera hello every 5 s | `public/js/venue.js`, tournament `server.js` |

## Where the merge runs: on the primary camera

The merge runs on the primary camera, which is the first camera attached to the match. The tournament server only relays messages and keeps the camera roster. Three reasons:

1. Everything after a rally is phone-side today: judging (`point.js`), the sure gate and the 누가 땄나요 bar, the 3 s cancel, the voice call, the clip recording and upload, and the clip attach (`app.js` onEvent, `tournament.js` score/enter). The server stores actions with a seq check and judges nothing. Moving the merge to the server would move all of that, or add a second scoring path, and the one-camera result could no longer stay identical.
2. The brief keeps recording and clips on the primary camera, and the primary's phone already owns the writes that carry them.
3. Only one phone ever writes points, so a double point cannot come from two writers. The server adds a second guard: a point from a camera that is attached but not primary gets a 409. The seq check stays as the last line.

## Clock

Each camera sends `{type:"clock", c}` (performance.now ms) over /ws, and the server answers `{type:"clock", c, s: Date.now()}`. The camera sets offset = s − (c + rtt/2) and keeps the sample with the lowest RTT out of the last 8 (4 pings 0.5 s apart on connect, then one every 10 s). An event time in server ms is t·1000 + offset. The error is at most rtt/2 of the kept sample, which shows on the camera as "시계 ±N ms". Target: 50 ms.

## Shared frame

Each camera knows which end colour is near it (`tourNear`). Events are sent by end colour (0 blue, 1 red), with x measured from the blue end (2.74 − x and 1.525 − y when red is near). The primary maps them back to its own near/far before judging. So two phones at opposite ends, or one at a side, agree.

## Merge

- The secondary sends a status (ball seen or lost, rally active) about once a second and whenever it changes. It sends each rallyEnd as a segment. It never scores, speaks, records, or uploads.
- The primary collects segments (server ms) into rallies. Segments of two different cameras that share at least 0.1 s are one rally, and so is everything they chain to. A body that hides the ball ends one camera's rally (ball_lost) and a new one starts after it; the other camera's segment spans both and joins them. One camera's own segments are never joined to each other. So with one camera, every rally is judged as rally.js cut it. (The offline run caught two earlier versions. The first joined anything within 1.0 s, so it merged and dropped one camera's back-to-back rallies. The second allowed 0.2 s of slack, so it dropped a rally that started right after the other camera's last one.)
- The rally is closed when no fresh camera is in a rally that could still join it, or 15 s after its latest segment came in, whichever comes first. A camera stays fresh while it reports at least every 3 s, so a long rally on the other phone is waited for and a silent phone is not. A segment that arrives later and overlaps another camera's segment in a closed rally is dropped, never scored.
- Two bounces count as one when they come from different cameras, land on the same end, are 0.1 s apart or less, and are 0.6 m apart or less when both have table x/y. The primary's bounce is kept. Two shots count as one when they come from different cameras, come from the same end, and are 0.25 s apart or less; a measured shot wins over an inferred one. So a bounce one camera lost (공 찾는 중, a body in the way) comes from the other camera.
- `judgePoint` runs once on the merged events.
- Conflict: when each camera's own events give a winner and the two winners differ, nothing is entered. The 누가 땄나요 bar opens, even in 모든 포인트 자동 mode.
- The fault and let suspicion use the segment that holds the serve, the earliest shot.
- The clip is the primary's own clip of its last segment in that rally. A rally only the secondary saw gets the point and no clip.

## End colours: picked by a person on each phone

Owner, 2026-11-01 11:14 KST: "폰1 폰2에 테이블 사이드 설정은 사람이 하는게 맞는것 같아 ... 이 기능이 가장 처음 외곽선 설정 시 들어가고, 설정 창에서도 수정할 수 있게". This replaces the automatic matching of 2026-10-31 (bounce vote deciding phone 2's colour, "끝 색 확인 중" until decided, the phone-2 prompt after 60 s, the primary writing phone 2's colour). A wrong near colour on phone 2 still matters (public videos: correct 36 -> 4, questions 5 -> 107 over 54 points), so each phone's pick is part of its calibration.

- Calibration: after the four corners the guide's step reads "끝 색" and says "내 쪽은 블루 끝이에요. 맞으면 확인, 아니면 ⇄" (or 레드); the picture names both ends ("블루 끝" / "레드 끝") and "⇄ 색 바꾸기" in the button row swaps them. 확인 keeps both. The bar's height does not change (qa/calib-taps.mjs). While the corner snap runs or asks for a drag, its message shows first.
- Settings: "카메라 앞쪽" (앞쪽 블루 사이드 / 앞쪽 레드 사이드) changes it later, on phone 1 or phone 2. A change is sent to the other phone at once.
- Each camera sends its near colour in the status and on every segment (`near`). Merging reads each phone's rallies with its own pick from the first rally: nothing waits for a vote.
- The warning, and since 2026-11-01 the hold below: the primary still compares bounces both phones saw (within 0.1 s; `multicam.js` `endVotes`). When three of the last six votes say the other phone's pick is turned (and more than say it is right), the other camera's chip turns the warning colour ("끝 색 반대?" in portrait) and "두 폰 끝 색이 반대로 보여요 · 설정에서 확인" shows once. Merging goes on with the picks, but no point is entered by itself until a pick changes (Score hold, below); a new pick on either phone clears it. Offline on the public videos (both picks right, 8,811 trials with up to 0.5 m calibration noise): 0 warnings; with one pick turned, 8,807 of 8,811 warned. Below about 16 fps of analysis no bounce is found, so there is no warning either.
- Each saved rally records `analysisFps` (median of the once-a-second analysis readings during that rally) and `screen` (viewport width and height only, nothing naming the device).
- Screens: with one camera a chip says where blue and red are in the picture ("왼쪽 블루 · 오른쪽 레드"). With two, the top row keeps the other camera's chip only (the landscape row ends a few px before the controls), which turns the warning colour for the warning above. The camera overlay draws the two end lines thin, dotted and see-through (owner: "얇은 점선", "반투명"), under the trail, LOCK and plates; they are on the display overlay only and never in the frames the analysis reads. When a panel or the screen edge hides an end line, its "블루 끝" / "레드 끝" label keeps off the table, the buttons, the panels, the name and standing plates, the LOCK bracket and each player's body (the box around the drawn joints and foot ring); with no free spot the panel's end-colour border alone marks the end. The referee and TV cards say "블루 끝 · 카메라1 쪽", with a small table map under the camera line. 자리 교체 moves the names; the end colours stay on the table. The court map draws the table's two ends (its short edges) in their own colours, the near end in its colour and the far end in the other, so it follows a colour swap (⇄ or settings) and keeps its colours through 자리 교체 (the ends do not move). An end line under the court map gets no border, label or arrow; one under the players panel keeps its border and label.

## Score hold (점수 보류)

Owner, 2026-11-01 13:47 KST: "점수 막아야 하는거 아니야? 애당초 점수를 어디 올려야 하는지 모르짖아?". When the end check warns, nobody knows which phone's pick is turned (the check is relative: it names the other camera even when the primary's own pick is the turned one), so no player can be trusted from a judged near / far. Before this, the primary went on entering points by itself: on the public rallies (`qa/end-hold-sim.mjs`, 79 rallies) a turned primary put every point the secondary missed on the wrong player (79/79), and a turned secondary put 43/79 on the wrong player when the primary lost the last bounce.

- From the warning on, every judged rally of that match asks on the primary: the 누가 땄나요 bar reads "누가 땄나요? 점수 보류 · 끝 색 확인" with [블루 득점] / [레드 득점]. The tap names an end colour, which the match's ends turn into a player, so it is right whatever either camera picked. With 확인 후 입력 (the default since the owner decision of 2026-11-01, `tournament.js` `POINT_ENTRY`) every point already waits on that bar with the camera's call chosen; while held nothing is chosen, and the referee screen shows the same question ("누가 땄나요? 점수 보류 · 끝 색 확인 · 득점한 쪽 점수판을 눌러 주세요"), where tapping the card that won enters it. The question stays until answered or the next judged point replaces it. (`multicam.js` `scoreAction`; the roster's `ask` carries the open question to the referee screen)
- The hold ends when a person changes a pick on either phone (settings "카메라 앞쪽", or the calibration step), and automatic points come back from the next rally. If the picks still disagree, the next shared bounces warn again, before that rally is scored.
- Screens: the warning chip reads "점수 보류 · 끝 색 반대?" on both phones ("보류 · 끝 색 반대?" in the landscape top strip, which has no room for more) (the secondary hears the hold in the primary's status), and settings say how to end it. The tournament roster carries `hold` on the primary's row, and the referee bar shows "점수 보류 · 끝 색 확인" in place of "카메라 2대 합치기" (the match tab's camera card adds it in front).
- One camera left while held (the other phone went off after the warning): it may be the turned one, so it keeps asking; its own chip reads "점수 보류 · 끝 색 확인" and opens settings, where a pick (even the same colour, confirmed) ends the hold. A secondary keeps the primary's hold for the same reason. The hold is per match and kept on the phone across a reload (`ppv.endHold`).
- Points entered before the warning: the primary lists each point it entered from its own call (by itself, or the call confirmed with one tap) since the picks last changed, except points two cameras both saw to the last bounce and agreed on (a turned pick turns its own call, so agreement is not in doubt). At the warning it writes the tournament action `mark` {matchId, index, side, on:true} for each (refused if that point changed since). The referee screen shows the earliest: "끝 색 확인 1/n · k번째 포인트 · <이름> 득점" with [반대로] (action `flip`: that point goes to the other player, every later point stays, clips stay; refused if the match would have ended earlier) and [맞음] (`mark` on:false). Nothing changes by itself.
- Copy for the English mode: `docs/copy-end-hold.md`.

## Joining and leaving

- After the WebSocket hello, a camera with the PIN on a match calls POST /api/vision/attach {conn, id, matchId} with `x-pin`. With no PIN, or a wrong PIN, it gets 403 and is not attached; the PIN lockout counts that try. The server forgets an attachment when the socket closes, when the hello names another match or `linked:false`, or after 15 s with no message.
- Roster `{type:"cameras", matches:{id:[{id, primary, ball, active, rttMs, fresh}]}}` goes to every screen. A device has one row: a reload or reconnect of the same phone drops its old socket's row. The primary is the earliest attached camera; when it leaves, the next one becomes primary and keeps judging alone.
- Counting cameras: a phone counts another camera only while it has heard that camera's status in the last 3 s, and the referee and spectator screens count only rows still reporting. With one live camera, the phone is the one camera and scores by the one-camera path; the merge code does not run.
- A camera whose status is more than 3 s old is "느림" and is not waited for: the primary judges alone.
- Screens: the camera, referee, and spectator screens show "카메라 1대" / "카메라 2대 합치기" small, and a short toast at the switch: "카메라 2대로 전환" / "카메라 1대로 전환". The camera also shows each camera's ball state (공 보임/놓침) and the clock ±ms.
- Roster and relay stay in memory, and joining or leaving does not change `rev`. The only writes are points and clips, and the 끝 색 확인 marks of the score hold.

## QA

- `bun qa/multicam-offline.mjs` builds two masked copies of the same public video. Each copy hides a different stretch of the ball's path, the way a player's body would. It compares one camera against the merge on bounces and points vs OpenTTGames GT, with duplicates and conflicts.
- `qa/end-label-overlap.mjs` plays a public clip on the camera screen at several sizes and counts, frame by frame, the pixels where an end label overlaps a player's body, a plate, the LOCK box, a button, a panel or the table (0 to pass).
- `qa/end-hold-sim.mjs` runs the app's judging and end check on the public rallies with one pick turned, and counts what the primary does (right / wrong player, ask) before and while held.
- `qa/end-hold-e2e.mjs --inject=1` runs the score hold on the real apps: picks right (no hold), secondary turned, the referee's marks, the fix, primary turned, and one phone off while held, with 393x852 and 852x393 captures and text-over-button counts.
- `qa/multicam-e2e.mjs` runs two Chromium fake cameras on an isolated tournament. It covers attach with and without the PIN, the 1↔2 switch and toast on the camera, referee, and spectator screens, the drop of one camera, no double point, and the clock error.
