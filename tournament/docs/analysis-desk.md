# 분석 데스크 대기열 (서버 쪽)

운영 서버는 GPU를 잡지 않습니다. 서버는 영상을 받아 일감을 적어 두기만 하고, 따로 도는 `desk-worker`(사용자 유닛, vision 저장소)가 일감을 하나씩 가져가 분석합니다. 코드는 `desk-queue.js`(일감과 복구 규칙), `desk-routes.js`(API), `desk-results.js`(결과 저장과 공개 읽기)에 있습니다.

## 파일

| 경로 | 내용 |
|---|---|
| `data/desk/queue.json` | `{v:1, jobs:[Job]}`. 서버 한 프로세스만 쓰고, 바뀔 때마다 임시 파일에 적은 뒤 이름을 바꿉니다 |
| `data/desk/videos/<jobId>.<확장자>` | 올린 영상. 분석이 끝나도 남고, 일감을 지울 때 함께 지워집니다 |
| `data/desk/tracks/<jobId>.json.gz` | 랠리 일감의 다시 보기 트랙(원본의 overlay.json.gz 그대로). 일감을 지울 때 함께 지워집니다 |
| `data/desk/worker-token` | 분석기 열쇠. 첫 부팅에 만들어지고 권한은 600입니다 |
| `data/analysis/g-<jobId>.json` | 갤러리 경기 결과 `{v:1, source:'gallery', id, playedAt, title, players, rallies}` |
| `data/analysis/pose/<경기키>.json` | 샷마다의 자세 `{v:1, rallies}` (형식은 [analytics.md](analytics.md), 자세 비교) |

## Job

`{id, kind:'gallery'|'rally', state, createdAt, updatedAt, title, playedAt, players:{near,far}, corners, video:{name,bytes,received,type}, matchRef, nearEnd, progress, waitPos, error, note, attempts, lease:{worker,until}}`

- `nearEnd`: 랠리 일감에서 카메라가 찍는 가까운 끝, `'blue'|'red'|null`. 대회는 카메라 쪽을 저장하지 않아서 기본값은 `null`(모름)입니다. 갤러리 일감은 항상 `null`입니다.
- `note`: 랠리 일감이 끝나면 `{dropped, nearSlot}`. `dropped`는 클립에서 버린 랠리 수, `nearSlot`은 저장한 랠리의 값(모르면 `null`)입니다.

- `state`: `uploading` → `queued` → `waiting` → `running` → `done` 또는 `failed`
- `createdAt`, `updatedAt`, `lease.until`, `worker.lastSeen`은 밀리초 시각(숫자)입니다.
- `players`는 `'이름,네자리'` 또는 `null`입니다. 입력은 쉼표, 전각 쉼표, 공백을 받고 `이름,0712`로 저장합니다.
- 클레임 직후 상태는 `waiting`(`waitPos`는 null)입니다. 분석기가 GPU 줄 순번을 알면 `waitPos`를 보내고, 화면은 이 값으로 "대기 중 n번째"를 보입니다.

## API

### 데스크 (x-pin 필요)

| 요청 | 설명 |
|---|---|
| `GET /api/desk/jobs` | `{jobs, worker:{alive, lastSeen}}`. 분석기 신호가 30초 안에 있었으면 `alive`입니다 |
| `POST /api/desk/jobs` | 본문 `{kind, title, playedAt, players, video:{name,bytes,type}}`, 답 `{job}`. `kind:'rally'`는 `matchRef:{tournament, matchId, index}`(index는 0 이상 정수, 필수)와 선택 `nearEnd:'blue'|'red'`도 받습니다 |
| `POST /api/desk/jobs/from-save` | 본문 `{save, matchRef:{tournament, matchId, index}, nearEnd, corners}`. 이 PC에 이미 저장된 다시 보기 랠리(pingpong-vision 저장 폴더, `PPV_SAVE_DIR` 또는 `~/pingpong-vision-saves`의 `<save>/`)로 랠리 일감을 바로 `queued`로 만들어요: 영상(`video.mp4`/`video.webm`)을 복사하고 `overlay.json.gz`가 v1 트랙이면 트랙으로 붙여요. `save`는 43자 저장 id만 받고, 저장 폴더 밖을 가리키는 링크·링크 영상은 404. 같은 `save`로 다시 물으면 새로 만들지 않고 `{job, existing:true}`(일감의 `source.save`로 찾아요). 새로 만들면 201 `{job}` |
| `PUT /api/desk/jobs/:id/video?offset=N` | 본문은 영상 조각 그대로(최대 8MiB). `offset`이 `received`와 같을 때만 붙이고 `{received}`로 답합니다. 다 받으면 `queued`가 됩니다 |
| `PUT /api/desk/jobs/:id/track` | 랠리 일감만. 본문은 다시 보기 원본의 `overlay.json.gz` 그대로(gzip, 최대 4MiB, 풀면 64MiB까지, `{v:1, frames:[...]}`만). 워커가 맡기 전(`uploading`·`queued`)에만 받고 `{job}`(job.track = `{bytes, frames}`)으로 답합니다. 형식이 틀리면 400, 크면 413, 이미 분석 중이면 409 |
| `GET /api/desk/jobs/:id` | `{job}`. 다시 연 화면은 `video.received`부터 이어 올립니다 |
| `HEAD /api/desk/jobs/:id` | 받은 바이트 수를 `x-received` 헤더로 줍니다 |
| `POST /api/desk/jobs/:id/corners` | 본문 `{corners:[{x,y} 4개]}` 또는 `{corners:null}` |
| `DELETE /api/desk/jobs/:id` | 일감과 영상을 지웁니다. 이미 저장된 분석 결과는 남습니다 |

