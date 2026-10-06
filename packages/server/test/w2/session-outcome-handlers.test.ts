/**
 * Spec D1 §4.1/§4.2 (migration 301) at the handler layer: what the HTTP doors
 * ask of the database, in which order, for each stored outcome.
 *
 *   execution.terminate on an OPEN session refuses `outcome_required` before
 *     anything is killed; `stop` runs stop_work_session first, `complete` runs
 *     complete_work_session first and closes the process as exited_clean.
 *   execution.terminate on a COMPLETED session only closes the process.
 *   execution.complete calls complete_work_session; `closeProcess` closes a
 *     live process afterwards, and is a no-op on an ended one.
 *
 * The SQL rules themselves are proven in test/db/session-outcome-301.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { getOperation, type OperationName } from '@tm8/contract';
import { registerExecutionHandlers } from '../../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OWNER: LoopbackOwner = {
  identityId: 'd1-owner',
  accountId: '77777777-7777-4777-8777-777777777777',
  username: 'owner',
  isNodeAdmin: true,
  isOwner: true,
};

/** Answers the session's stored outcome/status; records every RPC with its args. */
class ScriptedDb implements Db {
  readonly rpcs: Array<{ fn: string; args: readonly unknown[] }> = [];
  /** RPCs that raise, as the DB does on a refusal (e.g. the claim check). */
  readonly refuse = new Map<string, Error>();
  constructor(private readonly row: { outcome: string; status: string }) {}
  private record(fn: string, args: readonly unknown[]): void {
    this.rpcs.push({ fn, args });
    const refusal = this.refuse.get(fn.replace(/^public\./, ''));
    if (refusal) throw refusal;
  }

  private querier(): Querier {
    return {
      query: async <R>(sql: string) => this.answer(sql) as R[],
      rpc: async <T>(fn: string, args: readonly unknown[] = []) => {
        this.record(fn, args);
        return {} as T;
      },
    };
  }
  private answer(sql: string): unknown[] {
    if (/select ws\.outcome/.test(sql)) return [{ outcome: this.row.outcome }];
    if (/select ws\.status/.test(sql)) return [{ status: this.row.status }];
    return [];
  }
  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier());
  }
  async rpc<T = unknown>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.record(fn, args);
    return { outcome: { outcome: 'completed' } } as T;
  }
  async query<R = Record<string, unknown>>(_claims: DbClaims, sql: string): Promise<R[]> {
    return this.answer(sql) as R[];
  }
  async end(): Promise<void> {}
}

class Pty {
  kills = 0;
  constructor(private readonly live: boolean) {}
  hasSession(): boolean {
    return this.live;
  }
  kill(): string {
    this.kills += 1;
    return this.live ? 'killed' : 'not_found';
  }
}

function harness(row: { outcome: string; status: string }, live = true) {
  const registry = new HandlerRegistry();
  const db = new ScriptedDb(row);
  const pty = new Pty(live);
  registerExecutionHandlers(registry, {
    db,
    pty: pty as never,
    config: { host: '127.0.0.1', port: 4610 } as unknown as ServerConfig,
    owner: async () => OWNER,
  });
  return { registry, db, pty };
}

function ctx(op: 'execution.terminate' | 'execution.complete', body: Record<string, unknown>): RequestContext {
  const opName = op as OperationName;
  return {
    op: getOperation(opName)!,
    opName,
    params: { id: SESSION },
    query: new URLSearchParams(),
    body: { clientMutationId: 'cmid-d1', ...body },
    requestId: 'req-d1',
    identity: { kind: 'auto-owner', identityId: OWNER.identityId } as never,
    headers: {},
    method: 'POST',
    path: `/v2/entities/${SESSION}/commands/x`,
  };
}

async function call(h: ReturnType<typeof harness>, op: 'execution.terminate' | 'execution.complete', body: Record<string, unknown>) {
  const handler = h.registry.get(op as OperationName)!;
  return handler(ctx(op, body));
}

const fns = (h: ReturnType<typeof harness>) => h.db.rpcs.map((r) => r.fn.replace(/^public\./, ''));
const transitionOf = (h: ReturnType<typeof harness>) =>
  h.db.rpcs.find((r) => /work_session_transition/.test(r.fn))?.args;

