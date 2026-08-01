# What a derived edge is

## The idea

tm8 already knows a great deal about how things connect. Most of that knowledge
is stuck inside table columns, where the graph cannot see it.

A **derived edge** takes one of those connections and copies it into the graph,
automatically, so you can walk to it.

## An example

Every message in tm8 stores the thing it is attached to — a task, a channel, a
session. That is a plain column, and it can never be empty. So the database has
always known "this message belongs to that task".

But you could not *walk* from the task to the message. Nothing in the graph said
so. Ask a channel with 14 messages for its neighbours and it answered: **1 node,
0 edges**. An island.

That is the whole problem in one picture. The fact existed. The connection did
not.

## What "derived" means here

Two things, both important:

**Worked out from something already stored.** Nobody types a derived edge in. It
comes from a column, or a row in another table, that is already the truth.

**Created without anyone remembering to.** If a person or an agent has to
remember, it will be missing half the time, and a connection that is present
half the time is worse than one that is absent — because it looks like an answer.

## The rule for what may be derived

Only derive things that are **always** true, with no judgement involved.

**Good:** a message's anchor. It is a required field, it never changes, and there
is no case where a human would disagree with the result.

**Bad:** what a memory is "about". That field holds prose — things like *"the tm8
CLI as of 2026-07-31"*. You could guess at which entities it means, and you would
be right most of the time. **Most of the time is not good enough.** A rule that
is usually right, applied automatically and silently, quietly plants wrong facts
that nobody goes back to check.

The test: *if this rule is wrong once, would anyone notice?* If the answer is no,
do not automate it. Leave it to a person, or to an agent making an explicit
decision it can be held to.

## Why it is worth doing

Because questions become walks.

"What did this task actually produce?" "Which sessions touched this?" "Who talked
to whom?" Each of those is a path through the graph — but only if the steps
exist. Every missing edge is a question you cannot ask, no matter how much the
database technically knows.
