# 분석 데스크 worker

대회 서버는 분석을 직접 돌리지 않는다. 서버는 일감(job)만 적어 두고, 이 PC에서 따로 도는 **desk-worker**가 일감을 하나씩 받아 분석기를 돌린 뒤 결과를 돌려준다. 분석기는 GPU 작업 큐를 거쳐 실행되므로, 다른 무거운 작업과 GPU가 겹치지 않는다. 큐가 언제 돌릴지 정한다.

```
대회 서버 ──claim──▶ desk-worker ──heavy desk-<jobId> --mem <추정> --▶ desk/analyze.js (헤드리스 Chromium + Pipeline)
          ◀─progress/result──┘
```

## 구성 파일

| 파일 | 하는 일 |
|---|---|
| `desk/worker.js` | 일감 받기, 영상 내려받기, 큐로 분석기 실행, 진행 보고(리스 갱신), 결과 보내기 |
| `desk/analyze.js` | 영상 하나를 헤드리스 Chromium에서 실제 `Pipeline`으로 모든 프레임 처리(포즈 `full` 모델). stdout에 JSON 줄. 포즈를 어디서 돌릴지(`--delegate`)의 기본은 랠리 일감이 `CPU`, 갤러리 일감이 `GPU`다. 이 Chromium의 GPU는 CPU로 그리는 SwiftShader라서 `GPU`가 더 느리다(16장 랠리 12.3초 대 CPU 2.1초). 랠리 일감은 샷을 폰 트랙에서 받고 관절만 데스크가 보므로 CPU로 바꿔도 샷·손·종류는 그대로다. 갤러리 일감은 관절이 샷 찾기에도 쓰여서, 라벨 공개 영상에서 CPU 관절이 진짜 샷 9개 중 2개를 놓쳤다. 그래서 갤러리는 GPU로 둔다 |
| `desk/pass1.js` | 갤러리 일감의 1차: ffmpeg로 영상을 순서대로 풀어 앱의 `Pipeline.processPixels`(자세 없음)로 샷·바운드·종류·승자를 찾는다. 브라우저와 GPU 작업 큐를 쓰지 않는다(아래 '갤러리 일감: 샷 먼저, 포·백 나중') |
| `desk/page/analyze.js` | 브라우저 쪽. `qa/eval.js`와 같은 방식으로 Pipeline을 돌리고, 랠리마다 `RallyShots`(public/js/analysis-record.js)로 샷을 모은다 |
| `desk/page/pose-buffer.js` | 프레임마다 두 선수의 관절을 1.2초 버퍼에 두고, 샷마다 기준 시각의 관절을 꺼낸다(아래 '샷마다 자세') |
| `desk/run-state.js` | 랠리를 대회 Rally 기록으로 바꾸고 `judgePoint`(public/js/point.js)로 승자를 정한다. 체크포인트 관리 |
| `desk/checkpoint.js` | 30초마다 체크포인트 저장, 일감마다 분석기 하나만 돌게 하는 잠금 |
| `desk/heavy.js` | 큐의 HEAVY_WAIT / HEAVY_ADMIT 줄 읽기, 대기 순번 계산 |
| `deploy/pingpong-desk-worker.service` | systemd 사용자 유닛 틀 |
| `deploy/install-desk-worker.sh` | 유닛 파일을 써 주는 스크립트(켜지는 않는다) |

판정 코드(rally.js, pipeline.js, players.js)는 고치지 않고 그대로 쓴다.

## 설치

필요한 것: bun, ffprobe, `bun install`로 받은 playwright Chromium, GPU 작업 큐 명령.

```bash
deploy/install-desk-worker.sh --data-dir <대회 서버의 DATA_DIR> --server <대회 서버 주소> \
  --heavy <GPU 작업 큐 명령> --heavy-queue-dir <큐 폴더>             # 유닛 파일만 쓴다
deploy/install-desk-worker.sh ... --dry-run                             # 같은 인자로, 쓰지 않고 내용만 보기
systemctl --user daemon-reload
systemctl --user enable --now pingpong-desk-worker.service
journalctl --user -u pingpong-desk-worker -f
```

유닛은 `~/.config/systemd/user/pingpong-desk-worker.service`에 생긴다. 대회 서버의 서비스와는 따로 돈다. 서버를 다시 켜도 worker는 멈추지 않고, worker가 꺼져 있어도 서버는 일감을 받아 둔다.

