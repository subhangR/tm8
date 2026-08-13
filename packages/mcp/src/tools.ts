/**
 * Five hierarchical graph tools, not one tool per catalog operation.
 *
 * Calling a group with no `operation` returns its next-level operation
 * directory and request templates. Only the selected directory enters the
 * model's context. Calls then dispatch by catalog operation name through the
 * same HTTP facade as every other client.
 */
import { randomUUID } from 'node:crypto';
import { getOperation, OPERATIONS, type OperationName } from '@tm8/contract';
import {
  CatalogHttpError,
  type CatalogInvokeOptions,
  type CatalogTransport,
  type QueryValue,
} from './catalog-client.js';

export const MCP_TOOL_NAMES = [
  'tm8_overview',
  'tm8_read',
  'tm8_act',
  'tm8_delegate',
  'tm8_messages',
] as const;

export type Tm8McpToolName = (typeof MCP_TOOL_NAMES)[number];

export interface McpToolDefinition {
  name: Tm8McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

interface OperationGuide {
  operation: OperationName;
  summary: string;
  request: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  };
}

const READ_GUIDES = [
  guide('entities.context', 'Bounded orientation read with hierarchy, recent messages and allowed actions.', {
    params: { id: '<entity-id>' },
    query: { sections: 'summary,hierarchy,connections,messages,actions' },
  }),
  guide('entities.get', 'Read one entity in full.', { params: { id: '<entity-id>' } }),
  guide('entities.feed', 'Page the merged message and activity timeline for an entity.', {
    params: { id: '<entity-id>' }, query: { limit: '50' },
  }),
  guide('entities.children', 'Page direct children.', { params: { id: '<entity-id>' }, query: { limit: '50' } }),
  guide('entities.hierarchy', 'Read ancestors/descendants around an entity.', { params: { id: '<entity-id>' } }),
  guide('entities.connections', 'Read typed graph connections.', { params: { id: '<entity-id>' }, query: { limit: '50' } }),
  guide('entities.versions', 'Read version history.', { params: { id: '<entity-id>' }, query: { limit: '50' } }),
  guide('collections.query', 'Find entities by space, kind, status, assignee, hierarchy or edge.', {
    body: { spaceId: '<space-id>', kinds: ['task'], filters: { workStatus: ['working'] }, limit: 50 },
  }),
  guide('graph.query', 'Traverse the entity graph from a focus.', {
    body: { spaceId: '<space-id>', focusId: '<entity-id>', hops: 2, limit: 100 },
  }),
  guide('edges.list', 'Page edges with source, target and type filters.', { query: { limit: '50' } }),
  guide('edgeTypes.list', 'Read the registered graph relationship vocabulary.', {}),
  guide('attentionRequests.list', 'Read open human-attention requests.', { query: { limit: '50' } }),
  guide('inbox.list', 'Read the requesting human/persona inbox.', { query: { unread: 'true', limit: '50' } }),
  guide('actions.list', 'Discover currently allowed actions for an entity.', { query: { contextEntityId: '<entity-id>' } }),
  guide('events.poll', 'Page durable space events after a sequence.', {
    params: { spaceId: '<space-id>' }, query: { since: '0', limit: '50' },
  }),
] as const satisfies readonly OperationGuide[];

