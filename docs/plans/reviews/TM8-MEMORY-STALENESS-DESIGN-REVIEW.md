# W6 Design Review — Memory & Staleness (data model + API/CLI), verified against the tree

**Status: REVIEW. Read-only — no reviewed document was edited, nothing was implemented, no git was run.**
Reviewed on 2026-07-27 against the working tree at that date:

1. `docs/plans/TM8-MEMORY-AND-STALENESS-DESIGN.md` ("main design")
2. `docs/plans/TM8-MEMORY-STALENESS-API-CLI-DESIGN.md` ("API doc")

**Method.** Every claim carrying a `file:line` was checked by opening the file, not by re-deriving from
prose. Where the design's claim is about *runtime* behaviour, I traced the code path (facade → RPC →
trigger) rather than trusting the nearest comment; the live handler set was traced from
`main.ts` → `registerFacadeHandlers` (`facade/index.ts:121`) per the standing warning that this tree
carries superseded handler files. **Nothing was executed** — no server booted, no migration applied, no
test run. Everything below is a read of source; runtime claims are labelled as traced-not-measured.

**Verdict counts: 3 REFUTED design claims, 7 CONFIRMED findings, 3 PLAUSIBLE findings, ~40 checks
CLEARED** (the full cleared list — the denominator — is §5). The worst finding is **F1/F2 together: the
design's single most load-bearing mechanic (worktree merge ⇒ version bump ⇒ wholesale pin drift) does
not work as inventoried** — the version-bump trigger it silently relies on is per-table and the named
precedent (015) is a precedent for *not* wiring it, and the `entities.patch` door the transition needs
does not exist and is absent from the Phase-1 inventory. Both are cheap to fix and both would have
failed silently in the reassuring direction.

---

## 1. Answers to the API doc's six reviewer questions (§4), attacked first as instructed

### Q1. Initial-connection direction and atomicity — **CONFIRMED, design is right, with three nuances**

The live `entities.create` is the W2 service (`facade/index.ts:110-121` — G02 is registered first,
`register()` throws on duplicates, so exactly one owner exists;
`services/w2/entities-commands-tracking.ts:874-949`). It processes `input.connections` via
`attachInitialConnections` (`:783-827`), which calls `write_edge(entityId, connection.targetId, …)`
(`:805-812`) — **src is the new entity, dst is the target. New-entity-outward CONFIRMED**, corroborated
by the only other initial-edge mechanism, `internal.attach_on_create`, which inserts
`src_id = p_new_id` (`007_rpc_catalog.sql:899-901`).

**Atomicity CONFIRMED**: the door RPC, every `write_edge`, the ledger record, and the event capture all
run inside one `deps.db.tx` (`:879`); an edge failure throws, and rollback takes the entity, the ledger
row, and the events with it. So "one write, all-or-nothing" holds for `memory add` with pins.

Nuances the API doc should carry:

- **The mechanism is facade-generic, not door-specific.** `attachInitialConnections` runs after *any*
  kind's door. The new `create_memory` door needs **no** connections parameter — a simplification the
  doc can bank (its §1.1 table implies the door handles them).
- **GRAMMAR:308's wording ("validated before the entity is inserted") is not what ships.** Edges are
  validated *after* insert, same transaction — rollback-equivalent, but the doc cites the grammar law
  as "the load-bearing shipped fact" when the shipped fact is the W2 implementation. The grammar's own
  next bullet (`TM8-CLI-GRAMMAR-REDESIGN.md:309-310`) says the then-current `attachTo` **could not**
  implement the law and required an amendment; the amendment is what landed. Cite the implementation.
- Connection props with key `origin` are refused (`:797-799`, `forbidden`) — no mark props use it, but
  the props contract for mark types should note the reserved key.

### Q2. `--connect` props gap — **CONFIRMED, the doc is right**

`GRAMMAR:231` gives `--connect <edge-type>=<target-entity-id>` and §4's initial-connection bullets
offer no props form. A pinned atomic create is reachable only via `--data` or the `memory add` sugar.
§2.2's atomicity note stands as written.

### Q3. Error-code mappings — **verified end-to-end; what the §1.3 table should assert**

The full chain, traced: Postgres errcode → `translateDbError` (`db/errors.ts:62-85`, wired at
`db/client.ts:130,139,196`) → `CollabError` → `ERROR_STATUS` (`contract.ts:515-521`) → CLI
`EXIT_BY_COMMAND_ERROR` (`cli/errors.ts:52-66`). The mapping is mechanical
(`http/errors.ts:38-57`) and never regexes messages. So:

| errcode | code | HTTP | exit | Verdict on §1.3 |
|---|---|---|---|---|
| 23514 | `invariant_violation` | 409 | 6 | **CONFIRMED** — every trigger-refusal row is right |
| 22023 | `invalid_input` | 400 | 2 | **CONFIRMED** |
| 23503 / 23505 | `invariant_violation` | 409 | 6 | CONFIRMED (unclaimed but relevant: duplicate-mark upserts, see F3) |
| **23502** | **UNMAPPED → `upstream_unavailable`** | **503, retryable:true** | **7** | **See F5 — the doc understates this** |

**F5 (CONFIRMED, moderate).** The API doc's §1.3 row 1 calls a bare NOT NULL failure a "constraint
surprise". It is worse: 23502 is absent from `SQLSTATE_TO_ERROR_CODE`, so a memory missing a scope
field, absent a door pre-check, surfaces as a **retryable 503 "internal database error"** (plus a
server-side `unmapped SQLSTATE` log, `db/errors.ts:73-78`). A client told "retry" about a write that
can never succeed is the exact wrong-both-ways shape `http/errors.ts:42-47` documents for 22P02. The
pre-check-and-raise-22023 the doc marks [VERIFY] is therefore **mandatory, not stylistic**, and the
implementation gate should include the negative control: insert with missing scope through the raw
table (not the door) and observe the 503 — proving the pre-check is the only thing standing between
callers and it. The table should assert exactly that.

### Q4. `acyclic` enforcement for `supersedes` — **RESOLVED IN THE DESIGN'S FAVOUR**

The main design carried this as an open verify-item; the API doc's fallback (a cycle guard in
resolve-forward) is **unnecessary for writes**: `internal.prevent_edge_cycle()`
(`001_core_graph.sql:813-846`, trigger at `:846-847`) enforces the registry `acyclic` flag on insert
*and* update — self-edge refused, cycles found by recursive CTE, errcode 23514 → 409 → exit 6.
**Caveat (P3, info):** the CTE bounds recursion at `depth < 256` (`:836`). A cycle whose connecting
path exceeds 256 hops evades the write guard. Supersession chains that long are pathological, but the
Phase-3 resolve-forward walk should carry its own depth bound anyway — cheap, and it converts a
pathological-data hang into a loud annotation.

### Q5. `entity query` fit for worktree listing — **PARTIAL; the doc's assumption half-holds (F7)**

`CollectionQuery` (`contract.ts:215-239`) filters `kinds` — `tm8 entity query --kind worktree` lists
worktrees. But there is **no content-field filter**: `filters` covers task work-status, axes,
assignees, edges, and preset expansions only. "List *active* worktrees" is not expressible
server-side; merge tooling filters client-side or walks pages. Also worth stating plainly: `tm8 entity
query` itself is **[PROPOSED]** grammar (`GRAMMAR:317`), mapping `collections.query`
(`catalog.ts:89`) — the operation is shipped, the CLI command is not. "Listing stays on the floor" is
true for kind-level listing and no further.

### Q6. `memory status` vs the scripting law — **judgment: defensible, name the envelope**

`GRAMMAR:912`: "`--format json` emits the exact contract DTO, not a CLI-private shape." A composed
multi-read has no single contract DTO. Emitting "the underlying pages verbatim" honours the
no-CLI-private-shape half but leaves the composite's envelope undefined — which is itself a
CLI-private shape by omission. Two clean resolutions, either fine: (a) `--format json` emits one JSON
object whose members are the verbatim page DTOs under declared keys (`badge`, `marks`), documented in
help; (b) `--format jsonl` streams the underlying DTOs and `--format json` is refused with a hint to
the primitive commands. No grammar amendment needed for either. What is *not* fine is leaving it to
the implementer, which is where the current text stops.

---

## 2. The directive's load-bearing claims, checked one by one