**비전 배포 뒤에는 worker도 다시 켠다.** worker는 켤 때의 `current`(릴리스 폴더)에서 돌기 때문에 새 릴리스를 쓰려면 `systemctl --user restart pingpong-desk-worker`가 필요하다. `./start.sh --restart`는 worker가 켜져 있으면 이것을 함께 한다. 분석 중이던 일감은 멈췄다가 체크포인트에서 이어 간다.

### 환경 변수

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `TOURNAMENT_DATA_DIR` | (필수, 또는 `DESK_TOKEN_FILE`) | 대회 서버의 DATA_DIR. 토큰은 `<DATA_DIR>/desk/worker-token` |
| `DESK_TOKEN_FILE` | | 토큰 파일을 직접 지정 |
| `DESK_SERVER` | (필수) | 대회 서버 주소(이 PC의 루프백). 서버가 루프백만 받는다 |
| `DESK_STATE_DIR` | `~/.local/state/pingpong-desk` | 영상 캐시(`videos/`), 체크포인트(`checkpoints/`), 실행 중 표시(`active.json`) |
| `DESK_HEAVY` | (필수) | 이 PC의 GPU 작업 큐 명령(공백으로 나눈 인자) |
| `DESK_HEAVY_QUEUE_DIR` | (필수) | 대기 순번을 읽는 큐 폴더 |
| `DESK_ANALYZER` | `bun desk/analyze.js` | 분석기 명령(시험용으로 바꿀 수 있다) |
| `DESK_FIRST_PASS` | `bun desk/pass1.js` | 갤러리 1차 명령(시험용으로 바꿀 수 있다) |
| `DESK_PROGRESS_MIN_MS` | `5000` | 프레임 진행 보고의 최소 간격 |

## 서버와 주고받는 것

모든 요청에 `x-desk-worker: <worker-token 내용>` 머리말을 붙인다.

| 요청 | 내용 |
|---|---|
| `POST /api/desk/worker/heartbeat` | worker가 켜져 있는 동안 10초마다(일감이 있든 없든). 서버는 30초 안에 신호가 있으면 '켜져 있음'으로 보인다 |
| `POST /api/desk/worker/claim` | 본문 `{worker:"<호스트>:<pid>"}`. `{job}`(리스 90초, 받은 직후 상태는 `waiting`) 또는 204(일감 없음, 1초 뒤 다시) |
| `GET /api/desk/worker/jobs/:id/video` | 영상. `videos/<id>.video.part`로 받고 끝나면 이름을 바꾼다 |
| `POST /api/desk/worker/jobs/:id/progress` | `{state:'waiting'\|'running', progress:{done,total}\|null, waitPos:number\|null}`. 리스를 갱신한다 |
| `POST /api/desk/worker/jobs/:id/early` | 갤러리 일감만. `{rallies:[Rally]}`(1차, `stroke`는 모두 `null`). 서버는 바로 저장해 보여 주고 일감 `note.handPending`을 켜며 리스를 갱신한다. 랠리 일감은 409 |
| `POST /api/desk/worker/jobs/:id/result` | `{rallies:[Rally], pose}` 또는 `{error}`. `pose`는 아래 '샷마다 자세'. 갤러리 일감은 1차를 덮어쓰고 `handPending`을 지운다 |

서버는 `X-Forwarded-For`가 붙은 요청을 막으므로 worker는 프록시 없이 `127.0.0.1`로 바로 부른다.

진행 보고는 상태가 바뀔 때 바로, 프레임 수는 5초에 한 번까지, 그리고 마지막 보고 뒤 **20초**가 지나면 무조건 한 번 보낸다. 서버가 요구하는 "30초에 한 번 이상"보다 여유를 둔 값이다. 보고는 순서대로 하나씩 나가므로 서버는 상태를 일어난 순서로 받는다. progress에 404/409/410이 오면(일감이 지워졌거나 리스를 잃음) 분석기를 멈추고 결과를 보내지 않는다.

