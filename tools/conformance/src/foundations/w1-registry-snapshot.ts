import * as ContractExports from '@tm8/contract';
import {
  OPERATIONS,
  isOperationName,
  type OperationName,
} from '@tm8/contract';

type ContractSchemaName = Extract<keyof typeof ContractExports, `${string}Schema`>;

export interface HistoricalW1InputSchemaBinding {
  readonly operation: OperationName;
  readonly schema: ContractSchemaName;
}

export interface HistoricalW1RegistrySnapshot {
  readonly handlers: {
    readonly total: number;
    readonly facade: number;
    readonly execution: number;
    readonly events: number;
    readonly operations: readonly OperationName[];
  };
  readonly inputSchemas: {
    readonly bound: readonly HistoricalW1InputSchemaBinding[];
    readonly unboundCommands: readonly OperationName[];
  };
}

const W1_FACADE_HANDLERS = [
  'identity.get',
  'spaces.list',
  'spaces.create',
  'spaces.get',
  'spaces.home',
  'spaces.navigation',
  'projects.list',
  'projects.create',
  'projects.get',
  'projects.update',
  'projects.link',
  'entities.get',
  'entities.create',
  'entities.patch',
  'entities.children',
  'entities.activity',
  'entities.points.add',
  'edges.create',
  'collections.query',
  'messages.list',
  'messages.post',
  'entities.commands.work',
  'entities.commands.complete',
] as const satisfies readonly OperationName[];

const W1_EXECUTION_HANDLERS = [
  'execution.spawn',
  'execution.prompt',
  'execution.terminate',
  'execution.streams.attach',
] as const satisfies readonly OperationName[];

const W1_EVENT_HANDLERS = [
  'events.poll',
] as const satisfies readonly OperationName[];

const W1_INPUT_SCHEMA_BINDINGS = [
  { operation: 'spaces.create', schema: 'CreateSpaceInputSchema' },
  { operation: 'spaces.update', schema: 'UpdateSpaceInputSchema' },
  { operation: 'spaces.taskAxes.create', schema: 'TaskAxisInputSchema' },
  { operation: 'spaces.taskAxes.update', schema: 'TaskAxisInputSchema' },
  { operation: 'entities.create', schema: 'CreateEntityInputSchema' },
  { operation: 'entities.patch', schema: 'PatchEntityInputSchema' },
  { operation: 'entities.move', schema: 'MoveEntityInputSchema' },
  { operation: 'entities.react', schema: 'ReactionInputSchema' },
  { operation: 'entities.points.add', schema: 'GrantPointsInputSchema' },
  { operation: 'entities.commands.complete', schema: 'CompleteTaskInputSchema' },
  { operation: 'entities.commands.work', schema: 'WorkInputSchema' },
  { operation: 'entities.commands.pull', schema: 'PullInputSchema' },
  { operation: 'entities.commands.linkPr', schema: 'LinkPrInputSchema' },
  { operation: 'entities.commands.linkCommit', schema: 'LinkCommitInputSchema' },
  { operation: 'tracking.refresh', schema: 'TrackingRefreshInputSchema' },
  { operation: 'edges.create', schema: 'CreateEdgeInputSchema' },
  { operation: 'edges.patch', schema: 'PatchEdgeInputSchema' },
  { operation: 'messages.post', schema: 'PostMessageInputSchema' },
  { operation: 'messages.edit', schema: 'PatchMessageInputSchema' },
  { operation: 'collections.query', schema: 'CollectionQuerySchema' },
  { operation: 'graph.query', schema: 'GraphQuerySchema' },
  { operation: 'placements.apply', schema: 'PlacementInputSchema' },
  { operation: 'projects.create', schema: 'ProjectCreateInputSchema' },
  { operation: 'projects.update', schema: 'ProjectUpdateInputSchema' },
  { operation: 'projects.link', schema: 'ProjectLinkInputSchema' },
  { operation: 'files.uploadInit', schema: 'FileUploadInitInputSchema' },
  { operation: 'files.uploadComplete', schema: 'FileUploadCompleteInputSchema' },
  { operation: 'files.uploadAbort', schema: 'FileUploadAbortInputSchema' },
  { operation: 'savedViews.create', schema: 'SavedViewInputSchema' },
  { operation: 'savedViews.update', schema: 'SavedViewInputSchema' },
  { operation: 'execution.spawn', schema: 'ExecutionSpawnInputSchema' },
  { operation: 'execution.prompt', schema: 'ExecutionPromptInputSchema' },
  { operation: 'execution.terminate', schema: 'ExecutionTerminateInputSchema' },
  { operation: 'execution.streams.attach', schema: 'ExecutionStreamsAttachInputSchema' },
  { operation: 'entityKinds.create', schema: 'EntityKindCreateInputSchema' },
  { operation: 'entityKinds.update', schema: 'EntityKindUpdateInputSchema' },
] as const satisfies readonly HistoricalW1InputSchemaBinding[];

