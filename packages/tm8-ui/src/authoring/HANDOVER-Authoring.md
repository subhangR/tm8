# HANDOVER — Authoring flows: NEW TASK (create) + SAVE (edit/persist)

**status-as-of:** `756a9b0` (last commit at start of this seat; the working tree has moved since — see §8) · seat `sess_1785275765803_lvvuks08e` · task `task_1785275765553_q907l9fzl` · 2026-07-29

Everything in `src/authoring/` is **mountable, not mounted**. Nothing is wired into a screen. §7 is the integration note with exact props and exact call sites.

---

## 1. Frame enumeration — the oracle, measured

`T0-1 workspace structure review (1)/T5-5 T5-6 Launch & Authoring Flows Hi-Fi.dc.html`, from `data-screen-label`, file order. Byte offsets given so the read is reproducible.

| # | offset | `data-screen-label` | disposition |
|---|---|---|---|
| 1 | 830 | `T5-5 — Launch sheet anatomy` | **not my scope** (D44/D51 launch; already built — `views/LaunchSheet.tsx`, `panels/launch/LaunchQuickConfig.tsx`). Its *DESIGNED REFUSAL* block at offset ~19300 IS my oracle for the refusal/conflict card. |
| 2 | 20899 | `T5-6 — Teammate authoring` | the ONE designed create-**dialog** exception (4 fields). Teammate creation out of scope; its right-hand panel is the oracle for the **save grammar** I did build. |
| 3 | 35385 | `T5-6 — Generic create pattern, dark, floor` | **the new-task oracle** (left column). Its middle/right columns are the dark and 320-floor launch sheets — launch again, not mine. |

**The law the oracle states, verbatim** (frame 3):

> `＋ New → placeholder title → Z3 opens, title in inline-edit focus · no per-kind forms`
> "created for real, instantly — the row is already in the list as “Untitled task”. Type the name, enter commits, esc keeps the placeholder."
> "＋ New on ANY plain kind (task · doc · channel · collection · c:*) does exactly this … Exceptions are only the designed ones: teammate (above), member invite (T2-1), project registration (T2-2)"

**So there is no create form for a task.** The create fires with a placeholder title and the SAVE flow is what names it. That is why the two assigned flows are one continuous flow with a seam-crossing in the middle, and why they were right to be assigned together.

Supporting oracles: T0-4 anatomy note 2 — *"inline-editable title (dotted = editable; tracked kinds lock it)"*; T0-3 note 2 — *"＋ New (create) · kind quick-launch"*; T5-5's annotation on the refusal — *"red word + cause + what did NOT happen + real next moves"*, under the eyebrow **"DESIGNED REFUSAL — NOT A TOAST APOLOGY"**.

## 2. Executor map — which seam command each step needs

Measured against `src/data/seam.ts` + `@tm8/contract`, not remembered.

**NEW TASK**

| step | executor |
|---|---|
| `＋ New` pressed | none (UI) |
| create for real, instantly | `commands.createTask(CreateTaskInput{spaceId, title, clientMutationId})` |
| in-flight | **no executor** — a designed pending state (`aria-busy` + "creating…" + a phase guard) |
| Z3 opens on the new id, title focused | navStore push = **coordinator wiring**; I ship the focused editor |
| type, Enter commits | `commands.patchTask(id, {expectedVersion, title, clientMutationId})` |
| Esc | **no command**. The row stays "Untitled task"; Esc is not an undo, the entity exists |
| create refused | `CollabError` → refusal card |
| create returned no id | `CommandResult.entity` is OPTIONAL — a third state, neither success-with-open nor failure |

`CreateTaskInput.clientMutationId` is **optional** (it rides in via `CommandContext`), unlike `CreateEntityInput`'s which is required. `newTaskInput()` stamps one unconditionally rather than trusting a caller to remember.

**SAVE**

| step | executor |
|---|---|
| title / status / priority / dueDate / points / description | `commands.patchTask(id, {expectedVersion, …})` — **one** call flushes the whole dirty set |
| Cancel | no command |
| version conflict | `CollabError.code === 'version_conflict'`; `.current: EntityDetail` and/or `.details.currentVersion` |
| forbidden / not_found / invalid_input | refusal card; retry offered only where `CollabError.retryable` |
| `capabilities.canEdit === false` | disabled-with-reason, fed by registry `panel.capabilityReasons.canEdit` |