Rally 기록: `{v:1, index, source:'desk', startedAt, durationMs, winner:'near'|'far'|null, nearSlot:0, why, shots:[{side,t,stroke,kind,speedKmh,arc,inferred,land}], bounces:[{tx,ty,side,t}]}`. `index`는 영상 안의 랠리 순서, `startedAt`은 일감의 `playedAt`(서버에는 날짜 문자열로 있어 `Date.parse`로 읽고, 읽을 수 없으면 `createdAt`) + 랠리 시작의 영상 시각(ms). 분석기는 `nearSlot:0`을 보낸다. 갤러리 일감에서는 그대로 맞다(가까운 쪽이 `players.near`). 랠리 일감에서는 서버가 대회의 엔드와 일감의 `nearEnd`로 다시 정하고, `index`도 일감의 `matchRef.index`로 바꾼다(클립 하나는 랠리 하나).

일감에 꼭짓점이 없으면(`corners:null`) 분석기를 띄우지 않고 `{error}`를 보낸다. 승자는 `judgePoint`가 바운드로 정하고, 바운드가 없으면 `null`이다.

## 갤러리 일감: 샷 먼저, 포·백 나중

갤러리 일감(영상 통째 올리기)은 두 번 나눠 보여 준다.

1. **1차(`desk/pass1.js`)**: worker가 영상을 받은 뒤 GPU 작업 큐를 거치지 않고 바로 돌린다(CPU 하나, 브라우저 없음). ffmpeg가 처리 폭(640)으로 순서대로 푼 프레임을 앱의 `Pipeline.processPixels`(탁구대 확인, 흔들림 문, 공 잠금, 랠리)로 보고, 분석기와 같은 `DeskRallies`·`deskRally`로 Rally 기록을 만든다. 샷·바운드·종류·승자가 다 있고 `stroke`만 `null`이다. 결과는 `checkpoints/<id>.shots.json`에 두고 `/early`로 보낸다. worker는 일감을 하나씩 돌리므로 1차도 한 번에 하나만 돈다. 다시 맡은 일감은 남긴 파일을 그대로 쓴다. 1차가 실패하면 먼저 보여 주기만 빠지고, 2차는 전처럼 자기 샷으로 끝난다.
2. **2차(`desk/analyze.js --shots`)**: 지금 분석기를 큐로 그대로 돌린다. 모든 프레임에 GPU(SwiftShader) 자세를 돌리되 자기 샷은 모으지 않는다. 1차 샷마다 그 시각 0.3초 뒤에 `rally.js`와 같은 `strokeSide(players.landmarksAt(쪽, 시각), 손)`으로 포핸드·백핸드를, `ShotPoses`로 관절을 읽어 `{fill}`로 보낸다. 끝에 1차 랠리에 채운 포·백과 관절을 붙여 `/result`로 보낸다. 포·백은 같은 쪽 150ms(`SAME_HIT_S`) 안에 이 회차의 자기 샷이 있으면 그 샷의 것을 쓰고, 없으면 1차 샷 시각에서 `strokeSide`로 읽는다(시각만으로 짝짓으면 같은 샷의 시각이 중앙 50ms, 90%는 467ms까지 달라 포·백 '없음'이 늘었다). 다시 시작한 분석기는 채운 샷을 건너뛰고, 다음 샷 1.2초 전부터 다시 돌아 관절 버퍼를 채운다.

**먼 쪽 선수(`desk/page/far-crop.js`, `desk/page/fresh-joints.js`)**: 세로 영상에서 먼 쪽 선수는 작아서 화면 전체 자세로는 잘 안 잡힌다(test_5 앞 24초: 가까운 쪽 43%, 먼 쪽 5.7%의 프레임, 먼 쪽 최대 14.7초 공백). 2차는 먼 쪽 1차 샷 ±0.15초 프레임에서 화면 전체가 먼 쪽 선수를 새로 못 봤으면, 탁구대 위쪽 두 모서리(먼 쪽 끝선)로 정한 상자(끝선 길이의 옆 0.6·위 1.4·아래 0.35배)를 잘라 키워 두 번째 자세 모델로 보고, 그 관절을 영상 좌표로 되돌려 `players.assign`·`updateOne`으로 먼 쪽에 넣는다. 그리고 채울 때 치는 쪽의 가장 가까운 실제 검출이 샷에서 0.2초(`MAX_JOINT_AGE_S`)보다 멀면 포·백을 정하지 않는다(`null`): `landmarksAt`은 못 본 동안 몇 초 전 관절을 돌려주고, test_5 먼 쪽 판정 9개가 1.3~14초 묵은 관절에서 나와 4개만 맞았다. 라벨 두 영상 합 포·백(맞음/틀림/없음): 이전 28/16/7 → 28/12/11(판정 중 맞음 64% → 70%). test_2는 그대로 21/2/5, 바뀐 것은 모두 test_5 먼 쪽(4/6/2 → 4/2/6). 폰 파이프라인과 `rally.js`는 바뀌지 않는다.

