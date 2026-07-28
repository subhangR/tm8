# HANDOVER — T0-4 governed + restricted archetypes (`GovernedBody`, `RestrictedBody`)

**status-as-of:** `02830c6` · worker `sess_1785277879886_mm2f3rukw` · task `task_1785277878399_pbu2yl0zg` ·
written 2026-07-29

Code + tests done, wide check green, **not looked at in a browser**. Nothing wired: the six files are
new and unimported. Ready for you to mount and for the user's live review.

> **Two flagged file-location notes, neither argued.**
> 1. The brief §4.7 says a new non-source artifact goes OUTSIDE `src/`; the directive names this exact
>    path inside it. I followed the directive. Checked: this `.md` is invisible to every control —
>    `hex-ban.test.ts` and `no-branching.test.ts` scan only `.css`/`.ts`/`.tsx`, and the vitest include
>    glob is `src/**/*.{test,spec}.{ts,tsx}`.
> 2. The five siblings use `HANDOVER-<Name>.md`; the directive named `HANDOVER.md`. I followed the
>    directive, and the generic name in a shared directory is a collision risk if a later lane is told
>    the same thing. Rename to `HANDOVER-KindBodies2.md` if you'd rather; nothing depends on the path.

---

## 1. Screens + oracle regions

Oracle: `T0-1 workspace structure review (1)/T0-4 Entity Detail Panels Hi-Fi.dc.html`, frame 3,
`data-screen-label="Governed & fallback kinds"` (lines **664–799**). Frame enumeration for all seven
frames was reported as the first deliverable and is not repeated here.

| body | oracle card | full card | **body region built** |
|---|---|---|---|
| `GovernedBody` | PROJECT | 671–712 | **690–708** |
| `RestrictedBody` | INTERACTION PROFILE | 714–762 | **734–758** |

The third card in the frame (CUSTOM / UNKNOWN `c:deploy`, 764–797) is the **generic floor** and is
already built — `GenericBody` renders it. I built nothing for it, as instructed.

Anatomy, in the oracle's own order:

| GovernedBody block | lines | | RestrictedBody block | lines |
|---|---|---|---|---|
| `path-row` (mono path + ⧉ copy; repo + ↗) | 691–692 | | `status-banner` (draft / retired) | 735–740 |
| `trust-card` (chip + Untrust… + consequence) | 693–696 | | `preview` (eyebrow + mono card) | 741–744 |
| `live-sessions` (eyebrow + verdict rows) | 697–703 | | `field-rows` (VOICE / RISK / TOOLS) | 745–749 |
| `unlink-footer` (refused verb + reason) | 704–707 | | `items` (DEFAULT FOR chips) | 750–756 |
| `notice` (the 28px footer sentence) | 709 | | `pin-provenance` (immutability caption) | 757 |
| | | | `restrictions` (**authored**, see §3.6) | — |
| | | | `notice` | 759 |

**Cross-read and deliberately NOT implemented:** the Z4 full-view frame (921–1272) draws six layouts —
tasks, docs, channel-hub, teammate-profile, PRs, sessions. **Neither of my two kinds has a Z4 layout in
the oracle at all.** Promoting one of these panels today lands on whatever the shell's generic Z4 does.
Flagged, not solved; diffing my bodies against a neighbour's Z4 would be the sheet-commit-button error.

## 2. Files — ALL NEW, nothing else touched

| file | lines |
|---|---|
| `packages/tm8-ui/src/panels/bodies/GovernedBody.tsx` | 849 |
| `packages/tm8-ui/src/panels/bodies/GovernedBody.test.tsx` | 366 |
| `packages/tm8-ui/src/panels/bodies/governed-body.css` | 356 |
| `packages/tm8-ui/src/panels/bodies/RestrictedBody.tsx` | 575 |
| `packages/tm8-ui/src/panels/bodies/RestrictedBody.test.tsx` | 355 |
| `packages/tm8-ui/src/panels/bodies/restricted-body.css` | 219 |

