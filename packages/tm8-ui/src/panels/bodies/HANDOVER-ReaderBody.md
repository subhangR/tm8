# HANDOVER — ReaderBody (the `reader` archetype body)

**status-as-of:** `756a9b0` (working tree, uncommitted) · Worker: `sess_1785273196418_lmmemzx59` · task `task_1785273196059_sdzahqli5` · written 2026-07-29 02:5x +0530

> Same content as the handover already sent by message at 02:55 +0530 (that message was sent before the quiet protocol arrived). **This file is the record.**

> **A ruling that creates a file names the controls that will see it** (brief §4.7 / D62.3). This file sits INSIDE `src/`, which §4.7 says non-source artefacts should not — placed here on the coordinator's explicit instruction under the quiet protocol. Checked before writing: `src/hex-ban.test.ts` filters `.css` (styleFiles) and `.ts|.tsx` (sourceFiles); `panels/no-branching.test.ts` filters the same two sets. **Neither scans `.md`**, so the hex values quoted below cannot turn the package red. If a future guard widens to all files under `src/`, this file is the first thing it will hit.

---

## 1. Screen + oracle region

`ReaderBody` is the **reader archetype's Content-tab interior**. Oracle: `T0-1 workspace structure review (1)/T0-4 Entity Detail Panels Hi-Fi.dc.html`

| Region | Oracle lines | Use |
|---|---|---|
| frame 2 `<!-- DOC -->` | 325–361 (body div: 345–353) | **the built target** |
| Z4 `<!-- READER (doc) -->` | 984–1027 | cross-read; full-width measures recorded, not shipped |
| `<!-- DARK DOC -->` | 1321–1352 | dark pairing |

Anatomy shipped, top → bottom, exactly the oracle body div's children:

1. **outline chip row** — mono pills, `display:flex;gap:5px;flex-wrap:wrap` (line 346)
2. **reading column** — serif prose paragraphs with rule-quoted lines between them (349, 350)
3. **facts line** — `4 chapters · markdown` … `history ▸`, above a `--pn-line` rule (352)

---

## 2. Files (all NEW; nothing else in the repo touched; **no `git add`, no `git commit`**)

| File | Lines |
|---|---|
| `src/panels/bodies/ReaderBody.tsx` | 302 |
| `src/panels/bodies/reader-body.css` | 141 |
| `src/panels/bodies/ReaderBody.test.tsx` | 330 |
| `src/panels/bodies/HANDOVER-ReaderBody.md` (this file, coordinator-ordered) | — |

`reader-body.css` is imported **from the tsx**, per the directive. Note this diverges from the house convention where every other stylesheet is imported in `main.tsx` — move it if you prefer one home.

---

## 3. Integration note (what you wire)

```tsx
import { ReaderBody } from './bodies/ReaderBody';

// EntityDetailPanel.PanelBody, beside the terminal arm:
if (config.panel.archetype === 'reader') {
  return (
    <ReaderBody
      detail={detail}
      blocks={config.panel.blocks ?? []}
      historyUnavailableReason={reasons.versionHistory}
      onOpenEntity={onOpenEntity}
    />
  );
}
```

**Props I consume, exactly:**

