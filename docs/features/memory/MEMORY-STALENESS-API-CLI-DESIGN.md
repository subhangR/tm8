# tm8 W6 — Memory & Staleness: API and CLI Design

**Status: DESIGN. Companion to `MEMORY-AND-STALENESS-DESIGN.md` (the data-model design; read it
first — this document does not restate it, it maps it onto the wire and the terminal).**

**The constraint that shapes everything here: the contract catalog is frozen at 101 rows.** This
design adds **zero operations**. Every memory/staleness/worktree action maps onto a shipped v1
operation; the CLI additions are client-side composition over those operations plus rendering.
Where the contract *package* changes (enum values, state variants, one badge field), it is the
fields-and-projections lane, listed exhaustively in §1.6 and nowhere else.

**Method and limits, up front:** every claim about the shipped surface carries a `file:line` from
the working tree read on 2026-07-27. Claims about the CLI follow `CLI-GRAMMAR-REDESIGN.md`
(the frozen grammar) and `packages/cli/src/exit.ts` (the frozen exit table, `exit.ts:25-47`).
Nothing was executed by the author; **an independent Fable 5 review
(`reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md`) has since traced the load-bearing chains
through the source** — its dispositions are folded in below, marked *(review-confirmed)* where a
first-draft **[VERIFY]** resolved, and §4 now records each question's outcome. What remains
unexecuted remains labelled.

---

## 1. API design

### 1.1 The accounting table — every action, its operation, its atomicity

The load-bearing shipped fact — **and the authority for it is the implementation, not the
grammar law** (the grammar's "validated before the entity is inserted" wording at `GRAMMAR:308`
describes a shape that ships as validate-after-insert-same-transaction, rollback-equivalent):
`entities.create` accepts `connections: uniqueArray(InitialConnectionInputSchema)`
(`schemas.ts:861`), each carrying `{type, targetId, props}` (`schemas.ts:808-812`), and the live
W2 service runs the door RPC, every `write_edge`, the ledger record, and event capture **inside
one transaction** (`services/w2/entities-commands-tracking.ts:879`) — an edge failure rolls back
the entity, the ledger row, and the events together *(review-confirmed)*. Initial connections
are authored **from the new entity outward** — `attachInitialConnections` passes the new entity
as src (`entities-commands-tracking.ts:783-827`), corroborated by `internal.attach_on_create`
inserting `src_id = p_new_id` (`007:899-901`) *(review-confirmed, two mechanisms)*. Two
consequences banked from the review: the connection machinery is **facade-generic** — it runs
after *any* kind's door, so `create_memory` needs **no** connections parameter of its own; and
connection props reject the reserved key `origin`
(`entities-commands-tracking.ts:797-799`) — no mark-type props contract may use that name.

| Action | Operation (catalog row) | Body essentials | Atomic? |
|---|---|---|---|
| Create a memory + its pins | `entities.create` (`catalog.ts:54`) | `kind:'memory'`, `content:{statement, mechanism, subjectScope, doesNotEstablish, measuredAt?}`, `connections:[{type:'based_on', targetId, props:{pinnedVersion, pinnedAt, treeState?}}, {type:'authored_from', targetId:<work-session>}, {type:'supersedes', targetId:<predecessor>}?]` | **Yes — one write, all-or-nothing** |
| Create a worktree | `entities.create` | `kind:'worktree'`, `content:{path, branch, baseRef, projectId?}` | Yes |
| Worktree lifecycle transition | `entities.patch` (`catalog.ts:55`) | `expectedVersion`, `content:{status:'merged'|'abandoned'|'deleted'}` | Yes — and the version bump IS the invalidation trigger (main design §3.5). **Requires the Phase-1 `update_worktree` door**: the patch service routes per-kind and throws `not_implemented` for unrouted core kinds (`entities-commands-tracking.ts:1018`), and the bump itself requires the snapshot trigger wired on `public.worktrees` (main design §3.5, review F1/F2) |
| Dispute (mark suspect) | `edges.create` (`catalog.ts:77`) | `srcId:<evidence>`, `type:'disputes'`, `dstId:<target>`, `props:{quote, expected, observed, citation, pinnedVersion}` | Yes (evidence entity must already exist; see §2.3 for the two-step sugar) |
| Verify (mark current) | `edges.create` | `srcId:<fresh evidence>`, `type:'verifies'`, `dstId:<target>`, `props:{mechanism, secondReader, answers:[edgeIds], pinnedVersion}` | Yes |
| Supersede in place | `edges.create` | `srcId:<successor>`, `type:'supersedes'`, `dstId:<predecessor>` | Yes (or atomically at successor creation via `connections`) |
| Remember (owner association) | `edges.create` | `srcId:<actor entity>`, `type:'remembers'`, `dstId:<memory>` | Yes — but **cannot** be an initial connection of the memory: `remembers` runs owner→memory and initial connections run memory→outward. Separate call; failure orphan is a memory without an owner edge, recoverable by re-issuing |
| Restatement pin | `edges.create` | `type:'copy_of'`, `props:{pinnedVersion, source}` | Yes |
| Read staleness state | `entities.get` / any summary-bearing read | `badges.staleness` (main design §5.2) | read |
| Enumerate marks on X | `edges.list` (`catalog.ts:76`) | `destination=X`, `type=disputes|verifies|supersedes`, `direction` — all shipped filters (`edges-placements.ts:96-103`) | read |
| Memories about X | `entities.connections` (`catalog.ts:61`) on X, `--type based_on --direction incoming` — one paged read | read |
| Inherit-the-graph read | `entities.context` (`catalog.ts:155`) | staleness annotations + resolve-forward (§1.4) | read |
| The sweeps | **No API surface.** Internal SQL views (main design §5.5), run by cron/CI/agent sessions through their own DB access | — |

