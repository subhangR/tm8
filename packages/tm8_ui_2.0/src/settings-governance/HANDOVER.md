# HANDOVER — T2 half B: projects & trust, interaction profiles, custom kinds

**status-as-of:** `6dce6da` (HEAD at session start; my files are uncommitted `??`) ·
worker `sess_1785277832199_6a8t88x9d` · task `task_1785277831166_p7m4gdrqv` · written 2026-07-29

Code + tests done, lane suites green, package typecheck clean, **not looked at in a browser** (§8).
Nothing is wired: all 13 files are new and unimported. I edited **no existing file anywhere**, ran no
`git add` / `git commit`.

---

## 1. Frames built, and the oracle regions they implement

Oracle: `T0-1 workspace structure review (1)/T2 Settings, Trust & Authoring Hi-Fi.dc.html` (80,032
bytes). The five-frame enumeration was reported as the first deliverable; repeated here only as the
ownership split.

| frame | `data-screen-label` | oracle lines | owner |
|---|---|---|---|
| T2-1 | Space settings | 21–140 | half A (`settings-space/`) |
| **T2-2** | **Projects & trust** | **143–272** | **mine** |
| T2-3 | Menu editor | 275–390 | half A |
| **T2-4** | **Interaction profiles** | **392–493** | **mine** |
| **T2-5** | **Custom-kind authoring** | **496–618** | **mine** |

Region-by-region, in the oracle's own order:

| region | oracle | built as |
|---|---|---|
| Linked projects (SPACE side) | 150–187 | `ProjectsTrustScreen` › `LinkedProjectsCard` |
| Project registry (NODE side) | 188–229 | `ProjectsTrustScreen` › `ProjectRegistryCard` |
| The consent moment | 230–244 | **`UntrustedConsentCard`** (separately exported — §6) |
| Session projects: chips vs ⚿ | 245–261 | **`SessionProjectsCard`** (separately exported) |
| Profile list, lifecycle groups | 398–427 | `InteractionProfilesScreen` › list column |
| Profile Z3 detail | 428–474 | **NOT BUILT — already exists.** §3.1 |
| Session pinned provenance | 476–483 | **NOT BUILT — already exists.** §3.1 |
| New-kind authoring form | 502–561 | `CustomKindsScreen` › `NewKindCard` |
| "What you get" generic render | 563–590 | `CustomKindsScreen` › `WhatYouGetCard` |
| Unknown-kind fallback | 591–609 | `CustomKindsScreen` › `ExistingKindsCard` footer |

## 2. Files — ALL NEW, nothing else touched

| file | lines |
|---|---|
| `src/settings-governance/ProjectsTrustScreen.tsx` | 570 |
| `src/settings-governance/CustomKindsScreen.tsx` | 535 |
| `src/settings-governance/InteractionProfilesScreen.tsx` | 304 |
| `src/settings-governance/governance.css` | 815 |
| `src/settings-governance/governance-model.ts` | 496 |
| `src/settings-governance/governance.test.tsx` | 494 |
| `src/settings-governance/governance-model.test.ts` | 290 |
| `src/settings-governance/reasons.ts` | 198 |
| `src/settings-governance/parts.tsx` | 178 |
| `src/settings-governance/port.ts` | 104 |
| `src/settings-governance/port-seam.test.ts` | 103 |
| `src/settings-governance/no-kind-literals.test.ts` | 91 |
| `src/settings-governance/index.ts` | 83 |

**13 files, 4,261 insertions(+), 0 deletions(-)** (this handover makes 14).
`git status --porcelain src/settings-governance/` shows the directory as a single `??`.

**Tree dirt that is NOT mine, named rather than assumed known:** `src/panels/EntityDetailPanel.tsx`
and `src/panels/detail/chrome.tsx` are `M`, and `src/panels/detail/save-wiring.test.tsx` is a new `??`
that appeared **at 18:10 local, mid-way through my session** — a sibling lane landing a save path.
That file is the only red in the tree (§5). Also `src/settings-space/` (half A) landed while I worked.

## 3. Divergences — RULED vs DRIFT

### 3.1 A RULING I MADE ALONE — T2-4's middle and right columns are NOT built, because they already exist

