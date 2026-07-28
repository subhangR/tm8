# HANDOVER — SessionAnatomy (T0-4 session detail body)

**status-as-of:** `756a9b0` (HEAD) + working tree · worker `sess_1785273199588_6t5bml23f` · 2026-07-29 02:56 IST

> File location note: the brief (§4.7) says a new non-source artifact goes OUTSIDE `src/`.
> The quiet-protocol directive named this exact path, so the directive wins and the
> deviation is recorded here rather than silently taken. No guard reads `.md`
> (`hex-ban.test.ts` filters `.css`/`.ts`/`.tsx`; `no-branching.test.ts` the same), so
> nothing new scans this file.

---

## 1. Screen + oracle region

**Component:** `SessionAnatomy` — an ARCHETYPE body over an ordered block list, the same
shape as `GenericBody`. No kind literal anywhere in it; every block reads the detail
STRUCTURALLY ("does this content carry a `transcriptDoc`?").

Oracle regions implemented:

- `T0-4 Entity Detail Panels Hi-Fi.dc.html` : **1224–1234** — the Z4 TERMINAL frame's
  provenance strip (ASSOCIATED PROJECTS | SHARED CONTEXT, two columns).
- `T0-2 T0-5 Terminal & Live Session Hi-Fi.dc.html` : **225–231** — the exited canvas
  interior: the mono fact line and the brass transcript action.

Cross-read but deliberately NOT implemented: T0-4 : 800–921 (shared tabs), T0-4 : 188–230
(the stacked work_session panel), T0-2 : 109–199 (strip states).

### The scope finding to read first

The task listed *"Connections/Activity/Discussion tab content specific to sessions"*.
**The oracle draws no such thing.** T0-4's shared-tabs section is titled, in its own
markup, `DISCUSSION · CONNECTIONS · ACTIVITY — DESIGNED ONCE, SHARED BY EVERY KIND`, and
every frame in it is drawn on a **task**, not a session. The only session-flavoured
thread/linked rendering in either oracle is the 300px **Z4 rail** (T0-4 : 1249–1260) —
`THREAD · 3` with a composer and `LINKED · 2` *beside* the canvas, which is a Z4 LAYOUT
question (`panel.z4.immersive`), not a tab body.

Building session-specific tab bodies would have manufactured exactly the divergence the
oracle explicitly refuses, so I did not. Route the Z4 rail as a layout task if you want
it; I have not touched it. **This is ruling A1 below and it narrowed my own scope, so it
wants your explicit yes.**

---

## 2. The three blocks