**diffstat: 6 files changed, 2720 insertions(+), 0 deletions(-).** (This handover makes 7.)
`git status --porcelain src/panels/bodies/` shows exactly those six as `??`. I edited **no existing
file anywhere**, staged nothing, ran no `git add` / `git commit`. Tree dirt outside my lane exists and
is not mine — I did not inventory it, because two lanes were moving while I worked.

## 3. Divergences — RULED vs DRIFT

**3.1 RULED (D63.1).** The oracle frame draws a three-row chrome (crumb, header, a 32px action row,
then tabs). I built to none of it — D63 supersedes with the two-row chrome, and the chrome is not my
file. No action; recorded so nobody re-opens it.

**3.2 DRIFT — the oracle's data does not exist (GOVERNED).** Oracle line 691 draws
`~/code/tm8/packages/ui`, line 694 a `● trusted` chip. **Measured:** `EntityContent` for this kind is
`{ projectId, repoUrl?, materializedVersion }` (contract.ts:159–160) — no path, no trust. Both live on
`ProjectResource` (contract.ts:948–961), which **the stamped facade seam has no read for** (I read
`src/data/seam.ts` in full). Built: a `resource?: ProjectResource | null` prop; **absent ⇒ both regions
render HOLLOW with that reason.** An unread trust level is never painted `untrusted`. See §6 GAPS.

