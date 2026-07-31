# BRIEF — Foundation: land the shared seam for memories, worktrees and artifacts

You are the **foundation worker**. Three feature workers (memories, worktrees, artifacts) are
queued behind you. They cannot start until you finish, because all three need to modify the same
handful of files and the collision is silent.

Your job is **not** to implement any of the three features. It is to land the shared seam, prove
the shaky premises, and hand the three lanes a build order they can follow in parallel without
destroying each other.

## 0. Read first

- `docs/plans/TM8-NEW-ENTITIES-SESSION-DIGEST.md` — what the three features are
- `docs/plans/TM8-MEMORY-DESIGN-FINAL.md` (1230 ln)
- `docs/plans/TM8-WORKTREE-DESIGN.md` (1066 ln)
- `docs/plans/TM8-ARTIFACTS-DESIGN.md` (1473 ln)
- `docs/plans/MEMO-MEMORY-SEAM-QUESTIONS.md`, `docs/plans/MEMO-WORKTREE-SEAM-ANSWERS.md`

**All three designs were written without executing anything.** Every runtime claim in them is a
read of source. That is precisely why your first task is verification.

Line numbers in those docs were taken on 2026-07-31 against a dirty tree. **Treat them as hints,
not addresses.** Several are already known to have drifted.

## 1. Scope — what you own, and what you must NOT touch

**You own:**

1. The verification pass (§2).
2. The shared edge-guard migration (§3).
3. The catalog-count reconciliation (§4).
4. The `entity-read.ts` / `projector.ts` parity test that does not exist (§5).
5. The build-order and file-ownership manifest the three lanes will follow (§6).

**You must NOT:**

- Add any of the three new entity kinds (`memory`, `worktree`, `artifact`) to the contract or seed
  them in SQL. Each kind is a **one-way door** — `entity_kinds_guard_core` in
  `db/migrations/005_custom_kinds.sql` blocks update and delete of core rows — and the kind seed
  must land **atomically** with its contract entry or `EntityKindDriftError`
  (`packages/server/src/events/projector.ts`) takes down the projector lane. That atomicity is why
  each feature lane owns its own kind, not you. This is also awaiting explicit user ratification.
- Create detail tables, RPC doors, or any feature code.
- Commit anything. The tree has ~200 uncommitted files from other people's in-flight work.
  **Leave all of it alone.** Verify with `git status --short` before and after; if your diff
  touches a file you did not intend, stop and report.

## 2. Verification pass — do this BEFORE writing any SQL

Every one of these is a claim that at least one design depends on structurally. Prove or disprove
each **against a live database**, and write the result down with the command you ran and its
output. Where a claim is about a *silent failure*, the test only counts if you observe the **red**
case — an assertion that passes against an empty result is worse than no assertion.

The dev Postgres sidecar is on port **5442**. Its documented start command is known to fail on a
PG18 locale refusal, and `pg_isready` reports OK while auth is still failing — so confirm you can
actually run a query before trusting that the DB is up. There are two clusters on this machine and
a bare `psql` hits the wrong one. See `HOW-TO-TEST.md` and
`docs/plans/` for the working invocation, and report the one that worked.

**V1 — The snapshot debounce overwrites history.**
`db/migrations/001_core_graph.sql` around 1127–1176. Claim: a second write by the same actor
inside `internal.version_debounce_window()` (5 minutes) **UPDATEs** the existing `entity_versions`
row — renumbering it to the new version and overwriting the snapshot — while `entities.version`
still advances. Consequence: a pinned version can exist as an integer with **no snapshot row
behind it**. Memories' entire `basisMoved` derivation and worktrees' normal
`active -> merged -> deleted` cleanup path both run straight through this.
Prove it: two writes inside the window, then show `entities.version` and the `entity_versions`
rows. Also determine whether the 5-minute window is configurable per kind — worktrees flagged that
as unverified and its §2.4 consequence changes if it is.

**V2 — `authored_from` has three gates, not one.**
`db/migrations/015_w1_foundations.sql` around 615–633 and the unique index around 295–296.
Claim: widening `edge_types.src_kinds` is **not sufficient**. There is (a) a writer-ownership
equality that raises `42501` unless the writer is `message_recorder`, (b) a unique index allowing
one `authored_from` per source, (c) `props.origin` force-stamped, where sending `origin` yourself
also raises `42501`. This was missed by two design docs and an adversarial review that ran ~40
checks, all of which had read the declarative surface. Prove all three fire.