오류: 400 형식이 틀림, 404 없는 일감, 409 이어 올릴 위치가 틀림(답에 `received`가 있습니다), 413 영상이 4GiB를 넘거나 조각이 8MiB를 넘음.

### 분석기 (x-desk-worker 필요, 이 컴퓨터 안에서만)

직접 들어온 127.0.0.1 연결만 받습니다. `X-Forwarded-For`가 붙은 요청은 프록시를 거친 것이므로 열쇠가 맞아도 403입니다(tailscale serve도 127.0.0.1에서 접속합니다). 열쇠가 틀리면 401입니다. 받아들인 요청은 모두 `worker.lastSeen`을 새로 적습니다.

| 요청 | 설명 |
|---|---|
| `POST /api/desk/worker/heartbeat` | 일감이 없을 때의 신호. 30초보다 짧은 간격으로 보냅니다 |
| `POST /api/desk/worker/claim` | 본문 `{worker}`(없어도 됨). 가장 오래된 `queued` 일감을 90초 임대로 주고 `{job}`, 없으면 204 |
| `POST /api/desk/worker/jobs/:id/progress` | 본문 `{state:'waiting'|'running', progress:{done,total}|null, waitPos}`. 임대를 90초 연장합니다 |
| `POST /api/desk/worker/jobs/:id/early` | 갤러리 일감만. 본문 `{rallies:[...]}`(1차: 샷·바운드·종류·승자, `stroke`는 `null`). 바로 `g-<id>.json`에 `handPending:true`와 함께 저장하고, 일감 `note.handPending`을 켜고 임대를 90초 연장합니다. 랠리 일감은 409 |
| `POST /api/desk/worker/jobs/:id/result` | 본문 `{rallies:[...], pose?}`(랠리는 모두 `source:'desk'`) 또는 `{error}`. 갤러리 일감은 1차를 덮어쓰고 `handPending`을 지웁니다 |
| `GET /api/desk/worker/jobs/:id/video` | 영상 파일 |
| `GET /api/desk/worker/jobs/:id/track` | 트랙 파일(gzip). 트랙이 없는 일감은 404 |
| (결과의 `timing`) | 랠리 일감 결과 `{rallies, pose, timing}`의 `timing`은 `track`(트랙의 카메라 시각으로 샷을 찾음) 또는 `estimated`(카메라 시각이 없는 옛 원본: 공 위치로 추정)이고, 일감 `note.timing`에 남아 대기열 줄에 `카메라 샷 시각` 또는 `샷 시각은 추정(옛 원본)`으로 보입니다 |

맡고 있지 않은 일감(임대 만료 뒤 등)에 progress나 result를 보내면 409, 지워진 일감이면 404입니다. 두 경우 모두 분석기는 그 일감을 버려야 합니다.

### 공개 읽기 (PIN 없음)

| 요청 | 설명 |
|---|---|
| `GET /api/analysis/gallery/:id` | 갤러리 경기 파일 |
| `GET /api/analysis/matches` | `{items:[{kind,id,title,playedAt,players,score}]}`. 대회 경기와 갤러리 경기가 함께 들어 있습니다([analytics.md](analytics.md) 선수와 달력) |

공개 읽기의 `players`는 이름만 줍니다. 네자리는 PIN을 넣은 데스크 읽기에서만 보입니다.

## 결과 저장

