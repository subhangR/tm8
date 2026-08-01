# Entity Graph: derived edges

## What this is about

tm8 already knows a great deal about how things connect. Most of that knowledge is
locked inside table columns, where the graph cannot see it.

A **derived edge** copies one of those connections into the graph automatically, so
you can walk to it. The goal: **every connection we can be certain about should
become an edge by itself, with nobody remembering to do it.**

These docs cover what we found, what we fixed, and what is left.

## The docs

**Start here if you want the idea**

1. **What a derived edge is** — the concept, an example, and the rule for what may
   and may not be derived automatically.
2. **The edges we have, in plain words** — all 33 types, what each one means, which
   are actually used and which have never been written to.

**What we actually fixed**

3. **Fix 1 — messages were invisible** — 175 messages, none in the graph. A channel
   answered "1 node, 0 edges". Now 15 and 14.
4. **Fix 2 — sessions had no teammate link** — 152 sessions, 1 link. The correct
   code already existed and nobody was calling it.
5. **Fix 3 — the one that came out empty** — backfilled zero rows, and why that is
   the finding rather than a bug.

**The bigger problem underneath**

6. **How a session's identity travels** — why "which session made this?" cannot be
   answered today. Seven breaks in one chain, and a root cause that is really about
   agent identity. This is the largest piece of work remaining.

**How it was done and how we know it holds**

7. **How we checked it worked** — six steps, and the specific silent failure each
   one catches.
8. **What we got wrong along the way** — three claims that were wrong when measured,
   including two of my own, plus two process hazards that bit.
9. **How to add a derived edge** — the recipe, if you are adding one.

**What is next**

10. **Next steps** — in order, with sizes. Nothing speculative.

## What changed, in numbers

Measured on the live database, before and after migration 065:

| | Before | After |
|---|---:|---:|
| Edge types registered | 31 | 33 |
| Edge types actually used | 9 | 10 |
| Total edges | 454 | 788 |
| Messages visible in the graph | 0 | **175 of 175** |
| Sessions linked to their teammate | 1 | **154** |

## The one rule that shaped all of it

**Backfill what exists, and add a trigger so the future looks after itself.** Do
both, or neither.

A backfill on its own starts going out of date on the very next write, and a
half-full edge type is worse than an empty one — it reads like an answer. That is
not hypothetical: it is exactly what had happened to the teammate link, which sat
at 1 row for months looking like a working feature.

## Two things we chose not to do

**We did not label the session's own edges as machine-written.** It was on the
plan. Building it revealed it would have labelled every machine-written edge as
`user`, because the label comes from a claim the startup code never makes. A wrong
label is worse than a missing one. See doc 8; the one-line fix is in doc 10.

**We did not make "which session created this" work.** The participant backfill was
supposed to unblock it and does not. See doc 6.

## Where the source lives

The same text is in the repo under `docs/graph/`, which is the copy to edit. The
migration is `db/migrations/065_derived_edges_phase1.sql`. The long, evidence-heavy
investigation behind all of it is `docs/plans/TM8-DERIVED-EDGES-ANALYSIS.md`.

This root doc is attached to the task `Entity Graph derived edges`; the ten docs
above are its children.
