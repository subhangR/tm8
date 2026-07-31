# TM8 build order and file ownership — the manifest for the memories / worktrees / artifacts lanes

Author: foundation worker (`sess_1785455553256_u3iijo8gq`), 2026-07-31.
Prerequisites this document assumes landed (they are, in the working tree):

- `db/migrations/052_edge_guard_multi_kind.sql` — the shared edge-guard
  migration. Applied and behavior-proven (see
  `docs/plans/TM8-FOUNDATION-VERIFICATION.md`).
- `packages/server/test/events/projector-entity-read-parity.test.ts` — the
  parity gate. 6/6 green.

Read the verification doc first: **three of the seven claims your designs build
on came back different**, and §5 below says which design sections each refutation
invalidates.

---

## 1. Migration numbers

**The designs' allocation (051 shared, 052 artifacts, 053 memories, 054
worktrees) is dead.** 051 was taken by a different session while the designs
were being written; the shared migration is **052**, taken at write time.

| # | file | owner | status |
|---|---|---|---|
| 051 | `051_profile_selects_content_surface.sql` | another session | in tree, applied |
| **052** | `052_edge_guard_multi_kind.sql` | **shared (foundation) — owned by no feature** | **landed** |
| next free | *your feature migration* | first lane to write | **claim at write time** |

**The rule (this is how 051 was lost, twice):** do not reserve numbers. Run
`ls db/migrations | tail` **immediately before** writing your file, take the
next free number, and re-check after writing that no concurrent file took the
same one. Applied migrations are immutable and ordering is lexical, so a
collision costs a third migration after somebody notices. If the expected order
holds it will be 053 artifacts, 054 memories, 055 worktrees — but the **voice
lane is live in this tree today** (see §2) and may take numbers; there is no
guarantee beyond claim-at-write-time.

**What 052 already did for you** (do NOT redo any of it in a feature migration):

- `authored_from.src_kinds = {message, memory, artifact}`; description made
  kind-neutral.
- `in_project.src_kinds` += `artifact`; `attached_to.src_kinds` += `memory`,
  `artifact`.
- `edges_authored_from_message_idx` **renamed** to
  `edges_authored_from_source_idx` — rename only; the UNIQUE one-per-source
  predicate is intact and load-bearing for all three lanes. Never drop or widen
  it.
- `internal.guard_w1_edge` replaced **once**: the `authored_from` writer
  equality is now the per-type set `{message_recorder, memory_recorder,
  artifact_publisher}`, and `in_worktree` joined the `props.origin` stamping
  list (`in_project`, `participates_in`, `in_worktree`). `in_worktree` is
  deliberately **absent** from the recorder-owned set — the reason is a SQL
  comment in 052 itself.
- Writer tokens, non-colliding, as negotiated: `memory_recorder` (memories),
  `worktree_manager` (worktrees, stamping only), `artifact_publisher`
  (artifacts). All three proven live: the two recorder tokens accepted on
  `authored_from`, `worktree_manager` correctly refused there.

**Standing hazards 052 documents but does not fix:**

- The `UPDATE`-path allowlist for *changing* `props.origin` contains none of the
  three new tokens. Fine today (all three write `authored_from` once, never
  update). Any future correction path fails `42501` until its token is added —
  that addition is a policy decision, in a **new shared** migration if more than
  one lane needs it.
- **No later migration may `create or replace internal.guard_w1_edge`** or
  rewrite the three widened `src_kinds` arrays. If your feature needs a new
  guard branch, that is a new shared prerequisite, not a feature edit.
  Recommended (unowned): a CI grep for duplicate
  `create or replace function internal.<name>` across the chain — this bug
  class has no error message.
- `in_worktree`'s **registry row** is NOT in 052 — it lands in the worktrees
  feature migration (with its own `props_schema`; 018's bulk sweep will not
  cover a later row).

## 2. Catalog baseline — resolved, with a fourth mover you did not plan for

Measured this session:

| where | count | composition |
|---|---|---|
| git HEAD | **106** | the committed baseline the memories design cites |
| working tree | **111** | 106 + 4 `attentionRequests.*` (in-flight attention work) + 1 `voice.token.create` (**added mid-session today** by the voice-channels lane, `task_1785455843956_v7p4zpymk`) |

