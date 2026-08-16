import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CoreEntityKindSchema,
  OPERATIONS,
  RESERVED_OPERATIONS,
  V1_OPERATIONS,
  isOperationName,
  type OperationBinding,
  type OperationName,
} from '@tm8/contract';
import { CONFORMANCE_CASES, type ConformanceCase } from './conformance-cases.js';
import {
  CORE_KIND_DISPOSITIONS,
  CUSTOM_KIND_DISPOSITION,
  UI_TEMPLATE_SENTINEL,
  assertKindDispositionTotality,
} from './kind-dispositions.js';
import {
  readW1MigrationInventory,
  type W1MigrationObjectInventory,
} from './migration-inventory.js';
import {
  ADDITIVE_SCHEMA_DISPOSITIONS,
  POST_DOSSIER_SCHEMA_DISPOSITIONS,
  FROZEN_SCHEMA_DISPOSITIONS,
  resolveSchema,
  schemaDispositionFor,
} from './schema-dispositions.js';
import {
  readRouterSourceInventory,
  repositoryRoot,
} from './source-inventory.js';
import { readHistoricalW1RegistrySnapshot } from './w1-registry-snapshot.js';

export const ADDITIVE_OPERATION_NAMES = [
  'spaces.menu.get',
  'spaces.menu.update',
  'spaces.defaultChannel.set',
  'projects.associations.correct',
  'handoffs.send',
  'handoffs.list',
  'handoffs.withdraw',
  'messages.attachments.add',
  'messages.attachments.remove',
  'messages.delivery.get',
  'entities.feed',
  'entities.context',
  'interactionProfiles.propose',
  'interactionProfiles.updateDraft',
  'interactionProfiles.validate',
  'interactionProfiles.preview',
  'interactionProfiles.activate',
  'interactionProfiles.retire',
  'teamMembers.interactionProfile.setDefault',
  'spaces.interactionProfile.setDefault',
  'execution.liveness',
] as const satisfies readonly OperationName[];

/** Catalog rows added after the A01-A21 dossier closed. */
export const POST_DOSSIER_OPERATION_NAMES = [
  'execution.dispatch',
  'chat.threads.start',
] as const satisfies readonly OperationName[];

export const FROZEN_SCHEMA_OPERATION_NAMES = [
  'attentionRequests.list',
  'attentionRequests.create',
  'attentionRequests.update',
  'attentionRequests.resolveEntity',
  'messages.post',
  'messages.edit',
  'messages.delete',
  'entities.create',
  'entities.connections',
  'files.uploadComplete',
  'execution.spawn',
  'execution.prompt',
  'entities.commands.linkPr',
  'entities.commands.linkCommit',
  'inbox.list',
  'inbox.markRead',
  'actions.list',
  'events.subscribe',
] as const satisfies readonly OperationName[];

type HttpMethod = Exclude<OperationBinding['method'], 'WS'>;
type HelpExposure = 'public' | 'composite' | 'internal' | 'reserved';

export interface OperationHelpFoundation {
  readonly operation: OperationName;
  readonly noun: string;
  readonly exposure: HelpExposure;
  readonly helpRef: string;
  readonly intentTags: readonly string[];
  readonly inputSchemaRef: string | null;
  readonly resultSchemaRef: string | null;
  readonly invocationSyntax: null;
  readonly actionDiscoverable: boolean;
  readonly reason: string | null;
  readonly publicComposite: OperationName | null;
}

