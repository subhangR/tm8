# HANDOVER — `src/doc-edit/` (T5-3 Doc Authoring)

**status-as-of:** `1a1b70e` · seat: doc-edit worker (`sess_1785277848590_d2vtgzmi0`) · 2026-07-29

Everything in this directory is **mountable, not mounted**. No existing file anywhere in the repo was edited by this seat. §7 is the wiring the coordinator holds the seat for.

---

## 1. What was built, against which oracle region

Oracle: `T0-1 workspace structure review (1)/T5-3 Doc Authoring Hi-Fi.dc.html` — three frames, enumerated by `data-screen-label`.

| Oracle frame | Lines | Built as |
|---|---|---|
| F1a "Read and edit modes" — read panel's `Edit` primary | 43, annotation 1 (124) | `EditEntryControl.tsx` |
| F1b "Read and edit modes" — the edit panel | 68–120 | `DocEditor.tsx` + `DocSource.tsx` + `DocPreview.tsx` + `EditorChrome.tsx` |
| F1b conflict banner | 91–100, annotation ◦ (128) | `EditorChrome.ConflictBanner` |
| F2a "Z4 split view" | 143–171 | `DocSplitView.tsx` |
| F2b "block editors — full-bleed Z4" | 175–190 | `BlockEditorSlot.tsx` |
| F3a "the four footer states" | 204–208 | `EditorChrome.SaveWord` / `saveWordOf` |
| F3b dark | 211–237 | token inversion only — no per-theme rule was written |
| F3c "320 floor" | 240–263 | construction (wrapping bars, `min-height` not `%`), see NOT-CHECKED |

The save truth: `seam.commands.patchEntity(id, { expectedVersion, title?, content? })` — `src/data/seam.ts:201`, fixture executor `seam-fixture.ts:677`, real executor `ops.ts:249`. **Version conflict is a designed state**, not a simulated one: the fixture calls `requireVersion` and attaches `current: EntityDetail`, so reload-and-overwrite are both reachable end to end.

---

## 2. Files (all new, all mine)

```
blocks.ts               153   the draft parser (4 shapes + fences)
commands.ts              86   the DocCommands port, patch builder, structural readers
useDocSave.ts           258   the save flow; baseVersion captured at FIRST edit
EditorChrome.tsx        284   stance toggle, Cancel/Save, conflict banner, refusal host, save word
DocSource.tsx           134   write stance — textarea + fence-chip strip
DocPreview.tsx           68   preview stance
DocEditor.tsx           100   F1b, the Z3 edit surface
DocSplitView.tsx        160   F2a, the Z4 split
BlockEditorSlot.tsx      93   F2b, drawn and honest
EditEntryControl.tsx     69   F1a, permission-honest entry
index.ts                 55   barrel; imports the stylesheet (kit/panels/authoring precedent)
doc-edit.css            653   tokens only
docEdit.test.tsx        607   surface suite
docEdit-seam.test.tsx   217   the test that lives in the gap
HANDOVER.md             this
```

**Tree hygiene:** `git status --porcelain` at `1a1b70e` shows `?? packages/tm8-ui/src/doc-edit/` (my whole lane, untracked) **plus 46 files already modified under `packages/tm8-ui` that are NOT mine** — including `DECISIONS.md`, `src/data/**`, `src/authoring/**`, `src/domain/registry.ts`, `src/graph/**`, `src/App.tsx`. I did not write to any of them and cannot speak to their state. Flagging rather than assuming the coordinator knows.

---

## 3. Verification — every figure carries when, what, and which instrument

**Red-first, twice.**

1. *Absent-implementation red* — `2026-07-29T14:12:42Z`, `bunx vitest run src/doc-edit` from `packages/tm8-ui`:
   `Test Files 2 failed (2) · Tests: no tests` — `Failed to resolve import "./index"`.
2. *Meaningful red* (the one that matters — a green that was never red is a claim). With the implementation in the tree, the defect was **restored** in `useDocSave.save()` — `flush(detail.version)` instead of `flush(base.current)`, i.e. read the version at SAVE time:
   `FAIL docEdit.test.tsx > the save carries the version the edit was BASED ON … AssertionError: expected 7 to be 3`
   `Test Files 1 failed | 1 passed (2) · Tests 1 failed | 34 passed (35)`
   That is the silent-overwrite defect reproduced and caught. Reverted; suite returned to 35/35.

3. *Third red, on the shortcuts* — the footer advertises `⌘enter saves · esc cancels`, so those were tested and the tests proved non-vacuous: replacing the modifier guard in `DocSource.tsx` with `if (false)` produced
   `Tests 2 failed | 37 passed (39)` — both shortcut tests, and only those. Reverted.

