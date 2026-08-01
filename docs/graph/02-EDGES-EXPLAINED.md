# What the edges are, in plain words

An **edge** is a labelled arrow between two things. "This task is assigned to
Priya." "This session is working on that task." The label is the edge *type*.

They all live in one table. Each row is: which space, arrow start, arrow end, the
type, and a small bag of extra properties.

Two rules worth knowing up front:

- **Arrows point one way.** There is no reverse copy. "Tasks assigned to Priya" is
  just the same arrows read backwards.
- **Parent/child is not an edge.** A doc inside a doc, a task inside a task — that
  lives in a `parent_id` column, on purpose. And it only ever links things of the
  *same* kind. Which means **anything connecting two different kinds has to be an
  edge**, or it isn't in the graph at all.

There are **33** types registered. **10** are in use.

---

## In use today

| Type | Reads as | Count |
|---|---|---:|
| `anchored_to` | this message hangs on that task / channel / session | 175 |
| `participates_in` | this teammate is running that session | 154 |
| `relates_to` | these two things are related somehow (the catch-all) | 154 |
| `in_project` | this belongs to that project | 139 |
| `working_on` | this session (or person) is working on that task | 116 |
| `completed_by` | this task was finished by that person | 20 |
| `selected_profile` | this session is using that interaction profile | 14 |
| `attached_to` | this doc / file is attached to that thing, as context | 13 |
| `tracks` | this task tracks that pull request or commit | 2 |
| `supersedes` | this memory replaces that older one | 1 |

Two notes on this list.

**`relates_to` is being misused.** All 154 of them are a session pointing at its
teammate — written at session startup. But `participates_in` is the correct type
for exactly that, and it points the right way round. So the same fact is stored
twice, once in a vague type and once in a precise one. The vague ones should
eventually go.

**`working_on` is 38 short.** 154 sessions were started with a task, but only 116
have the edge. Worth a look.

---

## Registered but never used

These are the interesting ones — someone designed each of them and they've never
held a single row. Grouped by why.

### Blocked on session provenance

| Type | Reads as |
|---|---|
| `authored_from` | this message / memory / artifact was written in that session |
| `messaged` | this session addressed that session |
| `shared_into` | this thing was handed into that session |

`authored_from` and `messaged` are both waiting on the same missing connection —
see **6. How a session's identity travels** (`019fbbe2-1faf-7696-8cdc-bba4e814f988`). `shared_into` maps exactly
onto the session handoff table, which is currently empty, so there's nothing to
project yet.

### Features that were never finished

| Type | Reads as |
|---|---|
| `assigned_to` | this task is assigned to that person |
| `depends_on` | this can't proceed until that is done |
| `contains` | this collection contains that thing |
| `pulled` | this person pulled that thing into their local work |
| `equips` | this task / teammate / session has that spell or skill available |
| `member_of` | this teammate also belongs to that team |
| `in_worktree` | this belongs to that git worktree |
| `defaults_to_profile` | new sessions for this teammate default to that profile |

`assigned_to` is the striking one: tasks have **no assignee column at all**, so the
edge *is* the assignment mechanism — and it has zero rows. Task assignment simply
doesn't exist yet.

`depends_on` is the most valuable unbuilt one. It's designed to work between *any*
two things, with a "ready to work" query built on top of it.

### Deliberately dormant

| Type | Reads as |
|---|---|
| `visible_to` | this is visible to that person |
| `approval_requested_from` / `approved_by` | approval workflow |

Registered ahead of the features that will use them. Marked inert in the design.

### Memory bookkeeping

| Type | Reads as |
|---|---|
| `about` | this memory is about that thing |
| `based_on` | this memory rests on that as evidence, pinned to a version |
| `disputes` | this contradicts that, with a quote |
| `verifies` | this independently confirms that |
| `remembers` | this person / session holds that memory |

`about` looks like an easy win and isn't. The "what is this memory about" field
holds **prose**, not an entity reference — things like *"The tm8 CLI as of
2026-07-31, for every command."* Nothing in there names an id. Working these out
would need language understanding, not a query, so it is **not** something to put
in a trigger. Genuine judgement calls have to stay judgement calls.

`verifies` has a nice property worth knowing: the rule "your evidence must come
from a *different* session than the claim" is **already written and enforced in the
database**. It just can't bite, because no edge records which session anything came
from. Fixing session provenance turns a toothless rule into a real one.

### Housekeeping

| Type | Reads as |
|---|---|
| `copy_of` | this was copied from that |
| `likes` / `dislikes` / `stars` | reactions |

---

## The `origin` tag

Some edges carry an `origin` property saying who wrote them. It's set by the
database, never by the caller — try to set it yourself and you get refused.

| Value | Meaning |
|---|---|
| `spawn` | written when a session started |
| `backfill` | filled in after the fact by a repair pass |
| `materialized` | projected from another source of truth |
| `anchor_recorder` | derived from a message's anchor (new in 065) |
| `delivery_recorder` | derived from a session delivery (new in 065) |
| *(missing)* | written before origin tagging covered this type |

There's a real distinction underneath these, and it's a good one:

- Some derived edges are **facts about history** and can never be edited —
  "written in session X" either happened or didn't.
- Others are **filing decisions** and must stay correctable — which project
  something belongs to is a choice, and freezing a mistake would be worse than
  allowing an edit.

The code comment explaining this is worth quoting, because it's the reasoning that
should guide any new derived edge: *"putting it here would freeze filing errors
into permanent facts."*

Two types are **not** tagged and should be: `working_on` and `relates_to`, both
written at session startup. See **10. Next steps** (`019fbbe2-211d-7893-b962-443f637c6153`) for why that's
still open.