export interface W1ConformanceManifest {
  readonly schemaVersion: 'tm8.conformance.w1.v1';
  readonly catalogDigest: string;
  readonly catalog: {
    readonly total: number;
    readonly v1: number;
    readonly reserved: number;
    readonly http: number;
    readonly ws: number;
    readonly registerableV1Http: number;
    readonly methods: Record<OperationBinding['method'], number>;
    readonly kinds: Record<OperationBinding['kind'], number>;
    readonly uniqueNames: number;
    readonly uniqueBindings: number;
  };
  readonly reservedOperations: readonly OperationName[];
  readonly additiveOperations: readonly (OperationBinding & { semanticStatus: 'unimplemented' | 'registered' })[];
  readonly routes: {
    readonly http: readonly {
      operation: OperationName;
      method: HttpMethod;
      path: string;
      status: 'registered' | 'reserved';
      source: 'server-router';
    }[];
    readonly ws: readonly {
      operation: OperationName;
      method: 'WS';
      path: string;
      status: 'skeleton';
      durabilityClaim: false;
    }[];
  };
  readonly serverRegistries: {
    readonly handlers: {
      readonly total: number;
      readonly facade: number;
      readonly execution: number;
      readonly events: number;
      readonly operations: readonly OperationName[];
    };
    readonly inputSchemas: {
      readonly bound: readonly { operation: OperationName; schema: string }[];
      readonly unboundCommands: readonly OperationName[];
    };
    readonly unimplementedV1Http: number;
  };
  readonly schemas: {
    readonly additive: typeof ADDITIVE_SCHEMA_DISPOSITIONS;
    readonly frozenAmendments: typeof FROZEN_SCHEMA_DISPOSITIONS;
  };
  readonly help: {
    readonly operations: readonly OperationHelpFoundation[];
    readonly rejectedLegacyAliases: readonly ['whoami', 'report', 'progress', 'session prompt'];
    readonly cliGrammarStatus: 'metadata-only-w1';
  };
  readonly kinds: {
    readonly core: typeof CORE_KIND_DISPOSITIONS;
    readonly custom: typeof CUSTOM_KIND_DISPOSITION;
    readonly negativeSentinel: typeof UI_TEMPLATE_SENTINEL;
  };
  readonly migration: {
    readonly status: 'finalized';
    readonly source: 'db/migrations/015_w1_foundations.sql';
    readonly finalized: true;
    readonly sha256: string;
    readonly objects: W1MigrationObjectInventory;
  };
  readonly conformanceCases: Readonly<Record<string, ConformanceCase>>;
}

const generatedDirectory = join(repositoryRoot, 'tools/conformance/generated');
export const generatedManifestPath = join(generatedDirectory, 'w1-conformance-manifest.json');

function countBy<T extends string>(values: readonly T[], expected: readonly T[]): Record<T, number> {
  const counts = Object.fromEntries(expected.map((value) => [value, 0])) as Record<T, number>;
  for (const value of values) {
    if (!(value in counts)) throw new Error(`unknown generated accounting value: ${value}`);
    counts[value] += 1;
  }
  return counts;
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} drift: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function nounForOperation(operation: OperationName): string {
  const family = operation.split('.')[0];
  switch (family) {
    case 'identity': return 'identity';
    case 'auth': return 'auth';
    case 'serverConnections': return 'server';
    case 'spaces': return 'space';
    case 'entities': return 'entity';
    case 'attentionRequests': return 'attention';
    case 'tracking': return 'tracking';
    case 'edges': return 'edge';
    case 'edgeTypes': return 'edge-type';
    case 'messages': return 'message';
    case 'collections': return 'collection';
    case 'graph': return 'graph';
    case 'placements': return 'placement';
    case 'commands': return 'undo';
    case 'search': return 'search';
    case 'projects': return 'project';
    case 'files': return 'file';
    case 'bridge': return 'bridge';
    case 'inbox': return 'inbox';
    case 'readMarks': return 'read-mark';
    case 'savedViews': return 'saved-view';
    case 'actions': return 'action';
    case 'events': return 'event';
    case 'presence': return 'presence';
    case 'execution': return 'session';
    case 'entityKinds': return 'kind';
    case 'handoffs': return 'handoff';
    case 'interactionProfiles': return 'interaction-profile';
    case 'teamMembers': return 'teammate';
    case 'voice': return 'voice';
    case 'artifacts': return 'artifact';
    // A noun is required even though all four `credentials.*` rows are
    // deliberately `cmd: null` — the manifest groups by noun regardless of
    // whether the noun has any invocable command today, and that is the right
    // shape: the operations are discoverable rather than hidden.
    case 'credentials': return 'credential';
    case 'chat': return 'chat-thread';
    default: throw new Error(`operation ${operation} has no noun/help disposition`);
  }
}

