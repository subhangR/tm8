import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HarnessRegistry } from '@tm8/execution';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FencedTurnOptions } from '../../src/chat/fenced-turn.js';

/*
 * Turn management on the PRODUCTION (harness) drain: Stop, a failed turn, and
 * the recovery sweep. executeFencedTurn is replaced so each test controls how
 * a turn runs; its own behaviour is covered in fenced-turn.test.ts.
 */
const runs: FencedTurnOptions[] = [];
let runTurn: (options: FencedTurnOptions) => Promise<void> = async () => undefined;
vi.mock('../../src/chat/fenced-turn.js', () => ({
  executeFencedTurn: (options: FencedTurnOptions) => { runs.push(options); return runTurn(options); },
}));
const { ChatOrchestrator } = await import('../../src/chat/orchestrator.js');

const CHAT = '10000000-0000-4000-8000-000000000001';
function claim(turnId: string) {
  return { turnId, chatId: CHAT, userMessageId: `u-${turnId}`, agentMessageId: null, spaceId: 's', body: `body ${turnId}`,
    attachments: [], requesterIdentityId: 'creator', teammateId: 'tm', model: 'claude-opus-5-5', provider: 'anthropic',
    agentTool: 'claude-code', chatMode: 'explain', nativeSessionId: 'n', cwd: '/tmp', runtimeState: 'cold', nextSeq: 0,
    turnOrdinal: 1, captureHighWater: 1, runtimeEpoch: 1, attemptNo: 1, configRevision: 1, claimedConfiguration: {},
    claimedAuthority: { identityId: 'creator', authKind: 'browser', authSessionId: null, memberId: 'm' } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

function setup(opts: { queue?: string[]; team?: unknown; sweep?: unknown[] } = {}) {
  const queue = [...(opts.queue ?? [])];
  const rpcs: { name: string; args: readonly unknown[]; identityId?: string }[] = [];
  const rpc = async <T,>(auth: DbClaims | undefined, name: string, args: readonly unknown[] = []): Promise<T> => {
    rpcs.push({ name, args, ...(auth ? { identityId: auth.identityId } : {}) });
    if (name === 'claim_next_chat_turn') { const next = queue.shift(); return (next ? claim(next) : null) as T; }
    if (name === 'chat_turn_team') return (opts.team ?? null) as T;
    if (name === 'recover_chat_attempt' && args[1] === 'bad-turn') throw new Error('recover failed');
    return undefined as T;
  };
  const q: Querier = { query: async <T,>() => [] as T[], rpc: (name, args) => rpc(undefined, name, args) };
  const query = vi.fn(async <T,>(_auth: DbClaims, sql: string) => {
    if (!opts.sweep) return [] as T[];
    if (!sql.includes('list_recoverable_chats')) throw new Error(`unexpected sweep query: ${sql}`);
    return opts.sweep as T[];
  });
  const db = { tx: async <T,>(_auth: DbClaims, fn: (q: Querier) => Promise<T>) => fn(q), query, rpc } as unknown as Db;
  const onError = vi.fn();
  const orchestrator = new ChatOrchestrator({
    db, registry: {} as HarnessRegistry, resolvePreparedLaunch: vi.fn() as never, nodeId: 'node', bootId: 'boot',
    publisher: { publish: vi.fn() } as never, onError, sweepClaims: { identityId: 'owner' },
  });
  return { orchestrator, rpcs, onError, query };
}

afterEach(() => { runs.length = 0; runTurn = async () => undefined; vi.useRealTimers(); });

describe('Stop (chat.interrupt) on the harness drain', () => {
  it('cancels a tracked attempt', async () => {
    const gate = deferred();
    const cancel = vi.fn(async () => ({ disposition: 'requested' as const, nativeTurnId: null }));
    runTurn = async (o) => { o.track({ session: { cancel } as never, attempt: { turnId: 't1' } as never, revalidate: async () => {} }); await gate.promise; o.untrack(); };
    const { orchestrator } = setup({ queue: ['t1'] });
    const drain = orchestrator.wake(CHAT, 'creator');
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    expect(await orchestrator.interrupt(CHAT)).toBe('requested');
    expect(cancel).toHaveBeenCalledWith({ turnId: 't1' }, 'user');
    gate.resolve(); await drain;
  });

  it('latches a Stop pressed while the turn is still preparing, for THAT turn only', async () => {
    const gates = [deferred(), deferred()];
    const seen: boolean[] = [];
    runTurn = async (o) => { const gate = gates[runs.length - 1]!; await gate.promise; seen.push(o.stopRequested!()); };
    const { orchestrator } = setup({ queue: ['t1', 't2'] });
    const drain = orchestrator.wake(CHAT, 'creator');
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    // Before the fix this returned false and the Stop was dropped.
    expect(await orchestrator.interrupt(CHAT)).toBe('requested');
    gates[0]!.resolve();
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    gates[1]!.resolve(); await drain;
    // The next queued turn — another person's message — is not stopped by it.
    expect(seen).toEqual([true, false]);
  });

  it('says not_running when nothing is claimed', async () => {
    const { orchestrator } = setup();
    expect(await orchestrator.interrupt(CHAT)).toBe('not_running');
  });
});

describe('the drain survives a turn that cannot settle', () => {
  it('reports the failure and keeps claiming the queue behind it', async () => {
    runTurn = async (o) => { if (o.turn.turnId === 't1') throw new Error('settlement failed'); };
    const { orchestrator, onError } = setup({ queue: ['t1', 't2'] });
    await orchestrator.wake(CHAT, 'creator');
    expect(runs.map((o) => o.turn.turnId)).toEqual(['t1', 't2']);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'settlement failed' }));
  });
});

