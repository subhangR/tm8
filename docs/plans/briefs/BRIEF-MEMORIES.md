# BRIEF — Memories: complete the design and implementation plan

You own **one** feature: first-class **memory** entities in tm8. Two sibling workers own
worktrees and artifacts; you will need to talk to them (see §7).

## 0. Provenance of this brief — read this first

Everything in §3–§5 was **recovered from a prior session's transcript**, not from an approved
document. On 2026-07-30, session `sess_1785384914507_11izemwxh` did a deep read-only analysis and
reported its conclusions as chat messages. It **wrote nothing to disk**. Those conclusions were
recovered on 2026-07-31 and digested into `docs/plans/TM8-NEW-ENTITIES-SESSION-DIGEST.md`.

Treat §3–§5 as **a strong prior from a competent reader, not as settled fact**. The user has not
ratified it. Where it conflicts with the current tree, **the tree wins** — and say so in your
deliverable. Where you think it is wrong, say that too; you are not here to rubber-stamp it.

## 1. Your mission

Produce a **complete design and a phased implementation plan** for memories, ready for an
implementer to build from without making schema-level decisions in code.

You are **design-only**. Do not modify product source, do not run migrations, do not commit.
The working tree is dirty with other people's in-flight work — leave it alone. Writing your own
new documents under `docs/plans/` is expected and fine.

## 2. Read before you write

Existing design docs, in dependency order:

- `docs/plans/TM8-MEMORY-STALENESS-DESIGN-BRIEF.md`
- `docs/plans/TM8-MEMORY-AND-STALENESS-DESIGN.md` — the main design
- `docs/plans/TM8-MEMORY-STALENESS-API-CLI-DESIGN.md` — wire and CLI surface
- `docs/plans/reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md` — adversarial review
- `docs/plans/TM8-NEW-ENTITIES-SESSION-DIGEST.md` — the recovery digest; §2 and §5 are yours

Architecture context:

- `docs/tm8-architecture/03-ENTITY-GRAPH-DELTAS.md`
- `docs/tm8-architecture/01-LAWS.md`, `05-DECISIONS.md`

Current tree, to verify against:

- `packages/contract/src/catalog.ts`, `packages/contract/src/schemas.ts`
- `db/migrations/` — read the tail of the chain
- `packages/server/src/facade/entity-read.ts`
- wherever `PullState.contentStale` is derived — this is the shipped precedent for pinned-version
  drift and your closest working analogue

## 3. The model as previously reasoned

A memory is a typed entity, not the legacy `team_members.memories` JSON blob.

Required shape: `statement` (what is claimed), `mechanism` (how it was learned), `subjectScope`
(where it applies), `doesNotEstablish` (the nearby conclusion a reader must NOT infer), and
optional `measuredAt` (when an instantaneous measurement was taken).

Scope travels in the typed `EntityState`; the full statement travels in `EntityContent`. This is
deliberate: it prevents a value from being copied while its caveat stays behind.

Edges: `based_on` (version-pinned epistemic basis), `copy_of` (restatement, version-pinned),
`supersedes`, `disputes`, `verifies`, `remembers` (actor/session owns memory), `in_worktree`,
`authored_from` (memory to producing work session).

**Staleness is derived, never stored.** Computed from graph facts:

- `superseded` — an inbound `supersedes` edge exists
- `disputed` — an inbound dispute has no later valid verification answering it
- `basisMoved` — a pinned `based_on` or `copy_of` target advanced past the pin, or the immediate
  basis became suspect or superseded
- `verified` — a verification answers the open disputes and is pinned to the target current version

Display precedence is `superseded` then `disputed` then `basisMoved`; the payload keeps all
applicable reasons. One hop on hot reads; deeper propagation belongs to an offline sweep.

The rationale matters more than the rule: a stored status becomes another stale copy. Append-only
evidence edges retain who said what, why, and when; a correction is another fact in the graph
rather than an overwrite of history.

Absence of marks must read as **unflagged**, never as **verified** or **current** — otherwise an
entity nobody examined acquires false authority.

The asymmetry is intentional. Disputing is cheap: evidence plus one edge. Verification is
expensive: fresh evidence, a mechanism, named answered disputes, the target current version, and
an independent reader or context. Editing a verified target bumps its version and invalidates the
verification. Materially wrong memories are superseded, never silently edited.

An honest limit the prior design already admits: a mis-scoped but factually true claim cannot be
detected as stale. Required scope and `doesNotEstablish` reduce that failure mode; they do not
solve it. Keep that admission in your document.

## 4. Six decisions you must resolve — these block Phase 1

The prior session stopped here, on the grounds that if these are not settled in the spec, an
implementer settles them implicitly in code. Resolve each with a recommendation and a rationale.

1. **Split `about` from `based_on`.** One edge cannot mean both "this memory is about X" (subject
   routing, context inclusion) and "this conclusion epistemically depends on X" (version-pinned).
   The prior recommendation is a separate `about` edge, leaving `based_on` purely epistemic.
   (Note: this decision was itself nearly lost — the two words `about` and `based_on` were eaten by
   shell mangling in the original handoff and had to be re-sent as a correction.)
