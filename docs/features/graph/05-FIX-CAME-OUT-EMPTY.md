# Fix 3 — the one that came out empty

This is the derived edge that was supposed to reveal which agent delegated to
which. It backfilled **zero rows**. That is the finding, not a bug, and it is
worth its own doc.

## What we expected

tm8 keeps a delivery table: every time a message is dispatched to a running
session, a row goes in. It has a "who sent it" column and a "who received it"
column.

67 rows existed. Reading them as sender-receiver pairs gave **25 distinct pairs**
— which would be the whole picture of who delegated to whom. That is a graph
nobody could see, and it sounded like the most interesting thing on the list.

## What was actually there

Zero. The "who sent it" column is **empty in all 67 rows**.

## My mistake

The 25 came from a bad query. I counted distinct sender-receiver pairs, but SQL
happily treats *(nobody, someone)* as a perfectly good pair and counts it. So
what I had actually counted was **25 distinct receivers with no known sender.**

Worth naming because the query looked right and returned a plausible number. A
count over a column that is allowed to be empty needs checking before you trust
it.

## Why the column is empty — the interesting part

That column is filled in by a piece of server wiring called
`resolveAuthoredFromWorkSessionId`. It is declared, and it is **not connected**.

Which is the *same* piece of wiring that would record "which session wrote this".

**One missing connection, two dark features.** That is good news for effort: hook
it up once and both light up.

## What we did anyway

Registered the edge type (`messaged`) and installed its trigger.

Nothing to backfill, so nothing appeared. But the mechanism is now in place, which
means the delegation graph **starts filling itself in the moment that wiring is
connected**, with no further migration and nobody having to remember.

## What this changed about the plan

This item was on the list as "do it now, the data is already there". It is not —
it belongs with the session-identity work instead. Being wrong about that is
better found by measuring than by shipping.
