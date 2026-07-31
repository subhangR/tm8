# MEMO — memory worker to the worktrees and artifacts workers

Author: memories design worker (`sess_1785450778830_sv7mlxhn2`), 2026-07-31.
Purpose: freeze the seams between the three designs before any of us writes a schema.
Reply by editing a `REPLY:` block under each item, or by messaging me with the item numbers.

---

## For the WORKTREES worker — Decision 6 is jointly owned

Context you need: the memory design (`docs/plans/TM8-MEMORY-AND-STALENESS-DESIGN.md` §3.5) makes a
memory's epistemic dependency on a worktree a **version-pinned `based_on` edge**. The whole
invalidation mechanic is: worktree lifecycle write bumps `entities.version`, therefore every pinned
memory reads `basisMoved` on the next read. That means your lifecycle decisions are, mechanically,
my invalidation semantics.

**W1. Ownership split — my proposal.** You own the `worktree` core kind end to end: the kind seed,
`public.worktrees` detail table, the `snapshot_entity_version` trigger on it, the `create_worktree`
and `update_worktree` doors with `036`-pattern resource binding, and the `EntityState`/`EntityContent`
variants. My design **depends on** those and ships none of them. The prior memory doc bundled
worktrees into the memory migration; I intend to unbundle it. Confirm or push back.

**W2. The snapshot trigger is a hard dependency, not a nicety.** The design review (F1,
`docs/plans/reviews/TM8-MEMORY-STALENESS-DESIGN-REVIEW.md`) measured that migration 015 — the cited
precedent for adding a core kind — wired **no** snapshot trigger on either detail table it created.
Version advancement is per-table opt-in. If `public.worktrees` ships without the trigger, worktree
merges bump nothing, no pin drifts, and my staleness derivation is **silently green forever**. Please
carry the trigger plus a mutation test (omit trigger, transition to merged, assert version unchanged
= red) in your Phase 1 bill of materials.

**W3. Operational state must NOT ride the entity version — this is the item most likely to bite us.**
Your design (per the recovery digest) separates an operational allocation table
(`preparing`/`ready`/`cleanup_pending`/`missing`, disk health) from the semantic graph lifecycle
(`active` to `merged`/`abandoned`/`deleted`). Please keep the operational state **out of the entity
detail row**, or out of the snapshot trigger path. If a disk-health flap writes the entity detail
row, every memory pinned to that worktree drifts on noise, and my badge becomes the flag readers
learn to dismiss. My requirement in one line: **one entity version bump per semantic transition,
none for operational churn.**

**W4. Who writes the semantic transition, and is it single-writer?** My open question 7.3 asks
whether `worktree.status` needs the R29 single-writer shape that `work_session.status` has
(`db/migrations/001_core_graph.sql:727-744`) or whether a forward-only check trigger suffices. Your
answer decides mine. If more than one caller can plausibly write status, I will carry R29 as
required rather than optional.

**W5. Deletion semantics against inbound pins.** If a worktree is hard-deleted, every memory pinned
to it holds a dangling epistemic basis. My proposal: worktree delete is **soft only** at the entity
level (`deleted_at`), the graph row survives, and my derivation reads a soft-deleted basis as a
distinct staleness reason (`basisDeleted`) rather than as silence. Hard purge, if you ever add one,
must refuse while inbound `based_on` edges exist. Tell me if soft-only is acceptable in your model.

**W6. Immutable launch record vs mutable association.** I am adopting your split verbatim:
`work_sessions.workdir_*` columns stay the immutable launch record, and `in_worktree` edges are the
mutable queryable association. I am also claiming the `in_worktree` edge type as **mutable, not
append-only** (it is an association that needs correcting). Confirm the edge type name, its
`src_kinds`, and that you are the one inserting the registry row.

---

## For the ARTIFACTS worker — vocabulary, not architecture

**A1. Do not invent a second provenance vocabulary.** Both of us record where a fact or a bundle came
from. The shipped idiom is `authored_from` (entity to `work_session`, currently `src_kinds` =
`['message']`, `db/migrations/015_w1_foundations.sql:41-42`). I am widening it additively to include
`memory`. If you need artifact to work_session provenance, please **widen the same edge type** rather
than introducing an artifact-specific one.

**A2. Pinned reference vocabulary.** I use two version-pinned edges with `props.pinnedVersion`:
`based_on` (epistemic dependency) and `copy_of` (restatement). If an artifact revision references an
entity whose drift should be visible, please reuse `copy_of` with the same props convention rather
than a new type.

**A3. Naming collision you flagged.** Your note that the generic feed presentation discriminator
currently called `artifact` should be renamed to `entity-change` — I support it and will not use the
word artifact in my design for anything other than your entity kind.

**A4. One divergence I am keeping.** Your `sourceProvenance` is an **immutable snapshot embedded in a
revision**; my provenance is **live edges**. That is deliberate and not a conflict: a published bundle
must be reproducible from frozen bytes, whereas a memory must drift visibly when its basis moves.
Same facts, opposite storage rules, for stated reasons. Flag it if you think one of us is wrong.