**3.3 DRIFT — the oracle's preview prose has no source (RESTRICTED).** Line 743 draws real prompt text.
Measured: this kind's `EntityContent` is `{ status, templateKey, templateVersion, resolvedHash,
generatedByTeamMemberId }` (contract.ts:161–163), and the contract's own `InteractionProfilePreview` is
documented "sanitized, non-interactive projection: no prompt/tool/capture policy" (contract.ts:1452) —
and has no seam read either way. Built: the region renders its shape with the absence stated and its
cause named; `params.source` is honoured the instant a member carries it.

**3.4 DRIFT — the same for VOICE/RISK/TOOLS and DEFAULT FOR.** No contract member carries them. Built:
declared field rows KEEP their row with a hollow value (a declared-but-unmeasured field is a fact), and
the chip list distinguishes MISSING (hollow) from EMPTY (a real zero, "Not the default anywhere").

**3.5 DRIFT — the oracle's `Pinned by 3 running sessions`.** Pins are per work session
(`InteractionProfilePinView`); no read totals them. Built: the immutability LAW is always stated (it is
true regardless of the number); the count appears only when `params.countSource` resolves, and renders
hollow when named-but-absent — "pinned by 0" is the one thing this caption must never say by accident.

**3.6 A RULING I MADE ALONE — the `restrictions` block (RESTRICTED).** The oracle draws the refused
verbs in the ACTION BAR (`▲ —`, `⊕ Link` at .35 with "disabled — restricted kind", lines 726–727).
That bar is the chrome, which **already** renders those two through `ActionButton`'s
disabled-with-reason path — so building verb controls in the body would be **D64's defect exactly**
(two renderings of one fact). What nothing renders today is WHY edit/delete are refused for this kind,
though `registry.ts:720-724` has authored sentences sitting unused. The `restrictions` block renders
those: stated refusals in the caption voice, **no new controls**. Server truth decides which rows
appear; `capabilities == null` renders the CHECKING state, never a refusal. Reverse it by dropping the
block from the registry row — one line, no code change.

**3.7 A RULING I MADE ALONE — the untrusted consequence sentence.** The oracle draws only the TRUSTED
card, and its own note demands the consequence "stated both ways" (line 711). The missing half is
authored in the same shape: *"Agents cannot start terminal sessions in this root. Trusting it allows
new runs; it starts nothing and revives nothing."* Overridable from `params.untrustedNote`. The
untrusted card is built on the **idle** ramp, not `block` — an untrusted root is a governed default,
not an error.

**3.8 A RULING I MADE ALONE — the unlink refusal PRECEDENCE.** Three reasons can be true at once and
they are ranked: (1) sessions recorded + liveness unverified → refuse, naming that; (2) live > 0 →
"unlink blocked: N live sessions use this root" (the oracle's own case, line 706); (3) otherwise the
action registry's own answer, verbatim. A live-session block is a fact about the WORLD and outranks the
fact that a verb is deferred in this BUILD — the two send the user to different remedies.

**3.9 RULED (R5 #9 / L6, following `chrome.tsx` and `HubBody`).** Every control renders
disabled-with-reason when its dispatch is absent: session rows without `onOpenEntity`, chips without an
opener, copy without a clipboard, any verb without an `ActionContext` or a `dispatch`. On the screen you
capture, expect these treatments until the props are wired (§7).

**3.10 A TRADE-OFF I TOOK, stated because the elegant alternative is worse.** `status-banner` takes the
lifecycle member from `params.source`, NOT from `panel.statusPill.source`. The pill spec names a SOURCE
(`profileStatus`), not a member; translating needs `chrome.tsx`'s private `STATUS_FIELD` map — **which
already has four hand-copies in this package** (`chrome.tsx:194`, `SubtreeBody.tsx:430`,
`home-model.ts:79`, `GraphView.tsx:68`). A fifth is a fifth thing to drift. **Proposed, not taken:
export that map from `detail/chrome.tsx` and collapse all five.** Tones still come from the pill spec —
they key on the VALUE and need no translation.

## 4. Red first, then green — with instruments

All runs `cd packages/tm8-ui && bunx vitest`, banner `RUN v4.1.10 …/packages/tm8-ui`.

| when (UTC, `date -u`) | what | result |
|---|---|---|
| `2026-07-28T22:42:32Z` | `GovernedBody.test.tsx` with **`GovernedBody.tsx` moved out of the tree** | **RED** — `Failed to resolve import "./GovernedBody"` · Test Files 1 failed · Tests **no tests** |
| `2026-07-28T22:42:38Z` | same, component restored | **RED** — 4 failed / 21 passed (25); my assertions read the labelled node, while `DisabledAction` puts the reason CAPTION in a sibling. Fixed the assertions to read the region. |
| `2026-07-28T22:43:19Z` | after the fix | **GREEN** — Tests **25 passed (25)** |
| `2026-07-28T22:47:13Z` | `RestrictedBody.test.tsx` with **`RestrictedBody.tsx` moved out** | **RED** — Test Files 1 failed · Tests **no tests** |
| `2026-07-28T22:47:14Z` | same, component restored | **RED** — 5 failed / 21 passed (26). Two real findings, §4.1. |
| after fixes | | **GREEN** — Tests **26 passed (26)** |

**4.1 What the second red actually taught, because it is the transferable bit.** (a) The registry's
`statusPill.source` is `profileStatus`, not a member name — that is §3.10, found by a failing test and
not by reading. (b) The shared fixture grants **`CAPS_FULL`** to `profileHouseStyle`, i.e. `canEdit:
true` on a kind whose registry row exists to refuse editing. My component was right and the fixture is
wrong; the test withholds the two capabilities locally and says so in a comment. **Fixture gap, §8.**

**4.2 Mutation probes** — a green that was never red *per assertion* is a claim. Each probe restored
byte-identically, verified with `diff -q` against a pre-mutation copy.

| probe | mutation | result |
|---|---|---|
| A | session row lets a `running` RECORD outrank the verdict | exactly **1 failed** — "renders the VERDICT word over a record that disagrees", 24 passed |
| B | unlink footer loses the live-session precedence | exactly **1 failed** — "blocks on live sessions and names the number", 24 passed |
| C | chip list collapses MISSING into EMPTY | exactly **1 failed** — "renders HOLLOW when the named member does not exist", 25 passed |

## 5. Wide check — timestamp · scope · instrument

**THE RUN OF RECORD** (after the §9.1 rename, so it covers the bytes you will read):

```
2026-07-28T22:54:16Z | cwd packages/tm8-ui | bunx vitest run --exclude 'src/terminal/**'
banner: RUN v4.1.10 /Users/subhang/Desktop/Projects/tm8/packages/tm8-ui
RESULT: Test Files 56 passed (56) · Tests 1067 passed (1067) · 0 failed
```
```
2026-07-28T22:54:42Z | cwd packages/tm8-ui | bunx tsc --noEmit  →  CLEAN (zero output, exit 0)
2026-07-28T22:49:42Z | cwd packages/tm8-ui | bunx vitest run src/hex-ban.test.ts src/panels/no-branching.test.ts
        →  Test Files 2 passed · Tests 10 passed
