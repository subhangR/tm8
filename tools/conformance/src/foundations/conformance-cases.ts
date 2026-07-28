import type { OperationName } from '@tm8/contract';

export type ConformanceCaseStatus = 'foundation' | 'semantic-pending' | 'deferred';

export interface ConformanceCase {
  readonly owner: string;
  readonly status: ConformanceCaseStatus;
  readonly executableHere: boolean;
  readonly source: string;
  readonly assertion: string;
  readonly operations: readonly OperationName[];
}

const HARNESS_ASSERTIONS: Readonly<Record<string, string>> = {
  D1: 'At the W1 target, parse the catalog and assert 101 unique operations, 99 v1 and 2 reserved; retain the 81-row pre-amendment count as historical baseline evidence.',
  D2: 'Exact-operation help succeeds for every catalog operation and returns one catalog digest.',
  D3: 'Every public/composite operation has a noun shard and every operation has intent tags.',
  D7: 'Reserved/internal help explains exposure and owner without executable public syntax.',
  P8: 'No ui-template command, operation, graph entity kind, or agent-generated template exists.',
  M10: 'Four cross-root Teammate reservations consume the unordered-pair allowance; the fifth fails permanently, falls back, and writes zero bytes.',
  M11: 'execution.prompt exact help is internal/use_message_send and public principals are rejected before queue admission.',
  M12: 'canMessage, canContactSession, and canHandoffEntity vary independently; none implies another.',
  S6: 'Bootstrap uses TM8_AGENT_TOKEN and never the retired TM8_AUTH_TOKEN literal.',
};

function harnessCase(id: string): ConformanceCase {
  const family = id[0];
  const owner = family === 'D' || family === 'R'
    ? 'W4-W5'
    : 'W2-W5';
  const foundations = new Set(['D1', 'D2', 'D3', 'D7', 'P8']);
  return {
    owner,
    status: foundations.has(id) ? 'foundation' : 'semantic-pending',
    executableHere: foundations.has(id),
    source: 'TM8-AGENT-HARNESS-AND-COMMAND-DISCOVERY.md §20',
    assertion: HARNESS_ASSERTIONS[id]
      ?? `Named harness conformance case ${id}; semantic execution remains with ${owner}.`,
    operations: [],
  };
}

function numbered(prefix: string, count: number): readonly string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);
}

const HARNESS_IDS = [
  ...numbered('D', 7),
  ...numbered('B', 7),
  ...numbered('P', 10),
  ...numbered('C', 5),
  ...numbered('M', 12),
  ...numbered('R', 8),
  ...numbered('S', 6),
] as const;

const W0_IDS = [
  'W0-ACTIONS', 'W0-AUTH', 'W0-B1', 'W0-B2', 'W0-BATCH', 'W0-CONN',
  'W0-CONTEXT', 'W0-CURSOR', 'W0-DEFAULT', 'W0-EVENT', 'W0-FEED',
  'W0-HANDOFF', 'W0-INBOX', 'W0-MENU', 'W0-OWNED', 'W0-PROFILE',
  'W0-PROJ', 'W0-SPAWN', 'W0-VERSION',
] as const;

const entries: Array<[string, ConformanceCase]> = [
  ...HARNESS_IDS.map((id) => [id, harnessCase(id)] as [string, ConformanceCase]),
  ...W0_IDS.map((id) => [id, {
    owner: 'W2-W5',
    status: 'semantic-pending',
    executableHere: false,
    source: 'TM8-W0-CONSISTENCY-MATRICES.md §3',
    assertion: `Dossier suite ${id} is catalogued for later public-boundary execution.`,
    operations: [],
  }] as [string, ConformanceCase]),
  ['W1-A03-A20-SHARED-SETTINGS-REVISION', {
    owner: 'W1.B',
    status: 'foundation',
    executableHere: false,
    source: 'TM8-W1-PREFLIGHT-AND-INTEGRATION-EVIDENCE.md §8.3',
    assertion: 'A03 and A20 share one Space settings revision; concurrent writes using one expected revision cannot both commit.',
    operations: ['spaces.defaultChannel.set', 'spaces.interactionProfile.setDefault'],
  }],
  ['W1-PROMPT-HELP-INTERNAL', {
    owner: 'W1.C',
    status: 'foundation',
    executableHere: true,
    source: 'TM8-W0-AMENDMENT-DOSSIER.md §§5.1,6.5',
    assertion: 'execution.prompt exact help is internal/use_message_send, has no invocation syntax, and points to messages.post.',
    operations: ['execution.prompt', 'messages.post'],
  }],
  ['W1-RESERVED-HONESTY', {
    owner: 'W1.C',
    status: 'foundation',
    executableHere: true,
    source: 'TM8-W0-AMENDMENT-DOSSIER.md §10',
    assertion: 'Both reserved operations are route-reachable and return honest 501/not_implemented rather than 404.',
    operations: ['search.query', 'bridge.fetchBlob'],
  }],
  ['W1-WS-SKELETON', {
    owner: 'W1.C',
    status: 'foundation',
    executableHere: true,
    source: 'TM8-W0-AMENDMENT-DOSSIER.md §§3,9,10',
    assertion: 'events.subscribe is one WS skeleton and makes no semantic durability claim.',
    operations: ['events.subscribe'],
  }],
];

export const CONFORMANCE_CASES: Readonly<Record<string, ConformanceCase>> = Object.freeze(
  Object.fromEntries(entries),
);
