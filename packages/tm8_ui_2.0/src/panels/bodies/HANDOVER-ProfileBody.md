# HANDOVER — ProfileBody (the `profile` archetype)

**status-as-of:** `756a9b0` (HEAD at handover; my three files are UNCOMMITTED and untracked) · worker `sess_1785273197697_2xeh1s1l2` · task `task_1785273197416_crn5mrsla` · written 2026-07-29 03:0x IST / 2026-07-28 21:3x UTC

> Filed as a FILE per the quiet-protocol directive. Noting the tension rather than hiding it: brief §4.7 says a new non-source artifact goes OUTSIDE `src/`. The coordinator's path instruction is newer and explicit, and four sibling handovers already sit here, so I complied. Controls checked before writing it: `hex-ban.test.ts` filters `.css` only, `no-branching.test.ts` filters `.ts/.tsx` only, vitest `include` is `*.{test,spec}.{ts,tsx}` — a `.md` here is invisible to all three. Verified, not assumed.

---

## 1. Screen + oracle region

**The PROFILE archetype body — both variants, one component.**

Oracle: `T0-1 workspace structure review (1)/T0-4 Entity Detail Panels Hi-Fi.dc.html`, section `#kinds` ("All 12 kinds — Content"):

| variant | oracle lines | anatomy |
|---|---|---|
| human member | **400–448** (`<!-- MEMBER -->`) | identity header (40px round avatar, name, role tag, `human member · ● online`), 3 stat tiles, `TEAMMATES OWNED` chips, `CURRENT WORK` chips |
| agent teammate | **452–496** (`<!-- AGENT -->`) | persona prose, `Model/Tool/Owner/Memories` 2-col grid, working-on row, `EQUIPPED · 2` chips, `RECENT SESSIONS` rows |

Cross-read but **out of scope**: the Z4 full-view PROFILE frame at lines **1097–1160** (700px measure, right THREAD rail, `DEFAULTS` block, 44px avatar, 17px stat values). Not built, not attempted — see §8.

**No `kind ===` anywhere.** The two screens are the same code path; the difference is entirely the block list the registry row carries. `ProfileBody.test.tsx` proves it by rendering the MEMBER block list against the AGENT's detail and getting the member anatomy back.

---

## 2. Divergences from the oracle

### RULED (a ledgered rule wins over the pixel)

