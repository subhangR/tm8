# CODEX-REVIEW — three uncommitted UI branches

Reviewed 2026-08-30/31 against `wt-calm-int` HEAD `a47c841a`. All three worktrees
branch from `f0787580`. **Review complete for all three.** Nothing was merged,
committed, built into, or deployed from any worktree.

## How this was verified

- Diff read in full for every changed file in all three worktrees. The REPORT.md
  claims were checked against the diff, not accepted.
- `npx vitest run --maxWorkers=1 <their dir>` run once per worktree, sequentially,
  never in parallel. No run came near the 30 s `testTimeout`; no starvation.
- `wt-cx-board` and `wt-cx-graph` had **no `node_modules`** (their agents removed
  them). I symlinked `wt-cx-settings`' tree in to run their tests and **removed
  the symlinks afterwards** — `git status` in both is back to exactly the four /
  two modified files plus `REPORT.md`. I also built `packages/prompt/dist` and
  `packages/cli/dist` inside `wt-cx-settings` (both gitignored, needed for module
  resolution); if you want those gone, `rm -rf` them.
- Every custom property each diff *introduces or references* was checked against
  the **post-rename** token set in `wt-calm-int` (245 defined properties, gathered
  the same way `token-reference-ban.test.ts` gathers them: all CSS assignments
  plus string literals in TS). `var(--x, fallback)` was excluded — comma form is
  correct and was not flagged anywhere.
- Every changed stylesheet was run through **lightningcss minify** — all four
  parse and minify clean (failure mode 8 clear everywhere). Note that `vitest`
  here runs `css: false`, so no green test run is evidence about any stylesheet;
  the CSS findings below come from reading and from the minifier, not from tests.
- `hex-ban`, `tokens-verbatim`, `type-scale-ban`, `fullwidth-plus-ban`,
  `no-op-handler-ban`, `mobile-audit-css-parity` run green in the board, graph and
  settings worktrees.

---

# 1. `wt-cx-settings` — **NEEDS WORK**

*(Reviewed first and most closely, per your instruction. 32 files.)*

## Test result actually observed

| command | result | duration |
|---|---|---|
| `npx vitest run --maxWorkers=1 src/settings-space/` | **15 files, 246 tests passed** | 52.3 s |
| `npx vitest run --maxWorkers=1 src/settings-governance/` | **5 files, 77 tests passed** | 11.7 s |
| `npx vitest run --maxWorkers=1 src/settings-credentials/` | **4 files, 39 tests passed** | 12.7 s |

All green, no timeouts. The report says 243 for `settings-space`; I measured 246.
More, not fewer — a stale count in the report, not a discrepancy that matters.

## Findings, most severe first

### S1 — FAILS the new `token-reference-ban.test.ts`. Two dangling tokens, both new, both on adjacent lines. (failure mode 2)

`packages/tm8_ui_2.0/src/settings-space/settings.css:969-970`

```css
.cv2-root .set-nav__space {
  font-family: var(--pn-serif);   /* :969 — renamed to --pn-prose today; now dangles */
  font-size: var(--pn-fs-md);     /* :970 — has NEVER existed anywhere in this package */
}
```

- `--pn-fs-md` is defined nowhere, on either side of today's rename. The scale is
  `--pn-fs-{display,h1,h2,h3,title,read,body,sm,label,fine,micro,mono,tick}`.
  This is the **only** reference to `--pn-fs-md` in the entire package.
- `--pn-serif` is a **new** reference added by this diff, and `a47c841a` renamed
  `--pn-serif` → `--pn-prose` package-wide. It resolved at the time the branch was
  written; it does not resolve now.

Both are bare, no-comma form, so both are hard failures of the new guard. Both are
also silent at runtime: the declarations are invalid at computed-value time and the
browser drops them, so the space name renders at inherited size in the inherited
face — exactly the class of defect the guard was written for.

Fix is two lines: `var(--pn-prose)` and a real size token (`--pn-fs-sm` or
`--pn-fs-body` by the surrounding scale).

**Merge-mechanics note, not a defect in the branch:** `a47c841a` touched
`settings.css` (5 sites), `governance.css` (1 site) and `board.css` (1 site) for
*nothing but* the `--pn-serif`→`--pn-prose` rename. This branch's hunks don't
overlap those lines, so git will merge silently and the branch's own new
`--pn-serif` at :969 will survive into a tree where the token is gone. Grep the
merged result for `--pn-serif` before you trust it.

