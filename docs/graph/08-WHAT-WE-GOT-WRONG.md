# What we got wrong along the way

Three claims turned out to be wrong when measured, and two process hazards bit.
The corrections are more useful than the original conclusions, so they get their
own doc rather than being quietly dropped.

## 1. "25 session pairs to backfill" — actually zero

I reported that the delivery table held 25 sender-receiver session pairs ready to
turn into edges.

The real number is **0**. The sender column is empty in all 67 rows. My count had
included rows with no sender at all, because SQL treats *(nobody, someone)* as a
valid pair and counts it.

**Lesson:** a distinct-count over a column that is allowed to be empty needs
checking before it is quoted. The wrong number was plausible, which is exactly why
it survived.

## 2. "Filling in participants unblocks session provenance" — measured false

This was the reasoning for doing the participant backfill first, and it was wrong.

The recorder that writes session provenance checks: *is the acting actor a
declared participant in this session?* The backfill created those participant
links, so it looked like the check would now pass.

It does not. The link points **from the teammate persona**; the actor doing the
writing is **the space owner**, a human account. Different entities. The check
compares them and refuses.

Tested directly, on every session:

```
acting_actor  actor_kind  actor_has_participates
019fb748-...  member      false
```

**Why it matters:** the real blocker is that agents have no identity of their own —
a bigger and more interesting problem than a missing edge. Finding this out by
testing cost an hour. Finding it out after building the rest of the plan on top of
it would have cost much more.

## 3. The provenance tag — built, then deliberately removed

You asked for the session's own edges to be labelled as machine-written, so they
could be told apart from ones a person drew by hand. I built it, then measured what
it would actually produce.

The label comes from a "writer" claim the writing code has to make. **The session
startup code makes no such claim.** So the label would have read `user` on every
single machine-written edge — the exact opposite of the intent, and a false
statement inside the system whose whole job is recording who did what.

So it came out. A missing label is better than a wrong one, and a wrong one in a
provenance system is worse than in most places.

The real fix is one line in the session startup code, and it is on the next-steps
list. It was not done here because that code is shared, sits on the launch path,
and another lane is actively reshaping it.

## 4. Another lane took the migration number mid-work

I checked the next free migration number, wrote the file, and by the time it was
finished someone else had claimed it.

**Lesson:** check the number *after* writing as well as before. Minutes are enough.

## 5. A half-finished migration got applied by someone else

While the migration was still being corrected, another session ran a full
migration pass against staging and picked my file up out of the shared working
tree — applying the **work-in-progress version**, including the provenance tag I
had already decided to remove.

**Lesson:** an uncommitted migration file is not private. It is live input to every
other session on this machine. That is a strong argument for committing early, or
for staging work outside the migrations folder until it is settled.

I reconciled staging back to the corrected version afterwards, and both databases
now agree.

## Why this doc exists

Two of the three wrong claims came from *my own* earlier report on this task, and
one of them was a query error rather than a misreading of the code. Anyone reading
the original analysis without these corrections would build on numbers that do not
hold.