describe('execution.terminate — the work is the caller’s choice while it is open (§4.2)', () => {
  it('S7 precondition: an open session without an outcome is refused outcome_required, and nothing is killed', async () => {
    const h = harness({ outcome: 'open', status: 'running' });
    await expect(call(h, 'execution.terminate', {})).rejects.toMatchObject({
      code: 'invariant_violation',
      details: { reason: 'outcome_required' },
    });
    expect(h.pty.kills).toBe(0);
    expect(fns(h)).toEqual([]);
  });

  it('S6: outcome stop runs stop_work_session BEFORE the kill', async () => {
    const h = harness({ outcome: 'open', status: 'running' });
    await call(h, 'execution.terminate', { outcome: 'stop', note: 'Not needed' });
    expect(fns(h)[0]).toBe('stop_work_session');
    expect(h.db.rpcs[0]!.args.slice(0, 2)).toEqual([SESSION, 'Not needed']);
    expect(h.pty.kills).toBe(1);
    expect(transitionOf(h)).toContain('stopped_by_operator');
  });

  it('outcome complete runs complete_work_session first and records the close as exited_clean', async () => {
    const h = harness({ outcome: 'open', status: 'running' });
    await call(h, 'execution.terminate', { outcome: 'complete', receiptMessageId: '33333333-3333-4333-8333-333333333333' });
    expect(fns(h)[0]).toBe('complete_work_session');
    expect(h.db.rpcs[0]!.args[1]).toBe('33333333-3333-4333-8333-333333333333');
    expect(transitionOf(h)).toContain('exited_clean');
  });

  it('S7: "Mark complete & close" with an open claim is refused by the claim check, and nothing is killed', async () => {
    const h = harness({ outcome: 'open', status: 'running' });
    h.db.refuse.set(
      'complete_work_session',
      Object.assign(new Error('session has open claims: claims_open'), { code: 'P0001' }),
    );
    await expect(
      call(h, 'execution.terminate', { outcome: 'complete', receiptMessageId: '33333333-3333-4333-8333-333333333333' }),
    ).rejects.toBeTruthy();
    expect(fns(h)).toEqual(['complete_work_session']);
    expect(h.pty.kills).toBe(0);
    expect(transitionOf(h)).toBeUndefined();
  });

  it('S2: on a completed session it only closes the process (exited_clean), no outcome write', async () => {
    const h = harness({ outcome: 'completed', status: 'running' });
    await call(h, 'execution.terminate', {});
    expect(fns(h)).not.toContain('complete_work_session');
    expect(fns(h)).not.toContain('stop_work_session');
    expect(transitionOf(h)).toContain('exited_clean');
  });

  it('S25: on a stopped session it retries the kill without another outcome write', async () => {
    const h = harness({ outcome: 'stopped', status: 'running' });
    await call(h, 'execution.terminate', {});
    expect(fns(h)).not.toContain('stop_work_session');
    expect(h.pty.kills).toBe(1);
  });

  it('markLost records failed / lost, and is refused while the process is live', async () => {
    const gone = harness({ outcome: 'open', status: 'running' }, false);
    await call(gone, 'execution.terminate', { markLost: true });
    expect(transitionOf(gone)).toEqual(expect.arrayContaining(['failed', 'lost']));
    const here = harness({ outcome: 'open', status: 'running' }, true);
    await expect(call(here, 'execution.terminate', { markLost: true })).rejects.toBeTruthy();
  });
});

describe('execution.complete (§4.1)', () => {
  it('S1: calls complete_work_session and leaves a live process running', async () => {
    const h = harness({ outcome: 'open', status: 'running' });
    await call(h, 'execution.complete', {});
    expect(fns(h)).toEqual(['complete_work_session']);
    expect(h.pty.kills).toBe(0);
  });

  it('closeProcess closes a live process as exited_clean', async () => {
    const h = harness({ outcome: 'open', status: 'running' });
    await call(h, 'execution.complete', { closeProcess: true });
    expect(fns(h)[0]).toBe('complete_work_session');
    expect(transitionOf(h)).toContain('exited_clean');
  });

  it('closeProcess on an already-ended process writes nothing more', async () => {
    const h = harness({ outcome: 'open', status: 'exited' }, false);
    await call(h, 'execution.complete', { closeProcess: true });
    expect(fns(h)).toEqual(['complete_work_session']);
  });
});