**랠리 원본의 먼 쪽 선수(`hiddenLegsFar`)**: 다시 보기 원본(트랙 경로)도 먼 쪽 샷마다 그 샷 −0.85~+0.05초 프레임에서 화면 전체가 먼 쪽 선수를 못 봤으면 같은 상자를 잘라 키워 본다. 탁구대 옆에서 찍은 가로 영상은 탁구대가 먼 쪽 선수의 다리를 가려, 몸통이 확실히 보여도(네 점 신뢰도 0.96 이상) `players.js` `plausiblePerson`의 다리·바닥 조건에 걸려 버려졌다. 그래서 이 경로에서만, 잘라 키운 상자에서 `players.assign`이 아무도 먼 쪽에 넣지 않았을 때 몸통 네 점이 0.6 이상이고 엉덩이 가운데가 상자 안이며 먼 끝에 더 가까운 사람(여럿이면 몸통이 가장 긴 사람)을 먼 쪽 선수로 넣는다. 카메라의 선수 판정과 점수는 그대로다. 실제 경기 원본 두 개(가로 960×540)에서 먼 쪽 서브의 기준 시각 관절이 1/3 → 3/3, 0/1 → 1/1(클립 안에 든 시각만)이 됐다.

대회 서버는 1차 파일에 `handPending:true`를 두고, 데스크 화면과 분석 화면은 '포·백 분석 중'을 보여 주며 10초마다 다시 읽는다. 일감이 끝내 실패하면 표시를 지우고 1차만 남긴다.

라벨 공개 영상 두 개(test_2 30초·샷 29개, test_5 96초·샷 27개)에서 1차는 라벨 샷 51/56개·거짓 샷 48개(이전 갤러리 46·54), 종류 맞음 45·틀림 6(이전 40·6)이고, 부하 약 11에서 30초 영상 6.5초·96초 영상 20초가 걸렸다. 자세가 몸 상자를 공 찾기에서 빼지 않아 몸 가까이 있는 공을 더 찾는다.

## 샷마다 자세

분석기만 샷마다 관절을 남긴다. 폰 카메라는 남기지 않는다. `createPose`의 `world` 옵션은 기본이 꺼짐이고, 꺼져 있으면 `detect()`는 전과 같은 값을 주며 world landmarks를 읽지도 않는다. rally.js, pipeline.js, players.js는 그대로다. 페이지는 `process()`가 끝난 뒤 `pipe.players`를 읽기만 한다.

결과의 `pose`는 Rally 밖에 있다. `{ [랠리 index]: { [샷 index]: { pose2d, pose3d } } }`이고, 샷 index는 Rally의 `shots` 순서(시각 순)다. 자세가 하나도 없는 샷은 항목이 없다.

```
pose2d: { model:"mediapipe-full", at:[-0.77,-0.4,0], hand:"R"|"L"|null, vote:"R"|"L"|null, frames:[ [[x,y,v] x 23] | null x 3 ] }
pose3d: { frames:[ [[x,y,z,v] x 23] | null x 3 ] }
```