**Deliberately absent:** no `memory.markStale`, no `staleness.set`, no bulk-invalidate operation.
Marking is edge creation, full stop — that is what keeps the write path on shipped catalog rows,
the history append-only, and the evidence attached structurally.

### 1.2 Wire shapes

**Create a memory** (the canonical agent write — one request):

```jsonc
POST /v2/entities
{
  "clientMutationId": "mem-cursor-truncation-2026-07-27-a",
  "spaceId": "…",
  "kind": "memory",
  "title": "timestamptz cursors truncate through JS Date",
  "content": {
    "statement": "Any cursor round-tripping a timestamptz through a JS Date re-admits or skips rows at millisecond boundaries.",
    "mechanism": "measured: stored 06:34:13.421911 emitted as .421Z; reproduced across two databases",
    "subjectScope": "node-pg parse path; sites that format in SQL but pass through iso() are ALSO affected",
    "doesNotEstablish": "that any individual site is fixed — immunity requires the full call path to the wire",
    "measuredAt": "2026-07-27T06:34:13Z"
  },
  "connections": [
    { "type": "based_on",      "targetId": "<handlers/messages.ts doc entity>", "props": { "pinnedVersion": 7, "pinnedAt": "2026-07-27T07:00:00Z" } },
    { "type": "authored_from", "targetId": "<work-session entity>" }
  ]
}
→ 201 EntityDetail, state: { "kind": "memory", "mechanism": …, "subjectScope": …, "doesNotEstablish": …, "measuredAt": … }
```

The response's `state` variant is the scope-travels-with-value guarantee: **every** subsequent
summary read of this entity carries those fields inside the same payload as the title
(main design §3.1). `statement` lives in `content` (the detail read), with `title` as its
display form — mirroring how `doc` separates body from title (`contract.ts:147`).

**Worktree lifecycle** (the one write that makes merges fire):

```jsonc
PATCH /v2/entities/<worktree-id>
{ "clientMutationId": "…", "expectedVersion": 3, "content": { "status": "merged" } }
→ 200; entities.version now 4 → every based_on pin at 3 shows basisMoved on next read
```

`expectedVersion` is the shipped optimistic guard (`schemas.ts:866`) and is **required** here by
the same schema — a lifecycle transition against a version you have not read is exactly the
announcement-over-measurement failure the evidence catalogues.

**Mark edges** — `edges.create` bodies as in §1.1. The per-type props contracts live in
`edge_types.props_schema` (nullable and unenforced today — `001:756-758`; Phase 1 populates the
six mark rows and adds the validation trigger, main design §3.3). The wire consequence: a
malformed `disputes` props body fails **at the registry**, one place, not per-handler.

### 1.3 Validation and error surface

Frozen error-code vocabulary; nothing new. The full chain was traced by the review *(Q3)*:
errcode → `translateDbError` (`db/errors.ts:62-85`) → `CollabError` → `ERROR_STATUS`
(`contract.ts:515-521`) → exit code (`cli/errors.ts:52-66`) — mechanical, never
message-regexing. §23.1's negative-control rule still applies to every row at implementation.

