# Camera placement guide verification

Branch: `feat/camera-guide`, based on `f8f512e` (the Precise button).

## Advisory thresholds

The November 4, 2026 placement evidence covers 14 owner club clips and seven
OpenTTGames clips. These are setup suggestions, never additional calibration gates.

| Measurement | Starting recommendation |
| --- | --- |
| Position | Long-side/end-line pixel ratio at least 3 preferred; below 2 warns, matching `pipeline.js:endOnView` |
| Height/angle | Lens 1.4-1.8m high, looking down 10-25 degrees; provisional physical starting ranges, not recovered from a table homography |
| Framing | Every corner at least 2% inside the frame; table area target 6-8%, warning below 5% as in `guards.js:SMALL_TABLE` |
| Level | Actual phone roll within 3 degrees; beyond 5 degrees warns; perspective-slanted table edges are not phone roll |
| Shake | Consecutive-frame translation p90 at most 1px, warning beyond 2px at 960px frame width; normalized by width; provisional cutoff |

## Layout and portable smoke inputs

Layout: camera guide - keep the table and its labels exposed -> compact overlay
above the far end in landscape, in the upper black margin in portrait; scroll
owner: none. The landscape guide replaces only the visibility of the existing
absolute guide strip. At every step, the complete current `.calibbar__text` is
mirrored in the card's first line; placement advice takes the second line.
Only placement advice may use ellipsis. Neither the stage nor the calibration
bar is resized.

The smoke checks all five steps against the bounding box of four actual marker
buttons expanded by 24px. It also checks at most two text lines, picture-box
stability, the canonical calibration DOM when the guide is off, and shake.
The guide walk starts with zero corners. Before each tap it records the current
calibration message and corner count, then records the end-colour sentence and
the result of pressing Precise. Message checks compare the mirror with the live
source, reject clipping and hidden ancestors, and hit-test the text against
overlapping elements at every step.
Its four input paths are required:

```sh
bun qa/camera-guide-ui.mjs --engine=chromium \
  --clip=<still.webm> --shaky=<shaky.webm> \
  --corners=<corners.json> --tournament=<tournament-checkout>
```

`--engine=webkit` uses `PPV_WEBKIT` when supplied. Korean is the default;
`PPV_LANG=en` selects English. Captures go under the output directory's
`<engine>-<language>` subdirectory.

## Checks

- Full message-visibility `bun test`, run once: 305 pass, 0 fail (exit 0).
  Host load averages: 12.22, 7.18, 14.96.
- Initial focused guide/i18n run: 22 pass, 0 fail, including 16 guide tests.
- Initial mutation run: replaced all six exported functions with unconditional success/zero
  returns. Result: 6 pass, 10 fail. Restored before the full suite.
  Small-table and clipped-corner tests both received true instead of false; end-on,
  six-degree roll, straight-ahead pitch and three-pixel shake also received true
  instead of false. The shifted-frame test received 0 instead of 3. Missing-input
  and textureless-frame tests caught the removed null results.
- The new stylesheet, controller and entry HTML passed the frontend draft guard.
- JavaScript LSP checks were unavailable: `typescript-language-server` is not installed.

## Browser smoke

Fresh message-visibility captures and JSON receipts are in
`evidence/camera-guide-messages/`, under `chromium-ko` and `webkit-ko`.
Each walk starts with zero corners, records the four tap prompts, presses
Precise, walks all five guide steps, confirms, then switches the setting off.

| Engine | View | Result | Calibration visible | Tap order | Maximum overlap (px²) | Text lines |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium | 393x852 | PASS | true | true | 0 | 2 |
| Chromium | 852x393 | PASS | true | true | 0 | 2 |
| WebKit | 393x852 | PASS | true | true | 0 | 2 |
| WebKit | 852x393 | PASS | true | true | 0 | 2 |

Both final runs exited 0 and printed `CAMERA_GUIDE <engine> ko PASS`.
Chromium used one corrected attempt after the initial harness counted multiple
ellipsis Range fragments as separate lines. The line check now measures actual
line-box height. WebKit passed on its first attempt. No application retry was
needed. Earlier English captures remain in `evidence/camera-guide-followup/`;
this message-visibility regression was run in Korean as requested.

