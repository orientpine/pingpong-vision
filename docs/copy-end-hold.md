# Score hold copy (점수 보류)

Every string the score hold added (docs/multicam.md "Score hold"), for the English mode to carry over.
Where each one shows is in the second column. The English column is a suggestion.

| Korean | Where | English (suggested) |
|---|---|---|
| 점수 보류 · 끝 색 확인 | vision `multicam.js` `HOLD_REASON`: the 누가 땄나요 bar ("누가 땄나요? …"), the one-camera chip while held; tournament `role.js` `HOLD_TEXT`: the referee bar and the match tab's camera card | Scoring paused · check end colours |
| 점수 보류 | vision `ui.js` `HOLD_SHORT`: prefix on the warning chip ("점수 보류 · 끝 색 반대?") | Scoring paused |
| 보류 | vision `ui.js` `HOLD_STRIP`: the same prefix in the landscape top strip ("보류 · 끝 색 반대?", no room for more) | Paused |
| 점수 보류 중: 두 폰 끝 색이 반대로 보여요 · 어느 폰이든 앞쪽 사이드를 고치면 풀려요. 그때까지 카메라 판정 없이 누가 땄나요에서 직접 골라요 | vision `ui.js` `END_WARN_HOLD`: the warning line in settings while held | Scoring paused: the two phones' end colours look opposite · fixing the near side on either phone ends it. Until then pick the winner in "Who won it?" yourself, with no camera call |
| 점수 보류 · 끝 색 확인 · 어느 폰이든 끝 색을 고치면 풀려요 | tournament `app.js`: line under the referee cards on a narrow screen (the bar shows only the icon there) | Scoring paused · check end colours · fixing the end colour on either phone ends it |
| 점수 보류 · 끝 색 확인 · 설정 열기 | vision `ui.js`: aria-label of the one-camera chip while held | Scoring paused · check end colours · open settings |
| 끝 색 확인 1/n · k번째 포인트 · <이름> 득점 | tournament `app.js` `checkRow`: the referee screen row for a marked point | End colours · 1/n · point k · <name> scored |
| 카메라는 <블루/레드> · 맞으면 한 번 눌러 확정 (확실하지 않으면 "<색>(확실하지 않음)") | vision `ui.js` `CONFIRM_TEXT`: 누가 땄나요 bar in 확인 후 입력 ("누가 땄나요? …") | Camera says <blue/red> · tap once to confirm |
| 카메라 판정 | vision `ui.js` `CAMERA_CALL`: small line on the pre-chosen button; tournament `app.js`: tag on the referee card | Camera's call |
| 점수 입력: 확인 후 입력 · 포인트마다 카메라 판정을 한 번 눌러 확정해요 (심판 화면에서도) | vision `ui.js` `ENTRY_NOTE`: settings, in place of the 자동 입력 choice | Scoring: confirm first · tap the camera's call once for each point (also on the referee screen) |
| 포인트가 끝나면 카메라 판정을 한 번 눌러 확정해요. | vision `ui.js`: settings status line | When a point ends, tap the camera's call once to confirm. |
| 앞 포인트는 입력하지 않았어요 · 심판 화면에서 넣어 주세요 | vision `tournament.js`: notice when the next call replaces an unanswered one | The previous point was not entered · enter it on the referee screen |
| 심판 화면에서 점수를 넣었어요 | vision `tournament.js`: notice when the referee answered the camera's question | The referee entered the point |
| 카메라 판정 확인 <블루/레드> <이름> 득점? [확정] | tournament `app.js` `askRow`: referee screen row | Camera's call: <blue/red> <name> scored? [Confirm] |
| 누가 땄나요? <점수 보류 · 끝 색 확인 / 카메라 판정이 엇갈려요> · 득점한 쪽 점수판을 눌러 주세요 | tournament `app.js` `askRow`: referee row when no call is chosen | Who won it? <scoring paused · check end colours / the cameras disagree> · tap the winner's card |
| 반대로 | tournament `app.js`: referee row button (give the point to the other player) | Swap |
| 맞음 | tournament `app.js`: referee row button (the point was right) | Correct |
| k번째 포인트를 <이름> 득점으로 바꿀까요? 뒤의 포인트는 그대로예요. | tournament `app.js`: confirm before 반대로 | Give point k to <name>? Later points stay. |
| 바꾸기 | tournament `app.js`: the confirm button | Swap |
| k번째 포인트를 <이름> 득점으로 바꿨어요 | tournament `app.js`: line under the referee cards after 반대로 (3 s) | Point k now goes to <name>. |
| 그 포인트는 이미 바뀌었습니다. | tournament `engine.js` `markPoint`: refusal (the point changed since) | That point has already changed. |
| 이 포인트를 바꾸면 경기가 더 일찍 끝나요. 점수 취소로 고쳐 주세요. | tournament `engine.js` `flipPoint`: refusal | Swapping this point would end the match earlier. Fix it with undo. |
| 이 경기 결과로 정해진 N경기가 이미 시작되어 바꿀 수 없습니다. 그 경기 점수를 먼저 모두 취소하세요. | tournament `engine.js` `flipPoint`: refusal | Match N, decided by this result, has already started. Undo its points first. |
