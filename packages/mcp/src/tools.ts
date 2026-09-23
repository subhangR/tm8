/**
 * Five hierarchical graph tools, not one tool per catalog operation.
 *
 * Calling a group with no `operation` returns its next-level operation
 * directory and request templates. Only the selected directory enters the
 * model's context. Calls then dispatch by catalog operation name through the
 * same HTTP facade as every other client.
 */
import { randomUUID } from 'node:crypto';
import { getOperation, OPERATIONS, type ChatMode, type OperationName } from '@tm8/contract';
import {
  CatalogHttpError,
  type CatalogInvokeOptions,
  type CatalogTransport,
  type QueryValue,
} from './catalog-client.js';
import {
  callDirectTool,
  DIRECT_TOOLS,
  DirectToolError,
  isDirectTool,
  type DirectToolContext,
} from './direct-tools.js';
import { DIRECT_TOOL_NAMES, parseChatMode, toolPermission } from './modes.js';

export const GRAPH_TOOL_NAMES = [
  'tm8_overview',
  'tm8_read',
  'tm8_act',
  'tm8_delegate',
  'tm8_messages',
] as const;

export const MCP_TOOL_NAMES = [...GRAPH_TOOL_NAMES, ...DIRECT_TOOL_NAMES] as const;

export type Tm8McpToolName = (typeof MCP_TOOL_NAMES)[number];

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

/**
 * An MCP content block. Text is the ordinary case; `image` exists for the one
 * thing text cannot carry — a screenshot a model is meant to LOOK at.
 */
export type McpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

