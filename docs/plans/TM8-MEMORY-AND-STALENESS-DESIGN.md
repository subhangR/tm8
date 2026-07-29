# tm8 W6 Design — Entity Memory, Staleness, and Keeping the Graph Correct

**Status: DESIGN. Nothing here is implemented, no migration exists, no contract text changes.**
Produced against the requirements brief `TM8-MEMORY-STALENESS-DESIGN-BRIEF.md` and the evidence in
`TM8-PROGRAM-CLOSE.md` and `TM8-W0-W5-HANDOFF-STATE.md` §§15, 21–24.

**The one-paragraph version.** Staleness is not a column and memory is not a blob. **`memory` and
`worktree` are first-class core entity kinds** (user ruling, 2026-07-27, superseding this
document's first draft which proposed a custom kind): a memory is an entity carrying its own scope
as NOT NULL columns, a worktree is an entity whose lifecycle transitions are ordinary versioned
writes, and both are bound to what they concern by **append-only edges**. Staleness is **derived
at read time from those edges** — the same mechanism the tree already ships for
`PullState.contentStale` (`packages/server/src/facade/entity-read.ts:683`). Marking a fact suspect
is one cheap edge with evidence attached; marking it current again is expensive, version-bound,
and requires a second reader — because every misattribution in the evidence ran in the reassuring
direction. The design adds **zero catalog rows**: every write goes through `edges.create`,
`entities.create`, and `entities.patch`, all shipped v1 operations. It does cost one DDL migration
and contract-**schema** additions (two kind-enum values plus their state/content variants — the
sanctioned fields-and-projections lane, stated in §6, not smuggled).

---

## 0. Method, and the limits of this document

The brief's closing rule applies to this document: the artifacts transfer and the skepticism does
not. So, the filter that produced this design, stated up front:

**What I verified against the tree** (each claim below carries its `file:line`): the entity
envelope and `entity_versions`, the edge table, registry, and validation trigger, the shipped edge
types in `001` and `015`, the custom-kind machinery in `005` including required-field enforcement,
the command ledger's TTL, the `entities.patch` / `edges.create` input schemas, the catalog rows for
entities/edges/entityKinds, the read-path badge derivation in `entity-read.ts`, and the
`edge.upsert` event mapping. **What I took on trust from the brief**: the incident catalogue itself.
I re-read the underlying §§15, 21–24 of the handoff state rather than only the brief's summary, but
I did not re-derive any incident from primary evidence documents, and **I ran nothing** — no server
was booted, no chain applied, no test executed. Every claim here about runtime behaviour is a
*read* of source, not a measurement.

**One verification the directive asked for produced a specimen worth keeping — and the specimen
then demonstrated itself a second time.** When this document was first written,
`TM8-PROGRAM-CLOSE.md:28` said **fourteen** coordinator figures fell while the same document at
`:413` said **thirteen** challenges — same entry-point document, neither number carrying what it
was counted from, **unresolvable by construction**: Class F (a restatement with no owner) live
inside the document that defines Class F. Within hours, that document was amended: both numbers
were scrubbed and the discrepancy recorded in their place (`TM8-PROGRAM-CLOSE.md:31-32`,
*"this sentence used to carry a number, which is why it no longer does"*) — **which made this
paragraph's original citation stale in the reassuring direction** (a reader following `:28`
would have found no "fourteen" and might have concluded the specimen was invented). Caught by
this design's own reviewer (R2, `reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md`). A staleness
design whose founding specimen went stale before the design shipped is the cheapest possible
demonstration of why provenance must be structural rather than stylistic — a `copy_of` edge with
a pinned version would have flagged the drift mechanically; a prose citation needed a second
reader to catch it.

---

## 1. What already exists — the substrate, measured

This section is load-bearing: the brief's hard constraint is a frozen 101-row catalog, so the
design must be assembled from what is already shipped. More is shipped than the brief recorded.

| Primitive | Where | What it gives this design |
|---|---|---|
| Entity envelope: `version`, `activity_at`, `deleted_at` | `db/migrations/001_core_graph.sql:329-345` | A monotonic content version on **every** entity — the pin target for every drift derivation |
| `entity_versions` snapshots with `changed_by`, `changed_at` | `001:1064-1072` | Full per-change provenance already recorded, durable |
| Edges: open `props` jsonb, `created_by`, `unique(src,dst,type)` | `001:762-773` | Marks carry author + evidence structurally; one mark per (evidence, target, type) |
| Edge **registry** validates types via trigger | `001:778-800` | **A new edge type is a one-row data insert. Zero catalog rows, zero contract edits.** Precedent: `015:34-46` added seven types this way |
| `edges.create` takes `type: z.string().min(1)` + open props | `packages/contract/src/schemas.ts:878-884` | The wire schema does not enumerate edge types — new types need **no** schema change |
| **Core kinds added mid-stream — the worked precedent** | `015` seeded `project` + `interaction_profile` (`015:29-31`), created their detail tables (`015:69`, `015:88`), and re-replaced `internal.entity_content()` (`015:1651`) | **The exact migration shape `memory` and `worktree` follow.** Adding a core kind is an established, once-executed pattern in this tree, not new ground |
| Custom kinds: runtime registration, required-field enforcement | `entityKinds.create` (`catalog.ts:140`); `005_custom_kinds.sql:82-85` | Evaluated for the memory kind in this document's first draft and **declined by user ruling — memory is first-class.** Stays what it is: the lane for user-defined kinds |
| Kind-specific fields project into `state` on every summary read | `CoreEntityState` variants (`contract.ts:86-110`) | **Scope travels with the value on every read** — a typed `memory` state variant rides the shipped projection path |
| Derived staleness already on the read path | `PullState.contentStale` = `pinnedVersion < row.version` (`entity-read.ts:683`); `badges.blocked` from `depends_on` (`entity-read.ts:410-427`); `pull_request` state carries `stale: boolean` (`contract.ts:98`) | The exact derivation pattern this design generalises — shipped, tested, and cheap |
| One batched edge query feeds all badges | `entity-read.ts:388-394` | Adding staleness edge types to badge assembly is a filter-list edit, not a new query shape |
| Edge writes emit events | `edge.upsert` / `edge.deleted` (`packages/server/src/events/mapper.ts:131-132`) | Marks push to subscribers with no new event machinery |
| `copy_of` edge type — shipped, **unused** | `001:914` | The restatement edge the brief's Class F asks for |
| Provenance edges as a pattern | `authored_from` (message → work_session, "Immutable Server-recorded provenance", `015:41-42`); `shared_into` (`015:37`) | Authorship-provenance is an established edge idiom |
| Worktree coordinates already modeled | `work_sessions.workdir_mode in ('project','worktree','scratch')`, `workdir_path`, `base_ref` (`001:700-702`, widened `015:305`); `in_project` edges (`015:35`) | The launch-record half exists; §3.5 promotes the worktree itself to a first-class node these columns and edges point at |
| `team_members.memories` jsonb array | `002_identity.sql:119` | Memory **in embryo, as a blob** — the anti-pattern this design replaces (§3.6) |
| Command ledger | `004_ledgers.sql:79-92`, pruned at 24h (`004:152-156`) | **Disqualified as provenance** — it is an idempotency envelope with a TTL, not a durable record. The brief's sketch listed it as a candidate primitive; it is not one |
| Ledger results replay **byte-identical** | `internal.ledger_replay` returns the stored result verbatim (`004:104-123`) | The constraint the brief warns about: **nothing derived may live in a command result.** All staleness derivation in this design is read-path only (§5, checked explicitly) |