2026-07-28T22:53:55Z | cwd packages/tm8-ui | my 2 files + both guards → Test Files 4 · Tests 61 passed
```

**A moving tree, recorded rather than smoothed.** An earlier wide check at `22:49:19Z` read *53 files /
1021 tests, all green*. At `22:53:10Z` the same command read *55 passed / 1 failed (3 tests) — all in
`src/settings-space/settings.test.tsx`* plus one `tsc` error in `src/settings-space/port.ts` (`.at()`
under the current `lib`). By `22:54:16Z` both were gone. **A sibling lane was landing files between my
runs**; none of it is mine, and I did not investigate beyond naming it. Three honest, correct,
unreconcilable numbers in five minutes is exactly why a state report carries when + scope + instrument.

Note the machine clock stamps `2026-07-28` while the session date is `2026-07-29`; every stamp above is
the instrument's own `date -u`, unaltered.

## 6. GAPS — what the seam cannot do, and what I did instead

| # | need | seam today | rendered as |
|---|---|---|---|
| G1 | read a project's `workingDir` | **no read** — `seam.ts` has no `projects.*` family; `ProjectResource` is contract-only | path row HOLLOW, cause named |
| G2 | read a project's `trust` | **no read**, same | trust card HOLLOW — **never** `untrusted` |
| G3 | GRANT trust | `ActionRef` has `untrust` and **no `trust` member** | "Granting trust has no verb in this build — trust is a node-level grant" |
| G4 | REVOKE trust | `untrust` exists, `deferred()` (`actions.ts:281`) | disabled-with-reason carrying `REASONS.untrustDeferred` |
| G5 | unlink a project from a space | `unlink` exists, `deferred()` (`actions.ts:282`) | refusal, ranked per §3.8 |
| G6 | profile preview text | no seam read; the contract's preview view is sanitized of prompt policy | preview HOLLOW, cause named |
| G7 | a profile's DEFAULT FOR set | `TeammateProfileDefaultView` / `SpaceProfileDefaultView` are contract-only | chips HOLLOW (missing ≠ empty) |
| G8 | pin count | `InteractionProfilePinView` is per work session | law stated, count hollow |
| G9 | activate / retire a profile | no seam command | **nothing built** — the oracle draws no such button in this frame, so nothing was invented. `set-as-default` exists deferred (`actions.ts:283`) and belongs in the chrome's `primaries` |

None of these is an escalation: R7 says the answer is disabled-with-reason, and each flips to live with
**no edit to my files** the moment its executor or read lands.

## 7. Integration note — exact props, exact mount points

### 7.1 `domain/types.ts` — the archetype union (YOUR file)

```ts
export type BodyArchetype =
  | 'subtree' | 'reader' | 'hub' | 'profile' | 'generic' | 'terminal'
  | 'governed' | 'restricted';
