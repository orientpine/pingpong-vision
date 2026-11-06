# Changelog

All notable changes to PingPong Vision. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/) (see [RELEASING.md](RELEASING.md)).

한국어: [CHANGELOG.ko.md](CHANGELOG.ko.md)

## [Unreleased]

## [1.1.35] - 2026-11-06

From here on the version is one number: the V on the start screen, both `package.json` files and the tag ([RELEASING.md](RELEASING.md)). Public tags skip the numbers that went to production only.

### Added

- **The tournament app is now in this repository (`tournament/`).** Brackets (double, triple, league), scores, referee, spectator and TV screens, and the PIN that protects scoring. One clone and one install give you the scoreboard and the camera on one address. See [Tournament and PIN](README.md#tournament-and-pin).

### Changed

- `deploy.env.example` turns the tournament app on. An existing `deploy.env` keeps working as it is, camera only, until you add `TOURNAMENT_PORT` and `PPV_TOURNAMENT_URL`.
- The phone's address is now `https://<your PC>/`. `/vision/` still opens the camera directly.
- **One command on macOS and Windows.** `bun run.mjs` starts the camera and tournament apps and serves both on one local address, so one `tailscale serve` line shares them. `install.ps1` sets everything up on Windows (and adds a sign-in task with `-AutoStart`); `install.sh` runs on macOS as well as Linux.
- **Tailnet only by default.** `start.sh` used to put the app on the internet (Tailscale Funnel) when `deploy.env` had no `PPV_TS_MODE` line. Now `deploy.env.example` and `install.sh` give `serve` (only your tailnet), and `start.sh` stops and asks if the line is missing. Internet access is opt-in: [Open it to the internet](README.md#open-it-to-the-internet-optional).
- README: a *What's new in 1.1* section with screens of the real app on a public test clip and made-up names; making a tournament says 2 to 8 players, each as `name,four digits`.

## [1.1.34] - 2026-11-05

### Fixed

- With the camera placement guide on, the card's first line stayed on "Tap the left corner of the near end" while the corners went in (seen with a paused video file). It now follows every tap and every Precise answer, and the position and framing checks use the taps at once.

## [1.1.33] - 2026-11-05

### Changed

- Optional **Camera placement guide** in Settings (off by default): check the long-side position, height and look-down angle, whole-table framing, then level and shake before finishing with **Precise** and **OK**. Each step can be skipped; without an orientation sensor the angle and level recommendations remain available. The guide does not add calibration rejection rules.

## [1.1.32] - 2026-11-05

### Changed

- Calibration has a **Precise** button. Rough taps stay where you put them (before, the points jumped as soon as the fourth one went in). Press Precise and the app gathers about a second of frames (10) and fits the corners to the table's white border, using the middle of the per-frame fits so a shaking tripod does not throw it. The taps stay as a faint dotted outline to compare; **Revert** goes back to them and **Fit again** fits from them with a new second. A shaking tripod is reported ("Fitted, but shaking ±N px"); a very shaky one keeps the points. When no border line is found, a point is too far, or the fit is not the table top, the points stay and the guide names the point or side. A search that finds nothing runs once more twice as wide. Taps close to the corners still fit best: on the owner's club clips taps 20-30 video px off fitted 97% of the time, 40 px off about three times in four (otherwise the points stay and the guide names the side).
- QA: `qa/calib-snap-ui.mjs` plays a copy of the owner's clip as the camera and presses rough taps → Precise → Revert → Fit again → OK as the owner does, plus taps off the table and a shaking clip. It reports how far the fitted sides are from the read ones (px) and the table-top error (cm), and checks that no guide message moves the picture. `qa/corner-refine.mjs` takes `--set`, `--shake` and `--impl` for the owner's clips, shake and a main comparison.

## [1.1.31] - 2026-11-04

### Changed

- 다시 보기 on a turned phone: when the court map takes its small spot (168 px), its foot keeps blue at the left and red at the right on one row with the bounce count under them, as upright since 1.1.30; before, red wrapped under blue and ended 88 px short of the right edge.

## [1.1.30] - 2026-11-04

### Changed

- 다시 보기 starts a second before the serve. Since 1.1.28 a point clip holds the full three seconds before its rally, and the replay played all of it, so the serve came about 2-3 s in. It now starts 1 s before the rally (the first ball the camera sees, which is the serve's hit). On club clips the toss begins 0.6-0.8 s before that, so the whole serve shows; 0.5 s started mid-toss. A new `처음부터` chip plays the clip from 0, pre-roll included. The clip file, its overlay track and the analysis desk are unchanged.
- 다시 보기 on a phone uses the whole screen. In landscape the picture was squeezed to about a third of what the screen can show (483x272 or less on an iPhone 16 Pro), beside an empty navy column. That column was the camera's control bar, which a replay does not show. The column is gone and the picture fills the height (715x402). The tournament app's replay now gives this page the whole screen, and the page draws `‹`, `✕ 닫기`, `처음부터`, `오버레이 끄기` and `다시 보기` in the camera screen's top and bottom rows, inside the safe area. The tall vertical `다시 보기` and the floating `끄기` are gone. Upright, the picture sits right under the top row instead of floating in the middle of the screen.
- QA: `qa/replay-phone-layout.mjs` opens 다시 보기 the way a player does (tournament 다시 보기 → replay iframe) on a copied saved clip at 874x402, 844x390, 402x874 and 390x844, and at 402x874 turned to 874x402, with an iPhone safe area. It measures where playback starts, the picture's share of the screen, overlapping boxes and text, and cut text, and saves captures. `qa/replay-data.mjs` follows the new embedded replay: 다시 보기 and ✕ 닫기 are the replay page's own, replay again starts a second before the serve, the page's own chips are allowed, and the camera-versus-replay name-tag check in screen px runs only where both screens put the picture in the same box (a phone replay no longer keeps the control-bar column, so b-tag-video compares in video px; on clip12 at 852x393 the screen-px gap was 42 px against a video-px gap of 0.7 px).

## [1.1.29] - 2026-11-04

### Fixed

- Saving a point clip, and the script that moves old clips onto camera times, now check the rewritten file by decoding every picture at its own time. The old check forced 60 frames a second and flagged clean phone clips whose pictures came less than 1/60 s apart. A clip that fails the check keeps its original, and the script now puts a failed clip back from its backup by itself.
- The ball overlay no longer locks onto a spot in the background. A slow, smooth chain of bright fragments on a far barrier graphic could pass the flight-shape test and be shown as the ball for about 0.7 s (a club clip from 2026-11-04). Outside the calibrated table a lock now also needs a flying speed of at least 128 processing px/s. On the labelled test videos ball recall is unchanged (3153/3153), false outputs 158 -> 155, test_1 bounces 29 -> 28 of 31; the threshold was chosen after seeing results (256 was tried first).

## [1.1.28] - 2026-11-04

### Changed

- The analysis desk now finds the far player's body pose in point clips from a camera beside the table, where the table hides that player's legs. It reads the far end enlarged around far shots, as for whole videos, and counts a clearly seen upper body there. On two real point clips the far serve's pose was found at 3 of 3 moments instead of 1, and at 1 of 1 instead of 0. Live scoring on the camera is unchanged.
- The player page can now tell a player's racket hand from point clips too: each shot's own hand vote is kept, and once a player has five or more votes over all their shots the majority is used for the arm numbers (elbow angle, hand height). With fewer votes, or a tie, the hand stays unknown as before.
- Point clips now start the full three seconds before the rally on phones whose camera gives more than 30 pictures a second; before, those phones got about 2.4 seconds. The pre-roll keeps about 30 pictures a second, so it uses no more memory, and the clip plays at about 30 frames a second. This fills the three seconds before the rally; it is not the fix for choppy replay on phones. Each clip also notes what the pre-roll held when it started, so a clip with a short start can be traced to its cause. The pre-roll also keeps filling on the corner screen, so a serve right after setting the corners gets its three seconds too.

### Fixed

- Point clips play smoothly on a phone. The camera phone draws clip pictures between its analysis steps, so they reached the clip bunched (two or three within 12 ms, then 50-65 ms of nothing) and a phone replay showed about 20 of the 31-34 pictures a second. The PC now moves each saved picture to the time the camera filmed it, without re-encoding, and moves the overlay with it. On club clips from 2026-11-04 played at phone width in WebKit, pictures shown went from 101 to 161 of 164 and from 126 to 192 of 202 (about 20 to 33 a second). A clip whose overlay track lacks camera times stays as it came. `scripts/retime-saves.mjs` does the same for clips saved before, with a backup and a way back.

## [1.1.26] - 2026-11-02

### Changed

- Forehand/backhand on a whole video added on the analysis desk is more often right for the player at the far end. The far end is now also read enlarged around each of that player's shots, and a shot whose player was not actually seen near that moment is left without forehand/backhand instead of being guessed from a pose seconds old. On two labelled test videos (56 shots) wrong calls went from 16 to 12 with the same 28 right; 11 shots now show no forehand/backhand instead of 7.

## [1.1.25] - 2026-11-02

### Changed

- A whole video added on the analysis desk shows its shots, bounces, shot kinds and points within seconds: a first pass finds them without the pose model while the full analysis still runs. Forehand/backhand then fills in on the same shots when the full analysis finishes; until then the desk and the analysis screen say *forehand/backhand in progress*. On two labelled test videos (56 shots) the shots found went from 46 to 51 and wrong shots from 54 to 48; a 30-second video's shots took about 7 seconds instead of about 11 minutes. Point clips from the camera are analysed as before.

## [1.1.23] - 2026-11-01

### Fixed

- Changing the language on the mode screen after START no longer jumps to the camera screen. A phone that last chose camera opened the camera screen, and other phones landed on the match screen with their remembered mode painted. Now the mode screen stays, with every mode button plain, in the new language.

## [1.1.22] - 2026-11-01

### Changed

- The analysis PC finishes a point's clip in about 3 seconds instead of about 15 (one test clip with one shot, from upload to result). For point clips the shots, forehand/backhand and shot kind come from the phone and stay the same; the PC now finds the players' joints with its CPU, because the "GPU" it used was drawn by the CPU in software and was about 6 times slower. It found joints on more shots in a test (19 of 22 instead of 12). Long videos added from the gallery are analysed as before, since there the joints also decide which shots are found. The PC also checks for new work every second instead of every 5 seconds.
- QA: the one-phone WebKit test's fake camera no longer plays a hidden video. Under load, WebKit's playback of a looped test clip could stop for good after the clip went back to its start, and the test then waited minutes for a point that could not come. The clip is now decoded to pictures before the camera starts and shown on a clock that keeps real time; the test can still pause it while people fix the score.

## [1.1.21] - 2026-11-01

### Changed

- The tournament app's camera-call page is titled *판정 비교*, so the title fits beside the 관전 · 보기 전용 chip on a 393-wide phone (it was cut to 카메라 판정 …). Version number only on the camera side.

## [1.1.20] - 2026-11-01

### Added

- Every point the camera judges is recorded on the tournament PC next to what the referee entered: the camera's call (side, sure or weak, why the rally ended, shots and bounces, what 누가 땄나요 pre-chose, end colour hold) and the result (who entered it, which side, how long it took, later flips or take-backs, the clip). *Camera calls vs referee* on the tournament's match screen shows per match and in total how often they matched, how often sure calls were right, which side the referee picked on weak calls, points the camera missed and fake calls, and downloads the same as CSV. The record stays on that PC and holds no names or pictures; a failed write never stops a score.

## [1.1.19] - 2026-11-01

### Changed

- The ball trail on the camera screen and in the replay joins every ball point again, as in 1.1.17: the 1.1.18 change that left out steps longer than half the table on screen is reverted, because it also cut normal steps (8 real ball steps in the recorded test runs). A rare stray straight line is left as it is for now.

## [1.1.18] - 2026-11-01

### Fixed

- A point never gets another rally's replay clip. When rallies came back to back, the recorder could hand the clip of the rally before (or the one waiting) to the next point, so one clip sat on two points: 16 of 78 rallies in a 4-minute run on 1.1.16, 0 of 74 now. Each rally asks for its own clip only; a rally the recorder could not take (one clip still finishing and another already waiting) is saved with no clip.
- The court map shows the table as the camera sees it: the far long edge is on top. Bounces and player spots were drawn upside down (a far-side bounce showed near the bottom). Drawing only; saved bounces are unchanged. The tournament app's analysis sheet has the same fix.
- The ball trail on the camera screen and in the replay is no longer joined across a jump: a step longer than half the table on screen (a frame where the tracker took something else) is left out instead of drawn as a long straight line. The ball points are all still shown.

### Changed

- `./start.sh --restart` also restarts a running analysis desk worker, so it runs the new release.
- QA: `qa/preroll-soak.mjs` counts, for every rally, whether it got its own clip, another rally's clip, or none; `qa/tournament-e2e.mjs` allows a point without a clip only when the camera recorded that rally as refused, and fails when one clip is on two points.

## [1.1.17] - 2026-11-01

### Fixed

- Fewer fake 못 받음 points. The camera no longer turns a serve plus one stray bounce, or a ball it simply lost sight of, into a point.
- A weak call (one bounce, or a very short piece of a rally) is never pre-chosen on 누가 땄나요. The bar shows the camera's guess in words instead (*Camera guess Blue · not sure*), so the referee decides. Sure calls are pre-chosen as before.
- Fewer phantom bounces right after a serve: a bounce is only counted when the ball itself made it, and the receiver's hit is not counted before the serve has landed on their side.
- A short pause in the phone's analysis is no longer read as the ball being lost.
- At low frame rates (around 20 fps) the camera keeps hold of the ball better, and it times each camera picture by when it was taken.

## [1.1.16] - 2026-11-01

### Added

- `bun update.mjs` updates a public install with one command: it stops if the folder has local changes, backs up the settings folder, tournament data and rally saves into a dated folder, gets the new version, runs the installer, restarts the Linux service or the macOS LaunchAgent (or waits for a restart by hand), checks `/healthz` and the new version, and prints the lines to go back if a step fails.
- Settings on the camera screen and on the tournament screen show *New version · vX.Y.Z* when the public repository has a newer release. The app asks GitHub's public API at most once a day and sends nothing else; `PPV_UPDATE_CHECK=off` in `deploy.env` turns it off.
- A rally saved to the PC during a tournament match goes to the analysis desk by itself once its point is entered: the phone sends only the save id, the point, the camera's end and the table corners, and the tournament app makes one desk job from the clip and track already on the PC (asking again never makes a second one).

## [1.1.15] - 2026-11-01

### Changed

- The analysis desk worker no longer defaults to this PC's tournament address or GPU job queue: `DESK_SERVER`, `DESK_HEAVY` and `DESK_HEAVY_QUEUE_DIR` are required, and `deploy/install-desk-worker.sh` takes them as `--server`, `--heavy` and `--heavy-queue-dir`. A public export of the repo no longer names them.
- The court map colours both ends of the table: the blue end blue, the red end red, always. They swap when the end colours are swapped (⇄ or settings) and stay through 자리 교체, where only the players move. The court map no longer gets a coloured border or a 블루 끝 / 레드 끝 label when it covers an end line; the players panel still does.

### Fixed

- Camera screen in landscape and on a TV: the 누가 땄나요 bar no longer covers the table's top or a player. It is one low row (the question beside two 44 px buttons) on a free spot off the table, the space above it, the players and the ball's path; the players panel and court map make room, folding by themselves if needed. Portrait keeps the bar under the top rows, where it covers nothing.

## [1.1.14] - 2026-11-01

### Changed

- Replay clips now start 3 s before the rally (was 1.5 s). To stay under the 60 MB cap the held pictures are kept at a 480-pixel long side (about 0.52 MB each, about 49 MB at 30 fps); the analysis desk still reads the serve's pose from them.

## [1.1.13] - 2026-11-01

### Added

- Replay clips now start 1.5 s before the rally: while PC save is on, the camera keeps its last 1.5 s of pictures (at a 640-pixel long side, about 34 MB at 22 fps, never more than 60 MB), so the serve and its backswing are in the clip and the analysis desk can read the server's pose 0.77 s before the first shot. rally.js can mark the start a few tenths of a second after the serve, which is why it is 1.5 s and not 1 s.
- Each clip's track records how many pictures were shown, drawn, skipped or handed over early, and how long the camera stalled (`meta.counts`).

### Changed

- Clip pictures are drawn on the page's own screen-refresh loop, oldest first: a stall of the analysis loop now delays pictures instead of dropping them, and the backlog drains at about the clip's frame rate. Right after a stall the clip briefly plays fast; the overlay stays on its picture. A hidden tab falls back to drawing on the camera frame.
- A rally that starts inside the last clip's final second waits for that clip to end, so a point's ending stays in its own clip.

### Fixed

- An error inside the recorder turns recording off for the page (a chip and one console warning); scoring and analysis carry on.
- The clip's last picture is no longer lost when recording stops.

## [1.1.12] - 2026-11-01

### Changed

- Tournament scoring is now confirm-first: after each point the 누가 땄나요 bar opens with the camera's call already chosen, and one tap enters it, on the camera or with [확정] on the referee screen. A point the referee enters closes the camera's question, and the clip still goes on that point. `POINT_ENTRY` in `public/js/tournament.js` switches back to the old automatic entry.

### Fixed

- Two cameras whose end colours look opposite no longer enter points by themselves. 점수 보류 shows on both phones and on the referee screen, and no call is pre-chosen. A colour changed on either phone ends the hold. Points entered from the camera's call before the warning are marked on the referee screen with 반대로 / 맞음, and nothing changes by itself.

## [1.1.11] - 2026-11-01

### Fixed

- Camera screen in landscape and on a TV: the players panel and the court map no longer cover the table, the players or the ball's flight. Each goes to a free spot, shrinks if there is none, and folds by itself as a last resort (a dot on the 선수·코트 chip). Portrait is unchanged.
- QA: `qa/panel-table.mjs` counts panel points on the table, the players and the ball zone at 852x393, 1280x720, 1920x1080 and 393x852, with settings and history open too.

## [1.1.10] - 2026-11-01

### Added

- The camera, replay and share pages come in 한국어 or English: a Language row in settings (shared with the tournament app; refused while recording, since the reload would stop the clip). Score call-outs go out in both languages so each viewer screen reads its own.

### Fixed

- Calibration action labels wrap between words with the icon over the label on a TV or a 1280 screen, and the landscape chip strip never runs into the button column (the fps readout hides first).
- The page language is set from `js/page-lang.js` instead of an inline script the CSP blocked, so the replay and share page titles follow it; the share page shows one language.
- QA: `qa/i18n-census.mjs` measures every screen in one language at 393x852, 852x393 and 1920x1080, and `qa/lang-switch.mjs` walks the language choice end to end.

## [1.1.9] - 2026-11-01

### Changed

- Each phone's end colour is picked by a person: after the four corners the calibration guide asks 끝 색 (confirm, or ⇄), and settings 카메라 앞쪽 changes it on either phone. Two cameras merge with those picks from the first rally; the automatic matching is gone, and bounces only warn when the colours look opposite.

### Fixed

- The end-colour warning (끝 색 반대?) stays on the other camera's chip in landscape too, and a tap on the chip opens settings at the warning.
- A notice over the picture keeps off the players, the name plates, LOCK, the end labels, the table, buttons and panels.
- Settings keep their title and ✕ in view while scrolling, start under the top chip row in landscape, and open above the 누가 땄나요 bar.
- QA: `qa/end-sync-e2e.mjs` covers picked end colours and measures the warning notice frame by frame (0 px over bodies, plates, labels, the table, buttons and panels to pass).

## [1.1.8] - 2026-11-01

### Fixed

- The end labels (블루 끝 / 레드 끝) keep off each player's body, so in landscape the red end label no longer sits on the player beside the court map.
- QA: `qa/end-label-overlap.mjs` plays a public clip at each screen size and counts, frame by frame, the pixels where an end label covers a player, a plate, LOCK, a button, a panel or the table.

## [1.1.7] - 2026-11-01

### Added

- Each 다시 보기 overlay track frame keeps the camera clock (cam). Old tracks without it still play.
- A rally desk job with its 다시 보기 track takes shots and bounces from the track and poses only around them: exact with cam, estimated (marked) for originals from before it. The analysis worker stays off in production.

### Fixed

- QA: replay-data passes cam through its picture logger and checks every saved track frame carries it.

## [1.1.6] - 2026-11-01

### Added

- A PC desk worker takes videos uploaded to the tournament app's 분석 데스크, runs them through the production pipeline under the PC's GPU job queue and sends back each rally's shots, landings, bounces and the body pose around each hit. A killed worker's job is requeued and resumes from its checkpoint. The worker is not started in production with this release.
- A `rally` job (a 다시 보기 original) is kept as one rally with every shot and bounce.

### Fixed

- The desk samples a browser recording at its average frame rate when ffprobe reports the container tick (30000/1) as the frame rate.

## [1.1.5] - 2026-11-01

### Added

- The camera sends each scored rally's shots, landings and bounces (no body pose) to the tournament app, which keeps them per match for the analysis sheet.
- QA: technique accuracy tools that run the production pipeline on public answer sets.

### Fixed

- QA: tournament-e2e proves the camera calibrated in the run it measures.
- QA: the fake camera reports how far its clip got and how many different frames it drew, and a stalled clip resumes where it stopped instead of going back to the start.
- QA: every-button recovers a page that stops answering when a screen is first listed; venue and one-phone print the camera's analysis rate on every step.

## [1.1.4] - 2026-11-01

### Added

- Two cameras agree on the end colours by themselves. The first camera reads which end is red and which is blue for the second phone from bounces both saw, merges their rallies only once that is decided, and tells that phone its colour; if later bounces disagree, merging stops with a notice. When it cannot decide after 60 s and six rallies, phone 2 asks once with two buttons in its own picture's words. The settings choice stays as a manual override.
- Thin see-through dotted end lines in the end colours on the calibration and camera screens (drawn on the screen only, never in what the analysis reads). A panel that covers an end line marks its edge in that colour with 블루 끝 / 레드 끝 just outside it; nothing is drawn on the table.
- 색 바꾸기 (⇄) on the calibration bar swaps the two end colours; a chip says 왼쪽 블루 · 오른쪽 레드. Referee and spectator screens show which camera films which end.
- Each saved rally records its analysis rate and screen size (no device name).

### Fixed

- Calibration: the ⇄ button no longer appears in a row of its own after the fourth corner (it moved the picture while the corners were stored).

## [1.1.3] - 2026-10-31

### Fixed

- Portrait calibration stores the corners where they were tapped. Two guide messages wrapped to three lines at 393 px, grew the guide, moved the picture, and the corners were stored about 25 video px low. The guide now keeps two lines' height and those two messages are shorter.

## [1.1.2] - 2026-10-31

### Added

- Clips now keep the original camera picture, with the overlay saved beside it as a separate information track (`overlay.json.gz`). The replay draws the camera screen's own overlay over the clip, one draw per presented frame.
- In a replay, 선수·코트 folds and opens, and the overlay can be switched off. Clips saved before this play as they are.

### Changed

- Recording costs far less: about 8 ms per recorded second, down from about 190 ms, because the clip no longer draws the screen copy.

### Fixed

- A rally that follows closely after another no longer loses its video.
- The overlay stays in step with the clip while paused.

## [1.1.1] - 2026-10-31

### Added

- Two cameras on one match. When a second camera holding the tournament PIN joins the match and is judging, the two phones merge their bounces by server-clock time and table position, so one camera fills the moments the other loses the ball. One decision per rally, never two points; when the two cameras call a point differently the camera asks 누가 땄나요. Only the first camera writes points and records clips. With one camera nothing changes. Camera, referee and spectator screens show 카메라 1대 / 카메라 2대 합치기 and a short switch toast; a camera counts once it is calibrated and judging, and drops out when it leaves or stays silent for 15 s.

### Fixed

- QA: the fake camera's stall restart backs off instead of restarting every second.

## [1.1.0] - 2026-10-31

### Changed

- One version number across the tournament app and this app; `package.json` now carries it.
- QA harnesses give tournament players a four-digit code when the server asks for one, and every-button gives each press 30 s.

### Fixed

- QA: the fake camera rewinds its looped clip before the end and restarts a stalled clip, and venue and one-phone print those counts on every step.
- QA: tournament-e2e waits for the applied calibration up to 30 s instead of a fixed 10 s.

## [1.0.2] - 2026-10-31

### Fixed

- **`install.sh` works on recent macOS again.** It stopped at the model download with `usage: sha256sum [-bctwz]`, because recent macOS ships its own `sha256sum` that the model check mistook for the Linux one. It now uses `shasum` when present.

## [1.0.1] - 2026-10-31

### Changed

- **New name: PingPong Vision.** The repository is now `orientpine/pingpong-vision`. The old address `orientpine/table-tennis-vision` still redirects, and existing clones keep working. To update the remote anyway: `git remote set-url origin https://github.com/orientpine/pingpong-vision`.
- **A mascot and the pixel title.** The README opens with the app's pixel-art title (the one on the start screen) and a ping-pong penguin.

### Fixed

- **The banner GIF no longer jumps.** About one frame in four of the README animation showed a zoomed-in corner of the screen. It is re-recorded frame by frame at the page's own scale.

## [1.0.0] - 2026-10-31

First tagged release: the app as it runs at the maintainer's club since the 0.1.0 snapshot, plus a new installer (`install.sh`, `deploy.env.example`) and a PC install guide.

### Added

- **Full-screen overlay in portrait too.** The camera picture fills the phone in both orientations, and the panels float on it: a one-row glance strip, see-through buttons, and a players / court map chip you can fold.
- **Each player's standing position** is drawn on the picture and on the court map.
- **Replay clips record the screen you see.** A rally's clip holds the camera picture with the overlay and the panels where they sit on screen (rally time, shots, speed, player panels, court map). Buttons, chips and the settings sheet stay out. Settings → replay overlay can turn it off and record the camera alone.
- **판정 안정 모드 (stable judging mode).** If the phone starts repeating frames (over 30% repeats) or reads fewer than 12 frames a second for two 5-second windows in a row, the picture shrinks so the analysis keeps up. It returns to full screen after 30 s of good reads. Settings has 자동 / 끄기 (auto / off), and tapping its chip goes back to full screen at once.
- **Low-light and small-table notices** when you confirm calibration, so you know before a match that tracking will be weak.
- **Ball colour setting:** white (default) or orange (experimental).
- **Calibration snap.** Roughly tapped corners snap onto the table's white border, and the outline is shown for you to confirm. If the snap is not clearly the table edge, your taps are kept. If a corner is on the frame edge, the app says the table end is off screen instead of calibrating.
- **Optional scoreboard link** (needs a compatible scoreboard app, see [docs/tournament-link.md](docs/tournament-link.md)):
  - Points are judged from the ball path and entered automatically, with a 3 s cancel bar. If the call is unsure, the app asks with one-tap buttons.
  - Korean score call-outs, ends that change by the table-tennis rules, and one-tap 렛?/폴트? (let? / fault?) prompts.
  - You can fix the score by hand on the camera screen while it keeps filming.
  - Red / blue are the table's two ends and stay put. Only the players move when ends change.
  - The camera writes points with the scoreboard PIN only. The PIN typed on the camera is remembered on that phone.
- **PC save by PIN.** Entering the scoreboard PIN in any browser turns on rally saving to your own PC. The upload key never leaves the PC. The first screen, the camera strip and settings show whether saving is on.
- The model loading bar counts the real bytes received (MB counter). A stalled or failed download says why and offers 다시 받기 (download again).

### Changed

- **A double tap no longer zooms the camera screen.** Two-finger pinch zoom still works.
- Every input field is at least 16 px on phones, so iOS Safari does not zoom in when you tap one. Options are spaced 8 px apart, and long lists fold.
- The players and court map panels start open on every visit.
- The back button works on every camera screen, and the browser back button does the same. While recording, it asks once before stopping the camera.
- Overlay labels (name plates, LOCK, speed, standing marks) are measured on screen so they never overlap each other, a button, or the 3 s cancel bar. Skeleton lines are drawn under the text.
- The settings sheet fits a 393 px phone.
- `PPV_TOURNAMENT_URL` has no built-in default. Without it, PIN save is off (503). `start.sh` reads it from `deploy.env` and stops with a message if it is missing (`off` turns it off).

### Fixed

- When the phone camera turns after it starts (landscape frames first, then portrait), the tap mapping, the analysis canvas and the clip recorder follow the new frame size.
- A ball flying over the table takes over from a fast blob next to it (a swinging arm).
- Ball lock for a camera low behind one end. The end-on cubic lock is off by default and can be turned on in settings.
- The bounce dip threshold scales with the table, not the frame height.
- A lone player at one end takes that end's slot, and is marked off screen only after 2 s.
- A reopened video file starts from 0 instead of the old end position.
- A changed scoreboard PIN cannot lock a camera out: an old PIN that is refused once is dropped.
- PIN save sends the scoreboard app only the client address this server saw (last hop from loopback, else the peer).

## [0.1.0] - 2026-10-29

First public snapshot (untagged, a single commit). On-device pose for two players, ball tracking, rally time and shots, estimated shot speed, bounce map, MOVE distance and wrist angle, LOCK marker, rally history, optional save to your own PC, offline accuracy harness on OpenTTGames.

[Unreleased]: https://github.com/orientpine/pingpong-vision/compare/v1.1.35...HEAD
[1.1.35]: https://github.com/orientpine/pingpong-vision/compare/v1.0.2...v1.1.35
[1.0.2]: https://github.com/orientpine/pingpong-vision/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/orientpine/pingpong-vision/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/orientpine/pingpong-vision/releases/tag/v1.0.0
[0.1.0]: https://github.com/orientpine/pingpong-vision/commit/56bb9e8