### S2 — the measured failure reason is discarded in two places and replaced with a guessed one. (report/diff discrepancy)

`packages/tm8_ui_2.0/src/settings-governance/parts.tsx:170-177`

```ts
- reason={{ cause: `${what} could not be read`, remedy: state.message }}
+ reason={{ cause: `${what} could not be read`,
+           remedy: 'Check your connection and reload Settings. Nothing here is being treated as empty.' }}
```

`state.message` — the only thing that knows what actually failed — is now dropped
on the floor and replaced with an **asserted cause the code does not know**. A
`forbidden`, a 500, or a missing space all now tell the reader to check their
connection. `state.message` becomes dead data on the `failed` variant.

Same pattern at `packages/tm8_ui_2.0/src/settings-credentials/CredentialsSection.tsx:225`:
`why={loadError}` → a fixed string telling the reader to "ask a node administrator
to check whether credential access is enabled" — advice that is wrong for every
failure that is not an authorisation failure.

The REPORT.md line covering this is *"Rewrote disabled, unavailable, empty, and
failed-load copy … in customer-facing language with a useful reason or next step."*
Rewriting copy and **deleting the diagnostic payload** are different acts, and the
report only describes the first. Customer-facing phrasing and keeping the measured
detail are not in conflict — the previous code did the second in the `remedy` slot
and the new code could keep it there.

### S3 — a test was removed rather than replaced: the action-registry coupling. (failure mode 7)

`packages/tm8_ui_2.0/src/settings-governance/governance-model.test.ts`

The diff **deletes the `resolveAction` import** and both assertions that bound the
rendered refusal to the action registry's own sentence:

```ts
- const availability = resolveAction('unlink').availability({ spaceId: 'probe' });
- expect(registryText).toContain(rendered.cause);      // gone
- expect(registryText).toContain(untrustRefusal().cause); // gone (whole describe rewritten)
```

replaced by string-literal matches on the new hardcoded copy. The file's own header
comment stated the invariant being destroyed and was edited to remove it:

> ~~3. THE REFUSAL COPY IS READ FROM `domain/actions.ts`, not copied. A copy would
> still say "isn't wired yet" on the day it is.~~

That is precisely what now happens. `governance-model.ts:132-158` still calls
`resolveAction(ref)` but uses it only as a boolean; the sentences are literals, and
the non-disabled branch — the day `unlink`/`untrust` actually land — now renders
*"'unlink' is available elsewhere / Use the supported project action outside this
settings screen"*, which nothing tests and nobody will notice is wrong.

This is the single item on your list you asked to be flagged loudly, so: **the
guard against copy drift is gone, and no equivalent replaced it.** A cheap repair
that keeps the new customer-facing copy: assert that the disabled branch is reached
*because* `resolveAction(ref).availability(...).kind === 'disabled'`, and add a case
asserting the non-disabled branch does not render a refusal at all.

### S4 — hardcoded per-verb branch where the copy used to come from the registry. (failure mode 4, in spirit)

`packages/tm8_ui_2.0/src/settings-governance/governance-model.ts:145`

```ts
return ref === 'unlink' ? { cause: 'Projects can’t be unlinked…' } : { cause: 'Trust can’t be revoked…' };
```

Not an entity-kind literal — I checked, and **no diff in any of the three
worktrees introduces an entity-kind literal** (see the sweep note at the end). But
it is the same anti-pattern one level over: per-`ref` behaviour expressed as a
conditional in a component module, where it previously came from the registry row.
If the customer-facing sentence must live in Settings, it belongs in
`GOVERNANCE_REASONS` keyed by ref, not in an inline ternary.

### S5 — the active nav row lost its non-colour emphasis, and a stylesheet rule went dead. (failure mode 6)

`SettingsShell.tsx` changed `aria-current` from `'true'` to `'page'`. The existing
rule that styled the active row was never updated:

- `settings.css:183` — `.set-nav__row[aria-current='true'] { font-weight: 600; color: var(--pn-ink); border-left-color: var(--pn-brand); … }` — **now matches nothing.**
- `settings.css:1044` — the replacement `.cv2-root .set-nav__row[aria-current='page']` sets `background: var(--set-group-soft)` and `box-shadow: inset 3px 0 0 var(--set-group-accent)` and **does not restore `font-weight: 600` or `color: var(--pn-ink)`.**

