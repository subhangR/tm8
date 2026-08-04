# How we checked it worked

Migration 065 changed live data in the database you actually use. Here is how it
was checked, and why each step was worth doing — every one of them catches a
specific way this kind of change fails *silently*.

## 1. Applied it to a copy of the real database first

Took a full dump of the live database, restored it under another name, and applied
the migration there.

**Why:** a backfill's whole job is to fill in existing rows. Run it against an
empty test database and it reports success having done nothing at all. The numbers
only mean something against real data.

## 2. Went through the real migration runner, not `psql` by hand

**Why:** the runner writes a ledger row after applying, and a migration that
leaves the connection in a changed state makes *that* write fail — rolling
everything back. Applied by hand, the same migration looks perfectly fine. Only
the real runner exercises that.

We also staged a copy of the runner with **only this one file** in it. A normal run
would have applied every other lane's pending migrations too, which is not our
change to make.

## 3. Ran the backfill twice

Second run created **0 rows**. Total unchanged.

**Why:** if re-running duplicates data, the migration is a landmine for anyone who
retries it after a failure.

## 4. Tested the triggers by hand — including what must *not* happen

- A new message gets its edge. ✔
- Deleting a message is **not blocked** by its new edge. ✔ (Easy to get wrong;
  one stricter setting here would have made deleting any message fail.)
- A new session gets its teammate link. ✔
- **A person linking two tasks does not create a bogus participant.** ✔

That last one is the important one. The trigger fires on *every* vague link, so
without a narrow check it would have invented participants out of unrelated user
actions.

## 5. Compared the test suite against a baseline

The database test suite has **35 failures that were already there.** A green run
simply is not available, so "the tests pass" is not something anyone can honestly
say about this repo right now.

So we ran it **with and without** the migration and compared the lists of failing
test names:

```
without: 35 failures
with:    35 failures
new failures introduced: none
failures fixed:          none
```

**Why compare names and not counts:** equal counts are also what you would see if
the change fixed one test and broke another.

## 6. Drove the real path, on the real server

Posted an ordinary message through the live server and watched the edge appear.

**Why:** every step above is about the database in isolation. This is the only one
that shows the trigger firing in production conditions, and it is the step that is
easiest to skip because by then everything already looks fine.

## Rollback

A dump of the live database was taken immediately before applying, so the change
can be undone.

One caveat: it is sitting in this session's temporary folder, which does not
survive a reboot. Worth copying somewhere permanent if it matters.
