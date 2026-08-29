> **EXECUTED 2026-08-29 (phase 2)** — 15 after-images captured from the deployed head `6423d07d` via fixture-seam vite (bundle sha-proven == production). See README §Phase 2.

# Phase 2 — After-Capture Plan

Matched after-images per territory, to be captured **ONLY from the verified final production head after the train deploy** (i.e., after #548 and the remaining train-tail PRs — #550, #545, #549 as they land — are deployed and the deploy receipt SHA is confirmed). Do **not** capture from a browser tab that may be service-worker-stale: verify the loaded entry asset hashes against the deploy receipt first (see the stale-cache note in [README.md](README.md)).

## Hard rules

1. **Head verification first**: record the production deploy receipt SHA; confirm `tm8.sh` serves that bundle (entry asset hash comparison). Every after-image row must carry that SHA.
2. **Viewports**: 1600×950 desktop AND 390×844 mobile, per route.
3. **Themes**: both light and dark, per route/viewport.
4. **Browser**: Firefox only — Chromium's V8 segfaults on this host kernel and Chrome is absent at `/opt/google/chrome/chrome`. Firefox evidence is authoritative.
5. **Recipe**: the session's fixture-seam Firefox recipe — seed the fixture pass yourself (the stale capture-audit script is not trustworthy), build your own cli dist with `tsc -p` (the shared checkout's dist can be stale and blanks the UI at boot), and **click-nav** to channel/session chat (channel deep links do not route). For true production after-shots (not fixtures), drive the real prod UI in Firefox with the origin allowlist + agent-token-as-pass approach, and verify the bundle hash per rule 1.
6. **Naming**: `after-<territory>-<route>-<viewport>-<theme>.png`, indexed with the same provenance columns as phase 1 (route, fixture/entity, viewport, theme, production SHA, timestamp, source).
7. **Never** date any row by `fetchedAt`-style metadata; use the capture timestamp and receipt SHA.

## Checklist by territory (matched to the before-evidence)

- [ ] **Task detail** — open a real task with description, runs, acceptance criteria, and a live session (match `before/0829-1404` and `before/0829-1453`): panel default state, Controls row (points field legibility — no `no es`), acceptance section, discussion tabpanel. Desktop+mobile, light+dark, plus 125% zoom and reduced-motion+forced-colors passes. Preferred deterministic path: rerun PR #550's checked-in harness at the final head — `packages/tm8_ui_2.0/e2e/task-detail-premium-harness.html` / `.tsx` + `e2e/task-detail-premium.spec.ts` (auto-attaches `task-detail-light-desktop`, `task-detail-dark-390`, `task-detail-discussion-dark`).
- [ ] **Board / Astryx cards** — Board with a Sessions kind and a Tasks kind (match `before/0829-1157`): composed Card anatomy, family accent; verify reduced-motion.
- [ ] **Maestro / list rows** — Projects list with an expanded row (match `before/0829-1153-projects-list…` and `before/0829-1528`): cluster label column, honesty captions. If #549 is still unmerged at capture time, capture anyway and label the row **pending (in train)** for the caption fixes.
- [ ] **Home / global nav** — Home with lists + a live session (match `before/0828-1518`, `before/0829-1246`); nav rail light+dark (match `before/0829-1153-nav-rail…`, `before/0829-0750`). If #545 has landed, note it; if not, these are waves-only after-shots and the #545 pre-train set (`images/pr545-pre-train/`) must be refreshed or SHA-qualified post-#550-rebase and final deployment.
- [ ] **Switcher** — popover open (match `before/0829-1156-switcher-popover` / `before/0829-1507`): grouped spaces, brand-fill selection, buttoned footer (#548). This is the flagship merged-but-undeployed delta — capture it first once the deploy lands.
- [ ] **Mobile** — 390×844 for Home, Task detail, Board, Graph minimum. Record explicitly that no mobile before-images exist.
- [ ] **Graph** — canvas with legend + a focused node (match `before/0829-0513` shelf crop): legend clamps, kind marks, active-path edges, lens banner. Desktop+mobile, both themes.
- [ ] **Craft** — chat + blueprint pane (match `before/0829-1158-craft-chat-blueprint`): grammar reclassification; confirm the `+` button is alive (#533 behavior, visual only here).
- [ ] **Settings** — Members & roles (match `before/0829-1158-settings-members-roles`): first-ever screenshot verification of the #546 sweep on this territory.
- [ ] **Help / Prompts** — Help page and command palette overlay (match `before/0829-1152-topbar-palette-crop`; compare `session/kinetic-help-prompts`): palette overflow clamp. #544 remains deferred — do not represent Help *content* changes as shipped.
- [ ] **People / Channels** — Teammates/Members/Channels lists and one channel view (click-nav; deep links do not route). First screenshot verification of the sweep here too.

## Exit criteria for phase 2

- Every territory row in the README matrix gains at least one after-image whose provenance row carries the verified final production SHA.
- The 14 `unverified` provenance rows from phase 1 either stay honestly labeled (historical) or gain corroboration — never silently relabeled.
- README coverage summary and gaps list updated; `pending (in train)` rows re-labeled `shipped` only after both merge **and** deploy are receipt-verified.