The frame draws three columns. The Z3 detail panel (428–474) and the session pinned-provenance card
(476–483) are **already implemented** by `panels/bodies/RestrictedBody.tsx` — its own handover names
the oracle region it built (T0-4 714–762: `status-banner / preview / field-rows / items (DEFAULT FOR) /
pin-provenance`), inside `EntityDetailPanel`'s chrome, which owns the action bar and tab strip.

Building them again here would be **D64's defect exactly** — two renderings of one fact, which is what
the live-session bar was unmounted for. So this screen builds the column that exists nowhere (the
lifecycle-grouped list + the space-level governance verbs) and **opens** the existing panel via
`onOpenProfile`. Reverse it by deleting `LifecycleGovernanceCard` if you'd rather the panel carry the
verbs; nothing else depends on it.

### 3.2 DRIFT, found by a failing test — the LIST order is not the RAIL order

The oracle's list is `ACTIVE · 2`, `DRAFT · 1`, `RETIRED · 1` (L406/415/419); its lifecycle rail is
`draft → active → retired` (L456). My first implementation used one order for both — the tidier idea —
and the screen led with drafts. Now `PROFILE_LIST_ORDER` and `PROFILE_LIFECYCLE` are separate
constants, both asserted. **Found by the red, not by reading the oracle again.**

### 3.3 DRIFT — the oracle's trust badges have no data source

Oracle L161/170/179 draw `✓ trusted` / `⚠ untrusted` per row. **Measured:** the space-side projection's
state is `{ projectId, materializedVersion }` (contract.ts:107); `trust` lives on `ProjectResource`
(contract.ts:948–961) and **the stamped seam has no read for it** (I read `src/data/seam.ts` in full).
Built: `trust` is a `Known<ProjectTrustLevel>` that is `known:false` until a host supplies it, and the
chip renders **"trust unread"** — never either verdict. Same for `workingDir`.

This is the lane's safety property, and it is asserted twice (a render test + mutation probe E): **an
unverified root must never appear trusted.** Consistent with `GovernedBody`'s handover §3.2, which
reached the same answer independently for the panel.

### 3.4 DRIFT — "2 live sessions still use this root" cannot be counted here

Oracle L174. **Measured:** a work_session summary carries `{status, agentTool, model, shareMode,
startedAt, exitedAt}` (contract.ts:103–105) and **no project**; the launch root is
`EntityDetail.content.launchProjectId` (one read per session) and associations are `in_project` edges.
Built: `usage` is `Known<{recorded, live}>`; absent ⇒ the unlink refusal says *"How many sessions use
this root is unverified"* and **never falls through to the verb's deferral**, because those send the
user to different remedies. Supplied ⇒ the oracle's exact blocker, with the number and the
`view sessions` link.

### 3.5 DRIFT — the node registry has no read at all, so the card states the unasked question

Oracle 188–229 draws rows and an edit form. There is no `projects.*` family in the seam. Built: the
card keeps its shape (the reader learns what a project record consists of) with an `UnreadRegion`
where the rows would be. **It deliberately does not render an empty list** — an empty list asserts a
measurement ("this node has no projects") that nobody took.

### 3.6 A RULING I MADE ALONE — the glyph picker tells the truth about what the registry paints

`getKind()` resolves every `c:*` kind to the fallback row, whose glyph is `◇` (registry.ts:740). The
authored glyph is stored on `EntityKindDef.icon`, and **no consumer in this package reads that member
today.** So `WhatYouGetCard` shows both: the glyph you picked, and — when they differ — that the app
would paint `◇` and why. Showing only the authored glyph would promise a result this build does not
produce. Asserted (`tells the truth about the glyph…`).

### 3.7 A RULING I MADE ALONE — no sample data in the T2-5 preview

The oracle's preview carries real-looking values (`INC-7 checkout latency`, `sev1`, `payments`,
`06:41`). Those are canvas specimens; rendering them in the app would read as data. Built: the preview
shows the **shape** — field names and the treatment each type gets — with hollow values and a sentence
saying nothing on the card is sample data. Fabricated values are the same lie as a fabricated count.

### 3.8 A RULING I MADE ALONE — two field types the oracle does not name

Oracle L587 names three treatments: "enum → word-chip, text → value, datetime → mono". The contract has
five types. Authored: `number` follows `text` (a value); `bool` follows `enum` (a word-chip — a bool IS
a two-member enum, and bare `true` would be the only place in this UI where a state reads as a
programming literal); `date` is the oracle's "datetime". One function, `fieldTreatment`, asserted per
type.