- 갤러리 일감: `data/analysis/g-<jobId>.json`에 적습니다.
- 랠리 일감: `matchRef.tournament`의 대회 분석 파일에 `source:'desk'`로 적습니다. 같은 포인트의 `live`는 그대로 둡니다.
  - 클립 하나는 랠리 하나입니다. 클립의 첫 랠리를 정확히 `matchRef.index`에 적고, 그 자세도 같은 index에 둡니다. 랠리가 더 있으면 버리고 `note.dropped`에 세며, 일감에 `error`를 남깁니다(상태는 `done`). index가 없는 옛 랠리 일감은 아무것도 적지 않고 `failed`입니다.
  - `nearSlot`은 그 포인트 전까지의 점수로 정한 엔드(게임마다, 마지막 게임 5점에 바뀜)에서 `nearEnd` 끝에 선 선수 칸입니다. 엔드 손 고침(`endsFlip`)은 화면들처럼 경기 전체에 걸립니다. `nearEnd`, 대회, 경기, 포인트 중 하나라도 모르면 `nearSlot:null`로 적고, 그 랠리는 선수별 숫자에서 빠집니다(`docs/analytics.md`).

## 다시 켜질 때와 복구

- 갤러리 일감이 끝내 `failed`가 되면(오류 결과 3번, 임대 만료 3번, 서버 재시작 3번) 1차 파일과 일감의 `handPending`을 지웁니다. 1차 샷은 남고, 포·백은 채워지지 않습니다. 다시 줄을 선 일감은 `handPending`을 그대로 둡니다.

- 일감은 모두 디스크에 있어서 서버나 분석기가 죽어도 사라지지 않습니다.
- 서버가 다시 켜지면 `waiting`, `running` 일감은 `attempts`를 1 올려 `queued`로 돌립니다.
- 임대가 끝나면(90초 동안 progress 없음) 같은 방식으로 `queued`로 돌립니다. 5초마다, 그리고 목록 읽기와 클레임 때 확인합니다.
- 분석기가 `{error}`를 보내도 같습니다. 그 오류 문구를 `error`에 남깁니다.
- `attempts`가 3이 되면 `failed`가 되고 마지막 `error`가 남습니다. 성공하면 `error`는 지워집니다.
- 올리던 일감은 `uploading`으로 남습니다. 다시 켜질 때 `received`는 디스크에 실제로 있는 크기를 넘지 않게 맞추고, 조각을 쓸 때 그 뒤에 남은 찌꺼기를 잘라 냅니다.
- `queue.json`이 없으면 빈 대기열입니다. 깨졌거나 v1이 아니면 `queue.json.bad-<시각>`으로 옮겨 두고 빈 대기열로 시작합니다. 일감 하나만 형식이 틀리면 그 일감만 빼고 로그에 남깁니다.

## 기록

분석기의 progress와 heartbeat는 자주 오므로 `action.log`에 적지 않습니다. 영상 조각 PUT도 적지 않습니다. 분석기는 몇 초마다 `POST /api/desk/worker/claim`으로 일감을 묻는데, 일감이 없는 답(204)은 적지 않습니다. 일감을 받아 간 claim, 거절(401·403), 서버 오류(5xx), 결과 보고는 그대로 적습니다.

## 화면: 분석 데스크

코드: `public/desk-view.js`(화면과 올리기), `public/people-pick.js`(등록된 선수 드롭다운, 선수 페이지와 같이 씁), `public/app.js`의 훅(모드 `desk`, 데스크 모드의 첫 탭), `public/style.css`의 `분석 데스크` 블록. 브리프와 `Layout:`은 `DESIGN.md` 5절.

