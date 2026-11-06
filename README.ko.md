<div align="center">

[English](README.md) · **한국어**

<h1>
  <img src="docs/img/title.png" alt="PingPong Vision (핑퐁 비전)" width="540">
  <img src="docs/img/mascot-256.png" alt="보라 머리띠를 하고 빨간 탁구 라켓으로 하얀 공을 치는 도트 펭귄 마스코트" width="160">
</h1>

<img src="docs/img/hero.gif" alt="가로로 둔 폰에서 돌아가는 화면: 공개 OpenTTGames 경기 위에 랠리 시간, 샷 수, 속도 추정, LOCK 붙은 공 궤적, 선수 뼈대, 코트 지도" width="720">

<sub>이 움직이는 그림과 화면 캡처: <a href="https://lab.osai.ai/">OpenTTGames 데이터셋</a>(OSAI)의 <code>test_2</code> 프레임을 자르고 줄인 뒤 앱 오버레이를 그린 것입니다. 이 이미지들은 코드의 MIT가 아니라 <a href="https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ko">CC BY-NC-SA 4.0</a>을 따릅니다.</sub>

**무료·오픈소스 탁구 영상 분석. 폰 카메라 한 대로 브라우저에서 돌고, 서버는 내 PC에 직접 띄웁니다.**

