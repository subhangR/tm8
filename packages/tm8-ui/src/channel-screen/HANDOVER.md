# HANDOVER — `src/channel-screen/` (T10 Chat Surface, channel destination)

**status-as-of:** `6dce6da` (HEAD at spawn; my files are untracked-new, nothing of mine is committed)
**Seat:** surface-wave worker `sess_1785277859737_4r5jlvjop` · task `task_1785277858336_ytvdvaa9w`
**Bar built to:** LINK-LEVEL COMPLETENESS (user program order). Fidelity is explicitly NOT claimed anywhere below.

---

## 1. What this is

The T10 chat surface: a feed of `EntityFeedPage` items plus the composer grammar, posting through
`seam.commands.postMessage` — the same command the panel composer at `EntityView.tsx:107` already calls.

**What it is NOT, so the boundary is unambiguous:** the T10 hero frame draws an entire panel —
breadcrumb, entity header, the Content/Discussion/Connections/Activity tab strip, the Terminal|Chat
surface switch, and, inside all of that, a feed and a composer. **This lane built the inside.** The
chrome around it already exists and is owned elsewhere (`panels/detail/chrome.tsx`, `tabs.tsx`,
`bodies/TerminalBody.tsx`). Re-drawing it here would have been a second implementation of a solved
surface, and the two would drift.

## 2. Oracle enumeration and per-frame disposition

Oracle: `T0-1 workspace structure review (1)/T10 Chat Surface Hi-Fi.dc.html` (122,356 bytes,
27 `data-screen-label` frames). Read 2026-07-29.

| # | Frame | Disposition |
|---|---|---|
| 00 | Hero — Chat surface | **BUILT** (feed + composer + provenance footer). Panel chrome out of lane. |
| 01 | Provenance treatments | **BUILT** — treatment **1a margin rail**, which the oracle marks "1a is the hero default". 1b/1c not built; picking a non-default would be a design decision this lane has no standing to make. |
| 02 | Delivery and send layers | **BUILT** — all 8 delivery badges (`feed-model.ts` `DELIVERY`). The 4 send layers exist as: draft (local `text`), mutation-pending (`busy`), stored (a row on the feed), delivered-or-not (the badge). |
| 03 | State inventory boards | Section header, nothing to build. |
| S01 | Phase-1 reserved | N/A — a claim about the tab row, which is chrome. |
| S02 | Profile resolving | **NOT BUILT** — a claim about the Chat *tab*, which is chrome. |
| S03 | No Chat profile | **NOT BUILT** — chrome (whether the Chat tab exists at all). |
| S04 | Template failed | **NOT BUILT** — chrome (warning badge on the tab). |
| S05 | Core renderer fallback | **PARTIAL** — this component *is* the core renderer. The fallback *notice* is chrome. |
| S06 | Initial loading | **BUILT** — `loading` + `page===undefined` ⇒ fixed-height skeletons, `aria-busy`. |
| S07 | Empty feed | **BUILT** — `chs-empty`, with the terminal sentence conditional (see §5). |
| S08 | Loading older | **BUILT** — `loadingEarlier` ⇒ "loading earlier…". Scroll-anchor pinning NOT built (see §7). |
| S09 | Sparse page | **BUILT** — footer states items-returned + cursor, never a total. |
| S10 | Cursor refresh | **BUILT** — `refreshedFromNewest` notice; draft untouched (composer state is independent). |
| S11 | Offline | **BUILT** — `connection.phase` offline/polling ⇒ Send disabled-with-reason, cached rows kept. |
| S12 | Permission lost | **BUILT** — `refusal={kind:'forbidden'}` REPLACES the surface, composer included. |
| S13 | Session deleted | **BUILT** — `refusal={kind:'not_found'}`, tombstone copy. |
| S14 | Tombstone | **BUILT** — `message.deletedAt` ⇒ tombstone row, body never rendered. |
| S15 | Unknown variant | **BUILT** — safe card; rows are never dropped. |
| S16 | Mutation group | **BUILT** — `groupByOperation`, keyed on `logicalOperationId` only. |
| S17 | Validation failed | **BUILT** — `role="alert"` beside the composer, draft kept. |
| S18 | Outcome unknown | **NOT BUILT** — needs clientMutationId reconciliation, which lives in the host's store, not here (see §7). |
| S19 | Delivery failed | **BUILT** — badge + "send again" through the same dispatcher. |
| S20 | Multi-target | **BUILT** — summary chip + expandable per-target list, uncollapsed. |
| S21 | Exited composer | **BUILT** — `sessionExited` ⇒ warning, Send stays ENABLED (see §4 ruling 2). |
| S22 | Upload failed | **NOT BUILT** — there is no upload seam at all; the attach control refuses (see §6 GAP-1). |
| 26 | Accessibility contract | **BUILT** for the feed's half: labelled list of `article`s, no ARIA chat semantics; direction/provenance/delivery/redaction all available as TEXT. Tab-list and terminal-focus halves are chrome. |