Two conclusions fall out. First, **this design is assembly, not invention** — the graph was built
with the right joints and then not used for this purpose, which is the user's framing stated as an
inventory. Second, the migration budget is **one migration in the `015` shape**: two small detail
tables, two kind seed rows, one `entity_content()` replacement, the edge-registry inserts, and no
DDL on hot tables beyond one column on the `edge_types` registry. Catalog rows: zero.

---

## 2. Taxonomy — the brief's six classes, re-cut for design

The brief's A–F classification is sound as an *incident* taxonomy, and I keep it as the reference
frame. But it classifies by how each failure **looked**, and a design needs the incidents grouped
by **what record, had it existed in the graph, would have changed the outcome**. Re-cut on that
axis, six classes become four, and two of the merges are the design's most useful moves:

### R1. REFERENT DRIFT — the world moved; the record did not (brief's A + B)

A and B are one class with two triggers. In both, the record was true at write time and its
*referent* changed: in A the referent grew a successor (chain digest header, the reverted
rotation, the all-quiet read as standing state); in B the referent was mutated in place (the
guard-landed caveat, the solved-problem risk note, the 501-stub example, the `residual >= 6`
premise, the caveat deleted by a rename).

**The missing record is the same in both: the dependency, with a version pin.** A is "my referent
has an inbound successor"; B is "my referent's version moved past my pin." Both are **mechanically
derivable at read time** — but only if the edge was recorded. Not one incident in the evidence had
recorded its dependency. This is the class the `contentStale` pattern already solves for pulls,
and §3.3 generalises it.

### R2. SCOPE EXCESS — the record was never wrong; the sentence around it was wider than the mechanism (brief's C + E)

The brief marks C as the largest and hardest category, and it is right. I merge E into it
deliberately: an instrument "satisfiable by something other than what it checks for" (the no-body
probe, the always-red lint, the sequential fixture, the unscoped `pg_locks` barrier, the stale
binary) is the same defect as `residual = 0` read as "implemented" — **a true output whose scope
outran its mechanism** — differing only in whether a human or a harness did the over-reading. The
program's own countermeasure names the merge: *"state what a check can be satisfied by, not what
it asserts"* is exactly *"state what a measurement establishes, not what it suggests."*

**The missing record: the mechanism and the scope, stored WITH the value, inseparable from it on
the read path.** Nothing decayed in any R2 incident, so no drift derivation can ever fire — the
brief is correct about that and §4 addresses what remains honestly.

### R3. NON-DISTRIBUTION — correct, current, well-scoped knowledge that did not reach the work (brief's D)

The replay guard invented four times, the idiom applied at 3 of 11 sites, the comment whose trap
was hit twelve files away. The knowledge had no defect; it had no **route**. The program's own
adopted answer is that this class belongs to **detectors, not documents** — *"when you learn
something, don't write it down — wire it to something that fails"* — and a graph is a document
with better joints. **This design does not claim to solve R3.** What the graph can honestly
contribute: hold the *coverage ledger* (a claim naming the sites a rule governs and which of them
have the detector wired — the "3 of 11" shape made queryable), and give the rule a single durable
address that detectors and packets cite instead of restating. The firing thing stays in CI. §7
carries this as an open question rather than a feature, because overselling R3 coverage would
itself be a Class C error.

### R4. PROVENANCE LOSS — copies with no back-link (brief's F)

"A restatement has no owner — nothing in the copy records what it was copied from." The chain
digest in a header, the narrowed obligation restated into every packet, the 13-vs-14 specimen in
§0. The missing record is exactly the shipped-and-unused `copy_of` edge (`001:914`) plus a version
pin, and the strongest empirical countermeasure the program found — restatements carrying a
`file:line` survived challenge; bare ones fell — is this class's cheap approximation. The full
treatment: **a claim lives once, as an entity; documents and packets reference it; a reference
cannot diverge** (handoff §23.13, adopted there as a coordination rule, here as a data model).

### Mapping the brief's incidents onto the re-cut