function intentTags(operation: OperationName): string[] {
  const words = operation
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[.\s]+/)
    .map((word) => word.toLowerCase());
  return [...new Set(words)];
}

function helpExposure(operation: OperationBinding): HelpExposure {
  switch (operation.status) {
    case 'reserved': return 'reserved';
    case 'v1':
      if (operation.name === 'execution.prompt') return 'internal';
      if (operation.name === 'messages.post') return 'composite';
      return 'public';
    default: throw new Error(`operation ${operation.name} has unknown status ${String(operation.status)}`);
  }
}

function helpForOperation(
  operation: OperationBinding,
  actualInputSchemas: ReadonlyMap<OperationName, string>,
): OperationHelpFoundation {
  const name = operation.name as OperationName;
  const exposure = helpExposure(operation);
  const schemaDisposition = schemaDispositionFor(name);
  const publicComposite = name === 'execution.prompt'
    ? 'messages.post'
    : name === 'search.query'
      ? 'actions.list'
      : null;
  return {
    operation: name,
    noun: nounForOperation(name),
    exposure,
    helpRef: `tm8://help/operation/${name}`,
    intentTags: intentTags(name),
    inputSchemaRef: schemaDisposition?.requestSchema
      ?? actualInputSchemas.get(name)
      ?? null,
    resultSchemaRef: schemaDisposition?.resultSchema ?? null,
    invocationSyntax: null,
    actionDiscoverable: exposure === 'public' || exposure === 'composite',
    reason: name === 'execution.prompt'
      ? 'use_message_send'
      : exposure === 'reserved'
        ? 'not_implemented'
        : null,
    publicComposite,
  };
}

function verifySchemaReachability(): void {
  assertEqual(Object.keys(ADDITIVE_SCHEMA_DISPOSITIONS), [...ADDITIVE_OPERATION_NAMES], 'A01-A21 schema order');
  assertEqual(
    Object.keys(POST_DOSSIER_SCHEMA_DISPOSITIONS),
    [...POST_DOSSIER_OPERATION_NAMES],
    'post-dossier schema order',
  );
  assertEqual(Object.keys(FROZEN_SCHEMA_DISPOSITIONS), [...FROZEN_SCHEMA_OPERATION_NAMES], 'frozen-row schema order');
  for (const disposition of [
    ...Object.values(ADDITIVE_SCHEMA_DISPOSITIONS),
    ...Object.values(FROZEN_SCHEMA_DISPOSITIONS),
  ]) {
    if (disposition.requestSchema !== null) resolveSchema(disposition.requestSchema);
    resolveSchema(disposition.resultSchema);
  }
}

