/**
 * Command input validation — contract §4 preamble: malformed input is a 400
 * `invalid_input`, never a silent no-op or a partial write.
 *
 * Hand-rolled and table-driven on purpose (no schema deps in collab-v2): each
 * command declares its field table below and `assertInput` walks it. Rules:
 *
 *  - Unknown fields ALWAYS reject — including on patch-partial commands
 *    (patchTask / patchEntity / updateTaskAxis / updateSavedView), where every
 *    field is optional but a key the contract doesn't name is a typo, never a
 *    no-op. That is exactly how `setWork({ workStatus: 'done' })` used to
 *    silently wipe `workStatus` (DEF-1). The only deliberately open objects
 *    are free-form prop bags the contract types as `Record<string, unknown>`
 *    (`createEdge.props`, `patchEdge.props`, saved-view `query`/`graphLayout`).
 *  - `undefined` values count as absent (JSON cannot express undefined).
 *  - `null` is accepted only where the contract marks the field nullable.
 *  - Enums are closed sets; wrong scalar types reject naming the expected type.
 *  - The CommandContext envelope (`actorId`, `clientMutationId`) is accepted
 *    on every command.
 *
 * Domain/semantic checks (empty title, zero points, version guards, edge-type
 * registry…) stay in `world.ts` next to the state they protect — this module
 * is shape, type, and enum validation only.
 */
import { CollabError, type EntityKind } from '../types/contract';

// ---------------------------------------------------------------------------
// Spec engine
// ---------------------------------------------------------------------------

export type FieldSpec =
  | { t: 'string' }
  | { t: 'number' }
  | { t: 'boolean' }
  | { t: 'enum'; values: readonly string[] }
  | { t: 'record'; values: FieldSpec }          // Record<string, V>
  | { t: 'array'; items: FieldSpec }
  | { t: 'object'; fields?: FieldTable; open?: boolean }
  | { t: 'any' };

export interface FieldRule { spec: FieldSpec; required?: boolean; nullable?: boolean }
export type FieldTable = Record<string, FieldRule>;

const fail = (command: string, msg: string): never => {
  throw new CollabError('invalid_input', `${command}: ${msg}`);
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkValue(command: string, path: string, value: unknown, spec: FieldSpec): void {
  switch (spec.t) {
    case 'any':
      return;
    case 'string':
      if (typeof value !== 'string') fail(command, `"${path}" must be a string`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(command, `"${path}" must be a finite number`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(command, `"${path}" must be a boolean`);
      return;
    case 'enum':
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        fail(command, `"${path}" must be one of ${spec.values.join('|')}, got ${JSON.stringify(value)}`);
      }
      return;
    case 'record': {
      if (!isPlainObject(value)) fail(command, `"${path}" must be an object`);
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) continue;
        checkValue(command, `${path}.${k}`, v, spec.values);
      }
      return;
    }
    case 'array': {
      if (!Array.isArray(value)) fail(command, `"${path}" must be an array`);
      (value as unknown[]).forEach((v, i) => checkValue(command, `${path}[${i}]`, v, spec.items));
      return;
    }
    case 'object': {
      if (!isPlainObject(value)) fail(command, `"${path}" must be an object`);
      if (spec.fields) checkTable(command, path, value as Record<string, unknown>, spec.fields, spec.open ?? false);
      return;
    }
  }
}

function checkTable(
  command: string, path: string, obj: Record<string, unknown>, fields: FieldTable, open: boolean,
): void {
  const at = (key: string): string => (path ? `${path}.${key}` : key);
  for (const [key, rule] of Object.entries(fields)) {
    const value = obj[key];
    if (value === undefined) {
      if (rule.required) fail(command, `missing required field "${at(key)}"`);
      continue;
    }
    if (value === null) {
      if (!rule.nullable) fail(command, `"${at(key)}" must not be null`);
      continue;
    }
    checkValue(command, at(key), value, rule.spec);
  }
  if (open) return;
  const allowed = Object.keys(fields);
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) continue;       // absent per JSON semantics
    if (!allowed.includes(key)) {
      fail(command, `unknown field "${at(key)}" (allowed: ${allowed.join(', ')})`);
    }
  }
}

/** Envelope fields accepted on every command (§4 preamble). */
const CONTEXT_FIELDS: FieldTable = {
  actorId: { spec: { t: 'string' } },
  clientMutationId: { spec: { t: 'string' } },
};

/** Validate a command input object against its field table (+ context). */
export function assertInput(command: string, input: unknown, fields: FieldTable): void {
  if (!isPlainObject(input)) fail(command, 'input must be an object');
  checkTable(command, '', input as Record<string, unknown>, { ...CONTEXT_FIELDS, ...fields }, false);
}

/**
 * Validate a `content` payload against the kind's key table. No table for the
 * kind → skip (the command rejects that kind with its own precise error).
 */
