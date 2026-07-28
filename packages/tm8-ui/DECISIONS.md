# tm8-ui Decisions Ledger

Per charter R11: every design-ambiguity call made during the build is logged here by the fe-coordinator or its workers. The user reviews this ledger at THE GATE. Entries are append-only, numbered, dated, with source and rationale. Do not renumber or rewrite closed entries; corrections get a new entry referencing the old one.

Format:

```
## D<N> — <title> (<date>)
Source: <who ruled / where it came from>
Ruling: <the decision>
Rationale: <why, citing ATELIER / WLT / canvas>
```

---

## D1 — Tab-bar ◐ theme toggle is RETIRED (2026-07-28)

Source: Round-2 design-compliance review, ALL-ACCEPT verdict, forwarded by master coordinator. Amendment lives in T3-3's prose and binds the shell build.

Ruling: Do NOT build the ◐ theme toggle in the space tab bar, even though the T0-1 canvas still renders it (canvas is byte-unchanged; the amendment supersedes the pixels). Theme's one home is the account menu (T3-3); the command palette keeps "toggle theme" as the fast path.

Rationale: T3-3 (Account Menu, Round 2) retires the tab-bar toggle; single-home discipline for theme control.

## D2 — Board "axis: status ▾" grouping picker is IN-SCOPE (2026-07-28)

Source: Round-2 design-compliance review, boundary confirmation, forwarded by master coordinator.

Ruling: T5-2's board-layout grouping picker ("axis: status ▾") IS built — a board cannot render without its axis. What stays deferred under charter R7 is the saved-views/axes persistence-management surface, which no canvas draws.

Rationale: Distinguishes the in-canvas board control (required for the Board collection layout) from the deferred saved-views feature; R7's "disabled-with-reason, never hidden" applies only to the latter.

## D3 — Four detail-panel tabs everywhere; T5-7 three-tab mocks are abbreviation (2026-07-28)

Source: Round-2 design-compliance review, T5-7 nit, forwarded by master coordinator.

Ruling: EntityDetailPanel always renders four tabs (Content / Discussion / Connections / Activity), fixed order, every kind, no exceptions. Two small T5-7 mocks (empty-state panel, one 320px UUID mock) showing three tabs are mock abbreviation, not design; the prose reaffirms the four-tab law.

Rationale: WLT §3 / TM8-UI-SPEC-FINAL §4.6.2 inherited Z3 anatomy; the reviewer confirmed the mocks do not amend it.

## D4 — Canonical composition references (2026-07-28)

Source: Round-2 reviewer remark, forwarded by master coordinator.

Ruling: T5-2 (Board/Feed/Gallery layouts), T5-5/T5-6 (Launch & Authoring flows), and T5-3 (Doc Authoring) are especially tight and are treated as canonical composition references when other canvases are ambiguous.

Rationale: Reviewer's explicit guidance; gives ambiguity-resolution precedence within the canvas suite.

## D5 — Kit keeps canvas-measured literals that sit outside the named token steps (2026-07-28)

Source: A0 foundation worker, extracting kit primitives from T0-1 / T0-3 / T0-4.

Ruling: Colors are ALWAYS tokens (no hex in kit.css beyond what tokens.css defines). Geometry and micro-type literals measured from the canvases are kept verbatim even where they fall between the named token steps: mono micro sizes 9.5px (status pills) / 10px (section eyebrows, filter pills) / 11.5px (edge chips), the 6px radius on edge chips and kbd hints (between --pn-r-xs 5 and --pn-r-sm 7), and the agent-avatar 5px radius at EVERY size including 32px (T0-1 Z4: avR = member ? '50%' : '5px').

Rationale: The charter makes the canvases ground truth and the A0 brief says "match the canvases, do not invent styling". Normalizing these to the token scale would visibly drift from the approved pixels; ATELIER §6's "may not break the radii set" binds the designer's new work, and these values are the approved design's own output.

## D6 — Fixture vocabulary for the stale-session honesty state (2026-07-28)

Source: A0 foundation worker, fixture dataset design.

Ruling: Fixtures model a "stale" work session as `state.status === 'running'` with an activityAt well in the past (sessionStale, last heard 11:05 against FIXTURE_NOW 12:00) — there is no invented `stale` status and no fake liveness field on the contract shape. The honesty derivation ("running per record · unverified", no live dot) belongs to the UI layer once the charter-R3 liveness read exists; until then a running record without liveness proof must never render as live.

Rationale: Charter R3/R8 keep liveness detection out of this program's fixtures; inventing a non-contract field would leak a fake seam. The contract already expresses the honest truth: the record claims running, and recency is the only evidence available.

## D7 — Three measured backend gaps are day-one honesty states (2026-07-28)

Source: Master coordinator, relaying W5-attributed measured backend facts. No canvas changes; all three use the T1-4 honesty vocabulary.

Ruling:
1. T5-1 Home's activity "load earlier" supports **disabled-with-reason** from day one — the backend next-page token for `spaces.home` is currently defective (truncated, refused by every op); the bridge models it capability-gated.
2. The viewers footer and every presence affordance render **hollow-value** — presence data is measured-empty on every node and stays dormant per charter R8.
3. Any "from this session" provenance chip renders **hollow** until backend step S2 lands — `authored_from` is null through public writes (declared backend gap G2, planned work).

Rationale: Honest rendering of measured backend reality; exactly what the T1-4 honesty vocabulary exists for. Fixtures and the Facade seam must cover all three states.

## D8 — Catalog count correction: 101 rows / 98 v1 ops (2026-07-28)

Source: Master coordinator correction.

Ruling: The contract catalog is 101 rows / 98 v1 ops. The charter's "81 catalog ops" figure is stale; any doc in this package citing 81 is corrected to cite the catalog itself, not a count snapshot.

Rationale: Counts go stale; the catalog (`packages/contract/src/catalog.ts`) is the authority.

## D9 — Fixtures are wire-shaped: nested entity refs are snapshots, never back-references (2026-07-28)

Source: A0 foundation worker; bug found by the fixture zod-validation suite during A0 verification, fix endorsed by fe-coordinator.

Ruling: Fixture data must be acyclic, exactly as wire JSON is. Any nested EntitySummary inside another fixture (LiveWork.task, badges.blocked.waitingOn, EdgeView.source/target, collection items, hierarchy nodes, …) is a serialized SNAPSHOT — a copy with `badges: {}` (or otherwise stripped of anything that points back at a carrier) — never a JS object reference back into the fixture graph. The fixtures.test.ts zod pass (EntitySummarySchema/EntityDetailSchema.safeParse over every fixture) is the standing detector: a reintroduced cycle fails it with a stack overflow.

Rationale: A real backend serializes to JSON, which cannot express cycles; a fixture cycle is therefore a shape no client will ever receive, and it broke zod validation the moment it existed (LiveWork.task pointed back at its own carrier). Keeping fixtures wire-shaped keeps every consumer honest about what the seam can actually deliver.

## D10 — Real-browser pixel acceptance is a named precondition of the R5 gate (2026-07-28)

