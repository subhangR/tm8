/**
 * The roster every space starts with — roles, not models.
 *
 * A teammate is a context piece: a persona, its memories and its skills. The
 * model is a setting on it (and an override per launch), so the default roster
 * names jobs rather than one teammate per catalog row. The server seeds these
 * (`packages/server/src/bootstrap/default-teammates.ts`); the names live here
 * because the UI also needs one of them — a Craft chat starts with the Graph
 * Architect when the viewer has not picked anyone.
 */
export const HOUSE_TEAMMATE_NAMES = {
  worker: 'Worker',
  coordinator: 'Coordinator',
  reviewer: 'Reviewer',
  helper: 'TM8 Helper',
  teammateManager: 'Teammate Manager',
  graphArchitect: 'Graph Architect',
  dreamer: 'Dreamer',
  dispatcher: 'Dispatcher',
} as const;

export type HouseTeammateKey = keyof typeof HOUSE_TEAMMATE_NAMES;
