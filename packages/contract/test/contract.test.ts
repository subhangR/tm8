/**
 * Contract self-tests: taxonomy mapping (DEV-8), cursor behavior (DEV-5),
 * catalog integrity, and schema acceptance/rejection over canonical fixtures.
 */
import { describe, expect, it } from 'vitest';
import {
  ActorSummarySchema, BASE_PATH, CollabError, CollectionQuerySchema, CommandResultSchema,
  CreateEntityInputSchema, CURSOR_VERSION, decodeCursor, encodeCursor,
  EntityKindSchema, EntitySummarySchema, ERROR_STATUS, ExecutionLivenessSchema,
  ExecutionSpawnInputSchema,
  FileUploadGrantSchema, FileUploadInitInputSchema,
  getOperation, isCollabError, isKeysetCursor, MessageViewSchema, OPERATIONS,
  ProjectCreateInputSchema, ProjectDirectoryListingSchema, ProjectLinkInputSchema, ProjectResourceSchema,
  RESERVED_OPERATIONS, V1_OPERATIONS, WireErrorBodySchema, WorkInputSchema,
  WorkspaceEventSchema, bindPath,
} from '../src/index.js';
import type { EntitySummary, MessageView, WorkspaceEvent } from '../src/index.js';

const actor = {
  id: 'ent_member_1', kind: 'member' as const, displayName: 'Subhang', isAgent: false,
};

const counters = { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null };

const taskSummary: EntitySummary = {
  id: 'ent_task_1', spaceId: 'space_1', kind: 'task', title: 'T-1 · Do the thing',
  parentId: null, position: 1, visibility: 'space', version: 1,
  activityAt: '2026-07-25T12:00:00.000Z', createdAt: '2026-07-25T12:00:00.000Z',
  updatedAt: '2026-07-25T12:00:00.000Z', deletedAt: null,
  createdBy: actor, counters,
  state: {
    kind: 'task', workStatus: 'open', priority: 'medium', axes: {},
    assignees: [], acceptance: { total: 0, completed: 0 },
  },
  badges: {},
};

describe('error taxonomy (DEV-8)', () => {
  it('maps the closed code set to the normative HTTP statuses', () => {
    expect(ERROR_STATUS).toEqual({
      invalid_input: 400, invalid_cursor: 400,
      unauthenticated: 401, forbidden: 403, not_found: 404,
      version_conflict: 409, conflict: 409, invariant_violation: 409,
      payload_too_large: 413, rate_limited: 429, limit_exceeded: 429,
      not_implemented: 501, upstream_unavailable: 503,
    });
  });

  it('limit_exceeded (AM-2 §4 governance) is 429 and retryable by default', () => {
    const e = new CollabError('limit_exceeded', 'session concurrency cap reached');
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
  });

  it('CollabError carries code/status/requestId/retryable', () => {
    const e = new CollabError('rate_limited', 'slow down');
    expect(isCollabError(e)).toBe(true);
    expect(e.status).toBe(429);
    expect(e.retryable).toBe(true);
    expect(e.requestId).toMatch(/^req_/);
    expect(new CollabError('forbidden', 'no').retryable).toBe(false);
  });

  it('wire error bodies validate (and unknown codes are rejected)', () => {
    const ok = { error: { code: 'not_found', message: 'gone', requestId: 'req_1', retryable: false } };
    expect(WireErrorBodySchema.safeParse(ok).success).toBe(true);
    const bad = { error: { code: 'kaboom', message: 'x', requestId: 'req_1', retryable: false } };
    expect(WireErrorBodySchema.safeParse(bad).success).toBe(false);
  });
});