### 3.9 A RULING I MADE ALONE — the ⠿ handle is a keyboard control, not a grab cursor

The oracle draws `cursor:grab` (L536). Pointer drag is not built, so the handle is a focusable button
that reorders with ↑/↓ and says so in its `aria-label`. **A grab cursor over something that cannot be
grabbed is the enabled-inert lie in cursor form.** Asserted by driving the reorder.

### 3.10 A RULING I MADE ALONE — `scope: 'teammate'`, not the contract's `'team_member'`

Found by my own lane guard on its first run (§4). `team_member` is also an entity kind, so the literal
made `no-kind-literals.test.ts` red. Renaming beat exempting on the merits too: `Teammate` is the
registry's own label for that kind (registry.ts:474) and the word the oracle puts on screen. The
mapping to `TeammateProfileDefaultView` belongs in whatever adapter eventually reads it.

### 3.11 RULED (D15) — a second reasons file, and why it is not a second vocabulary

`domain/actions.ts` owns the copy for verbs that are `ActionRef`s. Of the ~20 verbs these three frames
draw, exactly **two** are (`untrust`, `unlink`) — and those are **read from the registry**, never
restated, so they change on the day the verbs land. The other 16 exist in the oracle and in no
registry, and this lane may not edit `domain/actions.ts`; they are authored in `reasons.ts` in the same
shape. **§7.3 lists them as `actions.ts` candidates for whoever holds that seat.**

### 3.12 RULED — the registry's profile tones are duplicated, and flagged rather than hidden

`registry.ts:700-704` already rules `draft: idle, active: run, retired: idle`. Reading them out of the
row requires naming the kind, which §15.2 forbids here, so `InteractionProfilesScreen` carries a local
`LIFECYCLE_TONE` map. **If the registry's tones change, that map must follow.** The clean fix is the
one `RestrictedBody`'s handover §3.10 also proposes: export the lookup from a place that owns kind
names. Not taken alone.

## 4. Red first, then green — with instruments

All runs `cd packages/tm8-ui && bunx vitest`, banner `RUN v4.1.10 …/packages/tm8-ui`. Times are the
instrument's own `date -u` (the machine clock stamps `2026-07-29 12:xx UTC`; the session date is
2026-07-29).

| when (UTC) | what | result |
|---|---|---|
| `12:31:28Z` | `governance-model.test.ts`, first run | **GREEN 32/32** — a green that was never red, so ↓ |
| `12:31:47Z` | **probe A**: unread trust defaults to `trusted` | **RED, exactly 1** — "renders trust and usage UNKNOWN…" · 31 passed |
| `12:31:57Z` | **probe B**: unlink drops the unread-usage precedence | **RED, exactly 1** — "refuses on UNVERIFIED usage before…" |
| `12:32:0xZ` | **probe C**: run counts become `known(0)` | **RED, exactly 1** — "leaves run counts hollow…" |
| `12:32:1xZ` | **probe D**: reserved-slug check removed | **RED, exactly 2** — the reserved-word test + the payload test |
| `12:35:16Z` | `governance.test.tsx`, first run | **RED — 7 failed / 22 passed (29)** · two real findings, §4.1 |
| `12:36:46Z` | after both fixes | **GREEN — 67 passed (3 files)** |
| `12:37:19Z` | `no-kind-literals.test.ts`, first run | **RED, 1** — `governance-model.ts → 'team_member'` (§3.10) |
| `12:38:12Z` | after the rename | **GREEN — 80 passed (6 files)** |
| `12:38:5xZ` | **probe E**: trust chip paints a verdict when unread | **RED, exactly 1** — "NEVER paints an unread trust level as a verdict" |
| `12:39:0xZ` | **probe F**: consent confirm with NO tick | **RED, exactly 1** — "the tick IS the consent" |
| `12:41:25Z` | lane + hex ban + no-branching + token twin | **GREEN — 7 files, 82 tests** |

Every probe file was restored from a pre-mutation copy and verified byte-identical with `diff -q`
(`RESTORED` in each transcript line).

### 4.1 What the render-test red actually taught — the transferable part