Net: "which section am I on" is now carried by a soft background tint plus a 3 px
coloured bar. The bar is a shape, so this is not *purely* colour — but the weight
and ink step that were the non-colour carriers are gone by accident, not by
decision, and nothing in the REPORT.md mentions the `aria-current` value change.
Two lines to restore.

### S6 — `title=` used as the disabled-reason carrier in ~20 places, against this package's own established rule.

New `title={…}` attributes appear across `AxesSection.tsx`, `MenuEditor.tsx`,
`InviteFrames.tsx`, `MembersSection.tsx`, `WorkflowsSection.tsx`,
`CredentialsSection.tsx` (11 of the `busy` form alone; 51 `title={` sites in the
changed settings files overall).

`title` is not announced by screen readers on a `disabled` control, does not appear
on touch, and is unreachable by keyboard. This package already ruled on exactly
this — `members-section.test.tsx:214` still carries the comment *"a reason a screen
reader cannot reach is not a reason"* — and already ships `DisabledAction`,
`DisabledIconControl` and the `aria-describedby` machinery that satisfies it. The
diff uses the proper machinery in some places (`AxesSection` now takes
`AXIS_DEFAULT_DELETE_UNAVAILABLE` through `DisabledIconControl`) and `title` in
others. The owner's brief asked for *"reasons on any disabled control"*; ~20 of
these reasons are not reachable by a screen reader or by touch.

`MembersSection.tsx:345` is the one place that did it right — it puts the busy
state in the `aria-label` **and** the `title`. That is the pattern the other 20
should follow.

### S7 — a new test bans vocabulary that legitimate customer copy needs.

`settings.test.tsx:275` and `governance-model.test.ts:281` both add:

```ts
expect(`${reason.cause} ${reason.remedy}`).not.toMatch(
  /\b(seam|executor|registry|rpc|dto|sql|schema|migration|column|table|row|prop)\b/i);
```

`row`, `table`, `column` and `prop` are ordinary English that customer copy about
a menu, a members table or a workflow grid will want. It already forced one
degradation in this diff: `menuChildCapReason` had to go from *"this row has 8 of
8"* to *"this item already has 8 of 8 nested links"* purely to satisfy the regex.
Narrow it to the genuinely internal terms (`seam`, `executor`, `dto`, `rpc`,
`migration`) or the next author will reword good copy to appease it.

### S8 — smaller things

- `settings.css:194` — `.set-nav__spacer { flex: 1; min-height: 12px; }` is dead: `SettingsShell` no longer renders that element. The comment at `settings.css:146-151` explaining the spacer is now also stale.
- `SettingsShell.tsx:213` — `SETTINGS_SECTIONS.find(c => c.id === id)!` throws if a group names a section that does not exist, and a section absent from every group vanishes from the rail. **Mitigated**: the new partition test in `settings.test.tsx:277-292` asserts the groups cover `SETTINGS_SECTIONS` exactly, both directions. Good; the report's claim on this one is accurate.
- `MenuEditor.tsx:526` silently drops the word "ref" from the item type line (`{item.type} ref` → `{item.type}`). Undisclosed in the report; harmless.
- `MEMBER_REMOVE_UNAVAILABLE` now reads *"Members who created work can't be removed yet"*, but the control is disabled for every member regardless of whether they authored anything. The copy asserts a condition the code does not check.

## Clean on

Raw hex (1): none. Grid tracks (5): `settings.css:989` correctly declares
`grid-auto-rows: max-content` on the bounded `.set-nav__groups` grid and the
responsive `minmax(min-content, 1fr)` is floored — this failure mode was
anticipated and handled. Kind literals (4): none. Minification (8): both
stylesheets minify clean. `styles/tokens.css` (3): untouched, `tokens-verbatim`
green.

## Verdict

**NEEDS WORK.** S1 is a hard build failure today and is a two-line fix. S2 and S3
are judgement calls I'd want the owner to make explicitly rather than absorb
silently — the branch trades measured diagnostics and one real coupling guard for
friendlier copy, and the REPORT.md describes only the copy half of that trade. The
grouped-navigation work itself (types, partition test, CSS structure) is good and I
found nothing wrong with it beyond S1 and S5.

---

# 2. `wt-cx-board` — **SAFE TO INTEGRATE**

## Test result actually observed

