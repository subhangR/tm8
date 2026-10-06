/**
 * KIND → CLI VOCABULARY — which `tm8 help` nouns and command paths describe a
 * kind, as registry DATA.
 *
 * WHY THIS EXISTS. Entity Help's Toolkit tab shows the commands that act on a
 * kind, and the ruling (form 01a0e7d3) is that those commands are read LIVE
 * from the help catalog — the same rows `tm8 help <noun> --format json` prints
 * — so the list can never drift from the binary. But the catalog is indexed by
 * NOUN (`session`, `teammate`, `pr`), not by kind (`work_session`,
 * `team_member`, `pull_request`), and a handful of kinds have no noun at all
 * (a doc is made and read through the generic `entity` family). This file is
 * the join: for each kind, the nouns whose whole command list applies, plus
 * the individual command paths from OTHER nouns that a reader of this kind
 * needs (a commit's page wants `task link-commit`, which is a task verb).
 *
 * NOTHING HERE IS A COMMAND'S TEXT. Only names. The syntax, summary, notes
 * and examples are looked up in the catalog at render time, and
 * `kind-nouns.test.ts` fails on any noun or path the catalog no longer has —
 * a renamed verb breaks the build rather than the page.
 *
 * THE GENERIC FAMILY applies to every kind and is listed once, below, rather
 * than repeated per row.
 *
 * Kind literals are legal here: `src/domain/` is one of the two directories
 * §15.2 permits them in.
 */

export interface KindCliVocabulary {
  /** Catalog nouns whose every command applies to this kind. */
  readonly nouns: readonly string[];
  /** Extra command paths (`'task link-pr'`) from other nouns. */
  readonly commands: readonly string[];
}

/**
 * The commands that act on ANY entity, in reading order: orient, read, make,
 * change, relate, talk. Every kind's Toolkit closes with these.
 */
export const GENERIC_ENTITY_COMMANDS: readonly string[] = [
  'entity context',
  'entity get',
  'entity create',
  'entity update',
  'entity header set',
  'entity connections',
  'entity children',
  'entity activity',
  'entity attention',
  'entity delete',
  'entity restore',
  'edge create',
  'message send',
  'message list',
  'action list',
];

export const KIND_CLI_VOCABULARY: Readonly<Record<string, KindCliVocabulary>> = {
  chat: { nouns: ['chat'], commands: ['space chat-defaults get', 'space chat-defaults set'] },
  task: {
    nouns: ['task'],
    commands: ['session dispatch', 'session spawn', 'space task-axis list', 'space task-workflow list'],
  },
  work_session: { nouns: ['session'], commands: ['handoff send', 'handoff list', 'attention list'] },
  form: { nouns: ['form'], commands: [] },
  project: { nouns: ['project'], commands: ['worktree list', 'container create'] },
  team_member: {
    nouns: ['teammate'],
    commands: ['skill equip', 'skill unequip', 'session spawn', 'chat start', 'space member list'],
  },
  skill: { nouns: ['skill'], commands: [] },
  memory: { nouns: [], commands: ['entity query', 'entity pull'] },
  doc: { nouns: [], commands: ['entity query', 'collection add'] },
  drawing: { nouns: [], commands: ['entity query', 'collection add'] },
  artifact: { nouns: ['artifact'], commands: ['project association correct'] },
  file: { nouns: ['file'], commands: ['message attachment add', 'message attachment remove'] },
  collection: { nouns: ['collection'], commands: ['entity query'] },
  // A story has no catalog noun (283 rides entities.create/patch); its roots go in
  // and out through the collection verbs, and spawning on it hands the story over.
  story: { nouns: [], commands: ['collection add', 'collection remove', 'session spawn'] },
  // A design rides the same doors as a story: its pages go in and out through
  // the collection verbs (with --position), and Run hands the design over.
  design: { nouns: [], commands: ['collection add', 'collection remove', 'session spawn'] },
  graph: { nouns: ['graph'], commands: ['saved-view list', 'saved-view create'] },
  member: {
    nouns: [],
    commands: [
      'space member list',
      'space member role',
      'space member remove',
      'space invite create',
      'space invite list',
      'space leave',
    ],
  },
  channel: {
    nouns: [],
    commands: ['message send', 'message list', 'message reply', 'space default-channel set', 'voice token'],
  },
  commit: { nouns: [], commands: ['task link-commit', 'tracking refresh', 'worktree commit', 'project blame'] },
  pull_request: { nouns: ['pr'], commands: ['task link-pr', 'task gate', 'tracking refresh'] },
  // `worktree` is a command family with no catalog NOUN of its own (its rows
  // are aliases under `project` / `session`), so the paths are named one by one.
  worktree: {
    nouns: [],
    commands: [
      'worktree list',
      'worktree status',
      'worktree stage',
      'worktree commit',
      'worktree merge',
      'worktree cherry-pick',
      'worktree branch',
      'worktree stash',
      'project contention',
      'session spawn',
    ],
  },
  interaction_profile: {
    nouns: ['interaction-profile'],
    commands: ['teammate interaction-profile set-default', 'space interaction-profile set-default'],
  },
  credential: { nouns: ['credential'], commands: ['space credential-readiness get', 'session spawn'] },
  space_link: { nouns: ['space-link'], commands: [] },
  // 284: a space style is written only by `tm8 style push`; the noun owns it.
  style: { nouns: ['style'], commands: [] },
  server: { nouns: ['server'], commands: ['identity get', 'node mode'] },
  mcp_server: {
    nouns: [],
    commands: [
      'mcp server list',
      'mcp server get',
      'mcp server create',
      'mcp server update',
      'mcp server delete',
      'mcp server import',
      'mcp server test',
    ],
  },
  op_request: { nouns: ['request'], commands: [] },
  loop: { nouns: [], commands: ['entity query', 'session spawn'] },
  spell: { nouns: [], commands: ['skill equip', 'entity query'] },
  container: { nouns: ['container'], commands: [] },
};

const EMPTY: KindCliVocabulary = { nouns: [], commands: [] };

/** A kind's vocabulary; a kind with no row still gets the generic family. */
export function kindCliVocabulary(kind: string): KindCliVocabulary {
  return KIND_CLI_VOCABULARY[kind] ?? EMPTY;
}
