# Public technique-label set

The original run below is the earlier pose-off baseline. The latest pose-on
per-technique counts are in the final "Pose-on 기술별 표본 수" section.
`qa/technique-accuracy.md` contains the current measured accuracy report.

Evidence directory: `--evidence=<dir>` or `EVIDENCE_DIR` (default `qa/evidence`).
Videos: `--videos=<dir>` or `VIDEOS_DIR` (default `data/videos`).
Annotation clone: `--truth=<dir>` or `TRUTH_REPO` (default `qa/truth-repo`).
Local-only videos and derived frames are not part of this worktree.

## Pipeline coverage

The unmodified production `Pipeline.processPixels` ran through the same RGBA
decode path as `qa/phone-clips.mjs`, with its default white-ball setting and
640-pixel processing width. This path does not run pose inference; consequently
the collected hand predictions are null, not correct hand classifications.
The run exited 0:

```sh
cd <repo>
bun qa/technique-dataset.mjs
# DATASET_DONE shots=108
```

| Clip | Decoded frames | Detected shots | Label source | Matched dataset strokes |
| --- | ---: | ---: | --- | ---: |
| test_2_head | 1301 | 2 | Extended OpenTTGames test_2 | 1 |
| cozza | 486 | 2 | Independent agent inspection | n/a |
| portrait_game | 573 | 0 | No detections to label | n/a |
| landscape_game | 692 | 0 | No detections to label | n/a |
| training_480 | 964 | 0 | No detections to label | n/a |
| test_2_portrait | 1800 | 46 | Extended OpenTTGames test_2 | 28 |
| test_5_portrait | 5760 | 58 | Extended OpenTTGames test_5 | 23 |
| Total | 11576 | 108 | Sources remain separate | 52 |

**The requested positive shot count for every clip is not satisfied.**
The three zero-shot clips remain explicit negative coverage results. No shots
were invented, no detector gates were bypassed, and no production classifier
was changed. `portrait_game` had 510 no-table, 2 searching, and 61 unstable
frames. `landscape_game` had 497 no-table, 2 searching, and 193 unstable frames.
`training_480` has a close-up moving view with approximate calibration.

`test_2_head` uses the `test_2` corners from `qa/eval-set.json`; Cozza and
portrait-game use the documented phone-evaluation corners. The letterboxed
test_2/test_5 copies scale the original corners by 0.5625 and add approximately
656 pixels of vertical padding. `calibration.json` records those transforms.
Landscape and training calibration is a low-confidence estimate from a blurred
preview because neither supplied calibration document contains those clips.
Handheld motion and approximate corners confound detector-only conclusions.

## Two distinct truth sources

### Commons: independent agent labels

`labels-gpt.json` has exactly two Commons labels, both with `source: "agent"`.
I viewed each before/hit pair without displaying the predicted hand/type fields
or consulting other technique labels. Both hand and type are `unsure` for both
shots: the privacy band, table occlusion, and only two stills do not establish
the striking arm or tactical type reliably. These are uncertainty records,
not two correctly classified examples. There are **zero scorable Commons
hand/type labels** and **zero human-confirmed labels**.

`labels-human.json` starts as `[]`. It is never populated from agent or dataset
labels. The browser persistence check uses a disposable isolated fixture, not
the real evidence file.

### Extended OpenTTGames: supplied frame annotations

Source: `https://github.com/moamal01/table_tennis_data`, cloned to
the `--truth` directory, commit
`36471a76b969a0340df59258a813bf8214e68e7c`, CC BY-NC-SA 4.0.
Upstream README and `src/view_labels.py` establish 120 fps and zero-based
OpenCV frame indexing. The source's annotation files and SHA-256 hashes are
recorded in `dataset-truth.json`. This truth file does not use agent labels.

Our mapping is `serve -> serve`, `loop/flick -> attack`, and
`block/push/lob -> defence`. Other techniques, if encountered, retain their
raw value and hand but have null mapped type; they are not silently remapped.
In the evaluated test_2/test_5 intervals no unmapped techniques occurred.

For these side-view calibrations, source `left -> near`, `right -> far`.
Annotations are matched to decoded source timestamps (`sourceT`), not the
incorrect nominal container rate. Candidate pairs must be on the same side
and within 0.15 seconds (18 original 120-fps frames). Closest absolute time
difference wins, then deterministic ID/frame tie breaks. A detection and
annotation are each used once within a clip.

| Evaluated clip | Annotated strokes in interval | Matched | Unmatched detections | Unmatched annotations |
| --- | ---: | ---: | ---: | ---: |
| test_2_head, first 10.842 s | 9 | 1 | 1 | 8 |
| test_2_portrait, 30 s | 29 | 28 | 18 | 1 |
| test_5_portrait, 96 s | 27 | 23 | 35 | 4 |

The head and portrait test_2 clips overlap the same original video. These are
separate clip results, **not independent source-video samples to pool**.
The portrait derivatives preserve original wall time and only letterbox/
resample frames. The two full source-video annotation sets are test_2/test_5;
this run does not claim evaluation of all seven upstream test videos.
Unmatched detections remain unmatched; there is no nearest-label assignment
outside the timing window. Match counts describe detection alignment, not
classification accuracy.

## Frames, files, and privacy

