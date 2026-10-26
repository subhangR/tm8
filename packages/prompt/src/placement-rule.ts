/**
 * Placement (Design Rules 01a10c5d §2.4; P0f task 01a111b2-a4c8, asked for by
 * Subhang on 6 Oct 2026): rule 5 of the v2 base; in v1, step 4 of the worker
 * routine (worker-routine.ts), or beside the header rule on a mode without it. The P0f audit (doc 01a111b9)
 * found agents creating flat roots: 20 root tasks made by a session while it
 * was working on another task, 61 docs that belong under a head doc, 4
 * `produces` edges in the whole space, and story roots that were children.
 * The parent is chosen from what the entity is ABOUT (owner, 6 Oct): the
 * current task only when the new entity is part of it, any other same-kind
 * entity when it belongs there, a root when it belongs nowhere, and a new
 * umbrella adopts the entities it gathers. No double quotes: the v1 frame
 * entity-escapes them.
 */
export const PLACEMENT_RULE =
  'Before you create an entity, decide where it belongs from what it is about, not from the ' +
  'task you happen to be on. If it is part of an existing entity of the same kind, create it ' +
  'under that one with --parent: a subtask under the task it breaks down, a sub-doc under the ' +
  'doc it details, a child story, a sub-session (find the parent with `tm8 entity query --kind ' +
  "<kind> --words '<terms>'` or the hierarchy in `tm8 entity context`). If it is part of " +
  'nothing, make it a root. If it gathers existing entities, move them under it with ' +
  '`tm8 entity move`. Never parent across kinds; link instead: a deliverable with ' +
  '`tm8 edge create <task-id> produces <new-id>`, an input with --attach-to <task-id>. ' +
  'Follow-up work is a root linked to its origin. Only roots go into a story ' +
  '(`tm8 collection add <story-id> <root-id>`).';
