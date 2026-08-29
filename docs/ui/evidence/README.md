# tm8 UI/UX Before/After Evidence — the 2026-08-29 Transformation

Formal evidence artifact for tm8 task `01a04e34-dfbb-7afa-8095-a0f860fb7e2f`.
**Phase 1** (this document): before-evidence, territory matrix, PR ledger, and the phase-2 after-capture plan.
**Phase 2** (pending): matched after-captures taken **only** from the verified final production head after the train deploy — see [AFTER-CAPTURE-PLAN.md](AFTER-CAPTURE-PLAN.md).

Companion documents: [PR-LEDGER.md](PR-LEDGER.md) · [AFTER-CAPTURE-PLAN.md](AFTER-CAPTURE-PLAN.md)

---

## Executive summary

On 2026-08-29 the tm8 web app (`packages/tm8_ui_2.0`) went through a single-day, whole-surface transformation, shipped as a coordinated train of PRs built by parallel codex lanes:

- **Kinetic Elite palette + Figtree** (#539): the design system finally renders in color and real type; Figtree at real size and weight replaces the app's previous mono-dominant voice.
- **Experience-layer reclassification** (#546, plus #538/#540 waves): a ten-territory sweep applying one law — mono becomes data-only; every label and button moves to the Figtree button/input grammar; kit grammar, motion, and overflow guards across every screen.
- **Functional entity panel** (#540): the whole entity system — functional task detail panel, 17-kind registry truth, Figtree caps.
- **Motion + containment**: reduced-motion support on board cards (#541), overflow clamps for palette and graph legend (#546), closed CSS containment defects (#547).
- **Mobile**: mobile wave 2 in #546; matched 390×844 after-captures are a phase-2 deliverable.
- **Coordinated codex lanes**: work landed via lane branches (`feat/graph-kinetic`, `feat/kinetic-system`, `feat/kinetic-palette`, `feat/kinetic-wave3`, lane `01a04dd8` for the #550 task-detail premium redesign, lane `01a04ddb` for the #545 Home/nav redesign), merged as a train: #532–#534 (relocation, craft fix, graph kinetic) → #538–#540 (waves 1–3) → #541–#543 (board/atoms/tile fixes) → #546–#548 (experience layer, CSS closure, switcher) → train tail #549/#550/#545 still open.

Foundation from the previous day (2026-08-28): Meta Astryx adoption phase 1 (#526) and the graph flow-card canvas (#531), live in production from 08-28 19:57Z as `8f68149e`.

Everything below is labeled with one of exactly five status labels: **shipped** / **pending (in train)** / **deferred** / **unchanged** / **unverified**.

---

## Territory matrix

Columns per the coordinator schema. "Before evidence" / "After evidence" link into [`images/`](images/); full provenance for every image is in the [provenance tables](#image-provenance) below. Key files per territory follow the matrix.

| Territory | Before evidence | After evidence | UX change | A11y / keyboard | Responsive / motion | PR / commit | Production status | Verification / gap |
|---|---|---|---|---|---|---|---|---|
| **Task detail** | [empty task, mono labels, `no es` truncation](images/before/0829-1151-task-detail-empty-untitled.png) · [description/runs overflow](images/before/0829-1404-task-detail-description-runs-overflow.png) · [metadata strip truncation](images/before/0829-1523-task-metadata-strip-points-truncation.png) | [#540 functional panel (pre-merge)](images/session/wave3-panel.png) · [#550 premium final light (pre-merge)](images/pr550/task-detail-premium-final-light.png) | #540: functional panel (kind registry truth, acceptance default-visible). #550 (claimed-by-lane until merged): fragmented header/clipping tabs → composed hierarchy with narrow containment; collapsing metadata → one labelled Controls row, ≥90px points field with 'points' placeholder + both dates/status/priority/assignee; misaligned prose → shared reading edge, Figtree; weak disabled Save → opaque `aria-disabled` + reason; buried criteria → default-visible with real progress and per-state copy; undifferentiated sessions → Live now/History/Liveness-unresolved cards; detached chat → unified discussion tabpanel. Preserved: hooks, mutations, attachments, six-run cap, honesty semantics, token ownership. | #550: `aria-disabled` Save with reason; unified discussion tabpanel (claimed-by-lane) | #550 harness matrix: 6 viewports incl. 1.25 zoom, dark 390w, reduced-motion + forced-colors combo (claimed-by-lane) | #540 `903417d2`; #546 `a4c06a31`; #550 head `7097052e` (open) | shipped — #550 merged `10307c80`, deployed `6423d07d` 17:44:53Z | #550 CI (typecheck+tests) was IN_PROGRESS at manifest time; its evidence is claimed-by-lane until merged. Cluster-row defects excluded from #550 by scope → assigned #549 (held train-tail). Phase-2 after-capture from final head required. |
| **Board / Astryx cards** | [plain white kanban cards](images/before/0829-1157-board-sessions-kanban.png) | [Astryx phase-1 board (pre-#526 session capture)](images/session/board-light.png) · [dark](images/session/board-dark.png) | Board cards composed with the Astryx `Card` atom (Card owns anatomy; family accent kept); Astryx atoms aligned to Kinetic theme tokens; unclosed `.b2[data-family] .b2__card` CSS rule fixed | — (no specific a11y claim verified) | Reduced-motion honored on board cards (#541) | #526 `8f68149e`(deploy) ; #541 `84cbc7c0`; #542 `1a6b6b81`; #547 `3cb0a2c8` | shipped | After-capture of the composed (post-#541/#547) board pends phase 2; session captures shown are pre-#526 fixture states. |
| **Maestro / list rows** | [projects list, expanded-row cluster collision](images/before/0829-1153-projects-list-expanded-row-cluster.png) · [expanded list-row cluster](images/before/0829-1528-expanded-list-row-cluster.png) | — (phase 2) | Maestro task tile control geometry fixed (#543); experience-layer reclassification of row typography (#546). Known defect preserved in before-evidence: cluster label column collides with values ("COLLECTION**In no collection**"); STATE/ARCHIVE captions render as mono blocks. | #549 (held): honesty captions are prose — reading type; cluster label column legible | — | #543 `4fec5759`; #546 `a4c06a31`; #549 head `ec933d4c` (open, held) | shipped — #549 merged `322ae63e`, deployed `6423d07d` | Cluster COLLECTION/STATE defects are **not** fixed in anything merged; they are #549's scope (held train-tail). |
| **Home / global nav** | [Home + sessions + terminal, 08-28 baseline](images/before/0828-1518-home-sessions-terminal.png) · [nav rail light](images/before/0829-1153-nav-rail-light.png) · [nav rail dark](images/before/0829-0750-nav-rail-dark.png) · [global nav / entity organization](images/before/0829-1408-global-nav-rail-entity-organization.png) | [**final head light 1600×950**](images/after-home-light-1600x950.png) · [**dark**](images/after-home-dark-1600x950.png) · [#545 integrated light](images/pr545-integrated/integrated-home-light-1492x900.png) / [expanded](images/pr545-integrated/integrated-home-expanded-1492x900.png) / [responsive 900×800](images/pr545-integrated/integrated-home-responsive-900x800.png) · historical: [wave-1 kinetic Home (pre-#538)](images/session/kinetic-home-light.png) · [palette Home (pre-#539)](images/session/palette-home-light.png) · [#545 pre-train Home light](images/pr545-pre-train/home-light-1492x900.png) / [dark](images/pr545-pre-train/home-dark-1492x900.png) / [expanded](images/pr545-pre-train/home-expanded-1492x900.png) | Waves 1–3 restyle Home into the Kinetic grammar; #545 redesigns Home and shared entity navigation (merged) | #545 lane: 3 earlier failures were accessible-name contract regressions, fixed by restoring kind trigger to `config.labelPlural` and rail toggle to 'Expand/Collapse the rail' | #545 pre-train captures include responsive 900×800 and mobile 390×844 | #538 `c2f3648a`; #539 `d236174d`; #540 `903417d2`; #546 `a4c06a31`; #545 local head `bf24218c` (draft, remote intentionally stale) | shipped — #545 merged `ac1c7235`, deployed `6423d07d` | #545 evidence is pre-train / pre-rebase — final after-captures must be refreshed or SHA-qualified post-#550-rebase and final deployment (lane's own instruction). #545 local verification: focused 147/147; panel/home isolation 134/134; full suite 359 files / 4,901 pass; strict typecheck; production build with zero CSS parser/minify warnings. |
| **Switcher** | [plain popover list, 11:56](images/before/0829-1156-switcher-popover.png) · [still plain at 15:07, 4 min before #548 merged](images/before/0829-1507-switcher-popover-pre-548.png) | [remainder capture (pre-#546 branch state)](images/session/remainder-switcher.png) · [#545 list-switcher light](images/pr545-pre-train/list-switcher-light-1280x800.png) / [dark](images/pr545-pre-train/list-switcher-dark-1280x800.png) / [forced-colors](images/pr545-pre-train/list-switcher-forced-colors-900x700.png) | #548: switcher popover composition — grouped spaces, brand-fill selection, buttoned footer | Forced-colors capture exists in #545 pre-train set | — | #548 `41c824b4` (merged 15:11Z) | shipped — deployed `6423d07d` 17:44:53Z | #548 merged after the last deploy (`3cb0a2c8` live ~15:10Z); production still shows the pre-#548 switcher until the train deploy. Phase-2 after-capture required. |
| **Mobile** | — (no owner mobile before-captures exist) | [#545 pre-train mobile 390×844](images/pr545-pre-train/home-mobile-390x844.png) | Mobile wave 2 (#546); wave-1 groundwork in #538 | — | 390×844 matrix mandated for phase 2; #550 harness includes dark 390w | #538 `c2f3648a`; #546 `a4c06a31` | shipped | No before mobile evidence exists — before/after pairing impossible for mobile; phase 2 captures the after state only, and says so. |
| **Graph** | [graph shelf '48 unconnected' crop](images/before/0829-0513-graph-shelf-unconnected-crop.png) · [design mock (reference, not product)](images/refs/0828-1519-executive-kinetic-graph-mock.png) | [flow-card canvas (08-28 session)](images/session/graph-new-light.png) · [kinetic tuning light (pre-#534)](images/session/graph-kinetic-light.png) / [dark](images/session/graph-kinetic-dark.png) / [hover](images/session/graph-kinetic-hover.png) · [wave-1 escape check](images/session/wave1-graph-escape.png) | #531 flow-card canvas per approved design refs; #534 kinetic tuning — legend kind marks, mono refs, frosted cards, active-path edges; #546 legend percentage overflow clamps. (#536 client-side contextual grouping predates this day and is background, not part of this train.) | Escape/focus behavior probed in wave-1 capture (`wave1-graph-escape.png`) | Legend/palette overflow guards (#546) | #531 (in `8f68149e` deploy); #534 `83fbb28f` (deploy); #546 `a4c06a31` | shipped | Graph after-capture at final head pends phase 2. |
| **Craft** | [craft chat + empty blueprint](images/before/0829-1158-craft-chat-blueprint.png) | — (phase 2) | #533: dead `+` button fixed — host-made selections mirrored eagerly; #546 sweep applies the grammar to Craft | — | — | #533 `e7caf041` (deployed in `83fbb28f`); #546 `a4c06a31` | shipped | No dedicated Craft after-capture exists yet; behavior fix (#533) verified by suite (0 failures at merge), visuals pend phase 2. |
| **Settings** | [Members & roles](images/before/0829-1158-settings-members-roles.png) | — (phase 2) | Covered by the #546 ten-territory reclassification (mono → data-only; Figtree labels/buttons) | — | — | #546 `a4c06a31` | shipped | No dedicated Settings capture on either side of #546 — the sweep's coverage of Settings is asserted by its commit/PR scope, not independently screenshot-verified. Phase 2 must capture it. |
| **Help / Prompts** | [prompts/palette affordance in topbar](images/before/0829-1152-topbar-palette-crop.png) | [help+prompts under kinetic (pre-#538)](images/session/kinetic-help-prompts.png) · [palette overlay (pre-#539)](images/session/kinetic-palette.png) | Kinetic restyle of Help and the command palette (waves + #546 palette overflow clamp). #544 (Help discovery for new users) remains open and deferred. | — | Palette overflow clamp (#546) | #538 `c2f3648a`; #546 `a4c06a31`; #544 head `89fc3cf1` (open) | shipped (restyle) · deferred (#544 Help discovery) | #544 explicitly deferred out of the train. |
| **People / Channels** | [People section in nav](images/before/0829-1153-nav-rail-light.png) (People group: Teammates/Members/Channels) | — (phase 2) | Covered by the #546 sweep (Channels/People territory builder) | — | — | #546 `a4c06a31` | shipped | Like Settings: sweep-asserted, not screenshot-verified on either side. Channel deep links do not route (known trap) — phase 2 must click-nav to capture. |

### Key files per territory

Paths are relative to the repo root, on `main` at `41c824b4` unless noted.

- **Task detail**: `packages/tm8_ui_2.0/` entity panel + `e2e/task-detail-premium-harness.html`, `e2e/task-detail-premium-harness.tsx`, `e2e/task-detail-premium.spec.ts` (on PR #550 branch `tm8/01a04dd8`, head `7097052e` — checked-in, reusable for final-head captures; the harness auto-attaches `task-detail-light-desktop` / `task-detail-dark-390` / `task-detail-discussion-dark` when run).
- **Board / Astryx cards**: board card composition + `board.css` (family accent + reduced-motion kept in the #541/#546 merge resolution); Astryx `Card` atom.
- **Home / global nav / Switcher**: shell/nav components (#548 switcher popover; #545 branch, local head `bf24218c`).
- **Graph**: graph canvas, legend, relevance/grouping modules (#534, #546 clamps).
- **Tokens / type**: Kinetic Elite palette + Figtree tokens (#539), kit grammar (#546).

*(This artifact intentionally names components at territory level; per-file diffs are in each PR on GitHub — see [PR-LEDGER.md](PR-LEDGER.md).)*

---

## Phase 2 — final production evidence (deployed `6423d07d`)

All phase-2 after-images: **final deployed head `6423d07d`** (deployed 2026-08-29T17:44:53Z), captured via fixture-seam vite on that exact commit — bundle identity to production proven by served==disk SHAs (`index-CKbB-BZn.js` f496797a…, `index-nHsBkdS2.css` e2672397…). Firefox 1600×950 unless the filename states otherwise.

| Territory | After (light) | After (dark) | Variant |
|---|---|---|---|
| **Home** | [light](images/after-home-light-1600x950.png) | [dark](images/after-home-dark-1600x950.png) | — |
| **Task detail** | [light](images/after-task-detail-light-1600x950.png) | [dark](images/after-task-detail-dark-1600x950.png) | [mobile dark 390×844](images/after-task-detail-dark-390x844.png) |
| **Board / Astryx cards** | [light](images/after-board-light-1600x950.png) | [dark](images/after-board-dark-1600x950.png) | — |
| **Maestro / list rows** | [light](images/after-maestro-list-rows-light-1600x950.png) | — | — |
| **Switcher** | [light](images/after-switcher-light-1600x950.png) | — | popover open |
| **Mobile** | [light](images/after-mobile-home-light-390x844.png) | — | 390×844 viewport |
| **Graph** | [light](images/after-graph-light-1600x950.png) | — | — |
| **Craft** | [light](images/after-craft-light-1600x950.png) | — | — |
| **Settings** | [light](images/after-settings-light-1600x950.png) | — | — |
| **Help / Prompts** | [light](images/after-help-light-1600x950.png) | — | search active, count sentence visible |
| **People / Channels** | [light](images/after-channels-light-1600x950.png) | — | — |


## What did not change / deferred

- **#544 — Help discovery for new users**: open, explicitly **deferred** out of the train.
- **#549 — list-row honesty captions + cluster label column**: open, **held** as train-tail. The COLLECTION/STATE cluster defects visible in the before-evidence are *not* fixed by anything merged today; they were excluded from #550 by scope and assigned to #549.
- **Server/API surface, data model, hooks/mutations semantics**: unchanged — #550's manifest explicitly preserves hooks, mutations, attachments, the six-run cap, honesty semantics, and token ownership.
- **tm8-ui (1.0)**: frozen as the 1.0 snapshot by #532; product work moved to `packages/tm8_ui_2.0`. The 1.0 package is **unchanged** by this train.
- **Mobile before-state**: no mobile before-evidence was ever captured — that gap is permanent and recorded, not backfilled.

## Stale-cache identification note (service worker)

Owner browser screenshots can show **service-worker-stale bundles older than the then-live deploy**. Every owner image row below is therefore labeled `production (possibly SW-stale)`, and stale output must never be called current production.

**How to tell whether a tab was stale**: compare the entry asset hashes the page actually loaded (DevTools → Network → the fingerprinted JS/CSS entry filenames, or `navigator.serviceWorker` cache contents) against the asset hashes recorded in the deploy receipt for the deploy that was live at the capture timestamp. Hash match ⇒ current; mismatch ⇒ SW-stale, and the screenshot evidences an *older* bundle than production was serving.

---

## Image provenance

<a id="image-provenance"></a>

Conventions:
- **Owner clipboard** rows: source is the owner's browser against production `tm8.sh`; provenance is `production (possibly SW-stale)` per the note above; timestamps are capture-file local time (server clock) embedded in the original filename; the "commit-or-production SHA" column gives the deploy believed live at that moment per the deploy timeline — *believed*, because SW staleness can make the rendered bundle older. Viewports are not recorded for owner captures (browser-window crops); marked `n/a (owner window/crop)`.
- **Session captures**: fixture-seam Firefox captures (deterministic fixtures, not production data), commit-accurate to the branch state listed. Where mapping is uncertain the row says **unverified**.
- Originals were sourced from the owner's clipboard directory and the session scratchpad (historical host locations, kept only as source notes in the provenance tables — every image this document references is the repo-relative copy under `images/`); nothing was edited.

### Owner clipboard (BEFORE evidence) — `images/before/` and `images/refs/`

| Image | Route / content | Fixture or entity | Viewport | Theme | Deploy believed live (SHA) | Timestamp (local) | Source / provenance |
|---|---|---|---|---|---|---|---|
| [0828-1518-home-sessions-terminal.png](images/before/0828-1518-home-sessions-terminal.png) | Home — sessions list + dark session terminal (Astryx feasibility session for #526 running). Pre-transformation baseline. | space Utho Prod, live session panel | n/a (owner window/crop) | light | pre-`8f68149e` (deployed later, 19:57Z) — **unverified** which older deploy | 2026-08-28 15:18 | owner clipboard `2026-08-28/151815-f6c1.png` — production (possibly SW-stale). Identical dup: `151854-79ed.png`; near-identical variant seconds later: `151834-cf04.png` (viewed, same screen) — deduped to one row. |
| [0828-1519-executive-kinetic-graph-mock.png](images/refs/0828-1519-executive-kinetic-graph-mock.png) | "Executive Kinetic" graph **design mock** — Task/Session/Doc/Milestone flow cards + legend. **Not the tm8 product UI**; a design reference for the #531/#534 direction. | mock data | n/a | light | n/a — design reference, not a build | 2026-08-28 15:19 | owner clipboard `2026-08-28/151910-02ab.png` — reference image (provenance of the mock itself unverified) |
| [0829-0513-graph-shelf-unconnected-crop.png](images/before/0829-0513-graph-shelf-unconnected-crop.png) | Graph — shelf strip crop, "SHELF · 48 UNCONNECTED", chip row incl. Astryx artifacts | Utho Prod graph | n/a (crop) | light | `4a41c5b3` (#532, deployed ~04:49Z) | 2026-08-29 05:13 | owner clipboard `2026-08-29/051305-f75f.png` — production (possibly SW-stale) |
| [0829-0527-home-tasks-session-terminal.png](images/before/0829-0527-home-tasks-session-terminal.png) | Home — Tasks list (To Do 197 / In Progress 115) + session terminal reporting #533/#534 deploy | live session, PR chips #526–#534 | n/a | light + dark terminal | `4a41c5b3`; #533/#534 deploy (`83fbb28f`) landing ~this time — **unverified** which side | 2026-08-29 05:27 | owner clipboard `2026-08-29/052747-846c.png` — production (possibly SW-stale). Identical dup: `052804-33c8.png`. |
| [0829-0529-topbar-crop.png](images/before/0829-0529-topbar-crop.png) | Topbar strip — space pill, nav (Home/Work/Board/Craft/Graph/Settings/Help), prompts + palette + Copy link | — | n/a (crop) | light | `83fbb28f` (**unverified**, see row above) | 2026-08-29 05:29 | owner clipboard `2026-08-29/052920-e8fa.png` — production (possibly SW-stale) |
| [0829-0750-nav-rail-dark.png](images/before/0829-0750-nav-rail-dark.png) | Global nav rail, dark — WORK/LIBRARY/PEOPLE groups | — | n/a (crop) | dark | `83fbb28f` | 2026-08-29 07:50 | owner clipboard `2026-08-29/075051-242b.png` — production (possibly SW-stale) |
| [0829-0751-topbar-dark-crop.png](images/before/0829-0751-topbar-dark-crop.png) | Topbar strip, dark | — | n/a (crop) | dark | `83fbb28f` | 2026-08-29 07:51 | owner clipboard `2026-08-29/075130-4a43.png` — production (possibly SW-stale) |
| [0829-1151-task-detail-empty-untitled.png](images/before/0829-1151-task-detail-empty-untitled.png) | Task detail — empty "Untitled task": mono ID/COMPLETION GATE labels, metadata strip with `no es` truncation, description editor, subtree | task `01a04d5b-…-7e1234ae03ba` | n/a | light | `d236174d` (#539, ~10:1xZ) — pre-#540 | 2026-08-29 11:51 | owner clipboard `2026-08-29/115151-6f26.png` — production (possibly SW-stale) |
| [0829-1152-sessions-scope-pills-crop.png](images/before/0829-1152-sessions-scope-pills-crop.png) | Home list header — Sessions scope pills (To Do 0 / In Progress 7 / Done 548) | — | n/a (crop) | light | `d236174d` | 2026-08-29 11:52 | owner clipboard `2026-08-29/115211-e431.png` — production (possibly SW-stale) |
| [0829-1152-topbar-palette-crop.png](images/before/0829-1152-topbar-palette-crop.png) | Topbar right — `/ palette ⌘K`, Copy link, account | — | n/a (crop) | light | `d236174d` | 2026-08-29 11:52 | owner clipboard `2026-08-29/115226-c4bd.png` — production (possibly SW-stale) |
| [0829-1153-nav-rail-light.png](images/before/0829-1153-nav-rail-light.png) | Global nav rail, light — WORK/LIBRARY/PEOPLE/MORE | — | n/a (crop) | light | `d236174d` | 2026-08-29 11:53 | owner clipboard `2026-08-29/115305-d4c2.png` — production (possibly SW-stale) |
| [0829-1153-tasks-scope-pills-crop.png](images/before/0829-1153-tasks-scope-pills-crop.png) | Tasks scope pills — "To Do 896" | — | n/a (crop) | light | `d236174d` | 2026-08-29 11:53 | owner clipboard `2026-08-29/115329-fb9f.png` — production (possibly SW-stale) |
| [0829-1153-projects-list-expanded-row-cluster.png](images/before/0829-1153-projects-list-expanded-row-cluster.png) | Projects list — expanded row cluster: label column collision ("COLLECTION**In no collection**"), mono Archive-permission caption | project `prod-workspace` | n/a | light | `d236174d` | 2026-08-29 11:53 | owner clipboard `2026-08-29/115359-dff1.png` — production (possibly SW-stale) |
| [0829-1154-home-artifacts-session-terminal.png](images/before/0829-1154-home-artifacts-session-terminal.png) | Home — Artifacts list (Done 20) + session terminal | live session | n/a | light + dark terminal | `d236174d` | 2026-08-29 11:54 | owner clipboard `2026-08-29/115446-befc.png` — production (possibly SW-stale) |
| [0829-1156-switcher-popover.png](images/before/0829-1156-switcher-popover.png) | Switcher popover — plain list: `local · this machine`, abhi, Office_Space, Tharak, ✓ Utho Prod, `+ new space` / `+ add server` | — | n/a (crop) | light | `d236174d` | 2026-08-29 11:56 | owner clipboard `2026-08-29/115606-bc0c.png` — production (possibly SW-stale) |
| [0829-1156-work-three-pane-top-strip.png](images/before/0829-1156-work-three-pane-top-strip.png) | Work — three-pane top strip (Tasks / session terminal / Sessions) | live session | n/a (wide crop) | light + dark terminal | `d236174d` | 2026-08-29 11:56 | owner clipboard `2026-08-29/115648-7214.png` — production (possibly SW-stale) |
| [0829-1157-board-sessions-kanban.png](images/before/0829-1157-board-sessions-kanban.png) | Board — Kind: Sessions kanban, plain white cards (pre-Astryx-Card composition), deploy tasks visible in In Progress | Utho Prod board | n/a | light | `d236174d` | 2026-08-29 11:57 | owner clipboard `2026-08-29/115740-9720.png` — production (possibly SW-stale) |
| [0829-1158-craft-chat-blueprint.png](images/before/0829-1158-craft-chat-blueprint.png) | Craft — chat pane ("Morning, Tarkesh.") + empty "Untitled graph" blueprint, Orchestrate | — | n/a | light | `d236174d` | 2026-08-29 11:58 | owner clipboard `2026-08-29/115804-65e5.png` — production (possibly SW-stale) |
| [0829-1158-settings-members-roles.png](images/before/0829-1158-settings-members-roles.png) | Settings — Members & roles (9 members, roles legend) | space Utho Prod | n/a | light | `d236174d` | 2026-08-29 11:58 | owner clipboard `2026-08-29/115824-24fd.png` — production (possibly SW-stale) |
| [0829-1246-home-tasks-terminal-sweep-running.png](images/before/0829-1246-home-tasks-terminal-sweep-running.png) | Home — Tasks + terminal running the ten-territory `kinetic-experience-sweep` workflow (1/10 agents done) | live session | n/a | light + dark terminal | `903417d2` (#540, deployed 11:48Z) | 2026-08-29 12:46 | owner clipboard `2026-08-29/124610-466c.png` — production (possibly SW-stale) |
| [0829-1404-task-detail-description-runs-overflow.png](images/before/0829-1404-task-detail-description-runs-overflow.png) | Task detail — "TM8 Website": description card, RUNS · 1 · 1 LIVE; description/runs overflow (horizontal scrollbar at panel bottom). SHA256 `05f7428c…` (T3-established). | task `E2AD` "TM8 Website" | n/a (narrow panel) | light | `903417d2` | 2026-08-29 14:04 | owner clipboard `2026-08-29/140432-7cd2.png` — production (possibly SW-stale) |
| [0829-1408-global-nav-rail-entity-organization.png](images/before/0829-1408-global-nav-rail-entity-organization.png) | Global nav / entity organization — rail with Tasks+Sessions selected | — | n/a (crop) | light | `903417d2` | 2026-08-29 14:08 | owner clipboard `2026-08-29/140828-5cf1.png` — production (possibly SW-stale) |
| [0829-1453-task-detail-tm8-website.png](images/before/0829-1453-task-detail-tm8-website.png) | Task detail — "TM8 Website" full panel: Open here / Open in Workspace, metadata strip (`no es` truncation), ID/gate card, description, runs | task `E2AD` | n/a | light | `903417d2` (pre-`3cb0a2c8` deploy ~15:10Z) — **unverified** (#542/#543 merged ~14:00Z but not yet deployed) | 2026-08-29 14:53 | owner clipboard `2026-08-29/145344-a11b.png` — production (possibly SW-stale) |
| [0829-1507-switcher-popover-pre-548.png](images/before/0829-1507-switcher-popover-pre-548.png) | Switcher popover — still the plain list at 15:07, four minutes before #548 merged | — | n/a (crop) | light | `903417d2` | 2026-08-29 15:07 | owner clipboard `2026-08-29/150732-a240.png` — production (possibly SW-stale) |
| [0829-1523-task-metadata-strip-points-truncation.png](images/before/0829-1523-task-metadata-strip-points-truncation.png) | Task detail — empty "Untitled task" `EB9D`; metadata strip with points/estimate truncated to `no es` | task `01a04e1d-…-7a7a2dcaeb9d` | n/a | light | `3cb0a2c8` (#546+#547, live ~15:10Z) — **note**: captured *after* the experience-layer deploy yet shows old grammar ⇒ likely SW-stale, exhibit A for the stale-cache note | 2026-08-29 15:23 | owner clipboard `2026-08-29/152334-6dce.png` — production (possibly SW-stale) |
| [0829-1528-expanded-list-row-cluster.png](images/before/0829-1528-expanded-list-row-cluster.png) | Expanded list-row cluster — session "Codex Check": idle pill, STATE/COLLECTION/ARCHIVE cluster with label collision and mono captions. SHA256 `37cf16f4…`. | session "Codex Check" | n/a (crop) | light | `3cb0a2c8` — same SW-stale caveat as row above (defect itself is real and #549-scoped) | 2026-08-29 15:28–15:29 | owner clipboard — **four byte-identical files deduped to one**: `152824-ce1c.png`, `152837-9f2b.png`, `152846-62c2.png`, `152922-ea31.png` — production (possibly SW-stale) |

### Session captures (fixture-seam, Firefox, commit-accurate) — `images/session/`

Branch mapping per the authoritative session deploy/branch timeline. All are deterministic fixture states (space "atelier", user "Ada" — not production data) unless marked live.

| Image | Route / content | Viewport | Theme | Branch / commit mapping | Timestamp | Notes |
|---|---|---|---|---|---|---|
| [board-light.png](images/session/board-light.png) / [board-dark.png](images/session/board-dark.png) | Board, Kind: Tasks — early Astryx-era card states | ~1440×900 | light / dark | 08-28 Astryx phase-1 session (#526 era) — exact commit **unverified** | 08-28 09:02–09:03 | |
| [board-harness-light.png](images/session/board-harness-light.png) / [board-harness-dark.png](images/session/board-harness-dark.png) | Board harness fixtures | — | light / dark | **unverified** (same session) | 08-28 09:02–09:03 | |
| [workspace-light.png](images/session/workspace-light.png) / [workspace-dark.png](images/session/workspace-dark.png) | Workspace view | — | light / dark | **unverified** (08-28 session) | 08-28 09:02 | |
| [tiles-light.png](images/session/tiles-light.png) / [tiles-dark.png](images/session/tiles-dark.png) | Task tiles | — | light / dark | **unverified** (08-28 session) | 08-28 09:04 | |
| [staging-front.png](images/session/staging-front.png) · [staging-front3.png](images/session/staging-front3.png) · [staging-front-final.png](images/session/staging-front-final.png) | Staging front during #526 staging bring-up | — | — | staging deploy checks — **unverified** commits | 08-28 10:24–10:52 | `staging-front2.png` was byte-identical to `staging-front.png`; deduped |
| [graph-proto-1-focus-light.png](images/session/graph-proto-1-focus-light.png) / [graph-proto-2-refocus.png](images/session/graph-proto-2-refocus.png) / [graph-proto-3-dark.png](images/session/graph-proto-3-dark.png) | Graph redesign interactive prototype (design phase for #531) | — | light/dark | prototype, not product build — **unverified** | 08-28 14:49 | |
| [graph-new-light.png](images/session/graph-new-light.png) / [graph-new-dark.png](images/session/graph-new-dark.png) | Graph flow-card canvas (#531 work) | — | light / dark | #531 branch state — exact commit **unverified** | 08-28 15:30 | |
| [graph-kinetic-light.png](images/session/graph-kinetic-light.png) / [graph-kinetic-dark.png](images/session/graph-kinetic-dark.png) / [graph-kinetic-hover.png](images/session/graph-kinetic-hover.png) | Graph kinetic tuning: legend kind marks, frosted cards, active-path edges, lens banner | ~1600×950 | light / dark / hover state | branch `feat/graph-kinetic`, pre-#534 | 08-29 05:06 | timeline-verified |
| [kinetic-BROKEN-boot-evidence.png](images/session/kinetic-BROKEN-boot-evidence.png) | Blank-boot defect evidence (stale shared cli dist blanks the UI at boot) | — | — | `feat/kinetic-system` env defect, pre-#538 | 08-29 06:16 | evidence of the worktree/cli-dist trap, not a UI state |
| [kinetic-gate.png](images/session/kinetic-gate.png) · [kinetic-help-prompts.png](images/session/kinetic-help-prompts.png) · [kinetic-home-light.png](images/session/kinetic-home-light.png) / [kinetic-home-dark.png](images/session/kinetic-home-dark.png) · [kinetic-palette.png](images/session/kinetic-palette.png) | Wave-1 Kinetic system: gate check, Help+Prompts, Home light/dark, command palette | ~1600×950 | both | branch `feat/kinetic-system`, pre-#538 | 08-29 06:36 | timeline-verified |
| [wave1-home.png](images/session/wave1-home.png) · [wave1-palette-filtered.png](images/session/wave1-palette-filtered.png) · [wave1-graph-escape.png](images/session/wave1-graph-escape.png) | Wave-1 verification set (Home, filtered palette, graph escape behavior) | — | light | **unverified** — captured 09:24, minutes before #538 merged 09:25Z; almost certainly `feat/kinetic-system` final state, but not in the authoritative timeline list | 08-29 09:24 | |
| [live-tm8sh-gate.png](images/session/live-tm8sh-gate.png) | Live tm8.sh gate check | — | — | **live production probe**; deploy under test **unverified** (#538/#539 deploy-time ambiguity — see PR-LEDGER) | 08-29 09:33 | |
| [palette-light.png](images/session/palette-light.png) / [palette-dark.png](images/session/palette-dark.png) / [palette-hover.png](images/session/palette-hover.png) · [palette-home-light.png](images/session/palette-home-light.png) / [palette-home-dark.png](images/session/palette-home-dark.png) | Kinetic Elite palette + Figtree: palette overlay and Home in both themes | ~1600×950 | both | branch `feat/kinetic-palette`, pre-#539 | 08-29 09:48–09:56 | timeline-verified |
| [probe-home.png](images/session/probe-home.png) / [probe-panel.png](images/session/probe-panel.png) | Post-deploy probes (Home, panel) | — | light | **unverified** — 10:26–10:28, consistent with probing the #539 deploy (~10:1xZ), but not timeline-listed | 08-29 10:26–10:28 | |
| [wave3-panel.png](images/session/wave3-panel.png) / [wave3-panel-dark.png](images/session/wave3-panel-dark.png) · [wave3-final.png](images/session/wave3-final.png) | Wave-3 functional entity panel (kind/ID/area card, acceptance, runs) light+dark; final wave-3 state | ~1600×950 | both | branch `feat/kinetic-wave3`, pre-#540 | 08-29 10:29 / 11:27 | timeline-verified |
| [impression-home.png](images/session/impression-home.png) / [impression-panel.png](images/session/impression-panel.png) | Impression pass — Home and entity panel | ~1600×950 | light | branch `feat/kinetic-wave3`, pre-#546 | 08-29 12:23 | timeline-verified |
| [remainder-home.png](images/session/remainder-home.png) / [remainder-dark.png](images/session/remainder-dark.png) / [remainder-switcher.png](images/session/remainder-switcher.png) | Remainder verification — Home light/dark, switcher popover open | ~1440×900 | both | branch `feat/kinetic-wave3`, pre-#546 | 08-29 14:41 | timeline-verified |

### PR #545 pre-train captures (lane 01a04ddb) — `images/pr545-pre-train/`

Source: lane `01a04ddb` Firefox harness. Commit: local head `bf24218c6b1cf31ed72bcd1df12f7aad5ffbf3a1` (base `41c824b4`; PR #545 draft, remote intentionally stale). **Every image is labeled: pre-train / pre-rebase — final after-captures must be refreshed or SHA-qualified post-#550-rebase and final deployment** (the lane's own instruction). Viewport is in each filename.

| Image | Route | Viewport | Theme |
|---|---|---|---|
| [home-light-1492x900.png](images/pr545-pre-train/home-light-1492x900.png) | Home (redesigned) | 1492×900 | light |
| [home-dark-1492x900.png](images/pr545-pre-train/home-dark-1492x900.png) | Home | 1492×900 | dark |
| [home-expanded-1492x900.png](images/pr545-pre-train/home-expanded-1492x900.png) | Home, rail expanded | 1492×900 | light |
| [home-responsive-900x800.png](images/pr545-pre-train/home-responsive-900x800.png) | Home, responsive | 900×800 | light |
| [home-mobile-390x844.png](images/pr545-pre-train/home-mobile-390x844.png) | Home, mobile | 390×844 | light |
| [list-switcher-light-1280x800.png](images/pr545-pre-train/list-switcher-light-1280x800.png) | List switcher | 1280×800 | light |
| [list-switcher-dark-1280x800.png](images/pr545-pre-train/list-switcher-dark-1280x800.png) | List switcher | 1280×800 | dark |
| [list-switcher-forced-colors-900x700.png](images/pr545-pre-train/list-switcher-forced-colors-900x700.png) | List switcher, forced-colors | 900×700 | forced-colors |

### PR #550 final capture (lane 01a04dd8) — `images/pr550/`

| Image | Route / content | Viewport | Theme | Commit | Provenance |
|---|---|---|---|---|---|
| [task-detail-premium-final-light.png](images/pr550/task-detail-premium-final-light.png) | Task detail, premium Kinetic surface — composed header, labelled Controls row, honest "Saving is not wired here" caption, description with shared reading edge, default-visible acceptance with progress | desktop light | light | `7097052e` (PR #550 head, pre-merge) | lane `01a04dd8` Firefox harness; SHA256 `96be8548d48954564fa5010e88218c08b7f98bc579d6d622719cc37046484238` (verified against the lane's stated hash) |

**Environment limitation (both lanes and all waves, verbatim from the T3 manifest): Chrome absent at `/opt/google/chrome/chrome`; Chromium's V8 segfaults on this kernel — Firefox evidence is authoritative.**

---

## Coverage summary

Territories: 11. Status label incidence across the matrix (a territory may carry more than one label):

- **shipped**: 9 territories (Task detail (#540/#546 portion), Board/Astryx cards, Maestro/list rows (#543/#546 portion), Home/global nav (waves), Mobile, Graph, Craft, Settings, Help/Prompts (restyle), People/Channels) — 10 mentions counting both halves of split rows
- **pending (in train)**: 0 — the full train (#550 `10307c80`, #545 `ac1c7235`, #549 `322ae63e`, #544 `6423d07d`) merged and deployed at `6423d07d` (2026-08-29T17:44:53Z)
- **deferred**: 1 (#544 Help discovery)
- **unchanged**: server/data semantics, tm8-ui 1.0 snapshot (recorded in the deferred/unchanged section, not a matrix row)
- **unverified**: 0 whole territories, but 14 individual provenance rows carry an explicit **unverified** commit/deploy mapping (see tables above), and Settings + People/Channels carry sweep-asserted-not-screenshot-verified gaps.

## Remaining evidence gaps (phase 2)

1. After-captures for **every** territory from the verified final production head only (routes, 1600×950 + 390×844, both themes) — [AFTER-CAPTURE-PLAN.md](AFTER-CAPTURE-PLAN.md).
2. #550 evidence is **claimed-by-lane** until merged; re-capture from the final head (or rerun its checked-in harness at that head).
3. #545 pre-train captures must be refreshed or SHA-qualified post-#550-rebase and final deployment.
4. 14 provenance rows above are **unverified** (owner deploy-mapping ambiguity ×5, 08-28 session commit mapping ×6, wave1/probe/live-gate mapping ×3).
5. No mobile before-evidence exists (permanent, recorded).
6. Settings and People/Channels have no screenshot verification of the #546 sweep on either side.