**V3 — `internal.entity_content()` falls through to `{}` silently.**
Omit a kind branch and confirm content comes back `{}` with **nothing raised**. See the
codebase's own warning in `db/migrations/011_entity_content_missing_kinds.sql`.

**V4 — The append-only trigger vs. the entity purge cascade.**
Memories plans a `before update or delete` trigger on `public.edges` raising `42501`. The claim is
that `on delete cascade` from `entities` still works "because the cascade fires as the table owner
rather than `tm8_app`". If that is wrong, **entity purge breaks at its last step** and you find out
in production. Prove the cascade succeeds through such a trigger.

**V5 — Snapshot triggers are per-table opt-in, and 015 attaches none.**
Claim: `snapshot_entity_version` is attached to exactly **11** detail tables, and
`015_w1_foundations.sql` attaches zero and never calls `record_initial_version`, so `project`
entities have **no `entity_versions` rows at all**. Confirm the count and the project-entity
consequence.

**V6 — The `entity-read.ts` / `projector.ts` parity gap.**
Claim: every kind-dispatch site in `entity-read.ts` has a twin in `projector.ts`
(`SUMMARY_SQL`, joins, `SummaryRow`, `titleOf`, `excerptOf`, `stateOf`), parity is asserted **only
in prose comments**, and **no test enforces it**. Miss the projector arm and an entity renders fine
over REST but is untitled in the event feed. Confirm the gap exists.

**V7 — Whether `tools/conformance/generated/w1-conformance-manifest.json` snapshots function
bodies.** If it does, replacing `guard_w1_edge` requires a manifest regeneration that no design
currently budgets for.

Report V1–V7 results before proceeding. If any comes back different from the design's claim, say
so loudly — a wrong premise here silently invalidates part of a feature design.

## 3. The shared edge-guard migration — the reason you exist

`internal.guard_w1_edge` (`db/migrations/015_w1_foundations.sql`, roughly lines 592–703, ~112
lines, trigger `edges_w1_guard` just after) is needed by all three features.
`create or replace function` **swaps the entire body**. Two migrations that both replace it do not
error — the **lexically later filename silently wins** and the earlier feature's branch vanishes.
The same hazard applies to `edge_types.src_kinds` array rewrites.

So exactly one migration, owned by you, does all of it.

**Registry changes (outside the function):**

- `authored_from.src_kinds` widened to include `memory` and `artifact`
- `in_project.src_kinds` += `artifact`
- `attached_to.src_kinds` += `artifact`, `memory`
- `authored_from.description` made kind-neutral (it currently says "message")
- Rename the index currently named for messages to something kind-neutral.
  **Rename only — do not drop or widen the UNIQUE constraint.** All three lanes depend on
  one-`authored_from`-per-source remaining true.

**Function body — replaced exactly once, two branches:**

1. **Recorder-ownership branch.** The single equality against `'message_recorder'` becomes a
   **per-type permitted-writer set**: `authored_from` accepts
   `{message_recorder, memory_recorder, artifact_publisher}`. `in_worktree` deliberately stays
   **out** of this branch, so it remains an ordinarily mutable association.
2. **`props.origin` stamping branch.** `in_worktree` **joins** the existing
   `('in_project','participates_in')` list — one array element, and the whole of the worktrees
   lane's ask on this file.

Writer tokens, already agreed non-colliding across the three lanes:
`memory_recorder`, `worktree_manager`, `artifact_publisher`.

**Two things must be written as SQL comments inside the migration itself**, not only in a design
doc: a header declaring the file a shared prerequisite owned by no single feature and naming its
three dependents; and the reason `in_worktree` is absent from the recorder-owned set.

**Flag, do not silently fix:** there is an `UPDATE`-path allowlist for *changing* `props.origin`
that contains none of the three new tokens. Harmless today (all three write `authored_from` once
and never update it) but any future correction path will fail `42501`. Note it in the file and in
your manifest.