The canonical calibration bar comparison passed in all four cases: class tokens
are sorted separately, so absent/empty class attributes and attribute order cannot
create a false failure. All class tokens, other attribute values and child content
remain part of the comparison.

### Recorded calibration messages

The live source and fully visible mirror matched before each tap in every case:

| Corners before tap | Message |
| --- | --- |
| 0 | 내 쪽 끝선 왼쪽 모서리를 누르세요 |
| 1 | 내 쪽 끝선 오른쪽 모서리를 누르세요 |
| 2 | 건너편 끝선 오른쪽 모서리를 누르세요 |
| 3 | 건너편 끝선 왼쪽 모서리를 누르세요 |

After the fourth tap: `내 쪽은 블루 끝이에요. 맞으면 확인, 아니면 ⇄`.

| Engine | View | Recorded Precise result |
| --- | --- | --- |
| Chromium | 393x852 | 테두리에 맞췄어요 · 최대 3px 옮김 |
| Chromium | 852x393 | 테두리에 맞췄어요 · 최대 6px 옮김 |
| WebKit | 393x852 | 테두리에 맞췄어요 · 최대 2px 옮김 |
| WebKit | 852x393 | 테두리에 맞췄어요 · 최대 5px 옮김 |

The full result remained visible at all five guide steps, including during
the shake warning. These fixtures produced successful fits; no failure-message
text was injected.

All successful cases also passed: no guide by default or when off, persisted
setting, unavailable-sensor continuation, steady-frame pass, shaky-frame warning,
disabled Next while shaky, stable button dimensions, minimum target size,
confirmation leaving the guide, and zero page errors. The picture box never
moved: `[8,96,374,581]` in portrait, `[0,0,749,393]` in landscape.
All 20 step captures and four zero-corner captures were visually inspected.
The near-end label stays exposed in landscape, below the unobscured table.

Ports 9650-9652 were checked before each attempt and free afterward; the harness
terminates only its own child server PIDs. No production server was used.

## Accessibility evidence

This small smoke is not a complete WCAG 2.2 AA audit. The parent's browser/capture
matrix remains responsible for unverified cases; no full-AA claim is made here.
The app has one dark theme, as specified in `docs/ui-guidelines.md`.

| Area | Result | Evidence |
| --- | --- | --- |
| Contrast | PASS for guide tokens | Body/solid panel 16.46:1; secondary/solid panel 8.10:1; primary button ink/fill 8.09:1 |
| Focus | Partial | Next focus captures in both views; a complete Tab traversal was not run |
| Target size | PASS | Smoke measured all visible guide buttons at least 24x24; stylesheet uses the existing 44px tap token |
| Keyboard | Not verified | Native buttons and focusable feedback; full keyboard flow not exercised |
| Reflow/text spacing | Partial | Both requested views fit; 320px and custom text spacing not exercised |
| Drag/authentication/help/entry | N/A for new guide | No new drag, authentication, help or repeated-entry flow; existing calibration keeps its keyboard corner nudges |
| State-stable controls | Partial | Idle/hover dimensions matched; all other states were not individually measured |
| System/surfaces | PASS | Existing CSS tokens and button anatomy; no blur, gradient, added accent stripe or new theme |

## Architectural review

The pure module owns placement judgements; the controller owns guidance lifecycle.
Device events are checked at their boundary and motion samples are normalized to
960px width. Step discrimination is exhaustive. No type escape, assertion, new
dependency, redundant verification, negative flag name or logging was introduced.
The text-diff helper has multiple callers and keeps native button targets intact.
The frame estimator's four arguments describe one image pair's buffer layout, not
independent options. Tests cover positive, negative and unavailable inputs, and
the mutation run distinguishes their failures. The guide controller remains below
200 non-comment lines. The harness is in the 200-250 warning band (222 lines);
its DOM probes should be extracted if another change expands it. The existing
large app/UI modules received only the setting and controller integration,
without restructuring unrelated behavior.