export async function buildW1ConformanceManifest(): Promise<W1ConformanceManifest> {
  const [router, migration] = await Promise.all([
    readRouterSourceInventory(),
    readW1MigrationInventory(),
  ]);
  const { handlers, inputSchemas } = readHistoricalW1RegistrySnapshot();

  const names = OPERATIONS.map(({ name }) => name);
  const bindings = OPERATIONS.map(({ method, path }) => `${method} ${path}`);
  const methods = countBy(
    OPERATIONS.map(({ method }) => method),
    ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'WS'],
  );
  const kinds = countBy(
    OPERATIONS.map(({ kind }) => kind),
    ['read', 'command', 'stream'],
  );
  // W1 amendments A01-A21 are no longer the catalog tail once feature ops
  // (artifacts, …) append after them, so extract them by name in catalog order
  // rather than by trailing slice.
  const additiveNames = new Set<string>(ADDITIVE_OPERATION_NAMES);
  const additive = OPERATIONS.filter(({ name }) => additiveNames.has(name));

  // A21 (execution.liveness) is the +1 on the catalog, GET, read, router and
  // execution-handler axes — the first IMPLEMENTED additive operation.
  // 127 -> 128 (2026-08-07): `execution.transcript`, one GET read.
  // 128 -> 129 (2026-08-09): `projects.branches.list`, one GET read.
  // 129 -> 131: projects.contention (GET/read) + entities.commands.gate (POST/command).
  // 131 -> 135: credentials.* (1 GET/read, 1 DELETE/command, 2 POST/command).
  // 135 -> 137: projects.files.list (GET/read) + projects.files.attach (POST/command).
  // 137 -> 138 (2026-08-09): `execution.dispatch`, one POST command.
  // 138 -> 142 (2026-08-10, files consolidation): projects.files.read (GET/read)
  // + projects.folderUploads.init/complete/abort (3 POST commands).
  // 142 -> 144 (2026-08-12): collections.addItem (POST command) +
  // collections.removeItem (DELETE command) — collection membership writes.
  // 144 -> 150 (2026-08-12, Git UI landing): execution.gitStatus + gitDiff
  // (GET reads) and gitCheckpoint/gitRollback/gitCommit/gitMerge (POST
  // commands) — the session git rail behind the facade.
  // 150 -> 152 (2026-08-12, Git UI landing): projects.file.history + projects.file.blame (GET reads) — FileInspector's two survey reads.
  // 152 -> 155 (2026-08-12, Git UI landing): execution.gitCherryPick/gitBranch/gitStash (POST commands) — Tier 2 completion on the session rail.
  // 155 -> 156 (2026-08-13, merge): execution.terminal.start joins from main (#161).
  // 157 -> 158 (2026-08-13, forge write): tracking.pr.merge (POST command) —
  // the one guarded write door to the forge.
  // 158 -> 163: unledgered upstream bumps (measured on origin/main 9b938647).
  // 163 -> 166 (2026-08-16, W4/132): spaces.taskWorkflows.list (GET read) +
  // .upsert (POST command) + .delete (DELETE command).
  assertEqual(names.length, 166, 'catalog total');
  // 157 -> 159 (114): spaces.members.updateRole (PATCH command) and
  // auth.invite.resolve (POST read — the code rides in the body, never a URL).
  // 161 -> 164 (W4/132): the three taskWorkflows rows are v1.
  assertEqual(V1_OPERATIONS.length, 164, 'v1 total');
  assertEqual(RESERVED_OPERATIONS.map(({ name }) => name), ['search.query', 'bridge.fetchBlob'], 'reserved operations');
  assertEqual(additive.map(({ name }) => name), [...ADDITIVE_OPERATION_NAMES], 'A01-A21 order');
  assertEqual(new Set(names).size, names.length, 'unique operation names');
  assertEqual(new Set(bindings).size, bindings.length, 'unique method/path bindings');
  // W4/132: GET 59->60, POST 75->76, DELETE 10->11; read 63->64, command 99->101.
  assertEqual(methods, { GET: 60, POST: 76, PATCH: 11, DELETE: 11, PUT: 7, WS: 1 }, 'method accounting');
  assertEqual(kinds, { read: 64, command: 101, stream: 1 }, 'kind accounting');
  // W4/132: 162 -> 165, the three taskWorkflows routes.
  assertEqual(router.http.length, 165, 'server router HTTP total');
  assertEqual(router.ws.length, 1, 'server router WS total');
  // These four are SNAPSHOT self-checks (the frozen W1 registry boundary) and
  // never move with an amendment; A21's live handler shows up only in the
  // current-mounted-boundary inventory (W2.C01), not here.
  assertEqual(handlers.facade, 23, 'facade handler total');
  assertEqual(handlers.execution, 4, 'execution handler total');
  assertEqual(handlers.events, 1, 'event handler total');
  assertEqual(handlers.total, 28, 'semantic handler total');
  assertEqual(inputSchemas.bound.length, 36, 'actual input-schema binding total');
  assertEqual(inputSchemas.unboundCommands.length, 13, 'actual unbound-command total');
  assertKindDispositionTotality(CoreEntityKindSchema.options);
  assertEqual(
    Object.values(CORE_KIND_DISPOSITIONS)
      .filter(({ migration: disposition }) => disposition.strategy.startsWith('w1-'))
      .map(({ kind }) => kind),
    migration.objects.entityKindSeeds,
    'W1 kind migration dispositions',
  );
  verifySchemaReachability();

  const implemented = new Set<OperationName>(handlers.operations);
  const actualInputSchemas = new Map(inputSchemas.bound.map(({ operation, schema }) => [operation, schema]));
  const registerableV1Http = OPERATIONS.filter(({ method, status }) => method !== 'WS' && status === 'v1');

  return {
    schemaVersion: 'tm8.conformance.w1.v1',
    catalogDigest: `sha256:${createHash('sha256').update(JSON.stringify(OPERATIONS)).digest('hex')}`,
    catalog: {
      total: OPERATIONS.length,
      v1: V1_OPERATIONS.length,
      reserved: RESERVED_OPERATIONS.length,
      http: router.http.length,
      ws: router.ws.length,
      registerableV1Http: registerableV1Http.length,
      methods,
      kinds,
      uniqueNames: new Set(names).size,
      uniqueBindings: new Set(bindings).size,
    },
    reservedOperations: RESERVED_OPERATIONS.map(({ name }) => name as OperationName),
    additiveOperations: additive.map((operation) => ({
      ...operation,
      semanticStatus: implemented.has(operation.name as OperationName) ? 'registered' : 'unimplemented',
    })),
    routes: {
      http: router.http.map((operation) => ({
        operation: operation.name as OperationName,
        method: operation.method as HttpMethod,
        path: operation.path,
        status: operation.status === 'reserved' ? 'reserved' : 'registered',
        source: 'server-router',
      })),
      ws: router.ws.map((operation) => ({
        operation: operation.name as OperationName,
        method: 'WS',
        path: operation.path,
        status: 'skeleton',
        durabilityClaim: false,
      })),
    },
    serverRegistries: {
      handlers,
      inputSchemas,
      unimplementedV1Http: registerableV1Http.filter(({ name }) => !implemented.has(name as OperationName)).length,
    },
    schemas: {
      additive: ADDITIVE_SCHEMA_DISPOSITIONS,
      frozenAmendments: FROZEN_SCHEMA_DISPOSITIONS,
    },
    help: {
      operations: OPERATIONS.map((operation) => helpForOperation(operation, actualInputSchemas)),
      rejectedLegacyAliases: ['whoami', 'report', 'progress', 'session prompt'],
      cliGrammarStatus: 'metadata-only-w1',
    },
    kinds: {
      core: CORE_KIND_DISPOSITIONS,
      custom: CUSTOM_KIND_DISPOSITION,
      negativeSentinel: UI_TEMPLATE_SENTINEL,
    },
    migration: {
      status: 'finalized',
      source: migration.source,
      finalized: true,
      sha256: migration.sha256,
      objects: migration.objects,
    },
    conformanceCases: CONFORMANCE_CASES,
  };
}

export function renderW1ConformanceManifest(manifest: W1ConformanceManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function exactOperationHelp(
  manifest: W1ConformanceManifest,
  operation: string,
): OperationHelpFoundation {
  if (!isOperationName(operation)) throw new Error(`unknown catalog operation: ${operation}`);
  const help = manifest.help.operations.find((entry) => entry.operation === operation);
  if (!help) throw new Error(`missing exact-operation help: ${operation}`);
  return help;
}

export async function writeW1ConformanceManifest(): Promise<void> {
  await mkdir(generatedDirectory, { recursive: true });
  await writeFile(
    generatedManifestPath,
    renderW1ConformanceManifest(await buildW1ConformanceManifest()),
    'utf8',
  );
}

export async function checkW1ConformanceManifest(): Promise<void> {
  const expected = renderW1ConformanceManifest(await buildW1ConformanceManifest());
  const actual = await readFile(generatedManifestPath, 'utf8');
  if (actual !== expected) {
    throw new Error(
      `generated conformance evidence is stale: run bun run generate (${generatedManifestPath})`,
    );
  }
}