export function assertContent(command: string, content: unknown, table: FieldTable | undefined): void {
  if (content === undefined || table === undefined) return;
  if (!isPlainObject(content)) fail(command, '"content" must be an object');
  checkTable(command, 'content', content as Record<string, unknown>, table, false);
}

// ---------------------------------------------------------------------------
// Shared field specs (contract enums + nested shapes)
// ---------------------------------------------------------------------------

const STR: FieldSpec = { t: 'string' };
const NUM: FieldSpec = { t: 'number' };
const WORK_STATUS: FieldSpec = { t: 'enum', values: ['open', 'pulled', 'working', 'in_review', 'done', 'blocked', 'cancelled'] };
const PRIORITY: FieldSpec = { t: 'enum', values: ['low', 'medium', 'high', 'urgent'] };
const DOC_FORMAT: FieldSpec = { t: 'enum', values: ['markdown', 'mermaid', 'excalidraw'] };
const PR_STATE: FieldSpec = { t: 'enum', values: ['open', 'merged', 'closed', 'draft'] };
const AXES: FieldSpec = { t: 'record', values: STR };
const OPEN_OBJECT: FieldSpec = { t: 'object', open: true };

const ACCEPTANCE_ITEM: FieldSpec = { t: 'object', fields: {
  text: { spec: STR, required: true },
  id: { spec: STR },
  done: { spec: { t: 'boolean' } },
  doneBy: { spec: STR },
  doneAt: { spec: STR },
} };
const MENTION_ITEM: FieldSpec = { t: 'object', fields: {
  entityId: { spec: STR, required: true },
  kind: { spec: { t: 'enum', values: ['member', 'team_member'] }, required: true },
  display: { spec: STR, required: true },
} };
const ATTACHMENT_ITEM: FieldSpec = { t: 'object', fields: {
  fileEntityId: { spec: STR, required: true },
  name: { spec: STR, required: true },
  mime: { spec: STR, required: true },
} };
const ATTACH_TO: FieldSpec = { t: 'object', fields: {
  entityId: { spec: STR, required: true },
  edgeType: { spec: { t: 'enum', values: ['attached_to', 'relates_to'] }, required: true },
} };

/** Task payload fields shared by the direct and generic (content-riding) routes. */
const TASK_PAYLOAD: FieldTable = {
  description: { spec: STR },
  axes: { spec: AXES },
  priority: { spec: PRIORITY },
  acceptanceCriteria: { spec: { t: 'array', items: ACCEPTANCE_ITEM } },
  pointsEstimate: { spec: NUM, nullable: true },
  dueDate: { spec: STR, nullable: true },
};

// ---------------------------------------------------------------------------
// Per-command field tables
// ---------------------------------------------------------------------------