| command | result | duration |
|---|---|---|
| `npx vitest run --maxWorkers=1 src/board-v2/` | **3 files, 46 tests passed** | 22.1 s |
| `npx vitest run --maxWorkers=1 src/hex-ban.test.ts src/styles/tokens-verbatim.test.ts` | **27 passed, 1 skipped** | 0.8 s |

Exactly what the report claims, including the skip. No timeouts.

## Findings

**This worktree is clean.** I found no instance of any of the eight failure modes,
and I am not going to manufacture one.

Specifically checked and clear:

1. **Raw hex** — none added.
2. **Dangling `var()`** — `--pn-wait-soft`, `--pn-info-soft`, `--pn-run-soft`, `--pn-block-soft`, `--pn-card`, `--pn-line` are all defined in both the light (`tokens.css:46-51`) and dark (`:186-190`) blocks. `board.css` checked in full against the **post-rename** token set: **zero** dangling references. No `font-family` added, so the new font half of `token-reference-ban.test.ts` is unaffected. This branch passes both new guards.
3. **`tokens.css`** — untouched; the reference twin is therefore consistent.
4. **Kind literal** — `data-category` (`BoardV2Screen.tsx:671`) reads `column.plan.category`, which is the `StatusCategory` contract enum driven by `CATEGORY_SPECS` in `board-model.ts:52`. The four CSS attribute selectors name *categories*, not kinds, and a category is a closed contract vocabulary that CSS has no other way to reach. Not a violation.
5. **Grid tracks** — the one new grid is `board.css:518` `grid-template-columns: minmax(8rem, 1fr) max-content`, floored at `8rem` and asserted floored by a new test. `.b2__col` is flex, not grid; `.b2__cards` keeps `flex: 1; min-height: 0; overflow-y: auto`, so the new `overflow: hidden` on `.b2__col` clips the tint to the radius without breaking the scroller.
6. **Colour as the only carrier** — the status word stays in every header and a new component test asserts it is the header's *first* child, ahead of the count, in both category and workflow mode.
7. **Tests** — additive only. `board-style.test.ts` and `board-v2-screen.test.tsx` gain assertions; nothing is removed or loosened.
8. **Minification** — `board.css` minifies clean.

## Notes (not blockers, not in the report)

- **The category band moved.** `BoardV2Screen.tsx:686-692` reorders the header children to title, count, band, and `board.css:714` gives the band `grid-column: 1 / -1`, which auto-places it on **row 2 — under the column name.** It used to sit first. The retained comment at `board.css:711-713` still calls it *"a true eyebrow"*, which it now isn't. Cosmetic, but the report does not mention the reorder at all.
- **The tint replaces the card ground, it doesn't sit on it.** `.cv2-root .b2__col[data-category=…]` overrides `background: var(--pn-card)` outright, and the `-soft` tokens are 9–14 % alpha, so columns now read as *paper + tint* rather than *white + tint*. Looks deliberate and matches "minimal colours carrying meaning"; worth one look in the browser before you ship it, since no test in this package can see it.

## Verdict

**SAFE TO INTEGRATE.** Report claims match the diff throughout; the two notes above
are undisclosed but benign.

---

# 3. `wt-cx-graph` — **DISCARD (mostly superseded)**

## Test result actually observed

`npx vitest run --maxWorkers=1 src/graph/` → **6 files, 87 tests passed**, 18.9 s.
Exactly what the report claims. Guards green. `graph.css` minifies clean, adds no
raw hex, and adds no new dangling token (its one `var(--pn-serif)` at
`graph.css:202` is **pre-existing base-commit debt already fixed in `a47c841a`**,
not something this branch introduced).

## Answer to your question: does it contain anything the shipped work does not, and is any of it better?

I diffed `f0787580..a47c841a -- src/graph` against the branch. The shipped work is
`4d93069c`, +1175 lines across 7 files (Building rail, GraphSearch, LOD gating, the
recency register).

**Superseded — the shipped version is better:**

- The branch adds `.cv2-root .gv-node--fresh/--warm/--rest/--blocked` to restore the family colour on the left border, because the pre-existing state modifiers were out-specifying it and wiping it. **`4d93069c` fixed the same defect** (`graph.css:1375-1406`, "THE RECENCY REGISTER") and fixed it better: the stripe is graded `color-mix(… 52%/78%/100%)` by heat instead of restored flat, plus `.cv2-root .gv-node--fresh .gv-node__meta` steps the timestamp up in ink so recency is never colour-only. The shipped block sits at line 1391 of 1645 and the branch's rules at ~line 900, both at specificity (0,2,0) — so after a merge the shipped block wins on source order and the branch's three rules are simply dead weight. No regression, but no value either.
- `.gv-building__glyph { color: var(--gvf) }` already ships — the shipped work reached the same "glyph wears the family hue" conclusion for the new Building rail.