describe('the team line reaches the harness prompt', () => {
  it('reads chat_turn_team on the production path (it was legacy-only)', async () => {
    const { orchestrator, rpcs } = setup({ queue: ['t1'], team: { members: [] } });
    await orchestrator.wake(CHAT, 'creator');
    expect(rpcs.some((c) => c.name === 'chat_turn_team' && c.args[0] === 't1')).toBe(true);
  });
});

describe('periodic recovery sweep', () => {
  it('recovers expired leases on an interval, survives a failing row, and wakes the queued chats', async () => {
    vi.useFakeTimers();
    const { orchestrator, rpcs, onError } = setup({
      queue: [],
      sweep: [
        { kind: 'stale', chat_id: CHAT, configured_by_identity_id: 'creator', turn_id: 'bad-turn', attempt_no: 1 },
        { kind: 'stale', chat_id: CHAT, configured_by_identity_id: 'creator', turn_id: 'stuck-turn', attempt_no: 2 },
        { kind: 'queued', chat_id: CHAT, configured_by_identity_id: 'creator', turn_id: null, attempt_no: null },
      ],
    });
    orchestrator.startRecoverySweep(1_000);
    expect(rpcs.filter((c) => c.name === 'recover_chat_attempt')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    orchestrator.stopRecoverySweep();
    const recovered = rpcs.filter((c) => c.name === 'recover_chat_attempt').map((c) => c.args[1]);
    expect(recovered).toEqual(['bad-turn', 'stuck-turn']);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'recover failed' }));
    expect(rpcs.some((c) => c.name === 'claim_next_chat_turn')).toBe(true);
  });

  it('lists chats through the node-admin function and acts on each as its own configuring identity', async () => {
    // The listing must not be a SELECT under the owner's RLS: that hid every
    // chat outside the owner's spaces and one stayed stuck (prod 2026-10-20).
    const OTHER = '00000000-0000-4000-8000-0000000000c2';
    const { orchestrator, query, rpcs } = setup({
      sweep: [
        { kind: 'stale', chat_id: OTHER, configured_by_identity_id: 'stranger', turn_id: 'frozen', attempt_no: 1 },
        { kind: 'queued', chat_id: CHAT, configured_by_identity_id: 'creator', turn_id: null, attempt_no: null },
      ],
    });
    await orchestrator.reconcileOnBoot();
    const claims = () => rpcs.filter((c) => c.name === 'claim_next_chat_turn').map((c) => c.identityId);
    await vi.waitFor(() => expect(claims()).toHaveLength(2));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![0]).toEqual({ identityId: 'owner' });
    expect(query.mock.calls[0]![1]).toContain('public.list_recoverable_chats($1,$2)');
    expect(query.mock.calls[0]![2]).toEqual(['node', 'boot']);
    expect(rpcs.find((c) => c.name === 'recover_chat_attempt')).toMatchObject({ args: [OTHER, 'frozen', 1, { nodeId: 'node', bootId: 'boot' }], identityId: 'stranger' });
    expect(claims().sort()).toEqual(['creator', 'stranger']);
  });
});