**Numbering — read this carefully.** The three designs allocated 051 (shared), 052, 053, 054.
**That allocation is already stale.** `db/migrations/051_profile_selects_content_surface.sql` was
written by a different session at 04:37 on 2026-07-31, while the designs were being written. It is
untracked, so `git log` shows the chain ending at 047 while the tree is four ahead — migrations
048, 049, 050 and 051 are all present and uncommitted.

Therefore: **re-check the directory immediately before you write, and claim the next free number at
write time.** Do not reserve a number in advance; that is exactly the mistake that produced this
situation. Applied migrations are immutable and ordering is lexical, so a collision is expensive.
Whatever number you take, record it in the manifest so the three lanes number themselves after it.

Recommend a CI check for duplicate `create or replace function internal.<name>` across the chain —
the current resolution rests on an unenforced convention, and this class of bug has no error
message.

## 4. Reconcile the catalog count — the three lanes disagree

They cannot all be right:

- **memories** says zero new operations, and insists the baseline is **106 committed**, because the
  110 in the working tree includes four in-flight `attentionRequests.*` ops that its own brief said
  not to treat as shipped.
- **worktrees** says zero new operations and states the catalog "is at **110** (VERIFIED)", with a
  gate asserting it stays 110.
- **artifacts** adds **6** new operations and computes 110 → 116, with histogram deltas
  (`POST +5, GET +1`, `command +4, read +2`).

Three test files assert the literal count. `CATALOG_DIGEST` is a sha256 over the operations array,
so any change forces regeneration of the conformance manifest, and one design counted a sweep of
~11 files carrying the number.

Decide the correct baseline, state whether the attentionRequests ops are in or out, compute what
each lane's gate should assert **after** artifacts lands its 6, and write it down. Do not change
the catalog yourself — just remove the ambiguity so three lanes do not each assert a different
number and turn the test suite red for reasons nobody can attribute.

## 5. Close the parity gap

If V6 confirms it, add the missing test that asserts every kind handled in `entity-read.ts` is also
handled in `projector.ts`. This is shared infrastructure: without it, all three lanes can ship a
kind that renders over REST and is untitled in the event feed, and nothing catches it. A test that
enumerates the kinds and fails on asymmetry is worth more than three lanes each remembering.

## 6. Deliverable

1. **`docs/plans/TM8-FOUNDATION-VERIFICATION.md`** — V1 through V7, each with the command run, the
   observed output, and VERIFIED / REFUTED / INCONCLUSIVE. Refuted claims must name which design
   section they invalidate.
2. **The shared migration**, at the number you claimed at write time.
3. **The parity test**, if V6 confirms the gap.
4. **`docs/plans/TM8-BUILD-ORDER-AND-OWNERSHIP.md`** — the manifest the three lanes follow:
   - the migration number you took, and the numbers the three lanes should claim after it (with the
     instruction to re-check at write time, not to reserve)
   - the resolved catalog baseline and what each lane's gate asserts
   - **file ownership**: for every file more than one lane needs, who owns it and what the others
     must do instead. At minimum: `packages/contract/src/catalog.ts`,
     `packages/contract/src/contract.ts`, `packages/contract/src/schemas.ts`,
     `packages/server/src/facade/entity-read.ts`, `packages/server/src/events/projector.ts`,
     `packages/server/src/facade/services/w2/entities-commands-tracking.ts`,
     `tools/conformance/src/foundations/kind-dispositions.ts`
   - the atomicity rule each lane must follow for its kind (SQL seed + contract entry +
     kind-dispositions row + TS dispatch cases in one change, or the projector lane dies)
   - anything V1–V7 refuted, and which design section it breaks

Report progress with `maestro task report progress <taskId> "..."` and finish with
`maestro task report complete <taskId> "..."`.

**A note on messaging siblings:** prose sent via `maestro session prompt --message` gets mangled by
the shell — backticks execute and an apostrophe truncates the message and runs the remainder as
commands, while the CLI prints a success checkmark either way. Avoid both characters, or write to
a file and send the path.

## 7. Two decisions are with the user, and you are not blocked on them

For visibility, not action: the user still has to ratify (a) that adding three new **core** entity
kinds is a one-way door, and (b) the artifacts residual risk — a browser iframe cannot enforce hard
CPU/memory limits or perfect egress containment — plus running a second origin and listener. None
of your scope depends on either. Do not wait, and do not decide them.
