# HANDOVER — T0-4 hub archetype (`HubBody`)

**status-as-of:** `756a9b0` · worker `sess_1785273201180_roff5xj0f` · task `task_1785273200656_22130s0t2` · written 2026-07-29

Code + tests done. **Not looked at in a browser.** Ready for capture.

> **File-location note (flagged, not argued):** the brief §4.7 says a new non-source artifact goes
> OUTSIDE `src/`; the quiet-protocol directive names this exact path inside `src/`. I followed the
> directive. Checked: this `.md` is invisible to every control — `hex-ban.test.ts` and
> `no-branching.test.ts` scan only `.css`/`.ts`/`.tsx`, and the vitest include glob is
> `src/**/*.{test,spec}.{ts,tsx}`. Move it if you'd rather honour §4.7; nothing depends on the path.
>
> This file is the record. The same content was sent as a session message before the quiet protocol
> arrived; that message is superseded by this file, not supplemented by it.

---

## 1. Screen + oracle region

`HubBody` = the `hub` archetype interior.

Oracle: `T0-1 workspace structure review (1)/T0-4 Entity Detail Panels Hi-Fi.dc.html`, **frame 2, the
CHANNEL region, lines 248–271** — the body div only; the chrome above it (231–247) and the footer
(272) are already built. Anatomy, in the oracle's order:

| region | oracle lines |
|---|---|
| description | 249 |
| PINNED chips | 250–256 |
| HUB TABS pills | 257–265 |
| latest-message card | 266–269 |
| redirect note | 270 |

Cross-read but **not** implemented: the Z4 HUB frame at lines 1030–1093 is a different surface (full
feed + composer + right rail), and diffing this body against it would be the sheet-commit-button
error.

## 2. Files

All NEW. Nothing else touched by me; nothing staged; no `git add` / `git commit` run.

| file | lines added |
|---|---|
| `packages/tm8-ui/src/panels/bodies/HubBody.tsx` | 262 |
| `packages/tm8-ui/src/panels/bodies/hub-body.css` | 102 |
| `packages/tm8-ui/src/panels/bodies/HubBody.test.tsx` | 249 |

**diffstat:** 3 files changed, 613 insertions(+), 0 deletions(-). (This handover file makes 4 —
created after the fact, on your order.)

**Tree dirt that is NOT mine**, so you don't attribute it to me — modified: `domain/menu.ts`+test,
`fixtures/index.ts`, `main.tsx`, `shell/menu-resolve.ts`+test, `terminal/index.ts`,
`terminal/terminal.css`, `views/GateApp.tsx`, `views/WorkspaceView.tsx`. Untracked:
`fixtures/graph.ts`, `graph/`, and the sibling bodies `ReaderBody.tsx`+test,
`SessionAnatomy.tsx`+test, `SubtreeBody.tsx`+test.

## 3. Divergences

**1. DRIFT, ACCEPTED — a RULING I MADE ALONE, reversible in one line** (`HubBody.tsx:120-122`).
Oracle line 260 draws the Feed pill BARE (`Feed`) while Tasks/Docs/Files carry counts (`Tasks · 12`);
the Z4 hub frame agrees (1048–1051). **Built:** every pill carries its count, so with today's fixture
the first pill reads `Feed · 148`.
*Why:* the contract types `ChannelTab.count` as a required `number`, the fixture authored feed=148
(equal to `counters.messages`), and suppressing a count a read actually produced is the same class of
dishonesty as printing `0` for something unmeasured — `chrome.tsx`'s `TabStrip` already states that
law in a comment. If you or the user prefer the oracle's bare Feed pill, it is one line here or one
field in the data.

**2. DRIFT, DATA NOT CODE.** Oracle draws `PINNED · 2` and FOUR tabs (Feed, Tasks·12, Docs·5,
Files·3). The fixture has one pin and three tabs with different counts, so the screen will read
`PINNED · 1` and three pills. See §6.

**3. RULED (D63.1).** The oracle frame draws a three-row chrome (crumb, header, a 32px action row at
240–244, then tabs). I did not build to that — D63 supersedes it with the two-row chrome, and the
chrome is not my file. No action; recorded so nobody re-opens it.