- 관절 23개: 코(0)와 MediaPipe 11~32번. 다른 얼굴 점은 버린다. 순서는 `JOINTS`(desk/page/pose-buffer.js)다.
- `at`: 샷 시각에서 몇 초 전인지. 공 맞는 순간과 0.4초 전, 0.77초 전.
- 2D: 양 엉덩이 가운데가 원점, 몸통 길이(어깨 가운데에서 엉덩이 가운데까지)가 1이다. 소수 셋째 자리까지. 그래서 몸 크기와 화면 속 위치가 빠진다.
- 3D: MediaPipe world landmarks 그대로(엉덩이 중심, 미터, 소수 셋째 자리). 몸 크기와 방향은 읽는 쪽이 맞춘다. 카메라 하나로 만든 값이라 깊이(z)는 추정이고, 화면에도 그렇게 적어야 한다.
- 버퍼: 시간 기준 약 1.2초(끝 쪽). 프레임 수가 아니라 시각으로 자른다. 기준 시각과 가장 가까운 프레임이 0.05초 안에 없거나 버퍼를 벗어나면 그 프레임은 `null`이다. 샷을 알게 된 시각이 공 맞은 뒤 0.43초보다 늦으면 -0.77 프레임이 `null`이 된다.
- `hand`: 분석기가 영상에서 정한다. 샷마다 공 맞기 전 0.3초 동안 두 손목(15, 16번) 가운데 더 빨리 움직인 쪽에 한 표를 주고(두 장면 넘게 잘 보인 손목만), 일감 전체에서 그 끝(near, far)의 다수결로 정한다. 표가 5개 미만이거나 같으면 `null`이고, 추측하지 않는다. 그 끝의 모든 샷이 같은 값을 받는다. 샷마다 자기 표도 `vote`로 함께 보낸다(표가 없으면 `null`). 포인트 클립 일감은 샷이 한두 개라 `hand`가 늘 `null`이므로, 대회 서버가 그 선수의 모든 샷 표로 다시 정한다(대회 docs/analytics.md 자세 비교). `players.js`의 `hand`는 쓰지 않는다(데스크에는 손 설정이 없어 늘 `R`이다).
- 일감 기준이라 갤러리 경기에서 선수가 끝을 바꾸면 한 끝에 두 사람의 표가 섞인다. 갤러리는 `players.near`가 가까운 쪽이라는 전제를 따른다.
- 체크포인트에도 `pose`가 함께 저장되어, 다시 시작해도 앞 랠리의 자세가 남는다. `pose`가 없는 옛 체크포인트는 빈 값으로 읽는다.

## GPU 작업 큐와 대기 순번(waitPos)

worker는 `heavy desk-<jobId> --mem <추정> -- <분석기 명령>`으로 분석기를 띄운다. 메모리 추정은 `4G + 영상 크기(GB, 올림)`이다(Chromium과 full 포즈 모델이 약 3 GB, 영상 버퍼가 나머지). 큐는 stderr에 다음 줄을 낸다.

```
HEAVY_WAIT desk-j1: 2 job(s) ahead in the queue                   -> waitPos 3
HEAVY_WAIT desk-j1: slot.1 was taken 5s ago; its load shows ...   -> waitPos 1
HEAVY_WAIT desk-j1: 1 running; gpu ...% -> ... free ...           -> waitPos 1
HEAVY_ADMIT desk-j1 slot.1: ...                                   -> state running
```

- `n job(s) ahead in the queue`이면 내 앞에 n개가 있으므로 **waitPos = n+1**(데스크 화면의 "대기 중 n번째").
- 다른 HEAVY_WAIT(슬롯이 차 있음, GPU·CPU·메모리 여유 부족, 방금 시작한 작업의 부하를 기다림)는 내가 줄 맨 앞에서 GPU가 비기를 기다린다는 뜻이므로 **waitPos = 1**.
- 큐는 기다리는 **이유가 바뀔 때만** HEAVY_WAIT를 다시 찍는다. 앞의 작업이 하나 빠져도 "2 job(s) ahead"가 다시 찍히지 않는다. 그래서 worker는 리스를 갱신할 때마다(20초) 큐 폴더(`DESK_HEAVY_QUEUE_DIR`)를 읽는다. 큐 폴더에는 기다리는 작업마다 `<등록 시각 ms 15자리>-<pid>-<label>` 이름의 표가 있고, 이름 순서가 곧 줄 순서다. 내 표(`desk-<jobId>`)가 몇 번째인지가 waitPos다. 표가 없으면(이미 시작됐거나 아직 등록 전) 마지막 HEAVY_WAIT 줄의 값을 그대로 둔다.
- 같은 줄은 큐의 로그 파일(큐 상태 폴더의 `heavy/heavy.log`)에도 남는다. 문제를 볼 때는 `grep desk- heavy.log`로 언제 기다리고 언제 시작했는지 확인한다.

## 복구