1. **`CSS.escape` is undefined in this runner's jsdom.** Three tests died on
   `Cannot read properties of undefined (reading 'escape')`. The helper now uses an `[id="…"]`
   attribute selector, which also survives React `useId` values containing `:`. Documented in the
   test, beside the code, because the next person will reach for `CSS.escape` too. *(Sibling hazard
   to the `localStorage` one `vite.config.ts` documents at length — this runner's jsdom is not a full
   jsdom.)*
2. **The profile group order was wrong** (§3.2) — the assertion caught a drift that reading the oracle
   had not.
3. **`＋ associate` is correctly absent with no session selected.** My assertion demanded the full
   drawn vocabulary in every state; the card collapses (design law 9) when there is no session, and an
   affordance with no subject would be worse. The completeness bar applies to the **drawn** state, so
   the test now renders the oracle's specimen. *The screen was right and the test was wrong* — said
   out loud because the opposite conclusion was equally available and would have made the screen worse.

## 5. Wide check — timestamp · scope · instrument

**THE RUN OF RECORD:**

```
2026-07-29T12:41:03Z | cwd packages/tm8-ui | bunx vitest run --exclude 'src/terminal/**'
banner: RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui
RESULT: Test Files 1 failed | 63 passed (64) · Tests 2 failed | 1182 passed (1184)
THE FAILURE IS NOT MINE: all of it in src/panels/detail/save-wiring.test.tsx
```

```
2026-07-29T12:39:16Z | cwd packages/tm8-ui | bunx tsc --noEmit → CLEAN (zero output, exit 0)
2026-07-29T12:41:25Z | cwd packages/tm8-ui | my 4 suites + hex-ban + no-branching + tokens-verbatim
        → Test Files 7 passed · Tests 82 passed
```

**A MOVING TREE, recorded rather than smoothed.** `12:38:29Z`: **63 files / 1177 tests, all green.**
`12:39:16Z`: **64 files, 6 failed.** `12:41:03Z`: **64 files, 2 failed.** Same command, three
different answers in three minutes. The delta is `src/panels/detail/save-wiring.test.tsx` (mtime
18:10 local — written *during* my session) plus `M` on `EntityDetailPanel.tsx` and
`detail/chrome.tsx`: **a sibling lane landing a save path while I ran.** I did not investigate beyond
identifying it. My own files were byte-stable across all three runs and my lane was green in each.

## 6. GAPS — what the seam cannot do, and what is rendered instead

Machine-readable twin: `GOVERNANCE_GAPS` in `reasons.ts` (asserted, so the table cannot rot away from
the screens). Each flips to live by deleting its row and passing a real handler — **no consumer edit.**

| # | need | seam today | rendered as |
|---|---|---|---|
| GG1 | link a project to a space | no `projects.*` family; `ProjectLinkInput` is contract-only | ⊕ Link project — refused |
| GG2 | unlink a project | `unlink` ActionRef, `deferred()` (actions.ts:282) | refused, **ranked** per §3.4 |
| GG3 | read the node registry | `ProjectResource` contract-only, no read | `UnreadRegion`, not an empty list |
| GG4 | create a node project | `ProjectCreateInput` declared, no command | ＋ New project — refused |
| GG5 | edit a node project | `ProjectUpdateInput` declared, no command | edit form + Save — refused |
| GG6 | **GRANT trust** | **no `trust` ActionRef exists at all** | refused; §7.3 flags it |
| GG7 | revoke trust | `untrust`, `deferred()` (actions.ts:281) | refused with the registry's copy |
| GG8 | associate a project with a session | associations are edges, no command | ＋ associate / chip ✕ — refused |
| GG9 | count sessions per project | summaries carry no project | usage hollow; refusal says so |
| GG10 | propose a profile | contract input declared, no command | ＋ New — refused |
| GG11 | duplicate as draft | no command | refused |
| GG12 | retire a profile | no command | refused |
| GG13 | set a profile default | default views contract-only | badges hollow; Set default refused |
| GG14 | read a profile's prompt | contract preview is *sanitized of prompt policy* (contract.ts:1452) | stated absence |
| GG15 | count runs / pins | pins are per session; nothing totals them | hollow — never `0` |
| GG16 | create a custom kind | `entityKinds()` reads; no write | Create kind refused; **payload shown** |