**Resolution of the three-way disagreement:**

- The **attentionRequests ops are IN**: they are in the tree, and the tree's
  count tests already assert them. "106 committed" (memories) is a true git fact
  and the wrong gate target — gates run against the tree.
- **worktrees' "catalog is at 110 (VERIFIED)" and its G5 gate ("still declares
  110") are stale twice over** — the tree is already 111. Rewrite G5 as **"my
  change adds zero catalog rows"** (a delta, not a literal).
- **memories: same rule** — assert zero delta, never a literal.
- **artifacts: +6**, so its gate is *(tree count at its write time)* **+ 6** —
  **117** if voice's 111 stands and nobody else adds. Its §A.3 sweep table
  shifts by one everywhere (110→116 becomes 111→117; HTTP 109→115 becomes
  110→116). The histogram deltas for its own six rows (+5 POST, +1 GET;
  +4 command, +2 read) are unchanged. Artifacts also owns the conformance
  manifest regeneration its rows force (`catalogDigest` is a sha256 over the
  operations array). Re-grep the count at write time:
  `/usr/bin/grep -c "{ name: '" packages/contract/src/catalog.ts`.
- **Nobody asserts a literal they did not measure the same day.** The catalog
  moved while this document was being written; treat every literal here the way
  you treat migration numbers.

**Known red, not yours:** the voice lane's sweep is mid-flight — as of this
writing `packages/cli` has 12 failures (`catalog-exhaustiveness.test.ts` still
asserts 110/108/109; the conformance-manifest digest cross-check disagrees)
while `w1-amendment.test.ts` and `discovery-availability.test.ts` are already at
111 and green. If you see these reds, they belong to
`task_1785455843956_v7p4zpymk`, not to you and not to each other. Do not "fix"
them in your lane.

**Baseline reds you will also see (pre-existing, measured, not yours):**
`db/test` suite: 17/61 fail, all in the `post_message` family (019 revoked it
from `tm8_app`; the suite is stale). Proven identical with and without 052.
Before your own gate runs, re-measure this baseline on your machine and compare
failure **names**, not counts.

## 3. File ownership — who edits what, and what everyone else does instead

The collision model: TypeScript files merge textually (parallel edits to
*different lines* coexist), but **shared SQL objects and count literals do
not** — the later writer silently wins. Hence: SQL shared objects live in 052
(done); TS files below are append-only per lane, each lane touching only its own
kind's lines.

| file | owner(s) | rule for everyone else |
|---|---|---|
| `db/migrations/052_edge_guard_multi_kind.sql` | foundation (landed) | read-only forever; see §1 hazards |
| `packages/contract/src/catalog.ts` | **artifacts** (+6 rows) — and the voice lane is in it now | memories/worktrees: do not touch. Artifacts: append before the closing `] as const`, re-count at write time |
| `packages/contract/src/contract.ts` | all three, append-only | each lane adds ONLY its own union member + `EntityState`/`EntityContent` variants; never reflow or reorder another lane's lines; `MenuKindRef` exclusion decision is per-lane and explicit |
| `packages/contract/src/schemas.ts` | all three, append-only | same rule; DTOs are `.strict()` — a misnamed field is a 400, not a merge conflict |
| `packages/server/src/facade/entity-read.ts` | all three, append-only | add your kind's `case` arms to **every** switch you need (titleOf, stateOf, contentOf, …) + your `left join`; the parity test fails you if the projector twin is missing |
| `packages/server/src/events/projector.ts` | all three, append-only | your kind's arms in `SUMMARY_SQL` joins, `SummaryRow`, `titleOf`/`excerptOf`/`stateOf` — in the SAME change as the contract entry (see §4) |
| `packages/server/src/facade/services/w2/entities-commands-tracking.ts` | memories + worktrees (create/patch dispatch arms for their doors) | artifacts routes its six ops through its own handlers; if it must touch this file, its arms only |
| `tools/conformance/src/foundations/kind-dispositions.ts` | all three | add your own row; it is typed over `CoreEntityKind`, so tsc fails until you do — that failure is the reminder, not an obstacle |
| `tools/conformance/generated/w1-conformance-manifest.json` | **artifacts** (regeneration forced by its catalog rows) | memories/worktrees: never regenerate — your changes don't move the digest (verified, V7) |
| `packages/server/test/events/projector-entity-read-parity.test.ts` | foundation (landed) | do NOT add your kind to `FROZEN_LEGACY_ENTITY_READ_GAP` or `IN_FLIGHT_KINDS`; ship both arms instead. Only the voice lane removes its own `IN_FLIGHT_KINDS` entry |
| `db/migrations/<your-number>_*.sql` | one per lane | purely additive: kind seed, detail table(s), triggers, RLS + grants (with full argument signatures — nothing is inherited), doors, `entity_content()` arm. No shared-object re-declarations |