[![License: MIT](https://img.shields.io/github/license/orientpine/pingpong-vision?color=blue)](LICENSE)
[![Release](https://img.shields.io/github/v/release/orientpine/pingpong-vision?sort=semver)](https://github.com/orientpine/pingpong-vision/releases)
[![Runtime: bun](https://img.shields.io/badge/runtime-bun%20%E2%89%A5%201.1-f9f1e1?logo=bun&logoColor=white)](https://bun.sh)
[![Platform: iPhone Safari · Android Chrome](https://img.shields.io/badge/platform-iPhone%20Safari%20%C2%B7%20Android%20Chrome-0b1634)](#pc-설치-tailscale)
[![Price: free](https://img.shields.io/badge/price-free-ff8a1f)](LICENSE)

</div>

PingPong Vision은 **아이폰 Safari**와 모바일 브라우저에서 도는 **탁구 영상 분석 웹앱**(PWA)입니다. 탁구대 옆 삼각대에 폰을 세우면 화면 위에 바로 이런 것을 보여 줍니다.

- **자세 추정**: 두 선수의 뼈대(MediaPipe Pose Landmarker)
- **공 추적**: 색과 움직임으로 찾고, 머신러닝은 쓰지 않습니다
- **랠리 시간**, **샷 수**, **샷 속도 추정**(km/h)
- **바운드 지도**와 선수가 **서 있는 위치**

분석은 모두 폰 안에서 합니다. 랠리 영상을 내 PC에 저장하는 기능을 직접 켜지 않는 한 카메라 영상은 폰 밖으로 나가지 않습니다. 작은 서버를 내 컴퓨터에 [bun](https://bun.sh)으로 띄우고, 폰에서는 [Tailscale](https://tailscale.com)로 HTTPS 주소를 엽니다. 가입, 구독, 저희 클라우드는 없습니다.

## 목차

- [1.1에서 달라진 점](#11에서-달라진-점)
- [기능](#기능)
- [화면](#화면)
- [빠른 시작(내 컴퓨터에서 해 보기)](#빠른-시작내-컴퓨터에서-해-보기)
- [PC 설치 (Tailscale)](#pc-설치-tailscale)
- [대회와 PIN](#대회와-pin)
- [탁구장에서 쓰는 법](#탁구장에서-쓰는-법)
- [정확도와 한계](#정확도와-한계)
- [선택 기능](#선택-기능)
- [다른 종목으로 바꾸기](#다른-종목으로-바꾸기)
- [기여](#기여)
- [릴리스](#릴리스)
- [라이선스와 제3자 고지](#라이선스와-제3자-고지)

## 1.1에서 달라진 점

**이제 PingPong Vision으로 대회 하나를 통째로 돌립니다.** PC 한 대, 주소 하나로 심판은 폰으로 점수를 넣고, 삼각대 폰은 포인트를 판정하고, TV는 점수판이 됩니다. 아래는 모두 1.1.35까지 공개 저장소에 들어간 기능이고, 화면은 공개 시험 영상 위에서 도는 실제 앱입니다. 선수 이름은 지어낸 것입니다.

| | |
|---|---|
| <img src="docs/img/feature-tv.webp" alt="1920x1080 TV 점수판: 블루 끝 선수2와 레드 끝 선수1의 큰 점수 숫자, 게임 수, 오버레이가 그려진 방금 포인트 영상, 랠리 다시 보기 목록" width="440"> | **대회 진행.** 2~8명 더블·트리플·리그 대진. 심판 폰, 관전 화면, TV 큰 점수판이 같이 움직이고 점수는 PIN으로 지킵니다([대회와 PIN](#대회와-pin)). |
| <img src="docs/img/feature-call.webp" alt="가로 카메라 폰: 누가 땄나요 막대에 카메라는 블루라고 적혀 있고 블루 득점 버튼이 미리 골라져 있으며 옆에 레드 득점 버튼, 탁구대 위에 뼈대·이름표·끝선" width="440"> | **카메라가 포인트를 판정.** 바운드로 포인트를 판정합니다. 판정은 *누가 땄나요* 막대에 그쪽이 미리 골라진 채 기다리고, 카메라나 심판 화면에서 한 번 누르면 들어가며 3초 안에 취소할 수 있습니다. 확실하지 않은 판정은 글로만 보여 주고 사람에게 맡깁니다. |
| | **폰 두 대를 하나로.** PIN을 넣은 두 번째 폰이 붙으면 저절로 합쳐집니다. 두 폰의 바운드를 합쳐 한쪽이 공을 놓친 순간을 다른 쪽이 채우고, 포인트는 한 번만 들어갑니다. 각 폰의 끝 색(블루·레드)은 모서리를 찍은 뒤 사람이 고르므로 두 폰이 어긋나지 않습니다. |
| <img src="docs/img/feature-replay.webp" alt="가로 폰의 전체 화면 다시 보기: 랠리 시간, 백핸드 서브 표시, 공 궤적과 LOCK, 두 선수 뼈대, 선수 패널, 닫기·처음부터·오버레이 끄기 버튼" width="440"> | **오버레이 다시 보기.** 포인트마다 영상을 원본 그대로 내 PC에 저장하고, 랠리 앞 3초를 함께 담습니다. 다시 보기는 서브 1초 전부터 폰 전체 화면으로 재생되고, 이름표·뼈대·공 궤적은 볼 때 그리며 한 번 눌러 접을 수 있습니다. |
| <img src="docs/img/feature-sheet.webp" alt="폰의 경기 분석 시트: 선수마다 한 줄 리포트와 기술 성공률 표, 포핸드 공격에 추정 표시" width="300"> | **경기 분석 시트.** 경기 뒤 한 줄 리포트, 기술 성공률, 랠리 길이, 서브·리시브 득점, 샷이 떨어진 자리를 봅니다. 포핸드·백핸드와 기술 종류는 **추정**입니다([정확도와 한계](#정확도와-한계)). |
| <img src="docs/img/feature-judge.webp" alt="판정 비교 화면: 카메라 판정 수, 심판과 같았던 수, 놓친 판정과 가짜 판정, 경기별 표" width="300"> | **카메라 판정과 심판 입력 비교.** 카메라의 판정을 심판이 넣은 것 옆에 모두 남깁니다. 얼마나 같았는지, 약한 판정에서 심판이 어느 쪽을 골랐는지, 놓치거나 취소된 판정을 경기별로, CSV로도 봅니다. 숫자만 남기고 이름과 사진은 남기지 않습니다. |
| <img src="docs/img/feature-players.webp" alt="폰의 새 대회 만들기: 1번 시드 칸에 홍을 치자 등록된 선수 목록에 홍길동 0712가 뜨고, 이름,네자리 안내 문구" width="300"> | **선수 이름+네 자리.** 선수를 `이름,1234`로 한 번 넣습니다(예: `홍길동,0712`). 네 자리는 같은 이름을 구분하는 용도일 뿐 관전 화면에는 보이지 않고, 대회가 바뀌어도 그 선수의 경기가 이어집니다. |
| <img src="docs/img/feature-calib.webp" alt="정밀하게를 누른 뒤의 보정 화면: 탁구대 테두리에 맞은 노란 윤곽, 흐린 점선으로 남은 처음 탭, 테두리에 맞췄어요 · 최대 8px 옮김 문구, 되돌리기·다시 하기·색 바꾸기·확인 버튼" width="440"> | **정밀 보정과 자리 안내.** 네 모서리를 대충 누르고 **정밀하게**를 누르면 탁구대 흰 테두리에 맞춰 줍니다. 처음 누른 자리는 흐리게 남아 비교할 수 있습니다(**되돌리기**, **다시 하기**). 설정에서 켜는 자리 안내는 확인 전에 위치·높이·구도·수평·흔들림을 차례로 봐 줍니다. |

리눅스, 맥, 윈도우에서 `bun run.mjs` 하나로 두 앱이 주소 하나에 뜨고, `bun update.mjs`로 업데이트하며, 새 버전이 나오면 설정에 한 줄 뜹니다. 모든 화면은 **한국어** 또는 **English**입니다. 무료, MIT, 계정 없음.

<sub>카메라·다시 보기·보정 그림과 TV의 영상 칸은 OpenTTGames 데이터셋(OSAI, <code>test_2</code>) 프레임에 앱 오버레이를 그린 것으로 CC BY-NC-SA 4.0을 따르며 MIT가 아닙니다. 점수판·시트·비교·입력 화면에는 데이터셋 프레임이 없습니다. 선수 이름은 지어낸 것입니다.</sub>

## 기능

| | 내용 |
|---|---|
| 🏓 **실시간 오버레이** | 랠리 시간, 샷 수, 속도 추정, 샷 종류(드라이브·스매시·로빙·푸시, 포핸드·백핸드는 규칙으로 판단), 공 궤적과 믿을 만할 때 뜨는 **LOCK** 상자 |
| 🧍 **선수** | 양쪽 끝 선수의 뼈대, 이동 거리(MOVE), 손목 각도, 탁구대 뒤·옆 어디에 서 있는지 |
| 🗺️ **코트 지도** | 바운드와 선 자리를 위에서 본 탁구대에 표시 |
| 📐 **한 번만 하는 보정** | 탁구대 네 모서리를 대충 누르고 정밀하게를 누르면 흰 테두리에 맞춰 주고, 윤곽을 보고 확인 |
| 🌐 **한국어·English** | 처음 화면(모드 고르기)이나 **설정**에서 **한국어** 또는 **English**를 고릅니다. 모든 화면, 영상 위 오버레이, 점수 음성, 오류 문구가 따라 바뀌고 폰이 기억합니다. 선수 이름은 적은 그대로 |
| 📱 **폰 중심** | 세로·가로 모두 화면을 꽉 채우고 패널은 위에 뜹니다. 태블릿이나 TV(AirPlay 미러링)에서는 큰 화면 배치 |
| 🎞️ **랠리 기록과 다시 보기** | 랠리마다 시간, 샷 수, 최고 속도, 바운드 지도. 영상은 *내* PC에 추측할 수 없는 공유 링크로 저장(선택) |
| 🛟 **판정 안정 모드** | 폰이 버거우면(같은 프레임 반복, 초당 12장 미만) 분석이 따라가도록 화면을 줄였다가 돌아옵니다 |
| 🔒 **개인정보** | 폰 안에서 분석, 서버는 `127.0.0.1`에만 열림, 켜지 않으면 아무것도 올리지 않음 |
| 🏆 **대회** | 2~8명 더블·트리플·리그 대진, 심판·카메라·관전·TV 화면을 한 주소에서, 점수는 PIN으로 보호([대회와 PIN](#대회와-pin)) |
| 🧪 **잴 수 있음** | 공개 [OpenTTGames](https://lab.osai.ai/) 정답으로 공·바운드·샷 검출을 채점하는 오프라인 도구 |

## 화면

아래는 모두 실제 앱이 공개 데이터셋 OpenTTGames 영상으로 계산한 화면입니다. 꾸민 화면이 아닙니다.

| 세로 폰 | 보정(네 번 누르면 테두리에 맞춤) | 랠리 기록 |
|---|---|---|
| <img src="docs/img/portrait-running.png" alt="세로 폰: 공에 LOCK 약 32 km/h, 포핸드 드라이브 표시, 선수 패널과 코트 지도" width="260"> | <img src="docs/img/calibrate.png" alt="가로 보정: 탁구대 테두리의 번호 붙은 네 모서리, 모서리 취소·다시·확인 버튼" width="420"> | <img src="docs/img/history.png" alt="랠리 기록: 랠리 1개, 2.2초, 샷 3, 최고 약 53 km/h, 바운드 지도" width="260"> |

<img src="docs/img/tv-running.png" alt="1920x1080 큰 화면 배치: 선수 패널, 코트 지도, 서브 토스 공에 LOCK" width="720">

*영상 프레임 출처: OSAI의 OpenTTGames 데이터셋(https://lab.osai.ai/), CC BY-NC-SA 4.0. 바꾼 점: 자르고 줄인 뒤 앱 오버레이를 그림. `docs/img/`의 이미지는 MIT가 아니라 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ko)을 따릅니다. 데이터셋 자체는 이 저장소에 들어 있지 않습니다.*

## 빠른 시작(내 컴퓨터에서 해 보기)

[bun](https://bun.sh) 1.1 이상, `git`, `curl`, `unzip`이 필요합니다.

```bash
git clone https://github.com/orientpine/pingpong-vision && cd pingpong-vision
bash install.sh && bun run.mjs     # 윈도우: install.ps1, 3단계 참고
```

대회 앱은 **http://localhost:8780/**, 카메라는 **http://localhost:8780/vision/** 을 엽니다(끝의 `/`까지). 컴퓨터 브라우저는 `localhost`를 안전한 주소로 보므로 카메라도 됩니다. 카메라가 없으면 **영상 파일로 시험**을 누르고 탁구 영상을 고르세요.

`install.sh`는 필요한 도구를 확인하고, `bun install`, 자세 모델 받기(sha256 확인, `public/models/`), 설정 파일 만들기, 시험 실행(`/healthz` 200 확인)을 합니다. 여러 번 돌려도 됩니다. 단위 시험은 `bun test`.

## PC 설치 (Tailscale)

관리자가 동호회에서 쓰는 방식 그대로입니다. 서버는 집이나 탁구장 PC에서 돌고, 폰은 HTTPS로 엽니다. 폰은 HTTPS에서만 카메라를 허락하는데, Tailscale이 내 PC에 진짜 인증서가 붙은 HTTPS 주소를 무료로, 공유기 포트를 열지 않고 만들어 줍니다.

```text
 폰(Safari/Chrome) ──HTTPS──▶ Tailscale ──▶ 내 PC: tailscale serve ──▶ bun server.js (비전 127.0.0.1:8791, 대회 127.0.0.1:8792)
```

**준비물**

- 켜 둘 PC 한 대: 리눅스, 맥, 또는 윈도우 10/11
- 폰: 아이폰 Safari(관리자는 iOS 18에서 씀) 또는 안드로이드 Chrome
- 무료 Tailscale 계정(구글, 마이크로소프트, 깃허브, 애플 계정으로 로그인)
- 삼각대나 폰 거치대(높이 1.5~2 m)

### 1. PC와 폰에 Tailscale

1. PC에 Tailscale 설치: https://tailscale.com/download (리눅스는 `curl -fsSL https://tailscale.com/install.sh | sh` 다음 `sudo tailscale up`)
2. 폰에 Tailscale 앱(App Store, Google Play)을 깔고 **같은 계정**으로 로그인
3. [관리 화면 → DNS](https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다. 처음 `tailscale serve`를 할 때도 물어봅니다.
4. 리눅스에서는 sudo 없이 `tailscale serve`를 쓰도록 한 번만:

   ```bash
   sudo tailscale set --operator=$USER
   ```

**맥과 윈도우:** 같은 다운로드 페이지에서 Tailscale 앱을 깔고 로그인합니다. `tailscale` 명령은 맥은 터미널, 윈도우는 PowerShell에서 됩니다.

### 2. bun 설치

```bash
curl -fsSL https://bun.sh/install | bash
```

**윈도우(PowerShell):** `powershell -c "irm bun.sh/install.ps1 | iex"`, git은 `winget install --id Git.Git -e`.

설치 뒤 터미널을 새로 열어야 `bun`이 잡힙니다(`bun --version`이 1.1 이상). 리눅스에서는 먼저 `sudo apt install -y git curl unzip`이 필요할 수 있습니다. 맥은 `xcode-select --install` 뒤에 git이 생깁니다.

### 3. 코드 받고 설치

```bash
git clone https://github.com/orientpine/pingpong-vision
cd pingpong-vision
bash install.sh
```

**윈도우**에서는 `bash install.sh` 대신 PowerShell에서:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

마지막 줄이 다음에 할 일을 알려 줍니다. 잘 되면 `/healthz 200`(리눅스, 맥) 또는 `/ and /vision/ answer 200`(윈도우)으로 끝납니다.

### 4. 설정 파일

`install.sh`가 [`deploy.env.example`](deploy.env.example)을 복사해 `~/.config/pingpong-vision/deploy.env`를 만듭니다.

```bash
PORT=8791                # PC 안 포트. 서버는 127.0.0.1에만 열립니다
FUNNEL_PORT=443          # Tailscale 주소의 HTTPS 포트(443이면 주소에 포트가 안 붙음)
PPV_TS_MODE=serve        # serve: 내 tailnet 기기만, funnel: 링크를 아는 누구나
TOURNAMENT_PORT=8792     # 대회 앱의 PC 안 포트
PPV_TOURNAMENT_URL=http://127.0.0.1:8792   # 카메라 앱이 찾을 대회 앱 주소. off면 카메라만 씀
```

`serve`로 두세요. 내 tailnet에 로그인한 기기만 열 수 있습니다. Tailscale 없는 폰도 들어오게 하려면 [인터넷에 공개하려면](#인터넷에-공개하려면-선택)을 보세요.

#### 인터넷에 공개하려면 (선택)

**위험: 주소를 아는 사람은 누구나 열 수 있습니다.** 점수를 볼 수 있고, 대회 앱이 있으면 4자리 PIN을 맞혀 보거나 내가 만들기 전에 첫 대회를 만들 수도 있습니다. 꼭 필요할 때만 켜세요.

1. Tailscale [관리 화면](https://login.tailscale.com/admin/acls)에서 이 PC의 Funnel을 허용합니다(처음 `tailscale funnel`을 부르면 링크가 찍힘).
2. `deploy.env`에 `PPV_TS_MODE=funnel`과 `FUNNEL_PORT`(443, 8443, 10000 중 하나)를 둡니다.
3. 리눅스 `start.sh`: `./start.sh --restart`를 실행합니다. 되돌리려면 `PPV_TS_MODE=serve`로 바꾸고 다시 실행합니다.
4. 맥, 윈도우(`bun run.mjs`): `serve` 줄 대신 `tailscale funnel --bg --https=443 http://127.0.0.1:8780`으로 공유합니다. 되돌리려면 `tailscale funnel --https=443 off` 뒤에 `serve` 줄을 다시 실행합니다.

### 5. 실행

**리눅스(systemd):** 명령 하나면 됩니다. 사용자 서비스를 만들어(멈추면 다시 켜지고, 부팅 때도 켜짐) `/healthz`를 기다린 뒤 `tailscale serve`(또는 funnel)까지 걸어 줍니다.

```bash
./start.sh
loginctl enable-linger $USER   # 로그아웃해도 계속 돌게(한 번만)
```

대회 앱도 같이 켜지고 `URL: https://<내 PC의 MagicDNS 이름>:443/`이 찍힙니다(전체 이름은 `tailscale serve status`에 나옴). `./start.sh --restart`는 지금 체크아웃을 배포하고 다시 켭니다. 카메라 서비스는 `~/.local/share/pingpong-vision/releases/`의 사본을 돌리므로, 체크아웃을 고쳐도 다시 켜기 전까지는 바뀌지 않습니다. 분석 데스크 워커가 켜져 있으면 새 릴리스로 함께 다시 켜요(직접 하려면 `systemctl --user restart pingpong-desk-worker`).

**맥, 윈도우, systemd 없는 리눅스:** 명령 하나로 두 앱이 한 주소(`127.0.0.1:8780`)에서 켜집니다. 창은 열어 두고, Ctrl+C로 끕니다. 그 주소를 Tailscale로 한 번만 공유합니다. `--bg` 설정은 재부팅해도 남습니다.

```bash
bun run.mjs                                              # 터미널 1(열어 둠)
tailscale serve --bg --https=443 http://127.0.0.1:8780   # 터미널 2, 한 번만
tailscale serve status                                   # https:// 주소 확인
```

윈도우에서는 같은 줄을 PowerShell에 입력합니다. `run.mjs`는 꺼진 앱을 다시 켜고, 폰마다 주소를 앱에 넘겨서 한 폰에서 PIN을 틀리면 그 폰만 잠깁니다.

### 6. 폰에서 열기

1. 폰의 Tailscale이 **연결됨**인지 확인합니다.
2. 5단계 주소 `https://<내 PC의 MagicDNS 이름>/`을 열고 역할을 고릅니다([대회와 PIN](#대회와-pin)). `/vision/`은 카메라를 바로 엽니다.
3. 처음 한 번 약 20 MB(자세 모델과 실행 파일)를 받습니다. 로딩 막대는 실제로 받은 양을 세고, 다음부터는 캐시를 씁니다.
4. 홈 화면에 추가하면 앱처럼 전체 화면으로 열립니다. **Safari**: 공유 → *홈 화면에 추가*. **Chrome**: ⋮ → *홈 화면에 추가* 또는 *앱 설치*.
5. **카메라 시작**을 누르고 카메라를 허용합니다.

### 7. 자동 시작(맥, 윈도우)

리눅스는 `start.sh`가 해 줍니다.

**맥:** LaunchAgent가 `bun run.mjs`를 켜 두고 로그인할 때 켭니다. 아래를 `~/Library/LaunchAgents/local.pingpong-vision.plist`로 저장하세요(두 경로의 `YOU`를 내 이름으로).

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>local.pingpong-vision</string>
  <key>ProgramArguments</key><array><string>/Users/YOU/.bun/bin/bun</string><string>/Users/YOU/pingpong-vision/run.mjs</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load -w ~/Library/LaunchAgents/local.pingpong-vision.plist
```

**윈도우:** 설치 프로그램을 `-AutoStart`를 붙여 한 번 더 실행합니다. 작업 스케줄러에 *PingPong Vision* 작업을 만들어 로그인할 때 `bun run.mjs`를 켭니다.

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -AutoStart
```

지우려면 `Unregister-ScheduledTask 'PingPong Vision'`.

### 8. 업데이트

명령 하나로 올립니다. 리눅스, 맥, 윈도우 모두 같습니다:

```bash
cd pingpong-vision && bun update.mjs
```

한 단계씩 하면서 무엇을 하는지 알려 줍니다:

1. **이 복사본을 확인합니다.** 폴더 안 파일을 고쳤거나 직접 만든 커밋이 있으면 아무것도 바꾸지 않고 멈춥니다(고친 파일을 보여 줍니다).
2. **백업합니다.** 설정 폴더(`~/.config/pingpong-vision`), 대회 기록, 랠리 저장을 `~/pingpong-vision-backups/<날짜>_<시각>/`에 복사합니다.
3. **새 버전을 받고**(`git pull`) `install.sh`(윈도우는 `install.ps1`)를 다시 돌립니다.
4. **앱을 다시 켭니다.** 리눅스 서비스(`start.sh --restart`)나 7단계의 맥 LaunchAgent로 켭니다. 직접 띄웠다면 직접 껐다 켤 때까지 기다립니다.
5. **확인합니다.** `/healthz`가 답하고 새 버전이 도는지 봅니다.

백업 뒤의 단계가 실패하면 원래 버전으로 되돌리는 줄을 보여 줍니다. 이름을 끝까지 쳐 주세요. `.mjs` 없는 `bun update`는 bun의 패키지 업데이트 명령입니다.

아직 `update.mjs`가 없는 v1.0.x에서는 한 번만 `git pull && bash install.sh` 후 예전처럼 다시 켭니다. 그다음부터는 `bun update.mjs`입니다.

**새 버전 알림.** 공개 저장소에 더 새 릴리스가 있으면 설정(카메라 화면과 대회 화면)에 *새 버전 있음 · vX.Y.Z* 한 줄이 뜨고, 누르면 릴리스 노트가 열립니다. 이를 위해 앱은 하루 한 번 이하로 GitHub 공개 API에 최신 릴리스만 묻고, 다른 정보는 보내지 않습니다. GitHub에 닿지 않으면 아무것도 띄우지 않습니다. 끄려면 `deploy.env`에 `PPV_UPDATE_CHECK=off`를 넣고 다시 켭니다.

바뀐 점은 [릴리스](https://github.com/orientpine/pingpong-vision/releases)에서 봅니다.

### 9. 문제 해결

| 증상 | 해결 |
|---|---|
| 카메라 버튼이 안 되거나 권한 거부 | 주소가 `https://`(또는 `localhost`)여야 합니다. 아이폰: 설정 → Safari → 카메라 → *묻기* 또는 *허용* 후 새로고침. 카메라를 쓰는 다른 앱을 닫으세요. |
| `http://<PC 내부 IP>:8791`이 안 열림 | 일부러 그렇습니다. 서버는 `127.0.0.1`에만 열립니다. Tailscale `https://` 주소를 쓰세요. |
| 폰에서 Tailscale `https://` 주소가 안 열림 | 폰 Tailscale이 같은 계정으로 연결돼 있어야 합니다. PC에서 `tailscale serve status`로 확인하고, 관리 화면에서 HTTPS Certificates가 켜졌는지 보세요. 첫 인증서는 1분쯤 걸릴 수 있습니다. |
| `tailscale serve`가 *access denied* | `sudo tailscale set --operator=$USER`를 한 번 하거나 앞에 `sudo`를 붙입니다. |
| Funnel이 안 켜져 있다고 함 | tailnet 정책을 바꿔야 합니다. 찍힌 링크를 따라가거나 `PPV_TS_MODE=serve`를 쓰세요. |
| 방화벽 | 열 것이 없습니다. Tailscale이 직접 연결을 만들고, 앱은 들어오는 포트가 필요 없습니다. |
| `install.sh`나 `start.sh`가 8791 포트가 쓰인다고 함 | 리눅스 `ss -ltnp \| grep 8791`, 맥 `lsof -i :8791`로 누가 쓰는지 봅니다. `deploy.env`의 `PORT`를 바꾸고 `bash install.sh`를 다시 돌린 뒤, `tailscale serve` 명령에도 새 포트를 씁니다. |
| `start.sh`가 *set PPV_TOURNAMENT_URL*, *set FUNNEL_PORT*, *set PPV_TS_MODE*로 멈춤 | `deploy.env`에 그 줄이 없습니다. `deploy.env.example`에서 복사하세요. |
| 로딩 막대가 멈춤 | 이유와 **다시 받기**가 뜹니다. 모델은 내 PC가 보내 주므로(`install.sh`에서 받아 둠) PC가 켜져 있는지 확인하세요. |
| `bun: command not found` | bun 설치 뒤 터미널을 새로 열거나 `~/.bun/bin/bun`으로 실행합니다. |
| 심판 화면에 카메라 PIN 대기가 뜸 | 카메라 폰에서 PIN을 넣으세요. 카메라와 점수판은 같은 주소로 열어야 합니다. |
| 서비스 로그(리눅스) | `journalctl --user -u pingpong-vision -n 50`, 대회 앱은 `-u pingpong-scoreboard` |

## 대회와 PIN

`tournament/`가 점수판입니다. 카메라 앱과 한 주소에서 돕니다. `https://<내 PC>/`가 입구이고 `/vision/`이 카메라입니다.

### 역할

기기마다 첫 화면에서 역할을 고릅니다. 나중에는 위쪽 모드 버튼으로 바꿉니다.

| 역할 | 누가 | PIN | 하는 일 |
|---|---|---|---|
| **심판** | 점수 보는 사람 | 필요 | 점수 넣기, 취소, 고치기. 심판 모드에서는 화면 왼쪽·오른쪽 절반을 누르면 1점, 길게 누르면 취소 |
| **카메라** | 삼각대의 폰 | 필요 | 탁구대를 찍어 점수를 저절로 넣음(위에서 설명한 그 앱) |
| **관전** | 누구나 | 필요 없음 | 실시간 점수, 다시 보기, 소리. 여기서는 아무것도 못 바꿈 |
| **TV** | 큰 화면, 태블릿 | 필요 없음 | **관전**을 고르면 큰 화면에서는 큰 점수판으로 나옴 |

### 대회 만들기

1. `https://<내 PC>/`를 열고 **심판**을 고른 뒤 **새 대회 만들기**로 갑니다.
2. 대회 이름과 선수 2~8명을 넣습니다. 선수는 `이름,네자리`로 넣습니다(예: `홍길동,0712`). 네 자리는 같은 이름을 구분하는 데만 쓰고 관전 화면에는 보이지 않으며, 한 번 넣은 선수는 다음 대회에서 이름 첫 글자만 쳐도 목록에 뜹니다. 시드 순서를 맞추거나 무작위 추첨을 씁니다.
3. 방식을 고릅니다. **더블**(2패 탈락), **트리플**(3패 탈락), **리그전**(모두 한 번씩). 경기 길이도 고릅니다.
4. **대회 만들기**를 누릅니다. 경기가 끝나면 대진은 저절로 채워집니다. 새 대회를 만들면 이전 대회는 **기록** 탭으로 옮겨집니다.

### PIN

PIN은 4자리 숫자입니다. 심판과 카메라가 점수를 쓸 때 필요하고, 보기만 할 때는 필요 없습니다. 첫 대회를 만들기 전에는 PIN이 없어서, 주소를 열 수 있는 사람은 누구나 첫 대회를 만들 수 있습니다. `PPV_TS_MODE=serve`(기본값)로 두거나 설치 후 바로 만드세요.

**처음 설치할 때: 주는 PIN을 쓰거나 직접 정하기**

- 아무것도 안 하면 **새 대회마다 무작위 PIN**이 나옵니다. **대회 만들기** 직후 화면에 한 번 뜨고, 그 기기에 기억됩니다. 그 기기의 **설정**에서 다시 볼 수 있습니다.
- **직접 정하려면** 파일에 적고 다시 켭니다. 그 뒤로 모든 대회가 이 PIN을 씁니다. `4827` 자리에 원하는 4자리를 넣으세요(따옴표는 그대로).

  ```bash
  cd pingpong-vision
  mkdir -p tournament/data
  echo '{"pin": "4827"}' > tournament/data/settings.json
  ./start.sh --restart     # 맥, 윈도우: bun run.mjs 창에서 Ctrl+C, 다시 bun run.mjs
  ```

**대회를 새로 만들 때**

- `settings.json`이 있으면 PIN은 그대로입니다.
- 없으면 대회를 바꿀 때 지금 PIN이 필요하고, 새 대회는 새 무작위 PIN을 받습니다. 심판에게 알리고 카메라에도 다시 넣으세요.

**PIN 바꾸기**

`tournament/data/settings.json`을 고치고 위처럼 다시 켭니다. 진행 중인 대회도 새 PIN으로 바뀌고 점수는 그대로입니다. 옛 PIN을 가진 기기는 다음에 점수를 쓸 때 새 PIN을 묻습니다. 파일을 지우고 다시 켜면 다음 새 대회부터 무작위 PIN으로 돌아갑니다.

**잊었을 때**

PC의 `pingpong-vision` 폴더에서:

```bash
grep '"pin"' tournament/data/tournament.json
```

처음 나오는 값이 지금 PIN입니다. 이 파일은 내 PC에만 있고 `tournament/data/`는 커밋되지 않습니다.

**너무 많이 틀렸을 때.** 5번 틀리면 그 기기가 1분 잠깁니다. 모든 기기를 합쳐 1분에 20번 틀리면 최근에 PIN을 맞힌 적 없는 기기는 잠시 막힙니다. 점수를 넣고 있던 폰은 그대로 됩니다. 앱을 다시 켜면 잠금이 풀립니다.

**안전하게.** 4자리는 추측을 늦출 뿐이라 `serve`가 더 안전합니다. `tournament/data/`에는 선수 이름, 점수, PIN이 있으니 절대 커밋하지 마세요.

### 카메라 잇기

`PPV_TOURNAMENT_URL`은 카메라 앱에 점수판 위치를 알려 줍니다. PC 저장용 PIN을 확인할 때 씁니다. `install.sh`가 `deploy.env`에 넣어 줍니다.

```bash
TOURNAMENT_PORT=8792
PPV_TOURNAMENT_URL=http://127.0.0.1:8792   # 위와 같은 포트. off면 카메라만 씀
```

`PPV_TOURNAMENT_DATA`는 PIN이 든 파일입니다. `start.sh`가 `tournament/data/tournament.json`으로 맞춰 줍니다. `DATA_DIR`로 데이터를 옮겼을 때만 직접 정합니다.

그다음 삼각대 폰에서:

1. `https://<내 PC>/`를 열고 **카메라**를 고른 뒤 PIN을 한 번 넣습니다.
2. 탁구대 네 모서리를 누릅니다([탁구장에서 쓰는 법](#탁구장에서-쓰는-법)).
3. 심판 화면에 **카메라 연결됨**이 뜹니다. 이제 점수가 저절로 들어가고, 카메라에 3초 취소 막대가 뜹니다.

카메라와 점수판은 같은 주소여야 합니다. 다른 호스트나 포트로 열면 이어지지 않습니다.

## 탁구장에서 쓰는 법

1. **폰 놓기**: 네트 연장선 위, 탁구대 옆면에서 2~3 m, 높이 1.5~2 m에서 살짝 내려다보게 삼각대에 세워 탁구대 전체와 두 선수가 다 들어오게 합니다. 수평을 맞추세요. 카메라가 탁구대 높이에 있으면 탁구대 윗면이 선처럼 보여 바운드와 속도를 계산할 수 없습니다. 자세한 위치: [docs/system-design.md](docs/system-design.md).
2. 앱은 한국어로 열립니다. 영어로 쓰려면 모드 고르기나 **설정**에서 **English**를 누르세요. **카메라 시작**을 누릅니다. 녹화한 영상으로 해 보려면 **영상 파일로 시험**.
3. **코트 보정**을 한 번 합니다. 화면 안내 순서대로 네 모서리를 누릅니다: ① 내 쪽 왼쪽, ② 내 쪽 오른쪽, ③ 건너편 오른쪽, ④ 건너편 왼쪽. 대충 눌러도 **정밀하게**를 누르면 약 1초 동안 흰 테두리에 맞추고 누른 점을 흐리게 같이 보여 줍니다(**되돌리기**·**다시 하기**). 점을 끌어 고친 뒤 **확인**. 삼각대가 그대로면 보정도 그대로입니다. 보정 전이거나 네 점 안이 탁구대 윗면처럼 보이지 않으면 공을 찾지 않고, 폰이 흔들리는 동안에도 쉽니다.
4. 두 끝은 **레드 사이드 / 블루 사이드**입니다. 선수가 엔드를 바꾸면 **자리 교체**. 왼손잡이는 **설정**에서 라켓 손을 바꾸면 포핸드·백핸드 판정에 씁니다.
   필요할 때 설정의 **카메라 자리 안내**(기본 꺼짐)를 켜면 자리·각도·크기·수평·흔들림 확인에서 정밀하게로 이어지며, 센서가 없어도 권장 배치를 읽고 각 단계를 건너뛸 수 있습니다.
5. 경기합니다. 끝나면 **정지**, **기록**에서 랠리마다 시간, 샷 수, 최고 속도, 바운드 지도를 봅니다.
6. 아이패드 가로나 TV 미러링이면 큰 화면 배치가 됩니다. 설정에서 직접 고를 수도 있습니다.

## 정확도와 한계

이번 릴리스 코드로 OpenTTGames `test_2`(1080p, 120 fps 원본, 30초)를 리눅스 PC에서 60 fps로 처리해 아래 명령으로 잰 값입니다. **아이폰에서 잰 값이 아닙니다.**

| 지표(`test_2`) | 결과 |
|---|---|
| 공 재현율 / 정밀도(20 px 안, 정답이 있는 프레임, n = 387) | 86.6% / 96.5% |
| 바운드 F1(정답 바운드 28개) | 83.3%(정답에서 빠진 바운드를 맞은 것으로 치면 정밀도 96.9%) |
| 바운드 사이 샷 수가 맞은 구간 | 15 / 16 |

재현: https://lab.osai.ai/datasets/openttgames/data/ 에서 `test_2.mp4`와 `test_2.zip`을 `data/videos/`(git에서 제외됨)에 받고, 정답을 `data/videos/test_2/`에 푼 뒤:

```bash
bun qa/ball-offline.mjs --video=data/videos/test_2.mp4 \
  --corners='[{"x":355,"y":634},{"x":557,"y":519},{"x":1339,"y":535},{"x":1486,"y":659}]' \
  --out=/tmp/test_2.offline.json
bun qa/score.mjs /tmp/test_2.offline.json data/videos/test_2 /tmp/test_2.score.json
```

**한계**(숫자를 믿기 전에 꼭 읽어 주세요)

- **속도와 거리는 카메라 한 대로 낸 추정치입니다.** 공 높이를 모르므로 위치를 탁구대 가운데 선에 투영하고 탁구대 길이(2.74 m)로 환산합니다. 옆에서 찍을 때 가장 잘 맞습니다.
- **공 검출은 색과 움직임 기반**이고 흰 공에 맞췄습니다(주황은 실험). 흰 옷, 흰 벽, 어두운 체육관에서는 놓치거나 잘못 잡습니다.
- **프레임 수.** Safari는 60 fps를 요청하지만 어두우면 30 fps로 떨어지고, 빠른 공은 바운드를 건너뛸 수 있습니다. 보정할 때 어둡다고 알려 줍니다.
- **샷 종류는 규칙**입니다(모델 아님). 포핸드·백핸드는 손목이 몸 어느 쪽에 있는지, 드라이브·스매시·로빙·푸시는 속도와 궤적으로 정합니다. 회전은 모릅니다.
- **선수는 양 끝에 한 명씩 두 명만.** 복식이나 지나가는 사람은 처리하지 않습니다.
- **폰마다 속도가 다릅니다.** `/vision/bench.html`이 내 폰의 자세 추정 속도를 잽니다. 두 선수가 나온 1280x720 정지 화면 `public/bench/frame.jpg`가 필요합니다(포함 안 됨). 예: `ffmpeg -ss 0.9 -i data/videos/test_2.mp4 -frames:v 1 -vf scale=1280:720 -q:v 3 public/bench/frame.jpg`

## 선택 기능

- **내 PC에 랠리 저장.** 끝난 랠리의 기록과 영상을 내 PC의 `save-server.js`로 보냅니다(폴더 권한 `0700`, 크기·개수 상한). 랠리마다 길고 추측할 수 없는 공유 링크와 지우기 버튼이 생깁니다. 업로드 열쇠는 1회용 설정 링크로 폰에 넘깁니다. 자세한 것은 [docs/save-to-pc.md](docs/save-to-pc.md). `~/.config/pingpong-vision/`의 열쇠는 절대 커밋하지 마세요.
- **점수판 연동.** `public/js/point.js`가 바운드 순서(두 번 바운드, 아웃, 놓침)로 포인트 승패를 판정하고, `public/js/tournament.js`가 같은 주소 `/`의 점수판 앱에 넣습니다. 3초 취소, 고른 언어(한국어·영어)의 점수 음성, 렛?/폴트? 한 번 눌러 확정이 있습니다. 점수판은 `tournament/`에 있고([대회와 PIN](#대회와-pin)), API는 [docs/tournament-link.md](docs/tournament-link.md)에 있습니다. `PPV_TOURNAMENT_URL=off`면 카메라만 혼자 씁니다.

`server.js` 환경 변수:

| 변수 | 기본값 | 하는 일 |
|---|---|---|
| `PORT` | `8791` | 포트(늘 `127.0.0.1`에만 열림) |
| `PPV_QA` | 없음 | `1`이면 `qa/` 페이지도 보냄 |
| `PPV_SAVE_DIR` | `~/pingpong-vision-saves` | 저장한 랠리 폴더 |
| `PPV_KEY_FILE` | `~/.config/pingpong-vision/upload-key` | 업로드 열쇠 파일(처음 켤 때 만듦) |
| `PPV_SETUP_FILE` | `~/.config/pingpong-vision/setup-tokens.json` | 1회용 설정 링크 토큰 |
| `PPV_TOURNAMENT_URL` | 없음 | PC 저장 PIN을 확인할 점수판 앱. 없으면 그 기능은 꺼짐 |
| `PPV_TOURNAMENT_DATA` | `tournament/data/tournament.json` | 대회 PIN이 든 파일 |

## 다른 종목으로 바꾸기

탁구에만 해당하는 부분은 몇 개 모듈에 모여 있습니다.

| 무엇 | 어디 | 바꿀 것 |
|---|---|---|
| 코트 크기 | `public/js/geom.js`: `TABLE_LENGTH`(2.74), `TABLE_WIDTH`(1.525), `TABLE_HEIGHT`(0.76), `makeCalibration` | 미터 단위 크기. 코트 종목은 선수가 코트 면에 서므로 `TABLE_HEIGHT` 바닥 차이는 0 |
| 중복 상수 | `public/js/ui.js`: `TABLE_L`, `TABLE_W`, `MOVE_SCALE_M`, `SHOT_SCALE_KMH` | 바운드 지도 모양과 막대 눈금 |
| 선수 구역 | `public/js/players.js`: `ZONE_M`, `plausiblePerson` | 테니스 선수는 코트 밖 멀리까지 가니 구역을 넓힘 |
| 공 모양 | `public/js/ball.js`: `BallDetector`, `BallTracker`, `pathResidual` | 색, 밝기, 크기, 속도 조건(테니스공은 연두색이고 더 큼) |
| 장면 조건 | `public/js/pipeline.js`: `tableUniformity`, `TABLE_MIN_UNIFORM`, `TABLE_CHECK_EVERY`, `SHAKE_*`, `ISSUE_NO_TABLE` | "한 색 탁구대 윗면" 검사는 작은 단색 면을 가정 |
| 바운드·샷·랠리 끝 | `public/js/rally.js`: `RallyEngine` | 바운드 검출, 샷 추론, 랠리 끝 시간, 네트 위치(`TABLE_LENGTH / 2`) |
| 포인트 승패 | `public/js/point.js`(+ `test/point.test.js`, `qa/point-eval.mjs`) | 새 규칙(선 안/밖, 서비스 박스, 한 번 바운드 허용)으로 다시 작성 |
| 샷 이름 | `public/js/rally.js`: `classifyKind`(45/35/22 km/h), `strokeSide` | 새 기술 이름과 기준 |
| 보정 화면 | `public/js/ui.js`: `CALIB_STEPS`, `CALIB_DONE` | 탁구대 모서리 대신 코트 선 모서리 |
| 화면 글자 | `public/js/hud.js`(`drawHud`), `public/js/ui.js`, `pipeline.js`의 문구 | 이름과 안내 문구 |
| 시험과 측정 도구 | `test/*.test.js`, `qa/ball-offline.mjs`, `qa/score.mjs` | 고정 데이터, 기댓값, 내 정답 영상 |

## 기여

이슈와 PR 모두 환영합니다(한국어, 영어 모두 좋습니다).

- PR 전에 `bun test`를 돌려 주세요. 화면을 바꿨다면 폰(가로 393 px)과 가로 화면 캡처를 붙여 주세요.
- 카메라 영상, 공개 데이터가 아닌 사람 프레임, 열쇠, 호스트 이름, 주소는 **절대 커밋하지 마세요.** 올리기 전에 확인:

  ```bash
  R=$(mktemp -d) && git archive HEAD | tar -x -C "$R" && bash scripts/scan-public.sh "$R"; rm -rf "$R"
  ```

- 구조와 데이터 약속: [docs/system-design.md](docs/system-design.md), [docs/contract.md](docs/contract.md), 화면 규칙 [docs/ui-guidelines.md](docs/ui-guidelines.md).

## 릴리스

버전은 하나입니다. 시작 화면의 `V x.y.z`, `package.json`, 릴리스 태그가 같습니다. 태그는 번호를 건너뛸 수 있습니다. 버전마다 바뀐 점은 [CHANGELOG.ko.md](CHANGELOG.ko.md)(English [CHANGELOG.md](CHANGELOG.md))에 쉬운 말로 적습니다. 내려받기(소스 zip)는 [릴리스](https://github.com/orientpine/pingpong-vision/releases) 페이지에 있습니다. 릴리스를 만드는 방법은 [RELEASING.md](RELEASING.md)에 있습니다.

## 라이선스와 제3자 고지

MIT © orientpine, [LICENSE](LICENSE). `tournament/`의 대회 앱도 같습니다. 상업적 용도를 포함해 무료로 쓰고 고치고 나눌 수 있습니다. 저작권 표시는 남겨 주세요.

제3자 구성 요소(자세한 것은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)):

- Galmuri 픽셀 폰트, SIL OFL 1.1 (`public/fonts/LICENSE-Galmuri-OFL.txt`)
- MediaPipe Tasks Vision과 Pose Landmarker 모델, Apache-2.0
- ONNX Runtime Web, MIT. RTMPose 모델(OpenMMLab), Apache-2.0(성능 측정 페이지에서만 사용)
- OpenTTGames 데이터는 들어 있지 않습니다. `docs/img/`의 이미지(배너 GIF, 화면 캡처, social preview)는 그 데이터의 프레임을 담고 있어 MIT가 아니라 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/deed.ko)을 따릅니다(출처: OpenTTGames, OSAI, https://lab.osai.ai/).