| Failure | Where it fires | Wire result |
|---|---|---|
| Memory missing a scope field | the `create_memory` / `update_memory` doors **pre-check and raise `22023` — MANDATORY, not stylistic** (review F5): a bare 23502 is **absent from `SQLSTATE_TO_ERROR_CODE`** and surfaces as a *retryable 503* "internal database error" — telling a caller to retry a write that can never succeed. Implementation gate: insert with a missing scope through the raw table, observe the 503, prove the pre-check is the only thing standing between callers and it | 400 `invalid_input`, exit 2 *(review-confirmed: 22023→400→2)* |
| Unregistered edge type | `internal.validate_edge` (`001:778-800`), errcode 23514 | 409 `invariant_violation`, exit 6 *(review-confirmed: 23514→409→6)* |
| Kind-mismatched mark (e.g. `disputes` src not an evidence kind) | same trigger, registry `src_kinds` | 409 `invariant_violation`, exit 6 |
| Deleting/patching/**upserting** an append-only mark edge | the Phase-1 **row-level** guard on `public.edges` (main design §3.3 — covers `write_edge`'s ON CONFLICT path, `018:195-202`, review F3) | 409 `invariant_violation`, message naming the rule — the refusal must say *why* (the caveat-in-the-diagnostic pattern, handoff §23.17) |
| `verifies` whose `answers` reference edges that are not open disputes on this target | Phase-1 props trigger | 409 with the offending id named |
| `verifies` authored from the claim's own session | Phase-1 session-separation check (main design §3.3) | 409, message: "verification requires an independent context" |
| `supersedes` cycle | `internal.prevent_edge_cycle` (`001:813-846`) enforces the registry `acyclic` flag on insert AND update *(review-resolved — the main design's verify-item closes)*. Caveat carried: the CTE bounds at depth 256 (`001:836`), so the Phase-3 resolve-forward walk carries its own depth bound and annotates loudly rather than hanging on pathological data | 409 `invariant_violation`, exit 6 |
| Version conflict on worktree transition | shipped `expectedVersion` guard | 409 conflict, exit 6 |
| Replay of a `clientMutationId` at a different resource | **the `036`-pattern binding all FOUR new doors ship with** (two create + two update — main design §6 Phase 1; handoff §23.15; review F2) | 409 `invariant_violation`, nothing leaked — XG03's acceptance shape |

**Idempotency:** all mutations carry `clientMutationId` per the universal envelope
(`004_ledgers.sql:79-92`). The ledger stores results verbatim and replays byte-identical
(`004:104-152`) — which is *why* no derived staleness value ever appears in a command result
(main design §5.2): a replayed 201 must not carry a frozen badge.

### 1.4 Reads: where staleness surfaces on the wire

1. **Every `EntitySummary`** gains optional `badges.staleness` (shape in main design §5.2).
   Absent = no marks = today's bytes. Viewer-independent by construction.
2. **`entities.context`** (the inherit path): root resolved **forward** along `supersedes` with
   the traversal stated; suspect connections annotated inline, never dropped (main design §5.3).
   The context view already has a `schemaVersion` discriminator (`contract.ts:1293`) — the
   annotation additions ride a minor revision of that tag, so old clients fail loud, not subtly.
3. **`entities.connections` / `edges.list`**: mark edges are ordinary edges — the shipped
   filters (`type`, `direction`, `source`/`destination`) are the query surface. No new read
   operation is needed to enumerate disputes, and **none is proposed**.
4. **Events**: `edge.upsert` / `edge.deleted` already exist (`mapper.ts:131-132`); mark writes
   push to subscribers with no new event kinds. UI/agent guidance: an `edge.upsert` whose type is
   a mark type invalidates the target's cached badge.

### 1.5 What the sweeps are NOT

The three SQL views and the consolidation ("dreaming") seat (main design §5.5) are **internal**:
they run against the database through session-local access, not through the public API, and they
*produce* ordinary `edges.create` calls when they act. Exposing a "run the sweep" operation would
be a new catalog row for something a standing agent session does with shipped tools — rejected.

### 1.6 The complete contract-package delta (and nothing else)

1. `CoreEntityKindSchema`: + `'memory'`, + `'worktree'` — **not** added to `entities.create`'s
   exclusion list (`schemas.ts:853`), which is what keeps creation on the shipped operation.
2. `CoreEntityState`: + `{ kind:'memory'; mechanism; subjectScope; doesNotEstablish;
   measuredAt? }`, + `{ kind:'worktree'; status; branch; baseRef; path }`.
3. `CoreEntityContent`: + memory (`statement` + the state fields), + worktree variants.
4. `EntityBadges`: + optional `staleness` (main design §5.2).
5. `EntityContextView`: annotation fields + `schemaVersion` minor bump.

Zero catalog rows; zero new operations; zero removals; every addition optional-or-new-variant, so
existing payloads are byte-stable. This is the delta that goes to whatever review governs schema
widening — stated here once so it cannot be smuggled piecemeal.

---

## 2. CLI design

Grammar authority: `CLI-GRAMMAR-REDESIGN.md` §3-§4. Conventions honoured throughout: noun /
subnoun / verb; global `--space --as --format --timeout --no-color --quiet`; mutations take
`--mutation-id`; pages take `--limit`/`--cursor`; guard flags kebab-case their schema field
(handoff §21.4: `expectedVersion` → `--expect-version`); `--data <json-source>` remains the
exact-DTO escape hatch; enum values use exact contract spelling. Frozen exit table
(`exit.ts:25-47`) — **no new exit codes**, and none are needed.

### 2.1 The capability floor: zero CLI changes

Everything in §1.1 is reachable **today** through the universal commands — the grammar's own rule
that "universal node operations are always entity commands" (`GRAMMAR:32`):

```
tm8 entity create memory "timestamptz cursors truncate" \
    --content @memory.json \
    --connect based_on=<subject-id> --connect authored_from=<session-id>
tm8 edge create <evidence-id> disputes <target-id> --props @dispute.json
tm8 edge create <fresh-evidence-id> verifies <target-id> --props @verify.json
tm8 entity update <worktree-id> --expect-version 3 --content '{"status":"merged"}'
tm8 entity connections <target-id> --type disputes --direction incoming
```

This floor matters: **the agent capability exists the moment Phase 1 lands, with no CLI release
at all.** Everything below is ergonomics and rendering — the write-path detector made
discoverable — not capability. *Gap at the floor, stated: `--connect <type>=<id>` has no props
slot in the frozen grammar (`GRAMMAR:231`), so pinned initial connections need `--data` or the
sugar below. The sugar is therefore not pure convenience for `based_on`: it is the only
non-`--data` path to an atomic pinned create.* *(Review-confirmed: `GRAMMAR:231` offers no props
form; the sugar's justification stands as written.)*

### 2.2 `tm8 memory` — the sugar group

Every command names the operation(s) it composes. One rule governs the group: **a command that
composes two operations must say so in its failure modes**, because non-atomic sugar that looks
atomic is the instrument-defect class (handoff §15) arriving in a terminal.

```
tm8 memory add <statement>
    --mechanism <text>
    --scope <text>
    --not-established <text>
    [--about <entity-id>...]          # based_on pins; see pinning rule below
    [--session <work-session-id>]     # authored_from; defaults to the session-injected context
    [--supersedes <memory-id>]        # atomic supersession at birth
    [--remember]                      # + remembers edge from --as actor (SECOND call — see below)
    [--title <text>]                  # defaults to first 80 chars of statement
    [--measured-at <iso-time>]
    [--mutation-id <id>]
```

Maps to **one** `entities.create` (kind `memory`, content from the four required flags,
`connections` from `--about`/`--session`/`--supersedes`) — atomic per `GRAMMAR:308`. The four
scope flags are **required by the CLI** and validated locally first: a missing `--scope` exits
**2 before the network** (`exit.ts:27`), which puts the write-path detector at the earliest
possible point; the server's NOT NULL remains the enforcement of record for non-CLI callers.
`--remember` issues a second `edges.create` (owner→memory; direction makes an initial connection
impossible, §1.1): on failure the CLI exits with the edge's code and prints the created memory id
with the exact retry command — **the memory is not rolled back and the output says so.**

**The pinning rule** (applies to `--about` here and `--pin` below): the CLI resolves the
target's current `version` with one `entities.get` and writes it into `props.pinnedVersion`. A
concurrent bump between read and write pins one version behind, which surfaces as `basisMoved`
on the next read — **the race degrades toward a false flag, never toward false confidence.**
Stated in `help` verbatim, because the direction of that degradation is the design.

```
tm8 memory get <memory-id>                                    # entities.get
tm8 memory about <entity-id>                                  # entities.connections on the SUBJECT:
    [--limit <n>] [--cursor <cursor>]                         #   --type based_on --direction incoming
tm8 memory mine                                               # edges.list source=<actor entity>
    [--limit <n>] [--cursor <cursor>]                         #   type=remembers
```

Each read maps to exactly **one** paged operation — no client-side merging, because the grammar
already ruled that two independently paged streams cannot produce one honest cursor
(`GRAMMAR:311`). Enrichment (titles for the returned ids) happens per-page via batch
`entities.get`, never across the cursor boundary.

```
tm8 memory dispute <target-id>
    --quote <text> --expected <text> --observed <text>
    [--cite <file:line>]
    (--evidence <entity-id> | --note <text>)
    [--mutation-id <id>]
```

With `--evidence`: **one** `edges.create` (`disputes`), atomic. With `--note`: composes
`messages.post` (the evidence message, anchored to the target) **then** `edges.create` from the
new message — two operations; if the second fails, the CLI prints the message id and the exact
retry command, and the orphan is a posted note with no mark: visible, harmless, re-issuable. The
props carry `pinnedVersion` of the target at dispute time (pinning rule above). Cheapness is the
point: this is the one-edge suspect mark of the asymmetry (main design §3.3).

```
tm8 memory verify <target-id>
    --mechanism <text>
    --second-reader <actor-id>
    --answers <edge-id>...
    --evidence <entity-id>
    [--mutation-id <id>]
```

**One** `edges.create` (`verifies`). Every flag is required — the CLI refuses locally (exit 2)
if any is missing, mirroring the five structural requirements of the expensive direction. The
CLI additionally pre-checks that `--evidence`'s `authored_from` session differs from the
target's and warns before sending **[the server trigger is the enforcement; the CLI check is
courtesy so the failure arrives before the network, not instead of it]**. There is deliberately
no `--force`.

```
tm8 memory supersede <old-memory-id> --by <new-memory-id>     # edges.create supersedes
    [--mutation-id <id>]
tm8 memory status <memory-id>                                 # read composition, no cursor:
                                                              #   entities.get (badge) +
                                                              #   edges.list dest=<id> marks
```

`memory status` renders the derivation the badge summarises: open disputes with their quotes,
answering verifications with mechanism and reader, supersession chain to head, pin drift per
`based_on` edge. It composes reads without pagination promises (bounded first page of each). Per
the review's Q6 ruling on the scripting law (`GRAMMAR:912` — json emits exact contract DTOs, no
CLI-private shapes): `--format json` emits **one object with declared members `badge` and
`marks`, each member a verbatim contract page DTO**, the envelope documented in `help` — the
composite's shape is declared, not left to the implementer, because an envelope defined by
omission is a CLI-private shape wearing a loophole.

### 2.3 `tm8 worktree` — the sugar group

```
tm8 worktree add <path>
    --branch <branch> --base-ref <ref>
    [--project <project-id>] [--title <text>] [--mutation-id <id>]     # entities.create kind=worktree
tm8 worktree merged    <worktree-id> --expect-version <n> [--mutation-id <id>]
tm8 worktree abandoned <worktree-id> --expect-version <n> [--mutation-id <id>]
tm8 worktree deleted   <worktree-id> --expect-version <n> [--mutation-id <id>]
```

The three transition verbs map to `entities.patch` with `content.status` — sugar over
`tm8 entity update`, worth having because the transition is the single write that fires
wholesale invalidation (main design §3.5) and it should be one obvious command in the merge
tooling's hand. `--expect-version` is required by the shipped schema (`schemas.ts:866`), not by
CLI opinion. Association stays on the floor: `tm8 edge create <session-id> in_worktree
<worktree-id>` needs no sugar. Listing half-stays on the floor (review F7): `entity query`
filters `kinds` (`contract.ts:215-239`), so kind-level listing works — but `CollectionQuery` has
**no content-field filter**, so "list *active* worktrees" is not expressible server-side; merge
tooling filters client-side within pages. And `tm8 entity query` is itself **[PROPOSED]** grammar
(`GRAMMAR:317`) over the shipped `collections.query` (`catalog.ts:89`) — the operation exists,
that CLI command does not yet. If status-filtered listing proves hot, the honest options are a
`CollectionQuery` field addition (schema lane, not a catalog row) or client-side filtering,
named here rather than discovered later.

### 2.4 Rendering the badge (output law, `GRAMMAR` §7)

`--format human`: summaries carry at most one staleness marker, chosen by the main design's
precedence — `⊘ superseded → <head-id>` / `? disputed(<n>)` / `↺ basis moved(<n>)` /
`✓ verified@v<n>` — one glyph, never a paragraph, because a noisy flag trains dismissal (brief
§6). `--format json|jsonl`: `badges.staleness` verbatim, no CLI reinterpretation. Exit codes are
**unaffected by staleness**: reading a superseded entity exits 0 — staleness is an annotation,
not an error, and encoding it as nonzero would be the read-blocking mistake §5.3 of the main
design declines (a one-edge allegation must not break scripts).

### 2.5 `worker-init` surfacing (proposal, harness territory)

`worker-init` (shipped module, `packages/cli/src/commands/worker-init.ts`) additionally prints
open disputes and supersessions on the assigned task's subtree at session start — the
inherit-the-graph read placed where every worker actually begins. Flagged as a proposal because
it is harness policy (main design §7.8), not graph mechanics; it needs no new operation either
(`entities.context` on the assigned task).

### 2.6 Phase alignment

| Main-design phase | API surface live | CLI |
|---|---|---|
| Phase 1 (migration) | Everything in §1.1 via generic ops | **Floor only** (§2.1) — full capability, zero CLI release |
| Phase 2 (badge) | `badges.staleness` on summaries | Badge rendering (§2.4) |
| Phase 3 (context) | resolve-forward + annotations | `worker-init` surfacing (§2.5) |
| Any time ≥ Phase 1 | — | `memory` / `worktree` sugar groups (§2.2–2.3) — pure client composition, independently shippable |

---

## 3. What this design refuses, with reasons

- **No `staleness` noun.** Staleness is not a resource; it is a derivation. A `tm8 staleness set`
  would recreate the stored-status column the main design rejects (§3.2).
- **No bulk invalidation command.** The wholesale case is the worktree transition (one patch);
  everything else is per-edge with evidence. A bulk mark without per-target evidence is the vague
  risk note that masked a live defect (brief §3.2).
- **No new exit codes.** The frozen table's 6 (conflict/invariant) covers every guard refusal;
  overloading staleness into `$?` would make annotation indistinguishable from failure.
- **No sweep API.** §1.5.
- **No `--force` on `verify`.** The expensive direction is expensive by design; a bypass flag is
  the reassuring-direction hole reopened with a convenience name.

## 4. The review questions, and what happened to each

Asked of the independent reviewer (`reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md`); dispositions
folded into the sections above.

1. **Initial-connection direction** — **CONFIRMED** (src = new entity, two mechanisms:
   `entities-commands-tracking.ts:783-827`, `007:899-901`), with three nuances banked in §1.1:
   cite the implementation not the grammar law; the connection machinery is facade-generic (the
   new doors need no connections parameter); `origin` is a reserved props key.
2. **`--connect` props gap** — **CONFIRMED as written**; the sugar remains the only non-`--data`
   atomic pinned create.
3. **Error-code mappings** — **traced end-to-end** (§1.3's table now carries the verified chain).
   The material finding (F5): bare 23502 is *unmapped* and surfaces as a retryable 503, so the
   door pre-check is mandatory, with the raw-table negative control in the gate.
4. **`acyclic` enforcement** — **RESOLVED, enforced** (`001:813-846`), with the depth-256 caveat
   carried into the Phase-3 walk (§1.3).
5. **`entity query` fit** — **PARTIAL** (F7): kind filter yes, content-field filter no, and the
   command itself is [PROPOSED] grammar; §2.3 restated accordingly.
6. **`memory status` composition** — **resolved by declaration**: named-envelope JSON (§2.2), no
   grammar amendment needed.

The review also produced two major findings against the **main** design (F1: version bumps
require per-table snapshot triggers `015` never wired; F2: `entities.patch` 501s unrouted core
kinds, so the transition needs an `update_worktree` door) — both folded into the main design's
§3.1/§3.5/§6 and reflected in §1.1/§1.3 here. Its full filter — ~40 checks cleared alongside the
findings — is published in the review document's §5, which is what makes the findings weighable
(program close, §7 item 5).