| block | oracle | what it renders |
|---|---|---|
| `provenance-strip` | T0-4:1224–1234 | Two wrapping columns: **ASSOCIATED PROJECTS** (launch chip + the oracle's verbatim caption `launched from · immutable`; honest absence when null) \| **SHARED CONTEXT · N** (one compact line per share, BOTH facet pills, no controls). `sourceMissing` rows are dashed, non-navigable, and carry T4's bare amber word. |
| `exit-summary` | T0-2:228 | `exit code — · ran 41m · ended 2026-07-27`. Duration computed from `startedAt`/`exitedAt`. With no recorded end: `started <date> · duration not recorded · no end recorded` — the exit-code phrase is suppressed, because naming one implies an ending the record does not claim. |
| `transcript` | T0-2:228 | Brass **View transcript ↗**, driven by the RECORD: a real button when `content.transcriptDoc` exists AND the open handler is wired; disabled-with-reason when the handler is missing (R5 #9, structural); disabled-with-reason stating the record's own fact when there is no transcript doc. |

Words and tones for the facet pills come from `share/facets.ts`, so a facet still says one
thing in one home; only the geometry is new.

### The exit code is HOLLOW, deliberately

The contract's `work_session` **state** arm (`packages/contract/src/schemas.ts:208–216`) is
`status / agentTool / model / shareMode / startedAt / exitedAt`, `.strict()` — **no exit
code, on any node.** The oracle's literal `exit code 0` is therefore unrenderable honestly:
printing `0` would claim a measurement nobody took, which is the exact lie T1-4's dash
forbids. It renders as a dash carrying its reason through `HollowInline`.

*NOT CHECKED:* whether the SERVER holds an exit code it simply does not project. I read the
contract schema, not the server.

---

## 3. Divergences — RULED vs DRIFT

### RULED (cite the entry; no action)

- **R1 — D63.2.** The chrome strip and context line sit BELOW the canvas, inverting T0-2's
  top-stacked order and T0-4:188–230's stack. User-ruled today.
- **R2 — D63.1.** Two-row chrome. T0-4:199 draws a third 32px action row (`⊕ Link ·
  ⤓ Share context` left, Complete/Terminate right); retired by ruling, the bar rides inline.
- **R3 — D60.1.** 1.1× root zoom; every canvas-measured literal stays verbatim in source,
  which is why my CSS transcribes 11px / 10.5px / 9px as-is.
- **R4 — D5.** Micro type sizes verbatim. The Z4 frame draws its eyebrows at 9.5px while
  the stacked panel draws 10px; I use the kit `Eyebrow` (10px) because these blocks land in
  a STACKED panel, where 10px *is* the oracle value. Forking a kit component for half a
  pixel would buy a second home for the eyebrow. Flagged for ratification, not decided
  silently.

### DRIFT in the EXISTING terminal screen (all in files I do not own; none fixed by me)

- **D1 — the exit facts do not exist on screen.** `SessionFallback.tsx:19–26`
  (`ExitedFallback`) accepts `meta`, and its ONLY caller — `TerminalBody.tsx:310` — passes
  none. The oracle's `exit code 0 · ran 41m · ended 12m ago` has never rendered. My
  `exit-summary` block is the honest assembly of it.
- **D2 — the transcript button is ENABLED-INERT.** `EntityDetailPanel.tsx:306–318` renders
  `TerminalBody` **without** `onOpenTranscript` (the prop exists at `TerminalBody.tsx:69`
  and is threaded to both the fallback and the chrome strip). So on an exited session the
  brass **View transcript ↗** button and the strip's `transcript ↗` chip are live controls
  that silently do nothing when clicked — the five-dead-verbs class (R5 #9 / charter R7),
  **still live at HEAD.** Highest-value finding in this handover.
- **D3 — a FAILED session's canvas says "Session exited".** `TerminalBody.tsx:307–310` maps
  both `failed` and `exited` to `ExitedFallback`, whose title is the word *Session exited* —
  while the chrome strip two rows down correctly reads `failed` in block tone
  (`session-presentation.ts:117` gives `failed` its own word and tone). The strip and the
  interior disagree about the same session. The oracle's exited note also rules *"Non-zero
  exit codes render the code in block red"*, which is unbuildable today (see the hollow
  exit code above) — so the honest fix is a failed-specific **title**, not a red number.
- **D4 — the panel footer drops the session's own facts.** Oracle (T0-4:222, T0-2:233):
  `◉ 1 viewing · launched from ⬒ tm8-ui · pty alive` / `launched by @ada · exited 12m ago`.
  Built (`chrome.tsx:385–424`): `◉ — viewing · by <author> · v<n>`. The viewers hollow is
  D7.2-correct; the launch provenance and the liveness word are simply absent. My
  provenance strip carries the launch fact, so this may count as answered — your call.
- **D5 — `⤓ Share context` is not a verb in the action bar.** T0-4:199 draws it beside
  `⊕ Link`; the build has `link` (`chrome.tsx:249`) and no share verb — the capability lives
  instead as the `ShareDropTarget` in the reserved seam, disabled with the §10.7 deferred
  reason. Arguably ruled by §10.7, but no entry says so, so I report it rather than assume.
- **D6 — `content.workingOn` is rendered NOWHERE** in the package (grep: fixtures and the
  seam fixture write it; nothing reads it). I did NOT build a block for it: the only
  "working on" affordance either oracle draws is on the **teammate** panel (T0-4:479, the
  profile archetype), not on a session. Routed to the profile seat rather than invented here.

### Checked and clean

The chrome strip already swaps the exit chip to `transcript ↗` for a non-live session
(`TerminalChromeStrip.tsx:101–103`) — T0-2:154's rule, verbatim.

---

## 4. Files + diffstat (mine only, all NEW, none staged)

```
A  packages/tm8-ui/src/panels/bodies/SessionAnatomy.tsx        409 lines
A  packages/tm8-ui/src/panels/bodies/session-anatomy.css       141 lines
A  packages/tm8-ui/src/panels/bodies/SessionAnatomy.test.tsx   282 lines
A  packages/tm8-ui/src/panels/bodies/HANDOVER-SessionAnatomy.md (this file)
                                                               832 lines of code
```

I ran no `git add` and no `git commit`. I edited nothing else in the repo.

**Dirty in `packages/tm8-ui` that is NOT mine**, so it does not surprise you —
*modified:* `src/domain/menu.ts` + `menu.test.ts`, `src/fixtures/index.ts`, `src/main.tsx`,
`src/shell/menu-resolve.ts` + test, `src/terminal/index.ts`, `src/terminal/terminal.css`,
`src/views/GateApp.tsx`, `src/views/WorkspaceView.tsx`. *Untracked:* `src/graph/`,
`src/panels/bodies/{HubBody,ProfileBody,ReaderBody,SubtreeBody}.{tsx,test.tsx}` + their
css, `src/fixtures/graph.ts`, a set of `src/terminal/*` P-lane files, and 15
`scratch-p*.txt` files at the package root. **`registry.ts` is NOT dirty** — which is why
`ProfileBody.test.tsx` is red (see §6).

---

## 5. Red-first record

- **02:50:53** — test file written against an ABSENT module. Red at collect:
  `Error: Failed to resolve import "./SessionAnatomy" … Does the file exist?` →
  `Test Files 1 failed (1) / Tests: no tests`.
- A collect-level red proves nothing about the assertions, so I made a real one.
  **02:51:06** — `SessionAnatomy.tsx` written as a DELIBERATE STUB returning an empty
  `<div className="pn-body" />`:
  ```
  Tests  13 failed | 3 passed (16)
  AssertionError: expected [] to deeply equal [ 'block-exit-summary', 'block-provenance-strip' ]
  ```
  The 3 passes are honest, not vacuous, and I am not counting them as earned: two are the
  seam-gap assertions about the REAL fixture detail arm (facts about the data, not about my
  component), and one asserts nothing renders when the block list is empty — which a stub
  satisfies by accident.
- **02:55:01** — real body written → `Tests 16 passed (16)`.
- **02:56:28** — re-run after the brass-button change → `Tests 16 passed (16)`.

---

## 6. Wide check — timestamp · scope · instrument

| axis | value |
|---|---|
| WHEN | 2026-07-29 **02:56:29 IST** |
| WHERE | `/Users/subhang/Desktop/Projects/tm8/packages/tm8-ui` (**not** repo root) |
| INSTRUMENT | `bunx vitest`, banner `RUN v4.1.10 …/packages/tm8-ui` — verified |
| SCOPE | `bunx vitest run --exclude 'src/terminal/**'` |
| RESULT | `Test Files 1 failed \| 41 passed (42)` · `Tests 13 failed \| 792 passed (805)` |

The 13 failures are ALL in `src/panels/bodies/ProfileBody.test.tsx`, a sibling seat's file.
Cause, **checked not assumed**: their `ProfileBody.tsx:5` currently reads
`export const PROFILE_BLOCKS: readonly string[] = []` — a stub. They are in their own
red-first window, exactly where I was at 02:51. At 02:55:07 the same command also showed 2
failures in `SubtreeBody.test.tsx`; those cleared by 02:56:29 without anyone touching my
files. The tree is moving under both of us, which is why this block carries its timestamp.

- **Typecheck:** `bunx tsc --noEmit` from `packages/tm8-ui` — **exit 0, clean**, 02:56:30.
- **Guards:** `bunx vitest run src/hex-ban.test.ts src/panels/no-branching.test.ts` —
  2 files / 10 tests passed, 02:55:41. Both scan my new files (`hex-ban` walks `src/` and
  picks up `session-anatomy.css`; `no-branching` owns `panels/`).
- **Zero raw hex, zero new tokens:** the oracle's dark values for this strip are already
  tokens — `#2C2719`=`--pn-line`, `#3B3524`=`--pn-line-2`, `#665E4C`=`--pn-ink-4`,
  `#BDB5A2`=`--pn-ink-2`, `#8C8470`=`--pn-ink-3`, `#1B1810`=`--pn-surface`. **No
  `canvas-extra.css` entry is needed for this screen and I requested none.**

**READY FOR CAPTURE** — after you wire it. My DoD is code + tests + this handover; the
pixels close through you and the user.

---

## 7. Integration note

```tsx
import { SessionAnatomy, type SessionBlockRef } from './bodies/SessionAnatomy';
```

**Props I consume** (the `GenericBody` shape plus the one session input):

| prop | required | note |
|---|---|---|
| `detail: EntityDetail` | yes | same as `GenericBody` |
| `blocks: readonly SessionBlockRef[]` | yes | registry data, ordered |
| `handoffs?: readonly HandoffView[]` | no (defaults `[]`) | `TerminalBody` already receives this exact prop |
| `onOpenEntity?: (id: string) => void` | no | same as `GenericBody` |

**Props I deliberately do NOT consume:** `liveness`, `streaming`, `needsAttention`,
`attentionDetail`, `compact`, `livenessLabel`, `livenessReason`, `onOpenTranscript`, or any
`DetailReasons` string. Nothing here presents a liveness verdict (that is the strip's and
the pill's job), and the transcript reason is a fact about the RECORD, not a deferred
capability, so it has no business in `DetailReasons`.

### Registry wiring — yours, and there is a choice in it

I export `SessionBlockKind = 'provenance-strip' | 'exit-summary' | 'transcript'` and
`SessionBlockRef` from my file.

**Recommended (a): a SEPARATE field on `PanelConfig`.**

```ts
anatomy?: readonly SessionBlockRef[]
// work_session row:
panel: { archetype: 'terminal', /* … */,
         anatomy: [{ block: 'provenance-strip' },
                   { block: 'exit-summary' },
                   { block: 'transcript' }] }
```

**Not recommended (b): widening `ContentBlockKind` and reusing `panel.blocks`.**
`GenericBody`'s switch defaults to `null`, so any generic kind that declared
`'exit-summary'` would render NOTHING and no test would fail — a silent hole. Two
vocabularies, two fields.

### Placement

D63/D64 keep the canvas first and I am not proposing otherwise. These blocks belong BELOW
the canvas, in or beside the context-line region. `TerminalBody.tsx` is frozen, so where
exactly they mount is your ruling; both candidate homes (inside `TerminalBody`'s
post-canvas stack, or in `EntityDetailPanel`'s content path after `<TerminalBody/>`) are
files I do not own.

### The one collision you must rule

`ExitedFallback` already draws its own **View transcript ↗** button
(`SessionFallback.tsx:33–35`). If you wire my `transcript` block into a panel that also
shows that fallback, the user sees **two** transcript buttons — and per **D2**, the
fallback's is the DEAD one. Wire one, not both. My preference, stated as a preference: keep
mine (record-driven, and it refuses to render an enabled-inert control) and have Track P
drop the fallback's — *or* pass `onOpenTranscript` so the fallback's button becomes real.
Either is fine; shipping both is not.

I also did **not** restate the fallback's *"Read-only — the session record, discussion and
connections stay. Re-run from its task."* caption, and there is a test pinning that I never
will. It has one home in `SessionFallback.tsx`, and this would have been the third instance
of the duplication `UnverifiedFallback`'s own docblock records.

---

## 8. Fixture needs (I edited no fixture — these are requests)

- **F1 — an EXITED `work_session` DETAIL arm.** `fixtureDetails` has exactly ONE session
  detail (`sessionStale.id`, `entities.ts:652–668`). `sessionExited` and `sessionFailed` are
  SUMMARIES only, so the `exit-summary` block cannot be seen on `:4612` in its ended form at
  all today — only in its "no end recorded" form. Needs
  `content { kind:'work_session', nodeId, launchProjectId, workingOn, transcriptDoc }` and a
  state with `exitedAt` set.
- **F2 — a FAILED `work_session` detail arm**, same shape, for D3's interior.
- **F3 — a session whose `transcriptDoc` is NOT null.** Every session in the fixture set has
  `transcriptDoc: null` (`entities.ts:658`, `seam-fixture.ts:140/864`), so the `transcript`
  block can only ever render its disabled form live. A doc summary is enough — the block
  needs only `id` + `title`.
- **F4 — nothing needed for shares.** `fixtureHandoffsBySession` already binds handoffs to
  `sessionStale.id`, so the strip's share column has real rows the moment you pass
  `handoffs` through.

---

## 9. Rulings I made alone (ratify or reverse)

- **A1** — No session-specific Discussion/Connections/Activity bodies were built, on the
  evidence in §1. Biggest single judgement here, and it narrowed my own scope.
- **A2** — No clock in the render path: the oracle's "ended 12m ago" renders as
  `ended <YYYY-MM-DD>` with the full ISO on `title`. A relative word needs `Date.now()`,
  which makes every render time-dependent — the same reason `detail/tabs.tsx` renders a
  plain date. The DURATION is not a clock read (difference of two recorded timestamps), so
  that one is exact and computed.
- **A3** — The compact share row is a SECOND rendering of a handoff beside
  `SharedContextSection`'s full one. Justified because the oracle draws both forms and the
  words/tones stay in `facets.ts`; flagged because two renderings of one fact is exactly the
  shape that drifts.
- **A4** — kit `Eyebrow` (10px) rather than a forked 9.5px Z4 variant (see R4).
- **A5** — The transcript block's disabled reason is authored in my file rather than threaded
  through `DetailReasons`, because it states the RECORD's fact, not a deferred capability.
  If you disagree, it is a two-line change.

---

## 10. NOT CHECKED — said plainly

- **N1** — I have NOT seen this render in a browser. Nothing of mine is wired into any
  route, so `:4612` shows none of it. Both themes unverified by eye; the tokens make dark
  free *in principle*, and jsdom can see neither.
- **N2** — I did not measure the strip at a narrow panel. The share column's 260px floor and
  the wrap are transcribed from the oracle, not tested at the 320px floor — and jsdom cannot
  test it.
- **N3** — I did not verify whether the SERVER carries an exit code the contract does not
  project. I read `packages/contract/src/schemas.ts` only.
- **N4** — I did not run the excluded `src/terminal/**` suites at all, per the wide-check
  scope set in the brief.
- **N5** — I did not read T5-5/T5-6 or T5-7. T5-7 is a Discussion-tab canvas and my §1
  finding means I built no discussion body; if you think T5-7 changes that finding, say so
  and I will read it.
- **N6** — The 792-passed figure is a fact about the tree at 02:56:29 with two sibling seats
  writing into it live. It will not reconcile with anyone else's count taken at another
  minute, and that is the tree moving, not a disagreement.