const ACT_GUIDES = [
  guide('entities.create', 'Create a graph entity (including a task).', {
    body: { spaceId: '<space-id>', kind: 'task', title: '<title>', content: {} },
  }),
  guide('entities.patch', 'Patch an entity under an expected-version guard.', {
    params: { id: '<entity-id>' }, body: { expectedVersion: 1, title: '<title>' },
  }),
  guide('entities.move', 'Move an entity in its hierarchy.', {
    params: { id: '<entity-id>' }, body: { parentId: '<parent-id-or-null>', position: 0, expectedVersion: 1 },
  }),
  guide('entities.delete', 'Soft-delete an entity; it remains recoverable through restore.', {
    params: { id: '<entity-id>' }, body: { clientMutationId: '<optional-id>' },
  }),
  guide('entities.restore', 'Restore a soft-deleted entity.', {
    params: { id: '<entity-id>' }, body: { clientMutationId: '<optional-id>' },
  }),
  guide('entities.react', 'Set or clear like/dislike/star.', {
    params: { id: '<entity-id>' }, body: { reaction: 'star', enabled: true },
  }),
  guide('entities.points.add', 'Grant or award points with an audit reason.', {
    params: { id: '<entity-id>' }, body: { amount: 1, reason: 'grant' },
  }),
  guide('entities.commands.work', 'Move a task to an allowed work status.', {
    params: { id: '<task-id>' }, body: { status: 'working', note: '<optional-note>' },
  }),
  guide('entities.commands.complete', 'Complete a task at its current version.', {
    params: { id: '<task-id>' }, body: { expectedVersion: 1, completerIds: ['<actor-id>'] },
  }),
  guide('entities.commands.pull', 'Pull a task under a pinned-version guard.', {
    params: { id: '<task-id>' }, body: { pinnedVersion: 1 },
  }),
  guide('entities.commands.linkPr', 'Link a pull request URL to a task.', {
    params: { id: '<task-id>' }, body: { url: 'https://github.com/org/repo/pull/1' },
  }),
  guide('entities.commands.linkCommit', 'Link a commit URL to a task.', {
    params: { id: '<task-id>' }, body: { url: 'https://github.com/org/repo/commit/sha' },
  }),
  guide('edges.create', 'Create a typed graph relationship.', {
    body: { srcId: '<source-id>', dstId: '<target-id>', type: 'relates_to', props: {} },
  }),
  guide('edges.patch', 'Replace an edge property bag.', {
    params: { edgeId: '<edge-id>' }, body: { props: {} },
  }),
  guide('edges.delete', 'Delete a graph relationship, not either endpoint.', {
    params: { edgeId: '<edge-id>' }, body: { clientMutationId: '<optional-id>' },
  }),
  guide('placements.apply', 'Apply an attach/assign/depend/subtask/embed/reparent intent.', {
    body: { sourceId: '<source-id>', targetId: '<target-id>', intent: 'attach' },
  }),
  guide('attentionRequests.create', 'Raise a bounded human-attention request.', {
    params: { entityId: '<entity-id>' }, body: { reason: '<reason>', points: 50 },
  }),
  guide('attentionRequests.resolveEntity', 'Resolve every pending attention request on an entity.', {
    params: { entityId: '<entity-id>' }, body: { resolutionNote: '<optional-note>' },
  }),
  guide('collections.addItem', 'Add or reposition an entity in a collection.', {
    params: { id: '<collection-id>' }, body: { entityId: '<entity-id>' },
  }),
  guide('collections.removeItem', 'Remove collection membership without deleting the entity.', {
    params: { id: '<collection-id>', entityId: '<entity-id>' }, body: {},
  }),
] as const satisfies readonly OperationGuide[];

const DELEGATE_GUIDES = [
  guide('execution.dispatch', 'Route an entity to the resident dispatcher; it chooses the teammate.', {
    body: { spaceId: '<space-id>', subjectId: '<entity-id>', note: '<optional-steer>' },
  }),
  guide('execution.spawn', 'Start a durable worker session with an explicitly chosen teammate.', {
    body: { spaceId: '<space-id>', teamMemberId: '<team-member-id>', taskIds: ['<task-id>'], mode: 'worker' },
  }),
  guide('execution.terminate', 'End a worker session.', {
    params: { id: '<work-session-id>' }, body: { force: false },
  }),
  guide('execution.resume', 'Resume an exited worker with its provider-native conversation.', {
    params: { id: '<work-session-id>' }, body: {},
  }),
] as const satisfies readonly OperationGuide[];

const MESSAGE_GUIDES = [
  guide('messages.list', 'Page thread roots or replies anchored to an entity.', {
    params: { anchorId: '<anchor-id>' }, query: { limit: '50' },
  }),
  guide('messages.post', 'Post a durable message or direct threaded reply as the selected teammate.', {
    body: { anchorIds: ['<anchor-id>'], body: '<message>', parentMessageId: '<optional-parent-message-id>' },
  }),
  guide('messages.delivery.get', 'Read storage/delivery settlement for a posted message.', {
    params: { messageId: '<message-id>' },
  }),
] as const satisfies readonly OperationGuide[];

const GROUPS = {
  tm8_read: READ_GUIDES,
  tm8_act: ACT_GUIDES,
  tm8_delegate: DELEGATE_GUIDES,
  tm8_messages: MESSAGE_GUIDES,
} as const;