`shots.json` contains all 108 detected shots: clip, pipeline timestamp,
decoded-source timestamp, side, stroke, kind, speedKmh, mapped predictions,
and before/hit paths. Shot updates replace the initial event's pending
speed/type values. Cozza's invalid container average is corrected exactly as
in the phone harness; frame extraction still uses original decoded PTS.

There are 216 nonempty JPEG frame files, at hit and 0.3 seconds before hit
(clamped at zero). FFmpeg applies a conservative full-width blurred head band
covering players and bystanders; it retains lower-body/racket evidence where
possible. The band dimensions are explicit in `privacyFilter` in the runner.
Blurred calibration previews and local contact sheets are additional evidence,
not distributed source captures. Do not commit or redistribute these frames.
No frame images are embedded in this report.

The three viewed privacy spot-checks were
`test_2_head-002-hit.jpg`, `cozza-002-hit.jpg`, and
`test_5_portrait-058-hit.jpg`. Faces were blurred in all three.
Cozza/portrait-game source credit is retained in
`evidence/r4/phone/README.md` (CC BY-SA 4.0); the Extended OpenTTGames
annotation license remains distinct.

## Correction tool and reproduction

```sh
cd <repo>
bun qa/label-tool.mjs --evidence=<dir>
# Open http://127.0.0.1:8897 locally.

# Re-extract blurred frames without rerunning the pipeline:
bun qa/technique-dataset.mjs --extract --evidence=<dir> --videos=<dir>
python3 qa/technique-contact.py <dir>
bun qa/technique-truth.mjs
bun qa/technique-verify.mjs

# Browser-based check:
bun qa/label-tool-check.mjs
```

The server binds loopback only, serves allowlisted frame basenames, checks
same-origin JSON writes and the ID/hand/type enums, and serializes atomic
tmp-to-rename saves beside the dataset. Its Korean page separates agent
labels, unreviewed dataset-backed shots, and human corrections.

File/label/source verification passed: 108 shots, 216 frames, two independent
Commons records, 52 matched upstream annotations, and no human reviews.
The verifier checks annotation hashes, raw source labels, time/side mapping,
uniqueness, and no cross-source mixing. It separately prints
`COVERAGE_UNMET` for the three zero-shot clips.

The browser check exited 0: desktop (1280x900) and mobile (390x844) screenshots
were inspected, images loaded, and neither viewport overflowed. An isolated
fixture correction persisted after reload; invalid IDs, cross-origin writes,
and unlisted frame requests were rejected. Actual `labels-human.json` remained
unchanged. The final line was `LABEL_TOOL_CHECK_PASS shots=108`.
Screenshots remain local as `label-tool-desktop.png`/`label-tool-mobile.png`.
The TypeScript language server is not
installed; LSP diagnostics could not run. Executable Bun checks cover imports
and syntax. No production tournament data was read, no PIN was printed,
no `rally.js` or `pipeline.js` was edited, and no commit was created.

<!-- pose-on-counts -->

## Pose-on 기술별 표본 수

공개 데이터셋 정답 기준: 이 표는 qa/eval.js, pose=1, poseModel=lite로 다시 검출하고 기존 dataset-truth.json의 주석에 재매칭한 최신 결과예요. 정확도는 accuracy.md, 기계용 6종 값은 accuracy.json에 있어요.

| 기술 | 매칭 정답 n | 해당 키 예측 수 | TP |
| --- | ---: | ---: | ---: |
| fore-attack | 26 | 17 | 13 |
| fore-defence | 2 | 7 | 1 |
| fore-serve | 2 | 0 | 0 |
| back-attack | 9 | 7 | 1 |
| back-defence | 3 | 1 | 0 |
| back-serve | 0 | 1 | 0 |

전체 매칭 42개 중 hand 예측 33개예요. 위 예측 수는 같은 정답 행 안의 수가 아니라 해당 클래스로 예측한 총수예요. n=0에는 성능을 주장하지 않아요.

공개 데이터셋 정답 기준: 매칭 샷 42개 중 hand 판정 33개, 일치 16개, 오판 17개, 미분류 9개예요. 판정한 샷의 hand 정확도는 48.48%예요.

최신 pose-on 검출은 주석 구간 안 TP 42, 거짓 샷 FP 59, 누락 FN 23예요. 이전 pose-off 발견인 거짓 샷 49/101개는 accuracy.md의 이전 실행 섹션에 그대로 남겨요.

### 미실행·미완료 클립

완료된 pose-on 결과는 4개뿐이에요. 아래 3개 클립은 측정하지 않았으며, 0개 검출이나 정확도 0%로 해석하지 않아요. 모두 dataset-truth.json의 주석 대상이 아니므로 아래 공개 데이터셋 정답 기준 분류·검출 분모에 들어가지 않아요. lead hold에 따라 pose·브라우저 재실행은 하지 않았어요.

| 클립 | 상태 | 사유 |
| --- | --- | --- |
| portrait_game | 측정 안 함(실행 미완료) | 1200초 후 시간 초과 |
| landscape_game | 미실행 | portrait_game 시간 초과로 중단, lead hold |
| training_480 | 미실행 | portrait_game 시간 초과로 중단, lead hold |

pose-resume.log의 오류 원문:

```text
error: Pose evaluation timed out: portrait_game
      at <anonymous> (qa/technique-pose.mjs:63:39)
```
