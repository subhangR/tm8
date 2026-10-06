/**
 * The canonical edge glossary: one edge type per meaning (Design Rules
 * 01a10c5d §2.3, P0b task 01a10c66; inventory doc 01a111b8-74a1).
 *
 * The meanings themselves live in `public.edge_types.description` (303) and
 * print with `tm8 edge type list`. This table adds what the registry cannot
 * say: which meaning an agent reaches for, the direction to write it in, and
 * whether an agent writes it at all or the server records it. `tm8 help
 * edge-type` and the worker prompt's linking rule render from it, so the
 * three surfaces cannot drift.
 */
export interface CanonicalEdge {
  /** The meaning, as Design Rules §2.3 names it. */
  meaning: string;
  type: string;
  /** Source → target, in words. */
  direction: string;
  /** `agent`: an agent writes it when the meaning applies. `server`: recorded for you; never write it by hand. */
  writtenBy: 'agent' | 'server';
  /** How to write it (agent edges) or what records it (server edges). */
  how: string;
}

export const CANONICAL_EDGES: readonly CanonicalEdge[] = [
  { meaning: 'Deliverable of a task', type: 'produces', direction: 'task → doc, artifact, file or drawing it produced', writtenBy: 'agent',
    how: 'tm8 edge create <task-id> produces <output-id>' },
  { meaning: 'Context or input', type: 'attached_to', direction: 'entity → the task (or entity) it gives context to', writtenBy: 'agent',
    how: 'tm8 entity create … --attach-to <task-id>, or tm8 edge create <entity-id> attached_to <task-id>' },
  { meaning: 'Follow-up of', type: 'follows_up', direction: 'new task → origin task (or new session → earlier session)', writtenBy: 'agent',
    how: 'tm8 edge create <new-task-id> follows_up <origin-task-id>' },
  { meaning: 'Prerequisite', type: 'depends_on', direction: 'task → the task it waits on', writtenBy: 'agent',
    how: 'tm8 edge create <task-id> depends_on <prerequisite-id>' },
  { meaning: 'Ships as code', type: 'tracks', direction: 'task → pull request or commit', writtenBy: 'agent',
    how: 'tm8 task link-pr <task-id> <url> / tm8 task link-commit <task-id> <url>' },
  { meaning: 'Responsible for', type: 'assigned_to', direction: 'task → member or teammate', writtenBy: 'agent',
    how: 'tm8 edge create <task-id> assigned_to <actor-id>' },
  { meaning: 'Story root', type: 'contains', direction: 'story → root entity', writtenBy: 'agent',
    how: 'tm8 collection add <story-id> <root-id> (roots only; children follow through --parent)' },
  { meaning: 'Actively working on', type: 'working_on', direction: 'session → task', writtenBy: 'server',
    how: 'tm8 task transition <task-id> --claim records it; it ends when the work stops' },
  { meaning: "Session's teammate", type: 'participates_in', direction: 'teammate → session', writtenBy: 'server',
    how: 'recorded at spawn' },
  { meaning: 'Made during a session', type: 'authored_from', direction: 'entity → session or chat', writtenBy: 'server',
    how: 'recorded when a session creates or posts it' },
  { meaning: 'Completed by', type: 'completed_by', direction: 'task → member or teammate', writtenBy: 'server',
    how: 'recorded by tm8 task complete' },
  { meaning: 'Launch task', type: 'derived_from', direction: 'task → the story or session it launches', writtenBy: 'server',
    how: 'recorded when a spawn needs a task' },
  { meaning: 'See also', type: 'relates_to', direction: 'any → any', writtenBy: 'agent',
    how: 'only when no edge above fits; story walks and maps ignore it' },
];

/** Edge types an agent must never hand-write: deprecated, or replaced by a canonical meaning. */
export const NON_CANONICAL_EDGES: Readonly<Record<string, string>> = {
  dispatched_by: 'deprecated: a session\'s parent is the session that spawned it',
  created_in: 'unverified alias of authored_from, which the server records',
};