- `detail` — `content.body` ?? `content.description` (prose); `content.format` ?? `state.format`; `state.childCount`; `hierarchy.children.items`; `detail.kind` **only** via `getKind()` for the empty-state glyph (GenericBody's precedent).
- `blocks` — two block kinds only: `notice` → an honest sentence under the column; `items` → `params.source` names the content member holding the outline (else hierarchy children). Any other declared block renders nothing, same as `GenericBody`'s `default: return null`.
- `historyUnavailableReason` — **REQUIRED, not optional.** An optional reason is how a control ends up live-and-inert; `reasons.versionHistory` is the value the panel already holds.
- `onOpenEntity` — optional; absent ⇒ chapter chips render disabled-with-reason, never live-and-dead.

**Registry:** the `doc` row already declares `archetype: 'reader'` and needs **no** block additions — `blocks={[]}` is a valid, complete reading column. Registry blocks are additive only.

**Accessibility/plumbing:** root is `.pn-body` with `id="tabpanel-content" role="tabpanel" aria-labelledby="tab-content"`, same as `GenericBody`, so the tab strip's `aria-controls` still resolves.

---

## 4. Divergences

### RULED

1. **`history ▸` renders DISABLED-WITH-REASON**, not the oracle's live brass link (line 353). Charter **R7**: a deferred verb is disabled-carrying-its-reason, never a live control that does nothing. Position and word are the oracle's; only the treatment changes. It duplicates the chrome footer's `v{n}` deferral home — the oracle draws both too, and both carry the same reason, so this duplicates an *affordance*, not a *claim*.
2. **Chrome is not restated.** The oracle body sits under a 3-row chrome and above a `v3 · autosaved · 2 readers now` strip. **D63** rules two-row chrome; `PanelFooter` already owns presence (hollow per **D7** — "2 readers now" would be a lie of precision) and version. "autosaved" is a fact we do not hold and is not invented. No file of mine touches any of it.
3. **Z4 measures NOT shipped.** The reader frame draws the same column at 16.5px/1.75 with a 700px measure and a 300px thread rail (lines 996–1020). That is a Z4 variant nobody has built; the panel values ship and the Z4 pair is recorded in a CSS comment rather than guessed at.

### DRIFT / NOTED — your call to ratify

4. **TOC chip background.** Oracle light `#FFFFFF` on a `#FBFAF6` panel; oracle dark `#1B1810` on a `#221E15` panel (recessed — **the relationship inverts in the oracle's dark**). Our `.pn-panel` is `--pn-surface` in *both* themes (`panels.css:285`), so I used `--pn-card` (kit-chip precedent), which reproduces the light relationship in both. Light is byte-exact; dark is one token step off the oracle by construction. Flagged rather than fixed with a per-theme override, which **L8** calls the mis-tokenisation smell.
5. **The reading column ships no heading style** — markdown headings are promoted into the OUTLINE instead of restated in the column. Reason is D5-shaped: the oracle's in-panel column draws prose and quote only, so any in-panel heading size would be eyeballed. *Ruling made alone; ratify or reverse.*
6. **Heading-derived TOC chips are LABELS** (`<span>`, no cursor, `title` explaining), not controls: in-document anchoring is not built, and the oracle draws them clickable. Entity-backed chips ARE live (`onOpenEntity`) and go disabled-with-reason when no dispatch is supplied. *Ruling made alone.*

---

## 5. COLOR NEED — `--pn-x-prose-ink` (I did not hex it)

- **MEASURED PAIR:** light `#3A362E` (oracle line 349, also 1007) / dark `#D8D0BE` (oracle line 1345, whose own note reads *"serif body lightens to #D8D0BE, never pure white"*).
- **Maps to no token:** not `--pn-ink` (`#23201B` / `#EFE9DB`), not `--pn-ink-2` (`#5B564C` / `#BDB5A2`).
- **Not derivable:** `color-mix(ink, paper)` lands 2–7 units off per channel in both themes at every single ratio checked; 88–89% is closest and still wrong in green/blue.
- **TRAP:** `--pn-x-btn-ink-hover` is already `#3A362E` in light **for an unrelated reason** (the R5 ink-chip hover). Borrowing it would be exactly the mis-tokenisation the hex guard exists to prevent, and its dark value derives ink→paper, nowhere near `#D8D0BE`. **Do not alias them.**
- **Interim in my file:** `color: var(--pn-x-prose-ink, var(--pn-ink))` — hex-free today, correct the instant the pair lands in `canvas-extra.css`. Until then the prose is one step too strong in both themes. The CSS comment states that as a measurement, not a prediction.

---

## 6. Fixture needs (I edited no fixtures)

1. **`docLayoutSpec` detail (`src/fixtures/entities.ts:589`) has no blockquote line**, so the quote treatment — a real oracle element — is invisible on the live screen. Add a line starting `> ` (e.g. the oracle's own `> C_min = max(320, V·320 + (V−1)·8)`).
2. **Same fixture: `state.childCount: 4` with an EMPTY `hierarchy.children`.** A genuine two-source case; my body renders the honest `4 chapters recorded · outline not loaded`. Correct behaviour, but it means the live screen shows **no chips** unless four doc children are added — the oracle's four are *Shell regions*, *C_min formula*, *Floors*, *Responsive*. **Recommend:** add them so the capture shows the chip row, and keep a SECOND doc fixture with the count-without-children shape so the honest-absence state stays visible too.
3. **No fixture exercises a second reader kind.** My archetype test builds a local contract-typed `collection` detail; a real fixture would let the user see the same anatomy for another kind on screen.

---

## 7. Red-first record

**RED 1 — absent component**, 02:50:26 +0530, `bunx vitest run src/panels/bodies/ReaderBody.test.tsx`:

```
Error: Failed to resolve import "./ReaderBody" from "src/panels/bodies/ReaderBody.test.tsx". Does the file exist?
 Test Files  1 failed (1)
      Tests  no tests
```

**GREEN**, 02:53:16 +0530, same command: `Test Files 1 passed (1) / Tests 16 passed (16)`.

**RED 2 — the assertion-bites check.** I injected the exact defect the honesty test exists for (drawing N chips from `state.childCount` when the outline is empty) and re-ran:

```
× states the gap instead of inventing chips when the record claims chapters we do not hold
AssertionError: expected [ <span …(3)></span>, …(7) ] to have a length of +0 but got 8
      Tests  1 failed | 15 passed (16)
```

(8 = 4 invented chips × 2 theme scopes.) Defect reverted; suite green again. **That assertion is measured, not decorative.**

---

## 8. Wide check — timestamp + scope + instrument

**INSTRUMENT:** `bunx vitest`, banner `RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui` (run FROM `packages/tm8-ui`, never repo root); `bunx tsc --noEmit`, same cwd.

| When (+0530) | Scope | Result |
|---|---|---|
| 2026-07-29 02:54:06 | whole package | `tsc --noEmit` → **0 errors** |
| 2026-07-29 02:53:39 | `--exclude 'src/terminal/**'` | Test Files 2 failed \| 39 passed (41); Tests **13 failed \| 759 passed (772)** |
| 2026-07-29 02:54:12 | above **+** the three sibling in-flight files | Tests **756 passed (756)**, 39 files (740 pre-existing + my 16) |
| 2026-07-29 02:54:35 | `src/hex-ban.test.ts src/panels/no-branching.test.ts` | **10 passed** |

**The 13 failures and 1 collect error are NOT mine** — sibling seats' in-flight untracked files in the same directory: `SessionAnatomy.test.tsx` (13 failed), `SubtreeBody.test.tsx` (collect error, 0 tests), and with those excluded a third, `ProfileBody.test.tsx`, fails to resolve `./ProfileBody` (a seat mid red-first, the same state I was in at 02:50). Reported rather than assumed known.

Both guards scan my two new source/style files: **zero raw hex, zero kind literals, no `kind ===`, no `minmax(0,…)`.**

**Other dirt in the tree that is NOT mine** (`git status`, `packages/tm8-ui/src`): `M` `domain/menu.ts`+test, `fixtures/index.ts`, `main.tsx`, `shell/menu-resolve.ts`+test, `terminal/index.ts`, `terminal/terminal.css`, `views/GateApp.tsx`, `views/WorkspaceView.tsx`; `??` `fixtures/graph.ts`, `graph/`, `bodies/HubBody.*`, `bodies/SessionAnatomy.*`, `bodies/SubtreeBody.*`, `bodies/ProfileBody.test.tsx`.

---

## 9. D-entry text I am authoring (yours to ratify, edit or reverse)

> **READER ARCHETYPE: the outline is what we HOLD, the count is what the record CLAIMS.** A doc's `state.childCount` and its `hierarchy.children` are two sources; the reader draws one chip per child it was actually given, falls back to the document's own headings, and where the record claims chapters the outline does not hold it STATES the gap in one quiet mono line rather than inventing chips. The reading column ships no heading style — the oracle's in-panel column draws prose and quote only, so a heading size would be eyeballed (D5), and headings are promoted into the outline, which is the place the oracle actually gives them. Heading-derived chips are labels, entity-derived chips are controls, and a control without a dispatch is disabled-with-reason (R7).

---

## 10. NOT CHECKED — stated plainly

- **I have NOT seen this render in a browser.** jsdom cannot see the reading measure, the chip row's wrap, whether the facts line clips at 389px, or whether the serif column reads at 15px under the 1.1× zoom lever. Ready for capture; both themes need eyes.
- **The prose colour on screen is the FALLBACK** (`--pn-ink`), not the measured pair. Any capture taken before `--pn-x-prose-ink` lands shows prose one step too strong — judge the colour after the token, not from that capture.
- I did **not** test long-title ellipsis on a chip, an outline of 20+ chapters, or a 32KB body (no fixture has one). Overflow behaviour in the chip row and the body scroller is unwitnessed.
- I did **not** verify a non-markdown format (mermaid/excalidraw docs). Design intent: they land in the same column and read as prose (the honest floor); no fixture exercises it.
- **No test asserts my CSS actually applies** — vitest does not load stylesheets. Every geometry/colour claim above is a source-to-oracle comparison, not a rendered measurement.
- I did not touch the seam, so nothing here reads liveness; there is no two-source liveness risk on this screen.