describe('keyset cursors (DEV-5)', () => {
  it('round-trips a keyset', () => {
    const c = encodeCursor(['2026-07-25T12:00:00.000Z', 'ent_01']);
    expect(decodeCursor(c)).toEqual({ v: CURSOR_VERSION, k: ['2026-07-25T12:00:00.000Z', 'ent_01'] });
    expect(isKeysetCursor(c)).toBe(true);
  });

  it('rejects offset-shaped, malformed, and wrong-version cursors with invalid_cursor', () => {
    for (const bad of ['off:40', '40', 'not-a-cursor!!!', '']) {
      try {
        decodeCursor(bad);
        expect.unreachable(`should reject ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(isCollabError(e) && e.code === 'invalid_cursor').toBe(true);
      }
    }
    const v1 = Buffer.from(JSON.stringify({ v: 1, k: ['x'] })).toString('base64url');
    expect(() => decodeCursor(v1)).toThrowError(/version/);
    const noKeys = Buffer.from(JSON.stringify({ v: 2, k: [] })).toString('base64url');
    expect(() => decodeCursor(noKeys)).toThrowError(/keyset/);
  });
});

describe('operation catalog', () => {
  it('has unique names and unique method+path bindings', () => {
    const names = OPERATIONS.map((o) => o.name);
    expect(new Set(names).size).toBe(names.length);
    const bindings = OPERATIONS.map((o) => `${o.method} ${o.path}`);
    expect(new Set(bindings).size).toBe(bindings.length);
    for (const op of OPERATIONS) expect(op.path.startsWith(BASE_PATH)).toBe(true);
  });

  it('carries the execution.* family (R16) and the entityKinds family (T-L4)', () => {
    for (const name of ['execution.spawn', 'execution.prompt', 'execution.terminate', 'execution.streams.attach',
                        'entityKinds.list', 'entityKinds.create', 'entityKinds.update'] as const) {
      expect(getOperation(name).status).toBe('v1');
    }
  });

  it('carries the projects.* and files.* families (AM-2 §1/§2) as v1', () => {
    for (const name of ['projects.list', 'projects.create', 'projects.directories.list', 'projects.get', 'projects.update',
                        'projects.link', 'projects.unlink',
                        'files.uploadInit', 'files.uploadComplete', 'files.uploadAbort', 'files.download'] as const) {
      expect(getOperation(name).status).toBe('v1');
    }
    // link/unlink bind under the space (M2M semantics, T-D17)
    expect(bindPath('projects.unlink', { spaceId: 's1', projectId: 'p1' })).toBe('/v2/spaces/s1/projects/p1');
  });

  it('reserved slots: search, bridge.fetchBlob, and the held-back folderUploads lifecycle', () => {
    expect(RESERVED_OPERATIONS.map((o) => o.name)).toEqual(['search.query', 'bridge.fetchBlob']);
    expect(V1_OPERATIONS.length).toBe(OPERATIONS.length - 2);
  });

  it('bindPath substitutes params and refuses missing ones', () => {
    expect(bindPath('entities.get', { id: 'ent_1' })).toBe('/v2/entities/ent_1');
    expect(() => bindPath('entities.get')).toThrowError(/missing param/);
  });
});

describe('DTO schemas', () => {
  it('accepts a canonical task summary and rejects drift', () => {
    expect(EntitySummarySchema.safeParse(taskSummary).success).toBe(true);
    expect(EntitySummarySchema.safeParse({ ...taskSummary, surprise: 1 }).success).toBe(false);
    expect(EntitySummarySchema.safeParse({ ...taskSummary, state: { ...taskSummary.state, workStatus: 'banana' } }).success).toBe(false);
    expect(EntitySummarySchema.safeParse({ ...taskSummary, counters: { ...counters, viewerReaction: undefined } }).success).toBe(false); // DEV-10: always present
  });

  it('accepts work_session, collection, and custom-kind states (tm8 extensions)', () => {
    const ws = {
      ...taskSummary, id: 'ent_ws_1', kind: 'work_session' as const,
      state: { kind: 'work_session' as const, status: 'running' as const, agentTool: 'claude-code', model: 'claude-opus-4-8', shareMode: 'none' as const, startedAt: '2026-07-25T12:00:00.000Z', exitedAt: null },
    };
    expect(EntitySummarySchema.safeParse(ws).success).toBe(true);
    const col = { ...taskSummary, id: 'ent_col_1', kind: 'collection' as const, state: { kind: 'collection' as const, collectionType: 'manual', itemCount: 3 } };
    expect(EntitySummarySchema.safeParse(col).success).toBe(true);
    const custom = { ...taskSummary, id: 'ent_c_1', kind: 'c:design_asset' as const, state: { kind: 'c:design_asset' as const, fields: { status: 'draft', reviewed: false } } };
    expect(EntitySummarySchema.safeParse(custom).success).toBe(true);
    expect(EntityKindSchema.safeParse('design_asset').success).toBe(false); // custom kinds must be c:-namespaced
  });

  it('A21/A22: liveness is strict, sessionStatus filters alone, and the kind-disjoint pair is refused', () => {
    // A21 — execution.liveness result, strict both ways.
    const liveness = {
      liveEntityIds: ['019f9896-928d-7a24-848b-4c8fdd82b761'],
      nodeBootId: 'boot-1',
      checkedAt: '2026-07-28T12:00:00.000Z',
      capacity: { used: 1, total: 8 },
    };
    expect(ExecutionLivenessSchema.safeParse(liveness).success).toBe(true);
    expect(ExecutionLivenessSchema.safeParse({ ...liveness, extra: 1 }).success).toBe(false);
    expect(ExecutionLivenessSchema.safeParse({ ...liveness, checkedAt: 'yesterday' }).success).toBe(false);

    // A22 — each filter alone is legal…
    const base = { spaceId: '019f9896-928d-79b6-ba1c-1cdcc1d30a6f' };
    expect(CollectionQuerySchema.safeParse({ ...base, filters: { sessionStatus: ['running', 'idle'] } }).success).toBe(true);
    expect(CollectionQuerySchema.safeParse({ ...base, filters: { workStatus: ['open'] } }).success).toBe(true);
    expect(CollectionQuerySchema.safeParse({ ...base, filters: { sessionStatus: ['sleeping'] } }).success).toBe(false);

    // …but the kind-disjoint PAIR is refused, not silently empty: no row is
    // both a task and a work_session, so the conjunction could only ever
    // produce the confident zero. The refusal names the mechanism.
    const pair = CollectionQuerySchema.safeParse({
      ...base,
      filters: { workStatus: ['open'], sessionStatus: ['running'] },
    });
    expect(pair.success).toBe(false);
    if (!pair.success) {
      expect(JSON.stringify(pair.error.issues)).toContain('kind-disjoint');
    }

    // The priority axis obeys the same law: task-only, so pairing it with
    // sessionStatus is another always-empty conjunction that must refuse.
    expect(CollectionQuerySchema.safeParse({ ...base, filters: { priority: ['high'] } }).success).toBe(true);
    const priorityPair = CollectionQuerySchema.safeParse({
      ...base,
      filters: { priority: ['high'], sessionStatus: ['running'] },
    });
    expect(priorityPair.success).toBe(false);
    if (!priorityPair.success) {
      expect(JSON.stringify(priorityPair.error.issues)).toContain('kind-disjoint');
    }
  });

  it('validates recursive message views with nested replies', () => {
    const msg: MessageView = {
      ...taskSummary, id: 'ent_msg_1', kind: 'message',
      state: { kind: 'message', anchorId: 'ent_task_1', rootMessageId: null, author: actor, messageBatchId: null },
      content: { kind: 'message', body: 'hello', mentions: [], attachments: [] },
      replyCount: 1,
      replies: {
        items: [{
          ...taskSummary, id: 'ent_msg_2', kind: 'message',
          state: { kind: 'message', anchorId: 'ent_task_1', rootMessageId: 'ent_msg_1', author: actor, messageBatchId: null },
          content: { kind: 'message', body: 'reply', mentions: [], attachments: [] },
          replyCount: 0,
        }],
        nextCursor: null,
      },
    };
    expect(MessageViewSchema.safeParse(msg).success).toBe(true);
  });

  it('preserves the optional message redaction timestamp without breaking legacy views', () => {
    const baseMessage = {
      ...taskSummary,
      id: 'ent_msg_redaction',
      kind: 'message' as const,
      state: {
        kind: 'message' as const,
        anchorId: 'ent_task_1',
        rootMessageId: null,
        author: actor,
        messageBatchId: null,
      },
      content: { kind: 'message' as const, body: '', mentions: [], attachments: [] },
      replyCount: 0,
    };

    const legacy = MessageViewSchema.safeParse(baseMessage);
    expect(legacy.success).toBe(true);
    if (legacy.success && legacy.data.state.kind === 'message') {
      expect(legacy.data.state).not.toHaveProperty('redactedAt');
    }

    const explicitNull = MessageViewSchema.safeParse({
      ...baseMessage,
      state: { ...baseMessage.state, redactedAt: null },
    });
    expect(explicitNull.success).toBe(true);
    if (explicitNull.success && explicitNull.data.state.kind === 'message') {
      expect(explicitNull.data.state.redactedAt).toBeNull();
    }

    const timestamp = '2026-07-30T03:45:00.000Z';
    const redacted = MessageViewSchema.safeParse({
      ...baseMessage,
      state: { ...baseMessage.state, redactedAt: timestamp },
    });
    expect(redacted.success).toBe(true);
    if (redacted.success && redacted.data.state.kind === 'message') {
      expect(redacted.data.state.redactedAt).toBe(timestamp);
    }
    expect(MessageViewSchema.safeParse({
      ...baseMessage,
      state: { ...baseMessage.state, redactedAt: 42 },
    }).success).toBe(false);
  });

  it('validates WorkspaceEvent unions with the AM-2 §3 envelope + clientMutationId threading (DEV-9)', () => {
    const envelope = { spaceId: 'space_1', seq: 41, occurredAt: '2026-07-25T12:00:00.000Z', schemaVersion: 1 };
    const ev: WorkspaceEvent = { ...envelope, type: 'entity.upsert', entity: taskSummary, clientMutationId: 'cmid-1' };
    expect(WorkspaceEventSchema.safeParse(ev).success).toBe(true);
    // clientMutationId is legal on every mutation-derived variant
    const counter: WorkspaceEvent = { ...envelope, type: 'counter.changed', entityId: 'ent_task_1', counters, clientMutationId: 'cmid-2' };
    expect(WorkspaceEventSchema.safeParse(counter).success).toBe(true);
    // the envelope is mandatory — a bare pre-AM-2 event (eventId, no seq) is drift
    expect(WorkspaceEventSchema.safeParse({ type: 'entity.upsert', eventId: 'evt_1', entity: taskSummary }).success).toBe(false);
    expect(WorkspaceEventSchema.safeParse({ ...envelope, seq: undefined, type: 'entity.upsert', entity: taskSummary }).success).toBe(false);
    expect(WorkspaceEventSchema.safeParse({ ...envelope, type: 'entity.exploded', entity: taskSummary }).success).toBe(false);
  });

  it('CommandResult requires patches', () => {
    expect(CommandResultSchema.safeParse({ patches: [] }).success).toBe(true);
    expect(CommandResultSchema.safeParse({}).success).toBe(false);
  });
});

describe('command input schemas (DEF-1/2/3 conventions)', () => {
  it('rejects unknown fields, closed-enum violations, and wrong types', () => {
    expect(WorkInputSchema.safeParse({ status: 'working' }).success).toBe(true);
    expect(WorkInputSchema.safeParse({ workStatus: 'done' }).success).toBe(false);       // DEF-1
    expect(WorkInputSchema.safeParse({ status: 'banana' }).success).toBe(false);          // DEF-2
    expect(WorkInputSchema.safeParse({ status: 'working', speed: 'fast' }).success).toBe(false); // DEF-3
    expect(WorkInputSchema.safeParse({ status: 'working', startedAt: 'yesterdayish' }).success).toBe(false);
    expect(WorkInputSchema.safeParse(null).success).toBe(false);
  });

  it('createEntity refuses message/member/work_session kinds (DEV-1 + R16)', () => {
    const base = { clientMutationId: 'cmid-create-1', spaceId: 'space_1', title: 'x' };
    for (const kind of ['message', 'member', 'work_session']) {
      expect(CreateEntityInputSchema.safeParse({ ...base, kind }).success).toBe(false);
    }
    expect(CreateEntityInputSchema.safeParse({ ...base, kind: 'doc' }).success).toBe(true);
    expect(CreateEntityInputSchema.safeParse({ ...base, kind: 'c:design_asset' }).success).toBe(true);
  });

  it('execution.spawn validates persona + mode enums and the typed project/workdir (AM-2 §1)', () => {
    const ok = {
      clientMutationId: 'cmid-spawn-1',
      spaceId: '11111111-1111-4111-8111-111111111111',
      teamMemberId: '22222222-2222-4222-8222-222222222222',
      taskIds: ['33333333-3333-4333-8333-333333333333'],
      mode: 'worker',
    };
    expect(ExecutionSpawnInputSchema.safeParse(ok).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok, parentSessionId: '55555555-5555-4555-8555-555555555555',
    }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok, parentSessionId: 'not-a-session-id',
    }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, mode: 'boss' }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, credentialSource: 'member' }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, credentialSource: 'node' }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, credentialSource: 'another-member' }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok,
      credentialSources: { anthropic: 'node', github: 'member' },
    }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok,
      credentialSources: { openai: 'member', github: 'node' },
    }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok,
      credentialSources: { github: 'another-member' },
    }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok,
      credentialSources: { somebodyElse: 'member' },
    }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ spaceId: ok.spaceId }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok, projectId: '44444444-4444-4444-8444-444444444444', workdir: { mode: 'project' },
    }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, workdir: { mode: 'scratch' } }).success).toBe(true);
    // The worktree gate is OPEN. It stayed shut while this schema was the only
    // thing holding the line (the RPC would have accepted the mode), and it
    // opened in the same change as the manager, the saga and the reconciler —
    // which is the condition §7.4 sets for advertising the capability at all.
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, workdir: { mode: 'worktree' } }).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, workdir: { mode: 'worktree', baseRef: 'main' } }).success).toBe(true);
    // Intent in, never paths (§7.1). `.strict()` is what makes this a refusal
    // rather than a field the server silently drops.
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok, workdir: { mode: 'worktree', path: '/etc' },
    }).success).toBe(false);
    // And a client cannot pin a commit the server never validated.
    expect(ExecutionSpawnInputSchema.safeParse({
      ...ok, workdir: { mode: 'worktree', baseCommitOid: 'a'.repeat(40) },
    }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, workdir: { mode: 'worktree', baseRef: '' } }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, workdir: { mode: 'yolo' } }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, spaceId: 'fixture-space' }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, interactionProfileId: 'fixture-profile' }).success).toBe(false);
    // the pre-AM-2 untyped ref is dead
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, projectRef: '~/code/x' }).success).toBe(false);
  });

  it('project resources + inputs validate (AM-2 §1)', () => {
    const project = {
      id: 'proj_1', name: 'tm8', repoUrl: null, workingDir: '/Users/x/tm8',
      trust: 'trusted', defaults: { model: 'claude-opus-4-8' },
      createdAt: '2026-07-25T12:00:00.000Z', updatedAt: '2026-07-25T12:00:00.000Z',
    };
    expect(ProjectResourceSchema.safeParse(project).success).toBe(true);
    expect(ProjectResourceSchema.safeParse({ ...project, trust: 'sorta' }).success).toBe(false);
    expect(ProjectCreateInputSchema.safeParse({ name: 'tm8', workingDir: '/Users/x/tm8' }).success).toBe(true);
    expect(ProjectCreateInputSchema.safeParse({
      name: 'tm8', workingDir: '/Users/x/tm8', ensureWorkingDir: true,
    }).success).toBe(true);
    expect(ProjectCreateInputSchema.safeParse({ name: 'tm8' }).success).toBe(false);
    expect(ProjectLinkInputSchema.safeParse({ projectId: 'proj_1' }).success).toBe(true);
    expect(ProjectDirectoryListingSchema.safeParse({
      roots: ['/Users/x'], path: '/Users/x', parentPath: null, separator: '/',
      directories: [{ name: 'tm8', path: '/Users/x/tm8' }], truncated: false,
    }).success).toBe(true);
  });

  it('file upload init enforces sha-256 checksums and positive sizes (AM-2 §2)', () => {
    const ok = {
      spaceId: 'space_1', name: 'design.png', mime: 'image/png', sizeBytes: 1024,
      checksumSha256: 'a'.repeat(64),
    };
    expect(FileUploadInitInputSchema.safeParse(ok).success).toBe(true);
    expect(FileUploadInitInputSchema.safeParse({ ...ok, checksumSha256: 'XYZ' }).success).toBe(false);
    expect(FileUploadInitInputSchema.safeParse({ ...ok, sizeBytes: 0 }).success).toBe(false);
    expect(FileUploadGrantSchema.safeParse({
      uploadId: 'up_1', uploadUrl: '/v2/files/uploads/up_1/bytes',
      expiresAt: '2026-07-25T12:10:00.000Z', maxSizeBytes: 536870912,
    }).success).toBe(true);
  });

  it('actor summaries validate', () => {
    expect(ActorSummarySchema.safeParse(actor).success).toBe(true);
    expect(ActorSummarySchema.safeParse({ ...actor, kind: 'robot' }).success).toBe(false);
  });
});
