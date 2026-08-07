# Agent coordination and polling

How several agent sessions in one Space actually reach each other, and the four
ways that silently fails.

Everything below was **measured on 2026-08-07** by three sessions coordinating
live (`feature/Channels`, `per-person inbox`, `Messaging Format`). Each trap is
recorded with the command that produces it, because every one of them **reports
silence rather than an error** — a poller with any of these looks like a poller
with nothing to read.

> The failure mode this document exists to prevent: *a confident read of a
> label instead of the thing.* All four traps have that shape.

---

## The model: the durable row is the receipt

An agent talks to another agent by posting a message on an **anchor** — a task,
a work session, any entity. The peer polls anchors. Nothing else is needed, and
in particular **delivery status is not part of the protocol**.

Measured by the Messaging Format line: a reply came back `failed_permanent` from
`tm8 message delivery` **while the target session was `status: running` and
present in `liveEntityIds` in the same minute**. The durable row was written
correctly — right anchor, right author, readable by the peer. Only the PTY push
failed.

```
delivered          the peer's composer took the text
unknown            says nothing about the row
failed_permanent   says nothing about the row
```

**Only `delivered` proves anything, and only about the PTY.** The other two are
not evidence the message was lost. Check `tm8 entity context <message-id>` and
the row is usually right there.

Consequences:

- **Do not resend on a delivery failure.** You duplicate a message the peer can
  already read.
- **Do not treat silence as non-receipt.**
- Post where it is natural — your own session anchor, your task, or theirs. A
  peer that polls anchors reads all of them.

---

## Trap 1 — `event list` pages from seq 0, so `--limit N` returns the OLDEST N

```console
$ tm8 event list --limit 3
seq 1, 2, 3        occurredAt 2026-08-01T12:43

$ tm8 event list --limit 500
seq 5 … 501        ALL dated 2026-08-01, max 22:24
```

Read naively that says the event ledger has been dead for six days — across
*every* event type, including seven `message.created`. It is a clean, complete,
wrong conclusion, and it was reached and published before being caught.

The real head is not in that output at all:

```console
$ tm8 entity context <any-entity-id> --format json | jq .provenance.eventSeq
7833

$ tm8 event list --after 7800 --limit 40
seq 7801..7843     max occurredAt 2026-08-07T10:10:52
```

**The rule.** The baseline comes from `provenance.eventSeq` on any
`entity context` call — that is what the session instructions mean by *"the
context call's provenance.eventSeq is your baseline."* Then page forward with
`--after`, carrying the last seq you saw between ticks. An unbounded `event
list` is never a poll.

---

## Trap 2 — every session writes as the SAME actor, so `createdBy` cannot tell senders apart

**This is the dangerous one**, because it fails plausibly rather than visibly.

The obvious filter — *skip messages I wrote* — looks like this:

```python
if (entity["createdBy"] or {})["id"] == ME:
    continue
```

It reported `0 inbound messages` on a window containing four messages from two
other sessions. Measured:

```
seq 7834 | createdBy: 019fbd62-…-d1bdf7cb0b2e  team_member  "Opus 5 Teammate"
seq 7840 | createdBy: 019fbd62-…-d1bdf7cb0b2e  team_member  "Opus 5 Teammate"
seq 7843 | createdBy: 019fbd62-…-d1bdf7cb0b2e  team_member  "Opus 5 Teammate"
```

All three sessions run as one `team_member`. **Sender identity lives in the
session, not the actor** — `source_session_id` on the delivery envelope, which
is not on the entity.

So "not me" is **not expressible via `createdBy`**. The only honest filter is a
set of message ids you know you sent, recorded at send time.

Trap 1 at least looks stale. This one returns a clean empty result and reads as
"nobody is talking".

---

## Trap 3 — event payloads carry the 200-char EXCERPT, not the body

`entity.title` on a `message` upsert is the excerpt, and **for a message the
excerpt IS the title** (`packages/server/src/facade/projector.ts:636`). The cap
is `EXCERPT_MAX = 200` with a whitespace flatten and no markdown strip
(`packages/server/src/facade/entity-read.ts:318`).

Every message pulled out of the event stream therefore arrives like this:

```
**Polling here too, same model. And a trap in the polling mechanism itself that
I walked into ten min
```

A poller that reads bodies from the event stream reads the first 200 characters
of everything, **silently**. Full text needs a second call:

```console
$ tm8 entity context <message-id> --format json
content.excerpt   <- the whole body
content.truncated <- false
```

This is a live operational cost of the excerpt design, not only a rendering
concern: at time of writing the cap is truncating the messages three agent
sessions are using to coordinate.

---

## Trap 4 — `--format json` is not strictly parseable

Message bodies carry raw control characters, so:

```python
json.loads(text)                 # dies at the first multi-line message body
json.loads(text, strict=False)   # works
```

Some commands also emit a trailing `[journal: …]` line after the JSON object,
so parse by brace-matching from the first `{` rather than feeding the whole
stream to a parser.

---

## Bounded waits

`event watch --until-match` refuses to run unbounded:

```
tm8: `--until-match` is a blocking wait and must be bounded: pass --timeout <seconds>
  the cap is 300s — longer waits belong to a scheduler re-invoking this command
```

So a watch-based loop is at most a five-minute blocking wait per tick, not an
open subscription. For anything longer, poll `event list --after`.

---

## A poll loop that has none of the four

```python
# baseline once, from provenance — never from an unbounded list (Trap 1)
seq = obj(run("tm8 entity context <anchor> --format json"))["provenance"]["eventSeq"]

while True:
    items, seq = page_after(seq)            # always --after (Trap 1)
    for e in items:
        ent = e.get("entity") or {}
        if e["type"] != "entity.upsert" or ent.get("kind") != "message":
            continue
        if ent["id"] in ids_i_sent:         # NOT createdBy (Trap 2)
            continue
        body = fetch_full_body(ent["id"])   # not ent["title"] (Trap 3)
        handle(body)
```

`obj()` brace-matches and uses `strict=False` (Trap 4).

---

## Workspace hazard: untracked design docs in the shared checkout

Not a polling trap, but it cost a near-miss in the same session and belongs
with the coordination notes.

`/home/tm8/prod-workspace/tm8` is a **shared** checkout. Several sessions work
in it at once; it is rarely clean and rarely on `main`. A design doc written
there and left untracked is one `git clean -fd`, branch switch or `git checkout .`
away from gone — by any session, including one that has no idea it exists.

On 2026-08-07 a 51 KB design document was sitting untracked in exactly that
state.

**Commit and push design docs to a branch as soon as they are worth keeping.** A
graph `doc` entity survives, but the file does not, and the file is what the
diff and the reviewer read.

---

## Related

- [`AGENT-HARNESS-AND-COMMAND-DISCOVERY.md`](AGENT-HARNESS-AND-COMMAND-DISCOVERY.md)
  — how an agent learns the grammar at runtime; this document is the
  coordination half of the same story.
- `docs/features/channels/README.md` — the channels work these sessions were
  coordinating over.
