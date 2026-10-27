# Story status and progress

A story's status is manual. Change it with `tm8 entity update <story-id>
--status <status-key> --expect-version <version>` after reading the current
version and allowed actions. Progress never completes a story automatically.
A done story can still contain unfinished tasks, and completed tasks do not
change its status.

## The three tallies

| Block | What it counts |
| --- | --- |
| `progress` | Tasks and stories contained by this story. |
| `taskProgress` | Only the tasks contained by this story. |
| `rollup` | The union of this story's tasks and its descendant stories' tasks, with each task counted once by entity ID. |

Contained work means each live `contains` target (a **root**), its hierarchy
children through `parent_id`, and the story's direct child stories. The root
itself counts if it is a task or story. Hierarchy traversal stops at a story:
a contained story contributes one item to `progress`, without bringing its
tasks into `taskProgress`. A direct child story contributes its tasks through
`rollup`. A story contained only by an edge, with no descendant `parent_id`
relationship, does not bring its tasks into the parent's rollup.

Docs, forms, teammates, work sessions and PRs contribute no progress items.
Sideways links, including a session's coordinator and that coordinator's other
tasks, affect the displayed trail but never add work to these tallies.
Overlapping roots are deduplicated by entity ID within each story. Rollup also
deduplicates tasks shared between parent and descendant stories; adding child
counts together can overcount. Per-root counts can likewise overlap.

The hierarchy walk is capped at depth 32. Rollup visits at most 50 descendant
stories through four levels. These are existing bounds: the trail's
`truncated` flag describes the trail, not completeness of the rollup.

For example, a parent has one open root task and one child story with two done
tasks, one of which is also a root of the parent. The child story is manually
`to_do`. The parent's `progress` is 3 work / 1 done / 2 to do;
`taskProgress` is 2 work / 1 done / 1 to do; `rollup` is 3 work / 2 done /
1 to do. The extra rollup task belongs only to the child. Such a difference is
expected, not an off-by-one. A story with only child stories has zero
`taskProgress`; its `progress` counts those stories and `rollup` counts their
tasks.

## Bands and the stale-work signal

Every block uses these fields:

- `work`: visible, nondeleted counted items in `to_do`, `in_progress` or `done`.
- `done`: items whose status category is `done`.
- `inProgress`: items whose status category is `in_progress`, excluding blocked items.
- `toDo`: items whose status category is `to_do`, excluding blocked items.
- `blocked`: unfinished items with an unresolved hard `depends_on`, or tasks explicitly in status `blocked`. Soft or resolved dependencies do not block. Completed and cancelled items stay in their terminal bands.
- `cancelled`: items whose status category is `cancelled`, outside `work`.
- `staleInProgress`: a **subset of `inProgress`**, counting tasks without a visible, nondeleted `work_session` directly linked by `working_on` (session → task) whose runtime status is `spawning`, `running` or `idle`.

The invariant is `done + inProgress + toDo + blocked = work`.
Do **not** add `staleInProgress` to that sum. It includes working/in-review
(and any other in-progress-category) tasks without that direct live evidence;
blocked tasks and manually in-progress stories are excluded. A session on a
parent task, a nearby trail node or another story does not prove the task is
being worked on. Failed/exited sessions, including crashes, do not qualify.
A recent task edit alone does not qualify either: this signal uses linkage
and runtime, not a time threshold.

The field does not change task status, reset copied tasks, or prove abandonment.
Humans may work without a session. Row-level visibility applies to the tasks,
links and sessions, so the signal is relative to what the reader can see.
Older stored summaries may omit `staleInProgress`; absence means the signal
is unavailable, not zero.

`liveSessionCount` counts live runtimes in the **trail**, not tasks in progress.
One session can work on several tasks, and several sessions can work on one
task. Therefore it need not equal `inProgress - staleInProgress`. Terminal
sessions are shown as terminal on story nodes and roots even when their board
category offers Resume; sessions never contribute to progress totals.

## Checking a count

Read `tm8 entity context <story-id>` and follow its paging pointers for roots
and child stories. For each task root, include the root and the task rows from
`tm8 entity query --kind task --subtree <root-id> --limit 100`, continuing each
returned cursor. Deduplicate IDs across roots. That set explains
`taskProgress`; for one root, `work + cancelled` equals one plus its task
subtree count. Add contained story IDs for `progress`. Repeat the task walk
for descendant stories, deduplicating IDs across the family, to explain
`rollup`. Count categories and blockers from those rows; never use the trail
node count as a work denominator.

For stale evidence, inspect incoming `working_on` edges and each directly
linked session's runtime and deletion state. Check the same visible snapshot
where possible, since sessions and task status can change during a walk.
Cross-space task copies need a real source reference or preserved history;
the stale signal does not reconstruct missing source identities or messages.