2. **Scope append-only precisely.** `disputes`, `verifies`, `supersedes`, `based_on`, `copy_of`
   should be append-only. `remembers` and `in_worktree` are mutable associations that need
   correcting and must not become immutable by accident.
3. **Restrict verification evidence** to entity kinds with enforceable independent-session
   provenance. `authored_from` currently exists only for messages and would widen to memories.
   Files, docs, commits, and PRs carry no session origin, so independence is unenforceable for
   them. Proposed Phase-1 floor: allow `verifies` only from messages and memories.
4. **Define how memories reach a spawned agent.** This is the largest integration gap. The v1
   prompt path renders legacy persona memory; the **v2 bootstrap path explicitly omits memory**.
   Graph memories will not transfer to new agents at all until this exists. Define selection rules
   (reachable via `remembers`, `about`, assigned tasks, worktree association), how suspect and
   superseded memories are excluded or annotated, and how the selection survives spawn and
   worker-init **without bypassing prompt byte budgets**.
5. **Rebase onto the current tree** — see §5.
6. **Worktree lifecycle ownership** — who records merge/abandon, project identity, deletion
   semantics. Coordinate with the worktrees worker rather than deciding unilaterally.

## 5. Rebase facts — the existing docs are stale here

Verified against the working tree on 2026-07-31. **Re-verify; do not trust this table blindly.**

| The design docs assume | The tree actually has |
|---|---|
| catalog frozen at 101 operations | **110** |
| the next migration is 038 | the chain reaches **050**; 038 is long taken |
| edge `props_schema` validation must be added | already shipped in migration **018** |
| migration 038 must bind the `entities.patch` doors | actual 038 **already binds** them |
| the ledger forbids derived values in responses | ledger stores **raw** results and the facade rehydrates projections after replay, so derived staleness **may** appear in command responses; only persisting it **inside ledger JSON** is forbidden |

Also: no `memory`, `worktree`, or `artifact` kind exists anywhere in the contract today.

The dirty tree carries an in-flight generic **attention-request** system (migration 050). Do not
treat it as shipped. The prior conclusion, which you should test rather than assume: attention is
workflow prioritization only and must **never** be staleness authority — it is mutable, bulk
resolvable, and carries neither pinned evidence nor independent verification.

## 6. Implementation shape as previously sketched

Offered as a starting point; improve it.

Implementation can stay **zero-new-catalog-operation** by going through the generic
`entities`/`edges` doors, with four specialized doors: `create_memory`, `update_memory`,
`create_worktree`, `update_worktree` — each with replay-principal/resource binding and explicit
`22023` pre-validation.

Rough phasing: reconcile the model before writing DDL; land storage and contract variants together
(both core kinds, detail tables, constraints, **snapshot triggers**, content-dispatch branches,
edge registry rows and property schemas, append-only row trigger, semantic verification triggers);
complete facade projection in `entity-read.ts` using a **fixed number of batched queries** (mark
edges, pinned-target versions, bounded supersession-head resolution — this is not merely a
filter-list change); then agent delivery; then CLI sugar on top of the generic floor, documenting
which operations are composed and non-atomic; then sweeps and legacy-blob migration last.

One trap worth restating: **snapshot triggers are per-table opt-in**. If the new detail tables do
not get them, version advancement silently does not happen and pin drift never fires.

Gates named previously: version-bump mutation tests, delete/patch/upsert append-only refusals,
verification independence, supersession cycles and depth bounds, replay-resource isolation on all
four doors, missing-scope error mapping, atomic initial pins, cross-space refusal, badge
derivation, command-replay freshness, and v1/v2 prompt-delivery parity.

## 7. Coordination

Siblings, spawned with you:

- **worktrees** worker — memories pin worktrees via `based_on`, and worktree lifecycle transitions
  are what make those pins drift. Decision 6 is jointly owned. Agree on the worktree entity shape
  and on who writes lifecycle transitions before either of you freezes a schema.
- **artifacts** worker — lighter overlap; artifact provenance and memory provenance should not
  invent two different vocabularies for the same facts.

Use `maestro session siblings` to find them and `maestro session prompt <id> --message "..."` to
talk. **Prose sent that way gets mangled by the shell**: backticks execute, and an apostrophe
truncates the message and runs the remainder as commands. The CLI prints a success checkmark
either way, and the recipient has no original to compare against. Avoid backticks and apostrophes
in messages entirely, or write to a file and tell them the path.

## 8. Deliverable

Write to `docs/plans/TM8-MEMORY-DESIGN-FINAL.md` (or amend the existing design docs in place and
say clearly which you did). It must contain:

1. The resolved model — entity shape, edge set with append-only status per edge, derivation rules.
2. **A decision record for all six blocking decisions**, each with the option taken, the rejected
   alternatives, and why.
3. Physical schema: tables, constraints, triggers, edge registry rows, property schemas.
4. Contract and facade changes, stated against the **current** catalog and migration numbers.
5. The agent-delivery design for v2 bootstrap, including byte-budget handling.
6. A phased implementation plan with explicit gates and a test matrix per phase.
7. An honest **open questions / residual risk** section. If something cannot be enforced, say so
   plainly rather than designing around the gap in silence.

Report milestones with `maestro task report progress <taskId> "..."` and finish with
`maestro task report complete <taskId> "..."`.