## 3. Integration note — exact props, exact mount point

```tsx
import { ChannelScreen } from './channel-screen';
```

Mount it where a hub's Feed navigates to. It fills its container (`height:100%`, internal scroll on
the feed region, composer pinned at the bottom) and expects a parent with a bounded height.

```ts
interface ChannelScreenProps {
  anchorId: EntityId;                 // REQUIRED — the entity the feed is anchored on
  anchorNoun: string;                 // REQUIRED — "this channel" / "this session".
                                      //   A PROP because naming a kind is registry knowledge;
                                      //   a lookup here would be kind-branching by another name.
  page?: EntityFeedPage;              // from seam.feed(anchorId, {scope, cursor, limit})
                                      //   undefined = NO READ RAN (hollow). items:[] = a real zero.
                                      //   These MUST stay distinct — do not default it to a page.
  loading?: boolean;                  // a first read is in flight
  loadingEarlier?: boolean;           // an older page is in flight
  refreshedFromNewest?: boolean;      // S10 — the cursor expired and history was re-seeded
  refusal?: ChannelRefusal | null;    // {kind:'forbidden'|'not_found', message} — REPLACES the surface
  connection?: ConnectionState;       // from seam.getConnection() / seam.onConnection()
  sessionExited?: boolean;            // liveness says the anchor's session is not running
  newSinceItemId?: string | null;     // client-local divider; the first item that arrived after open

  onPost?: (input: ChannelPostInput) => Promise<void> | void;
  onLoadEarlier?: (cursor: Cursor) => Promise<void> | void;
  onOpenEntity?: (id: EntityId) => void;
  onSwitchToTerminal?: () => void;    // omit on a channel — see §5
}

interface ChannelPostInput { anchorIds: EntityId[]; body: string; parentMessageId: EntityId | null }
```