export const MCP_MAPPED_OPERATIONS: readonly OperationName[] = [
  ...READ_GUIDES.map((item) => item.operation),
  ...ACT_GUIDES.map((item) => item.operation),
  ...DELEGATE_GUIDES.map((item) => item.operation),
  ...MESSAGE_GUIDES.map((item) => item.operation),
];

const GROUP_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      description: 'Omit to discover this group. Then copy one operation name from the returned directory.',
    },
    params: {
      type: 'object',
      description: 'Catalog path parameters such as {"id":"<uuid>"}.',
      additionalProperties: { type: 'string' },
    },
    query: {
      type: 'object',
      description: 'Query-string values. Arrays become repeated keys.',
      additionalProperties: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
      },
    },
    body: {
      type: 'object',
      description: 'Exact operation request body from the discovered template.',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
};

export const TM8_MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'tm8_overview',
    description: 'Open the tm8 graph-tool directory. Optionally search the curated next-level operations by intent.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Optional intent words, e.g. "find task" or "delegate work".' } },
      additionalProperties: false,
    },
    annotations: annotations(true, false, true),
  },
  {
    name: 'tm8_read',
    description: 'Read graph context. Call with {} first to receive the next-level read operations and request templates.',
    inputSchema: GROUP_SCHEMA,
    annotations: annotations(true, false, true),
  },
  {
    name: 'tm8_act',
    description: 'Mutate graph entities and relationships. Call with {} first for the allowed operations and exact templates.',
    inputSchema: GROUP_SCHEMA,
    annotations: annotations(false, true, false),
  },
  {
    name: 'tm8_delegate',
    description: 'Dispatch, spawn, resume, or stop durable worker sessions. Call with {} first for next-level schemas.',
    inputSchema: GROUP_SCHEMA,
    annotations: annotations(false, true, false),
  },
  {
    name: 'tm8_messages',
    description: 'Read or post durable anchored/threaded messages. Call with {} first for next-level schemas.',
    inputSchema: GROUP_SCHEMA,
    annotations: annotations(false, false, false),
  },
];

export class ToolInputError extends Error {
  readonly code = 'invalid_input';
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export class Tm8ToolRouter {
  constructor(private readonly transport: CatalogTransport) {}

  async call(name: string, rawArguments: unknown): Promise<McpToolResult> {
    try {
      if (name === 'tm8_overview') return success(overview(rawArguments));
      if (!isGroupName(name)) throw new ToolInputError(`unknown tm8 MCP tool: ${name}`);
      const args = objectOf(rawArguments, 'tool arguments');
      const operation = optionalString(args.operation, 'operation');
      const directory = GROUPS[name];
      if (!operation) return success(directoryResult(name, directory));
      const selected = directory.find((item) => item.operation === operation);
      if (!selected) {
        throw new ToolInputError(`${operation} is not available through ${name}; call ${name} with {} for its directory`);
      }
      const options = invokeOptions(args, selected.operation);
      const data = await this.transport.invoke(selected.operation, options);
      return success({
        schemaVersion: 'tm8.mcp.result.v1',
        tool: name,
        operation: selected.operation,
        data,
      });
    } catch (error) {
      return failure(error);
    }
  }
}

function guide(
  operation: OperationName,
  summary: string,
  request: OperationGuide['request'],
): OperationGuide {
  return { operation, summary, request };
}

function annotations(
  readOnlyHint: boolean,
  destructiveHint: boolean,
  idempotentHint: boolean,
): McpToolDefinition['annotations'] {
  return { readOnlyHint, destructiveHint, idempotentHint, openWorldHint: false };
}

function isGroupName(name: string): name is keyof typeof GROUPS {
  return Object.prototype.hasOwnProperty.call(GROUPS, name);
}

function directoryResult(name: keyof typeof GROUPS, directory: readonly OperationGuide[]): Record<string, unknown> {
  return {
    schemaVersion: 'tm8.mcp.directory.v1',
    tool: name,
    instructions: 'Choose one operation, then call this same tool with operation plus the shown params/query/body shape.',
    operations: directory.map((item) => ({
      ...item,
      catalog: getOperation(item.operation),
    })),
  };
}

function overview(raw: unknown): Record<string, unknown> {
  const args = objectOf(raw, 'tool arguments');
  const query = optionalString(args.query, 'query')?.toLowerCase();
  const groups = [
    { tool: 'tm8_read', purpose: 'context, search, graph traversal, inbox and action discovery' },
    { tool: 'tm8_act', purpose: 'entity, task, relationship, placement and attention mutations' },
    { tool: 'tm8_delegate', purpose: 'dispatching and lifecycle of durable worker sessions' },
    { tool: 'tm8_messages', purpose: 'durable anchored messages and threaded replies' },
  ];
  const operations = Object.entries(GROUPS).flatMap(([tool, guides]) =>
    guides.map((item) => ({ tool, operation: item.operation, summary: item.summary })));
  const terms = query?.split(/\s+/).filter(Boolean) ?? [];
  return {
    schemaVersion: 'tm8.mcp.overview.v1',
    security: {
      authority: 'requesting human claims',
      provenance: 'selected teammate actor',
      filesystem: false,
      credentialOperations: false,
    },
    groups,
    ...(terms.length === 0
      ? {}
      : {
          matches: operations
            .filter((item) => {
              const haystack = `${item.tool} ${item.operation} ${item.summary}`.toLowerCase();
              return terms.some((term) => haystack.includes(term));
            })
            .slice(0, 12),
        }),
    instructions: 'Open one group with {} to load only that group\'s next-level schemas.',
  };
}

const REQUIRES_MUTATION_ID = new Set<OperationName>([
  'entities.create',
  'attentionRequests.create',
  'attentionRequests.update',
  'attentionRequests.resolveEntity',
  'messages.post',
  'messages.edit',
  'messages.delete',
  'entities.commands.linkPr',
  'entities.commands.linkCommit',
  'execution.spawn',
  'execution.dispatch',
  'execution.resume',
]);

function invokeOptions(args: Record<string, unknown>, operation: OperationName): CatalogInvokeOptions {
  const params = stringRecord(args.params, 'params');
  const query = queryRecord(args.query);
  let body = optionalObject(args.body, 'body');
  if (REQUIRES_MUTATION_ID.has(operation)) {
    body = { ...(body ?? {}), clientMutationId: body?.clientMutationId ?? randomUUID() };
  }
  return {
    ...(params ? { params } : {}),
    ...(query ? { query } : {}),
    ...(body ? { body } : {}),
  };
}

function objectOf(raw: unknown, field: string): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ToolInputError(`${field} must be an object`);
  return raw as Record<string, unknown>;
}

