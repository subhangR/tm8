/**
 * Contract self-tests: taxonomy mapping (DEV-8), cursor behavior (DEV-5),
 * catalog integrity, and schema acceptance/rejection over canonical fixtures.
 */
import { describe, expect, it } from 'vitest';
import {
  ActorSummarySchema, BASE_PATH, CollabError, CommandResultSchema,
  CreateEntityInputSchema, CURSOR_VERSION, decodeCursor, encodeCursor,
  EntityKindSchema, EntitySummarySchema, ERROR_STATUS, ExecutionSpawnInputSchema,
  getOperation, isCollabError, isKeysetCursor, MessageViewSchema, OPERATIONS,
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
      version_conflict: 409, invariant_violation: 409,
      payload_too_large: 413, rate_limited: 429,
      not_implemented: 501, upstream_unavailable: 503,
    });
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

  it('search is the only reserved v1 slot (DEV-13)', () => {
    expect(RESERVED_OPERATIONS.map((o) => o.name)).toEqual(['search.query']);
    expect(V1_OPERATIONS.length).toBe(OPERATIONS.length - 1);
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

  it('validates recursive message views with nested replies', () => {
    const msg: MessageView = {
      ...taskSummary, id: 'ent_msg_1', kind: 'message',
      state: { kind: 'message', anchorId: 'ent_task_1', rootMessageId: null, author: actor },
      content: { kind: 'message', body: 'hello', mentions: [], attachments: [] },
      replyCount: 1,
      replies: {
        items: [{
          ...taskSummary, id: 'ent_msg_2', kind: 'message',
          state: { kind: 'message', anchorId: 'ent_task_1', rootMessageId: 'ent_msg_1', author: actor },
          content: { kind: 'message', body: 'reply', mentions: [], attachments: [] },
          replyCount: 0,
        }],
        nextCursor: null,
      },
    };
    expect(MessageViewSchema.safeParse(msg).success).toBe(true);
  });

  it('validates WorkspaceEvent unions incl. clientMutationId threading (DEV-9)', () => {
    const ev: WorkspaceEvent = { type: 'entity.upsert', eventId: 'evt_1', entity: taskSummary, clientMutationId: 'cmid-1' };
    expect(WorkspaceEventSchema.safeParse(ev).success).toBe(true);
    expect(WorkspaceEventSchema.safeParse({ type: 'entity.exploded', eventId: 'evt_2', entity: taskSummary }).success).toBe(false);
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
    const base = { spaceId: 'space_1', title: 'x' };
    for (const kind of ['message', 'member', 'work_session']) {
      expect(CreateEntityInputSchema.safeParse({ ...base, kind }).success).toBe(false);
    }
    expect(CreateEntityInputSchema.safeParse({ ...base, kind: 'doc' }).success).toBe(true);
    expect(CreateEntityInputSchema.safeParse({ ...base, kind: 'c:design_asset' }).success).toBe(true);
  });

  it('execution.spawn validates persona + mode enums', () => {
    const ok = { spaceId: 'space_1', teamMemberId: 'ent_tm_1', taskIds: ['ent_task_1'], mode: 'worker' };
    expect(ExecutionSpawnInputSchema.safeParse(ok).success).toBe(true);
    expect(ExecutionSpawnInputSchema.safeParse({ ...ok, mode: 'boss' }).success).toBe(false);
    expect(ExecutionSpawnInputSchema.safeParse({ spaceId: 'space_1' }).success).toBe(false);
  });

  it('actor summaries validate', () => {
    expect(ActorSummarySchema.safeParse(actor).success).toBe(true);
    expect(ActorSummarySchema.safeParse({ ...actor, kind: 'robot' }).success).toBe(false);
  });
});