Source: Master coordinator ruling after the Chrome extension was found disconnected program-wide (A0's session, fe-coordinator's session, master's session); surfaced to the user as resolved-as-user-action.

Ruling: jsdom smoke tests plus the served :4612 page stand as INTERIM evidence only. Real-browser pixel acceptance (both themes, against the canvases) is DEFERRED-NOT-WAIVED and is a named precondition of the R5 gate review — the gate screen cannot pass on jsdom.

Rationale: jsdom has no layout engine (repo lore, paid for); the charter's acceptance culture is "a screenshot diffed against a reference, or it isn't done."

## D11 — Correction to D8: catalog measures 101 rows / 99 v1 / 2 reserved (2026-07-28)

Source: Independent reviewer finding (R1B B3), verified by fe-coordinator against the tree: `grep -c "status: 'v1'"` = 99; `grep -n "status: 'reserved'"` = 3 hits of which line 8 is the header comment, leaving 2 real reserved rows (`search.query`, `bridge.fetchBlob`); `{ name: '` rows = 101. 99 + 2 = 101, internally consistent.

Ruling: The measured catalog state is 101 rows, 99 v1 operations, 2 reserved. D8's relayed "98 v1 ops" figure was itself stale — which is exactly D8's own point. Reaffirmed and strengthened: no doc in this package cites an op COUNT as authority; cite `packages/contract/src/catalog.ts` and, where a number is unavoidable, stamp it with the measurement command and date.

Rationale: D8's rationale ("counts go stale; the catalog is the authority") applied to D8 itself. Corrections get a new entry referencing the old one — this is that entry.

## D12 — Phase-1 handling of contentSurface=…:chat in URLs (2026-07-28)

Source: Independent reviewer finding (R1B B6) flagging the unruled case; ruled by fe-coordinator under R11 within WLT §2.2 / CHAT §5.1 / charter R10.

Ruling: `contentSurface={id}:chat` is VALID route grammar (WLT §2.2) and round-trips — the codec accepts it, preserves it, and never rewrites it out of the URL (a link is not lied about). In Phase 1 the RENDERED surface clamps to terminal with CHAT §5.1's unflavored presentation: terminal-only Content region, no surface switch shown, no error copy, no empty Chat tab. The preserved param is honored when Phase 2 lands. This is presentation clamping, not param dropping — distinct from the atomic discard of UNPARSEABLE params.

Rationale: The value is valid grammar for an unavailable feature: R7's honesty posture (never silently rewrite), R10's reserved seam (switch not built in Phase 1), and CHAT §5.1's no-error presentation compose cleanly; discarding would break Phase-2 deep links authored today.

## D13 — The `＋ add server` affordance renders disabled-with-reason (2026-07-28)

Source: A1b shell worker, per LLD §4.1's explicit instruction ("an L6 application to be ledgered as a D-entry at build"); D-entry authority granted by fe-coordinator [fe->a1b 2].

Ruling: The T0-1 unified rail's `＋ add server` control IS built and IS visible, permanently disabled with the reason "remote servers arrive in Phase 2" (`ADD_SERVER_DISABLED_REASON`, `src/shell/MenuRail.tsx`). Phase 1 wires only the implicit local server (R10, RULING B). The same treatment applies to the tab bar's `+` add-space control ("creating spaces arrives with the settings screens") — no `spaces.create` op is in the stamped seam surface.

Rationale: L6 — unavailable ≠ invisible. A ghost may never advertise an action the facade cannot perform, and hiding the control would make Phase 2's rail a surprise rather than a promise kept. T1-4 form A supplies the rendering: .45 opacity + `cursor:not-allowed` + the reason on the control.

## D14 — Pin-refusal copy is the T1-4 two-line form with computed numbers (2026-07-28)

Source: A1b shell worker. LLD §16 leaves "exact disabled-reason copy strings" to build time; this is that call.

Ruling: A refused pin renders the T1-4 honesty vocabulary form A — a bold **cause** line and a mono **remedy** line — not a single flat string. LLD §5.3's prose ("center too narrow — unpin or widen", "3 pins max") is a summary of intent; the shipped strings are the canvas's:
- max pins → cause "Can't pin — 3 panels pinned", remedy "unpin one first · max 3 (02 §2.1)"
- too narrow → cause "Can't pin — center too narrow", remedy "needs {C_min(V')}px for {V'} columns · now {measured}"
- pool capacity → cause "Can't pin — terminal capacity reached", remedy "{n} of {k-1} terminal slots in use · close one first"

The remedy line is COMPUTED from the live measurement, never a constant.

Rationale: T1-4's own footer rule is binding on the voice — "reasons name numbers (3 pins, 8 slots) so they read as fact, not apology". The canvas draws "needs 976px for 3 columns · now 730"; 976 is exactly `C_min(3)` from the §5.1 formula, so the drawn string is reproducible from the real engine rather than being decorative copy. A test asserts that reproduction.

## D15 — WLT's 8px column gap supersedes the T0-1 canvas's flush columns (2026-07-28)

Source: A1b shell worker, conflict found while transcribing the T0-1 workspace grid.

Ruling: The workspace grid ships with `G = 8px` gaps between left | center | right, per WLT §6 line 204 (`minmax(200px, --ws-left) G minmax(C_min, 1fr) G minmax(220px, --ws-right)`, `G = 8px`) and LLD §5.1. The T0-1 canvas draws something different — **zero** gap between the three columns, separated only by 1px `#E7E3D9` hairlines, with `gap:8px` appearing only INSIDE the center stage between panel columns. WLT wins: the authority chain puts the governing spec above the canvases, and LLD §5.1 additionally rules that the WLT gap law supersedes the old 6px resizer track (the gap IS the resize-handle track, which a 0px seam cannot host).

Flagged for the R5 pixel reviewer: the shipped grid will read ~16px wider in chrome than the T0-1 canvas at the same viewport. This is a known, ruled divergence, not a transcription error.

Related measured note (no conflict): the canvas's own centerMin binding is `n*320 + (n-1)*8 + 16`, which is `C_min(n)` plus the stage's 8px padding on each side — the formula agrees with §5.1 exactly once the padding is accounted for.

## D16 — The ink stage is a `data-theme="dark"` scope, not a raw hex (2026-07-28)

Source: A1b shell worker; `tokens.css` has no name for the canvas's `#1D1912` center-stage fill.

Ruling: The workspace center stage and the Z4 host open a `data-theme="dark"` scope rather than hard-coding the canvas's `#1D1912`. Inside that scope `--pn-paper` resolves to `#15130E` and `--pn-surface` to `#1B1810`, so every descendant speaks dark tokens automatically. The stage is therefore dark in BOTH app themes, which is the intended behavior (LLD §12: the terminal canvas keeps its established near-black contrast in both themes).

Accepted deviation: `#15130E` vs the canvas's `#1D1912` — a small step darker. Listed here for the R5 pixel pass rather than resolved by introducing an untokenized colour.

Rationale: D5 is unambiguous that COLORS always resolve through tokens even where geometry literals are kept verbatim, and §14/§15.2 make raw hex outside `styles/tokens.css` a build failure. Adding a new token would edit the verbatim-copied `tokens.css` and break its byte-equality test. Scoping is the only mechanism that keeps both rules intact; if the exact canvas value is required, the correct fix is a design-system amendment upstream, not a local hex.

## D17 — T1-1 is the authority for menu ROW GRAMMAR; T0-1 for rail composition (2026-07-28)

Source: A1b shell worker; the two canvases draw the rail with different row vocabularies.

Ruling: Where T0-1 and T1-1 disagree about the menu rail, **T1-1 governs the row grammar** (it is the dedicated `data-screen-label="T1-1 — Menu rail grammar"` frame) and **T0-1 governs composition** (the unified server rows above the space groups, both footers). Concretely, the three grammars are T1-1's and they match both LLD §4.1 and the frozen `MenuConfig` DTO: a group header is a label and nothing else; a plain row is a `MenuItem` without children; a caret row is a VIEW item with children. T0-1's alternative — clickable group rows carrying carets and containing items — conflates `MenuGroup` with a caret `MenuItem` and is not representable in the DTO.

Note for the reviewer: a group header whose label repeats its first row's label (the shipped default's "Workspace" header above the "Workspace" caret row) is NOT a bug — T1-1 draws exactly that, the two separated by type treatment (mono 9.5px uppercase `.12em` header vs 12.5px UI row). A test documents it so it is not "fixed" later.

Glyph vocabulary: the T1-1 legend is definitional and wins where T0-1 differs (inbox `◹` not `◲`, workspace `⌗` not `▣`, settings `⛭` not `⚙`); `≋` for Feed and `#` for Channels come from T0-1, which the legend does not cover.

## D18 — The shipped default menu is registry-adjacent DATA and lives in `src/domain/` (2026-07-28)

Source: A1b escalation, fe-coordinator ruling [fe->a1b 3].

Collision found: LLD §4.1 puts the shipped default `MenuConfig` with the MenuRail (shell), but §15.2 makes kind string literals (`'task'`, `'work_session'`, `'team_member'`, `'pull_request'`) a BUILD FAILURE anywhere outside `domain/` and `fixtures/`. The shipped default is defined by WLT §2 to name kinds, so as authored in `src/shell/menu-default.ts` it would have failed the CI grep the moment that grep landed. The two rules collided head-on; A1b escalated rather than choosing.