**Wide check** — `2026-07-29T14:27:47Z`, run from `/Users/subhang/Desktop/Projects/tm8/packages/tm8-ui` (banner control: `RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui`):

- `bunx vitest run --exclude 'src/terminal/**'` → **73 files passed, 1370 tests passed, 0 failed**. Scope: whole package minus `src/terminal/**`; integration `.itest.ts` files are not in the default include and did not run. (An earlier wide check at `14:24:30Z` read 1366/1366 — the delta is the four shortcut tests added after it.)
- `bunx tsc --noEmit` → **exit 0, no output**.
- `src/hex-ban.test.ts` is inside that 1370 and scans `doc-edit/doc-edit.css` (my lane is not one of its four exclusions). It is green, so the file carries no raw hex.

One instrument note worth keeping: an intermediate run of mine reported from `packages/tm8-ui/src` and the banner read `RUN v4.1.10 …/packages/tm8-ui/src` with `No test files found` — the brief's control worked exactly as documented. Every figure above is from the package root.

---

## 4. Divergences from the oracle — RULED vs DRIFT

**DRIFT (oracle value / built value / where):**

- **D-1 · the source is a `<textarea>`, and the fence chips sit in a strip below it rather than inline.**
  Oracle 101–111 draws syntax-tinted spans with the mermaid fence collapsed to a chip *inside the text flow*. Built: `DocSource.tsx:33` textarea + `de-blocks` strip. Reason: that drawing is a static mock of a rich editor; a textarea cannot host elements and no contenteditable editor exists in this package. Under this wave's bar (link-level completeness first) a textarea that types and saves through the real seam beats a div that looks right and cannot accept a keystroke. The oracle's actual **law** — "blocks stay blocks … never inline as raw code someone can half-break" (annotation 3) — is kept; its position is lost. **A parity session owns this.**
