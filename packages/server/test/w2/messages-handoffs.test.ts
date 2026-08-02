import {
  CollabError,
  HandoffViewSchema,
  MessageBatchResultSchema,
  MessageDeliveryViewSchema,
  decodeCursor,
  getOperation,
  type HandoffView,
  type MessageView,
  type OperationName,
  type Page,
} from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { EntityRow } from '../../src/facade/entity-read.js';
import { registerW2MessagesHandoffsHandlers } from '../../src/facade/handlers/w2/messages-handoffs.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { OperationHandler, RequestContext } from '../../src/http/types.js';

const OWNER = {
  identityId: 'message-owner',
  accountId: '11111111-1111-4111-8111-111111111111',
  username: 'message-owner',
  isNodeAdmin: true,
  isOwner: true,
};

const IDS = {
  space: '22222222-2222-4222-8222-222222222222',
  anchor: '33333333-3333-4333-8333-333333333333',
  message: '44444444-4444-4444-8444-444444444444',
  author: '55555555-5555-4555-8555-555555555555',
  mention: '66666666-6666-4666-8666-666666666666',
  file: '77777777-7777-4777-8777-777777777777',
  sourceSession: '88888888-8888-4888-8888-888888888888',
  targetSession: '99999999-9999-4999-8999-999999999999',
  delivery: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  handoff: 'handoff-client-mutation-key',
  source: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

const NOW = '2026-07-26T12:00:00.000Z';

function messageRow(overrides: Partial<EntityRow> = {}): EntityRow {
  return {
    id: IDS.message,
    space_id: IDS.space,
    kind: 'message',
    parent_id: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activity_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
    created_by: IDS.author,
    likes: 0,
    dislikes: 0,
    stars: 0,
    points: 0,
    messages: 0,
    task_title: null,
    task_description: null,
    task_axes: null,
    work_status: null,
    priority: null,
    acceptance_criteria: null,
    points_estimate: null,
    due_date: null,
    doc_title: null,
    doc_body: null,
    doc_format: null,
    channel_name: null,
    channel_topic: null,
    member_display_name: null,
    member_role: null,
    team_member_name: null,
    team_member_model: null,
    team_member_agent_tool: null,
    team_member_owner_id: null,
    team_member_identity: null,
    team_member_avatar: null,
    team_member_capabilities: null,
    team_member_command_permissions: null,
    team_member_memories: null,
    collection_name: null,
    collection_description: null,
    collection_type: null,
    ws_title: null,
    ws_status: null,
    ws_agent_tool: null,
    ws_model: null,
    ws_share_mode: null,
    ws_started_at: null,
    ws_exited_at: null,
    ws_node_id: null,
    ws_project_id: null,
    ws_transcript_doc_id: null,
    anchor_id: IDS.anchor,
    root_message_id: null,
    author_id: IDS.author,
    message_batch_id: 'batch-1',
    message_body: 'stored body',
    message_mentions: [{ entityId: IDS.mention, kind: 'member', display: 'Mention' }],
    message_attachments: [{ fileEntityId: IDS.file, name: 'proof.txt', mime: 'text/plain' }],
    message_edited_at: null,
    message_redacted_at: null,
    file_name: null,
    file_mime: null,
    file_size: null,
    ...overrides,
  };
}

const HANDOFF: HandoffView = {
  handoffId: IDS.handoff,
  sourceEntityId: IDS.source,
  targetWorkSessionId: IDS.targetSession,
  deliveryStatus: 'prepared',
  recordStatus: 'pending',
  sourceSnapshot: {
    entityId: IDS.source,
    kind: 'task',
    title: 'Source task',
    contentVersion: 4,
    sourceSpaceId: IDS.space,
    body: 'security-labelled projection',
    bodyBytes: 28,
    truncated: false,
    omittedFields: [],
  },
  envelopeHash: 'f'.repeat(64),
  sourceMissing: false,
  recordVersion: 1,
  withdrawnBy: null,
  withdrawnAt: null,
  withdrawReason: null,
  createdAt: NOW,
  updatedAt: NOW,
};

type DbCall = {
  kind: 'query' | 'rpc';
  claims: DbClaims;
  name: string;
  args: readonly unknown[];
  inTx: boolean;
};

class FakeDb implements Db {
  readonly calls: DbCall[] = [];
  inTx = false;
  rpcImpl: <T>(fn: string, args: readonly unknown[]) => Promise<T> = async (fn) => {
    throw new Error(`unexpected rpc: ${fn}`);
  };
  queryImpl: <R>(sql: string, params: readonly unknown[]) => Promise<R[]> = async (sql, params) => {
    if (sql.includes('profile_display_name')) {
      return [{
        id: IDS.author,
        kind: 'member',
        space_id: IDS.space,
        member_display_name: 'Message Author',
        member_role: 'owner',
        team_member_name: null,
        team_member_avatar: null,
        team_member_owner_id: null,
        profile_display_name: 'Message Author',
        profile_avatar: null,
      }] as R[];
    }
    if (sql.includes('left join public.messages msg')) {
      const requested = Array.isArray(params[0]) ? params[0] as string[] : [];
      if (requested.includes(IDS.anchor)) {
        return [messageRow({
          id: IDS.anchor,
          kind: 'channel',
          channel_name: 'Identity channel',
          anchor_id: null,
          author_id: null,
          message_batch_id: null,
          message_body: null,
          message_mentions: null,
          message_attachments: null,
        })] as R[];
      }
      return [messageRow()] as R[];
    }
    return [];
  };

  async tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    this.inTx = true;
    try {
      return await fn({
        query: async <R>(sql: string, params: readonly unknown[] = []) => {
          this.calls.push({ kind: 'query', claims, name: sql, args: params, inTx: this.inTx });
          return this.queryImpl<R>(sql, params);
        },
        rpc: async <R>(name: string, args: readonly unknown[] = []) => {
          this.calls.push({ kind: 'rpc', claims, name, args, inTx: this.inTx });
          return this.rpcImpl<R>(name, args);
        },
      });
    } finally {
      this.inTx = false;
    }
  }

  async rpc<T>(claims: DbClaims, name: string, args: readonly unknown[] = []): Promise<T> {
    this.calls.push({ kind: 'rpc', claims, name, args, inTx: this.inTx });
    return this.rpcImpl<T>(name, args);
  }

  async query<R>(claims: DbClaims, sql: string, params: readonly unknown[] = []): Promise<R[]> {
    this.calls.push({ kind: 'query', claims, name: sql, args: params, inTx: this.inTx });
    return this.queryImpl<R>(sql, params);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

function request(
  opName: OperationName,
  options: {
    params?: Record<string, string>;
    body?: unknown;
    query?: URLSearchParams;
  } = {},
): RequestContext {
  const op = getOperation(opName);
  return {
    op,
    opName,
    params: options.params ?? {},
    query: options.query ?? new URLSearchParams(),
    body: options.body,
    requestId: `request-${opName}`,
    identity: { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

function handler(registry: HandlerRegistry, name: OperationName): OperationHandler {
  const value = registry.get(name);
  if (!value) throw new Error(`missing handler: ${name}`);
  return value;
}

function deps(db: Db) {
  return {
    db,
    config: {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024 * 1024,
      databaseUrl: 'postgres://unused',
    },
    owner: async () => OWNER,
  };
}

describe('W2.G04 message, delivery, and handoff facade', () => {
  it('exports one seam that registers exactly the ten catalog operations', () => {
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(new FakeDb()));
    expect(registry.implemented()).toEqual([
      'handoffs.list',
      'handoffs.send',
      'handoffs.withdraw',
      'messages.attachments.add',
      'messages.attachments.remove',
      'messages.delete',
      'messages.delivery.get',
      'messages.edit',
      'messages.list',
      'messages.post',
    ]);
  });

  it('stores one atomic batch before dispatch and accepts authored_from only from the server resolver', async () => {
    const db = new FakeDb();
    const order: string[] = [];
    db.rpcImpl = async <T>(name, args) => {
      expect(name).toBe('w2_post_message_batch');
      order.push(`rpc:${db.inTx}`);
      expect(args).toEqual([
        [IDS.anchor],
        'stored body',
        null,
        [IDS.mention],
        [IDS.file],
        IDS.sourceSession,
        IDS.author,
        'batch-1',
      ]);
      return {
        messageBatchId: 'batch-1',
        messageIds: [IDS.message],
        deliveryIntents: [{
          messageId: IDS.message,
          targetWorkSessionId: IDS.targetSession,
          content: 'stored body',
          mode: 'send',
        }],
      } as T;
    };
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(db), {
      resolveAuthoredFromWorkSessionId: async () => IDS.sourceSession,
      messageDelivery: {
        reserve: async (intent) => {
          order.push(`reserve:${db.inTx}`);
          expect(intent).toMatchObject({
            requestId: 'request-messages.post',
            messageId: IDS.message,
            targetWorkSessionId: IDS.targetSession,
            incomingMessage: {
              messageId: IDS.message,
              author: { actorId: IDS.author, displayName: 'Message Author', isAgent: false },
              anchor: { id: IDS.anchor, kind: 'channel', title: 'Identity channel', spaceId: IDS.space },
              rootMessageId: null,
              parentMessageId: null,
              sourceSessionId: IDS.sourceSession,
              body: 'stored body',
            },
          });
          return {
            deliveryId: IDS.delivery,
            messageId: IDS.message,
            targetWorkSessionId: IDS.targetSession,
            reservationVersion: 3,
            expiresAt: '2026-07-26T12:15:00.000Z',
            content: 'stored body',
            mode: 'send',
          };
        },
        principalFor: (reservation) => ({ reserved: reservation.deliveryId }),
        adapter: {
          dispatch: async (attempt) => {
            order.push(`dispatch:${db.inTx}`);
            expect(attempt).toMatchObject({
              deliveryId: IDS.delivery,
              requestId: 'request-messages.post',
              messageId: IDS.message,
              principal: { reserved: IDS.delivery },
            });
            return { outcome: 'delivered' };
          },
        },
      },
    });

    const result = await handler(registry, 'messages.post')(request('messages.post', {
      body: {
        clientMutationId: 'batch-1',
        actorId: IDS.author,
        anchorIds: [IDS.anchor],
        body: 'stored body',
        parentMessageId: null,
        mentionIds: [IDS.mention],
        attachmentIds: [IDS.file],
        // A hostile extra property can never become provenance because only
        // the server resolver supplies the RPC's source-work-session argument.
        authoredFromWorkSessionId: IDS.targetSession,
      },
    }));

    expect(MessageBatchResultSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ messageBatchId: 'batch-1', messages: [{ id: IDS.message }] });
    expect(order).toEqual(['rpc:true', 'reserve:false', 'dispatch:false']);
  });

  it('maps frozen PostgreSQL detail strings to the contract details.reason field', async () => {
    const db = new FakeDb();
    db.rpcImpl = async () => {
      throw new CollabError('invariant_violation', 'message batch identity mismatch', {
        details: { detail: 'message_batch_identity_mismatch' },
      });
    };
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(db));

    await expect(handler(registry, 'messages.post')(request('messages.post', {
      body: {
        clientMutationId: 'batch-mismatch',
        anchorIds: [IDS.anchor],
        body: 'stored body',
      },
    }))).rejects.toMatchObject({
      code: 'invariant_violation',
      details: { reason: 'message_batch_identity_mismatch' },
    });
  });

  it('re-derives patch mentions by id and uses versioned tombstone/attachment commands', async () => {
    const db = new FakeDb();
    db.rpcImpl = async <T>(name) => ({ messageId: IDS.message, rpc: name }) as T;
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(db));

    await handler(registry, 'messages.edit')(request('messages.edit', {
      params: { id: IDS.message },
      body: {
        clientMutationId: 'edit-1',
        expectedVersion: 1,
        body: 'edited body',
        mentions: [{ entityId: IDS.mention, kind: 'team_member', display: 'forged display' }],
      },
    }));
    await handler(registry, 'messages.delete')(request('messages.delete', {
      params: { id: IDS.message },
      body: { clientMutationId: 'delete-1', expectedVersion: 2 },
    }));
    await handler(registry, 'messages.attachments.add')(request('messages.attachments.add', {
      params: { messageId: IDS.message },
      body: { clientMutationId: 'add-1', expectedVersion: 3, fileEntityIds: [IDS.file] },
    }));
    await handler(registry, 'messages.attachments.remove')(request('messages.attachments.remove', {
      params: { messageId: IDS.message },
      body: { clientMutationId: 'remove-1', expectedVersion: 4, fileEntityIds: [IDS.file] },
    }));

    const rpcCalls = db.calls.filter((call) => call.kind === 'rpc');
    expect(rpcCalls.map((call) => call.name)).toEqual([
      'w2_edit_message',
      'w2_tombstone_message',
      'w2_add_message_attachments',
      'w2_remove_message_attachments',
    ]);
    expect(rpcCalls[0]?.args).toEqual([
      IDS.message, 'edited body', [IDS.mention], 1, null, 'edit-1',
    ]);
    expect(rpcCalls[1]?.args).toEqual([IDS.message, 2, null, 'delete-1']);
    expect(rpcCalls[2]?.args).toEqual([IDS.message, [IDS.file], 3, null, 'add-1']);
    expect(rpcCalls[3]?.args).toEqual([IDS.message, [IDS.file], 4, null, 'remove-1']);
  });

  it('reads delivery truth through RLS without calling any delivery-role RPC', async () => {
    const db = new FakeDb();
    db.queryImpl = async <R>(sql) => {
      if (sql.includes('profile_display_name')) return [{
        id: IDS.author, kind: 'member', space_id: IDS.space,
        member_display_name: 'Message Author', member_role: 'owner',
        team_member_name: null, team_member_avatar: null, team_member_owner_id: null,
        profile_display_name: 'Message Author', profile_avatar: null,
      }] as R[];
      if (sql.includes('left join public.messages msg')) return [messageRow()] as R[];
      if (sql.includes('from public.session_message_deliveries')) return [{
        id: IDS.delivery,
        message_id: IDS.message,
        source_work_session_id: IDS.sourceSession,
        target_work_session_id: IDS.targetSession,
        status: 'failed_permanent',
        attempt_no: 1,
        failure_reason: 'session_not_live',
        reserved_at: NOW,
        claimed_at: null,
        settled_at: NOW,
        updated_at: NOW,
      }] as R[];
      return [];
    };
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(db));

    const result = await handler(registry, 'messages.delivery.get')(
      request('messages.delivery.get', { params: { messageId: IDS.message } }),
    );
    expect(MessageDeliveryViewSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({
      message: { id: IDS.message },
      deliveries: [{ deliveryId: IDS.delivery, status: 'failed_permanent' }],
    });
    expect(db.calls.filter((call) => call.kind === 'rpc')).toEqual([]);
    const deliveryCall = db.calls.find((call) =>
      call.kind === 'query' && call.name.includes('from public.session_message_deliveries'));
    expect(deliveryCall?.name).toContain('delivery_id id');
    expect(deliveryCall?.name).toContain('order by reserved_at asc,delivery_id asc');
  });

  it('runs handoff prepare, durable claim, actual write, and terminal recording as separate transactions', async () => {
    const db = new FakeDb();
    const order: string[] = [];
    db.rpcImpl = async <T>(name, args) => {
      order.push(`${name}:${db.inTx}`);
      if (name === 'w2_prepare_handoff') {
        expect(args).toEqual([
          IDS.handoff, IDS.source, IDS.targetSession, null, null, 'epoch-7',
        ]);
        return { handoff: HANDOFF, dispatch: {
          handoffId: IDS.handoff,
          requestId: 'request-handoffs.send',
          targetWorkSessionId: IDS.targetSession,
          sessionEpoch: 'epoch-7',
          envelopeHash: HANDOFF.envelopeHash,
          content: HANDOFF.sourceSnapshot.body,
          mode: 'send',
        } } as T;
      }
      if (name === 'w2_claim_handoff_dispatch') return { state: 'claimed' } as T;
      if (name === 'w2_settle_handoff') {
        return { ...HANDOFF, deliveryStatus: 'delivered', recordStatus: 'recorded', recordVersion: 2 } as T;
      }
      throw new Error(`unexpected rpc ${name}`);
    };
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(db), {
      resolveTargetWorkSessionEpoch: async (target) => {
        expect(target).toBe(IDS.targetSession);
        return 'epoch-7';
      },
      handoffDelivery: {
        writeAttempt: async (dispatch) => {
          order.push(`proc.write:${db.inTx}`);
          expect(dispatch).toMatchObject({ handoffId: IDS.handoff, sessionEpoch: 'epoch-7' });
          return { outcome: 'delivered' };
        },
      },
    });

    const result = await handler(registry, 'handoffs.send')(request('handoffs.send', {
      params: { workSessionId: IDS.targetSession },
      body: { clientMutationId: IDS.handoff, sourceEntityId: IDS.source },
    }));
    expect(HandoffViewSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ deliveryStatus: 'delivered', recordStatus: 'recorded' });
    expect(order).toEqual([
      'w2_prepare_handoff:true',
      'w2_claim_handoff_dispatch:false',
      'proc.write:false',
      'w2_settle_handoff:false',
    ]);
  });

  it('joins a pending same-handoff dispatch and performs exactly one PTY write', async () => {
    const db = new FakeDb();
    let prepares = 0;
    let claims = 0;
    let writes = 0;
    let settlements = 0;
    let releaseWrite!: () => void;
    let markWriteStarted!: () => void;
    let markSecondPrepared!: () => void;
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const secondPrepared = new Promise<void>((resolve) => { markSecondPrepared = resolve; });
    const dispatch = {
      handoffId: IDS.handoff,
      requestId: 'request-handoffs.send',
      targetWorkSessionId: IDS.targetSession,
      sessionEpoch: 'epoch-7',
      envelopeHash: HANDOFF.envelopeHash,
      content: HANDOFF.sourceSnapshot.body,
      mode: 'send' as const,
    };
    db.rpcImpl = async <T>(name) => {
      if (name === 'w2_prepare_handoff') {
        prepares += 1;
        if (prepares === 2) markSecondPrepared();
        return { handoff: HANDOFF, dispatch } as T;
      }
      if (name === 'w2_claim_handoff_dispatch') {
        claims += 1;
        return { state: 'claimed' } as T;
      }
      if (name === 'w2_settle_handoff') {
        settlements += 1;
        return { ...HANDOFF, deliveryStatus: 'delivered', recordStatus: 'recorded' } as T;
      }
      throw new Error(`unexpected rpc ${name}`);
    };
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(db), {
      resolveTargetWorkSessionEpoch: async () => 'epoch-7',
      handoffDelivery: {
        writeAttempt: async () => {
          writes += 1;
          markWriteStarted();
          await writeGate;
          return { outcome: 'delivered' };
        },
      },
    });
    const invoke = () => handler(registry, 'handoffs.send')(request('handoffs.send', {
      params: { workSessionId: IDS.targetSession },
      body: { clientMutationId: IDS.handoff, sourceEntityId: IDS.source },
    }));

    const first = invoke();
    await writeStarted;
    const duplicate = invoke();
    await secondPrepared;
    await Promise.resolve();
    releaseWrite();
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      expect.objectContaining({ deliveryStatus: 'delivered', recordStatus: 'recorded' }),
      expect.objectContaining({ deliveryStatus: 'delivered', recordStatus: 'recorded' }),
    ]);
    expect({ prepares, claims, writes, settlements }).toEqual({
      prepares: 2,
      claims: 1,
      writes: 1,
      settlements: 1,
    });
  });

  it('lists and withdraws durable handoff history without deleting its correlated record', async () => {
    const withdrawn = {
      ...HANDOFF,
      deliveryStatus: 'delivered' as const,
      recordStatus: 'withdrawn' as const,
      recordVersion: 3,
      withdrawnBy: {
        id: IDS.author,
        kind: 'member' as const,
        displayName: 'Message Author',
        avatar: null,
        role: 'owner',
        isAgent: false,
      },
      withdrawnAt: NOW,
      withdrawReason: 'superseded',
    };
    const db = new FakeDb();
    db.rpcImpl = async <T>(name) => {
      expect(name).toBe('w2_withdraw_handoff');
      return withdrawn as T;
    };
    db.queryImpl = async <R>(sql) => {
      if (sql.includes('from public.session_handoffs')) return [{ view: withdrawn }] as R[];
      return [];
    };
    const registry = new HandlerRegistry();
    registerW2MessagesHandoffsHandlers(registry, deps(db));

    const listed = await handler(registry, 'handoffs.list')(request('handoffs.list', {
      params: { workSessionId: IDS.targetSession },
      query: new URLSearchParams({ deliveryStatus: 'delivered', recordStatus: 'withdrawn' }),
    }));
    expect(listed).toMatchObject({ items: [{ handoffId: IDS.handoff }], nextCursor: null });
    const listCall = db.calls.find((entry) =>
      entry.kind === 'query' && entry.name.includes('from public.session_handoffs'));
    expect(listCall?.name).toContain('h.handoff_id');
    expect(listCall?.name).not.toContain('h.id');

    const result = await handler(registry, 'handoffs.withdraw')(request('handoffs.withdraw', {
      params: { handoffId: IDS.handoff },
      body: {
        clientMutationId: 'withdraw-1',
        expectedRecordVersion: 2,
        reason: 'superseded',
      },
    }));
    expect(HandoffViewSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ recordStatus: 'withdrawn', recordVersion: 3 });
    const call = db.calls.find((entry) => entry.kind === 'rpc');
    expect(call?.args).toEqual([
      IDS.handoff, 2, 'superseded', null, 'withdraw-1',
    ]);
  });

  // A06 returns Page<HandoffView>, so the dossier's keyset-cursor law applies to
  // it. Both cases below were previously unproven: nothing in either G04 suite
  // exercised a cursor beyond asserting `nextCursor: null` on a one-row page.
  describe('handoffs.list keyset cursor', () => {
    const SECOND = { ...HANDOFF, handoffId: 'handoff-client-mutation-key-2' };

    function pagingDb(): FakeDb {
      const db = new FakeDb();
      db.queryImpl = async <R>(sql, params) => {
        if (!sql.includes('from public.session_handoffs')) return [];
        // Page 2 is whatever survives the keyset predicate; the fake models that
        // by returning only the second row once bound keyset params are present.
        const rows = params.length > 3
          ? [{ view: SECOND, cursor_created_at: NOW, id: SECOND.handoffId }]
          : [
            { view: HANDOFF, cursor_created_at: NOW, id: HANDOFF.handoffId },
            { view: SECOND, cursor_created_at: NOW, id: SECOND.handoffId },
          ];
        return rows as R[];
      };
      return db;
    }

    function listWith(db: FakeDb, query: URLSearchParams): Promise<unknown> {
      const registry = new HandlerRegistry();
      registerW2MessagesHandoffsHandlers(registry, deps(db));
      return handler(registry, 'handoffs.list')(request('handoffs.list', {
        params: { workSessionId: IDS.targetSession },
        query,
      }));
    }

    it('emits a keyset cursor and re-accepts it as bound keyset parameters', async () => {
      const db = pagingDb();
      const page1 = await listWith(db, new URLSearchParams({
        deliveryStatus: 'delivered,refused', limit: '1',
      })) as Page<HandoffView>;

      expect(page1.items).toEqual([HANDOFF]);
      expect(page1.nextCursor).toBeTruthy();
      expect(decodeCursor(page1.nextCursor!).k).toHaveLength(3);

      const page2 = await listWith(db, new URLSearchParams({
        deliveryStatus: 'delivered,refused', limit: '1', cursor: page1.nextCursor!,
      })) as Page<HandoffView>;

      expect(page2.items).toEqual([SECOND]);
      const lastCall = db.calls.at(-1);
      expect(lastCall?.name).toContain('(h.created_at,h.handoff_id) > ($4::timestamptz,$5::text)');
      expect(lastCall?.args.slice(3)).toEqual([NOW, HANDOFF.handoffId]);
    });

    it('treats an equivalently reordered status filter as the same cursor fingerprint', async () => {
      const db = pagingDb();
      const page1 = await listWith(db, new URLSearchParams({
        deliveryStatus: 'delivered,refused', limit: '1',
      })) as Page<HandoffView>;
      expect(page1.nextCursor).toBeTruthy();

      // `= any($2::text[])` is order-insensitive, so this is the SAME filter.
      // A keyset cursor must stay stable across it; only a genuinely different
      // filter/sort may be rejected.
      const page2 = await listWith(db, new URLSearchParams({
        deliveryStatus: 'refused,delivered', limit: '1', cursor: page1.nextCursor!,
      })) as Page<HandoffView>;

      expect(page2.items).toEqual([SECOND]);
    });

    it('still refuses a cursor whose filter genuinely differs', async () => {
      const db = pagingDb();
      const page1 = await listWith(db, new URLSearchParams({
        deliveryStatus: 'delivered,refused', limit: '1',
      })) as Page<HandoffView>;

      // Canonicalizing the filter must not make the fingerprint permissive.
      await expect(listWith(db, new URLSearchParams({
        deliveryStatus: 'delivered', limit: '1', cursor: page1.nextCursor!,
      }))).rejects.toMatchObject({ code: 'invalid_cursor' });

      await expect(listWith(db, new URLSearchParams({
        deliveryStatus: 'delivered,refused', recordStatus: 'recorded',
        limit: '1', cursor: page1.nextCursor!,
      }))).rejects.toMatchObject({ code: 'invalid_cursor' });
    });

    it('refuses a malformed cursor without touching the database', async () => {
      const db = pagingDb();
      await expect(listWith(db, new URLSearchParams({ cursor: 'not-a-real-cursor' })))
        .rejects.toMatchObject({ code: 'invalid_cursor' });
      await expect(listWith(db, new URLSearchParams({ cursor: '42' })))
        .rejects.toMatchObject({ code: 'invalid_cursor' });
      expect(db.calls).toEqual([]);
    });

    it('traverses every page exactly once when two handoffs share one timestamp', async () => {
      // B collides with A on created_at, so a naive timestamp-only keyset would
      // either skip B or replay A forever. The row-value comparison must not.
      const T1 = '2026-07-26T12:00:00.000Z';
      const T2 = '2026-07-26T13:00:00.000Z';
      const dataset = [
        { at: T1, id: 'h-a' },
        { at: T1, id: 'h-b' },
        { at: T2, id: 'h-c' },
      ];
      const db = new FakeDb();
      db.queryImpl = async <R>(sql, params) => {
        if (!sql.includes('from public.session_handoffs')) return [];
        const take = Number(/limit (\d+)/.exec(sql)?.[1] ?? '0');
        const after = params.length > 3
          ? { at: String(params[3]), id: String(params[4]) }
          : null;
        return dataset
          .filter((row) => !after || row.at > after.at || (row.at === after.at && row.id > after.id))
          .slice(0, take)
          .map((row) => ({
            view: { ...HANDOFF, handoffId: row.id },
            cursor_created_at: row.at,
            id: row.id,
          })) as R[];
      };

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard += 1) {
        const query = new URLSearchParams({ limit: '1' });
        if (cursor) query.set('cursor', cursor);
        const page = await listWith(db, query) as Page<HandoffView>;
        seen.push(...page.items.map((item) => item.handoffId));
        cursor = page.nextCursor;
        if (!cursor) break;
      }

      expect(seen).toEqual(['h-a', 'h-b', 'h-c']);
      expect(new Set(seen).size).toBe(seen.length);
      expect(cursor).toBeNull();
    });
  });
});