Ruling: the constant moves to `src/domain/`, beside the kind registry, where kind literals are already legal. **§15.2 stays STRICT — no second named exception is added** (the route codec's `strategy` branch remains the only one), on the reasoning that every exception weakens the grep. `MenuRail` imports the constant from `domain/`, which is DAG-legal (`domain ← … ← shell`).

Scope of the move, precisely: only the kind-naming DATA moves — `SHIPPED_DEFAULT_MENU` and `SHIPPED_DEFAULT_MENU_REVISION`. The fail-closed resolver (`resolveMenu`, the structural validator and its `MenuSource`/`MenuFallbackReason` vocabulary) and `VIEW_PRESENTATION` STAY in `src/shell/`: they contain no kind literals (`ViewRef` is a closed six-member view union, which is shell's own territory), and they are rail *behavior* rather than registry *data*. Moving them would relocate shell's fail-closed tests into the registry lane and blur the ownership line the ruling is drawing.

Rationale: the general principle the collision teaches — **data that must name kinds belongs where kind literals are legal, and the rule that keeps per-kind behavior out of components is worth more than the convenience of co-locating a constant with its renderer**. §4.1's placement was about which component *renders* the default, not about which module *owns* it.

## D19 — Per-kind `defaultMode` / `hiddenModes` are authored from kind semantics (2026-07-28)

Source: A1a nav/registry worker, building `src/domain/registry.ts`; approved by fe-coordinator [fe->a1a 3].

Finding first: **neither governing spec supplies any per-kind registry DATA.** WLT §2.1 gives slugs and route strategies; TM8-UI-SPEC-FINAL §4.5.1/§4.5.2 give the row SHAPE and the `ListConfig` field set. Both deliberately stop at the shape and defer the values (SPEC-FINAL §5 item 3 says so outright: "the §4.5.2 config gives structure; the visual language is undesigned"). Verified by walking both files for `defaultMode`, `hiddenModes`, `lifecycleTabs`, `primaryAction`, `quickLaunch`, `liveCount`, `needsAttention` — every hit is a schema declaration or a back-reference, never a value.

Ruling: the values are authored in the registry from kind semantics (tasks default to `list` with nothing hidden; sessions hide `gallery`; docs hide `board` because they have no status axis; commits default to `feed`; files default to `gallery`; the restricted kinds — `project`, `interaction_profile` — hide `board`/`tree`/`gallery`; `message` is never routed as a collection). They are DATA and a later canvas or measurement changes them without touching a component.

**`'graph'` is NEVER a member of `hiddenModes` for any kind: R7 requires it visible-and-disabled in the switcher, which is a different state from hidden-by-config.** Conflating the two would silently delete an R7 affordance instead of rendering it honestly. A test asserts the absence across every row.

Same class, same disposition: the Z1 chip glyphs are text placeholders in the canvases' own idiom. Replacing them with the canvas-extracted set at reference capture is a data edit in the registry and touches no component.

Rationale: the specs left the values open on purpose; L2 says the values must live in registry data either way; and the graph clause is where a plausible-looking simplification would have cost a ruled behavior.

## D20 — INTERIM: session lifecycle tabs carry a client-side status partition, because the contract cannot express one (2026-07-28)

Source: A1a nav/registry worker; measured gap. fe-coordinator APPROVED AS INTERIM [fe->a1a 3] and escalated the underlying gap to master as a candidate additive contract amendment.

Measured gap (walked against `packages/contract/src/contract.ts`, not assumed): `CollectionQuery.filters` offers `workStatus` (the TASK vocabulary: `open|pulled|working|in_review|done|blocked|cancelled`), `axes`, `assigneeIds`, `edge`, `readyToPull`, `inReviewForActorId`, `mentionedActorId`, `inFlightForActorId`, `needsActorId`, `deleted`. **There is no member that filters `work_session` rows by `WorkSessionStatus` (`spawning|running|idle|exited|failed`).** So the WLT §3 survival item "sessions lifecycle tabs" had no expressible field — precisely the LLD's own "a behavior with no field is a spec defect" case.

Ruling (INTERIM): `ListConfig.lifecycleTabs` entries keep the LLD's contract-shaped `filter` AND carry `statuses?: readonly WorkSessionStatus[]`. The `statuses` member is applied as a **client-side partition over rows the seam has already delivered** — `EntitySummary.state.status` — never as a synthesized query. The list panel reads it STRUCTURALLY (`'status' in row.state`), so no kind literal leaves `domain/`. No contract shape is invented and no seam method is added; the §10.7 register is untouched.

**This partition retires mechanically if/when the contract gains a session-status filter member** (R4-legal, additive, server-owner's queue): the field is deleted, the tabs' `filter` absorbs it, and no consumer changes.

Rationale: the honest unblocking shape. Inventing a contract field would leak a fake seam (D6's lesson); dropping the tabs would delete a ruled survival behavior; filtering rows the seam already sent is presentation, which is what a UI is allowed to do.

## D21 — RFC 3986 percent-encoding governs DATA, not a grammar's DELIMITERS; one canonical form per route (2026-07-28)

Source: A1a nav/registry worker. Raised as a defect by A1b from a whole-package test run, diagnosed the other way by A1b and then by fe-coordinator; **both diagnoses retracted after measurement** ([A1b->A1a 3], [fe->a1a 5]). This entry records the settled rule because it will govern every future URL parameter.

The question: WLT §2.2 says "RFC 3986 percent-encoding" and defines `t` as "comma-joined `{entityId}:{tab}` pairs". Should the `:` and `,` be percent-encoded?

Ruling: **NO — structural delimiters stay literal; only DATA that would collide with them is escaped.** This is the same rule the query string itself follows (`?a=1&b=2` keeps `&` and `=` literal and escapes them inside a value). Percent-encoding the `:` would leave nothing separating the pairs, making the parameter unparseable by its own stated grammar. Concretely: `t=<id>:discussion`, `contentSurface=<id>:chat`, `p=<id1>.<id2>`, with `:` / `,` / `.` escaped when they appear INSIDE an id. `.` needs an explicit escape because `encodeURIComponent` does not escape it and `.` is the `p`/`pin` delimiter.

The proposed tolerance "encode on build, accept both on parse" is REJECTED for a second, independent reason: **a codec that accepts two spellings of the same URL has two canonical forms**, which breaks the LLD §6 idempotent-`replaceState` law downstream — the normalization settle would keep rewriting between spellings.

The real defect underneath, and the one worth remembering: the parser was **double-decoding**. It read the query through `URLSearchParams` (which decodes once) and then decoded each sub-token again, so any id containing `%`, `.` or `:` came back mangled — or threw, and the whole parameter was atomically discarded, which looks exactly like a hostile URL rather than a client bug. Fixed with a raw query splitter: exactly ONE decode happens, on the sub-token.

Rationale: two people independently read "RFC 3986 percent-encoding" as reaching the delimiters, which is why it is written down rather than left to the code. The process lesson is recorded too: the failing test's raw diff was the useful artifact; the theories attached to it were wrong in both directions (R15 corollary — two symptoms that look alike are not the same defect until the mechanism is established; four reds here had two mechanisms).

## D22 — The live-session WORD is `running`/`streaming` on a row; `live` belongs to the bar's count (2026-07-28)

Source: A1c primitives worker raised it as a canvas/data mismatch; ruled and landed by A1a in the registry.

Finding: `liveTreatment('live')` returned the word `live`, but T0-3's Sessions panel and T0-2's chrome strip draw `streaming` when bytes are moving and `running` when they are not. `live` is the word on the live-session BAR's count (`● N live`), never on a session row.

Ruling: the words live in the registry (L2), not in a render path. `LiveTreatment` for the `live` verdict is `{ label: 'running', tone: 'run', dot: 'solid', attachable: true, streamingLabel: 'streaming' }`. Two consequences:

1. **`dot` narrowed from `'pulse'|'solid'|null` to `'solid'|null`.** The verdict may no longer emit `pulse` at all: a steady dot is what a liveness verdict justifies, and the animated dot belongs to the pool activity signal via the `tile.pulse` binding. The two sources stay visibly distinct in the type.
2. **Only the `live` verdict carries `streamingLabel`.** `stale`, `not-running` and `unknown` deliberately have none, so a non-live verdict has no streaming word for any render path to reach for. "Activity may REFINE a live verdict and may never promote a non-live one" stops being a rule one function has to remember and becomes a shape the data cannot express. A test asserts the absence, so a future edit that adds a streaming word to `stale` fails rather than quietly making a dead session look busy.

Rationale: D6's two-source law, made structural instead of procedural — and the canvases' own words, which is where the words should have come from in the first place.

## D23 — The four tokenless canvas colours live in `src/styles/canvas-extra.css`; nothing else in `src/` carries a hex (2026-07-28)

Source: A1c (universal primitives + session panel + palette worker), building the terminal chrome and the T1-4 honesty vocabulary. Ruled by fe-coordinator ([fe->a1c 6]) with A0 doorbelled for its own gates.

Ruling: `styles/tokens.css` stays byte-verbatim and cannot grow, but the canvases paint two regions with colours the token ramp has no entry for. Those — and ONLY those — are declared as named custom properties in a second file, `src/styles/canvas-extra.css`: `--pn-x-term-bg` (#0D0B08, the xterm black box), `--pn-x-term-live-bg` (#131009, live scrollback — declared now so the transport transplant binds to a name rather than minting a fresh literal), `--pn-x-term-ghost` (#4A4334, host placeholder text) and `--pn-x-warn-fill` (#FFF8EC, T4's caution fill under `unknown`). §15.2's hex ban therefore names exactly TWO exempt files: `tokens.css` and `canvas-extra.css`. Everything else derives: brand alphas use the token file's own `--pn-brand-rgb`, and other ramps use `color-mix(in srgb, var(--pn-…) N%, transparent)`, so both re-theme for free. A test in `panels/no-branching.test.ts` scans every owned stylesheet and component for raw hex and fails on any hit.

Rationale: §14's hex ban exists so a hundred careful transcriptions do not drift into a hundred palettes — one named, auditable, tested extension file serves that purpose exactly as well as zero would, whereas inlining four literals at their use sites would not. The alternative, editing tokens.css, would break the byte-equality transplant test for zero benefit.

## D24 — Always-dark regions open a nested `.cv2-root[data-theme="dark"]` scope instead of restating the dark ramp (2026-07-28)

Source: A1c, building the T0-2 chrome strip, live-session bar and roster. Approved by fe-coordinator as the same law as A1b's D16.

Ruling: the terminal chrome strip, the live-session bar and the roster popover are dark graphite in BOTH themes (T0-2: the xterm canvas is near-black in both, so the chrome touching it is pixel-frozen once, not twinned). They are rendered inside an `<AlwaysDark>` wrapper — a `display: contents` element carrying `className="cv2-root" data-theme="dark"` — which re-declares the real dark tokens through tokens.css's OWN selector. Those regions are then styled with ordinary `var(--pn-…)`. `display: contents` keeps the wrapper boxless so children still lay out in the parent's flex context; custom properties inherit through it unaffected. The theme-FOLLOWING parts of a session panel (header, action bar, tab strip, footer, and the exited fallback) stay outside the scope.

Rationale: the honest alternative was sixteen dark hex literals in a component stylesheet, which would rot the first time a token moved and could never be detected. This cannot drift by construction rather than by discipline. It also resolves the T0-2/T0-4 apparent conflict (T0-2 draws a LIGHT exited session panel; T0-4 draws the work_session card dark): the panel chrome follows the theme like every other kind, and only the strip and the host are always dark — which is exactly what T0-2 §10 says, and what "death reads as the terminal literally leaving the panel" means.

## D25 — The pool terminal-activity signal is consumed through a narrow port, not by building a TerminalPool in A1 (2026-07-28)

Source: A1c. Approved by fe-coordinator ([fe->a1c 3]) before implementation.

Ruling: `tile.pulse` and the live-session bar's dot need the LLD §9.2 terminal-activity signal, but `TerminalPool` belongs with the transport transplant that R9 defers to integration. A1 therefore declares only the CONSUMER side, at the exact §9.2 signature — `onActivity(cb: (sessionId, active) => void): Unsubscribe` — in `src/terminal/activity.ts`, satisfied in Phase 1 by `createScriptedActivitySource()` and at integration by passing `pool.onActivity` with no call-site change. The stub carries no timers: the real signal decays ~1s after the last flush, but a decay clock would make every test time-dependent for no fidelity gain, so tests and the gate demo drive `setActive` explicitly.

Rationale: building a pool nobody asked for, to obtain one boolean, would be inventing the thing R9 defers. A port is the smallest commitment that lets the gate demo pulse honestly and keeps integration a swap rather than a rework.

## D26 — Facet copy for the pairs the canvases do not freeze (2026-07-28)

Source: A1c. Approved by fe-coordinator ([fe->a1c 3]) with `unknown is never styled as success` named as the invariant the set must satisfy.

Ruling: the complete legal handoff matrix is 14 `deliveryStatus × recordStatus` pairs (`HandoffViewSchema` forbids a terminal record verdict on a `prepared`/`dispatching` delivery). T0-2 freezes three visuals (`delivered ✓` run, `delivery unknown ⚠` wait, `recorded` idle) and T4's share family supplies three more (refused → block with a cross glyph, withdrawn → wait pill plus an audit line that decorates and never rewrites, sourceMissing → dashed row plus a bare amber word). The remaining states are authored in `panels/share/facets.ts` against the established grammar — green = proven good, amber = warn/partial, red = failed, grey = neutral/in-progress: delivery `prepared` → "preparing" (idle), `dispatching` → "sending" (idle); record `pending` → "recording" (idle), `failed` → "record failed" (block). Every facet also carries a longer `detail` sentence for title/aria. T0-2's trailing-glyph word order (`delivered ✓`) is used in the session panel rather than T4's leading-glyph form (`✓ delivered`), since T0-2 is that surface's canvas.

Rationale: LLD §16 leaves exact copy to build time. The un-speced set was two states wide, not four, only because the T4 extraction was read against T0-2's — the cross-canvas check is what kept this from being a bigger invention. Tests pin that every row renders exactly two pills and that no `unknown` delivery ever wears the run tone.

## D27 — `unknown` liveness renders the word "unverified", not "running" (2026-07-28)

Source: A1c, building the T0-2 chrome strip pill, which the canvas does not draw for the `unknown` verdict.

Ruling: LLD §3.1 words the `unknown` verdict "running per record · unverified", which does not fit a 9.5px pill. The strip pill therefore reads `unverified` (idle tone, hollow dot) with the full sentence on `title` and in the fallback body; the registry's `liveTreatment` keeps the long form for list rows, where there is room. The word is never `running` alone.

Rationale: the pill must not be able to be misread as a claim of life. "unverified" is the shortest word that states the actual epistemic position, and the full sentence is one hover or one screen-reader stop away. Consistent with D6: a running record without liveness proof must never render as live.

## D28 — Disabled-with-reason controls are `aria-disabled` and FOCUSABLE, never natively `disabled` (2026-07-28)

Source: A1c, building the T1-4 honesty vocabulary (`panels/honesty/`).

Ruling: every disabled-with-reason affordance renders as a focusable element with `aria-disabled="true"`, no click handler, and its reason wired through `aria-describedby`. The reason text is always in the DOM; the tooltip form hides it with `opacity`/`visibility`, never `display: none`. The native `disabled` attribute is not used on these controls.

Rationale: a natively disabled control leaves the tab order, so a keyboard-only or screen-reader user can never reach it and therefore can never learn WHY the feature is unavailable — which defeats the entire treatment, whose whole purpose (L6) is that the user learns the affordance exists and why it cannot be used right now. `display: none` on the tooltip would remove the reason from the accessibility tree for the same reason. C8 makes accessibility a release criterion, not polish.

## D29 — The share drop target refuses at the BROWSER level, not by swallowing the drop (2026-07-28)

Source: A1c, building the §8 row-8 drag-share visuals while `handoffs.send` is a §10.7 deferred amendment.

Ruling: while the send operation is unavailable the drop target is VISIBLE and labelled with its reason, and refuses by NOT calling `preventDefault()` on `dragover`. That is the platform's own refusal mechanism: it shows the "no drop" cursor and fires no `drop` event. The target does not accept a drop and then report failure. When the amendment is stamped, one `accept` flag flips and the same component begins accepting — no new surface and no new copy path. A test asserts `defaultPrevented === false` on dragover.

Rationale: L6 forbids a ghost advertising an action the facade cannot perform, and T4's drag-ghost note forbids silent drops. Accepting the drop and showing a toast afterwards would create a window in which the UI appears to have taken the share — the worst of both, since the user has already let go.

## D30 — In A1, non-terminal archetypes render the GENERIC body over a default `fields` block (2026-07-28)

Source: A1c, per the fe-coordinator brief ("generic archetype body for A1 — per-kind bodies are A2 fan-out").

Ruling: `EntityDetailPanel` switches the Content body on `panel.archetype` — a registry field, never a kind. The `terminal` archetype is fully built in A1 because it is the gate's session panel. The other five (`subtree`, `reader`, `hub`, `profile`, `generic`) all render `GenericBody`; where a registry row declares no `blocks`, the panel falls back to a single `{ block: 'fields' }` so the entity's REAL scalar content shows rather than a placeholder. The archetype bodies slot into that one switch in A2 without touching the chrome.

Rationale: an honest partial beats a "coming soon" — a task panel that shows its description and fields is useful at the gate, whereas an empty frame teaches nothing and hides whether the data path works. The fixed anatomy is exactly what makes this substitution free later.

## D31 — The collapsed rail's live mark is a COUNT, not an animated dot (2026-07-28)

Source: A1b shell worker, found by re-reading DECISIONS.md on A1a's D19–D22 doorbell (a title that "sounded like it might reach my rail" did). Co-signed by A1a, who verified it in the tree and supplied the a11y ground; scope widened by fe-coordinator; D28 compliance folded in from A1c.

Ruling: `.shell-rail__live-corner` — the collapsed 48px rail's live-session mark — renders its COUNT as text, does not animate, and sits bottom-right so it cannot collide with the badge corner. The collapsed row's `aria-label` is composed from every part it shows (`"Sessions, 18, 3 live"`). The live word rides along visually-hidden in the expanded row AND leaf marks.

THREE INDEPENDENT GROUNDS, any one sufficient:

1. **The two-source law.** D6 / LLD §2.2-F1 / R-UI-5: pulse is a declarative binding from the POOL ACTIVITY signal, gated on a live verdict, never a function of liveness data. LLD §5.4 confirms every legal pulse is attributed to ONE identified session ("the FOCUSED session's activity signal"). A kind row has no focused session, so no honest attribution exists even in principle — a pulse there would **claim streaming knowledge the UI cannot have** (fe-coordinator's framing). D22 is the sibling application of this same law to `LiveTreatment`; it is NOT the primary authority here, because a rail count is not a `LiveTreatment` (A1a's correction to A1b's initial framing).
2. **§13 — status is never conveyed by motion alone.** Collapsed, the dot was the ONLY carrier: no number, no word, `aria-hidden`. The `prefers-reduced-motion` block — written to SATISFY §13 — is what erased the status entirely for reduced-motion viewers. A correct rule cannot have a correct exception that deletes the information.
3. **C8/L10 — status is colour + word.** A bare dot is colour alone, so T1-4's collapsed treatment cannot carry status regardless of whether it moves.

Canvas supersession: T1-1 draws this dot pulsing, bare, and numberless. Superseded on all three grounds — the D1 shape (binding law over a canvas pixel), not a worker entry overriding a canvas. Note this is a scope increase against the PIXEL only, not against the DESIGN: the collapsed badge corner already renders numbers, so this extends the canvas's own established vocabulary to the one row whose information was being dropped (fe-coordinator).

PRE-EXISTING DEFECT RECORDED, so it is not misread as a regression this fix introduced: an `aria-label` on a button REPLACES the accessible name computed from its contents. The collapsed row carried one (the bare kind name), so the badge count was ALREADY invisible to assistive tech — since the day it was written. The degrade-don't-disappear principle was therefore broken in BOTH corner marks, differently: live dropped its count for everyone, badge dropped it for AT only (A1a).

HOW THE DEFECT SURVIVED — the part worth more than the ruling:

- **A comment stating the correct principle sat two lines above the code violating it.** `"the count is information, so it degrades rather than disappearing"` — honoured by the badge block, violated by the live block directly beneath.
- **A green test named "counts survive" stood over a dropped count.** It asserted the badge's NUMBER but, for live, only that the element was NOT NULL — an assertion a decorative dot satisfies perfectly. The corpus rule verbatim: *state what your check can be satisfied by, not what it asserts.* An absent detector is a known gap; a present detector asserting the wrong half is a false assurance, and this file had the second.
- **The replacement detector had to change shape to work.** The first plan — assert no element carries a `pulse` class — would NOT have caught this: the offending class was `shell-rail__live-corner`, containing no such substring, with the animation attached in CSS, and jsdom loads no stylesheets. `no-motion-status.test.ts` therefore scans the STYLESHEET SOURCE and treats every `animation:` declaration as guilty until allowlisted (allowlist empty by design). Proven both halves: red on known-bad (animation re-introduced ⇒ exit 1, the offending selector named), green on known-good (exit 0).

Also landed under this entry: D28 compliance for the two disabled-with-reason controls (`＋ add server`, `+ add space`) — native `disabled` removed in favour of `aria-disabled` + focusable, since a natively disabled control leaves the tab order and takes its reason with it. Their tests now encode D28's full trio — present, announced, REACHABLE — with the native attribute asserted FALSE as a positive guard against reintroduction (A1a's suggestion; the previous assertion demanded the very defect D28 forbids).

## D32 — Disabled opacity follows what T1-4 DRAWS, not what its annotation says (2026-07-28)

Source: A1c, building `panels/honesty/`. Raised as ambiguity F-4 by the T1-4 canvas extraction.

Ruling: T1-4's annotation prose says disabled-with-reason is "45% opacity", but the frames draw two different values by FORM — the tooltip-form icon controls are `opacity: .55` in light and `.7` in dark, and only the inline-caption buttons are `.45`. The drawn values are implemented. Two forms, two opacities: `.55/.7` for icon controls, `.45` for inline-caption actions.

Rationale: the canvases are the pixel ground truth per the charter, and where an annotation and the frame it annotates disagree, the frame is the artifact that was approved. The split is also defensible on its own terms: an icon control has no text to carry the meaning, so it cannot afford to fade as far as a labelled button can. The dark tooltip control sits at `.7` for the same reason — the dark ramp's ink-4 is already low-contrast, and `.55` on top of it would fall below legibility.

## D33 — One tree guide-line formula, because the canvas frames disagree with each other (2026-07-28)

Source: A1c, building `EntityListPanel`. Raised as ambiguity #1 by the T0-3 canvas extraction.

Ruling: T0-3 states "+17px per level" in its geometry footer, but no frame's guide line obeys it — the guide sits at `left: 14px` in the Tasks panel, `17px` in Sessions, `11px` at the floors, and `7px` (plus `24px` at depth 2) on the tree-geometry reference card. Implemented as ONE formula: row `padding-left: 10 + depth × 17`, guide hairline at `left: 4 + depth × 17`, 1px in `--pn-line-2`. The reference card is treated as the authority because it is the frame drawn expressly to specify the geometry, and its 7 → 24 step IS a 17px stride.

Rationale: four different offsets across four frames is drift in the source, not four intentions, and shipping a per-panel offset table would preserve an accident forever. One formula that matches the stated stride and the frame drawn to define it is the only reading that is self-consistent. Flagged for the D10 real-browser pass: this is the kind of 3px difference a pixel diff will adjudicate better than arithmetic can.

## D34 — The SHORT status word is registry data; supersedes D27's presentation-layer reading (2026-07-28)

Source: A1c and A1a jointly. A1c hit a floor overflow; A1a independently found a copy-drift under the same ruling; the two messages crossed in flight proposing the same field.

Ruling, three parts:

1. **`LiveTreatment` gains an optional `shortLabel`** (`stale` → "stale", `unknown` → "unverified"), which surfaces render wherever the long label does not fit. This SUPERSEDES the part of D27 that read the short pill word as a presentation-layer variant: D22 settled that status words live in the registry, and D27 as written pointed the other way on the same question. The contradiction is resolved in D22's favour rather than documented. A1c's interim `shortenWord()` in `EntityListPanel.tsx` is deleted when the field lands.

2. **The defect that forced it.** `.lp__word` is `white-space: nowrap` in a `flex: none` slot, so a 31-character label ("running per record · unverified") at the 200px left-panel floor is wider than the row's whole content box, and the title — the only `flex: 1; min-width: 0` element — absorbs the entire loss and collapses. That inverts the floor law: the title is meant to be the one thing that shrinks, not the one thing that disappears. T0-3 frame 4 already rules the behaviour, drawing "stale" rather than "stale — node restarted" at the 220px floor and captioning it *"state word survives; 'node restarted' moves to detail"*. NOT browser-measured — jsdom has no layout engine — so it is on the D10 list; the mechanism is readable off the box model.

3. **One sentence per state.** Review found TWO authored explanations of the `unknown` verdict: the registry's `liveTreatment('unknown').reason` and a near-identical `??` default inside `UnverifiedFallback`. The default is DELETED rather than replaced — when no reason is passed the component renders no explanatory sentence at all, since the title and pill still identify the state completely. `session-presentation.ts` likewise stops restating the registry's long form; the strip takes an optional `statusDetail` and `panels/` threads the registry sentence in. `src/terminal/` cannot import the registry to fetch it itself — that would mean naming `work_session`, the §15.2 build failure — so passing it down is structural, not incidental.

Rationale: a near-duplicate sentence is worse than no sentence, because it reads as authored copy and diverges silently; only a line-by-line review finds it. The corrective also caught a test that had pinned the duplication in place (it required the presentation layer's `full` to contain "record") — worth naming, because a test can lock in a defect exactly as firmly as it locks in a requirement, and a passing suite is not evidence that what it asserts is right.

## D35 — A `FilterSpec` renders as ONE chip; the filter row is bounded by construction, not by clipping (2026-07-28)

Source: A1c, from a gate-screen defect A1b found in a real-browser pass and handed over with a repro rather than a fix (the file is A1c's). Ruled and fixed in A1c's lane per fe-coordinator routing.

Ruling: the list panel's filter row renders **one chip per ACTIVE selection**, exactly **one `filter ▾` trigger**, then the sort chip. It does NOT render one chip per option. The unbounded option set lives in a picker popover that scrolls. A `multi` spec's selected options UNION their contract filters rather than overwrite. At the floor the sort chip collapses to `↓` and never disappears.

Rationale, and the reason this is a ledger entry rather than a bug fix: the row had been flat-mapping every option of every `FilterSpec` into its own chip, so `task` emitted ten chips (7 status + 1 ready-to-pull + 2 deleted) into a row that is `overflow: hidden`. Three things make it worth recording.

1. **The type already said so** — "One filter chip in the list/collection filter row" — and all three T0-3 frames draw it that way (`mine ✕ · filter ▾ · ↓ priority`). This was a misread of the data shape, not a missing decision, and the registry data was correct throughout.
2. **`overflow: hidden` hid the evidence.** Ten chips presented as one truncated label, which is why it read as cosmetic. Clipping is a legitimate floor guard against one over-long chip; it is NOT a bound on chip COUNT, and using it as one converts a structural error into a visual smudge. The row is now bounded by what it renders.
3. **A second affordance was lost and nobody had named it.** The sort chip is absent entirely from the before-state screenshot — pushed out of the clipped row. A truncated `Blo…` is not merely ugly: it is an affordance the viewer cannot know exists, which is the quiet cousin of the disabled-with-reason problem (D28) — a control the user cannot reach cannot tell them anything. That framing is A1b's and is adopted here.

Same floor-inversion class as D34 (unbounded content in a fixed slot destroying the slot), different root: a misread data shape rather than a long word.

**Corollary, from the same pass:** popovers dismiss on Escape (consumed per C6 layer 2, so dismissing a picker never also pops the panel stack) and on outside pointer-down. The real-browser pass caught this in the new filter picker AND in the kind selector written hours earlier; both were fixed through one shared `useDismissable` rather than patching the instance under review. Jsdom could not have found it — nothing in a unit test notices that a popover has no way out.

## D36 — In-panel list search is `f`; `/` stays the palette's guaranteed path everywhere (2026-07-28)

Source: A1a nav/registry seat, ruling requested by fe-coordinator during R5 gate iteration (user finding #2 — in-panel list search, T0-3 anatomy). The coordinator's stated read was that layer 5 should consume `/` for search-focus ahead of layer 6's palette binding; that read is **not** adopted, for the reason below.

Conflict: WLT §5.8 publishes plain `/` as the palette's path **"everywhere"** and names it the GUARANTEED one. T0-3 draws slash-focus on the panel's search field. Both cannot hold.

Ruling: **`/` is untouched — it opens the palette at layer 6 from every focus state, including a focused list. In-panel search binds to plain `f` at layer 5.**

Why the obvious reading fails, and this is the load-bearing part: `/` is guaranteed *because* `⌘K` is browser-owned on Chrome Windows/Linux and on Firefox everywhere (WLT §5.8's own collision matrix). A focused list is the workspace's most common focus state. Consuming `/` there would leave the palette with **no reachable binding at all on half the supported matrix, in the state users occupy most of the time** — and `Esc` does not rescue it, because at layer 5 `Esc` pops the panel stack rather than blurring to chrome. The guarantee would survive in the published text and die in practice, which is the failure mode C6 exists to prevent: the map is a contract, not a per-context lottery.

`f` (find) is free, browser-proof, mnemonic, and gives search a guaranteed path of its own rather than borrowing the palette's. Consequences, all asserted by tests:
- Layer 3 untouched — a focused terminal still owns `f`, and nothing about the terminal contract changes.
- Layer 4 governs the field once focused: every plain key is dead (so typing `f` types an `f`), `Mod` chords stay live where receivable, and `Esc` blurs the FIELD rather than popping the stack.
- **`Mod+F` is deliberately NOT bound.** It is absent from WLT's hard-exclusion list, but every browser opens its own find bar on it, and the contract never advertises a chord the browser owns (R8-3).

Canvas disposition: T0-3's slash-focus pixel is **superseded**, the same shape as D1 retiring the tab-bar toggle the T0-1 canvas still draws — a published keyboard guarantee outranks a canvas affordance, and the authority chain (rulings → DECISIONS → WLT → SPEC-FINAL → canvases) says so directly. The canvas is right that the field needs a keyboard path; it is wrong about which key was available to spend.

Rationale: the binding philosophy (R8-3) makes the browser-proof plain-key core the thing everything else is arranged around. Spending the one guaranteed global key on a per-panel affordance inverts that, and the cost lands invisibly — on keyboard-only users, on exactly the platforms where the fallback is already gone.

## D37 — Correction to D36: the slash hint is drawn by T0-1, not T0-3 — and the hint chip must render `f` (2026-07-28)

Source: A1a nav/registry seat, self-correction. Prompted by fe-coordinator's #2/#3 dispute resolution ("the authority was T0-1's in-situ panels; T0-3 draws neither"), then MEASURED against the canvas files rather than accepted as a second relay.

**What D36 got wrong.** D36's canvas-disposition paragraph asserts that "T0-3 draws slash-focus on the panel's search field" and declares that pixel superseded. **T0-3 contains the string "search" zero times.** It draws no search field, so there was nothing there to supersede. I took that claim from the ruling request and repeated it as fact in a ledger entry without opening the canvas — a relayed claim published as a measurement, which is the failure this program has spent the day naming in other people's work.

**What is actually true, and it does not weaken D36.** `T0-1 Workspace Hi-Fi` — THE GATE TARGET — draws the search field in BOTH side panels, with a per-kind placeholder (`Search teammates`, `Search projects`) and a mono key-hint chip. The chip's literal content is:

```
⌕ {{L.search}}<span style="flex:1"></span><span style="font-family:'JetBrains Mono';font-size:10px">/</span>
```

So the slash-focus affordance is real and IS drawn — in T0-1, not T0-3. D36's ruling (`f` for in-panel search, `/` reserved to the palette) and its supersession stand unchanged on their own argument, which never depended on which canvas drew the chip. Only the citation was wrong.

**The consequence D36 missed, which is why this is a correction and not a footnote.** Because the chip lives in T0-1, it is ON THE GATE SCREEN. A reviewer opening the master screen will see a `/` hint next to a field that answers to `f`. Ruling: **the hint chip renders `f`.** A key hint is not decoration — it is the contract's own advertisement of itself, and a chip that names a key the app does not bind is a lie in the one place a user goes to learn the key. This is the same discipline as R8-3's "never advertise a chord the browser owns", applied to our own binding: never advertise a key we did not bind.

Note for the R5 reviewer: the `/` in the canvas is not a defect in the design — it is the same key-budget collision D36 resolved, drawn before the collision was noticed. The canvas is right that the field deserves a hint; `f` is what the hint says.

Method note, recorded because the correction was nearly missed twice: my first two attempts to verify this used `placeholder=` and `<input` as probes and returned zero for EVERY canvas including the one that demonstrably has search fields — the canvases are inline-styled divs with no form elements at all. A clean zero from a detector that cannot fire is not evidence, and I only caught it by checking that the probe fired on a known-positive first. The probe that works is the literal glyph-and-token shape (`⌕ {{…}}`).

## D38 — Canvas hierarchy: T0-1's in-situ anatomy EXTENDS the component canvases; walks check the composed one (2026-07-28)

Source: A1c, from an anatomy walk that produced a confidently wrong answer at the R5 gate. Corrected by fe-coordinator, who verified T0-1 independently; A1a's D37 corrects the same miss from the keyboard side.

Ruling: when auditing a surface for missing elements, the COMPOSED canvas (T0-1, the gate screen) is authoritative over the dedicated component canvas (T0-3, T0-4) for what that surface carries IN SITU. T0-1's panel headers draw elements T0-3's dedicated panel frames do not, and T0-1 wins. An anatomy walk that measures only the component canvas is measuring the wrong artifact.

Rationale, and the incident: asked to sweep the list-panel header for missing elements, I walked T0-3 element by element, measured all five of its frames, and reported — accurately — that T0-3 contains zero search glyphs, zero occurrences of the word "Search", and no view switcher in any frame. I concluded the features were unspecified and asked for a ruling before building. T0-1 draws BOTH: each panel header carries a bordered `⌕ {search}` input row with a mono hint chip, and its support code builds `views = [['≡','List'],['⑂','Tree'],['▥','Board'],['◉','Graph']]` with active-colour logic. The measurement was correct; the artifact was wrong. Two corroborating arguments I offered (ListConfig has no search field; the palette is the search surface per §4.2) were consistent with my wrong answer and did nothing to catch it — agreement among sources that share an assumption is not corroboration.

Consequences adopted:
1. **Anatomy walks name their artifact and check the composed canvas.** "T0-3 draws no search" and "the design specifies no search" are different claims; only the first was measured.
2. **A drawn pixel loses to a later ruling, and the ledger says which.** T0-1's hint chip draws `/`; D36 binds `f`; the chip ships `f`. A chip naming an unbound key is a lie in the one place users look to learn keys.
3. **The four switcher positions come from T0-1, not from the registry's six modes.** `feed` and `gallery` are CollectionView layouts (A2); the composed workspace canvas does not offer them in a side panel. `hiddenModes` may show fewer, never more.

## D39 — The verdict outranks the record at EVERY consumer, and dead registry data is a defect class (2026-07-28)

Source: A1c, from R5 gate findings #1 and #4 — both reported as separate defects, both one mechanism.

Ruling, two parts:

1. **Wherever a `liveTreatment` exists for a kind, it owns the status presentation** — the header pill, the tile word, and the chrome strip alike. A kind's own `statusPill`/`tile.badges` status source fills that slot only where no verdict is available. The record's claim is never discarded (the registry's authored label states and withdraws it in one breath) but it never wears the live treatment alone. Rendering record-`running` in live green above a session the node reports stale is the D6/R-UI-5 violation, and it shipped to the user's screen because this rule existed in the tile and nowhere else.

2. **Registry data with no consumer is a defect, not a latent feature.** `ListConfig.tile.badges` — 35 sources across 16 rows — had no reader at all; the renderer consumed only `tile.pulse`. Every kind rendered a bare title, and `work_session` looked correct solely because it owns `liveTreatment`, a different field on a different path, which disguised a universal break as one kind's bug. The guard is a CONSUMER-COVERAGE test deriving the source set from the registry (not from the type union) and asserting the renderer handles each: the next added source fails loudly rather than rendering nothing.

Rationale: the finding-class sentence is **a consumer that has the authoritative fact available and renders a lesser one**. All four gate findings were instances — the tile ignored its badges, the header ignored the verdict, the action bar was never handed the verdict or the capabilities the same panel was holding three lines above. Note the shape of the near-miss on the guard: a registry-side test asserting `tile.badges` is POPULATED passed throughout, over data nobody read. A test on one side of a seam cannot prove the two sides MEET; only a test that crosses it can.

## D40 — Correction to D24: the whole work_session panel is an always-dark shell, not just the strip and host (2026-07-28)

Source: A1c, from R5 gate finding #5 — the user's words were "TERMINAL SHOULD FULLY COVER". Measured against T0-1's in-situ (Z3) session markup and ordered by fe-coordinator as an append-only correction rather than an edit to D24.

Ruling: the `work_session` panel renders in the always-dark scope IN ITS ENTIRETY — breadcrumb, header, action bar, tab strip, Content body sections, reserved seam, banner, canvas, the exited/stale fallbacks, and the footer. Not the strip and host alone. D24's mechanism is unchanged and untouched: a nested `.cv2-root[data-theme="dark"]` scope re-declaring the real dark tokens through tokens.css's own selector, zero duplicated hex, cannot-drift-by-construction. **Only the scope BOUNDARY moves.** Keyed on `panel.archetype === 'terminal'` — a registry field, never a kind literal.

Measured values from T0-1's Z3 session panel, which is what settles it: every hairline `#2C2719` (dark line); title `#EFE9DB` (dark ink); provider and controls `#8C8470` hovering to `#302A1D`; close-hover `#DA7D6A`; section eyebrows `#665E4C`; project chip `#BDB5A2` on `#1B1810` with border `#3B3524`; terminal `#131009`; **and the EXITED fallback on `#1B1810` — dark, not paper.**

Also corrected here: the reserved seam is **24px**, not the 34px built from T0-4 anatomy prose.

Rationale, and the provenance, which is the part worth keeping: D24 ruled that panel chrome follows the theme and only the strip and host stay dark, and its stated evidence was T0-2's `#exited` frame drawing a LIGHT exited session panel. That frame is a standalone COMPONENT frame. The COMPOSED canvas draws the same state dark. **Generalising from the component canvas to the composed one is precisely the error D38 names — and I made it before writing D38 and did not catch it while writing D38.** A ruling I authored was the provenance of a gate defect, and the ledger is where that has to be visible; the code fix and the ledger fix land together.

The symptom inverted the cause, which is why it took a measurement rather than a look: the xterm read as an *inset block with paper gutters*, so the natural reading was "the canvas region needs to be full-bleed". The canvas region was already full-bleed and measured clean (direct flex child, `flex: 1`, no margin, `min-height: 160`, scrolls internally). What was wrong was its NEIGHBOURS — the sections above and the fallback below wearing paper. **A region can look inset because it is inset, or because everything around it is the wrong colour; only measuring both tells you which.**

Verified in the browser at 1492×812 in BOTH themes. Dark theme cannot prove this law — everything is dark there. The LIGHT theme is the test that matters, and it passes: the session panel renders fully dark against a paper workspace, reading as designed rather than as a rendering fault. Evidence: `gate-evidence/T0-1-session-dark-shell-light-theme.jpg`, sha256 739974ee773a3ff42079f468a7f8c33667757030e62ce00509bce29971da61a6.

## D42 — Refinement of D38: the composed canvas governs COMPOSITION, the dedicated canvas governs GRAMMAR (2026-07-28)

Source: A1c, after over-applying my own D38. The correcting argument is A1a's, from its D17 precedent.

Ruling: D38 established that T0-1's in-situ anatomy EXTENDS the component canvases and that anatomy walks must check the composed one. That holds for **which elements exist** — it is how the search field and the view switcher were settled. It does **not** license "T0-1 overrides the component canvas on every question". The boundary, following D17's menu precedent (T1-1 governs menu ROW GRAMMAR, T0-1 governs rail COMPOSITION):

- **Composition** — which elements a surface carries in situ: the COMPOSED canvas (T0-1) governs.
- **Grammar** — the internal mechanics, labelling and persistence of an element: the DEDICATED canvas governs (T0-3 for the list panel, T0-4 for the detail panel).

Rationale, and the incident that produced it: I reported the task section labels as a "divergence" because T0-1 draws `NEEDS ATTENTION` / `IN PROGRESS` while the registry declares `CURRENT` / `COMPLETED`, and implied a rename. A1a measured both canvases and refuted it on three grounds. (1) It is not a divergence — T0-3 draws CURRENT/COMPLETED and T0-1 draws the other pair; the registry matches its governing canvas exactly. (2) They are not the same mechanism: T0-1's are `isGrp` group rows guarded by `sort === 'Default' && !anyF`, so they EVAPORATE on any sort or filter, while `sections` persist and carry `collapsedByDefault`. (3) `NEEDS ATTENTION` is the R8-dormant attention concept already carried as `needsAttentionGroup` — a predicate, not a section.

The cost had it been complied with rather than challenged: the rename would have silently deleted the completed/collapsed behaviour that WLT §3 lists as a survival item, and conflated a dormant designed-but-undetected feature with a live lifecycle split. I proposed it about another seat's data, from one canvas, while spending the same day arguing that conflating two axes is the defect class.

**A ruling generalised past its evidence is a defect with a citation.** D38 was correct and I applied it to a question it never addressed; the citation made the over-application look grounded. This entry is the boundary D38 should have carried.

## D43 — Lifecycle tiers are universal; tabs, footer and total read ONE per-tier query (2026-07-28)

Source: **USER at R5 review, via master.** THE GATE'S FIRST USER-RATIFIED ENTRY. Registry field by A1a; consumers by A1c.

Authority note, verbatim as ordered: **the user ratified the canvas ADDITION over WLT silence; WLT gains the tier by ratification, not by drift.**

Ruling: every collection kind carries the three lifecycle tiers Open / Done / Archived, in fixed order, as T0-1 draws them — plus the footer count line (`9 open · 601 done · 33 archived`) and the kind-selector total. Tabs are a lifecycle TIER; `sections` are triage grouping WITHIN the current tier; the filter chips narrow within it further. All three coexist — T0-1 draws tabs and group headers together, and neither supersedes the other.

Two consequences worth recording because they were nearly got wrong:

1. **COUNTS ARE NOT A REGISTRY FIELD.** Each tier's count is its own query's result total, and the tab label, the footer line and the selector total all read that one source. A count field would be a second source that could disagree with the query it claims to summarise — the three surfaces would then be consistent with each other and wrong together. (A1a's design, against my requirement as stated; they were right to refuse the shape I asked for.)

2. **`unsupported` IS THE HONEST-EMPTY ANSWER.** `archived` is a real query for every kind (`deleted: 'only'` is a genuine `CollectionQuery` member); `open`/`done` are only expressible where the contract knows a state axis. Every other kind's `done` tier carries an `unsupported` reason, renders with an honestly-zero count, and is dimmed but PRESENT — never hidden. Hidden and empty are different states (L6), and a tab that vanished per-kind would teach nothing about why. This means T0-1's drawn `Docs [Open 4, Done 58, Archived 4]` cannot be honoured: those are mock numbers and the contract has no doc-completion concept. Saying so is the ruling, not a shortfall.

Implementation note that cost a real bug: tabs and filter chips had been coded as either/or, which was invisible while `work_session` was the only kind with tabs. Making tiers universal deleted the filter trigger from every kind at once. The tests caught it. **A conditional that is only ever exercised on one branch is untested in the other, and the day it flips it takes a working feature with it.**

## D41 — Task sections are NOT renamed: T0-1's default grouping is a different mechanism (2026-07-28)

*Appended OUT OF NUMERIC SEQUENCE, after D43, and the reason is itself the point.* I cited D41 in four committed test names, in `registry.ts` comments and in commit `db18c95` before the entry existed — the number was claimed in code and never written, so the citations dangled against a record that was not there. Siblings appended D42 and D43 around the gap. Rather than renumber committed code I am writing the entry at its claimed number and recording why it sits out of order: a reference in durable code is a claim on the ledger, and claiming one without writing it is the documentation form of the commit-dangle I caused an hour earlier with a doorbell.

Source: A1a nav/registry seat. Raised as a canvas-conformance correction by A1c, relayed as an instruction by fe-coordinator, COUNTERED by me on measurement, and the counter accepted as the ruling by fe ([fe->a1a 34]).

**The claim:** T0-1's composed task panel draws sections `NEEDS ATTENTION` / `IN PROGRESS` where the registry declares `CURRENT` / `COMPLETED`; therefore rename the registry's sections.

**Measured, from the canvas files rather than the relay:** both label sets are drawn, in DIFFERENT canvases. `T0-3 Entity List Panel` contains `CURRENT` ×2 and `COMPLETED` ×1 and neither of the others; `T0-1 Workspace Hi-Fi` contains `NEEDS ATTENTION` ×1 and `IN PROGRESS` ×1 and neither of the others. So the registry never diverged from its governing canvas — it matches T0-3, the dedicated EntityListPanel canvas.

**Ruling: no rename. `CURRENT` / `COMPLETED` stands**, because the two are not the same mechanism. Verbatim from T0-1's source:

```js
const buildTasks = (sort, f) => {
  const anyF = Object.keys(f).length > 0;
  if (sort === 'Default' && !anyF) return [
    { isGrp: true, name: 'NEEDS ATTENTION · 2', gc: C.wait },
```

Three facts follow. (1) These are `isGrp` GROUP ROWS carrying a group colour; T0-3's are section EYEBROWS (mono 9.5px/600/.1em ink-3). (2) They exist only under `sort === 'Default' && !anyF` — a default-sort grouping that EVAPORATES on any sort or filter, where `sections` persist across both. (3) `NEEDS ATTENTION` is the R8-dormant concept the registry already carries as `needsAttentionGroup`.

**What the rename would have cost, which is why it was dangerous rather than cosmetic:** it would have silently deleted `collapsedByDefault` on COMPLETED — a WLT §3 survival item, the one class of behaviour the survival list exists to make undeletable — and conflated a dormant designed-but-undetected feature with a live lifecycle split.

**Disposition of T0-1's grouping:** recorded as an ADDITIVE default-`groupBy` candidate for the A2 wave (D2 axis-picker territory, `CollectionQuery.groupBy`). Not built now, and never as a substitution for `sections`.

**Left honestly open:** whether the DESIGNER intends T0-1's attention/progress grouping to supersede T0-3's sections in the shipped product. The canvases do not answer it — they show two mechanisms with different persistence and different colour semantics, and that is a mechanism finding, not a design-intent one. If the answer is "supersede", the correct change is still not a rename: it is sections replaced by a default groupBy, plus a decision about where the completed/collapsed split goes.

Precedent applied: D17's split (dedicated canvas governs GRAMMAR, composed canvas governs COMPOSITION), which A1c generalised as D42 after this counter.

Rationale: a difference between two canvases is not a divergence in the data, and "just rename the labels" is the shape a spec-defect takes when the two things being compared were never the same field.

## D44 — USER SCOPE DIRECTIVE: the Run workflow pulls forward from T5-5/A2 into current scope (2026-07-28)

Source: USER order at R5 review, via master coordinator. Ledgered by fe-coordinator.

Ruling: Every task/entity row gets a RUN BUTTON with the launch workflow behind it — launch profile, model selection, agent/teammate selection — in the CURRENT build, fixture-backed (fixture teammates/models/projects; spawn creates a fixture session; real execution.spawn wires at integration). Interaction shape is user-named: the maestro TaskTile expand pattern (row Run → inline quick config with teammate/model → full sheet), as a UX TRANSPLANT REFERENCE (reference paths recorded in the dispatch; R9 does not apply — this is interaction-shape reference, not code harvest). The T5-5 canvas remains the DESIGN authority for the full launch sheet (teammate rows with model+tool+owner, trust-gated M:N projects incl. scratch, profile resolution shown, refusal-card honesty). Registry-driven per-kind wiring via the existing rowActions carrier (B1) — no kind branching.

Rationale: User order supersedes the A2 deferral for this workflow; composition law reconciles the user-required interaction shape with the approved sheet design. Sequencing (fe call): the findings #1–#7 capture ships as R5-closure evidence immediately; the Run-inclusive capture completes the reviewed package in the follow-on window.