- **D-2 · no syntax tint in the source.** Same cause as D-1, same owner.
- **D-3 · the block chip says `N lines`, not `8 nodes`.** Oracle 107. We do not parse mermaid, so a node count would be a claim rather than a measurement (D39's defect class). A line count is a fact we hold. `blocks.ts:41`.
- **D-4 · the conflict banner fill sits at the token's alpha, not the canvas's.** Oracle `rgba(63,108,144,.08)` fill / `.25` rule; built `var(--pn-info-soft)` (α .12) and `color-mix(… 25%, transparent)`. The token file ships no `--pn-info-rgb` triple, and inventing one is a tokens.css change this seat may not make. `doc-edit.css` "conflict banner" block.
- **D-5 · the split footer does not repeat the canvas's sentence.** Oracle 169 promises "split remembers its ratio per doc · preview tracks the caret". Neither is built (see G7), so the footer states what is true instead of printing a promise it does not keep. `DocSplitView.tsx:129`.
- **D-6 · the banner's actor is usually unnamed.** Oracle 95 writes "@noa saved v4". See G4 — this is a contract gap, not a styling one.

**RULED (a call I made; flag for ratification or reversal):**

- **R-1 · the conflict renders as the BANNER, not as `authoring/RefusalCard`.** T5-3 line 208 states the law for *this* surface: "the state lives in the footer, the conflict fact in a banner — no toasts inside an editor". The refusal card is still used for **non-conflict** refusals, where the server sentence needs room. Two different failures, two different homes, each from its own canvas.
- **R-2 · `reload()` is gated on actually holding their document (`canReload`).** `authoring/useTaskSave.reload()` calls `onReload` only `if (current)` but settles either way — so a refusal carrying no document **drops the draft and delivers nothing**. Mine refuses to run and the control renders disabled-with-reason instead. **This is a suspected defect in `authoring/`, reported not fixed** — that lane is not mine to edit. Test: `docEdit.test.tsx` "LOAD THEIRS DISABLES WITH REASON …".
- **R-3 · in a conflict, the primary Save is disabled-with-reason.** Pressing it again re-sends the same `expectedVersion` and fails forever; making it re-read the version is the silent overwrite the flow exists to prevent. The two real answers live in the banner and the button says so. `EditorChrome.tsx:70`.
- **R-4 · the 320 floor is met by wrapping the two bars, not by folding Cancel into the header ✕.** Oracle 263 folds it. We do not own the header, so a fold would be a cross-lane edit; wrapping keeps every control reachable and clips nothing. Reversible once the header is in scope.
- **R-5 · ⤢/⇲ and the "editing" pill are NOT drawn by this surface.** They sit in the panel header on the canvas (38, 74, 145), and `authoring/SaveControls` already renders that pill for the header's `actions` slot. Drawing a second set here would be two controls per gesture.
- **R-6 · `useDocSave` duplicates `useTaskSave`'s state machine** rather than adapting it. Routing a doc body through `patchTask` means sending it as `description`, which is a lie about the field being written; and an adapter is where an argument gets dropped (D57.1). The failure vocabulary (`classifyFailure`, `ConflictFailure`, `RefusedFailure`, `nextMutationId`) **is** imported from `../authoring`, so there is one error vocabulary. See the D-entry proposal in §6.

---

## 5. GAPS — every one renders disabled-with-reason or states its absence

| # | Gap | Where it surfaces | Copy |
|---|---|---|---|
| G1 | **"N readers now" has no seam source.** `seam.ts` states presence/typing frames never appear (R8 dormant, no publisher). | The READ footer (oracle 63) — **chrome's, not this surface's.** The edit footer draws no reader count, so nothing here fakes one. Reported against chrome. | n/a |
| G2 | **No mermaid/excalidraw renderer.** | preview `de-preview__block` | "not rendered — no diagram renderer ships in this build" |
| G3 | **No block editor.** `BlockEditorSlot` is drawn with real anatomy; both verbs disabled. | chip `open editor ⤢`; slot `Apply to draft`, `⇲ back to doc` | "The block editor isn't built yet — T5-3 draws a full-bleed mermaid/excalidraw stage; no editor and no renderer ship in this build" |
| G4 | **The contract has no last-editor field.** `EntitySummary` carries `createdBy` and nothing else; rendering it would attribute a stranger's edit to the doc's creator — plausible, wrong, unfalsifiable. | banner headline | "Someone saved v4 while you were editing" unless the host passes `conflictActor` |
| G5 | **Proactive conflict detection** (someone saves *while* you type, before you press Save) needs `seam.onEvent` `entity.upsert` watching. That is host wiring. | Without it the conflict still surfaces at save time — the designed 409, never silent. | — |
| G6 | **Version history** — R7 deferred. The oracle itself draws **no** history affordance in edit mode (annotation, line 268), so nothing was added. | — | — |
| G7 | **Split ratio does not persist.** `vite.config.ts` records `localStorage` as measured-broken under this runner (an object with no `setItem`). A persistence path that silently no-ops in every test is worse than none. | split footer | "ratio resets when this view closes" |
| G8 | **Read-mode action-bar verbs** (`▲ 6`, `▽`, `⊕ Link`, `Add chapter`, oracle 41) are registry primaries / chrome — **not covered by this seat.** Flagged so they are not assumed done. | — | — |

---

## 6. COLOR NEEDS and D-entries I am authoring

**COLOR NEEDS — one, and it is not new.** The editor/prose ink `#3A362E` light / `#D8D0BE` dark is the *same measured pair* `panels/bodies/reader-body.css` already reported as `--pn-x-prose-ink`. This file uses the identical `var(--pn-x-prose-ink, var(--pn-ink))` fallback rather than filing a second request for one colour. When it lands in `canvas-extra.css`, both surfaces correct together. **No other colour in this canvas lacks a token** — the full mapping is stated at the top of `doc-edit.css`.

**D-entry texts (yours to ratify, edit or reverse — I never stage `DECISIONS.md`):**

> **D<N> — The version conflict is a DESIGNED state on every write surface, and `patchEntity` is the doc's truth.**
> A doc save rides `seam.commands.patchEntity` with `expectedVersion` captured at the FIRST edit and held until the draft resolves — never re-read at save time, because re-reading turns the race into a silent overwrite that no test which keeps the version still can see. A conflict parks and offers exactly two moves: reload (take theirs, gated on actually holding their document) and overwrite (keep mine, at THEIR version, disabled-with-reason when the node did not say which version won). No merge, no retry, no toast — the fact lives in a banner and the state lives in the footer word (T5-3 line 208).

> **D<N+1> — `readDocument` should be exported from `panels/bodies/ReaderBody.tsx`.**
> `doc-edit/blocks.ts` parses the same document family for the editor preview and is a stated duplication: the reader promotes headings into its outline and has no fence concept, the editor must show headings in place and must find fences. Both are correct for their surface, and both will drift. One exported parser with a `promoteHeadings` option would end it. Not done here — `panels/` is not this lane's to edit.

> **D<N+2> — `authoring/useTaskSave.reload()` drops the draft when the refusal carried no document.**
> `settle()` runs unconditionally and `onReload` only fires `if (current)`, so a `version_conflict` without a `current` payload clears the user's text and shows them nothing. `doc-edit/useDocSave` gates the move instead and renders it disabled-with-reason. Reported across the boundary rather than fixed across it; the authoring seat should confirm or refute before this is treated as a defect.

---

## 7. INTEGRATION NOTE — exact props, exact mount points

`src/doc-edit/` exports only. Import from `'../doc-edit'` (the barrel imports the stylesheet, so one symbol brings the whole vocabulary).

### 7.1 The hook, once per doc panel

```tsx
const save = useDocSave({
  detail,                      // EntityDetail | null — null is legal (pre-hydration)
  commands: seam.commands,     // Seam['commands'] assigns directly: no adapter, no cast
  onSaved: (result) => { /* optional: refresh the panel's detail */ },
  onReload: (current) => setDetail(current),   // "load theirs" hands you the server's detail
  editRefusal: getKind(detail.kind).panel?.capabilityReasons?.canEdit,  // registry DATA
});
```

`useDocSave` holds the draft. **One handle per editing session** — `DocEditor` and `DocSplitView` must share it, or ⤢ forks the user's text into two drafts.

### 7.2 Mount points

| Component | Mounts | Required props | Optional |
|---|---|---|---|
| `EditEntryControl` | the **read** panel's action row / kind primary, where the oracle draws `Edit` (line 43) | `detail`, `commands` | `onEnterEdit` (absent ⇒ disabled-with-reason), `editRefusal`, `label` |
| `DocEditor` | **replaces the Content-tab body** while editing — i.e. where `ReaderBody` renders. It draws its own `role="tabpanel"`-free column, so it goes *inside* the panel's existing body slot. | `save`, `detail` | `stance` + `onStanceChange` (controlled), `onOpenBlock`, `conflictActor` |
| `DocSplitView` | the **Z4 immersive** surface, target of the header's ⤢ | `save`, `detail` | `onCollapse` (absent ⇒ disabled-with-reason), `onOpenBlock`, `conflictActor` |
| `BlockEditorSlot` | full-bleed Z4, target of `onOpenBlock` | `block` | `onApply`, `onBack` |

### 7.3 What the host still owns

1. **The header pieces** — the `editing` pill (use `authoring/SaveControls`' pill or the header's own), the `v{n}` pill, and the ⤢/⇲ pair. Route ⤢ to a `DocSplitView` mount carrying **the same `save` handle**.
2. **Mode state** — read ⇄ edit. `EditEntryControl.onEnterEdit` flips it; `save.cancel()` on exit drops the draft.
3. **`conflictActor`** (G4/G5) — if you subscribe `seam.onEvent` for `entity.upsert` on this id, pass the actor's display name; otherwise leave it and the copy stays honest.
4. **The registry row** — `doc`'s `panel.archetype` is `'reader'` today. Nothing in this lane changes it; wiring is a host decision.

---

## 8. NOT-CHECKED — said plainly

- **No browser.** Nothing here has been rendered at `:4612`, in either theme, at any width. Every layout claim in `doc-edit.css` is a **constraint I wrote**, not a measurement I took. Specifically unverified: the 320 floor (F3c) — the wrapping bars and `min-height: 120px` source are *intended* to satisfy it and have never been looked at; whether the source area actually scrolls instead of pushing the footer out; whether the split panes hold at narrow widths; the dark pairing (F3b), which should be free through tokens and has not been seen.
- **No real node.** Every seam assertion runs against `createFixtureSeam()`. The real path (`ops.ts` → `entities.patch`) was read, not exercised. In particular: whether the server **merges** `content: { body }` into the existing doc content or **replaces** it. The fixture merges (`{ ...e.content, ...input.content }`). If the real node replaces, a doc save would drop `format`. **This is the highest-value thing to check next** and I could not check it from this seat.
- **No `CommandResult` shape from a real node** — `savedVersionOf` reads `entity.version` then `patches[0].version` and returns `null` otherwise. Which one a real node populates is untested.
- ~~The `⌘enter` / `esc` shortcuts are untested~~ — **closed.** Four tests cover ⌘enter, ctrl+enter, bare enter (must NOT save), and esc-cancels-without-escaping-the-field; the modifier guard was broken to prove they are not vacuous.
- **Pointer-drag on the splitter** is untested (the keyboard path is). `getBoundingClientRect` returns zeros in jsdom, so the drag would need a browser.
- **`aria-disabled` focus order and screen-reader announcement** of the disabled controls is inherited from `DisabledWithReason` and was not independently verified here.
- **The 46 modified files in the tree that are not mine** — I did not read them and make no claim about whether my lane composes with their current state beyond the wide check passing at `1a1b70e`.

**Ready for capture** — the surface needs a browser pass before anyone should believe its geometry.