| Incident (brief §3) | Class | The record that was missing |
|---|---|---|
| Chain digest in a doc header | R1 + R4 | `copy_of` → chain-state claim, pinned |
| Rotation broadcast after revert | R1 | announcement referencing a claim, not supplying a value; claim superseded by the revert's successor claim |
| All-quiet treated as standing | R1 | claim scoped to an instant (`measured_at`), read surfacing its pin age |
| Guard-landed caveat (24.2) | R1 | `based_on` → the wiring entity, pin drifted when the guard landed |
| Solved-problem risk note masking a live defect | R1 (+ §5 hazard note) | supersession when the fix landed; note the *masking* cost is a read-path problem, §5 |
| 501-stub example inherited from an older packet | R1 + R4 | `copy_of` with pin; drift visible at read |
| Caveat stored in a test name, deleted by rename | R1 + R3 | the caveat as a claim; the test cites the claim, not vice versa |
| `residual >= 6` premise expiry | R1 | `based_on` → residual-set claim; pin drift fires when residual moves |
| `residual = 0` read as "implemented" | **R2** | `does_not_establish` field, required at write, projected on read |
| `73 + 25 = 98` four-author tautology | **R2** | `mechanism` field on all four claims — identical values make the §15.5 question *queryable* (§5.5) |
| True disk figure framed reclaimable | **R2** | `subject_scope` ("occupied, attribution unmeasured") |
| Wake defect prose over-generalised | **R2** | claim scope vs basis scope comparable across `based_on` |
| "74 bits" CLI property stated as system | **R2** | `subject_scope` naming the surface measured |
| All §3.5 instrument incidents | **R2** | `mechanism` + "satisfiable by" recorded with every instrument claim |
| Replay guard ×4, idiom 3-of-11, comment 12 files away, two-audience contradiction | **R3** | coverage-ledger claims at best; detectors otherwise (honest boundary) |
| Prose restatements (all of §3.6) | **R4** | `copy_of` + pin; single-source claims |

---

## 3. The primitive set

The brief's §8.2 demands explicit answers to three questions. They come first, then the mechanics.