- 들어가는 곳: 모드 고르기의 네 번째 카드 **분석 데스크**. 심판과 같은 대회 PIN으로 열고(PIN이 없으면 카메라와 같은 PIN 대화 상자), 기기에 기억해요. 데스크 모드에서는 첫 탭이 `데스크`이고 대진·순위·기록·설정은 그대로예요. PIN이 지워진 기기는 데스크 화면 안에 PIN 폼을 보여요.
- 대기열: `GET /api/desk/jobs`를 데스크 화면이 보일 때만 3초마다 읽고, 답이 바뀜 때만 다시 그려요(다른 탭·다른 화면·숨은 탭에서는 멈춤). 상태는 우리말 한 단어(올리는 중 · 대기열 · 대기 중 n번째 · 분석 중 · 끝 · 실패)와 모양(채운 네모 돌아감, 빈 네모 기다림, 노란 네모 끝, 세모 실패)으로 보여요. `running`은 `progress`로 막대와 `done/total 프레임`, `waiting`은 `waitPos`가 있으면 `대기 중 n번째`이고 없으면 `분석기가 GPU 차례를 기다려요`, `failed`는 남은 `error`, `queued`에 `attempts`가 있으면 왼 다시 줄을 섰는지와 몇 번째 시도인지를 같이 적어요. `worker.alive`가 거짓이면 목록 위에 `분석기가 꺼져 있어요`와 마지막 신호 시각. 목록은 최근 것부터이고 10개를 넘으면 5개만 보여요(접기 규칙). 끝난 갤러리 일감의 `결과 보기`는 그 영상의 분석 시트(`openAnalysis(id, 'g')`, `GET /api/analysis/gallery/:id`)를, 랠리 일감은 그 대회 경기의 시트를 열어요. 갤러리 시트는 공개 읽기라 이름만 받으므로, 두 선수 이름이 같으면 `홍길동 (카메라 쪽)`과 `홍길동 (건너편)`으로 구분해요(공개 갤러리 읽기에 `label`을 붙이는 것은 서버 후속). 지우기는 앱의 확인 대화 상자를 거쳐요.
- 샷 먼저: 갤러리 일감에 `note.handPending`이 있으면(대기열·대기 중·분석 중) 상태 줄 위에 `샷 결과 나옴 · 포·백 분석 중`을 적고 `결과 보기`를 바로 보여요. 분석 화면은 `handPending` 파일이면 머리 아래에 `포·백 분석 중` 안내와 기술 카드 제목의 `· 포·백 분석 중`을 보이고, 열려 있는 동안 10초마다 다시 읽어 채워지면 안내가 사라져요.
- 영상 올리기: `video/*` 여러 개를 골라요. 파일마다 가까운 쪽 선수와 건너편 선수(등록된 선수 드롭다운에서 고르거나 `이름,네자리`로 적음, 비우면 `null`), 친 날짜(기본 오늘, KST), 제목(기본 파일 이름)을 적어요. 형식이 틀리면 그 칸 아래에 까닭을 적고 아무것도 보내지 않아요. `영상 n개 올리기`는 파일마다 `POST /api/desk/jobs` → (모서리가 있으면) `POST .../corners` → 4 MiB 조각을 `PUT .../video?offset=` 으로 차례로 보내요. 답의 `received`로 다음 offset을 정하고, 409가 오면 그 답의 `received`에서 이어요. 올리는 동안 화면을 다시 그려도 파일 손잡이는 모듈 상태에 남아 이어져요. 페이지를 닫았다 다시 열면 그 일감은 `uploading`으로 남고, 줄에 `같은 파일 고르기`가 나와요: 이름과 크기가 같은 파일만 받고 `GET /api/desk/jobs/:id`의 `video.received`부터 이어 올려요. 다른 파일은 그 줄에 까닭을 적고 아무것도 보내지 않아요. 진행률은 파일마다의 막대와 `올리는 중 n개 · 남은 영상 n개` 한 줄이에요.
- 모서리: 고른 파일의 첫 장면(0.5초 지점, 최대 960 px 폭)을 브라우저가 읽어 캔버스에 그리고, 카메라 화면의 코트 보정과 같은 순서(내 쪽 끝선 왼쪽 → 내 쪽 끝선 오른쪽 → 건너편 끝선 오른쪽 → 건너편 끝선 왼쪽)로 네 번 눌러요. 번호 표시와 선이 그려지고 `모서리 취소`·`다시 찍기`가 있어요. 좌표는 영상 픽셀 단위로 보내요. 브라우저가 못 읽는 영상은 그렇다고 적고 모서리 없이 올려요(분석기가 탁구대를 찾아요).
- 촬영 안내: 우리말 다섯 줄(삼각대 고정, 네 모서리가 다 보이게, 탁구대 높이 이상에서 끝선 뒤나 옆, 고른 조명, 빈 배경).
- 들록된 선수 드롭다운(`people-pick.js`): `GET /api/players`(x-pin, feat/player-code가 들어오면 응답, 없으면 404를 무시) + 데스크 대기열에 적힌 `이름,네자리` + `GET /api/analysis/people`의 이름(네자리 모름: 고르면 `이름,`까지 채우고 네자리를 이어 적게 함). 앞 글자와 초성으로 거르고(`ㅊㅂ` → 홍길동), 터치·키보드(위·아래·Enter·Esc)로 골라요. 목록은 필드 바로 아래 DOM에 직접 그려요(앱의 render는 필드에 포커스가 있는 동안 기다리므로).
- 화면 시험: `bun scripts/seed-analysis.js --out=<빈 폴더>`가 갤러리 영상 8개(끝), 랠리 일감 1개(끝), 실패 1개, 대기열 3개, 올리다 만 일감 1개(8 MiB 중 3 MiB)와 두 사람의 자세 파일을 써요. `waiting`과 `running`은 서버가 켜질 때 `queued`로 돌아가므로 시드에 없고, QA 스크립트의 가짜 분석기가 claim과 progress로 만들어요
