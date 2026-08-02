# How a session's identity travels — and where it stops

**The question:** an agent is running in a work session. It runs
`tm8 entity create --kind doc`. Afterwards, can we ask "which session made this
doc?"

**The answer today: no.** Not for a doc, a task, a message, or anything else.

This document explains why, in order, because the reason is a chain and every
link in it is broken independently. It matters because fixing one link changes
nothing on its own.

---

## First, clearing up a misconception

There's a belief that we already store a "created by session" id. We don't.

Every entity has a `created_by` column, and it's never empty — so it *looks* like
provenance is covered. But `created_by` holds an **actor** (a person or a
teammate persona), never a session. There is no `created_by_session_id` column
anywhere in the database.

There is exactly **one** column in the whole schema that ties a session to
something that happened: `activity.work_session_id`. It has an index, a foreign
key, and a validation trigger — someone built it carefully. It is empty in all
421 rows, because the only function that writes to that table never sets it.

---

## The chain, link by link

The session id genuinely exists inside the agent's process. It just never gets
anywhere.

**1. The agent's environment knows.**
When a session starts, it gets `TM8_SESSION_ID` in its environment variables.
This works.

**2. The CLI reads it.**
The CLI picks it up into its internal context. This works too.

**3. The CLI almost never sends it.** ← *first break*
Out of 32 command files, the session id is put into a request exactly **once**:
when spawning a *child* session, to record the parent. Not when creating a doc,
sending a message, completing a task, or anything else.

**4. There's no header carrying it either.**
The CLI sends three headers, and none of them is the session.

**5. The request format has no field for it.** ← *second break*
The shape every command uses has room for two things: who's acting, and a
mutation id. There's no session slot. And the request shapes are strict, so
adding a `sessionId` field would be **rejected**, not quietly ignored.

**6. The database has no slot for it.** ← *third break*
Four pieces of context reach the database per request: identity, actor, admin
flag, request id. No session.

**7. The server code has nowhere to read it from.** ← *fourth break*
The request context object simply has no session field.

So the function that's supposed to work out the authoring session
(`resolveAuthoredFromWorkSessionId`) is never connected — and couldn't do its job
if it were, because there's nothing to read.

**This gap is deliberately marked.** There's a test that fails to compile if the
connection point appears. Someone found this, understood it, and left a tripwire
rather than a mystery. Closing the gap means updating that test on purpose.

---

## The link that survives fixing all of the above

This is the part that surprised us, and it's why migration 065 turned out
differently than planned.

Say you fix links 3 through 7 and the session id arrives cleanly. The write
**still gets refused.**

Every one of the three places that records session provenance checks the same
precondition first: *is the acting actor a declared participant in this session?*
It looks for a `participates_in` edge from the actor to the session.

Filling in those edges was step one of the plan, and 065 did it — 154 sessions now
have one. But when tested, the check **still fails**, because:

- The `participates_in` edge points **from the teammate persona** to the session.
- The acting actor, when an agent runs a CLI command, is **the space owner** — a
  human member account.

They're different entities. The check compares them and says no.

This was measured, not guessed:

```
session                               acting_actor    actor_kind  actor_has_participates
019fbbad-0d09-7cd3-9f4b-3e1e255782ec  019fb748-...    member      false
```

---

## Which brings us to the real root cause

Agents have no identity of their own.

When this agent asks the server who it is, the answer is:

```json
{ "displayName": "Owner", "isOwner": true, "actingAs": null }
```

`actingAs` is a built-in slot for "I'm acting as this persona". It's empty. The
session startup code sets a `TM8_TEAM_MEMBER_ID` environment variable and never
mints a token to go with it — so every write an agent makes is recorded as the
human owner's.

You can see it in the data: **165 of 169 messages are attributed to a human
member.** Only 4 to any teammate.

So there are really two problems, and they multiply:

1. The session never reaches the server.
2. Even the *actor* is wrong, so agent work and human work are indistinguishable.

Fixing only the first gives you session-tagged edges that still claim the owner
wrote them.

---

## One seam, two symptoms

A useful thing fell out of the 065 work.

We expected to backfill 25 session-to-session "who delegated to whom" edges from
the message delivery table. The real count is **zero** — the "who sent it" column
is empty in all 67 rows.

Why? That column is filled in by **the same unconnected function** that would
have filled in session provenance. One missing connection, two features dark.

Which is good news for effort: connecting it lights up both.

---

## What already exists and is waiting

None of this needs designing from scratch:

- The edge type for session provenance (`authored_from`) is registered, with the
  right rules and a uniqueness guarantee.
- The reader side is fully built — the session chat feed already queries for it
  and just gets nothing back.
- Two operations (artifact create and publish) **already accept a session id in
  their request format**. Nobody sends it.
- The intended fix is written down in `docs/identity/IDENTITY-DESIGN.md`: add the
  field to the request shape, add a database context slot, and export the actor id
  at session startup.

---

## One thing that can never be recovered

Old history cannot be attributed retroactively. We tested it: match each entity
against which sessions were alive when it was created.

| kind | total | exactly one session alive | two or more (ambiguous) |
|---|---:|---:|---:|
| message | 170 | 9 | **154** |
| task | 53 | 12 | 32 |
| doc | 39 | 1 | 24 |

Up to **49 sessions run at once**, so guessing from timing is hopeless. The
logs don't help either — the command ledger has no session column and is deleted
after 24 hours; the event log has neither actor nor session and is deleted after
7 days.

**Session provenance can only ever be captured going forward.** Anything built on
the assumption that a backfill will recover the past is built on sand.
