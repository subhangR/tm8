# Fix 1 — messages were invisible to the graph

## Before

175 messages existed. **Not one of them appeared in the graph.**

The clearest way to see it: take the `general` channel, which had 14 messages on
it, and ask the graph for everything within two steps.

```
$ tm8 graph query --focus <channel> --hops 2
  nodes: 1   edges: 0
```

One node — itself. No edges. The busiest, most conversational kind of thing in
the whole system was an island.

## Why

Every message row stores an `anchor_id`: the task, channel, or session it hangs
on. It is a required field and it never changes.

So the fact was never missing. What was missing was **any edge type that could
hold it**. Of the 31 types registered, not one accepted a message as its
starting point. There was nowhere to put the connection even if someone had
wanted to.

## What we did

Three things, in one migration:

1. **Added a type** called `anchored_to` — "this message hangs on that thing".
2. **Backfilled every message.** 175 of 175, none missed.
3. **Added a trigger** on the messages table, so a new message gets its edge the
   moment it is written.

That third step is the one that matters long-term. Without it the backfill starts
going out of date on the very next message posted.

## After

The same channel, same question:

```
  nodes: 15   edges: 14
```

Its whole conversation is now reachable by walking.

## The proof it works going forward

Not a test — the real thing. We posted an ordinary message through the live
server and looked for the edge:

```
  anchored_to  origin='anchor_recorder'  -> channel:'general'
```

Nobody created that edge. The trigger did, during the normal message post, with
no code change on the server.

## A detail worth knowing

This works on the **frozen server build** running on ports 7777/7778 — the one
that never picks up new code. Because the whole change is plain SQL living in the
database, it took effect immediately without rebuilding or restarting anything.

That turned out to be a good reason to prefer triggers over changing server code,
and it shaped the rest of the work.