export const COMMAND_FIELDS: Record<string, FieldTable> = {
  createTask: {
    spaceId: { spec: STR, required: true },
    title: { spec: STR, required: true },
    parentId: { spec: STR, nullable: true },
    position: { spec: NUM },
    attachTo: { spec: ATTACH_TO },
    ...TASK_PAYLOAD,
  },
  // Patch-partial: every payload field optional, unknown keys still reject.
  patchTask: {
    expectedVersion: { spec: NUM, required: true },
    title: { spec: STR },
    workStatus: { spec: WORK_STATUS },
    ...TASK_PAYLOAD,
  },
  createEntity: {
    spaceId: { spec: STR, required: true },
    kind: { spec: { t: 'enum', values: ['task', 'channel', 'doc', 'file', 'spell', 'skill', 'pull_request', 'commit', 'team_member'] }, required: true },
    title: { spec: STR, required: true },
    parentId: { spec: STR, nullable: true },
    position: { spec: NUM },
    content: { spec: OPEN_OBJECT },             // keys checked per kind via CREATE_CONTENT
    attachTo: { spec: ATTACH_TO },
  },
  // Patch-partial: `content` keys checked per kind via PATCH_CONTENT.
  patchEntity: {
    expectedVersion: { spec: NUM, required: true },
    title: { spec: STR },
    content: { spec: OPEN_OBJECT },
  },
  moveEntity: {
    parentId: { spec: STR, required: true, nullable: true },  // explicit null = move to root
    position: { spec: NUM, required: true },
    expectedVersion: { spec: NUM, required: true },
  },
  createEdge: {
    srcId: { spec: STR, required: true },
    dstId: { spec: STR, required: true },
    type: { spec: STR, required: true },
    props: { spec: OPEN_OBJECT },
  },
  patchEdge: {
    props: { spec: OPEN_OBJECT, required: true },
  },
  placements: {
    sourceId: { spec: STR, required: true },
    targetId: { spec: STR, required: true },
    intent: { spec: { t: 'enum', values: ['attach', 'assign', 'depend', 'subtask', 'embed', 'reparent'] }, required: true },
    embedMessage: { spec: STR },
  },
  postMessage: {
    anchorId: { spec: STR, required: true },
    body: { spec: STR, required: true },
    parentMessageId: { spec: STR, nullable: true },
    mentions: { spec: { t: 'array', items: MENTION_ITEM } },
    attachments: { spec: { t: 'array', items: ATTACHMENT_ITEM } },
  },
  patchMessage: {
    body: { spec: STR, required: true },
    mentions: { spec: { t: 'array', items: MENTION_ITEM } },
  },
  setReaction: {
    reaction: { spec: { t: 'enum', values: ['like', 'dislike', 'star'] }, required: true },
    enabled: { spec: { t: 'boolean' }, required: true },
  },
  grantPoints: {
    amount: { spec: NUM, required: true },
    reason: { spec: { t: 'enum', values: ['grant', 'award', 'seed'] }, required: true },
    referenceId: { spec: STR },
  },
  completeTask: {
    expectedVersion: { spec: NUM, required: true },
    completerIds: { spec: { t: 'array', items: STR }, required: true },
  },
  pullEntity: {
    localId: { spec: STR, nullable: true },
    pinnedVersion: { spec: NUM, required: true },
  },
  setWork: {
    status: { spec: WORK_STATUS, required: true },
    startedAt: { spec: STR },
    note: { spec: STR, nullable: true },
  },
  linkPr: {
    url: { spec: STR, required: true },
  },
  trackingRefresh: {
    entityIds: { spec: { t: 'array', items: STR } },
  },
  createProjectFromRepo: {
    repoUrl: { spec: STR, required: true },
    name: { spec: STR },
  },
  createTaskAxis: {
    name: { spec: STR, required: true },
    axisValues: { spec: { t: 'array', items: STR }, required: true },
    kind: { spec: { t: 'enum', values: ['default', 'manual'] }, required: true },
    position: { spec: NUM, required: true },
  },
  // Patch-partial variant of createTaskAxis.
  updateTaskAxis: {
    name: { spec: STR },
    axisValues: { spec: { t: 'array', items: STR } },
    kind: { spec: { t: 'enum', values: ['default', 'manual'] } },
    position: { spec: NUM },
  },
  createSavedView: {
    name: { spec: STR, required: true },
    shareMode: { spec: { t: 'enum', values: ['private', 'space'] }, required: true },
    query: { spec: OPEN_OBJECT, required: true },     // CollectionQuery — free-form by contract
    graphLayout: { spec: OPEN_OBJECT },
  },
  // Patch-partial variant of createSavedView.
  updateSavedView: {
    name: { spec: STR },
    shareMode: { spec: { t: 'enum', values: ['private', 'space'] } },
    query: { spec: OPEN_OBJECT },
    graphLayout: { spec: OPEN_OBJECT },
  },
  /** Context-only commands (deleteEntity, deleteEdge, deleteMessage, undo, markRead, markNotificationRead). */
  contextOnly: {},
};

// ---------------------------------------------------------------------------
// Kind-typed `content` key tables (DEV-1 generic routes)
// ---------------------------------------------------------------------------

/** createEntity content keys per kind (mirrors what world.createEntity reads). */
export const CREATE_CONTENT: Partial<Record<EntityKind, FieldTable>> = {
  task: TASK_PAYLOAD,
  channel: { topic: { spec: STR } },
  doc: { body: { spec: STR }, format: { spec: DOC_FORMAT } },
  file: { mimeType: { spec: STR }, sizeBytes: { spec: NUM }, storagePath: { spec: STR } },
  spell: { description: { spec: STR } },
  skill: { description: { spec: STR }, content: { spec: STR } },
  pull_request: {
    provider: { spec: STR }, url: { spec: STR }, repo: { spec: STR }, repository: { spec: STR },
    number: { spec: NUM }, state: { spec: PR_STATE }, headSha: { spec: STR },
  },
  commit: {
    repo: { spec: STR }, repository: { spec: STR }, sha: { spec: STR },
    message: { spec: STR }, author: { spec: STR }, url: { spec: STR },
  },
  team_member: {
    ownerMemberId: { spec: STR }, role: { spec: STR }, identity: { spec: STR },
    model: { spec: STR }, agentTool: { spec: STR }, mode: { spec: STR }, avatar: { spec: STR },
  },
};

/**
 * patchEntity content keys per kind (mirrors what world.patchEntity applies).
 * Kinds absent here (message/member/commit) reject in the command itself with
 * their own precise error; task adds workStatus on top of the create payload.
 */
export const PATCH_CONTENT: Partial<Record<EntityKind, FieldTable>> = {
  task: { ...TASK_PAYLOAD, workStatus: { spec: WORK_STATUS } },
  channel: { topic: { spec: STR } },
  doc: { body: { spec: STR }, format: { spec: DOC_FORMAT } },
  file: {},                                     // only the title is patchable
  spell: { description: { spec: STR } },
  skill: { description: { spec: STR }, content: { spec: STR } },
  pull_request: { state: { spec: PR_STATE }, headSha: { spec: STR } },
  team_member: {
    identity: { spec: STR }, model: { spec: STR },
    memories: { spec: { t: 'array', items: { t: 'any' } } },
  },
};
