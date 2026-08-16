/**
 * W2 G11 — execution and session lifecycle. B1 (`execution.prompt` is
 * Server-internal-only) and B2 (one durable unordered pair budget), at the
 * server API boundary.
 *
 * THE ORACLE THIS FILE EXISTS TO BE
 *
 * B1 is not "the handler returns 403". A guard that refuses everyone passes
 * every negative anyone will ever write, and would be indistinguishable here
 * from deleting the operation. So each negative is paired with the POSITIVE
 * half — an internally minted, pre-reserved delivery still reaches the PTY —
 * and both halves read the SAME two observers:
 *
 *   `db.calls`  — every RPC and transaction the path attempted. B1 says a
 *                 public caller is refused BEFORE queue admission, and
 *                 `record_execution_command` IS queue admission: it is the
 *                 audited row that says a prompt was accepted. A refusal that
 *                 writes it has already admitted the prompt.
 *   `pty.bytes` — bytes actually pushed at a live terminal. Zero is the
 *                 second half of B1's "zero queue and zero bytes"; a nonzero
 *                 count with a 403 response is the worst outcome available,
 *                 because the caller is told no after the agent was typed at.
 *
 * `owner.calls` is a third, weaker observer: the public refusal must precede
 * even resolving the loopback owner, which is a database round trip. It is not
 * a law, it is evidence that the guard is the FIRST statement on the path
 * rather than a late branch — the defect class this program keeps finding is
 * an authorization check that is not the first thing the path does.
 *
 * The fake PTY reports `hasSession` TRUE throughout. That is deliberate and it
 * is the difference between a real red and a counterfeit one: SpawnService
 * refuses a prompt for a session with no live terminal, so a fake that said
 * `false` would make every negative pass for a reason that has nothing to do
 * with B1, and the suite would go green over an unguarded route.
 */
import { describe, expect, it, vi } from 'vitest';

import { registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import {
  W2ExecutionDeliveryService,
  createW2ExecutionDelivery,
  type DeliveryPrincipalLease,
  type DeliverySettlementStatus,
  type StoredDelivery,
  type W2DeliveryRpcPort,
} from '../../src/facade/services/w2/execution.js';
import type { W2MessagesHandoffsServiceOptions } from '../../src/facade/services/w2/messages-handoffs.js';
import { mintSystemDeliveryPrincipal } from '../../src/identity/index.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext, RequestIdentity } from '../../src/http/types.js';
import { getOperation, type OperationName } from '@tm8/contract';

// --- observers ---------------------------------------------------------------

const IDS = {
  session: '11111111-1111-4111-8111-111111111111',
  otherSession: '22222222-2222-4222-8222-222222222222',
  message: '33333333-3333-4333-8333-333333333333',
  delivery: '44444444-4444-4444-8444-444444444444',
  member: '55555555-5555-4555-8555-555555555555',
  teamMember: '66666666-6666-4666-8666-666666666666',
};

const OWNER: LoopbackOwner = {
  identityId: 'g11-owner-identity',
  accountId: '77777777-7777-4777-8777-777777777777',
  username: 'owner',
  isNodeAdmin: true,
  isOwner: true,
};

/** Records every database touch; answers nothing, because nothing should ask. */
class RecordingDb implements Db {
  readonly calls: string[] = [];

  async tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    this.calls.push('tx');
    const q: Querier = {
      query: async (sql: string) => {
        this.calls.push(`query:${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
        return [] as never[];
      },
      rpc: async (fn2: string) => {
        this.calls.push(`rpc:${fn2}`);
        return {} as never;
      },
    };
    return fn(q);
  }

  async rpc<T = unknown>(_claims: DbClaims, fn: string): Promise<T> {
    this.calls.push(`rpc:${fn}`);
    return {} as T;
  }

  async query<R = Record<string, unknown>>(_claims: DbClaims, sql: string): Promise<R[]> {
    this.calls.push(`query:${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`);
    return [];
  }

  async end(): Promise<void> {}
}

/**
 * A PTY that is LIVE. `hasSession` is true so no negative can pass by accident
 * (see the file header), and every byte that reaches it is counted.
 */
class RecordingPty {
  readonly deliveries: Array<{ sessionId: string; content: string; mode: string }> = [];
  bytes = 0;
  /** Flipped only by the B2 refusal case; every B1 negative runs against TRUE. */
  live = true;

  hasSession(): boolean {
    return this.live;
  }

  async deliverPrompt(sessionId: string, content: string, mode: 'send' | 'paste'): Promise<boolean> {
    this.deliveries.push({ sessionId, content, mode });
    this.bytes += Buffer.byteLength(content, 'utf8');
    return true;
  }

  kill(): string {
    return 'killed';
  }
}

/**
 * Fake `InternalPromptDeliverySettlement` (execution.ts) — these fixtures predate
 * the two-signal PromptSettlementWaiter bridge, so `RecordingPty.deliverPrompt`
 * above admits every delivery synchronously and never calls a real
 * `onPromptSettled`. Resolving 'delivered' immediately reproduces the OLD
 * admission-is-the-outcome behavior these tests were written against, without
 * pretending this fake models the real closed loop's timing at all.
 */
function fakePromptSettlement(): { awaitOutcome: () => Promise<{ outcome: 'delivered' }>; cancel: () => void } {
  return {
    awaitOutcome: async () => ({ outcome: 'delivered' }),
    cancel: () => {},
  };
}

const CONFIG = { host: '127.0.0.1', port: 4610 } as unknown as ServerConfig;

/**
 * A stand-in for the three RPCs that behaves like 015 §7 — including the wake
 * count and its refusal at four — but keeps that state OUTSIDE the service, in
 * this object, exactly as Postgres keeps it outside the process.
 *
 * That placement is the assertion. If `W2ExecutionDeliveryService` ever grew a
 * counter of its own, a service rebuilt over this same port would hand out a
 * fresh allowance and `restarting the service does not mint a fresh allowance`
 * below would fail. This is the cheap, no-database half of the durability
 * proof; the executable process-restart proof is in
 * `test/db/w2-execution.pg.test.ts` and destroys the connection pool too.
 */
class FakeDeliveryRpc implements W2DeliveryRpcPort {
  readonly calls: string[] = [];
  /** The durable counter, deliberately owned by the "database", not the service. */
  wakes = 0;
  /**
   * Message ids this "database" reserves as already-settled.
   *
   * Used to be a `wakes >= 4` cap standing in for `automated_wake_limit`.
   * Migration `120` removed that refusal from the schema, so a fake that still
   * produced it would be modelling a database that no longer exists. The TS
   * behaviour under test never depended on WHICH refusal it was — the service
   * returns null for ANY non-pending reservation and stops there — so the
   * trigger moved to a reason the schema still writes (`session_not_live`,
   * an exited or failed target) and the coverage is unchanged.
   */
  readonly refuse = new Set<string>();

  private readonly rows = new Map<string, StoredDelivery>();

  async reserve(lease: DeliveryPrincipalLease, attemptNo: number): Promise<StoredDelivery> {
    this.calls.push('reserve');
    if (this.refuse.has(lease.messageId)) {
      const refused: StoredDelivery = {
        deliveryId: lease.deliveryId,
        messageId: lease.messageId,
        targetWorkSessionId: lease.targetWorkSessionId,
        status: 'failed_permanent',
        attemptNo,
        pairBudgetVersion: this.wakes,
        failureReason: 'session_not_live',
      };
      this.rows.set(lease.deliveryId, refused);
      return refused;
    }
    this.wakes += 1;
    const row: StoredDelivery = {
      deliveryId: lease.deliveryId,
      messageId: lease.messageId,
      targetWorkSessionId: lease.targetWorkSessionId,
      status: 'pending',
      attemptNo,
      pairBudgetVersion: this.wakes,
      failureReason: null,
    };
    this.rows.set(lease.deliveryId, row);
    return row;
  }

  async claim(lease: DeliveryPrincipalLease): Promise<StoredDelivery> {
    this.calls.push('claim');
    const row = this.rows.get(lease.deliveryId)!;
    if (row.pairBudgetVersion !== lease.pairBudgetVersion) {
      throw new Error('delivery reservation not found');
    }
    const claimed = { ...row, status: 'dispatching' as const };
    this.rows.set(lease.deliveryId, claimed);
    return claimed;
  }

  async settle(
    lease: DeliveryPrincipalLease,
    status: DeliverySettlementStatus,
    failureReason: string | null,
  ): Promise<StoredDelivery> {
    this.calls.push(`settle:${status}`);
    const settled = { ...this.rows.get(lease.deliveryId)!, status, failureReason };
    this.rows.set(lease.deliveryId, settled);
    return settled;
  }

  async close(): Promise<void> {
    this.calls.push('close');
  }

  statusOf(deliveryId: string): string | undefined {
    return this.rows.get(deliveryId)?.status;
  }
}

interface Harness {
  registry: HandlerRegistry;
  db: RecordingDb;
  pty: RecordingPty;
  ownerCalls: number;
}

function harness(): Harness {
  const registry = new HandlerRegistry();
  const db = new RecordingDb();
  const pty = new RecordingPty();
  const state = { ownerCalls: 0 };
  registerExecutionHandlers(registry, {
    db,
    pty: pty as never,
    config: CONFIG,
    owner: async () => {
      state.ownerCalls += 1;
      return OWNER;
    },
  });
  return {
    registry,
    db,
    pty,
    get ownerCalls() {
      return state.ownerCalls;
    },
  } as Harness;
}

function promptCtx(identity: RequestIdentity, body: Record<string, unknown> = {}): RequestContext {
  const opName = 'execution.prompt' as OperationName;
  return {
    op: getOperation(opName)!,
    opName,
    params: { id: IDS.session },
    query: new URLSearchParams(),
    body: { message: 'wake up', ...body },
    requestId: 'req-g11',
    identity,
    headers: {},
    method: 'POST',
    path: `/v2/entities/${IDS.session}/commands/prompt`,
  };
}

/**
 * Every public principal shape the adopted law names. They differ only in how
 * the caller presents themself, which is exactly the point: B1 is a property of
 * the OPERATION, so no presentation of any caller may reach the terminal.
 */
const PUBLIC_CALLERS: Array<{ label: string; identity: RequestIdentity; body?: Record<string, unknown> }> = [
  { label: 'Member', identity: { kind: 'bearer', identityId: 'member-identity', token: 't' } },
  {
    label: 'Teammate',
    identity: { kind: 'bearer', identityId: 'teammate-identity', actorId: IDS.teamMember, token: 't' },
  },
  { label: 'node owner', identity: { kind: 'auto-owner', identityId: OWNER.identityId } },
  { label: 'node admin', identity: { kind: 'bearer', identityId: 'admin-identity', token: 't' } },
  {
    label: 'spawned session',
    identity: { kind: 'bearer', identityId: 'session-identity', actorId: IDS.teamMember, token: 't' },
  },
  {
    label: 'act-as',
    identity: { kind: 'auto-owner', identityId: OWNER.identityId },
    body: { actorId: IDS.member },
  },
  { label: 'anonymous', identity: { kind: 'anonymous' } },
];

// --- B1 ----------------------------------------------------------------------

describe('B1 — execution.prompt is Server-internal-only', () => {
  for (const caller of PUBLIC_CALLERS) {
    it(`refuses a ${caller.label} with forbidden/use_message_send and writes nothing`, async () => {
      const h = harness();
      const handler = h.registry.get('execution.prompt' as OperationName)!;

      await expect(handler(promptCtx(caller.identity, caller.body))).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'use_message_send' },
      });

      // Zero queue: no audit row, no transaction, nothing reached the graph.
      expect(h.db.calls).toEqual([]);
      // Zero bytes: the live terminal was never typed at.
      expect(h.pty.deliveries).toEqual([]);
      expect(h.pty.bytes).toBe(0);
      // And the refusal preceded even the owner lookup.
      expect(h.ownerCalls).toBe(0);
    });
  }

  it('refuses before reading the message, so no body shape unlocks the route', async () => {
    const h = harness();
    const handler = h.registry.get('execution.prompt' as OperationName)!;
    for (const body of [{}, { message: '' }, { message: 'x'.repeat(4096) }]) {
      const ctx = { ...promptCtx({ kind: 'auto-owner', identityId: OWNER.identityId }), body };
      await expect(handler(ctx)).rejects.toMatchObject({
        code: 'forbidden',
        details: { reason: 'use_message_send' },
      });
    }
    expect(h.db.calls).toEqual([]);
    expect(h.pty.bytes).toBe(0);
  });

  it('still routes execution.spawn and execution.terminate — B1 closes ONE operation', async () => {
    const h = harness();
    expect(h.registry.has('execution.spawn' as OperationName)).toBe(true);
    expect(h.registry.has('execution.terminate' as OperationName)).toBe(true);
    expect(h.registry.has('execution.streams.attach' as OperationName)).toBe(true);
    // Registered, not deleted: the catalog still declares execution.prompt and a
    // node that dropped it would answer 501 and lie about its own contract.
    expect(h.registry.has('execution.prompt' as OperationName)).toBe(true);
  });
});

// --- B1, the positive half ---------------------------------------------------

describe('B1 — the internal delivery seam still works', () => {
  it('delivers for a minted principal bound to the reserved delivery', async () => {
    const h = harness();
    const runtime = h.registry as unknown as { internalPrompt?: unknown };
    void runtime;

    const { promptInternal } = await import('../../src/facade/services/w2/execution.js');
    const binding = {
      deliveryId: IDS.delivery,
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
      reservationVersion: 3,
    };
    const principal = mintSystemDeliveryPrincipal({
      ...binding,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const outcome = await promptInternal(
      { pty: h.pty as never, promptSettlement: fakePromptSettlement() },
      principal,
      { ...binding, content: 'wake up', mode: 'send' },
    );

    expect(outcome).toMatchObject({ outcome: 'delivered' });
    expect(h.pty.deliveries).toEqual([
      { sessionId: IDS.session, content: 'wake up', mode: 'send' },
    ]);
    expect(h.pty.bytes).toBeGreaterThan(0);
  });

  it('refuses a structurally identical principal that this process never minted', async () => {
    const h = harness();
    const { promptInternal } = await import('../../src/facade/services/w2/execution.js');
    const binding = {
      deliveryId: IDS.delivery,
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
      reservationVersion: 3,
    };
    const forged = {
      principalType: 'system_delivery_adapter',
      claims: { ...binding, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    };

    await expect(
      promptInternal(
        { pty: h.pty as never, promptSettlement: fakePromptSettlement() },
        forged,
        { ...binding, content: 'wake up', mode: 'send' },
      ),
    ).rejects.toThrow();
    expect(h.pty.bytes).toBe(0);
  });

  it('binds the principal to the ATTEMPT expiry, not merely to a live one', async () => {
    const h = harness();
    const { W2ExecutionDeliveryService: Service } = await import(
      '../../src/facade/services/w2/execution.js'
    );
    const rpc = new FakeDeliveryRpc();
    const service = new Service({ rpc, pty: h.pty as never, promptSettlement: fakePromptSettlement() });
    const reservation = await service.reserve({
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
      content: 'wake up',
      mode: 'send',
      requestId: 'req-g11',
    });
    const principal = service.principalFor(reservation!);

    // Same principal, an attempt claiming a LONGER lease than it was minted for.
    // The DB claim is stamped from the attempt, so a longer attempt expiry would
    // let the durable claim outlive the authority that permitted it.
    await expect(
      service.dispatch({
        ...reservation!,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        requestId: 'req-g11',
        principal,
      }),
    ).rejects.toThrow();
    expect(h.pty.bytes).toBe(0);
  });

  it('refuses a minted principal bound to a DIFFERENT session', async () => {
    const h = harness();
    const { promptInternal } = await import('../../src/facade/services/w2/execution.js');
    const principal = mintSystemDeliveryPrincipal({
      deliveryId: IDS.delivery,
      messageId: IDS.message,
      targetWorkSessionId: IDS.otherSession,
      reservationVersion: 3,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await expect(
      promptInternal(
        { pty: h.pty as never, promptSettlement: fakePromptSettlement() },
        principal,
        {
          deliveryId: IDS.delivery,
          messageId: IDS.message,
          targetWorkSessionId: IDS.session,
          reservationVersion: 3,
          content: 'wake up',
          mode: 'send',
        },
      ),
    ).rejects.toThrow();
    expect(h.pty.bytes).toBe(0);
  });
});

// --- B2, without a database --------------------------------------------------

/**
 * The fast half of B2. It cannot prove DURABILITY — only Postgres and a real
 * process teardown can, and `test/db/w2-execution.pg.test.ts` does — but it can
 * prove the two things that make durability possible, in under a millisecond:
 * that the whole path is routed through the RPC port, and that the service
 * itself remembers nothing between lives.
 *
 * The first test here is the one that matters most, and it is the one this
 * suite did not have when it first went green. `promptInternal` was proved
 * directly and passed; the SERVICE path around it was never exercised, and it
 * was broken — `isSystemDeliveryPrincipalFor` refused every delivery because
 * G04's adapter hands `authorize` a six-key binding and the guard demands
 * exactly four. A unit test of a component and a unit test of the same
 * component's wiring are different tests, and only the second one finds a seam
 * that does not fit.
 */
describe('B2 — the delivery path, over a fake RPC port', () => {
  function service(pty: RecordingPty, rpc = new FakeDeliveryRpc()) {
    return {
      rpc,
      service: new W2ExecutionDeliveryService({ rpc, pty: pty as never, promptSettlement: fakePromptSettlement() }),
    };
  }

  async function deliver(
    svc: W2ExecutionDeliveryService,
    messageId: string,
    target: string,
    content: string,
  ): Promise<{ reserved: boolean; outcome: string | null; deliveryId: string | null }> {
    const reservation = await svc.reserve({
      messageId,
      targetWorkSessionId: target,
      content,
      mode: 'send',
      requestId: 'req-g11',
    });
    if (!reservation) return { reserved: false, outcome: null, deliveryId: null };
    const result = await svc.dispatch({
      ...reservation,
      requestId: 'req-g11',
      principal: svc.principalFor(reservation),
    });
    return { reserved: true, outcome: result.outcome, deliveryId: reservation.deliveryId };
  }

  it('reserves, claims, WRITES and settles — the seam actually carries traffic', async () => {
    const pty = new RecordingPty();
    const { rpc, service: svc } = service(pty);

    const result = await deliver(svc, IDS.message, IDS.session, 'wake up');

    expect(result.outcome).toBe('delivered');
    expect(rpc.calls).toEqual(['reserve', 'claim', 'settle:delivered']);
    expect(pty.deliveries).toEqual([{ sessionId: IDS.session, content: 'wake up', mode: 'send' }]);
    expect(rpc.statusOf(result.deliveryId!)).toBe('delivered');
  });

  it('holds NO wake state: the counter lives in the database and the service never caps', async () => {
    const rpc = new FakeDeliveryRpc();
    const first = new W2ExecutionDeliveryService({
      rpc,
      pty: new RecordingPty() as never,
      promptSettlement: fakePromptSettlement(),
    });
    for (const message of ['m1', 'm2']) {
      expect((await deliver(first, message, IDS.session, 'x')).outcome).toBe('delivered');
    }
    expect(rpc.wakes).toBe(2);

    // A new service over the same durable state — the in-process analogue of a
    // restart. The count continues; it is not this object's to reset.
    const ptyAfter = new RecordingPty();
    const second = new W2ExecutionDeliveryService({
      rpc,
      pty: ptyAfter as never,
      promptSettlement: fakePromptSettlement(),
    });
    for (const message of ['m3', 'm4', 'm5', 'm6']) {
      expect((await deliver(second, message, IDS.session, 'x')).outcome).toBe('delivered');
    }
    // Straight past four. Since 120 nothing in this seam or under it caps a
    // pair, and a process-local counter reappearing here would show as a
    // refusal on the fifth.
    expect(rpc.wakes).toBe(6);
    expect(ptyAfter.deliveries).toHaveLength(4);

    // What the service must STILL do with a reservation the database settled
    // itself: return null and stop — no claim, no settle, no bytes. This is
    // the branch `automated_wake_limit` used to be the headline example of;
    // `session_not_live` is now the one that reaches it.
    rpc.refuse.add('m7');
    const refused = await deliver(second, 'm7', IDS.session, 'x');
    expect(refused).toMatchObject({ reserved: false, outcome: null });
    expect(ptyAfter.deliveries).toHaveLength(4);
    expect(rpc.calls.filter((c) => c === 'claim')).toHaveLength(6);
  });

  it('a refusal settles failed_retryable and writes no bytes', async () => {
    const pty = new RecordingPty();
    pty.live = false;
    const { rpc, service: svc } = service(pty);

    const result = await deliver(svc, IDS.message, IDS.session, 'wake up');

    expect(result.outcome).toBe('refused');
    expect(rpc.calls).toEqual(['reserve', 'claim', 'settle:failed_retryable']);
    expect(pty.bytes).toBe(0);
  });

  it('joins duplicate in-flight dispatches into ONE write', async () => {
    const pty = new RecordingPty();
    const { rpc, service: svc } = service(pty);
    const reservation = (await svc.reserve({
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
      content: 'wake up',
      mode: 'send',
      requestId: 'req-g11',
    }))!;
    const attempt = {
      ...reservation,
      requestId: 'req-g11',
      principal: svc.principalFor(reservation),
    };

    const [a, b] = await Promise.all([svc.dispatch(attempt), svc.dispatch(attempt)]);

    expect([a.outcome, b.outcome]).toEqual(['delivered', 'delivered']);
    expect(pty.deliveries).toHaveLength(1);
    expect(rpc.calls).toEqual(['reserve', 'claim', 'settle:delivered']);
  });
});

/**
 * The composition-root wiring, compile-checked HERE rather than in a snippet.
 *
 * G11 does not compose itself into the facade — the coordinator sequences that.
 * But handing over a wiring snippet that has never been type-checked is exactly
 * the failure the program just named on the migration side: verifying the
 * artifact is not verifying the artifact's delivery. This test IS the delivery
 * check. If `W2ExecutionDeliveryService` ever stops satisfying the seam G04
 * declared, this file stops compiling and nobody discovers it while pasting
 * into main.ts.
 */
describe('the seam handed to the composition root', () => {
  it('satisfies W2MessagesHandoffsServiceOptions.messageDelivery exactly', () => {
    const svc = new W2ExecutionDeliveryService({
      rpc: new FakeDeliveryRpc(),
      pty: new RecordingPty() as never,
      promptSettlement: fakePromptSettlement(),
    });

    const messageDelivery: NonNullable<W2MessagesHandoffsServiceOptions['messageDelivery']> = {
      reserve: (intent) => svc.reserve(intent),
      adapter: svc,
      principalFor: (reservation) => svc.principalFor(reservation),
    };

    expect(typeof messageDelivery.adapter.dispatch).toBe('function');
    expect(typeof messageDelivery.reserve).toBe('function');
    expect(typeof messageDelivery.principalFor).toBe('function');
  });
});

// --- the composition step, proved to be reached -----------------------------

/**
 * THE INTEGRATION TEST FOR THE WIRING ITSELF.
 *
 * B2's whole failure mode was never a wrong implementation — it was an
 * implementation nothing invoked. The delivery loop in `postMessageBatch` is
 * gated on `this.options.messageDelivery`, and until this landing no caller
 * anywhere in `packages/server/src` supplied it, so the loop ran zero times and
 * every proof of B2 lived below a seam production never crossed.
 *
 * So this test does not re-prove reserve/claim/settle — that is covered without
 * a database in the suite above and against a real Postgres in
 * `test/db/w2-execution.pg.test.ts`. It proves the ONE thing those cannot: that
 * `registerFacadeHandlers` actually carries the option through to the service.
 *
 * BOTH HALVES, because a "the wiring works" test that only runs the wired case
 * cannot tell a working pass-through from a service that always delivers:
 *   - WITHOUT the option, `messages.post` must reserve NOTHING;
 *   - WITH it, the same request must reserve and dispatch the same intent.
 * The two cases differ by exactly one argument, so a green pair localises the
 * behaviour to the pass-through and nothing else.
 */
describe('registerFacadeHandlers carries messageDelivery to the messages seam', () => {
  const ANCHOR = '88888888-8888-4888-8888-888888888888';

  /** A Db whose `w2_post_message_batch` emits one work_session delivery intent. */
  function deliveringDb(): Db {
    // `messageIds` is EMPTY on purpose, and the reason is worth stating rather
    // than hiding. `postMessageBatch` reloads every stored message after the
    // RPC and throws `upstream_unavailable` if the reload comes back short —
    // BEFORE the delivery loop, deliberately, because a batch that cannot be
    // read back must not be reported as delivered. Staging that reload here
    // would mean reproducing a ~60-column entity row, which is G04's own test's
    // job and not this one's. Empty ids reload consistently (0 === 0), so the
    // handler reaches the loop and the loop's ONLY input — `deliveryIntents` —
    // is exactly what this fixture controls.
    const rpcResult = {
      messageBatchId: 'batch-1',
      messageIds: [] as string[],
      deliveryIntents: [
        {
          messageId: IDS.message,
          targetWorkSessionId: IDS.session,
          content: 'wake up',
          mode: 'send' as const,
        },
      ],
    };
    const routeResult = [{
      targetMessageId: IDS.message,
      targetWorkSessionId: IDS.session,
      messageBatchId: 'batch-1',
      senderActorId: IDS.member,
      senderActorKind: 'member',
      sourceAnchorId: ANCHOR,
      sourceAnchorKind: 'channel',
      sourceMessageId: IDS.message,
      threadParentMessageId: null,
      threadRootMessageId: IDS.message,
      body: 'wake up',
      addressingKind: 'channel_mention',
      contextAnchors: [],
      rollingControlMaxBytes: 16_384,
      sessionInputAllowed: true,
    }];
    const q: Querier = {
      query: async () => [] as never[],
      rpc: async (fn: string) => (
        fn === 'w2_post_message_batch' ? rpcResult
          : fn === 'w2_record_session_message_routes' ? routeResult
            : {}
      ) as never,
    };
    return {
      tx: async <T>(_c: DbClaims, fn: (qq: Querier) => Promise<T>) => fn(q),
      rpc: async () => ({}) as never,
      query: async () => [] as never[],
      end: async () => {},
    } as Db;
  }

  function postCtx(): RequestContext {
    const opName = 'messages.post' as OperationName;
    return {
      op: getOperation(opName)!,
      opName,
      params: {},
      query: new URLSearchParams(),
      body: { anchorIds: [ANCHOR], body: 'wake up', clientMutationId: 'g11-wiring' },
      requestId: 'req-g11-wiring',
      identity: { kind: 'auto-owner', identityId: OWNER.identityId },
      headers: {},
      method: 'POST',
      path: '/v2/messages',
    };
  }

  async function run(wired: boolean): Promise<string[]> {
    const { registerFacadeHandlers } = await import('../../src/facade/index.js');
    const calls: string[] = [];
    const pty = new RecordingPty();
    const service = new W2ExecutionDeliveryService({
      rpc: new FakeDeliveryRpc(),
      pty: pty as never,
      promptSettlement: fakePromptSettlement(),
    });
    const registry = new HandlerRegistry();
    registerFacadeHandlers(registry, {
      db: deliveringDb(),
      config: CONFIG,
      owner: async () => OWNER,
      ...(wired
        ? {
            messageDelivery: {
              reserve: (intent) => {
                calls.push(`reserve:${intent.targetWorkSessionId}`);
                return service.reserve(intent);
              },
              adapter: service,
              principalFor: (r) => service.principalFor(r),
            },
          }
        : {}),
    });

    await (registry.get('messages.post' as OperationName)!)(postCtx());
    return calls;
  }

  it('reserves NOTHING when the option is absent — the state this landing changed', async () => {
    expect(await run(false)).toEqual([]);
  });

  it('reserves the emitted intent when the option is supplied', async () => {
    expect(await run(true)).toEqual([`reserve:${IDS.session}`]);
  });
});

// --- the diagnostic, with a negative control --------------------------------

/**
 * A logger that fires on everything is not a diagnostic, it is noise — and it
 * would pass a "does it log the failure" test exactly as well as a correct one.
 * So the control matters more than the red half here: a HEALTHY delivery must
 * log NOTHING, or the first real failure is invisible inside a stream of
 * routine lines.
 *
 * The second assertion in each failing case is the one that protects G04: the
 * exception must still PROPAGATE. Logging and swallowing would put a second
 * silence on top of the one this exists to lift, and the stored-first
 * guarantee belongs to `postMessageBatch`'s catch, not to this service.
 */
describe('the delivery diagnostic names failures without becoming noise', () => {
  interface Logged {
    message: string;
    meta: Record<string, unknown> | undefined;
  }

  function recordingLogger(lines: Logged[]) {
    return {
      error: (message: string, _e?: Error, meta?: Record<string, unknown>) =>
        lines.push({ message, meta }),
      warn: () => {},
      info: () => {},
      debug: () => {},
    };
  }

  it('CONTROL: a healthy reserve-and-dispatch logs NOTHING', async () => {
    const lines: Logged[] = [];
    const svc = new W2ExecutionDeliveryService({
      rpc: new FakeDeliveryRpc(),
      pty: new RecordingPty() as never,
      promptSettlement: fakePromptSettlement(),
      logger: recordingLogger(lines) as never,
    });
    const reservation = (await svc.reserve({
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
      content: 'wake up',
      mode: 'send',
      requestId: 'req-g11',
    }))!;
    await svc.dispatch({ ...reservation, requestId: 'req-g11', principal: svc.principalFor(reservation) });

    expect(lines).toEqual([]);
  });

  it('names a reserve failure with its type, message and SQLSTATE, and rethrows', async () => {
    const lines: Logged[] = [];
    const rpc = new FakeDeliveryRpc();
    // A pg driver error carries SQLSTATE on `code` — 42501 is what a refused
    // delivery principal actually raises.
    rpc.reserve = async () => {
      const err = Object.assign(new Error('system delivery adapter database role required'), {
        code: '42501',
      });
      throw err;
    };
    const svc = new W2ExecutionDeliveryService({
      rpc,
      pty: new RecordingPty() as never,
      promptSettlement: fakePromptSettlement(),
      logger: recordingLogger(lines) as never,
    });

    await expect(
      svc.reserve({
        messageId: IDS.message,
        targetWorkSessionId: IDS.session,
        content: 'wake up',
        mode: 'send',
        requestId: 'req-g11',
      }),
    ).rejects.toThrow(/delivery adapter database role/);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe('w2 delivery: reserve failed');
    expect(lines[0]!.meta).toMatchObject({
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
      type: 'Error',
      sqlstate: '42501',
    });
    // The body is the user's and must not be in a log line.
    expect(JSON.stringify(lines[0]!.meta)).not.toContain('wake up');
  });

  it('names a dispatch failure too — the half that reaches the terminal', async () => {
    const lines: Logged[] = [];
    const svc = new W2ExecutionDeliveryService({
      rpc: new FakeDeliveryRpc(),
      pty: new RecordingPty() as never,
      promptSettlement: fakePromptSettlement(),
      logger: recordingLogger(lines) as never,
    });
    const reservation = (await svc.reserve({
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
      content: 'wake up',
      mode: 'send',
      requestId: 'req-g11',
    }))!;

    // An unminted principal — the B1 refusal, reached through dispatch.
    await expect(
      svc.dispatch({ ...reservation, requestId: 'req-g11', principal: { forged: true } }),
    ).rejects.toThrow();

    expect(lines).toHaveLength(1);
    expect(lines[0]!.message).toBe('w2 delivery: dispatch failed');
    expect(lines[0]!.meta).toMatchObject({ deliveryId: reservation.deliveryId, sqlstate: null });
  });
});

// --- and the half that was missing: production actually HAS a logger ---------

/**
 * The three tests above proved the diagnostic works when a logger is supplied.
 * Nothing proved one ever WAS, and none was: `createW2ExecutionDelivery` copied
 * `logger` only `...(options.logger ? … : {})`, and the single production call
 * site omitted it. Every assertion above passed against a node whose delivery
 * failures were completely silent — which is how a `reserve()` that threw on
 * every message for days looked exactly like a node with nothing to deliver.
 *
 * So this is deliberately not a wiring assertion at the composition root. It
 * drives the real factory against an unreachable database and reads the
 * console: the failure has to be AUDIBLE with nobody having asked for it.
 */
describe('the production factory is audible by default', () => {
  // Port 1 is reserved and unbound: connect() refuses immediately rather than
  // hanging, so this is a fast, network-free-by-effect failure.
  const UNREACHABLE = 'postgres://tm8_delivery_worker@127.0.0.1:1/nowhere';

  const intent = {
    messageId: IDS.message,
    targetWorkSessionId: IDS.session,
    content: 'wake up',
    mode: 'send' as const,
    requestId: 'req-audible',
  };

  function buildWiring(logger?: {
    error: (message: string, error?: Error, meta?: Record<string, unknown>) => void;
    warn: () => void;
    info: () => void;
    debug: () => void;
  }) {
    return createW2ExecutionDelivery({
      connectionString: UNREACHABLE,
      pty: new RecordingPty() as never,
      promptSettlement: fakePromptSettlement() as never,
      ...(logger ? { logger: logger as never } : {}),
    });
  }

  /** Captured rather than read off the spy: `mockRestore` clears `mock.calls`. */
  async function reserveCapturingConsole(logger?: Parameters<typeof buildWiring>[0]): Promise<string[]> {
    const printed: string[] = [];
    const spy = vi
      .spyOn(console, 'error')
      .mockImplementation((line: unknown) => void printed.push(String(line)));
    const wiring = buildWiring(logger);
    try {
      await expect(wiring.messageDelivery.reserve(intent)).rejects.toThrow();
    } finally {
      await wiring.close();
      spy.mockRestore();
    }
    return printed;
  }

  it('names a reserve failure on the console when no logger is supplied', async () => {
    const printed = await reserveCapturingConsole();

    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0]!) as Record<string, unknown>).toMatchObject({
      component: 'w2-delivery',
      level: 'error',
      event: 'w2 delivery: reserve failed',
      messageId: IDS.message,
      targetWorkSessionId: IDS.session,
    });
    // Same allowlist as every other line: ids and SQLSTATE, never the body.
    expect(printed[0]!).not.toContain('wake up');
  });

  it('CONTROL: an explicit logger still wins, and the console stays quiet', async () => {
    const lines: string[] = [];
    const printed = await reserveCapturingConsole({
      error: (message) => lines.push(message),
      warn: () => {},
      info: () => {},
      debug: () => {},
    });

    expect(lines).toEqual(['w2 delivery: reserve failed']);
    expect(printed).toEqual([]);
  });
});