```

Both components take plain props and **compile today without this** — the union only gates the registry
rows and the `PanelBody` arm. Their block names (`path-row`, `trust-card`, `live-sessions`,
`unlink-footer`, `status-banner`, `preview`, `field-rows`, `restrictions`, `pin-provenance`) are also
additions to `ContentBlockKind`; both bodies widen `block` to `string` locally (the `ProfileBody`
precedent), so `readonly ContentBlockRef[]` flows in either way and nothing breaks when you widen it.

### 7.2 `panels/EntityDetailPanel.tsx` — two arms, beside the existing five (~line 345)

```tsx
if (config.panel.archetype === 'governed') {
  return (
    <GovernedBody
      detail={detail}
      blocks={config.panel.blocks ?? []}
      resource={props.projectResource}          // NEW panel prop; omit ⇒ honest hollow (G1/G2)
      livenessOf={props.livenessOf}
      actionContext={{
        ...props.ctx,
        entityId: props.ctx.entityId ?? detail.id,
        kind: props.ctx.kind ?? detail.kind,
        capabilities: props.ctx.capabilities ?? detail.capabilities,
      }}
      onOpenEntity={onOpenEntity}
    />
  );
}
if (config.panel.archetype === 'restricted') {
  return <RestrictedBody detail={detail} blocks={config.panel.blocks ?? []} onOpenEntity={onOpenEntity} />;
}
```

**The `actionContext` enrichment must match `ActionBar`'s (lines 234–239) exactly** — otherwise the body
and the chrome answer the same availability question differently, which is the four-links-green class
D57.1 names. I did not edit that file, so nothing asserts the two agree; **that assertion belongs in
the gap** and I could not write it from my lane.

### 7.3 Registry rows

**`project` (registry.ts:671-687)** — replace `archetype: 'generic'` and its blocks:

```ts
panel: {
  archetype: 'governed',
  blocks: [
    { block: 'path-row' },
    { block: 'trust-card', params: { action: 'untrust' } },   // `grantAction` when a trust verb exists
    { block: 'live-sessions' },                               // edgeType defaults to 'in_project'
    { block: 'unlink-footer', params: { action: 'unlink' } },
    { block: 'notice', params: { text: /* keep the existing sentence, verbatim */ } },
  ],
  capabilityReasons: { /* unchanged */ },
},
```

**`interaction_profile` (registry.ts:710-725)**:

```ts
panel: {
  archetype: 'restricted',
  blocks: [
    { block: 'status-banner', params: {
        source: 'status',                                     // the MEMBER, not the pill source (§3.10)
        draft: 'preview only — activate to offer it at launch.',
        retired: 'sessions pinned to it keep running — new launches can’t pick it.',
      } },                                                    // no `active` key ⇒ no banner, as drawn
    { block: 'preview', label: 'PREVIEW' },
    { block: 'field-rows', params: { fields: 'voice=VOICE,risk=RISK,tools=TOOLS' } },
    { block: 'items', label: 'DEFAULT FOR', params: { source: 'defaultFor' } },
    { block: 'restrictions' },
    { block: 'pin-provenance', params: { countSource: 'pinnedBy' } },
  ],
  statusPill: { /* unchanged */ },
  capabilityReasons: { /* unchanged — the `restrictions` block renders these */ },
  primaries: ['set-as-default'],        // OPTIONAL: puts the oracle's line-729 verb in the chrome bar
},
```

**Copy the two banner sentences from `RestrictedBody.test.tsx` (the `BLOCKS` const), not by hand** —
they carry an em dash and a curly apostrophe, and retyping is how they ship mangled.

**CSS** is imported by each component (the `CommandPalette.tsx` precedent), so `main.tsx` needs no edit.

### 7.4 Props reference

| `GovernedBody` | required | notes |
|---|---|---|
| `detail: EntityDetail` | yes | |
| `blocks: readonly GovernedBlockRef[]` | yes | `[]` is legal → designed empty body |
| `resource?: ProjectResource \| null` | no | the ONLY source of path + trust; absent ⇒ hollow |
| `livenessOf?: (id) => SessionLiveness` | no | THE verdict; absent ⇒ no live count is claimed |
| `actionContext?: ActionContext` | no | absent ⇒ every verb disabled-with-reason |
| `now?: string` · `onOpenEntity?` · `onCopyPath?` | no | `now` is test determinism only |

| `RestrictedBody` | required | notes |
|---|---|---|
| `detail: EntityDetail` · `blocks: readonly RestrictedBlockRef[]` | yes | |
| `onOpenEntity?: (id) => void` | no | absent ⇒ chips disabled-with-reason |

Both export their block-name const (`GOVERNED_BLOCKS`, `RESTRICTED_BLOCKS`) so a registry row can be
checked against them in a test rather than in two heads.

## 8. Fixture needs (I edited no fixture — not my lane this round)

1. **`fixtureDetails[projectTm8Ui.id]` has NO `in_project` connections**, so the LIVE SESSIONS region
   and the whole unlink-refusal ladder render their empty/deferred states on screen. My tests compose
   the edges locally. Add incoming `in_project` edges from `sessionLive` + `sessionStale` to exercise
   the oracle's two-row card *and* the blocked-unlink footer.
2. **No `ProjectResource` fixture exists anywhere** (grepped). Without one the path row and trust card
   are hollow in the app. My test builds a contract-typed one; that shape is copyable.
3. **`profileHouseStyle` gets `CAPS_FULL`** — `canEdit: true` on a kind whose registry row exists to
   refuse editing. Either the fixture should withhold them, or the restriction copy is describing a
   world the fixtures contradict. **This is the one I would fix first**: it is a fixture that disagrees
   with the registry, which is exactly the shape of a defect nobody sees until a user does.
4. No fixture carries `preview`, `voice`/`risk`/`tools`, `defaultFor` or `pinnedBy` — all render their
   honest absences. That is correct behaviour and a thin screen; adding them exercises the populated
   layouts the oracle draws.

## 9. COLOUR NEEDS — none. No `canvas-extra.css` edit required.

Every oracle byte in both regions maps onto the existing ramp:
`#FFFFFF`=`--pn-card` · `#E7E3D9`=`--pn-line` · `#D8D3C6`=`--pn-line-2` · `#F0EDE4`=`--pn-x-hairline-soft`
· `#F2EFE8`=`--pn-hover` · `#23201B`=`--pn-ink` · `#5B564C`=`--pn-ink-2` · `#8E897B`=`--pn-ink-3` ·
`#B7B2A4`=`--pn-ink-4` · `#3E8E5A`=`--pn-run` · `#BD8A2A`=`--pn-wait`.