const W1_UNBOUND_COMMANDS = [
  'entities.delete',
  'entities.restore',
  'edges.delete',
  'messages.delete',
  'commands.undo',
  'inbox.markRead',
  'readMarks.upsert',
  'savedViews.delete',
  'spaces.invites.create',
  'spaces.invites.revoke',
  'spaces.invites.redeem',
  'spaces.taskAxes.delete',
  'projects.unlink',
] as const satisfies readonly OperationName[];

const OPERATION_BY_NAME = new Map(OPERATIONS.map((operation) => [operation.name, operation]));

function assertExactCount(actual: number, expected: number, label: string): void {
  if (actual !== expected) {
    throw new Error(`historical W1 ${label} drift: expected ${expected}, got ${actual}`);
  }
}

function assertUniqueOperations(names: readonly string[], context: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!isOperationName(name)) {
      throw new Error(`historical W1 ${context} references unknown catalog operation ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`historical W1 ${context} contains duplicate operation ${name}`);
    }
    seen.add(name);
  }
}

function validateHistoricalW1RegistrySnapshot(snapshot: HistoricalW1RegistrySnapshot): void {
  assertExactCount(W1_FACADE_HANDLERS.length, 23, 'facade handler total');
  assertExactCount(W1_EXECUTION_HANDLERS.length, 4, 'execution handler total');
  assertExactCount(W1_EVENT_HANDLERS.length, 1, 'event handler total');
  assertExactCount(snapshot.handlers.facade, 23, 'facade handler accounting');
  assertExactCount(snapshot.handlers.execution, 4, 'execution handler accounting');
  assertExactCount(snapshot.handlers.events, 1, 'event handler accounting');
  assertExactCount(snapshot.handlers.total, 28, 'semantic handler accounting');
  assertExactCount(snapshot.handlers.operations.length, 28, 'semantic handler operation total');
  assertExactCount(snapshot.inputSchemas.bound.length, 36, 'input-schema binding total');
  assertExactCount(snapshot.inputSchemas.unboundCommands.length, 13, 'unbound command total');

  const groupedHandlers = [
    ...W1_FACADE_HANDLERS,
    ...W1_EXECUTION_HANDLERS,
    ...W1_EVENT_HANDLERS,
  ];
  assertUniqueOperations(groupedHandlers, 'handler registry');
  const sortedHandlers = [...groupedHandlers].sort();
  if (JSON.stringify(snapshot.handlers.operations) !== JSON.stringify(sortedHandlers)) {
    throw new Error('historical W1 handler operation snapshot does not match its typed groups');
  }
  for (const name of snapshot.handlers.operations) {
    const operation = OPERATION_BY_NAME.get(name);
    if (!operation || operation.method === 'WS' || operation.status !== 'v1') {
      throw new Error(`historical W1 handler ${name} is not a registerable v1 HTTP operation`);
    }
  }

  assertUniqueOperations(
    snapshot.inputSchemas.bound.map(({ operation }) => operation),
    'input-schema bindings',
  );
  for (const { operation, schema } of snapshot.inputSchemas.bound) {
    const contractSchema: unknown = ContractExports[schema];
    if (
      (typeof contractSchema !== 'object' && typeof contractSchema !== 'function')
      || contractSchema === null
      || typeof (contractSchema as { safeParse?: unknown }).safeParse !== 'function'
    ) {
      throw new Error(`historical W1 ${operation} references unknown contract schema ${schema}`);
    }
  }

  assertUniqueOperations(snapshot.inputSchemas.unboundCommands, 'unbound commands');
  const bound = new Set(snapshot.inputSchemas.bound.map(({ operation }) => operation));
  for (const name of snapshot.inputSchemas.unboundCommands) {
    const operation = OPERATION_BY_NAME.get(name);
    if (!operation || operation.kind !== 'command') {
      throw new Error(`historical W1 unbound entry ${name} is not a catalog command`);
    }
    if (bound.has(name)) {
      throw new Error(`historical W1 operation ${name} is both bound and unbound`);
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

const historicalW1RegistrySnapshot = {
  handlers: {
    total: 28,
    facade: 23,
    execution: 4,
    events: 1,
    operations: [
      ...W1_FACADE_HANDLERS,
      ...W1_EXECUTION_HANDLERS,
      ...W1_EVENT_HANDLERS,
    ].sort(),
  },
  inputSchemas: {
    bound: W1_INPUT_SCHEMA_BINDINGS.map(({ operation, schema }) => ({ operation, schema })),
    unboundCommands: [...W1_UNBOUND_COMMANDS],
  },
} satisfies HistoricalW1RegistrySnapshot;

validateHistoricalW1RegistrySnapshot(historicalW1RegistrySnapshot);

export const HISTORICAL_W1_REGISTRY_SNAPSHOT = deepFreeze(historicalW1RegistrySnapshot);

export function readHistoricalW1RegistrySnapshot(): HistoricalW1RegistrySnapshot {
  validateHistoricalW1RegistrySnapshot(HISTORICAL_W1_REGISTRY_SNAPSHOT);
  return HISTORICAL_W1_REGISTRY_SNAPSHOT;
}
