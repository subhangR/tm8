# PR Ledger — 2026-08-29 UI transformation train

Every PR of the day (plus the two 08-28 foundation PRs), verified via `gh pr view --json state,mergeCommit` on 2026-08-29. Merge SHAs are the squash/merge commits on `main`.

Deploy receipts (authoritative session timeline): production ran `8f68149e` from **08-28 19:57Z**; then bundle-swap deploys `4a41c5b3` (~04:49Z), `83fbb28f` (~05:20Z), `d236174d` (~10:1xZ per its receipt), `903417d2` (11:48Z), `3cb0a2c8` (live ~15:10Z). Anything merged after `3cb0a2c8` is **pending deploy**.

> **#538 deploy-time ambiguity (recorded honestly):** the session timeline as first written listed `c2f3648a` (#538) deploying ~11:45Z, but the corrected receipt times for #539 (~10:1xZ) and #540 (11:48Z) imply #538 reached production earlier (between its 09:25Z merge and the #539 deploy). Exact #538 deploy time: **unverified**.

| PR | State (verified) | Merge SHA | One-line scope | Deploy status |
|---|---|---|---|---|
| [#526](https://github.com/subhangR/tm8/pull/526) | MERGED 08-28 19:39Z | `8f68149e` | Adopt Meta Astryx design system: React 19, root theme bridge, Astryx task card (phase 1) | deployed (live from 08-28 19:57Z as `8f68149e`) |
| [#531](https://github.com/subhangR/tm8/pull/531) | MERGED 08-28 19:39Z | `8d733bd4` | Graph: flow-card canvas per the approved design refs (stacked on Astryx phase 1) | deployed (in the `8f68149e` line) |
| [#532](https://github.com/subhangR/tm8/pull/532) | MERGED 04:45Z | `4a41c5b3` | Relocate product UI to `packages/tm8_ui_2.0`; freeze tm8-ui as the 1.0 snapshot | deployed ~04:49Z |
| [#533](https://github.com/subhangR/tm8/pull/533) | MERGED 05:01Z | `e7caf041` | Craft: dead + button — mirror host-made selections eagerly; suite to 0 failures | deployed ~05:20Z (in `83fbb28f`) |
| [#534](https://github.com/subhangR/tm8/pull/534) | MERGED 05:13Z | `83fbb28f` | Graph kinetic tuning — legend kind marks, mono refs, frosted cards, active-path edges | deployed ~05:20Z |
| [#538](https://github.com/subhangR/tm8/pull/538) | MERGED 09:25Z | `c2f3648a` | Kinetic wave 1 — the Kinetic design system across the web app | deployed (exact time unverified — see ambiguity note) |
| [#539](https://github.com/subhangR/tm8/pull/539) | MERGED 10:04Z | `d236174d` | Kinetic Elite palette + Figtree — the design system finally renders in color | deployed ~10:1xZ per its receipt |
| [#540](https://github.com/subhangR/tm8/pull/540) | MERGED 11:43Z | `903417d2` | Kinetic wave 3 — the whole entity system: functional panel, 17-kind registry truth, Figtree caps | deployed 11:48Z |
| [#541](https://github.com/subhangR/tm8/pull/541) | MERGED 14:15Z | `84cbc7c0` | Compose board cards with Astryx Card | deployed ~15:10Z (in `3cb0a2c8`) |
| [#542](https://github.com/subhangR/tm8/pull/542) | MERGED 13:51Z | `1a6b6b81` | Align Astryx atoms with Kinetic theme tokens | deployed ~15:10Z (in `3cb0a2c8`) |
| [#543](https://github.com/subhangR/tm8/pull/543) | MERGED 14:00Z | `4fec5759` | Fix Maestro task tile control geometry | deployed ~15:10Z (in `3cb0a2c8`) |
| [#544](https://github.com/subhangR/tm8/pull/544) | OPEN (head `89fc3cf1`) | — | Improve Help discovery for new users | **deferred** — not in the train |
| [#545](https://github.com/subhangR/tm8/pull/545) | OPEN, **draft** (remote intentionally stale; local head `bf24218c`, base `41c824b4`) | — | Redesign Home and shared entity navigation | **pending (in train)**. Local verification (lane 01a04ddb): focused 147/147; panel/home isolation 134/134; full suite 359 files / 4,901 pass; strict typecheck; production build with zero CSS parser/minify warnings. A11y note: its 3 earlier failures were accessible-name contract regressions (kind trigger restored to `config.labelPlural`; rail toggle to 'Expand/Collapse the rail'). |
| [#546](https://github.com/subhangR/tm8/pull/546) | MERGED 14:43Z | `a4c06a31` | Kinetic experience layer — kit grammar, motion, ten-territory reclassification, mobile, overflow guards | deployed ~15:10Z (in `3cb0a2c8`) |
| [#547](https://github.com/subhangR/tm8/pull/547) | MERGED 15:02Z | `3cb0a2c8` | Close the unclosed `.b2[data-family] .b2__card` rule | deployed ~15:10Z |
| [#548](https://github.com/subhangR/tm8/pull/548) | MERGED 15:11Z | `41c824b4` | Switcher popover composition — grouped spaces, brand-fill selection, buttoned footer | merged, **pending deploy** (merged one minute after the `3cb0a2c8` deploy went live) |
| [#549](https://github.com/subhangR/tm8/pull/549) | OPEN (head `ec933d4c`) | — | Honesty captions are prose — reading type; cluster label column legible | **held** (train-tail). Owns the list-row COLLECTION/STATE cluster defects explicitly excluded from #550's scope. |
| [#550](https://github.com/subhangR/tm8/pull/550) | OPEN, non-draft (head `7097052e`, base `41c824b4`) — the T3 lane PR (lane `01a04dd8`) | — | Redesign task detail as premium Kinetic surface | **pending (in train)**. Gated; CI typecheck+tests **IN_PROGRESS at manifest time**. Claimed-by-lane evidence (until merged): typecheck pass; focused 70; guards 40 + 1 skip; full UI 4,892 + 2 skips; production build 3,116 modules; Firefox proofs desktop / 125% zoom / mobile dark / discussion / focus / reduced-motion / forced-colors; zero overflow; readable points+dates; Figtree prose. Checked-in harness: `packages/tm8_ui_2.0/e2e/task-detail-premium-harness.{html,tsx}` + `e2e/task-detail-premium.spec.ts`. Limitation, verbatim: Chrome absent at `/opt/google/chrome/chrome`; Firefox evidence authoritative. |

Notes:
- "T3 PR (pending, no number yet)" in the original brief **is** #550 — it received its number during the day and is recorded above.
- This artifact's own PR (`docs(ui): before/after evidence artifact`) is not part of the product train and intentionally not a ledger row.