**Five tint/edge alphas have no token** (trust card 693: `rgba(62,142,90,.06)` / `.35`; banners 736/739:
`rgba(162,156,142,.14)`, `rgba(189,138,42,.09)` / `.4`). They are **DERIVED** with
`color-mix(in srgb, var(--pn-run|--pn-wait|--pn-idle) N%, transparent)` at the oracle's own alphas —
the `panels.css:547-548` precedent. Deliberately not new `--pn-x-*` constants: a color-mix over a token
follows the token through the theme flip, where a measured constant needs a dark twin and can drift
from its parent. If you'd rather have named tokens, that is your file and a mechanical swap.

`hex-ban.test.ts` + `no-branching.test.ts` both pass over the two new sheets and the two new
components (run by name at `22:49:42Z`): no raw hex, no inline hex style prop, no kind literal, no
`kind ===`, no `minmax(0,…)`.

### 9.1 Two things I found by grepping AFTER the sheets were written, and fixed

1. **The `gv-` prefix is already taken.** `graph/graph.css` owns `.gv-node`, `.gv-edge*`, `.gv-banner`,
   `.gv-empty`, `.gv-screen*`… No exact collision existed with my classes, but two features sharing a
   prefix in one global stylesheet is a collision waiting for its third class. **Renamed to `gb-`**
   (verified free across `src/`). `RestrictedBody`'s `rs-` was checked the same way and is free.
2. **`pnPulse` already exists** in `kit/kit.css:13`, transplanted from the canvas helmet verbatim —
   the very keyframe the oracle names at line 700. I had declared a private copy; it is deleted and
   the rule now uses `pnPulse`. (`home.css:396`'s `hmPulse` is a third copy of the same three lines,
   not mine to touch — flagged.) The `prefers-reduced-motion` stop is authored, not from the oracle.

Both changes were made after the `22:49` runs, which is why §5's run of record is the `22:54` one.

## 10. `collection` — a PROPOSAL, flagged. NOTHING BUILT.

I grepped every crumb in all seven T0-4 frames: **`collection` has no card in the oracle** (its detail
is drawn nowhere). Per the directive I built nothing. What follows is a composition of patterns that
already exist and is **not a design** — it needs the user's or your ruling before anyone writes it.

Today `collection` is `archetype: 'generic'` with `[{items,'ITEMS'},{fields,'DETAILS'}]`
(registry.ts:645-651), and `GenericBody` renders that adequately. **My recommendation: leave it.** If a
richer body is wanted, everything it needs exists as blocks already shipped by other archetypes:

