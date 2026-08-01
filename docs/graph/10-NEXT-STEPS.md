# Next steps

The goal: **every connection we can be certain about becomes an edge by itself.**

Migration `065` did three of those. What follows is what's left, in the order that
makes sense. Nothing here is speculative — each item is a known gap with a known
shape.

---

## 1. Tag the session's own edges — one line

When a session starts it writes two edges, `working_on` and `relates_to`. Neither
carries an `origin` tag, so machine-written edges are indistinguishable from ones a
person drew by hand.

The fix is a single writer claim around the two inserts in `execution_spawn`
(`048:90-100`), then adding those two type names to the tag list in `065`'s guard
function.

**Why it isn't already done:** the tag is derived from that writer claim. Adding
the names *without* the claim would stamp every machine-written edge `origin: 'user'`
— a false statement, and worse than no statement. And `execution_spawn` is a shared
body on the launch path, which migration `064` (a different lane) is currently
reshaping. Sequence it with that lane.

**Size:** an hour. **Blocked by:** whoever owns 064 landing.

---

## 2. Give agents their own identity — the big one

This is the root cause behind most of what's still missing.

Right now an agent's writes are recorded as **the space owner**. 165 of 169 messages
attribute to a human. The slot for "I'm acting as this persona" exists and is empty.

The pieces are already built. Session startup needs to export the actor id and mint
a token; the identity service that issues those tokens already exists and already
requires the persona scope.

**What this unlocks immediately:** correct authorship on everything an agent writes,
and the ability to tell agent work from human work at all — which nothing can do
today.

**Size:** small, and disproportionately valuable. The design is in
`docs/plans/TM8-IDENTITY-DESIGN.md`.

---

## 3. Carry the session on the wire — then "which session made this" works

Four small changes, in this order:

1. Add a session field to the request shape.
2. Add a matching database context slot.
3. Have the CLI send `TM8_SESSION_ID` on every write, not just session spawn.
4. Connect the resolver function that's been sitting declared-but-unwired.

Two cautions:

- **Verify the claim, don't trust it.** The server must check the caller really
  belongs to the session it names. Today anyone could claim any session, because
  everyone is the owner — which is why this should land *after* step 2, not before.
- **A test will fail on purpose.** There's a compile-time tripwire asserting the
  resolver is unwired. Updating it is part of the work, not a surprise.

**What this unlocks:** `authored_from` starts recording which session wrote what.
And `messaged` — the session-to-session delegation graph — starts filling in for
free, because it reads from the same resolver. One connection, two features.

**Also worth doing here:** fill in `activity.work_session_id`. The column, index,
foreign key and validation trigger all exist already; the single function that
writes that table just needs the extra parameter.

**Note:** two operations (artifact create and publish) already accept a session id
in their request format. Nobody sends it. Those are the cheapest place to prove the
pattern.

---

## 4. Widen `authored_from` to every kind

`authored_from` currently only accepts messages, memories and artifacts as sources.
A doc, task, channel, file or commit **cannot carry one at all** — the validator
refuses it.

So "every entity knows its session" needs a registry widening as well as the wiring
in step 3. Easy to miss, and it would make step 3 look half-broken.

**Size:** one migration line, plus a check that nothing assumes the narrow set.

---

## 5. Retire the misused `relates_to`

All 154 session→teammate `relates_to` edges duplicate what `participates_in` now
holds correctly. Once nothing reads them, delete them, and have session startup
write `participates_in` directly instead of relying on 065's trigger.

Do this **after** step 2 — the correct type expects a teammate as the source, which
only becomes natural once agents act as their persona.

---

## 6. The empty-but-exact mappings

Two derived edges whose source tables happen to be empty right now, so there's
nothing to backfill — but the mapping is unambiguous and the triggers are cheap:

- `shared_into` from the session handoff table.
- `in_worktree` from the worktree allocation table.

Worth doing when either feature next gets touched, not before.

---

## Also open, smaller

- **`working_on` is 38 short.** 154 sessions were started with a task; 116 have the
  edge. Find out why before assuming it's cosmetic.
- **Live sessions are supposed to keep at least one participant.** The rule exists
  but only fires on edit and delete, so before 065 every running session broke it
  silently. Now that participants exist, consider checking it on insert too.
- **The database test baseline has drifted** from 17 failures to 35. Nobody owns
  those. Worth a triage pass so the suite can be used as a signal again.

---

## Deliberately not on this list

**Backfilling session provenance for old data.** It cannot be done, and this is
measured, not assumed: 154 of 170 messages were created while two or more sessions
were alive, with up to 49 running at once. The command ledger has no session column
and is deleted after 24 hours; the event log has neither actor nor session and is
deleted after 7 days.

Session provenance is **forward-capture only**. Any plan that assumes the past can
be reconstructed is wrong, and it's better to know that now.

**Deriving memory `about` edges.** The subject field is prose. Guessing entities
from it needs language understanding, so it will be right most of the time — and a
rule that's right most of the time is exactly what must not go in a trigger. This
stays a judgement call.