## 3. RULED vs DRIFT

Every divergence from the authoring canvas, labelled.

| # | oracle draws | built | verdict |
|---|---|---|---|
| 1 | `＋ New` chip in **brass** (`#9A581F` on `rgba(178,106,43,.11)`, T5-6/T0-3) | **INK** — `.lp__new` untouched, `panels.css` owns it | **RULED — D58.** The user ruled the create chip ink from the T0-1 oracle. Transcribing the authoring canvas here would re-open a ruling on the strength of a canvas that lost it. `authoring.css` sets **no** colour/radius/padding/font on `.lp__new`; it adds only the in-flight treatment. |
| 2 | Cancel/Save in a standalone 32px action row under the tab strip (T5-6 teammate frame) | a **fragment** for the header's inline `actions` slot | **RULED — D63.** The user retired the standalone action row; the action bar rides inline in the header. |
| 3 | refusal card `border:1px solid #2C2719`, `box-shadow:0 2px 8px rgba(0,0,0,.5)` | `1px solid var(--pn-line)`, no shadow | **RULED — hairline rule (brief §2.4).** `#2C2719` is the **dark** line token; the card is drawn on the dark presentation board. Inside a light panel it would render a near-black frame. `--pn-line` BOUNDS a component, and a card is a component. The shadow drops because this card is *seated* in a panel body, not floating over it. |
| 4 | a drawn 1.5px brass caret bar with `animation:pnPulse` beside the title text | `caret-color: var(--pn-brand)` on the real `<input>` | **RULED (mechanical translation).** The bar is a static mock's rendering of a caret. A real input already has one; drawing a second beside it is a defect a transcription produces and jsdom cannot see. |
| 5 | title-in-edit text in `#B7B2A4` (ink-4) | ink-4 **only when the value is the placeholder**; ordinary ink once a real title exists | **DERIVED, flagged.** The oracle paints only the placeholder state, so it does not answer the typed-title case. Reading ink-4 as unconditional would render every edited title in the disabled-text colour. Controlled by `data-placeholder`. |
| 6 | (nothing drawn) blur behaviour on the title field | **blur commits if changed** | **RULING I MADE ALONE — please ratify or reverse (§6).** |
| 7 | `no queue in v1 — honestly` (T5-5's trailing note voice) | `no merge in v1 — honestly` on the conflict card | **adopted voice, new words.** Named here so it is not read as a quotation. |

**No DRIFT found.** Every divergence above is either a ruling or a stated derivation.

## 4. Files + diffstat

All new, all under `packages/tm8-ui/src/authoring/`. **Zero existing files edited** — verified by `git status --porcelain packages/tm8-ui`, where the only entry attributable to this seat is `?? packages/tm8-ui/src/authoring/`.

```
 src/authoring/commands.ts             | 218 ++  port, mutation ids, builders, failure vocabulary
 src/authoring/useNewTask.ts           | 140 ++  the create flow
 src/authoring/useTaskSave.ts          | 250 ++  the save flow — baseVersion, conflict, overwrite
 src/authoring/InlineTitleEditor.tsx   | 151 ++  dotted-underline title → input
 src/authoring/StatusSelect.tsx        | 109 ++  the `● working ▾` picker
 src/authoring/RefusalCard.tsx         |  87 ++  T5-5's designed refusal
 src/authoring/SaveControls.tsx        | 174 ++  editing pill, Cancel/Save, AuthoringHost, ConflictCard
 src/authoring/NewTaskControl.tsx      |  78 ++  the create chip's two new states
 src/authoring/authoring.css           | 315 ++  every value cited to its oracle frame
 src/authoring/index.ts                |  41 ++
 src/authoring/authoring.test.tsx      | 557 ++  flow + component (31 tests)
 src/authoring/authoring-seam.test.tsx | 217 ++  THE GAP TEST — real fixture seam (5 tests)
 src/authoring/no-kind-literals.test.ts| 125 ++  §15.2 for this lane, see §5 (5 tests)
 src/authoring/HANDOVER-Authoring.md   | 256 ++  this file
 14 files changed, 2718 insertions(+), 0 deletions(-)  —  wc -l, 2026-07-29 03:47 IST
```

**Dirty in the tree that is NOT mine** (so it is not assumed you already know): `src/auth/` (untracked, another seat, actively being written — files timestamped inside the same minute as my run), plus modified `domain/actions.ts`, `domain/types.ts`, `domain/menu*`, `fixtures/index.ts`, `main.tsx`, `panels/EntityDetailPanel.tsx`, `panels/detail/chrome.tsx`, `panels/detail/tabs.tsx`, `panels/panels.test.tsx`, `shell/menu-resolve*`, `terminal/*`, `views/GateApp.tsx`, `views/useGateData.ts`, and a dozen `scratch-p*.txt` at the package root.

## 5. A ruling that creates a file names the controls that will see it (DoD §7)

Checked **before** writing, not after.

- **`src/hex-ban.test.ts`** is a PACKAGE guard: it walks `src/` with exactly four exclusions, and `authoring` is not one of them. It therefore scans this lane automatically. ✅ nothing to do, and `no-kind-literals.test.ts` now *asserts* that exclusion-list membership rather than trusting it.
- **`src/panels/no-branching.test.ts`** scans `OWNED_DIRS = ['panels']` + four named shell files. **It does not reach `src/authoring/`.** Creating this directory created a region where §15.2 is stated everywhere and enforced nowhere — the exact shape D61 recorded from the other side (coverage shrinking by side effect while the ledger claimed the package). So the lane carries its own guard: `src/authoring/no-kind-literals.test.ts`.
  - *Why not widen `OWNED_DIRS`:* D61's own argument. A lane guard that fails on another seat's file makes the **wrong seat red**, and their only moves are nag or exempt. Two lanes, two guards, one law.
- **New CSS file** → seen by the package hex guard (above). Zero raw hex; the hex→token mapping is written out at the top of `authoring.css` so a reviewer can check it without a colour picker.
- **New test files** → `vite.config.ts` `include: ['src/**/*.{test,spec}.{ts,tsx}']` picks them up; both `.tsx` files carry the `// @vitest-environment jsdom` pragma. **They do NOT touch `localStorage`**, so the load-bearing stub from `realSeamFlag.test.ts` is deliberately not copied — copying it blind would have added a mechanism with no reason attached.
- **No non-source artifact** was placed inside `src/` other than this handover, which the brief locates here by name.

## 6. Rulings I made alone — flagged for ratification or reversal

1. **Blur on the inline title COMMITS if changed** (`InlineTitleEditor.tsx`). The oracle states Enter-commits and Esc-keeps-the-placeholder and is silent on blur. Both candidates lose something, so it is a choice of *which* loss: blur-reverts silently destroys typed text on a stray click (a bug report), blur-commits saves something the user typed and can immediately edit again (not a bug report). Every save here is version-checked and reversible, which is what makes the asymmetry decidable rather than a matter of taste. **Reverse it by deleting the `onBlur` handler** — Esc keeps the explicit-discard path either way.
2. **`SaveControls` renders when dirty OR when saving is unavailable.** The second half means a panel mounted without an executor shows a permanently disabled Save carrying its reason. That is L6 (hidden and disabled are different states, and only one teaches), but it *is* a visible chip on every such panel. If you would rather it stay hidden until dirty, it is one condition.
3. **A conflict offers reload / overwrite and NOT retry.** A "retry" at the same `expectedVersion` fails forever; a "retry" that re-reads the version is the silent overwrite the whole flow exists to prevent. The type makes both unreachable.
4. **`aftermath` is a required field on both failure arms**, not prose spliced in at the card. The `no_id` state is what proves it earns its place: there the honest aftermath is *"the task MAY exist"*, and a hard-coded "nothing was created" would have contradicted the state it was rendering.

## 7. INTEGRATION NOTE — exact props, exact call sites

You wire; I do not. Four mounts.

### 7a. The create control — `EntityListPanel`, replacing the `.lp__new` chip

```tsx
import { NewTaskControl, placeholderTitleFor, useNewTask } from '../authoring';

const create = useNewTask({
  spaceId,                                   // GateData.spaceId
  placeholderTitle: placeholderTitleFor(config.label),   // registry label → "Untitled task"
  commands: seam.commands,                   // GateData.seam.commands — assigns with NO cast
  onCreated: (id) => { openPanel(id); focusTitle(id); },  // navStore push + the flag in 7b
});

<NewTaskControl flow={create} label={config.palette?.createLabel ?? '＋ New'} />
```

`NewTaskControl` renders `className="lp__new"` by default, so the chip is byte-identical to today's; pass `className` if a different host needs another chip. **Only wire this for `task`** — see GAPS G1.

### 7b. The title — `panels/detail/chrome.tsx`, `PanelHeader`

The existing title span is `contentEditable` with **no commit handler and no seam call**: inert since it was written. Replace the whole `<span className={…pn-head__title…}>` block with:

```tsx
<InlineTitleEditor
  value={detail.title}
  editable={detail.capabilities.canEdit && detail.deletedAt === null && titleEditable}
  lockedReason={titleLockReason}        // e.g. "tracked from GitHub — the title follows the source"
  placeholder={detail.title === placeholderTitleFor(config.label)}
  autoFocus={justCreated}               // true for the id 7a just created, once
  onCommit={(title) => void save.commitNow({ title })}
/>
```

`titleEditable` / `titleLockReason` are **registry data you must add** — see GAPS G3. Until they exist, pass `editable={detail.capabilities.canEdit && !detail.deletedAt}` and the tracked kinds will be wrongly editable; that is a real gap, not something to paper over here.

`pn-head__title--editable` in `panels.css` and `au-title--editable` here are two names for the same dotted-underline treatment. **Pick one and delete the other** — I could not, because `panels.css` is not mine.

### 7c. The save controls — the header's existing inline `actions` slot (D63)

```tsx
const save = useTaskSave({
  detail,
  commands: seam.commands,
  onSaved: () => void refreshDetail(detail.id),
  onReload: (current) => setDetail(current),           // take-theirs hands you the server detail
  editRefusal: config.panel.capabilityReasons?.canEdit,
});

<PanelHeader … actions={<><ActionBar inline … /><SaveControls save={save} /></>} />
```

### 7d. The honesty states — in the panel BODY, not the header

```tsx
<AuthoringHost save={save}>{bodyContent}</AuthoringHost>
```

`AuthoringHost` renders the conflict card and the refusal card beside its children. It is deliberately **not** inside `SaveControls`: a card cannot live in a 30px header row.

### 7e. Optional — the editable status pill

```tsx
<StatusSelect
  value={detail.state.workStatus}
  options={STATUS_OPTIONS}          // derived from config.panel.statusPill (labels + tones)
  editable={detail.capabilities.canEdit && (config.list.inlineEdit?.status ?? false)}
  onSelect={(workStatus) => void save.commitNow({ workStatus })}
/>
```

`StatusOption.value` is typed `WorkStatus`, so the narrowing from the registry's `Record<string, …>` happens at **your** call site, where the registry row is in scope. That is deliberate: pushing the cast here would have hidden it.

## 8. Verification

### Red-first

**RED 1 — the absent state.** Both test files written before any implementation; the run died at import.

```
2026-07-28T22:06:38Z   RUN v4.1.10 …/packages/tm8-ui
 FAIL  src/authoring/authoring.test.tsx [ src/authoring/authoring.test.tsx ]
Error: Failed to resolve import "./index" from "src/authoring/authoring.test.tsx". Does the file exist?
 FAIL  src/authoring/authoring-seam.test.tsx [ … ]  (same)
 Test Files  2 failed (2) · Tests  no tests
```

**RED 2 — three deliberate breaks against the finished tree.** An import failure proves absence, not that the assertions bite. Each break was applied, run, captured, reverted.

| break | what was changed | what went red |
|---|---|---|
| **1 — version read at SAVE time** | `save()` → `flush(detail.version)` instead of `flush(base.current)` | `sends expectedVersion — and it is the version the EDIT was made against` → `AssertionError: expected 7 to be 3`. **This is the silent-overwrite defect**, and it goes red on exactly one assertion. |
| **2 — draft dropped on conflict** | `if (failure.kind === 'conflict') { draft.current = {}; setEdits({}); }` | THREE tests, across BOTH files: `renders the conflict card … and keeps the draft` (`expected null not to be null`), `overwrite keeps MINE` (`expected […] to have a length of 2 but got 1`), and — the one that matters — the **seam** test `overwrite, once CHOSEN, lands at the current version` → `expected 'theirs' to be 'mine wins'`. A component-only break surfaced in the dataset. That is the crossing working. |
| **3 — overwrite offered with no version** | null-guard removed from `overwrite()`; the conditional move made unconditional | `cannot offer overwrite when the node did not say which version won` → `expected [ <button>, …(1) ] to have a length of 1 but got 2` |

**RED 3 — the new lane guard, both halves.** A `'task'` literal and a `#B26A2B` literal were injected into `commands.ts`:

```
 × no source file here contains a kind string literal
     authoring/commands.ts → 'task'
 × carries no raw hex of its own, checked locally as well
     authoring/commands.ts → #B26A2B
 Tests  2 failed | 3 passed (5)
```

Both removed; green restored. The guard also carries a non-empty-file-set assertion, so a glob that matched nothing cannot make it vacuously true.

### Wide check

**Instrument, stated because three seats mis-stated this tree in twenty minutes with honest numbers (D62 §1):** `bunx vitest run --exclude 'src/terminal/**'` and `bunx tsc --noEmit`, both run **from `/Users/subhang/Desktop/Projects/tm8/packages/tm8-ui`** — never the repo root, where `bunx` resolves vitest 2.x against this v4 tree and every file dies at collect. Banner control: `RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui`.

**TWO READINGS, both recorded, because the tree moved under me between them and only one of them is the final state.**

| | 2026-07-29 **03:45:56** IST | 2026-07-29 **03:49:32** IST (final) |
|---|---|---|
| vitest, package minus `src/terminal/**` | `1 failed \| 45 passed (46)` files · `2 failed \| 882 passed (884)` tests | **`46 passed (46)` files · `884 passed (884)` tests** |
| `tsc --noEmit` (app) | exit **2** — 2 errors, both `src/panels/detail/tabs.tsx` | **exit 0** |
| `tsc -p tsconfig.test.json --noEmit` | exit 2 — 2 errors, both `src/panels/bodies/SessionAnatomy.test.tsx` | exit **2** — same 2 errors, unchanged |

The 03:45 failures were **never mine** and are gone without any action by me: `src/auth/auth.test.tsx` (`ReferenceError: AuthBoard is not defined`) and `tabs.tsx` (`Cannot find name 'Composer'`) were other seats' files mid-edit — `AuthBoard.tsx` mtime `03:44`, my run `03:45`. Both seats landed their work in the intervening four minutes. **I report the earlier reading anyway rather than only the flattering one**, because a state report that quietly drops the run that looked bad is the failure mode D62 §1 exists to prevent.

**The two remaining test-typecheck errors are `src/panels/bodies/SessionAnatomy.test.tsx`, another seat's file.** Zero errors in `src/authoring/` in either config.

**WHY BOTH TSC CONFIGS WERE RUN, and it is not thoroughness for its own sake:** the main `tsconfig.json` **excludes `*.test.*`** (vitest compiles test files but does not typecheck them), so `bunx tsc --noEmit` alone is structurally blind to every type error in the 779 lines of tests I just wrote. Running only it would have produced a true statement about the wrong noun. `tsconfig.test.json` exists for exactly this and is the gate that actually covers my test files.

**My lane alone:** `bunx vitest run src/authoring` → 3 files, **41 tests, all passing**. Measured per file rather than apportioned by memory: `authoring.test.tsx` **31**, `authoring-seam.test.tsx` **5**, `no-kind-literals.test.ts` **5**.

## 9. GAPS — steps with no executor, and the data that does not exist

- **G1 — NO REGISTRY FIELD NAMES A KIND'S CREATE/PATCH COMMAND.** The oracle promises "＋ New on ANY plain kind … does exactly this", but nothing in `domain/types.ts` says whether a kind creates through `createTask` or `createEntity` (and patches through `patchTask` or `patchEntity`). `ListConfig.quickCreate` is a **boolean** — it says *that* a kind quick-creates, never *how*. Generic create for `doc`/`channel`/`collection`/`c:*` therefore cannot be built without either a kind literal in this lane (§15.2 build failure) or a new registry field (`domain/` is not my lane). **Built the task flow as directed; reported the missing field rather than inventing one.** Non-task `＋ New` is neither enabled nor broken by this work. Suggested shape: `KindConfig.authoring?: { create: 'task' | 'entity'; patch: 'task' | 'entity' }` — data, in `domain/`, where kind literals are legal.
- **G2 — `ListConfig.inlineEdit { status?, title? }` HAS NO CONSUMER anywhere in the tree.** Same defect class as D39 part 2 (`tile.badges`: 35 sources, zero readers). This flow is its first reader, and only if you wire 7b/7e to it.
- **G3 — WHICH KINDS LOCK THEIR TITLE IS NOT DATA.** T0-4 draws three locked cases, each with its own sentence: message ("title is the excerpt, never editable"), member ("identity is theirs"), commit ("tracked from GitHub"). Those are per-kind sentences ⇒ registry data (L2), and no field carries them. `InlineTitleEditor` takes `editable` + `lockedReason` and knows nothing about kinds; **until the field exists, every kind with `canEdit: true` will render an editable title, including tracked ones.** That is a real wrong state, not a cosmetic one. Suggested: `PanelConfig.titleLock?: string`.
- **G4 — description / priority / dueDate / acceptance have no EDITOR.** `useTaskSave` accepts all of them (`TaskEdits` is derived from `PatchTaskInput` by subtraction, so they are already wired end to end) but only the title and status have a UI. Adding one is a component, not a flow change.
- **G5 — no optimistic echo reconciliation.** `clientMutationId` is stamped on every command and the fixture seam echoes it on `entity.upsert`, but nothing in this lane journals or reconciles — the flow awaits the promise and the caller re-reads. That is honest and correct for a single client; it is **not** the store-side optimistic path the seam's docblock describes. If you want that, it belongs in the domain store, not here.
- **G6 — no undo.** `CommandResult.undo?: UndoToken` exists in the contract and is ignored. Named so it reads as unbuilt rather than unnoticed.

## 10. COLOR NEEDS

**None.** Every value the three frames draw already had a token name; the full hex→token mapping is written into the head of `authoring.css`. Nothing was added to `canvas-extra.css` and nothing needed to be. The only two brass alphas the oracle uses beyond `--pn-brand-soft` (`.20` hover, `.35` border) derive from `--pn-brand-rgb`, which `tokens.css` ships for exactly this, so both re-theme for free.

## 11. NOT CHECKED — stated plainly

- **NOT LOOKED AT IN A BROWSER.** Zero of this has been rendered on `:4612`, in either theme, at any width. jsdom has no layout engine and every defect that reached HEAD in this program was found by looking at the screen. Specifically unverified: whether the `au-title-input` at `height:24px` fits the header row without pushing the status pill; whether the conflict card's sentence wraps sanely at the 320 floor; whether `au-status__menu` is clipped by the panel's `overflow`; whether the editing pill + Cancel + Save fit beside `ActionBar inline` in the two-row header. **The status-picker clipping is the one I would check first** — a popover inside an `overflow:hidden` header is exactly the D35 class of defect, and it is invisible to all 41 of my tests. Ready for capture.
- **NOT RUN AGAINST THE REAL SEAM.** The gap test drives `createFixtureSeam()`. Whether a real node returns `current: EntityDetail` on a 409, or only `details.currentVersion`, or neither, is **unmeasured** — which is precisely why `currentVersion: number | null` exists and why the null branch renders disabled-with-reason instead of guessing. The null path has never been exercised against a real node.
- **NOT MEASURED: the mutation-id uniqueness window.** `au-{n}` is session-scoped and monotonic. Sufficient for echo reconciliation within one client, and it has **not** been tested against a real node's dedupe semantics. The comment in `commands.ts` says so rather than predicting.
- **NOT TESTED: two panels editing the same entity in one client.** Each `useTaskSave` holds its own `baseVersion`, so the second save would conflict against the first — probably the right behaviour, but designed-by-accident rather than designed, and unasserted.
- **NOT VERIFIED: `panels.css`'s `.pn-head__title--editable` vs my `.au-title--editable`.** Two selectors for one treatment now exist. I could not consolidate them (`panels.css` is not mine) and I did not diff their computed values.
- **NOT INVESTIGATED: the two `src/auth/auth.test.tsx` failures and the two `tabs.tsx` tsc errors.** Confirmed to be other seats' live edits by mtime and by `git status`; not diagnosed further, and NOT assumed harmless to those seats.
- **The `status-as-of` sha is the commit at the START of this seat.** Nothing was committed by me (no `git add`, no `git commit`, per the brief), and the working tree has moved under other seats during the window — so this file describes a tree that no sha names. That is stated rather than papered over with a stale stamp.
