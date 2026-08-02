# Per-Kind Entity-Page Coverage Audit

**Ruling under audit (user, 2026-07-29):** for full-screen entity pages, **only custom kinds (`c:*`) may use the generic treatment. Every core kind gets its own designed UI.** A core kind rendering on generic is a **GAP**.

**Snapshot marker:** `git log -1 --format=%h` → `756a9b0`. The working tree is **dirty** and was audited as-is (`packages/tm8-ui/src/panels/bodies/{Subtree,Reader,Hub,Profile}Body.tsx` + `SessionAnatomy.tsx` are untracked in-flight worker output; `EntityDetailPanel.tsx` is modified). Method: read the canvas files directly; traced the code path `main.tsx → App → GateApp → EntityView → EntityDetailPanel → PanelBody`. Reachability is proven by call-graph, never inferred from a file name.

---

## 0. The headline, in one paragraph

The design suite draws **fourteen distinct per-kind detail bodies** (twelve in T0-4's "All 12 kinds — Content", two more in "Governed & fallback kinds") and **six distinct Z4 full-view layouts**. The build renders **exactly two bodies**: `TerminalBody` for `work_session`, and `GenericBody` for **everything else**. The switch is three lines long:

```ts
// packages/tm8-ui/src/panels/EntityDetailPanel.tsx:305-329
if (config.panel.archetype === 'terminal') { return <TerminalBody … /> }
return <GenericBody detail={detail} blocks={config.panel.blocks ?? DEFAULT_BLOCKS} … />
```

So **14 of the 15 core kinds land on the generic treatment today** — including the five whose registry rows already *declare* a dedicated archetype (`subtree`, `reader`, `hub`, `profile`). `GenericBody.tsx:13` states the intent plainly — *"lets nine core kinds plus EVERY custom kind share one body"* — and even that understates the live number, because the four archetype bodies that would rescue the other five **exist on disk but have zero importers**.

Against the user's ruling: **14 GAPs of 15 core kinds.** One kind (`work_session`) complies.

The fourteen are **not one population**. Five (task, doc, channel, member, team_member) already declare a dedicated archetype in the registry and have a finished body on disk — they are **one three-line switch edit** from closing (§2.1, D30). Nine declare `archetype: 'generic'` in the registry itself, so no amount of wiring reaches them; they need new archetypes, blocks or action verbs (§5). Ranking in §4 reflects that difference.

---

## 1. The denominator is contract-anchored

`CoreEntityKindSchema` — `packages/contract/src/schemas.ts:79-83` — enumerates exactly fifteen:

```
channel, task, message, member, team_member, doc, file, spell, skill,
pull_request, commit, work_session, collection, project, interaction_profile
```

**Verified independently of the source seat**, per standing rule. The two further facts supplied by the W5 API-surface seat both reproduce on this tree:

- **Five are excluded from `entities.create`** — `schemas.ts:866`: `CoreEntityKindSchema.exclude(['message','member','work_session','project','interaction_profile'])`. A create attempt fails at schema validation (400).
- **The same five are refused by `entities.patch`** — `packages/server/src/facade/services/w2/entities-commands-tracking.ts:49-55` defines `RESTRICTED_LIFECYCLE_KINDS` with those identical five members; `:751-755` `assertGenericLifecycle()` throws `forbidden` (403) *before* per-kind dispatch.

### Two populations, not one

| Population | Kinds | Why the verdict reasons differently |
|---|---|---|
| **A — uniform (10)** | channel, task, team_member, doc, file, spell, skill, pull_request, commit, collection | Full generic create/edit path through `entities.*`. A missing per-kind page is straightforwardly a missing page. |
| **B — lifecycle-owned (5)** | message, member, work_session, project, interaction_profile | **No** generic create/edit path. Their lifecycle lives elsewhere — `message` → `messages.post`, `member` → `spaces.create`/invite, `work_session` → `execution.spawn`, `project` → node-level registry projection, `interaction_profile` → draft→activate→retire. Their per-kind UI is **mostly read + lifecycle-verb surface**, and the canvases draw them that way. |

Treating all fifteen as one population would misclassify Population B: for those five, "no edit affordance" is **correct behaviour**, not a gap — and the canvases agree (T0-4 draws `project` and `interaction_profile` in a frame literally titled *"Governed & fallback kinds"*, with generic verbs **disabled-with-reason**). What is still a gap for them is the **read-side designed body**, which is substantial and specific in every case.

---

## 2. What the build actually does — traced, not inferred

### 2.1 The two-body renderer

`EntityDetailPanel.tsx:35-39` documents the state of play in its own header comment:

> *"A1 SCOPE: the `terminal` archetype is fully built […]; **the other five archetypes render the GENERIC body over their registry blocks**. The archetype-specific bodies (subtree, reader, hub, profile) are A2 fan-out."*

**This was ruled, not overlooked — and the ruling matters for how the gaps should be read.** `DECISIONS.md` **D30** (2026-07-28) rules exactly this: *"The other five (`subtree`, `reader`, `hub`, `profile`, `generic`) all render `GenericBody`; where a registry row declares no `blocks`, the panel falls back to a single `{block:'fields'}` so the entity's REAL scalar content shows rather than a placeholder. The archetype bodies slot into that one switch in A2 without touching the chrome."* Its rationale — *"an honest partial beats a 'coming soon'"* — is sound, and the fixed anatomy is what makes the substitution cheap.

So the five archetype-declaring kinds are, strictly, **DEFERRED-BY-RULING (D30) whose deferral has now come due**: A2 is in flight, the bodies are written, and only the switch edit is missing. They are still GAPs against the 2026-07-29 ruling — a core kind on generic is a gap regardless of why — but they are *one edit* from closing, not one design-and-build cycle. The nine registry-generic kinds in the table below are the harder population: for them D30 was never the blocker, because their registry rows say `archetype: 'generic'` outright, and closing those gaps needs new archetypes, new blocks, or new verbs.

### 2.2 The four archetype bodies exist and are unreachable

`SubtreeBody.tsx`, `ReaderBody.tsx`, `HubBody.tsx`, `ProfileBody.tsx`, `SessionAnatomy.tsx` — all present, all with tests and CSS, all untracked (in-flight). **Importers outside `src/panels/bodies/`: zero.**

```
$ grep -rn "SubtreeBody\|ReaderBody\|HubBody\|ProfileBody\|SessionAnatomy" src \
    --include="*.tsx" --include="*.ts" | grep -v "^src/panels/bodies/"
(no output)
```

This is the file-exists-vs-reachable distinction the brief demands be stated explicitly. **File exists ≠ implemented.** Each worker's own handover says so unprompted — `HANDOVER-SubtreeBody.md:98`: *"It is unreachable until you wire the switch"*; `HANDOVER-ProfileBody.md:227`: *"It cannot be reached until the registry rows and `livenessOf` are wired."* The **wiring edit in `EntityDetailPanel.PanelBody` is unclaimed work** — five workers each wrote "your wiring", and nobody's DoD covers it.

### 2.3 Z4 full view hosts the Z3 panel, not the six layouts

`EntityView.tsx:14-16`, verbatim:

> *"The six per-archetype Z4 layouts (subtree/reader/hub/profile/generic/terminal) are a **LATER PASS** — v1 hosts the Z3 panel's content in the Z4 shell, stated here so nobody reads the interim as the design."*

The Z4 shell itself is real and correct (collapse chip, breadcrumb, `esc` hint — `EntityView.tsx:119-134`). Its **body is the Z3 panel**, so every Z4 finding inherits §2.1 exactly.

### 2.4 Reachability of the entity page itself

Chain: `main.tsx:15 → App.tsx:8 → GateApp` → `MenuRail` sets `activeTarget` → `GateApp.tsx:187-197` routes `type:'kind'` to `<EntityView>`.

- **Rail kind rows — 7 kinds** (`domain/menu.ts:47-91`): task, work_session, doc, team_member (under Workspace), project, pull_request (Tracking), member (Collab).
- **Workspace side-panel `KindSelector` — 13 kinds** (`EntityListPanel.tsx:364` over `collectionKinds()`, `registry.ts:772`): every `strategy:'collection'` row. Reaches the Z3 panel but **not** the Z4 full-screen page.
- **channel and message are unreachable by either route.** `channel` is `strategy:'special'` and `message` is `'anchored'`, so both are excluded from `collectionKinds()`; and the menu's `{type:'view', ref:'channels'}` row (`menu.ts:88`) is **not handled** in `GateApp` — only `ref:'graph'` is special-cased (`:174`), so `channels` falls through to `WorkspaceView`. Clicking "Channels" shows the workspace.
- **Dead prop:** `EntityView` accepts `onKindChange` (`:43`) and `GateApp` passes it (`:196`), but `EntityView` **never renders a kind switcher** — the prop is referenced nowhere in the component body.

---

## 3. Per-kind table — canvas vs build

Legend — **Body**: what `PanelBody` renders *today*. **Reach**: R = rail row (full-screen page), K = KindSelector only (Z3 panel), ✗ = neither.

### Population A — uniform (10)

| # | Kind | Canvas designs (source + archetype) | Registry says | Body today | Reach | Verdict |
|---|---|---|---|---|---|---|
| 1 | **task** | T0-4 *All 12 kinds* task frame + **Z4 SUBTREE**: acceptance checklist `ACCEPTANCE · 1/3`, `SUBTREE · 2`, `RUNS · 1 LIVE`, assignee/priority/project/due, Run+Coordinate primaries | `subtree` (`registry.ts:302-303`) | **GenericBody** | R | **GAP** — body written (`SubtreeBody.tsx`), not wired |
| 2 | **doc** | T0-4 doc frame + **Z4 READER** + **T5-3 Doc Authoring**: TOC chips, prose measure, `v3` version pill, Add chapter/Edit, `4 chapters · markdown`, `history ▸`; Z4 "Edit swaps the column for the editor in place" | `reader` (`:397`) | **GenericBody** | R | **GAP** — `ReaderBody.tsx` not wired; edit mode absent entirely |
| 3 | **channel** | T0-4 channel frame + **Z4 HUB** + **T10 Chat Surface** (22 states): working/unread pills, Mark read, `Open hub ⤢`, `PINNED · 2`, HUB TABS Feed/Tasks/Docs/Files, `HERE NOW · 3` | `hub` (`:419`) | **GenericBody** | **✗** | **GAP (worst)** — `HubBody.tsx` not wired **and** no route reaches it |
| 4 | **team_member** | T0-4 teammate frame + **Z4 PROFILE** + **T5-6 Teammate authoring**: squared avatar, persona prose, Model/Tool/Owner/Memories, live "working on", `EQUIPPED · 2`, RECENT SESSIONS, Equip…/Launch session ▸ | `profile` (`:487`) | **GenericBody** | R | **GAP** — `ProfileBody.tsx` not wired |
| 5 | **file** | T0-4 file frame: `image preview · 1284×902`, NAME/TYPE/SIZE/UPLOADED, **`USED IN · 2`** backrefs, Copy link + `Download ↓`, `sha256 ✓`; explicitly *"honestly no status pill"* | `generic` + `file-preview`,`fields` (`:567-573`) | GenericBody | K | **GAP** — blocks render preview+fields; **USED IN backrefs, Copy link, sha verification absent** |
| 6 | **spell** | T0-4 spell frame: description prose, **TRIGGER `/review`**, SCOPE, VERSION, `EQUIPPED BY · 2` chips, `Equip ▸` primary, equipped/library state pill | `generic` + `fields`,`items` (`:593-599`) | GenericBody | K | **GAP** — fields+items approximate it; **`Equip ▸` verb has no `ActionRef`** (`domain/types.ts:248-278` has no equip verb) |
| 7 | **skill** | T0-4 skill frame: SOURCE path, `SIZE 4 KB · markdown`, designed **instructional empty state** (*"Not equipped by any agent yet — equip it from an agent profile"*), `Equip ▸` | `generic` + `fields`,`items` (`:619-625`) | GenericBody | K | **GAP** — generic empty is *"Nothing here yet."* (`GenericBody.tsx:213`), not the designed sentence; no equip verb |
| 8 | **pull_request** | T0-4 PR frame: locked title (tracked kind), branch line `tm8/guide-lines → main`, **`+214 −38` diffstat**, **CHECKS list** (✓build ✓lint ✗e2e — *"failing checks stay red and honest"*), LINKED, `⟳ Refresh` + `Open diff ↗` | `generic` + `link-summary`,`fields` (`:511-521`) | GenericBody | K | **GAP** — `link-summary` gives repo/number/url only (`GenericBody.tsx:138-160`); **diffstat and the CHECKS list have no block**; no `refresh` ActionRef |
| 9 | **commit** | T0-4 commit frame: short sha leads / **full sha wraps rather than truncates**, REPO/SHA/COMMITTED/MESSAGE, LINKED chips, `⟳ Refresh` | `generic` + `link-summary`,`fields` (`:541-547`) | GenericBody | K | **PARTIAL-GAP** — closest fit of any generic kind; `link-summary` truncates sha to 7 (`:142`) against the canvas's explicit wrap rule; no refresh verb |
| 10 | **collection** | **NOT DRAWN.** Zero occurrences of the kind in T0-4 or T0-3. Named once, in T5-5's create-pattern list: *"＋ New on ANY plain kind (task · doc · channel · collection · c:*)"* | `generic` + `items`,`fields` (`:645-651`) | GenericBody | K | **DESIGN GAP, not a build gap** — the build cannot implement a page the suite never drew. Needs a canvas before it needs code. |

### Population B — lifecycle-owned (5)

| # | Kind | Canvas designs | Registry says | Body today | Reach | Verdict |
|---|---|---|---|---|---|---|
| 11 | **work_session** | T0-4 session frame + **Z4 TERMINAL**: dark shell end-to-end, chrome strip, black-box canvas, Complete/Terminate, Z4 adds `ASSOCIATED PROJECTS` (immutable "launched from") + **`SHARED CONTEXT · 2` with delivery facets** (`delivered ✓ recorded` vs `delivery unknown ⚠ recorded`) | `terminal` (`:355-356`) | **TerminalBody** ✅ | R | **COMPLIANT** — the one kind with its own body. Z4 provenance strip still pending (`SessionAnatomy.tsx` written, unwired) |
| 12 | **member** | T0-4 member frame + **Z4 PROFILE**: round avatar (*"= human, always"*), role tag, **stat trio 112 tasks done / 412 points / 2 teammates**, TEAMMATES OWNED, CURRENT WORK, `@mention`; *"title not editable (identity is theirs)"* | `profile` (`:465-468`) | **GenericBody** | R | **GAP** — `ProfileBody.tsx` not wired. Non-editable title is correct and matches the 403 guard. |
| 13 | **message** | T0-4 message frame (canvas maps Z4→generic): **excerpt-as-title, never editable**, author + `agent` provenance tag, `edited` stamp, **`EMBEDDED · 1` live entity card**, `MENTIONS — ATTACHMENTS`, `Quote` primary, permalink footer | `generic` + `fields` (`:442`) | GenericBody | **✗** | **GAP** — fields-only; embedded entity cards, mentions/attachments, Quote all absent; **no route reaches a message** (`strategy:'anchored'`) |
| 14 | **project** | T0-4 *Governed & fallback*: `● trusted` pill, path + repo link, **`Untrust…` with the two-way consequence sentence**, `LIVE SESSIONS IN THIS ROOT · 2`, `Unlink from this space` + inline **`⚠ unlink blocked: 2 live sessions use this root`**, `Open terminal ▸` | `generic` + `fields`,`items`,`notice` (`:671-687`) | GenericBody | R | **GAP** — the `notice` block carries the honest refusal *text*; **trust as safety UI (trust pill, Untrust…, live-session blast radius, inline blocked-refusal) is entirely absent** |
| 15 | **interaction_profile** | T0-4 *Governed & fallback*: **draft→active→retired lifecycle with a sentence per state**, PREVIEW prose, VOICE/RISK/TOOLS, `DEFAULT FOR` chips, `Set as default ▸`, generic verbs disabled-with-reason, *"Pinned by 3 running sessions"* | `generic` + `lifecycle`,`fields` (`:710-725`) | GenericBody | K | **GAP** — `LifecycleBlock` renders only `templateKey · templateVersion · resolvedHash` (`GenericBody.tsx:227-236`); the **state machine, its per-state sentences and `Set as default` are absent**. `capabilityReasons` are authored and correct. |

### The one compliant row

`c:*` — `generic` + `fields` (`registry.ts:746-749`). Canvas: *"the generic floor every `c:*` kind lands on […] this is the floor, not a target."* **Correct by the ruling**, and the only kind for which generic is the design.

---

## 4. Gaps ranked by user-visible importance

1. **channel** — the *only* kind that is both unbodied **and** unroutable. Three canvases design it (T0-4 hub frame, Z4 HUB, all of T10's 22 states) and none of it is reachable; the menu's "Channels" row silently renders the workspace. Highest design-investment-to-zero-delivery ratio in the suite.
2. **task** — the most-used kind in the product. `SubtreeBody.tsx` is written and tested; the acceptance checklist, subtree and live-runs blocks are the daily surface, and today they are key/value rows.
3. **doc** — `ReaderBody.tsx` written; on top of the unwired body, **edit mode (T5-3 in full) has no implementation at all**. Docs are currently read-only key/value.
4. **team_member** + **member** — one unwired `ProfileBody.tsx` closes both. Stat trios, equipped kit, current work, owned teammates.
5. **project** — trust is *safety* UI. Untrust and the live-session blast-radius refusal are the difference between "agents can run real terminals in this root" being visible and being invisible. Absent.
6. **pull_request** — CHECKS list and diffstat are the entire reason to open a PR panel; neither has a block.
7. **interaction_profile** — the draft→active→retire machine governs what every launched session behaves like; currently three provenance strings.
8. **message** — unroutable; embedded entity cards are a distinctive designed idea with no build trace.
9. **file** — `USED IN` backrefs are the honest-provenance surface; preview + fields land, backrefs do not.
10. **spell** / **skill** — `Equip ▸` is not in the `ActionRef` union at all, so the verb cannot be dispatched from anywhere.
11. **commit** — closest generic fit; only the sha-truncation rule and refresh diverge.
12. **collection** — blocked on **design**, not build. Nothing to implement yet.

---

## 5. Two structural blockers worth naming separately

- **The wiring edit is unowned.** Five in-flight bodies each hand off a `PanelBody` switch edit to "you"; no worker's DoD includes it. Until one three-line edit lands in `EntityDetailPanel.tsx:305`, five finished bodies deliver zero user-visible change. This is the single highest-leverage line in the whole audit.
- **Missing verbs, not just missing bodies.** `Equip`, `Refresh`, `Untrust`, `Unlink`, `Set as default`, `Mark read`, `Quote` are drawn as kind primaries in T0-4 and **none exists in `ActionRef`** (`domain/types.ts:248-278`). Because the registry's `primaries` are typed to `ActionRef`, these cannot be added as data — they need vocabulary edits first. Wiring the bodies will not surface them.

---

## 6. Honest coverage statement

**What this method establishes.** Kind population and the create/patch restrictions are read from the contract and server source, verified on this tree rather than accepted from a report. Canvas claims come from parsing the `.dc.html` files and reading the extracted text — every "the canvas designs X" above is a string I read in the file, not a recollection of a canvas title. Build claims are traced along the call graph from `main.tsx`, and reachability is asserted only where I followed the chain to a render.

**What it cannot establish.** (1) **Pixel fidelity is out of scope** — a kind marked compliant (`work_session`) is compliant in *presence*; whether it matches the canvas visually belongs to the parity sweep. (2) **Nothing was rendered in a browser** — a live user session is running and the brief forbids driving it, so every verdict is static-analysis grade. A body that is wired but throws at runtime would read as IMPLEMENTED here. (3) **The tree is moving** — five workers are actively landing bodies against snapshot `756a9b0` + uncommitted changes; the unwired-bodies finding is the most likely to age, and it ages the moment someone lands the switch edit. (4) **Canvas completeness** — I read T0-4 and T0-3 in full for the per-kind question and spot-checked all 18 canvases for `collection`; a per-kind detail drawn *only* in a canvas I sampled rather than read in full could be missed. (5) The **`GateApp` view-ref fall-through** (`channels`/`dashboard`/`feed`/`inbox`/`settings` → `WorkspaceView`) is read from a conditional chain, not from clicking the rows.