export interface McpToolResult {
  content: McpContentBlock[];
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
    body: { spaceId: '<space-id>', kinds: ['task'], filters: { status: ['working'] }, limit: 50 },
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
  /* `parentId` is advertised DELIBERATELY, and its absence was a real defect.
     The field has always been accepted (`CreateEntityInput`), but a template
     that never showed it is a field the model never sets — so every entity a
     conversation created landed flat at the root, and every surface that draws
     hierarchy from creates (the chat ledger's tree, its scope picker) had
     nothing to draw. A capability the schema has and the guide hides does not
     exist in practice.
     Hierarchy is homogeneous — a parent and its direct children share one kind
     and one Space — so the summary says so rather than letting a model discover
     it by rejection. */
  guide('entities.create', 'Create a graph entity (including a task). Pass parentId to nest it under an existing entity of the SAME kind — a parent and its direct children share one kind and one Space.', {
    body: { spaceId: '<space-id>', kind: 'task', title: '<title>', parentId: '<optional-parent-id>', content: {} },
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

/**
 * Containers (TM8-CONTAINERS-DESIGN §14.1). Guide rows, not direct tools,
 * because these are called once per decision rather than in a loop — a
 * template is the right shape for "start this machine", and a typed result is
 * the right shape only for the three the agent calls repeatedly.
 *
 * `containers.run` appears BOTH here and as the direct tool `container_run`,
 * and §14.1 asks for both deliberately: the guide is how a model discovers the
 * operation exists at all, the direct tool is how it calls it in a loop and
 * gets `exitCode` as a number rather than a blob to re-parse. The summary here
 * says so, rather than leaving a model to find out by trying both.
 *
 * Fifteen of the twenty-five containers.* operations answer an honest 501 in
 * P0. That is deliberately NOT narrated in these summaries: what a node can
 * actually serve is measured at call time and reported by the error, and a
 * summary that said "not yet" would be a roadmap that rots.
 */
const CONTAINER_GUIDES = [
  guide('containers.create', 'Create a machine an agent can run in or drive, and start it. The birth verb — entities.create refuses the container kind.', {
    body: { spaceId: '<space-id>', profile: 'shell', title: '<title>', clientMutationId: '<optional-id>' },
  }),
  guide('containers.start', 'Start a stopped machine, under a version guard.', {
    params: { containerId: '<container-id>' }, body: { expectedVersion: 1 },
  }),
  guide('containers.stop', 'Stop a running or paused machine, keeping its record.', {
    params: { containerId: '<container-id>' }, body: { expectedVersion: 1 },
  }),
  guide('containers.destroy', 'Destroy a machine and its runtime object, under a version guard.', {
    params: { containerId: '<container-id>' }, body: { expectedVersion: 1, force: false },
  }),
  guide('containers.run', 'Run one command inside a machine. Prefer the container_run tool when looping: it returns a typed exitCode, stdout and stderr.', {
    params: { containerId: '<container-id>' }, body: { argv: ['<command>', '<arg>'], cwd: '<optional-path>' },
  }),
  guide('containers.policy.set', 'Set a machine\'s egress preset and allowlist, under a version guard.', {
    params: { containerId: '<container-id>' }, body: { expectedVersion: 1, network: { preset: 'locked', allow: ['<hostname>'] } },
  }),
  guide('containers.expose', 'Publish a machine\'s port through the node\'s reverse proxy.', {
    params: { containerId: '<container-id>' }, body: { expectedVersion: 1, port: 8080, share: 'space' },
  }),
  guide('containers.snapshot', 'Capture a machine\'s disk as a reusable image.', {
    params: { containerId: '<container-id>' }, body: { expectedVersion: 1, name: '<name>' },
  }),
  guide('containers.fork', 'Create a new machine from this one\'s snapshot. No version guard — a fork reads the source.', {
    params: { containerId: '<container-id>' }, body: { title: '<title>' },
  }),
  guide('containers.attention', 'Ask a human to take over the machine — a login, a captcha, a payment. Use this instead of automating past the moment.', {
    params: { containerId: '<container-id>' }, body: { reason: 'login', detail: '<what is needed>', points: 50 },
  }),
] as const satisfies readonly OperationGuide[];

/* `mode: 'coordinated-worker'` is the TEMPLATE value, and that is the whole
   point of this guide (176/Wave 2).

   A worker spawned `mode: 'worker'` has no coordinator and no return address:
   it does its work and exits, and whatever it learned dies with its transcript.
   `coordinated-worker` is what makes `resolveCoordinatorSessionId` resolve a
   coordinator at all (`execution/src/spawn/manifest.ts`) — with any other mode
   it returns null and the launched prompt carries no `<coordination>` block.

   The coordinator it resolves is `parentSessionId`, which THIS caller does not
   have to supply and should not: `execution.spawn` defaults it to the calling
   chat's own id, read off the bearer's session row rather than from this body.
   So the two halves — a chat that can be a parent (178) and a mode that makes
   the parent a return address — are what turn a dispatched worker's completion
   report into a turn in this chat instead of an inert stored message.

   A guide that showed `mode: 'worker'` therefore advertised the one value that
   silently discards the result. */
const DELEGATE_GUIDES = [
  guide('execution.dispatch', 'Route an entity to the resident dispatcher; it chooses the teammate.', {
    body: { spaceId: '<space-id>', subjectId: '<entity-id>', note: '<optional-steer>' },
  }),
  guide(
    'execution.spawn',
    'Start a durable worker session with an explicitly chosen teammate. '
      + "Use mode 'coordinated-worker' so the worker is told a coordinator is waiting and reports back "
      + 'when it finishes or blocks. Leave parentSessionId out: it defaults to THIS chat, so the worker '
      + "is parented on the chat and its report arrives here as a turn. Any other mode ('worker') gives "
      + 'the worker no return address and its result is lost when it exits.',
    {
      body: {
        spaceId: '<space-id>',
        teamMemberId: '<team-member-id>',
        taskIds: ['<task-id>'],
        mode: 'coordinated-worker',
      },
    },
  ),
  guide('execution.terminate', 'End a worker session. Chats are not terminated this way.', {
    params: { id: '<work-session-id>' }, body: { force: false },
  }),
  guide('execution.resume', 'Resume an exited worker with its provider-native conversation.', {
    params: { id: '<work-session-id>' }, body: {},
  }),
] as const satisfies readonly OperationGuide[];

/* AN AGENT'S ADDRESS IS ITS OWN ENTITY ID, and until 176 only half of that
   sentence was true. A work session has always been reachable by anchoring a
   message on its id; a chat was a message thread with no id to anchor on, so
   nothing could address one. Now a chat is an entity and the two are symmetric,
   which is worth saying in the guide rather than leaving a model to discover it
   — `<anchor-id>` alone reads as "some entity", and a model that reads it that
   way posts its report onto the task and nobody wakes. */
const MESSAGE_GUIDES = [
  guide('messages.list', 'Page thread roots or replies anchored to an entity — a task, a work session, or a chat.', {
    params: { anchorId: '<anchor-id: entity, work-session or chat id>' }, query: { limit: '50' },
  }),
  guide(
    'messages.post',
    'Post a durable message or direct threaded reply as the selected teammate. '
      + "An agent's address IS its entity id: anchor on a work session's id to reach that session, "
      + "and on a chat's id to reach that chat — a chat you are answering, or the chat that spawned you. "
      + 'Either one wakes its recipient; anchoring on a task or a document only stores the message.',
    {
      body: {
        anchorIds: ['<anchor-id: entity, work-session or chat id>'],
        body: '<message>',
        parentMessageId: '<optional-parent-message-id>',
      },
    },
  ),
  guide('messages.delivery.get', 'Read storage/delivery settlement for a posted message, including any chat turn it queued.', {
    params: { messageId: '<message-id>' },
  }),
] as const satisfies readonly OperationGuide[];

const GROUPS = {
  tm8_read: READ_GUIDES,
  tm8_act: [...ACT_GUIDES, ...CONTAINER_GUIDES],
  tm8_delegate: DELEGATE_GUIDES,
  tm8_messages: MESSAGE_GUIDES,
} as const;

export const MCP_MAPPED_OPERATIONS: readonly OperationName[] = [
  ...READ_GUIDES.map((item) => item.operation),
  ...ACT_GUIDES.map((item) => item.operation),
  ...CONTAINER_GUIDES.map((item) => item.operation),
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
  ...DIRECT_TOOLS,
];

export class ToolInputError extends Error {
  readonly code = 'invalid_input';
  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

export interface Tm8ToolRouterOptions {
  mode?: ChatMode;
  projectRoot?: string;
  spaceId?: string;
  /**
   * The chat this MCP server runs inside (`TM8_CHAT_ID`, written into the
   * per-chat config by the server's launch-config resolver).
   *
   * It is NOT used to authorize anything — the server re-reads the same fact off
   * the bearer's own session row, which is the only copy that cannot be edited
   * by whoever can read this config file. It is here so the tool surface can
   * TELL the model its own address instead of leaving it to infer one from the
   * cwd or the config filename, both of which have been wrong before.
   */
  chatId?: string;
  fetchImpl?: typeof fetch;
  /** Provider-native equivalents omitted from MCP registration and calls. */
  hiddenTools?: readonly string[];
}

export class Tm8ToolRouter {
  private readonly mode: ChatMode;
  private readonly directContext: DirectToolContext;
  private readonly hiddenTools: ReadonlySet<string>;
  private readonly chatId: string | null;

  constructor(private readonly transport: CatalogTransport, options: Tm8ToolRouterOptions = {}) {
    this.mode = options.mode ?? parseChatMode(undefined);
    this.hiddenTools = new Set(options.hiddenTools ?? []);
    this.chatId = options.chatId?.trim() || null;
    this.directContext = {
      transport,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      ...(options.spaceId ? { spaceId: options.spaceId } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    };
  }

  listedTools(): readonly McpToolDefinition[] {
    return TM8_MCP_TOOLS.filter((tool) => (
      !this.hiddenTools.has(tool.name)
      && toolPermission(this.mode, tool.name) === 'allow'
    ));
  }

  async call(name: string, rawArguments: unknown): Promise<McpToolResult> {
    try {
      if (!(MCP_TOOL_NAMES as readonly string[]).includes(name)) {
        throw new ToolInputError(`unknown tm8 MCP tool: ${name}`);
      }
      if (this.hiddenTools.has(name)) {
        throw new ToolInputError(`${name} is replaced by a provider-native tool in this chat runtime`);
      }
      if (isDirectTool(name)) {
        enforcePermission(this.mode, name);
        return success(await callDirectTool(name, rawArguments, this.directContext));
      }
      if (name === 'tm8_overview') {
        enforcePermission(this.mode, name);
        return success(overview(rawArguments, this.mode, this.hiddenTools, this.chatId));
      }
      if (!isGroupName(name)) throw new ToolInputError(`unknown tm8 MCP tool: ${name}`);
      const args = objectOf(rawArguments, 'tool arguments');
      const operation = optionalString(args.operation, 'operation');
      const directory = GROUPS[name];
      enforcePermission(this.mode, name, operation);
      if (!operation) {
        return success(directoryResult(
          name,
          directory.filter((item) => toolPermission(this.mode, name, item.operation) !== 'deny'),
        ));
      }
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

function overview(
  raw: unknown,
  mode: ChatMode,
  hiddenTools: ReadonlySet<string>,
  chatId: string | null,
): Record<string, unknown> {
  const args = objectOf(raw, 'tool arguments');
  const query = optionalString(args.query, 'query')?.toLowerCase();
  const groups = [
    { tool: 'tm8_read', purpose: 'context, search, graph traversal, inbox and action discovery' },
    { tool: 'tm8_act', purpose: 'entity, task, relationship, placement and attention mutations' },
    {
      tool: 'tm8_delegate',
      purpose: "dispatching and lifecycle of durable worker sessions; spawn mode 'coordinated-worker'"
        + ' parents the worker on this chat and gives it this chat as its return address',
    },
    {
      tool: 'tm8_messages',
      purpose: 'durable anchored messages and threaded replies; a work session or a chat is reached'
        + ' by anchoring on ITS own entity id',
    },
  ].filter((group) => toolPermission(mode, group.tool) === 'allow');
  const operations = Object.entries(GROUPS).flatMap(([tool, guides]) =>
    guides
      .filter((item) => toolPermission(mode, tool, item.operation) !== 'deny')
      .map((item) => ({ tool, operation: item.operation, summary: item.summary })));
  const terms = query?.split(/\s+/).filter(Boolean) ?? [];
  return {
    schemaVersion: 'tm8.mcp.overview.v1',
    security: {
      authority: 'requesting human claims',
      provenance: 'selected teammate actor',
      filesystem: toolPermission(mode, 'repo_read_file') === 'allow',
      credentialOperations: false,
      /* B10. The credential is bound to ONE chat server-side; naming that chat
         here is a statement about the token, not a grant. Saying so is the
         honest half of the guard the server enforces. */
      ...(chatId ? { boundChatId: chatId } : {}),
    },
    groups,
    mode,
    /* The chat's own id and what it means, so `messages.post` needs no
       inference: this is the address other sessions and chats post on to reach
       this chat, and the parent a coordinated worker reports back to. Absent
       only when the runtime did not set TM8_CHAT_ID — an older config file. */
    ...(chatId
      ? {
        chat: {
          id: chatId,
          address: 'other sessions and chats reach this chat by anchoring a message on this id;'
            + ' reach one of them with messages.post anchored on ITS id',
          delegation: "a worker spawned mode:'coordinated-worker' is parented on this id and reports"
            + ' back to it',
        },
      }
      : {}),
    directTools: DIRECT_TOOLS
      .filter((tool) => !hiddenTools.has(tool.name) && toolPermission(mode, tool.name) !== 'deny')
      .map((tool) => ({ tool: tool.name, purpose: tool.description })),
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

function enforcePermission(mode: ChatMode, tool: string, operation?: string): void {
  const permission = toolPermission(mode, tool, operation);
  if (permission === 'allow') return;
  if (permission === 'ask') {
    throw new DirectToolError(
      'permission_required',
      `${tool} requires explicit approval in ${mode} mode; headless chat fails closed`,
    );
  }
  throw new DirectToolError(
    'mode_denied',
    `${operation ?? tool} is not available in ${mode} mode`,
  );
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
  // Containers: every one of these is a ledgered command, and a replayed
  // create must return the FIRST machine rather than provision a second.
  'containers.create',
  'containers.start',
  'containers.stop',
  'containers.destroy',
  'containers.run',
  'containers.policy.set',
  'containers.expose',
  'containers.snapshot',
  'containers.fork',
  'containers.attention',
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

/**
 * A direct tool may return an `imageContent` envelope. `success` lifts it into
 * a real MCP image block and REMOVES it from `structuredContent`.
 *
 * The removal is the point, not tidiness: a screenshot is on the order of a
 * megabyte of base64, and leaving it in the structured half would ship it
 * TWICE to a model that can read it in neither place as text. The dimensions
 * and the scale stay behind in `screenshot`, because those are what the model
 * needs to convert its next click's coordinates — the image block alone does
 * not carry them.
 */
function success(value: Record<string, unknown>): McpToolResult {
  const { imageContent, ...rest } = value as { imageContent?: unknown } & Record<string, unknown>;
  const image = imageContent as { mimeType?: unknown; data?: unknown } | undefined;
  if (image && typeof image.data === 'string' && typeof image.mimeType === 'string') {
    return {
      content: [
        { type: 'text', text: JSON.stringify(rest) },
        { type: 'image', data: image.data, mimeType: image.mimeType },
      ],
      structuredContent: rest,
    };
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(rest) }],
    structuredContent: rest,
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
  if (error instanceof DirectToolError) {
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
  return {
    schemaVersion: 'tm8.mcp.error.v1',
    error: {
      code: 'internal_error',
      // Do not reflect raw filesystem/process errors: they can contain the
      // server checkout root, command environment, or another tenant's path.
      message: 'unexpected tool failure',
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
