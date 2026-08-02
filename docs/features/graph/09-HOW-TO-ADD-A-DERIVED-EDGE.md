# How to add a derived edge

The recipe migration `065` follows. Copy it.

---

## The one rule

**Backfill what exists, and add a trigger so the future looks after itself.**

Do both, or neither.

A backfill on its own starts rotting from the very next write. Within a week you
have an edge type that's right for old rows and wrong for new ones, and that is
**worse than not having it** — because a half-full edge type reads like an answer.
Anyone querying it gets a confident, wrong result.

This is not hypothetical. It's what happened to `participates_in`: a backfill ran
once in migration 015, nothing kept it up, and it sat at **1 row across 152
sessions** for months. It looked like a feature.

---

## Before you write anything: is it actually derivable?

Only build this when the answer is *always*, with no judgement involved.

**Good** — `messages.anchor_id`. It's a foreign key, it can't be empty, it never
changes. The edge is a straight copy. There is no case where a human would
disagree with the result.

**Bad** — memory `about` edges. The field holds prose like *"the tm8 CLI as of
2026-07-31"*. You could guess at entities with language understanding, and you'd be
right most of the time. **Most of the time is not derivable.** A trigger that's
usually right is a machine that quietly plants wrong facts. Leave it to a human or
an explicit agent step.

The test: *if this rule is wrong once, does anyone notice?* If no, don't automate it.

---

## Use a trigger, not the RPC

The obvious place to write a derived edge is inside the operation that causes it —
`execution_spawn` for session edges, `post_message` for message edges.

Don't, if you can avoid it. Two reasons:

**It's a shared body.** These functions get replaced with `create or replace` by
whatever migration comes last. Two lanes both editing one, and the later file
**silently wins** — the earlier one's work vanishes with no error and no failing
test. tm8 has been bitten by this enough times that migration 052 exists purely to
own one such function.

**A trigger works on frozen builds.** Ports 7777/7778 run a snapshot binary that
never picks up code changes. Pure SQL applies to the database and takes effect
immediately. 065 was verified end-to-end against that frozen server — a new message
got its edge with no rebuild.

For `participates_in`, the trigger hangs off the `relates_to` edge that session
startup *already* writes. Same result, nothing shared touched.

---

## The shape

```sql
set role tm8_graph_owner;          -- and `reset role;` at the end. Both matter.

-- 1. Register the type.
insert into public.edge_types(type, src_kinds, dst_kinds, description, acyclic, props_schema)
values ('your_type', array['source_kind'], array['*'], 'Server-derived: ...', false,
        jsonb_build_object('type','object',
          'properties', jsonb_build_object('origin', jsonb_build_object('type','string')),
          'additionalProperties', true))
on conflict (type) do nothing;

-- 2. The trigger function.
create or replace function internal.derive_your_thing() returns trigger
language plpgsql set search_path = public, internal, pg_temp as $$
begin
  -- Bail out quietly on anything that isn't your exact case.
  perform internal.w1_set_writer('your_recorder');   -- this is what tags props.origin
  insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
  values (...)
  on conflict do nothing;                            -- makes re-runs free
  perform internal.w1_set_writer(null);              -- always clear it
  return null;
end $$;

drop trigger if exists your_trigger on public.source_table;
create trigger your_trigger after insert on public.source_table
for each row execute function internal.derive_your_thing();

-- 3. Backfill, in the same file.
do $backfill$ ... $backfill$;

reset role;
```

---

## Things that will bite you

**Both endpoints must be in the same space.** The edge validator raises if they
aren't. Check it in the trigger and return quietly instead — a derived edge must
never take down the operation that caused it. 065 does this for both new types.

**Be narrow about what you match.** The `participates_in` trigger fires on every
`relates_to` edge, so it checks that the source is a session *and* the target is a
teammate before doing anything. Without that, a user linking two tasks would
manufacture a bogus participant. There's a test for exactly this.

**Don't make it "recorder-owned" without thinking.** There's a stricter mode where
only the official writer can touch a type. It has no exemption for cascade deletes
— so making `anchored_to` recorder-owned would mean **deleting a message fails**.
Tag your edges; only *own* them when the fact must be permanent.

**Don't invent history.** 065 deliberately leaves `origin` empty on rows that
predate it, rather than guessing. Which of those were machine-written is precisely
the fact that was lost. Absent means "we don't know", and that's the honest answer.

**Check the migration number twice** — before you write and after. Numbers get
claimed by other lanes in minutes. While 065 was being written, another lane took
064 out from under it.

---

## How to know it worked

The database test suite has **35 pre-existing failures**. A green run is not
available, so "the tests pass" is not a thing you can say. Take a baseline instead:

```bash
# with your migration parked
TM8_DATABASE_URL=postgres://tm8:tm8@127.0.0.1:5442/tm8_base node db/test/run.mjs > base.log 2>&1
# with it in place
TM8_DATABASE_URL=postgres://tm8:tm8@127.0.0.1:5442/tm8_new node db/test/run.mjs > new.log 2>&1
# then diff the failing test names, not the counts
```

Equal counts aren't enough — diff the actual names, or a fixed test masking a
broken one looks identical.

Then, in order:

1. **Apply to a copy of the real database first.** `pg_dump` production, restore it
   under another name, apply there, and count. Numbers from an empty test database
   tell you nothing about a backfill.
2. **Go through the real runner**, not `psql`. The runner writes a ledger row after
   the fact, and a migration that leaves the session under `set role` makes that
   write fail — rolling back everything, while a hand-run `psql` looks fine.
   Stage a copy of the runner with **only your file** in its migrations directory,
   or `up` will also apply every other lane's pending work.
3. **Run the backfill twice.** The second run must create zero rows.
4. **Drive the real path.** Post an actual message through the actual server and
   look for the edge. This is the only step that proves the trigger fires in
   production conditions, and it's the one that's easy to skip.