**Genuinely not in the shipped work:**

1. `--gvf-soft` + `background: linear-gradient(90deg, var(--gvf-soft), var(--pn-card) 44px)` on the card.
2. Family hue on the *canvas card's* glyph and kind word (`.gv-node__glyph`, `.gv-node__kind` → `var(--gvf)`).
3. **Edge contrast**: `--pn-line-2` → `--pn-ink-4` on the line, `--pn-ink-3` on the arrowhead, `--pn-ink-2` on the label, with `--blocked`/`--live`/`--hot` restated at higher specificity so state still outranks the new neutral floor. The shipped file still draws edges in `--pn-line-2`.
4. `.gv-node__foot { flex-wrap: wrap }`.

**A regression the branch introduces:** `purple` moves from `--pn-pr-merged` to
`--pn-brand` and `pink` from `--pn-brand-2` to `--pn-brand`. Two distinct hues
collapse into one, and that one is *also* the selected-node outline colour and the
hot-edge colour (`.gv-node--selected { outline: 2px solid var(--pn-brand) }`).
Four registry kinds now wear the same hue as "selected". Against a brief that says
"coloured by kind", that is backwards, and the report describes the same change as
*"Strengthened registry-driven kind identity"*.

*(The nine `var(--color-icon-*, …)` references the branch removes were always
dead — none of `--color-icon-blue/green/orange/red/purple/teal/cyan/yellow/pink`
is defined anywhere; only `-primary/-secondary/-disabled/-accent` exist in
`astryx-bridge.css`. They are comma-fallback form, so the new guard explicitly
permits them. Removing them is tidy but not a fix.)*

**Is any of it better?** Item 3 is the one clear standalone win — the dark theme's
dividers are built to recede and a graph connection must not. Item 4 is a safe
one-liner (`V_GAP` is 72 px, so a second footer line cannot make cards overlap; I
checked). Items 1 and 2 are a taste call the file itself argued against before this
branch deleted the argument — *"the icon and kind word stay neutral so color is
organized at a single, predictable location"* — and `4d93069c` independently
restated that reasoning almost verbatim (*"stacking a fourth meaning on it is how a
card ends up saying four things with one line"*). Two agents reached the opposite
conclusion from the same file; the shipped one wrote down why.

## Verdict

**DISCARD the branch.** Nothing in it is required, the recency work in it is
already shipped in a better form, and its one novel colour decision is a
regression. If you want anything, take items 3 and 4 as a fresh ~6-line patch
against `wt-calm-int` — that is smaller than resolving the merge.

---

# Cross-cutting

- **New-guard status.** `board` passes `token-reference-ban.test.ts` on both halves. `graph` introduces nothing that fails it. `settings` **fails it** — `settings.css:969` and `:970` (S1). No worktree adds a `font-family` outside the `var(--pn-*)` form, so the font half is clear for all three.
- **`--pn-serif` sweep.** Introduced by this work: exactly one site, `wt-cx-settings` `settings.css:969`. Pre-existing base-commit debt that `a47c841a` already fixed and that a careless merge could resurrect: `settings.css` ×4 (`:236, :446, :522, :598`), `governance.css:93`, `graph.css:202`. Grep the merged tree.
- **Kind-literal sweep.** I swept every added non-test line in all three diffs for entity-kind literals (`task|session|work_session|teammate|project|space|doc|note|channel|message|board|loop|prompt|artifact|file|folder|pull_request|hub|axis` in quotes). **Zero hits.** The only string-union literals added are `SETTINGS_GROUPS` ids (`'space' | 'personal' | 'work' | 'structure' | 'safety'`), which name settings groups, not kinds. Failure mode 4 is clear on all three except the softer S4 case above.
- **Deleted tests.** One, and only one: the action-registry coupling in
  `wt-cx-settings/…/governance-model.test.ts` (S3). Board and graph are additive
  only. Every other settings test change is a rewritten assertion, not a removal —
  they generally hold the same shape against new copy, and several are *stronger*
  (they add negative assertions). S3 is the exception, and it is the one to argue
  about.