**Nothing here is an escalation** — R7 says the answer is disabled-with-reason. The one thing worth a
seam conversation is **GG6**: `untrust` exists as a deferred verb and `trust` has no ActionRef at all,
so the registry can express revoking trust and cannot express granting it. That asymmetry is in
`domain/actions.ts`, not my lane.

### 6.1 The exception: one control that genuinely works today

`UntrustedConsentCard` is wireable **now**. `confirmUntrusted?: true` is a real member of
`ExecutionSpawnInput` (contract.ts:1046 — *"explicit consent carrier for untrusted Projects and scratch
roots"*), so the card collects the decision and hands it to whoever owns the spawn. It is exported
separately for exactly that reason. See §7.2.

## 7. INTEGRATION NOTE — exact props, exact mount points

Nothing below is done. All of it is yours.

### 7.1 The port, then the three screens

```ts
import { governancePortFromSeam } from './settings-governance';
const port = governancePortFromSeam(seam, spaceId);   // reads only; four members
```

`port` has exactly `linkedProjects()`, `profiles()`, `entityKinds()`, `statusOf` — asserted, so no
future component can quietly acquire a write. Feed each screen a `LoadState<T>`
(`{phase:'loading'} | {phase:'ready', value} | {phase:'failed', message}`); all three states render
distinctly and are tested.

```tsx
<ProjectsTrustScreen
  spaceLabel={`space · ${space.name}`}
  projects={projectsLoadState}
  factsFor={undefined}          // no seam read exists (GG3) — omit and every fact renders hollow
  sessionProjects={undefined}   // omit unless a session is selected; card collapses honestly
  consent={pendingUntrustedRun ?? null}
  onConsentDecision={handleDecision}
  onOpenSessions={(projectEntityId) => openEntity(projectEntityId)}
/>

<InteractionProfilesScreen
  spaceLabel={`space · ${space.name}`}
  profiles={profilesLoadState}
  defaultsFor={undefined}       // GG13 — omit; badges render "defaults unread", never "not a default"
  onOpenProfile={(id) => openDetailPanel(id)}   // ← routes to the EXISTING RestrictedBody panel
  selectedProfileId={openPanelId}
/>

<CustomKindsScreen spaceLabel={`space · ${space.name}`} kinds={kindsLoadState} />
```

**Where they mount.** These are section BODIES, not screens with their own chrome. Half A's
`settings-space/SettingsShell.tsx` owns the T2-1 section nav, whose rows include **Linked projects**,
**Custom kinds** and (per the oracle's own nav, L21–140) the rest. The intended composition:

| nav row | body |
|---|---|
| Linked projects | `<ProjectsTrustScreen …/>` |
| Custom kinds | `<CustomKindsScreen …/>` |
| Interaction profiles *(not in the oracle's T2-1 nav — see below)* | `<InteractionProfilesScreen …/>` |

**A question only you can settle:** the T2-1 section nav does **not** list interaction profiles, and
T2-4 is drawn as its own frame with a list + detail. Two readings — a settings section, or a rail kind
row opening the D65 entity view (`interaction-profiles` IS a registry slug, so the route exists). I did
not choose; the screen works in either host, and `onOpenProfile` is how it hands off to the panel.

### 7.2 Wiring the consent card into the launch flow (the one live control)

`views/LaunchSheet.tsx` already renders untrusted projects disabled-with-reason under D28/L6, so today
an untrusted root is a dead end. The card is the missing second half:

```tsx
<UntrustedConsentCard
  request={{ actorLabel: teammate.title, projectLabel: project.title, projectId: project.projectId }}
  onDecision={(d) => {
    if (!d.consented) return closeConsent();
    return seam.commands.spawn({ ...spawnInput, projectId: d.projectId, confirmUntrusted: true });
  }}
/>
```

`d.confirmUntrusted` is `true` only after the checkbox — that is asserted, and probe F proved the
assertion bites. **Whether an untrusted root should become reachable at all is a policy call, not
mine**; D28 currently says no, and this card is what a reversal would need.

### 7.3 D-entry texts I am authoring (yours to ratify or reverse)

- **`untrust` has no twin.** `domain/actions.ts` carries `untrust` (deferred) and **no `trust`**. A
  surface that can revoke and cannot grant is asymmetric in the one direction that matters for safety.
  Proposed: add `trust` as a `deferred()` ActionRef so both halves live in the registry.
- **Sixteen drawn verbs are not `ActionRef`s.** Link project, New project, Save project, associate,
  New profile, Duplicate as draft, Retire, Set default, Create kind, and the rest. They live in
  `settings-governance/reasons.ts` today. Proposed: promote them to `domain/actions.ts` when that seat
  is open, and delete this file's local half.
- **The T2-4 detail is `RestrictedBody`, and T2-4's list is the only new column** (§3.1) — worth a
  ledger line so nobody rebuilds the panel next session.
- **The authored kind glyph is stored and unread** (§3.6). Either a consumer starts reading
  `EntityKindDef.icon`, or the picker should say so permanently. It says so today.

## 8. COLOR NEEDS — for the parity session that owns fidelity

`governance.css` uses **tokens only** (the hex ban scans it; no exclusion, deliberately). Four oracle
values have no token and could not be added, because a new measured colour's only legal home is
`styles/canvas-extra.css` — an **existing file this lane may not edit**. Each is named here with what
was used instead:

| oracle value | oracle line | where | shipped instead |
|---|---|---|---|
| `#221E15` node-admin card fill | 189, 476, 564 | dark governance cards | `--pn-card` on `.gov-card--node` → `--pn-surface` |
| `#3B3524` node-admin card border | 189 | same | `--pn-line-2` |
| `#1D1912` frame stage | 148, 397, 501 | the canvas board behind the cards | **not built** — that is the app's own paper (see canvas-extra.css's own note on `#1D1912`) |
| `rgba(189,138,42,.1)` consent banner fill | 234 | `.gov-consent__banner` | `color-mix(in srgb, var(--pn-wait) 10%, var(--pn-card))` |

All four are correct in both themes and one step off the oracle's specimen. **Not pixel parity — that
is explicitly a later session's job under this wave's bar.**

## 9. NOT CHECKED — plainly

1. **I have not looked at any of these three screens in a browser.** Not in either theme, not at
   `:4612`, not once. The brief's §4.4 is unambiguous that this is where every defect that reached HEAD
   was found — and every one of my findings above came from a test or from reading the contract, which
   is exactly the evidence class §4.4 says is insufficient. **I could not:** the screens have no mount,
   and mounting them means editing `App.tsx` or `GateApp.tsx`, which this wave's file-ownership rule
   forbids me. So: **layout is unverified.** jsdom cannot see a wrapped card, a clipped 815-line
   stylesheet's overflow, a three-column flex that stacks wrongly at the real width, or a dark-theme
   region I mis-tokenized. Expect layout defects on first render and treat §8's table as untested too.
2. **No fixture entities were added, and the shared fixture is thin.** Measured through the port
   (`createFixtureSeam()`, 2026-07-29): **1 space, 1 project, 1 profile, 1 custom kind.** My
   `port-seam.test.ts` loops therefore ran exactly once each — non-vacuous, but empty states,
   multi-row states and the lifecycle groups are exercised only by local specimens inside
   `governance.test.tsx`. **On the real node these screens may render mostly empty**, and that is a
   fixture/data gap, not a code one. I did not extend `src/fixtures/` (allowed by the detail brief §1,
   but this wave's directive confines me to my own directory).
3. **`statusOf` is exposed by the port and no screen consumes it yet.** It is there because the unlink
   refusal will need it the moment a per-project session read exists (GG9). Today nothing calls it
   except its own test — a deliberately-unused member, said out loud rather than left to be found.
4. **Accessibility is followed, not audited.** I copied `DisabledWithReason`'s pattern (focusable
   `aria-disabled` + `aria-describedby`, reason always in the DOM) and gave every icon control a
   label, but I ran no AT and no axe pass.
5. **The `interaction_profile` status pill tones are duplicated** (§3.12) and will silently drift if
   the registry's change. No control catches that.
6. **I did not verify half A's shell composition.** §7.1's mount table is read from
   `settings-space/`'s file names and the oracle's nav, not from reading their component's props.
7. **The wide-check red is attributed, not diagnosed.** I established `save-wiring.test.tsx` is a
   sibling's file written during my session and that my lane is green; I did not read it.

**Ready for capture** (with §9.1's caveat: nothing here has been seen by human eyes, so the first
capture is likely to find layout work).