| Claim | Verdict | Evidence |
|---|---|---|
| `entities.create` connections atomic, authored src=new-entity-outward | **CONFIRMED** | §1 Q1 above; `entities-commands-tracking.ts:783-827`, `007:899-901` |
| `edges.create` accepts free type strings; registry trigger validates | **CONFIRMED**, one nuance | `schemas.ts:877-883` (`type: z.string().min(1)`); `001:778-805` — but an unregistered type NOT namespaced `x:*` is **refused** (`:801-803`), so the capability exists only once the six registry rows land; the design does land them, and correctly claims zero schema change |
| `acyclic` enforced anywhere? | **YES — enforced** | `001:813-846`; see §1 Q4 |
| `PullState.contentStale` at `entity-read.ts:683`; `loadRelations` absorbs new types without a second query | **CONFIRMED with limits** | Formula at `entity-read.ts:683` (actual: `pinnedVersion > 0 && pinnedVersion < row.version` — the design drops the `>0` guard, trivial). Absorption: see P1 below — one-hop marks yes; `basisMoved` needs a target-version join; `superseded.headId` needs recursion |
| 015's core-kind shape (015:29-31, 69, 88, 1651) as precedent | **CONFIRMED as cited, misleading as relied on** | All four line citations exact (kind seeds :28-31, `project_projection_details` :69, `interaction_profiles` :88, `entity_content` :1651). But the precedent **does not include version-snapshot wiring** — see F1 |
| Frozen exit table `exit.ts:25-47`; no new exit codes needed | **CONFIRMED** | Table verbatim at `exit.ts:25-47`; guard refusals → `invariant_violation` → 6 (`cli/errors.ts:52-66`); staleness reads exit 0 by design |
| Error mappings through the facade | Verified | §1 Q3 |
| Handoff §23.15 door-binding rule carried, nothing weakens it | **CONFIRMED for create; GAP for patch** | §23.15 (`TM8-W0-W5-HANDOFF-STATE.md:2688-2760`) measured eleven doors on the `entities.create` label; migration 036 shipped all eleven bound plus two repairs (`036:49-70`). Main design §3.1+§6 and API §1.3 all require the 036 pattern on `create_memory`/`create_worktree` from day one — carried, not weakened. But **the same handoff records `entities.patch`'s eleven doors as UNBOUND**, and the designs add doors to that label without a word — F2 |
| Frozen catalog is 101 rows | **CONFIRMED** | `grep -c "{ name: '" catalog.ts` = 101 exactly |

---

## 3. Findings

Classification: **REFUTED** = a design claim that fell when the file was opened. **CONFIRMED** = a real
defect/gap in the design, verified against the tree. **PLAUSIBLE** = likely issue I could not fully
verify without executing. Severity in brackets.

### 3.1 REFUTED design claims

**R1 [minor].** Main design §1: "*Precedent: `015:34-46` added **seven** types this way.*" The insert
(`015:34-46`) adds **six**: `in_project`, `shared_into`, `participates_in`, `authored_from`,
`defaults_to_profile`, `selected_profile`. There is no second `edge_types` insert in 015. An
unprovenanced count, off by one, in the document whose subject is unprovenanced figures.

**R2 [minor, high irony].** Main design §0's specimen: "*`TM8-PROGRAM-CLOSE.md:28` says fourteen; the
same document at `:413` says thirteen.*" **Both citations are now dead.** PROGRAM-CLOSE has been
amended: lines 31-32 now read "*AND THIS SENTENCE USED TO CARRY A NUMBER, WHICH IS WHY IT NO LONGER
DOES. It said fourteen here and thirteen in §7*" — the numbers are scrubbed and the discrepancy is
recorded in place (a grep for `thirteen|fourteen` finds only that sentence). The design's observation
was true when made and plausibly *caused* the amendment — but as the tree stands, §0 describes a
document state that no longer exists. The design's own Class-F specimen has undergone the design's own
Class B (referent mutated under a written claim), and its `copy_of`-with-pin machinery is exactly what
would have caught it. Fix: restate §0 as "found and since amended", pinning the pre-amendment state.

**R3 [moderate — it is the citation under F1].** Main design §1 and §3.5: "*content writes advance
`entities.version` (`001:346-349`)*." Those lines are **index DDL** (`entities_space_kind_created_idx`
etc.). The actual mechanism is `internal.snapshot_entity_version()` (`001:1130-1177`) — attached
**per detail table** to exactly five kinds in 001 (`tasks`, `documents`, `spells`, `skills`,
`collections`, `001:1179-1188`) plus `team_members` in 002 (`002:138`). "Content writes advance
version" is a per-table opt-in, not an envelope property. The scope of a true statement outran its
mechanism — the design's own R2 class, live in the design.