- **분석기 체크포인트**: 분석기는 30초마다 `checkpoints/<jobId>.json`에 처리한 마지막 프레임과 시각, 다시 시작할 곳(`resumeFrame`/`resumeT`), 지금까지의 랠리를 원자적으로(tmp 뒤 rename) 쓴다. 다시 시작할 곳은 마지막으로 랠리가 열려 있지 않던 프레임 다음이다. 그래서 다시 켜도 랠리가 둘로 잘리지 않는다. 같은 영상(크기와 fps가 같음)의 체크포인트만 이어 쓴다. 다시 시작한 Pipeline은 공 추적을 새로 시작하므로, 다시 시작한 곳 바로 뒤의 몇 프레임은 끊김 없이 돌린 결과와 조금 다를 수 있다.
- **worker가 죽으면**: 결과를 보내지 않으므로 서버의 리스(90초)가 끝나면 일감이 다시 나간다. 다음 worker가 같은 일감을 받으면 캐시된 영상과 체크포인트로 이어서 돌린다.
- **남은 분석기 정리**: 큐는 분석기를 자기 systemd scope에서 돌린다. 그래서 worker 유닛이 죽어도 분석기는 살아 있을 수 있다. worker는 시작할 때 `active.json`(큐 프로세스 pid)과 `checkpoints/<jobId>.json.pid`(분석기 pid)를 읽어 남은 프로세스를 멈춘다. pid가 다른 프로그램에 재사용된 경우를 막으려고, 명령줄에 그 일감의 표시(label 또는 체크포인트 경로)가 있을 때만 멈춘다. 분석기도 시작할 때 같은 잠금 파일을 보고 앞의 분석기를 멈춘다. 그래서 한 일감에는 분석기가 늘 하나다.
- **worker를 멈추면**(`systemctl --user stop`): SIGTERM을 받으면 분석기를 멈추고 결과 없이 끝난다. 체크포인트는 남는다.
- **결과를 보낸 뒤**: 서버가 받으면(또는 404, 일감이 지워짐) 영상 캐시, 체크포인트, 잠금, `active.json`을 지운다. 409(리스가 끝나 일감이 대기열로 돌아감)나 네트워크 오류면 파일을 남긴다. 다시 받으면 끝난 체크포인트에서 바로 같은 결과를 낸다.
- **오류와 재시도**: worker는 같은 일감을 스스로 다시 돌리지 않는다. `{error}`를 보내거나 리스가 끝나면 서버가 `attempts`를 1 올려 대기열로 돌리고, 세 번째에 `failed`로 둔다. 오류를 보낸 일감의 캐시와 체크포인트는 지우므로, 다시 받으면 처음부터 돈다.
- **분석기 실패**: 종료 코드가 0이 아니거나 랠리 줄이 없으면 `{error: "analyzer exited <code>: <stderr 마지막 줄들>"}`을 보낸다. 큐가 메모리 상한을 넘은 작업을 죽이면 종료 코드는 137이다.

## 분석기만 따로 돌리기

```bash
heavy desk-try --mem 6G -- bun desk/analyze.js --video clip.mp4 \
  --corners '[{"x":236.7,"y":422.7},{"x":371.3,"y":346},{"x":892.7,"y":356.7},{"x":990.7,"y":439.3}]' \
  --checkpoint /tmp/desk-try.json --played-at 0 > rallies.jsonl
```

꼭짓점은 **그 영상의 픽셀 좌표**다. `qa/eval-set.json`의 꼭짓점은 1920×1080 원본 기준이므로, 720p로 줄인 클립에는 2/3을 곱해야 한다. 곱하지 않으면 탁자를 못 찾아 랠리가 0개로 나온다.

## 시험

`bun test test/desk-worker.test.js test/pose-buffer.test.js test/pose-option.test.js`. 가짜 대회 서버(Bun.serve)와 가짜 큐(`test/fixtures/desk/fake-heavy.sh`)를 쓴다. 가짜 큐는 HEAVY_WAIT 두 줄과 HEAVY_ADMIT를 찍고 가짜 분석기(`fake-analyzer.js`)를 띄운다. 가짜 분석기는 진짜 `AnalysisRun`과 `Checkpoint`를 쓴다. 시계는 주입한 가짜 시계를 쓰고, 대기는 fifo로 막았다 푼다. sleep은 쓰지 않는다.