| region | existing pattern | source |
|---|---|---|
| description prose | `pn-prose` | `HubBody` / `GenericBody` |
| ITEMS as rows with status + done-strike | `SubtreeBody`'s `SubtreeRow` (registry `done` tier) | `SubtreeBody` |
| `collectionType` + `itemCount` | `fields` block | `GenericBody` |
| honest partial page ("12 of 40 loaded") | `SubtreeBody`'s partial-page line | `SubtreeBody` |
| designed empty ("Nothing parked right now") | `collectionEmpty` fixture already exists | `GenericBody` |

So the proposal is: **a registry-row change, not a new component** — reuse `subtree` with an `items`
source parameter, IF anyone wants collection items to carry status. Zero new code, zero new archetype.
Do not act on this without a ruling; I am flagging a possibility, not reporting a gap.

## 11. D-entries I am offering to author (text on request — I wrote none)

1. **The governed archetype**: its anatomy and fixed order; that path/trust are node-record facts with
   no seam read and render hollow rather than defaulting; the untrust/trust verb asymmetry; the
   three-way unlink refusal precedence (§3.8).
2. **The restricted archetype**: lifecycle sentences are registry data keyed by the status VALUE, so
   ACTIVE draws no banner by DATA and not by a special case; the `restrictions` block renders the
   registry's already-authored refusals and adds no control (the D64 avoidance, §3.6).
3. **`STATUS_FIELD` has five would-be homes** — export it from `detail/chrome.tsx` (§3.10). This one is
   worth a ledger line whether or not my bodies land, because the copies already exist.

## 12. NOT CHECKED — stated plainly

- **I have not looked at either body in a browser.** No `:4612`, no themes, no zoom, no capture.
  Everything above is jsdom plus the oracle's bytes. Every layout claim in my CSS — the path ellipsis,
  the session-row overflow, the 84px field key column, the banner wrap — is unverified by the only
  instrument that can see layout.
- **Dark theme is asserted BY CONSTRUCTION only** (tokens + color-mix over tokens, no per-theme
  override in either sheet). I have not seen either rendered dark, and the `color-mix` derivations over
  the DARK `--pn-run`/`--pn-wait`/`--pn-idle` are exactly the thing I would look at first.
- **Nothing is wired.** Both components have zero importers. I did not edit `EntityDetailPanel.tsx`,
  `registry.ts`, `types.ts`, any fixture, or `DECISIONS.md`. Until you mount them, the wide check's
  1021 green tests say nothing about whether these bodies ever render in the app — the exact
  Surface-Audit shape where five finished bodies had zero importers.
- **No test lives in the gap between my bodies and the panel**, because the gap is in a file I may not
  edit. §7.2's `actionContext` enrichment is the specific thing that could silently disagree with the
  chrome; assert it when you wire it.
- I did **not** open `src/data/**` beyond READING `seam.ts` end to end, and I ran nothing outside
  `packages/tm8-ui`, and never vitest from the repo root.
- **Not measured:** whether `EntityDetailPanel` should own a `projectResource` prop at all, or whether
  the shell should hold that read. I typed it as a prop because that is the only shape available to me.
- The 51 tests cover anatomy + order, both archetypes' registry-data claims, every honesty branch I
  built, and the archetype-not-kind claim (each body rendered over a different kind's detail). They do
  **not** cover keyboard interaction beyond what the kit provides, long-title overflow, RTL, or the
  peek / pinned / Z4 hosts.
- **Not measured:** whether `home.css`'s `hmPulse` and `kit.css`'s `pnPulse` should be one keyframe
  (§9.1 — I collapsed my own copy into `pnPulse`, but the third copy is another lane's file).
- **Not measured:** whether the `restrictions` block duplicates anything the `⋯` overflow menu already
  says. I read the ActionBar (`chrome.tsx:240-256`: link, add-child, `panel.primaries`) and it renders
  no edit/delete verb — but I did not audit every menu surface in the panel.