> **Is staleness a property of an entity or of a claim about an entity?** Of the **entity**, for
> the state itself — any entity can rot (a doc, a task's description, a skill) and the read path
> must be able to say so about all of them. But staleness **state is never stored**: it is derived
> at read time from append-only edges (§3.2), and the *rich* machinery — scope fields, basis pins,
> verification — lives only on **claims** (§3.1), because claims are the things the evidence shows
> actually rotting. One derivation, every kind; one kind carries the full instrument.
>
> **Is memory a kind, a projection, or an edge?** All three, with distinct roles, and collapsing
> them is how the last system failed: the **kind** (`memory`, a first-class core kind — §3.1) is
> the unit and carries scope as NOT NULL columns; **edges** bind it to subjects, evidence,
> authors, and predecessors; **projections** are where any of it fires. A memory that is only a
> kind is a filing cabinet; only an edge, a pointer; only a projection, a lie the first time the
> underlying data moves.
>
> **Is worktree part of this problem?** **Yes, as a first-class node** (user ruling), and the
> ruling earns its keep on the mechanics: a `worktree` entity's lifecycle transitions are
> versioned content writes, so **merge/abandon fires the ordinary pin-drift derivation on every
> memory pinned to it** — no special machinery (§3.5). What still does *not* exist is a separate
> worktree-scoped memory store: memories attach to the worktree entity the way they attach to any
> subject, by edge. Half of Class E is "measured against a tree state nobody recorded"; the
> worktree entity is that coordinate made addressable.

### 3.1 The memory: a first-class core kind

A memory unit is an entity of core kind **`memory`** — global, migration-seeded, with its own
detail table, exactly the shape `015` used to add `project` and `interaction_profile`
(`015:29-31`, `015:69`, `015:88`, `015:1651`). *(Vocabulary: this document says "claim" when it
means a memory in its epistemic role — the thing that can be true, scoped, disputed. The kind is
`memory`; a claim is what an instance of it is.)* Detail table `public.memories`:

| Column | Constraint | Why it exists |
|---|---|---|
| `statement` | text **NOT NULL** | What is claimed — one sentence, the value |
| `mechanism` | text **NOT NULL** | What produced it: the command, instrument, or read. The §15.5 question ("could these have disagreed?") becomes answerable — and indexable — from stored data |
| `subject_scope` | text **NOT NULL** | The conditions under which it was measured — the program's scope-discipline rule (*"a measurement without its conditions is a rumour with a number attached"*) compiled into schema |
| `does_not_establish` | text **NOT NULL** | The false neighbour, pre-written by the author at the moment they know the mechanism best. The only column aimed squarely at Class C |
| `measured_at` | timestamptz null | For instant-scoped facts (the all-quiet class) |

**The NOT NULLs are enforcement, not convention** — a table constraint, the strongest refusal the
system has. This is the design's first detector in the program's own sense: the write **fails**
if scope is absent, whether or not anyone read a rule.

**Why first-class rather than custom** (the first draft proposed `c:claim`; the user ruled
first-class, and the ruling buys real things): NOT NULL columns instead of trigger-validated
jsonb; a **typed** `CoreEntityState` variant (`{ kind: 'memory'; mechanism; subjectScope;
doesNotEstablish; measuredAt }` following `contract.ts:86-110`) so scope rides typed inside
`state` on every summary read for every client; server code and the badge assembly **may**
hard-depend on the kind; one global definition instead of per-space registrations that can drift;
and indexes on `mechanism` for the §5.5 sweeps. What it costs, stated rather than smuggled: the
DDL migration (§6 Phase 1) and contract-schema additions — `memory` in the core-kind enum, the
state/content variants, and **not** in `entities.create`'s exclusion list (`schemas.ts:853`), so
creation stays on the shipped operation. **Security consequence carried in from the evidence,
widened by review:** a new creatable core kind is a new `create_*` door on the `entities.create`
ledger label — and a new *patchable* one is a new `update_*` door on `entities.patch`, because
the patch service routes per-kind and throws `not_implemented` for any unrouted core kind
(`services/w2/entities-commands-tracking.ts:1018`). So Phase 1 ships **four** doors, not two:
`create_memory`, `create_worktree`, `update_memory` (typo-edits, §3.1's edit policy),
`update_worktree` (the lifecycle transition — without this door the §3.5 mechanic has no route).
Handoff §23.15's measured finding is that every such door needs the `036`-pattern resource
binding **from day one** — shipping any of the four unbound recreates XG03 at a new site. The
two update doors join the `entities.patch` label whose **eleven existing doors are recorded
UNMEASURED, NOT SAFE** (§23.15); our four ship bound, and the eleven stay handoff scope — the
§23.12 boundary ("we fix what we add, not what we merely failed to claim") is not extended by
this design.

**Memories are ordinary entities.** They version (`entities.version`), snapshot
(`entity_versions`), soft-delete, and edge like everything else — which means the staleness
machinery below applies **to memories themselves** with no special casing. A materially wrong
claim is *superseded*, not edited; edits are for typos, and any edit bumps `version`, which
visibly un-pins every inbound verification and citation (§3.3) — the machinery treats an edited
claim as changed, because it is.

### 3.2 Staleness state: derived, never stored

There is no `staleness` column anywhere in this design. The state of an entity is computed at
read time from its inbound/outbound mark edges, exactly as `contentStale` is computed from
`pinnedVersion` vs `row.version` today (`entity-read.ts:683`):

```
superseded   iff  ∃ inbound supersedes edge                      (follow chain to head)
suspect      iff  ∃ inbound disputes edge with no answering verifies edge
                  (answering = later-created AND props.answers includes the dispute's edge id
                              AND pinned to the entity's CURRENT version)
basis-moved  iff  ∃ outbound based_on/copy_of edge whose props.pinnedVersion < target.version,
                  or whose target is itself superseded/suspect        (ONE hop — see limit below)
current      otherwise — and "current" after a dispute is only reachable through verifies
```

Precedence when several hold: `superseded` > `suspect` > `basis-moved`. All three surface
simultaneously in the badge (§5.2) — precedence orders display, it does not hide.

**Why derived rather than stored.** (1) A stored status is a *copy* of what the edges say, and
this program's Class F is precisely what copies do. (2) The edges carry who/why/evidence
structurally (`created_by`, `props`, and the evidence entity at `src`); a column carries a word.
(3) Append-only edges preserve the full dispute/verification history — the program's *"archive a
red before the fix that destroys it lands"*, enforced by data model. (4) The marking write is a
shipped catalog operation (`edges.create`), so **agents already have the capability today** —
which is the user's stated floor ("at least so that agents have that capability").

*Limit, inline: the `basis-moved` derivation is one hop deep at read time. Transitive rot
(A based_on B based_on C, C disputed) does not surface on A's summary — deep closure at read is
unbounded work on a hot path. The sweep (§5.5) walks the closure offline. Whether one hop misses
real chains in practice is open question §7.6.*

### 3.3 The mark edges: six registry rows in the Phase-1 migration

Six rows into `public.edge_types`, following `015:34-46`'s precedent exactly. No catalog rows —
`edges.create` already accepts any registered type (`schemas.ts:882`).

| Type | src → dst | Props (convention, validated by trigger in Phase 1) | Purpose |
|---|---|---|---|
| `supersedes` | `*` → `*`, acyclic | `{reason}` | Successor marks predecessor. Class A becomes automatic **at the successor's write**: the writer draws one edge, every future reader inherits the redirect. Reads resolve to chain head (§5.3) |
| `disputes` | evidence kinds → `*` | `{quote, expected, observed, citation, pinnedVersion}` | **The cheap suspect mark.** `src` MUST be an evidence-bearing entity — `message`, `doc`, `file`, `commit`, `pull_request`, `memory` — so a dispute without evidence is structurally impossible, not procedurally discouraged. Specificity is required (quote/expected/observed), because the evidence shows *vague* standing flags (the risk note) become masks (§5 hazard note) |
| `verifies` | evidence kinds → `*` | `{mechanism, secondReader, answers: [edgeIds], pinnedVersion}` | **The expensive clear.** Must cite fresh evidence (its `src`), name a mechanism, name a second reader **different from `created_by`** (trigger-checkable), enumerate which disputes it answers, and pin the version it verified. An edit to the target after verification un-pins it — re-verification does not survive content changes |
| `based_on` | `memory` → `*` | `{pinnedVersion, pinnedAt, treeState?}` | The epistemic input pin. Class B detection is then the shipped formula: `pinnedVersion < target.version` ⇒ basis moved. A memory pinned to a `worktree` entity drifts **mechanically** when the worktree's lifecycle write bumps its version (§3.5) |
| `remembers` | `member`, `team_member`, `work_session` → `*` | `{note?}` | The owner path: "what does this actor durably know" = `edges.list src=me type=remembers`. Replaces growth of the `memories` blob (§3.6) |
| `in_worktree` | `work_session`, `task`, `pull_request`, `commit` → `worktree` | `{}` | Graph-side association to the worktree node, the `in_project` idiom (`015:35`) applied one level down. The session's `workdir_*` columns remain the immutable launch record; the edge is the queryable association |

Plus **`copy_of`, which is already shipped** (`001:914`) and gains only a props convention:
`{pinnedVersion, source}` — a restatement records what it restates and at what version, and the
same drift formula fires on it. This is the brief's §3.6 observation, adopted verbatim.

**Why not reuse `depends_on` for `based_on`:** `depends_on` drives `badges.blocked` and
`ready_to_work` (`entity-read.ts:410-427`, `007:2350` — a dependency with no `hard` flag counts
as hard). An epistemic pin riding that type would make every claim read as a blocked task and
pollute work-readiness. Concrete pollution, not aesthetics; the type is a wrong fit, and the
brief's instruction to prefer existing types is satisfied by `copy_of` and rejected with a reason
here.

**Append-only enforcement — a ROW-LEVEL trigger, because the mutation paths are three, not
two.** `edges.delete` and `edges.patch` are the visible un-mark routes, and deleting a
`disputes` edge would be a silent, cheap un-mark — the reassuring-direction loophole the whole
asymmetry exists to close. But the review (F3) found the third path this design's first wording
missed: `internal.write_edge` is an **ON CONFLICT props upsert** (`018:195-202`) — re-creating
an existing mark edge quietly **replaces its props** through a path that is neither patch nor
delete. An operation-layer guard covers two doors of a three-door room. Phase 1 therefore adds
`edge_types.append_only boolean default false` enforced by a **BEFORE UPDATE OR DELETE row
trigger on `public.edges`** — beneath every RPC, upsert included; the six mark types plus
`copy_of` set it true. Migration-sized, zero catalog impact. Negative controls per handoff
§23.1, now three: red on deleting a `disputes` edge, **red on re-creating a `disputes` edge with
different props through `write_edge`**, green on deleting a `relates_to` edge — a detector that
fires on everything proves nothing, and one that misses a door proves less.

**The asymmetry, stated as mechanism.** Marking suspect: one evidence entity (often a message
already written) + one `edges.create`. Marking current: a *fresh* evidence entity + a `verifies`
edge that must name mechanism, a distinct second reader, the answered disputes, and the version —
five structural requirements versus one. This is the single briefer sketch I adopt unchanged,
because it is the only one that is a measured fact about the evidence rather than a taste: **every
misattribution in the program ran in the reassuring direction.** Wrongly suspecting a good fact
costs one re-measurement; wrongly clearing a bad one costs everything downstream of it.

**And the second reader should be a second *context*, not just a second name.** The graph can
enforce this structurally: the verifying evidence entity's `authored_from` session must differ
from the claim's `authored_from` session — one trigger-checkable edge comparison, and
verification is guaranteed to come from a context that did not produce the work. This is the
same separation Anthropic's async-agent practice reports as the verifier-loop principle (a
grading context sharing the build context confabulates; an independent verifier context does
not — user-supplied talk transcript, 2026-07, unverified but convergent), and it is the handoff's
own independence finding arriving from a second direction: *"independence enforced for integrity
turns out to be independence enforced for detection"* — the program's cross-wave contradiction
was only detectable because the two results came from sessions that could not see each other's
reasoning.

*Limit, inline: `verifies.props.secondReader` names a reader; no mechanism can make them have
actually read it. The session-separation check above closes the shared-context hole; a distinct
session run by an incurious reader remains possible and is open question §7.2.*

### 3.4 What marks, and what may mark

Anything that can call `edges.create` can mark — member, team member, work session; `created_by`
records which (`001:768`). Agentic invalidation is therefore not a feature to build but a
capability that exists the moment the types are registered: an agent that finds a claim
contradicted by the tree posts a message quoting the source (`file:line` — the program's
empirically-surviving citation form), then draws one `disputes` edge from that message.
**Automatic** invalidation (no agent in the loop) exists exactly where derivation is mechanical:
supersession by write, pin drift by formula, and the sweeps of §5.5. The user's ordering —
capability first, automation where derivable — is the ordering the mechanics natively produce.

### 3.5 Worktree: a first-class node, and what that buys the staleness machinery

A worktree is an entity of core kind **`worktree`**, detail table `public.worktrees`: `path`
(absolute, same shape check as `work_sessions.workdir_path`, `001:702`), `branch`, `base_ref`,
`project_id`, and `status` ∈ `{active, merged, abandoned, deleted}` with `status_changed_at` and
a forward-only transition check (`active` never recurs). The session's own `workdir_mode` ∈
`{project, worktree, scratch}` (`015:305`) and `workdir_path`/`base_ref` (`001:700-702`) remain
untouched as the **immutable launch record** — the same division `work_session` content already
draws between `launchProjectId` and `in_project` association edges (`contract.ts:154-157`).
Sessions, tasks, PRs, and commits associate to the node via `in_worktree` edges (§3.3).

**Why the node earns first-class status mechanically, not just organisationally — corrected by
review, because the first version of this paragraph was wrong in the reassuring direction.** A
detail-table write advances `entities.version` **only where the per-table
`internal.snapshot_entity_version()` trigger is wired** (`001:1130+`); the bump is not a property
of detail tables, it is a trigger each table must attach. The review (F1,
`reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md`) measured that `015` — this design's cited
precedent — wired **no** snapshot triggers for its new detail tables (`interaction_profiles`
guards its own versioning at `015:431/459`), so the precedent is exact for kind-addition and
**silent about versioning**. Therefore Phase 1 wires the snapshot trigger on **both**
`public.memories` and `public.worktrees` explicitly, with the mutation test that matters: omit
the trigger, transition a worktree to `merged`, observe `entities.version` unchanged and every
pin **not** drifting — the failure is invisible and reassuring, which is exactly why it is
tested. *With* the trigger wired, the payoff stands as designed: the merge write bumps the
version, **every memory holding a `based_on` pin to the worktree drifts on the shipped
formula** — `pinnedVersion < target.version` — and the badge (§5.2), the events, and the
pin-drift sweep (§5.5) fire with zero worktree-specific machinery. One write, and the graph does
the rest — but the write only counts because the trigger is on the bill of materials.

**Provenance wiring:** memories authored during a session carry `authored_from` → the work
session. That edge type is shipped for messages (`015:41-42`) with `src_kinds = array['message']`;
Phase 1 widens it additively to `array['message','memory']` — a registry UPDATE in the same
migration. Through session and `in_worktree` edge, a claim resolves to path + branch + base_ref +
project; claims needing a byte-precise coordinate record `based_on.props.treeState` as a digest
**with its recipe**, and the recipe is the canonical cwd-independent one, because the program
measured four different digests for byte-identical files from four directories (handoff §15.5a,
§21.8). Two of the costliest evidence classes — the green measured against a stale binary, and
the all-quiet read as a standing state — are exactly claims whose missing scope was *which tree
state produced this*; the worktree node is that scope made addressable and pinnable.

**The limit that survives first-class status, stated plainly:** the server still cannot see git.
The merge itself fires nothing; an agent (or the CLI wrapping the merge) must write the status
transition. What changed is the cost after that single write: previously, batch invalidation; now,
nothing — the derivation does it. Recording still precedes firing by exactly one agent action,
and this section would join the brief's Class E list if it claimed otherwise.

**What was still swept in:** a worktree-scoped memory *store*. There isn't one. Memories attach
to the worktree node by edge the way they attach to any entity — the node is a subject and a
coordinate, not a container with its own storage semantics.

### 3.6 The existing memory blob

`team_members.memories` (`002_identity.sql:119`) is a jsonb array on one row: no versioning, no
edges, no scope, no staleness — structurally unable to participate in anything above. It is the
document-not-graph pattern the user's thesis rejects, already in the tree. Disposition: **leave it
functioning** (it is shipped surface — `contract.ts:150` projects it), route new memory through
`memory` entities + `remembers` edges, and migrate content opportunistically in Phase 4. Breaking
it now buys nothing and costs a contract fight.

---

## 4. Class C, specifically — what this design does and does not do about it

The brief demands this answered plainly, so: **Class C is not detectable by any staleness
mechanism, in this design or any other, because nothing in a Class C failure changes state.**
`residual = 0` was true the whole time. A flag that fires on it would be a flag that fires on
true, well-scoped facts too — noise, which the evidence says trains readers to dismiss flags
entirely. This design does not detect Class C. It does four specific things *around* it:

**1. It makes scope structurally inseparable from the value.** Every Class C incident shared one
geometry: the value travelled and the scope stayed behind (in prose, in a test name, in the
author's head). A memory's `subject_scope` and `does_not_establish` are NOT NULL columns
(`public.memories`, §3.1 — the write fails without them) that project typed inside `state` on
**every** read (a `CoreEntityState` variant, following `contract.ts:86-110`).
The residual-count claim arrives as *"98 mounted / establishes: every v1
non-WS operation is mounted / does not establish: implemented — a registered handler that throws
is invisible to the no-body probe."* A reader can still over-read it — but they must now do so
**against an adjacent sentence**, not for want of a distant one. In the actual incident, the
caveat existed and lived in a different document than the number; the near-miss ("nearly written
into an entry-point document as: every v1 operation is implemented") was caught by a human asking
the mechanism question. This design's contribution is that the mechanism answer rides with the
number.

**2. It forces the false neighbour to be written by the person who knows it.** `does_not_establish`
is filled at write time by the claim's author — the moment the program's evidence shows the scope
is best understood (every instrument limit in §24.2 was stated *by the instrument's author,
unprompted*). The field is the program's scope-discipline rule (*"state the conditions under which
it was measured, or do not broadcast it"*) converted from a rule into a write-refusing detector —
the exact rule→detector move the program says is the only one that transfers.

**3. It makes shared-mechanism agreement queryable.** The `73+25=98` tautology survived because
four agreements *looked* like corroboration and nobody could see they shared one mechanism. With
`mechanism` a stored field, "N claims about one subject whose mechanism strings are effectively
identical" is a **sweep query** (§5.5), and its finding is the §15.5 verdict pre-written:
replication, not corroboration. This is the one place Class C acquires something that fires
without a reader — not on the mis-scoping itself, but on the corroboration structure that let it
survive.

**4. It gives the eventual noticer a one-edge path.** Every Class C error in the evidence *was*
eventually caught — by a person opening a file. The design cannot replace that person; it can make
their finding durable and directed: one `disputes` edge with the quote, and every subsequent
reader of the claim sees it. Today that person's finding lands in a message that scrolls away.

**The boundary, stated without decoration: nothing above stops a reader who reads the scope and
reasons past it.** The disk-deletion incident would likely have survived all four mechanisms — the
figure's scope was arguably *present* and the framing error happened in the order that consumed
it. Partial coverage here means: mis-scoping becomes an act of ignoring adjacent text rather than
an act of failing to locate distant text. The evidence suggests that is a real reduction — the
figures that fell hardest travelled furthest from their caveats — but it is a reduction, not a
solution, and anyone extending this design should treat Class C as open.

---

## 5. What FIRES — the read path, the push path, and the sweeps

The brief's §4 rule making this the crux: **"A RULE IS KNOWLEDGE THAT MUST TRANSFER TO THE WORK; A
DETECTOR IS KNOWLEDGE COMPILED INTO SOMETHING THAT FIRES WHETHER OR NOT ANYONE READ IT."** A
staleness record nobody reads is the §3.2-incident risk note with a schema. So every recorded
structure above is listed here with its firing surface, and the one that has none is named.

| # | Recorded structure | Fires | Where | Who sees it |
|---|---|---|---|---|
| 1 | NOT NULL scope columns | **At write** — the operation fails | `public.memories` (§3.1) | The author, at the moment of recording |
| 2 | Mark edges → derived badge | **On every summary read** | `badges` assembly, `entity-read.ts` | Every reader of every list, feed, context, connection — UI and agent alike |
| 3 | `supersedes` chain | **On the context read** — resolve-forward | `entities.context` | The next agent, on the inherit path |
| 4 | Any mark edge | **At mark time** — pushed | `edge.upsert` events (`mapper.ts:131`) | Live subscribers of the space |
| 5 | Pins + mechanism fields | **On sweep** | SQL views + an agent seat (§5.5) | The invalidation loop |
| — | A claim nobody reads and nothing links | **Never** | — | Nobody — stated honestly below |

### 5.2 The badge (surface #2)

One optional field on `EntityBadges` (`contract.ts:117`) — a DTO field addition, the lane the
brief explicitly sanctions ("fields … and projection changes"), zero catalog rows:

```ts
staleness?: {
  superseded?: { by: EntityId; headId: EntityId };          // chain head after following supersedes
  disputed?:   { open: number; latestAt: string };          // unanswered disputes edges
  basisMoved?: { count: number };                           // outbound pins behind their targets
  verified?:   { at: string; atVersion: number; current: boolean };  // current = atVersion == version
}
```

Assembly extends the existing single batched edge query (`entity-read.ts:388-394`) with the mark
types — the same shape that already loads `pulled` and `depends_on` both directions. Absent field
= no marks = today's behaviour; old clients ignore it.

**Checked against the brief's §7 read-path warning, explicitly:** every value above is
viewer-**independent** (derived from edges and versions, never from the caller), so nothing here
recreates the viewer-relative-field-in-a-replay-snapshot contradiction. And none of it may ever be
computed into a **command result**, because `ledger_record` stores results verbatim and
`ledger_replay` returns them byte-identical (`004:104-152`) — a staleness annotation frozen into a
replayed 201 would be this design failing its own brief. Rule for implementers: **staleness is
assembled in read handlers only; command handlers never touch it.**

### 5.3 The context read (surface #3) — annotate loudly, resolve forward, never silently drop

`entities.context` is the inherit-the-graph read (sections, byte budgets —
`feed-context.ts:674`), so it gets the two behaviours the summary badge cannot carry:

- **Resolve forward:** a context assembled over a superseded entity follows the `supersedes`
  chain and presents the **head**, with the traversal stated inline (`requested v… superseded by …`).
  Serving a known-superseded body to a fresh agent is serving rot; substitution-with-annotation is
  not blocking and loses nothing.
- **Annotate, never drop:** suspect entities stay in every section with their dispute count and
  latest quote attached. Dropping them is worse than including them — the evidence's risk-note
  incident shows a *suppressed* problem masks the live one behind it.

**On blocking, the brief's open question, answered with a recommendation:** default to
annotation everywhere; do not block reads on `suspect`. A dispute is an allegation with evidence,
not a verdict — a read-blocking allegation is a one-edge denial-of-service on any fact (and on any
rival agent's work), and the brief's own observation that blocking is "annoying enough to get
switched off" predicts the mechanism's end state. The one place blocking earns its cost is
**write-side**: creating a `based_on` edge pinned to a target that is *currently superseded*
should refuse (you are building on a version the graph already knows has a successor — follow the
chain first); pinning to a merely *disputed* target warns in the response but proceeds. This is
carried as open question §7.1 because the evidence for where that dial belongs is one program's
worth, not settled.

### 5.5 The sweeps (surface #5) — the agentic invalidation loop, with its cheap floor

Three are pure SQL over edges + versions — internal views, no catalog surface, runnable by a cron,
a CI step, or an agent's first command:

1. **Pin drift:** every `based_on` / `copy_of` / `verifies` edge with `props.pinnedVersion <`
   target's current `version`. (Class B / R1, wholesale.)
2. **Unanswered disputes, aged:** open disputes older than N days, oldest first — the "somebody
   flagged this and nobody resolved it" queue, surfaced instead of rotting.
3. **Shared-mechanism corroboration:** subjects with ≥2 claims whose `mechanism` fields are
   near-identical — replication wearing corroboration's costume, flagged from stored data (§4.3).

The fourth is agentic by nature: **scope-widening across derivation edges** — for each claim with
`based_on` → a measurement claim, does the statement exceed the basis's `does_not_establish`?
That is a judgment call, which is why it is an agent seat and not a view; the views above are its
work-list. An invalidator agent's whole loop is: run the views, open the sources, post evidence
messages, draw `disputes`/`supersedes` edges. Every step uses shipped operations.

**This seat is an out-of-band consolidator, and the out-of-band property is load-bearing.**
Memories are written in-band — during the work, by the context doing the work — and in-band
writes are locally optimal by construction: written to finish *this* task, under *this* session's
beliefs, sometimes wrong in ways the writing context cannot see. Anthropic's async-agent practice
reports the same structure empirically (user-supplied talk transcript, 2026-07, unverified but
convergent): raw in-band memory stores accumulate errors that recur on every replicate until an
offline "dreaming" pass — reading the memory store *against prior session traces* — corrects
them. tm8 has both halves addressable: the memories, and the traces (`work_sessions.
transcript_doc_id`, `001:711`; `authored_from` edges from §3.5). So the consolidation seat reads
memories **against the transcripts that produced them**, and does two things the in-band writer
structurally cannot: correct (dispute/supersede what the session believed but the trace
contradicts) and **distill** — promote a tactical, task-local statement into the transferable
generalisation, recorded as a new claim superseding the local one with `based_on` back to it.
Distillation is not cosmetic: the capability finding in the same report is that what separates
useful memory from noise is precisely whether the abstraction transfers to future sessions — the
brief's own transfer rule, arriving from a third direction.

**The honest hole in the firing table:** a claim that nothing links and nobody queries fires
nowhere — the graph does not push un-asked-for knowledge into an agent's context. The structural
mitigation is that claims enter through edges (`based_on` its subject, `remembers` its owner,
`authored_from` its session), so a claim *about* task T is on T's connection surface, which the
context read already assembles — reachability by subject, not by recall. What the design does
**not** do is guarantee any agent reads T's context before acting on T; that is harness
territory (spawn packets citing context reads), noted in §7.7 and not claimed here.

---

## 6. Sequencing — frozen catalog respected, cheapest useful increment named

Every phase is independently shippable and the program can stop after any of them with the value
banked. Catalog rows added, all phases: **zero**. Contract-**schema** additions (the two
core-kind enum values, their state/content variants, and the badge field) land in Phases 1–2 and
are the plan's only contract-package changes — the fields-and-projections lane the brief
sanctions, subject to whatever review governs schema widening, named here so nothing is smuggled.

**Phase 0 — conventions on shipped surface. No migration, no contract change, no server change.**
Adopt the `copy_of` props convention (`pinnedVersion`, `source`) on the shipped type for
restatements between existing entities, and the evidence-message citation discipline
(`file:line` in every figure-bearing message). *Cheapest useful increment: restatements acquire
owners — the 13-vs-14 class becomes detectable for anything that cites.* Phase 0 shrank when
memory went first-class (the first draft registered a custom kind here); it is now purely
provenance discipline, and the memory unit itself arrives with Phase 1.

**Phase 1 — one migration (038), in `015`'s shape for kind-addition — and deliberately NOT in
its shape for versioning** (review F1: `015` wired no snapshot triggers for its new detail
tables, so the precedent is exact about kinds and silent about the one mechanism §3.5 depends
on). DDL + data: `public.memories` and `public.worktrees` detail tables; **the
`internal.snapshot_entity_version()` trigger (`001:1130+`) wired on BOTH tables** — without it,
detail writes never advance `entities.version`, no pin ever drifts, and the design's central
mechanic fails silently green; `memory` + `worktree` seed rows in `entity_kinds`;
`internal.entity_content()` replaced to add both branches (the sanctioned extension point —
`001:1076-1078`, precedent `015:1651`); **four doors, not two** — `create_memory` /
`create_worktree` on `entities.create` and `update_memory` / `update_worktree` on
`entities.patch` (the patch service 501s unrouted core kinds,
`services/w2/entities-commands-tracking.ts:1018`) — **all four shipped WITH the `036`-pattern
resource binding from day one**, because handoff §23.15 measured that every unbound door on a
shared ledger label is an XG03 site, and XG03 itself is the executable acceptance template
(§23.12 ruling); the six mark-edge types inserted; `authored_from` src_kinds widened to
`array['message','memory']`; `edge_types.append_only` enforced by a **row-level BEFORE UPDATE OR
DELETE trigger on `public.edges`** (§3.3 — covers `edges.patch`, `edges.delete`, AND
`write_edge`'s ON CONFLICT upsert at `018:195-202`); the props-shape validation trigger for mark
types (`edge_types.props_schema` exists and is unenforced — `001:756-758` — this is its first
consumer, exactly the "revisit when first promoted" the schema comment anticipated). Contract
side: enum + state/content variants; `memory` and `worktree` stay **out** of `entities.create`'s
exclusion list (`schemas.ts:853`) so creation needs no new operation. Gates, from the program's
own scar tissue: proven through `db/migrate.mjs` (the applier is a third thing — §22.1), the
set/reset-role state-machine lint (§23.1), and every new trigger and all four doors validated
**red on known-bad and green on known-good** (§23.1's negative-control rule) — including the
F1 mutation test (trigger omitted → merged worktree bumps nothing → red) and the F3 upsert
control (re-created `disputes` edge with changed props → red). *Cheapest useful increment:
memory exists, worktrees exist, agents can mark, and marks are durable, evidenced, append-only —
capability lands here, per the user's floor.*

**Phase 2 — the badge.** `badges.staleness` in the contract DTO (optional field) and the
`loadRelations` extension. Read-only, viewer-independent, never in command results (§5.2's
check). *Cheapest useful increment: staleness stops being queryable-only and starts being
ambient — every list and feed carries it.*

**Phase 3 — context semantics.** Resolve-forward on `supersedes`, inline dispute annotation, and
a claims-about-subject presence in the context read. Touches the most delicate read path
(byte-budgeted sections), so it follows the badge rather than leading. *Cheapest useful
increment: the next agent's first read inherits the corrected graph without asking.*

**Phase 4 — the loop.** The three SQL views; the out-of-band consolidation seat (§5.5: correct
against transcripts, distill task-local claims into transferable ones — skill + standing task);
`remembers`-based memory for team members with opportunistic migration off the blob; the
worktree lifecycle write wired into merge tooling (one `entities.patch` — after which pin drift
fires by derivation, §3.5). *Cheapest useful increment: the pin-drift view alone — it is one
query and it detects the entire R1 class for recorded pins.*

---

## 7. Open questions — each with what would close it

1. **Annotate vs block, the dial's final position** (§5.3). Recommended: annotate reads, refuse
   `based_on` pins to superseded targets, warn on disputed. *Closed by:* one real multi-agent
   program run on Phase 2+, counting (a) rot inherited despite annotation, (b) legitimate work
   refused by the write-side block. The evidence to decide this does not exist yet and cannot be
   reasoned into existence.
2. **Second-reader enforcement depth** (§3.3). Adopted floor: the verifying evidence's
   `authored_from` session must differ from the claim's — context separation, trigger-checkable.
   Still open above the floor: does verification require the second reader's own `verifies` edge
   (two-edge quorum — mechanical, heavier), or does the named-reader convention plus sweep-#2
   audit suffice? A distinct-but-incurious session remains the residual hole either way. *Closed
   by:* Phase 1 usage evidence on how often single-session verifications get overturned.
3. **Worktree status writer discipline.** `work_session.status` has a single-writer guard (R29,
   `001:727-744`) because a transition function owns it. `worktree.status` is agent-reported by
   design — is a forward-only check trigger enough, or does it need the R29 shape (one transition
   function, every other writer refused)? *Closed by:* Phase 1 review — count the paths that can
   plausibly write it; more than one distinct caller means R29, because "a well-meaning future
   RPC quietly becoming writer #2" is the exact failure that comment names.
4. **Cross-space claims are impossible.** Edges refuse endpoints in different spaces
   (`001:791-794`), so a claim cannot cite a subject in another space. The W0–W5 program lived in
   one repo and would fit one space; whether real programs do is unknown. *Closed by:* the first
   real cross-space program; if it needs cross-space citation, that is contract-level work
   (a reference-by-value form, or claim mirroring with `copy_of`), named here so it is not
   smuggled later.
5. **Volume and noise.** No TTL by design (the brief and the evidence agree: noise trains
   dismissal). Claims accrete; soft-delete and `collections` exist for curation; whether
   accretion degrades context reads at real scale is unmeasured. *Closed by:* Phase 4 telemetry —
   claims per space per week, badge density on hot entities.
6. **One-hop basis derivation** (§3.2 limit). Deep rot chains surface only via the sweep.
   *Closed by:* measuring, after Phase 4, whether sweep-found transitive rot ever mattered before
   the one-hop signal caught it at a nearer node.
7. **R3's residue** (§2). Should the coverage-ledger claim (sites governed / sites wired) be a
   convention, or is it R3 theatre? *Closed by:* trying it once on a real class — the
   microsecond-cursor idiom with its known 3-of-11 shape is the natural pilot — and seeing
   whether the ledger changed anyone's sweep.
8. **Harness integration.** Nothing here makes an agent read context before acting (§5.5's
   honest hole). Spawn packets citing `entities.context` for the work target, and the CLI's
   worker-init path surfacing open disputes on the assigned task, are harness design — adjacent,
   real, and not this document's to decide.

---

## 8. Coda: this document, run through its own design

This document is prose, so per its own §2 it is R4-exposed the day it lands. Its figures carry
`file:line` citations — the cheap approximation. Its claims about the tree were produced by
mechanism *"read the working tree at one commit on 2026-07-27"* — which establishes what the
source says, and **does not establish** what the running system does; nothing here was executed.
Its incident claims are `copy_of` the brief and the handoff state, pinned to the versions read
today, and one drift was found and recorded (§0). One of its own decisions has already been
superseded the honest way: the first draft's custom-kind memory fell to a user ruling, and the
supersession is recorded inline (§3.1) rather than silently rewritten — the predecessor is named
in the successor, which is what a `supersedes` edge is. When any of this is implemented, the
first `memory` entities written should be this document's own load-bearing figures, superseding
these paragraphs as the medium — which is, after all, the thesis.