**The `onPost` wiring the gap test proves works** (copy this shape — `clientMutationId` is the
host's to supply, per the seam docblock):

```tsx
onPost={(input) => seam.commands.postMessage({
  ...input,
  clientMutationId: `post:${anchorId}:${Date.now()}`,
})}
```

**Every optional dispatcher above is optional in the R7 sense, never the silent sense:** omit it and
the corresponding control renders disabled-with-reason. There is no prop whose absence makes a
control vanish or go inert, with the single documented exception of `onSwitchToTerminal` (§5).

## 4. Rulings I made alone — flag for ratification or reversal

1. **Provenance treatment 1a (margin rail) is the built one.** Not a free choice: the oracle labels
   it "1a is the hero default". Recording it because it is a design commitment a reader might
   otherwise think was arbitrary.
2. **`sessionExited` warns but does NOT disable Send.** S21's copy is "Session exited — Send stores
   the message; nothing is delivered, nothing wakes." Storing is a *permitted, successful* write, so
   disabling would refuse something the product does. The composer says the consequence is smaller
   than expected; it does not pretend the write is impossible. **If the coordinator reads S21 the
   other way, this is a one-line reversal in `Composer.tsx`.**
3. **`offline` and `polling` both disable Send.** Only `offline` is drawn by S11. I extended it to
   `polling` because there is no contracted offline queue either way, and a Send that silently
   depends on a degraded transport is the "outcome unknown" state we cannot yet reconcile (S18, not
   built). Conservative, and reversible.
4. **Grouping refuses three cases** (`feed-model.ts`, each tested): never by timestamp, never a
   message, never a group of one. The first two are the oracle's own words; the third is mine.

## 5. RULED vs DRIFT — divergences from the oracle

| | Oracle | Built | Where | Class |
|---|---|---|---|---|
| Avatar size on the byline | 18px (hero line 98) | 20px | `FeedRow.tsx:153` | **DRIFT** — `kit/Avatar` types `AvatarSize = 15\|20\|22\|32`; 18 does not type-check and widening the kit union is outside this lane. Routed to the coordinator. |
| Panel chrome (breadcrumb, header, tab strip, surface switch) | drawn in the hero | not drawn | — | **RULED** — D63 already supersedes the T0-4/T0-2 chrome by user ruling; re-drawing it here would fork a solved surface. |
| Row dividers | none — `gap:3px` only (hero line 78) | none | `channel-screen.css` | Match. Recorded because the hairline rule (`--pn-x-hairline-soft` separates repeated siblings) *predicts* a divider here and the oracle draws none; I followed the oracle, not the rule. |
| Empty-state terminal sentence | unconditional (S07) | conditional on `onSwitchToTerminal` | `ChannelScreen.tsx` | **DRIFT, deliberate** — "the agent's native output lives in Terminal" is true of a session anchor and false of a channel. Printing it unconditionally on a channel would be a confident false sentence. |
| Reply parent excerpt | excerpt + author (hero lines 109–114) | relationship only ("in reply to <id>") | `FeedRow.tsx` ParentPreview | **DRIFT** — see GAP-2. |

## 6. GAPS — capabilities the seam does not have

- **GAP-1 · attachments.** No upload command exists anywhere behind the facade seam (checked
  `src/data/seam.ts` `commands` block, 2026-07-29). `PostMessageInput.attachmentIds` accepts ids of
  files that must already exist as entities; nothing in the seam creates one from a local file. The
  composer's `＋` renders **disabled-with-reason** with that exact fact. S22 (upload failure states)
  is unbuildable until an executor exists. **Not a decision — a gap.**
- **GAP-2 · parent-message hydration.** `MessageView.state.rootMessageId` gives the parent's ID and
  nothing else, and this surface holds only the page it was handed — so the oracle's parent
  *excerpt* is available only when the parent happens to be on that page. Rather than a
  sometimes-excerpt that silently degrades, the row renders the relationship, which is always true.
  Closing this needs either a parent-hydration read or a host-side lookup passed in as a prop.
- **GAP-3 · fixture `feed()` returns `nextCursor: null` always** (`seam-fixture.ts:590`). So S08/S09/S10
  paging cannot be exercised against fixtures — the component's paging is proven by unit test with a
  synthetic cursor, **not** against the fixture seam. Extending the fixture dataset is `src/fixtures/`
  work (a lane I was told is mine to extend but which I did not touch, to keep this handover to one
  directory). Flagged rather than done.
- **GAP-4 · S18, mutation outcome unknown.** Requires reconciling a `clientMutationId` against the
  event echo before offering another send. That state lives in the host's store, not in this
  component. Not built, and **not faked** — there is no control here that pretends to do it.

## 7. NOT BUILT, said plainly (not gaps — scope calls)

- **The "⌄ new items" scroll pill and scroll-anchor pinning on prepend.** Both need real layout
  measurement, which jsdom cannot verify and which I could not check in a browser this session. I
  drew **neither** rather than draw a dead one — nothing is rendered, so there is no silent void.
- **Optimistic echo / pending row.** Layer 2 of §7. The store owns it.
- **The tab-list and terminal-focus halves of the §10 accessibility contract** — chrome.

## 8. COLOR NEEDS

**None.** No `--pn-x-*` extension was required: all fourteen of the oracle's dark literals on this
surface map one-for-one onto existing tokens, and the mapping table is written into the head of
`channel-screen.css` for the next reader. `src/hex-ban.test.ts` scans the new stylesheet and passes.

## 9. Evidence

**Red first** — 2026-07-29 19:42:57 IST, `bunx vitest run src/channel-screen` from
`packages/tm8-ui` (v4.1.10), with the three test files written and **no implementation present**:

```
Error: Failed to resolve import "./ChannelScreen" from "src/channel-screen/seam-gap.test.tsx".
 Test Files  3 failed (3)
      Tests  no tests
```

A second, sharper red followed implementation: the gap test failed on
`expected undefined to be truthy — the fixture anchor must carry at least one message to reply to`,
because `channelDesign` carries **no** anchored messages in the fixture dataset. Repointed to
`taskGuideLines` (the only fixture anchor that does). That red was information, not noise: it is the
first evidence for GAP-3.

**Green, lane** — 2026-07-29 19:48:53 IST · `bunx vitest run src/channel-screen` · cwd
`packages/tm8-ui` · vitest v4.1.10 → **3 files, 44 tests, all passed**.

**Guards** — 2026-07-29 19:50:38 IST · `bunx vitest run src/hex-ban.test.ts
src/panels/no-branching.test.ts src/channel-screen` → **5 files, 54 tests passed**.

**Typecheck** — 2026-07-29 19:49:31 IST · `bunx tsc --noEmit` from `packages/tm8-ui` → **clean, no
output**. (Its one finding, the 18px avatar, is recorded as DRIFT in §5 rather than suppressed.)

**Wide check** — 2026-07-29 19:49:36–19:49:52 IST · `bunx vitest run --exclude 'src/terminal/**'` ·
cwd `packages/tm8-ui` (banner `RUN v4.1.10 …/packages/tm8-ui` — the control) → **71 files, 1314
tests**.

> **THE TREE IS NOT MINE ALONE AND THE NUMBERS MOVED WHILE I MEASURED.** Two consecutive wide runs
> 40 seconds apart disagreed: the first reported `3 failed | 68 passed` with 2 test failures in
> `src/files/files.test.tsx`; the second reported `2 failed | 69 passed` with **1314/1314 tests
> passing** and the two failures being `src/doc-edit/docEdit.test.tsx` and
> `src/doc-edit/docEdit-seam.test.tsx` dying at collect (0 tests). Both directories belong to OTHER
> live seats in this wave (`surface files-node`, `surface doc-edit`) who are writing them right now.
> **Neither failure is in my lane, and neither is caused by my files** — my directory is untracked-new
> and imports nothing that either lane owns. Per D62.1 I am naming the noun rather than reporting a
> tree state: *at 19:49:52 IST, with two sibling lanes mid-write, the package's non-terminal suite was
> 1314/1314 green except for two collect-time failures in `src/doc-edit/`.* Re-run after those lanes
> land; do not attribute their red to this handover, and do not take my green as a statement about
> their files.

**Tree ownership** — `git status --porcelain packages/tm8-ui/src/channel-screen` → `?? packages/tm8-ui/src/channel-screen/`,
one untracked directory, 9 files, 2,603 lines. I ran no `git add`, no `git commit`, and edited **zero
existing files anywhere in the repo**. 124 other files in the tree are modified by other seats,
including `src/data/seam.ts`, `src/data/fixtures/seam-fixture.ts` and `src/data/real/ops.ts` — I read
the working-tree versions, which is the truth of this tree, not of `HEAD`.

## 10. NOT CHECKED — the section worth more than a confident silence

1. **I never looked at it.** No browser, no `:4612`, no capture, neither theme. Per my brief the user
   reviews live after the coordinator wires it. **Every defect that reached HEAD on this project was
   found by rendering the thing and none by a passing suite** — so treat every layout, overflow and
   contrast claim in this document as UNWITNESSED. Specific things a suite structurally cannot see
   and which I therefore do not claim: whether the feed's `overflow:auto` actually resolves inside
   whatever container the coordinator mounts it in; whether the composer pins at the bottom; whether
   the 88px rail folds acceptably at narrow widths (the oracle warns it must fold below 480px and I
   wrote **no** such breakpoint); whether anything clips under the 1.1× zoom lever.
2. **Dark theme is asserted, not observed.** The claim "tokens invert, so no per-theme override is
   needed" is a claim about the token system, which I read; it is not a screenshot.
3. **The real seam.** The gap test drives the FIXTURE seam end to end. `createRealSeam()` needs a
   live node. A shape divergence between the two would be a contract violation rather than a silent
   pass — but that is an argument, not a measurement.
4. **No pixel diff of any kind was run.** No value in this lane was extracted by measuring the
   oracle's rendered output; the geometry literals were transcribed from its inline styles where it
   states them, and everything else is this package's existing idiom. **Fidelity is a later
   session's job and nothing here should be read as a parity claim.**
5. **Cross-lane collision.** I did not check whether any sibling seat is also creating a chat/feed
   surface. If two exist, that is a coordinator-level merge question, not a defect in either.
6. **Accessibility was tested by role and name, not by a screen reader**, and never with a keyboard
   in a real browser.
