# Attention forms-chip scrolling

Task: `01a11b00-0438-75de-be49-1b33fbeab6ba`.
Baseline: `e2b4ea3c2` (includes PR #1068).

[Durable screenshots, measurements, and check receipts](https://tm8.sh/#/s/01a0fb3d-558e-7d92-b370-d0601112607a/work?tab=01a11b16-1b02-756e-9531-9f61b6568a4f)
are published as artifact `01a11b16-1b02-756e-9531-9f61b6568a4f`, revision 1, linked as a task deliverable.

## Cause and fix

`PendingFormsBanner` portals its forms-chip dialog outside the right action
strip. The capped `.pf-chip__pop` could scroll, but the inner `.pf-banner`
inherited `overflow-y: auto` and `overscroll-behavior: contain`. Its height was
unbounded, so it swallowed wheel/touch gestures without moving. The popover
now constrains the banner and gives `.pf-banner__list` the single internal
scroll range. The heading stays outside it; Hide and submit/discard stay sticky.

Initial focus also ran while the positioning hook still hid the dialog.
It now waits for visible placement. Portal keyboard events stop at the dialog,
so the parent toolbar cannot steal Home/End or arrow keys. Escape still closes
the dialog and restores focus to its trigger. Inline-banner styles and PR #1068
SaveControls rules are unchanged.

Measured after a real 600px wheel gesture (CSS pixels; app zoom 1.1):

| Viewport | Baseline outer client/content height | Baseline scrollTop | Fixed list client/content height | Fixed list scrollTop |
| --- | --- | --- | --- | --- |
| 800×400 | 347 / 3544 | 0 | 288 / 3500 | 545.45 |
| 390×420 | 365 / 4547 | 0 | 306 / 4818 | 545.45 |
| 320×240 | 202 / 5844 | 0 | 142 / 6137 | 545.45 |

Touch at 390×420 moved the list to 160px, with page scrollY still 0. Initial
focus succeeds in all three fixed captures (fails in all baseline captures).
Tab reaches question 16 and Submit, submission works, amendment/discard stays
reachable after resizing to 320×240, and Escape restores trigger focus.

## Verification

- Seven Chromium cases pass: four viewport sizes (also 1280×800), keyboard
  submission/amendment/discard, touch scrolling, and unchanged inline-banner scrolling.
- The 800×400 wheel test fails with baseline CSS restored: expected scrollTop
  greater than 100, received 0. The focus fix was retained for that CSS-only regression.
- Six focused Vitest files / 104 tests pass.
- UI TypeScript check and production Vite build pass. Vite reports its existing
  large-chunk advisory.

From `packages/tm8-ui`:

```sh
bun run test:e2e --config e2e/attention-scroll.config.ts
bun run test -- src/forms/pending.test.tsx src/forms/questionnaire.test.tsx src/tab-workspace/view/forms-attention-layering.test.ts src/tab-workspace/view/action-strip-split.test.tsx src/kit/anchoredPopover.test.ts src/authoring/authoring.test.tsx --maxWorkers=2
bun run typecheck
bun run build
```

This runner required extracted Chromium shared libraries and
`TM8_BROWSER_SINGLE_PROCESS=1`; Chromium then cannot reuse a browser across
contexts reliably. Each of the seven cases was run in a fresh invocation using
`--grep`, and passed without retries. This is a runner constraint, not a test
skip. Normal environments use the default browser process model.

For repeatable measurements, start Vite and run:

```sh
TM8_UI_URL=http://127.0.0.1:4612 TM8_EVIDENCE_LABEL=after node e2e/capture-attention-scroll.mjs
```

## Entry-path boundary

A real API-backed Workspace check opened Game Design task
`01a11abc-3d05-7b01-bc80-902b932789a8`. On the baseline, its rolled-up form is
shown by a floating `AttentionBlock`; its right strip has no generic Attention
button. The screenshot is in the evidence artifact. The coordinator assigned
that generic mount/wiring to a separate lane. This PR covers the existing
session forms-chip overlay and does not change terminal/panel mounts.
No real form answers were submitted. Long-form browser tests use the actual
components/CSS with a fixture forms port. Safari and physical devices were not tested.