### 3.2 CONFIRMED findings

**F1 [major]. The worktree/memory version-bump wiring is missing from the Phase-1 inventory, and the
cited precedent is a precedent for its absence.** The entire §3.5 mechanic — "*when the worktree
merges, every memory pinned to it drifts on the shipped formula … with zero worktree-specific
machinery*" — requires `public.worktrees` updates to bump `entities.version`. That happens only via a
`snapshot_entity_version` trigger on the detail table (R3 above). **015 — the "exact shape" Phase 1
follows — wired no such trigger on either of its new detail tables**; `interaction_profiles` uses its
own bespoke guard instead (`015:431`, `:459`). The Phase-1 migration inventory (main §1 closing
paragraph and §6 Phase 1) enumerates detail tables, kind seeds, `entity_content()`, registry inserts,
`append_only`, and the props trigger — **no snapshot triggers**. Same for `public.memories`, which
§3.1 needs for "*memories version, snapshot*" and §3.3 needs for edit-un-pins-verification. Without
the two triggers: a merge transition writes the detail row, version stays put, **no pin drifts, no
badge fires, no sweep row appears — silence, in the reassuring direction**, which is the failure class
this whole design exists to close. Fix is two `create trigger` statements plus the design's own
§23.1-style gate: red = transition without bump observed, green = transition bumps and a pinned
memory's `basisMoved` appears on the next read.