## 4. The atomicity rule (one change per kind, or the projector lane dies)

Adding a core kind to SQL without its TypeScript twin is not a lint warning —
`EntityKindDriftError` (`packages/server/src/events/projector.ts`) is a fatal
runtime error in the projector lane. And the kind seed is a **one-way door**:
`entity_kinds_guard_core` (005) blocks update/delete of core rows. Each lane
therefore lands, in ONE change:

1. the `entity_kinds` seed row (SQL);
2. the `CoreEntityKind` union member (`contract.ts`) + `EntityState`/`EntityContent` variants;
3. the `kind-dispositions.ts` row;
4. the `entity-read.ts` arms AND the `projector.ts` arms (the parity test
   enforces the pair);
5. the `internal.entity_content()` arm (V3: omitting it returns `{}` silently,
   forever);
6. if versioned: a detail table with columns literally named `entity_id` and
   `updated_at`, the `snapshot_entity_version` trigger, and
   `record_initial_version` in the create door (V5: precedent is 021, not 015).

None of this is seeded by 052, deliberately: the kinds await user ratification
(one-way door), and splitting seed from contract entry is exactly the
projector-killing configuration.

## 5. What the verification refuted, and which design sections it breaks

| finding | verdict | breaks | required change |
|---|---|---|---|
| V4: append-only edge/revision triggers block the FK purge cascade (`23514` observed as owner) | **REFUTED** ("cascade fires as table owner, still works") | **Artifacts §5.1** revisions-trigger note; **Memories D2** edges trigger. Reach is bigger than purge: `spaces → entities → edges` cascades exist **today**, so space deletion breaks too | both triggers need an explicit cascade/purge exemption (e.g. `pg_trigger_depth() > 0`, or a purge-door writer claim) + a red/green pair: cascade-succeeds AND direct-delete-refused |
| V5: project entities DO have an initial version row (021:159) | half refuted | worktrees memo W2 / design's F1 restatement ("no entity_versions rows at all") | cite 021 as the projection precedent; the lane's own trigger+initial-version plan is unchanged |
| V1: the debounce also renumbers the **creation** snapshot | verified, stronger | memories `basisMoved` derivations that walk `entity_versions` history; worktrees §2.4 | design for versions 1..N-1 having possibly NO snapshot rows; `pinnedVersion < entities.version` comparisons stay safe |
| V6: the live parity gap is inverted (entity-read misses spell/skill/pull_request/commit; projector covers all) | confirmed, direction corrected | nothing structural in the three designs | parity test landed; ship both arms per §4 |
| V7: conformance manifest snapshots NO function bodies | refuted (favorably) | removes the unbudgeted-regeneration worry for the guard swap | only catalog changes force regeneration (artifacts, voice) |
| catalog at 111 and moving; voice lane mid-sweep red in `packages/cli` | new fact | worktrees G5 literal; artifacts 110→116 table; memories "against 106" framing | delta-based gates (§2) |
| `db/test` 17/61 pre-existing reds (`post_message` revoked in 019, suite stale) | new fact | any lane's gate that runs the db suite and expects green | compare failure *names* against the baseline in the verification doc |

## 6. Not decided here, deliberately

- User ratification of (a) three new **core** kinds as one-way doors and (b) the
  artifacts preview residual risk (iframe cannot hard-limit CPU/memory/egress) +
  second origin/listener. No lane blocks on scope in this document, but **no
  lane seeds its kind before (a) is ratified.**
- The voice lane's own numbering, sweep completion, and parity arms — flagged to
  its owner; its `IN_FLIGHT_KINDS` entry in the parity test is its to remove.