**4. RULED (R5 #9 / L6, following `chrome.tsx`'s `ActionButton`).** A pinned chip renders
DISABLED-WITH-REASON when no `onOpenEntity` handler is passed, instead of the oracle's live chip
(line 253 carries `cursor:pointer`). The check is structural, so the treatment disappears the moment
the host wires an opener. **Today the host does not** (§5) — so on the screen you capture, every
pinned chip will wear the disabled treatment until that is wired.

**5. RULING I MADE ALONE.** The oracle draws only the POPULATED latest-message card. I added the two
absence states, kept distinct: `messages === undefined` renders HOLLOW (a dash plus its reason — no
read ran); `messages === []` renders "No messages yet." (a read ran and found none). Both are one
quiet line, never an expanded empty region.

**6. NO NEW COLOUR.** Every byte in the region maps onto the existing ramp: `E7E3D9`=`--pn-line`,
`FFFFFF`=`--pn-card`, `5B564C`=`--pn-ink-2`, `8E897B`=`--pn-ink-3`, `B7B2A4`=`--pn-ink-4`,
`23201B`=`--pn-ink`, `rgba(178,106,43,.11)`=`--pn-brand-soft`, `9A581F`=`--pn-brand-2`. So: no
`canvas-extra.css` edit needed, no FIXTURE-NEED-style colour note, and dark carries no override in my
sheet.

## 4. Red first, then green

All runs from `packages/tm8-ui`, `bunx vitest` v4.1.10.

- **RED 1 — 2026-07-28T21:20:27Z**, `HubBody.test.tsx` alone, before `HubBody.tsx` existed:
  `Failed to resolve import "./HubBody"` → `Test Files 1 failed (1) · Tests no tests`.
- **GREEN — 2026-07-28T21:21:46Z**, after the component + css: `Test Files 1 passed · Tests 16 passed`.

Because a green that was never red *per assertion* is a claim, I then broke the component three times
and confirmed each probe bit only its own test, restoring byte-identically after each (verified by
`diff` against a pre-mutation copy):

| probe | mutation | result |
|---|---|---|
| A | remove the hollow branch | 11 failed — the hollow test by assertion, the rest by the crash it causes; the branch is load-bearing |
| B | collapse hollow into measured-empty **and** hide a zero tab count | exactly 2 failed (`renders HOLLOW when no message read has run`, `shows a measured ZERO rather than hiding it`), 14 passed |
| C | move the latest card below the redirect note | exactly 1 failed (`renders the five regions in the oracle order`), 15 passed |

**Recorded because it is the transferable bit:** my FIRST attempt at probe C was a no-op — I moved the
element past a JSX comment rather than past the block — and it stayed green. A mutation probe that
silently does nothing reads exactly like a passing test.

Restored and re-run: `Test Files 1 passed (1) · Tests 16 passed (16)`.

## 5. Wide check — timestamp · scope · instrument

```
2026-07-28T21:23:02Z | cwd packages/tm8-ui | bunx vitest run --exclude 'src/terminal/**'
banner: RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui
RESULT: Test Files 3 failed / 38 passed (41) · Tests 14 failed / 758 passed (772)
```

**All 14 failures are in three SIBLING files, none of them mine:**

- `src/panels/bodies/SubtreeBody.test.tsx` — 0 tests, dies at collect (`Failed to resolve import
  "./SubtreeBody"`) — a sibling's red-first, in flight.
- `src/panels/bodies/SessionAnatomy.test.tsx` — 16 tests, 13 failed.
- `src/panels/bodies/ReaderBody.test.tsx` — 16 tests, 1 failed.

I did not touch or investigate them beyond identifying them; flagging in case those seats don't yet
know the tree is red for them. **My file: 16/16 green in the same run.**

The two guards that scan my new files, run by name **2026-07-28T21:23:42Z**: `src/hex-ban.test.ts` +
`src/panels/no-branching.test.ts` → `Test Files 2 passed · Tests 10 passed`. So: no raw hex in
`hub-body.css` or `HubBody.tsx`, no kind literal, no `kind ===`, no `minmax(0,…)`.

```
2026-07-28T21:23:42Z | cwd packages/tm8-ui | bunx tsc --noEmit  →  CLEAN (zero output, whole package)
```

## 6. Fixture needs

I edited no fixture — `src/fixtures/` is not mine this round. In
`fixtureDetails[channelDesign.id]` (`fixtures/entities.ts:552`):

1. `content.pinned` is `[docLayoutSpec]`; the oracle draws TWO pins (`PINNED · 2`, a doc chip and a
   task chip). Adding e.g. `taskGuideLines` exercises a second glyph and the wrap behaviour.
2. `content.autoTabs` is three (feed 148 / tasks 4 / docs 1); the oracle draws FOUR, with `Files · 3`.
   A fourth tab exercises the pill row's wrap.
3. `content.topic` is `'tm8-ui build'` — three words, where the oracle's description line is a full
   sentence ("Where UI decisions get argued and settled."). A sentence-length topic is what actually
   exercises the 12.5px/1.55 prose measure and `text-wrap: pretty`. (The summary's `excerpt` already
   reads like one; the body reads `topic`, per the contract.)
4. **No `MessageView` fixture exists anywhere in `src/fixtures`** (grepped). The latest-message card
   has no fixture source at all. My test builds its own contract-typed `MessageView` locally from
   `messageAgentNullProvenance` + `forge`, with `createdAt` 11:48 against `FIXTURE_NOW` 12:00 — the
   oracle's exact "12m ago". That pattern is copyable into fixtures if you want it there.

## 7. Integration note

Component: `import { HubBody } from './bodies/HubBody'`.

**Props consumed** — the `GenericBody` shape plus two:

| prop | notes |
|---|---|
| `detail: EntityDetail` | required — same as `GenericBody` |
| `blocks: readonly ContentBlockRef[]` | required — same as `GenericBody`; `[]` is legal |
| `onOpenEntity?: (id: string) => void` | same as `GenericBody` |
| `messages?: readonly MessageView[]` | **NEW** — the panel already holds this prop and passes it to `DiscussionTab`; it is the ONLY source of the latest card |
| `now?: string` | **NEW** — injected only so "12m ago" is deterministic under test; omit in the app and it uses the render instant |

**`PanelBody` switch**, beside the terminal branch in `EntityDetailPanel.tsx` (~line 304):

```tsx
if (config.panel.archetype === 'hub') {
  return (
    <HubBody
      detail={detail}
      blocks={config.panel.blocks ?? []}
      messages={props.messages}
      onOpenEntity={onOpenEntity}
    />
  );
}
```

**Registry**, channel row (`registry.ts:418`, currently `panel: { archetype: 'hub', primaries:
['add-child'] }`) — add blocks:

```ts
blocks: [
  { block: 'items', label: 'PINNED', params: { source: 'pinned' } },
  { block: 'notice', params: { text: /* the redirect sentence */ } },
]
```

- the `items` block names which content member holds the pins and what the eyebrow says (defaults are
  `'pinned'` / `'PINNED'` if you declare none);
- the `notice` block carries the redirect sentence. **Copy it verbatim from `HubBody.test.tsx`
  lines 42–44 (`const REDIRECT`)** — it contains an em dash and the ⤢ glyph, and retyping it by hand
  is how it ships mangled;
- **no blocks at all is legal**: description, pins and tabs still render, and no redirect note does —
  the sentence names a specific surface, so the component will not invent one.

**TWO HOST GAPS, both visible on the screen the user will review.** Verified by reading
`views/WorkspaceView.tsx` `renderPanel` (2026-07-29): it passes neither `messages` nor `onOpenEntity`
to `EntityDetailPanel` today. Until `messages` is wired the latest-message card renders hollow
("— latest message", reason on hover); until `onOpenEntity` is wired every pinned chip renders
disabled-with-reason. Both are the honest states and neither is a defect in my body — but if you want
the oracle's populated card and live chips in the capture, those two props must be wired first, and
`messages` needs a real source (§9).

**CSS:** `hub-body.css` is imported from `HubBody.tsx` (the `shell/CommandPalette.tsx` precedent), so
`main.tsx` needs no edit.

## 8. D-entry I am offering to author

Not written yet — say the word and I'll send the text. A hub-archetype entry would carry: the anatomy
and its fixed order; that the body reads description/pins/auto-tabs STRUCTURALLY and takes only the
pin source+label and the redirect sentence from registry blocks (so a second kind can declare
`archetype: 'hub'` with no code change); the two-absence rule for the latest card; and divergence 1
above if it survives review.

## 9. NOT CHECKED — stated plainly

- **I have not looked at this in a browser.** No `:4612`, no themes, no zoom, no capture. Everything
  above is jsdom plus reading the oracle bytes. Every layout claim in my CSS — the ellipsis on the
  latest line, the pill row wrapping, the body scrolling at panel floor widths — is unverified by the
  only instrument that can see layout.
- Dark theme is asserted **by construction only** (tokens throughout, no per-theme override in my
  sheet). I have not seen it rendered dark.
- I did **not** open `src/data/**` and therefore do **not** know whether a seam capability exists to
  READ a channel's messages. Confirm that before wiring `messages`, or the card stays hollow no
  matter what the panel passes.
- I did not check how the hub body behaves inside the peek / pinned / z4 hosts, only that it renders.
- I ran nothing outside `packages/tm8-ui`, and never ran vitest from the repo root.
- I did not investigate the three failing sibling files beyond naming them.
- The 16 tests cover the anatomy and its order, both absence states, the archetype-not-kind claim (a
  `collection` detail rendered through the same component with a different content member), and the
  no-blocks case. They do **not** cover keyboard interaction, aria beyond what the kit already
  provides, or long-title overflow.
