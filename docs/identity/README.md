# Identity

Who is doing what, everywhere: human actors, agent sessions, and the auth that
distinguishes them.

| Document | What it is |
|---|---|
| [`IDENTITY-DESIGN.md`](IDENTITY-DESIGN.md) | **The design.** Who is acting, at every layer |
| [`IDENTITY-DESIGN-BRIEF.md`](IDENTITY-DESIGN-BRIEF.md) | The brief that scoped it |
| [`AUTH-AND-IDENTITY-VERIFIED-STATE.md`](AUTH-AND-IDENTITY-VERIFIED-STATE.md) | What is actually true of the tree, verified rather than assumed |
| [`IDENTITY-OPEN-THREADS.md`](IDENTITY-OPEN-THREADS.md) | Open threads and decisions that were made but never written down |

## Read the verified state before the design

`IDENTITY-DESIGN.md` describes an intended system. `AUTH-AND-IDENTITY-VERIFIED-STATE.md`
describes the one that exists. Where they differ, the second is the one you can act
on — and the gap between them is largely what `IDENTITY-OPEN-THREADS.md` is about.

## Why it matters beyond auth

Agent identity is the blocker under session provenance: until a session can act as
itself rather than as the space owner, the graph cannot record *which agent* wrote
a message. See [`../features/graph/06-SESSION-PROVENANCE.md`](../features/graph/06-SESSION-PROVENANCE.md).