1. **The working-on row's green `● live` is NOT drawn.** Oracle line 479 paints an 8px `#3E8E5A` dot with `animation:pnPulse` and a mono `● live` on the right. The record it is drawn from is the contract's `LiveWork` = `{actor, task, startedAt, note}` — **it carries no session reference**, so there is no id to hand `livenessOf` and the only way to paint that dot is to infer liveness from a stored record. That is the inference D6 forbids, D27 names ("unknown is never shown as live"), and D39 found reaching the user's screen. Built: the record's real facts (task + `since 2m ago`), a hollow ink-4 **ring** instead of the green fill, and a hollow `— unverified` verdict slot whose `title`/AT text states why. Cites: D6, D27, D39, brief §2.7, D7.2 (the hollow idiom). **Reversible the moment `LiveWork` gains a session ref — the row needs no other change.** See §6.
2. **`● online` in the member caption is hollow.** Oracle line 424 reads `human member · ● online`. Presence is measured-empty on every node (D7.2) — a green `online` claims a measurement nobody took. Built: `human member · — presence`, reason on hover and to AT. Cites D7.2, and it is the same treatment `PanelFooter` already gives `— viewing`.
3. **Session-row glyph comes from the registry, not the canvas.** Oracle line 490 draws `▣`; the registry's `work_session` row declares `▸`. `registry.ts`'s own docblock rules glyphs to be DATA ("replacing them with the canvas-extracted set … is a DATA edit here and touches no component"), so the body renders `getKind(peer.kind).chip.glyph`. If you want `▣` on sessions everywhere, that is one character in `registry.ts` — your file, and it moves every surface at once.
4. **No hairline between profile blocks.** `.pn-section` (which `GenericBody` uses) draws a `--pn-line` bottom rule; the oracle draws none between these regions (line 418: plain `gap:12px`). The hairline rule agrees — `--pn-line` BOUNDS a component and these are regions inside one body — so this body uses `.pn-profile__block` (no border, `gap:5px` per the label's `padding-bottom:5px` at line 433).

### DRIFT (built ≠ oracle, no rule behind it — your call)

| # | oracle | built | where | why / remedy |
|---|---|---|---|---|
| D1 | identity avatar **40px**, font 17px (line 420) | **32px**, font 14px | `ProfileBody.tsx:~250` | `AvatarSize` is a closed union `15\|20\|22\|32` in `kit/Avatar.tsx` — **not my file**. Remedy: add `40` to the union + `FONT` map (2 lines in kit), then change `size={32}` → `size={40}`. Or ratify 32. |
| D2 | `CURRENT WORK` chip reads `◔ T-114 · working` (line 442) | reads `<title> · <status>` **only when the registry row passes `params.statusKey`** | `ItemsBlock` | Implemented, but it needs the registry to name the state key (see §4). The alternative — resolving `StatusSource → state key` from the registry — would be a THIRD copy of the `STATUS_FIELD` map, which already exists at `panels/detail/chrome.tsx:194` and `graph/GraphView.tsx:63` and is in neither's shared home. **Proposed D-entry in §7.** |
| D3 | session row reads `forge — running · task T-114 · 2m` (line 490) | `forge — running · 2m` (no task) | `SessionRowsBlock` | The row is built from the connections edge peer, an `EntitySummary`; a session's `workingOn` lives in its **content**, which the peer summary does not carry. Fixing it means a second read the panel does not do today. Stated, not papered over. |
| D4 | session row is **monochrome** `#5B564C` throughout (line 490) | the verdict word is **tinted by tone** (`run/wait/block/idle`) | `profile-body.css` `.pn-profile__word` | **A ruling I made alone — ratify or reverse.** Everywhere else in this app status is color + word (L10, D22), and monochrome makes `exited` and `running` read identically on the one surface where confusing them is the named defect (D39). The word is always present, so color is never the only carrier. One CSS block to revert. |
| D5 | `RECENT SESSIONS` shows **two** rows (lines 489–491) | shows **one** | fixture, not code | Only `sessionTeammateEdges.forge` links a session to forge. See §6. |

---

## 3. Files (mine, all three NEW, all UNCOMMITTED — I ran no `git add`/`git commit`)

```
src/panels/bodies/ProfileBody.tsx        647 lines   (new)
src/panels/bodies/profile-body.css       266 lines   (new)
src/panels/bodies/ProfileBody.test.tsx   295 lines   (new, 15 tests)
src/panels/bodies/HANDOVER-ProfileBody.md            (new, this file — per your directive)
```

`profile-body.css` is imported **from `ProfileBody.tsx`**, as instructed — nothing to add to `main.tsx` or `panels/index.ts`.

**I edited nothing else.** Everything below was already dirty in the tree when I started and is NOT mine — flagging rather than assuming you know:

```
 M src/domain/menu.ts · menu.test.ts        M src/shell/menu-resolve.ts · .test.ts
 M src/fixtures/index.ts                     M src/main.tsx
 M src/views/GateApp.tsx · WorkspaceView.tsx M src/terminal/index.ts · terminal.css
 ?? src/graph/ · src/fixtures/graph.ts · src/terminal/{LiveTerminal.tsx,pty/,…} · src/terminal-dev.tsx
 ?? sibling bodies: Hub/Reader/Subtree/SessionAnatomy (+ their css/tests/handovers)
```

No filename, class-name (`pn-profile__*`) or exported-symbol collision with the sibling bodies — checked by grep, not assumed.

---

## 4. INTEGRATION — what you need to wire

### 4.1 The component

```tsx
import { ProfileBody } from './bodies/ProfileBody';

if (config.panel.archetype === 'profile') {
  return (
    <ProfileBody
      detail={detail}
      blocks={config.panel.blocks ?? []}      // assignable with NO cast — asserted by a test
      livenessOf={props.livenessOf}           // NEW panel prop, see 4.3
      onOpenEntity={onOpenEntity}
    />
  );
}
```

Props I consume, against `GenericBody`'s shape: **`detail`**, **`blocks`**, **`onOpenEntity`** — same three, same meanings. Added: **`livenessOf?: (id: string) => SessionLiveness`** (the `EntityListPanel`/`RosterPopover`/`LiveSessionBar` idiom, not a new one) and **`now?: string`** (injected clock, the `GraphView` precedent; defaults to the wall clock, tests pass it).

`blocks` is typed `readonly ProfileBlockRef[]` — `ContentBlockRef` **widened at `block` to `string`**, because the block names below are additions to the closed `ContentBlockKind` union in `domain/types.ts`, **your file**. `readonly ContentBlockRef[]` is assignable to it *today* (compile-proved by a test, and I reddened that proof to check it can fail). When you add the names to the union, nothing here changes.

### 4.2 Registry rows — paste-ready

`member` row, add to `panel`:

```ts
blocks: [
  { block: 'identity', params: { provenance: 'human', tagKey: 'role', caption: 'human member', presence: true } },
  { block: 'stat-tiles', params: { tiles: 'taskDoneCount=tasks done,score=points,teamMembers=teammates' } },
  { block: 'items', label: 'TEAMMATES OWNED', params: { source: 'teamMembers' } },
  { block: 'items', label: 'CURRENT WORK', params: { source: 'work', statusKey: 'workStatus' } },
],
```

`team_member` row, add to `panel`:

```ts
blocks: [
  { block: 'bio', params: { source: 'identity' } },
  { block: 'field-grid', params: { fields: 'model=Model,agentTool=Tool,owner=Owner,memories=Memories' } },
  { block: 'live-work', params: { source: 'liveWork' } },
  { block: 'items', label: 'EQUIPPED', params: { source: 'equipped', count: true } },
  { block: 'session-rows', label: 'RECENT SESSIONS', params: { edgeType: 'relates_to', direction: 'incoming' } },
],
```

`ContentBlockKind` additions needed: `'identity' | 'bio' | 'stat-tiles' | 'field-grid' | 'live-work' | 'session-rows'`. **`'items'` is already there and I reuse it deliberately** — one block name, one meaning, two renderers (`GenericBody` and this).

**Block vocabulary (the full contract):**

| block | params | notes |
|---|---|---|
| `identity` | `provenance:'human'\|'agent'`, `tagKey` (state key → the role tag), `caption` (static words), `presence:boolean` | `presence` adds the hollow presence mark, never an `online` claim |
| `bio` | `source` (content key) | absent/empty ⇒ block renders nothing |
| `stat-tiles` | `tiles: 'key=Label,…'` | key looked up in `state` then `content`; an array counts; absent ⇒ hollow `—` + reason, never `0` |
| `field-grid` | `fields: 'key=Label,…'` | scalar → mono; array → its length; actor → `◯/◇ @name`; absent → hollow |
| `items` | `source`, `count?:true`, `statusKey?`, `empty?` | `count` puts `· N` on the eyebrow (`EQUIPPED · 2`); the count is of the same list rendered, so they cannot disagree |
| `live-work` | `source` (state key, default `liveWork`), | absent record ⇒ one quiet line, never a shouted empty |
| `session-rows` | `edgeType`, `direction:'incoming'\|'outgoing'`, `empty?` | peers off `detail.connections`, verdict via `livenessOf` |

The `'key=Label,…'` params are a mini-DSL **only because `ContentBlockRef.params` is `Record<string, string|number|boolean>`** — a list cannot be expressed any other way today. The parsers already accept a real `string[]` too, so if you widen `params`, the registry can pass arrays and this body needs no edit. Your call.

### 4.3 `livenessOf` on the panel

`EntityDetailPanel` today carries a single `liveness?: SessionLiveness` (the panel's OWN session). The profile body needs a **lookup** — it renders other entities' sessions. Add `livenessOf?: (id: string) => SessionLiveness` to `EntityDetailPanelProps` and thread the shell's existing one (the same function `EntityListPanel` and `LiveSessionBar` already receive). Without it the rows read `unverified` — honest, and visibly not-wired, which is the intended failure mode.

---

## 5. Red-first record, and the checks

### Red (measured, not claimed)

Test file written first, then a deliberate stub body (`return <div className="pn-body" data-testid="profile-body" />`) so the red is at the ASSERTION level, not an unresolved import:

```
$ bunx vitest run src/panels/bodies/ProfileBody.test.tsx     # 02:54:55 IST
 Test Files  1 failed (1)
      Tests  13 failed | 1 passed (14)
```

The one pass was the registry-seam test, which scans `panel.blocks` on the profile rows — currently empty, so it passes vacuously. That is documented in its own docblock rather than hidden; it becomes load-bearing the moment §4.2 lands.

The 15th test (§4.1's no-cast assignability) was added after and is a **compile-time** assertion, so I reddened it separately by narrowing `ProfileBlockRef['block']` to the profile-only union:

```
src/panels/bodies/ProfileBody.test.tsx(281,11): error TS2322:
  Type 'readonly ContentBlockRef[]' is not assignable to type 'readonly ProfileBlockRef[]'.
      Type '"fields"' is not assignable to type '"items" | "identity" | …'
```

…then restored the file and re-verified green. Both directions measured.

### Green

```
$ bunx vitest run src/panels/bodies/ProfileBody.test.tsx     # 03:01:49 IST
 Test Files  1 passed (1) · Tests  15 passed (15)
```

### Wide check

- **timestamp:** 2026-07-28 **21:31:09 UTC** (= 2026-07-29 03:01 IST — this machine's clock is UTC+0530 and the two readings are the same instant)
- **scope:** the whole `tm8-ui` package **minus `src/terminal/**`** (`--exclude 'src/terminal/**'`), plus a full `tsc --noEmit`
- **instrument:** `bunx vitest` **v4.1.10**, banner path `…/packages/tm8-ui`, run **from `packages/tm8-ui`** (never the repo root); `bunx tsc` from the same cwd

```
 Test Files  42 passed (42)
      Tests  806 passed (806)
 tsc --noEmit → exit 0
```

Guards specifically re-run and green over my files: `src/hex-ban.test.ts` (scans `profile-body.css` — **zero raw hex; I added nothing to `canvas-extra.css` and needed nothing**, both frames' colours all resolve to existing tokens) and `src/panels/no-branching.test.ts` (scans `ProfileBody.tsx` — no kind literal, no `kind ===`, no `minmax(0`).

**One instrument trap, recorded because it bit here:** `tsconfig.json` **excludes `*.test.tsx`**, so `bunx tsc --noEmit` does *not* typecheck test files. The test file was typechecked by naming it explicitly:

```
bunx tsc --noEmit --jsx react-jsx --module ESNext --target ES2021 --moduleResolution Bundler \
  --strict --skipLibCheck --resolveJsonModule --lib ES2021,DOM,DOM.Iterable \
  src/panels/bodies/ProfileBody.test.tsx      # → exit 0
```

**READY FOR CAPTURE** once §4.2/§4.3 are wired.

---

## 6. Fixture needs (I edited no fixtures)

Everything renders off today's fixtures; these would exercise states the screen has but the data cannot currently reach:

1. **A second session edge on `teamMemberForge`** — an *exited* one. Today only `sessionTeammateEdges.forge` (→ `sessionLive`) exists, so `RECENT SESSIONS` draws one row where the oracle draws two, and the exited/idle row styling is untested against real data. Adding a `relates_to` edge from an exited session summary to forge is the whole fix.
2. **`LiveWork` needs a session reference — CONTRACT, not fixture.** This is the §2-RULED item. `packages/contract/src/contract.ts:` `interface LiveWork { actor; task; startedAt; note? }`. With a session ref (or a session summary) on it, the working-on row can carry a real `livenessOf` verdict and match the oracle exactly. I could not even *test* that path without fabricating a shape the contract forbids, which is why there is no speculative code for it. Routed to you: contract is off-limits to me.
3. **A member with `teamMembers: []` / `work: []`** — the empty chip rows are covered via `teamMemberScout`, but not on a member entity.
4. **A member whose `score`/`taskDoneCount` is genuinely absent** — the hollow-stat path is covered (by pointing a tile at a key `team_member` lacks), but not on a realistic member record.

---

## 7. D-entry texts I am authoring (and rulings I made alone)

**Proposed D — `StatusSource → state key` has two homes and no owner.**
> The map `{workStatus, sessionStatus→status, prState→state, profileStatus→status, memberRole→role, equipped}` exists independently at `panels/detail/chrome.tsx:194` and `graph/GraphView.tsx:63`. A third consumer (the profile chip row) declined to make a third copy and took the key from registry DATA (`params.statusKey`) instead. Ruling wanted: either (a) `domain/` exports `statusValueOf(summaryOrState, source)` and all three consume it — then `params.statusKey` is deleted from the profile blocks — or (b) `params.statusKey` is ratified as the block-level answer and the duplication is accepted as two lane-local copies. Not decided by me; the smaller footprint was chosen so the decision stays open.

**Proposed D — the profile block vocabulary.** §4.2's table, once ratified, is the D-entry text: six additions to `ContentBlockKind`, `items` reused, and the `'key=Label'` params being a consequence of `params` allowing scalars only.

**Rulings I made ALONE, flagged for ratification or reversal:**

1. **DRIFT D4** — tinting the session-row verdict word (oracle is monochrome). One CSS block reverts it.
2. The working-on row's hollow verdict (§2 RULED #1). I believe the ledger forces it, but it *is* a visible departure from a frame the user will look at, so it should be your call at capture time, not discovered on screen.
3. Importing `presentSession`/`toSessionRow` **module-deep** (`terminal/session-presentation`, `terminal/session-row`) rather than through `terminal/index.ts`, which `TerminalBody` uses. Reason, measured: the barrel re-exports `LiveTerminal`, which pulls xterm into the graph — through the barrel this test file emitted jsdom's `HTMLCanvasElement.getContext` warning; module-deep it does not. Read-only either way, so the charter carve is respected; the deviation from `TerminalBody`'s import style is deliberate and commented in the file.

---

## 8. NOT CHECKED — stated plainly

- **I have not seen this screen.** No `:4612`, no browser, neither theme, no hard reload. It cannot be reached until the registry rows and `livenessOf` are wired (§4), which is your file. Every defect that reached HEAD last night was found by rendering the thing, and this one has not been rendered. **Treat §2's divergence list as complete only for what jsdom can see.**
- **Dark theme is reasoned, not observed.** Every value is a token, so it should invert for free (design law 8), and I wrote no per-theme override — but "should" is the word, and I did not open the T0-4 `#dark` section (line 1273) to check whether the profile frames are redrawn there.
- **Narrow widths / the 220px panel floor.** The 3-across stat grid and the two-column field grid are oracle-verbatim at the 389px frame width. I set `min-width:0`+`overflow:hidden` on the tiles so they share the row instead of overflowing, but I have not *seen* them at the floor, and jsdom cannot tell me whether a label clips.
- **The Z4 full-view PROFILE frame (oracle 1097–1160)** — different measure, a right-hand THREAD rail, a `DEFAULTS` block, 44px avatar, 17px stat values. Not in scope, not built, not diffed.
- **Real-seam data.** Everything here ran against `src/fixtures/`. I never exercised the body against a live server payload, so I have not seen what a real `member`/`team_member` detail's `content`/`state` actually carries versus what the fixtures assert.
- **`params.count` counts the `items` source only.** If you put `count: true` on a non-`items` block it yields `· 0`, silently. Not guarded, because no registry row does it — stated so it is a known hole rather than a surprise.
- **Accessibility beyond structure.** Roles/labels are in place (`tabpanel`, `aria-hidden` glyphs, hollow reasons reachable via `title` + hidden text). No screen-reader run, no keyboard-order pass, no contrast measurement.