**F2 [major]. The worktree lifecycle transition has no door, and its label is the unbound one.**
`entities.patch` routes per-kind (`entities-commands-tracking.ts:961-1022`); a core kind with no case
hits `throw CollabError('not_implemented', …)` (`:1017-1018`). The API doc's §1.1 row "Worktree
lifecycle transition → `entities.patch`" is therefore **unreachable** without an `update_worktree`
RPC + facade case (and `update_memory` for §3.1's typo-edit path). Neither door appears in the Phase-1
inventory, which names only the two `create_*` doors. Worse: these update doors join the
**`entities.patch` ledger label, whose eleven existing doors handoff §23.15 explicitly records as
UNBOUND** ("*`entities.patch`'s eleven doors are NOT authorized — unmeasured*",
`TM8-W0-W5-HANDOFF-STATE.md:2733-2736`). The designs' day-one 036-binding rule is stated for create
doors only. Adding doors twelve and thirteen to an unbound label without a ruling either extends the
036 pattern there or must say why not — silence is how the §23.15 incident happened the first time.

**F3 [moderate]. The append-only guard as specified misses the third mutation path.** The design
(§3.3) refuses "*DELETE (and props-rewriting PATCH) on flagged types*". But `edges.create` itself is
an **upsert**: `write_edge` does `on conflict (src_id, dst_id, type) do update set props =
excluded.props …` (`018_w2_edges_placements.sql:195-202`) — a second `edges.create` naming an existing
mark **rewrites its props through the create operation**. A row-level `BEFORE UPDATE` trigger on
`public.edges` does cover this path (the trigger fires regardless of which RPC updates), so the
asymmetry **is enforceable as specified** — but only if implemented at trigger level, and the design's
wording invites an RPC-level guard in `delete_edge`/`update_edge` that would leave the upsert path
open. Three consequences to state in the design: (i) duplicate mark creation flips from idempotent
upsert to 409 — a wire-behaviour change per type; (ii) `write_edge` mints an undo token redeeming via
`edges.delete` (`018:210-215`) — for append-only types that token is dead on arrival and should be
suppressed or documented; (iii) `unique(src_id, dst_id, type)` (`001:773`) **plus** append-only means
a mis-authored dispute from evidence E on target T can never be corrected or reissued from E — the
recovery path is a fresh evidence entity, which the design should name as the intended recovery.

**F4 [moderate]. API §1.6 contradicts §1.4 on context-payload stability.** §1.6 closes with "*every
addition optional-or-new-variant, so existing payloads are byte-stable*", but §1.6 item 5 / §1.4 item
2 bump the `EntityContextView` discriminator, which is the **literal** `'tm8.entity-context.v1'`
(`contract.ts:1292`). Bumping it changes **every** context payload and hard-fails every v1-pinned
client — including clients that never asked for staleness annotations. That may be the right call
("fail loud"), but it is the opposite of byte-stable, and the delta list's summary sentence is how
this gets waved through schema review unnoticed. Pick one: additive optional fields under the v1 tag
(consistent with the badge's approach), or the bump with the break stated in §1.6's summary.

**F5 [moderate].** The 23502→503 mapping — written up under Q3 above.

**F6 [minor]. Phase 0's `copy_of` convention runs unguarded.** Phase 1 flips `copy_of` to
`append_only`; Phase 0 adopts pin conventions on it **before any guard exists**. During Phase 0 every
restatement pin is silently deletable (`edges.delete` is live, `018:263-300`) and rewritable (F3's
upsert). Phase 0's "cheapest useful increment: restatements acquire owners" should carry its inline
limit: owners whose marks are erasable without trace until Phase 1 lands.

**F7 [minor].** Worktree listing — written up under Q5 above.

### 3.3 PLAUSIBLE findings

**P1 [minor]. "A filter-list edit, not a new query shape" (main §1) overstates the badge's cost
shape.** The single batched relations query (`entity-read.ts:381-394`) absorbs inbound
`disputes`/`verifies`/`supersedes` and outbound `based_on`/`copy_of` as filter additions, and the
answering-verifies match (props.answers vs dispute ids, pin vs version) is computable in memory from
those rows. But `basisMoved` needs each pin **target's current version** — a join against
`public.entities` the current query does not have — and `superseded.headId` needs a **recursive**
chain walk that no one-hop query yields. Both are bounded (chain length, marks per entity) and the
design's scale answer survives: this is the same cost class as the shipped `pulls`/`blocked` badges,
paid only by entities carrying marks. But implementers sized for "edit two filter lists" will meet a
recursive CTE. Cannot be fully settled without measuring on real data — hence PLAUSIBLE, not
CONFIRMED.

**P2 [minor]. Sweep #3 is weaker than its motivating incident.** §4.3/§5.5 flag "claims whose
`mechanism` fields are **near-identical**" as replication-detection. The incident it answers —
`73+25=98`, four authors, one mechanism — is one where four *independently phrased* mechanism strings
would plausibly share no lexical similarity while sharing the counting mechanism. String-similarity
sweeps catch copy-paste replication; they under-catch independently-worded replication, which is what
actually happened. The honest statement: sweep #3 catches the cheap half of the tautology class, and
the scope-widening agent seat carries the rest. (The design's Class-C section is otherwise honest —
see §4d below.)

**P3 [info].** `prevent_edge_cycle` depth cap — under Q4 above.

---

## 4. The four design-judgment questions from the review directive

**(a) Does derived-not-stored staleness survive scale?** Yes, with P1's caveats. The derivation is
per-page, edge-count-bounded, and rides an already-shipped query shape whose existing consumers
(`pulls`, `blocked`) have the same profile. The genuinely new costs — target-version join, recursive
head resolution — are paid only for marked entities, and marks are (by the noise-discipline design)
rare. The design's refusal to store the state is also what keeps the replay/read-path constraint
satisfiable: nothing derived enters a command result (checked — `ledger_replay` returns stored jsonb
verbatim, `004:104-123`, and the design's rule at §5.2 correctly quarantines staleness to read
handlers). The un-assessable residual is hot entities accumulating hundreds of marks over months; the
design's own open question §7.5 (volume telemetry) covers it, and no better answer exists pre-Phase-4.

**(b) Is the suspect-cheap/verify-expensive asymmetry enforceable as specified?** Yes at the data
layer, **if and only if** the guard is a row-level trigger (F3) — DELETE, PATCH, and the upsert path
all converge on row triggers, and `edge_types.append_only` + one trigger covers all three. The Phase
timing has **no** hole for the five new mark types: registry rows and guard land in the same migration
(038), and `validate_edge` refuses unregistered non-`x:` types today (`001:801-803`), so no
`disputes` edge can predate its guard. The two real, bounded holes: Phase 0's `copy_of` window (F6),
and the design's own admitted residue — `secondReader` names a reader, session-separation is
trigger-checkable via `authored_from`, and an incurious-but-distinct session remains possible (design
§7.2, honestly carried).

**(c) Does the CLI sugar hide non-atomicity anywhere the doc does not admit?** **No.** I looked for
composition seams beyond the declared ones and found none: `memory add` is genuinely one
`entities.create` (Q1); `--remember`'s second call, its failure mode, and its no-rollback are stated
(§2.2); `dispute --note`'s two-step and orphan shape are stated; `verify` is one edge; the pinning
rule's read-then-write race is stated *with its degradation direction* ("toward a false flag, never
toward false confidence" — verified correct: a behind-pin surfaces as `basisMoved`); the worktree
verbs are single patches. The doc's rule "a command that composes two operations must say so in its
failure modes" is applied consistently in its own text. The one addition worth making: `memory add
--about` performs an `entities.get` per target *before* the create (to resolve the pin) — a read, not
a mutation, but it widens the race window the pinning rule describes and belongs in the same help
text.

**(d) Is the Class-C treatment honest?** **Yes — it is the strongest section of the main design.** It
opens with "not detectable by any staleness mechanism, in this design or any other", correctly refuses
to make a flag fire on true facts, and its boundary paragraph concedes the disk-deletion incident
would likely have survived all four mitigations. Nothing quietly claims detection: the four mechanisms
are write-refusal (real — NOT NULL), adjacency (real — the state variant rides every summary read,
`contract.ts:86-110` pattern verified), queryability (overstated only in P2's lexical-similarity
sense), and a one-edge path for the eventual human noticer (real). The single sentence I would tighten
is §4.3's "this is the one place Class C acquires something that fires without a reader" — per P2 it
fires on *part* of the corroboration structure. The section's closing register — "a reduction, not a
solution" — is exactly the honesty the brief demanded.

---

## 5. The filter: what was checked and cleared

Per the program's close (§7 item 5): findings without a denominator are unweighable. Everything below
was opened and matched; none of it generated a finding. Citations listed as design-doc claim →
verified location.

**Migrations.** Entity envelope + version/activity/deleted (`001:328-345` ✓); edges table, open props,
`created_by`, `unique(src,dst,type)` (`001:762-773` ✓); `validate_edge` registry trigger + `x:*` rule
(`001:778-805` ✓); `copy_of` shipped and unused for restatements (`001:910-914` ✓); reaction-counter
and activity-touch triggers confirm edges never bump `version` (`001:849-870` ✓ — supports the design's
marks-don't-un-pin premise); `edge_types.props_schema` nullable/unenforced (`001:755-758` ✓);
`entity_versions` with `changed_by/changed_at` (`001:1063-1073` ✓); `entity_content()` as the
sanctioned extension point (`001:1074-1078` ✓); R29 single-writer guard on `work_session.status`
(`001:727-744` ✓ — the design's §7.3 question cites it accurately); `work_sessions` workdir columns
(`001:700-702` ✓) widened to `scratch` in 015 (`015:303-305` ✓); `transcript_doc_id` (`001:711` ✓);
015 kind seeds (`:28-31` ✓), detail tables (`:69`, `:88` — **exact**), `entity_content` replacement
(`:1650` ✓), `authored_from` src=`['message']` with unique-src index (`015:1640` — the design's
widening to `['message','memory']` is compatible: one authoring session per memory); ledger envelope
(`004:79-92` ✓), byte-identical replay (`004:104-123` ✓), 24h prune (`004:152-158` ✓ — the design's
disqualification of the ledger as provenance is correct); custom-kind required-field enforcement
(`005:82-85` ✓, errcode 22023); `team_members.memories` blob (`002:119` — exact) and its projection
(`contract.ts:150` ✓ — leave-it-functioning is the right call); 036 rebinding all eleven create doors
plus the two claimed-bound repairs (`036:1-100` ✓).

**Contract package.** Catalog rows 53/54/55/61/76/77/78/79/89/140/155 all name-and-line exact ✓;
catalog = 101 rows exactly ✓; `InitialConnectionInputSchema` (`schemas.ts:808-812` ✓);
`entities.create` kind exclusion list (`schemas.ts:852-855` ✓ — `memory`/`worktree` absent from it is
achievable as claimed, noting the facade switch also needs cases, which the design's new-door plan
implies); `expectedVersion` required on patch (`schemas.ts:865-866` ✓); `CreateEdgeInputSchema` free
type string (`schemas.ts:877-883` ✓); `CoreEntityState` variants incl. `pull_request.stale`
(`contract.ts:86-110` ✓); `EntityBadges` optional-field shape (`contract.ts:117-122` ✓ — the
`staleness` addition is additive as claimed); `doc` content body/title split (`contract.ts:147` ✓);
`work_session` launch-record vs association split (`contract.ts:154-157` ✓ — the design's worktree
division copies a real idiom); `EntityContextView.schemaVersion` (`contract.ts:1292` ✓, but see F4);
`ERROR_STATUS` (`contract.ts:515-521` ✓).

**Server.** Live handler ownership traced `main.ts:31` → `registerFacadeHandlers` →
`registerW2EntitiesCommandsTrackingHandlers` first with duplicate-throw (`facade/index.ts:110-121` ✓ —
the older `handlers/entities.ts` `entitiesCreate`, which *drops* `connections` and supports four
kinds, is not the mounted path); `attachInitialConnections` dedup + same-tx (`:796-818` ✓);
`entities.connections` is a shipped flat `Page<EdgeView>` with `type`/`direction`/peer filters
(`services/w2/entities-commands-tracking.ts:440-500`, `:1139` ✓ — the API doc's "memories about X in
one paged read" holds; the grammar's amendment-dependent warning is stale in the good direction);
`edges.list` filters (`services/w2/edges-placements.ts:90-103` ✓); `loadRelations` single batched
query (`entity-read.ts:369-394` ✓); `depends_on` hard-default (`entity-read.ts:410-417` comment ✓,
corroborating `007:2350`); `contentStale` (`entity-read.ts:683` ✓); `edge.upsert`/`edge.deleted`
events (`events/mapper.ts:131-132` ✓, with the endpoint+author referencing the design relies on);
`entities.context` sections/byte budgets (`services/w2/feed-context.ts:670-680` ✓); wire-error single
serializer (`http/errors.ts:78-124` ✓).

**CLI + grammar + handoff.** Exit table (`exit.ts:25-47` verbatim ✓); code→exit map
(`cli/errors.ts:52-66` ✓); `worker-init` module exists (`packages/cli/src/commands/worker-init.ts` ✓);
grammar model line (`GRAMMAR:32` ✓), `--connect` form (`:231` ✓), initial-connection law + amendment
caveat (`:301-310` ✓), one-cursor rule (`:311-315` ✓), `entity query` block (`:317-340` ✓), output law
(`:904-918` ✓); handoff §21.4 (guard spellings, `:2006` ✓), §23.1 (negative controls, `:2291` ✓),
§23.12 (XG03, `:2560` ✓), §23.13 (two-audience item, `:2629` ✓), §23.15 (eleven doors, quoted at
length, `:2688-2760` ✓), §23.17 (caveat-in-the-diagnostic, `:2824+` ✓ — the API doc's citation of the
pattern is accurate).

**Design-internal consistency spot-checks that cleared:** the six mark types' `src_kinds` name only
existing core kinds ✓; `based_on`-not-`depends_on` rationale matches the real `blocked` semantics ✓;
no derived value enters a command result anywhere in either doc ✓; badge values are
viewer-independent by construction ✓; the sweeps use no catalog surface ✓; "no new exit codes" ✓;
zero catalog rows added by any phase ✓ (both docs' accounting tables map every action onto rows
53-155 of the shipped catalog, all verified live).

**Limits of this review, stated per the same rule it enforces:** produced by mechanism *"read the
working tree at one commit on 2026-07-27"*; establishes what the source says, does not establish what
a running node does — no migration was applied, no test executed, no HTTP status observed. Line
numbers are exact where stated "exact" and ±3 elsewhere (sed windows). The handoff and program-close
were read at the sections cited, not end-to-end. I did not verify the user-supplied talk-transcript
claims in main §3.3/§5.5 (marked "unverified but convergent" there — honestly labelled, left as-is).

---

## 6. Disposition summary for the authors

Ship-blocking for Phase 1 as currently inventoried: **F1** (snapshot triggers), **F2** (update doors +
patch-label binding ruling). Must-fix in text before implementation: **F3** (guard = row trigger;
upsert/undo/uniqueness consequences), **F4** (pick a context-versioning story), **F5** (harden the
§1.3 row-1 wording into the gate). Textual corrections: **R1, R2, R3, F6, F7**. Judgment items P1/P2
need a sentence each, no redesign. Nothing found contradicts the core architecture — first-class
kinds, derived state, append-only marks, the asymmetry, zero catalog rows — and the review actively
*resolved* two of the design's own open verify-items in its favour (acyclic enforcement, connections
atomicity). The design is sound; its Phase-1 bill of materials is short two triggers, two doors, and
one ruling.