function optionalObject(raw: unknown, field: string): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  return objectOf(raw, field);
}

function optionalString(raw: unknown, field: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || raw.trim() === '') throw new ToolInputError(`${field} must be a non-empty string`);
  return raw;
}

function stringRecord(raw: unknown, field: string): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const object = objectOf(raw, field);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(object)) {
    if (typeof value !== 'string') throw new ToolInputError(`${field}.${key} must be a string`);
    result[key] = value;
  }
  return result;
}

function queryRecord(raw: unknown): Record<string, QueryValue> | undefined {
  if (raw === undefined) return undefined;
  const object = objectOf(raw, 'query');
  const result: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(object)) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      result[key] = value as string[];
    } else {
      throw new ToolInputError(`query.${key} must be a string or string array`);
    }
  }
  return result;
}

function success(value: Record<string, unknown>): McpToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function failure(error: unknown): McpToolResult {
  const value = errorValue(error);
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

function errorValue(error: unknown): Record<string, unknown> {
  if (error instanceof CatalogHttpError) {
    return {
      schemaVersion: 'tm8.mcp.error.v1',
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }
  if (error instanceof ToolInputError) {
    return {
      schemaVersion: 'tm8.mcp.error.v1',
      error: { code: error.code, message: error.message, retryable: false },
    };
  }
  return {
    schemaVersion: 'tm8.mcp.error.v1',
    error: {
      code: 'internal_error',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
}

// Module-load proof that curation cannot silently drift from the catalog.
for (const operation of MCP_MAPPED_OPERATIONS) getOperation(operation);

// The explicit inverse proof: neither credential nor auth operation is in a
// resident or next-level graph tool.
for (const operation of MCP_MAPPED_OPERATIONS) {
  if (operation.startsWith('credentials.') || operation.startsWith('auth.')) {
    throw new Error(`credential/auth operation leaked into MCP curation: ${operation}`);
  }
}

// Keep the import honest: the source of operation truth is the same closed
// catalog and no tool call adds a catalog row.
void OPERATIONS;
