/**
 * Server receipts — `?return=receipt` (spec 01a0d044 §4.1, §4.2, §9 tests 3/9).
 *
 * Pins, through the production registry over a real PostgreSQL scratch
 * database:
 *
 *   - no opt-in, no change: the default response is still `CommandResult`;
 *   - `version.from`, `status.from` and `changed` come from the server's own
 *     before/after read, not from the caller's argv;
 *   - `changed: []` is a VERIFIED no-op (the row was rewritten, every value
 *     came out equal), and an idempotent replay — which writes nothing — is
 *     never reported as one;
 *   - link-pr's receipt carries the pull_request id a chained command needs
 *     (test 9), the same id the full result's patches carry;
 *   - complete carries the gate and the completed_by edge it wrote;
 *   - every success receipt fits the 640-byte hard cap.
 *
 * Writes mutate the shared fixture task, so the cases run in order.
 */
import type { OperationName } from '@tm8/contract';
import { getOperation } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { isHandlerResult } from '../../src/http/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const OWNER = {
  identityId: IDENTITY,
  accountId: '01a0c000-0000-7000-8000-0000000000fd',
  username: 'receipt-owner',
  isNodeAdmin: false,
  isOwner: true,
};

const HARD_CAP = 640;

type Receipt = Record<string, unknown> & {
  schemaVersion?: string;
  op: string;
  id: string;
  version: { from?: number; to: number };
  status?: { from?: string; to: string };
  changed?: string[];
  refs: Array<Record<string, unknown>>;
  warnings: Array<{ code: string }>;
};

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;
let mutation = 0;

beforeAll(async () => {
  database = await createW1ScratchDatabase('receipt');
  database.apply(migrationFiles());
  await seedContextV2Fixtures(database);
  pgDb = createDb(database.url);
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, {
    db: pgDb,
    config: { host: '127.0.0.1', port: 0, databaseUrl: database.url } as unknown as ServerConfig,
    owner: async () => OWNER,
  });
}, 300_000);

afterAll(async () => {
  await pgDb?.end();
  await database?.destroy();
});

async function call<T>(
  opName: OperationName,
  params: Record<string, string>,
  body: Record<string, unknown> | undefined,
  receipt = true,
): Promise<T> {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`missing handler: ${opName}`);
  const op = getOperation(opName);
  const ctx: RequestContext = {
    op,
    opName,
    params,
    query: new URLSearchParams(receipt ? { return: 'receipt' } : {}),
    body: body === undefined ? undefined : { clientMutationId: `receipt-${++mutation}`, ...body },
    requestId: `receipt-${opName}`,
    identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {},
    method: op.method,
    path: op.path,
  };
  const out = await handler(ctx);
  return (isHandlerResult(out) ? (out as { data: unknown }).data : out) as T;
}

async function version(id: string): Promise<number> {
  const rows = await database.query<{ version: number }>('select version from public.entities where id = $1', [id]);
  return Number(rows[0]!.version);
}

function fitsCap(receipt: unknown): void {
  expect(Buffer.byteLength(JSON.stringify(receipt), 'utf8')).toBeLessThanOrEqual(HARD_CAP);
}

describe('?return=receipt (server receipts, phase 2)', () => {
  it('without the opt-in, entities.patch still returns the full CommandResult', async () => {
    const v = await version(F.T);
    const full = await call<Record<string, unknown>>('entities.patch', { id: F.T },
      { expectedVersion: v, title: 'Receipt task' }, false);
    expect(full.schemaVersion).toBeUndefined();
    expect(full.entity).toBeDefined();
  });

  it('an update reports version and changed from the server read', async () => {
    const v = await version(F.T);
    const r = await call<Receipt>('entities.patch', { id: F.T },
      { expectedVersion: v, title: 'Receipt task, renamed', content: { priority: 'high' } });
    expect(r).toMatchObject({ schemaVersion: 'tm8.receipt.v1', ok: true, op: 'entity.update', id: F.T, kind: 'task' });
    expect(r.title).toBe('Receipt task, renamed');
    expect(r.version).toEqual({ from: v, to: v + 1 });
    expect(r.changed).toEqual(['title', 'content.priority']);
    expect(r.warnings).toEqual([]);
    fitsCap(r);
  });

  it('test 3: a same-value update is a verified no-op — changed:[] with a no_change warning', async () => {
    const v = await version(F.T);
    const r = await call<Receipt>('entities.patch', { id: F.T },
      { expectedVersion: v, title: 'Receipt task, renamed' });
    expect(r.changed).toEqual([]);
    expect(r.version.from).toBe(v);
    expect(r.warnings.map((w) => w.code)).toEqual(['no_change']);
    fitsCap(r);
  });

  it('an idempotent replay writes nothing and is NOT reported as a no-op', async () => {
    const v = await version(F.T);
    const body = { clientMutationId: 'receipt-replay', expectedVersion: v, title: 'Receipt task, replayed' };
    const first = await call<Receipt>('entities.patch', { id: F.T }, body);
    expect(first.changed).toEqual(['title']);
    const again = await call<Receipt>('entities.patch', { id: F.T }, body);
    expect(again.changed).toBeUndefined();
    expect(again.version.from).toBeUndefined();
    expect(again.warnings.map((w) => w.code)).toEqual(['no_write_observed']);
  });

  it('a transition reports status from → to', async () => {
    const r = await call<Receipt>('entities.commands.work', { id: F.T }, { status: 'blocked' });
    expect(r.op).toBe('task.transition');
    expect(r.status?.to).toBe('blocked');
    expect(r.status?.from).toBeDefined();
    expect(r.status?.from).not.toBe('blocked');
    expect(r.changed).toContain('state.status');
    fitsCap(r);
    await call('entities.commands.work', { id: F.T }, { status: 'working' });
  });

  it('tick reports the acceptance count and the open ids', async () => {
    const v = await version(F.T);
    const r = await call<Receipt>('entities.commands.tick', { id: F.T }, { expectedVersion: v, criterionIds: ['a1'] });
    expect(r.op).toBe('task.tick');
    expect(r.changed).toEqual(['content.acceptanceCriteria']);
    expect(r.acceptance).toMatchObject({ total: 4 });
    expect(r.open).not.toContain('a1');
    fitsCap(r);
  });

  it('test 9: link-pr carries the pull_request id a chained command needs, the same one the full result patches', async () => {
    const url = 'https://github.com/example/tm8/pull/4242';
    const r = await call<Receipt>('entities.commands.linkPr', { id: F.T }, { url });
    expect(r.op).toBe('task.link-pr');
    const pr = r.refs.find((ref) => ref.kind === 'pull_request');
    expect(pr).toMatchObject({ url, id: expect.any(String) });
    expect(r.refs.some((ref) => ref.kind === 'edge')).toBe(true);
    fitsCap(r);
    // The same link again, full: its patches name the same pull_request.
    const full = await call<{ patches: Array<{ id: string }> }>('entities.commands.linkPr', { id: F.T }, { url }, false);
    expect(full.patches.map((p) => p.id)).toContain(pr!.id);
  });

  it('complete carries status, the gate and the completed_by edge to the completer', async () => {
    const tickV = await version(F.T);
    await call('entities.commands.tick', { id: F.T }, { expectedVersion: tickV, criterionIds: ['a1', 'a2', 'a3', 'a4'] });
    const v = await version(F.T);
    const r = await call<Receipt>('entities.commands.complete', { id: F.T },
      { expectedVersion: v, completerIds: [F.member] });
    expect(r.op).toBe('task.complete');
    expect(r.version).toEqual({ from: v, to: expect.any(Number) });
    expect(r.status).toEqual({ from: 'working', to: 'done' });
    expect(r.changed).toEqual(expect.arrayContaining(['state.status', 'edge:completed_by']));
    expect(r.gate).toMatchObject({ result: 'passed' });
    expect(r.refs).toContainEqual(expect.objectContaining({ kind: 'edge', type: 'completed_by', to: F.member }));
    fitsCap(r);
  });

  it('create reports the new id, version and parent', async () => {
    const r = await call<Receipt>('entities.create', {},
      { spaceId: F.space, kind: 'task', title: 'Receipt child', parentId: F.T });
    expect(r).toMatchObject({ op: 'entity.create', kind: 'task', parentId: F.T, title: 'Receipt child' });
    expect(r.version.to).toBeGreaterThan(0);
    expect(r.changed).toBeUndefined();
    fitsCap(r);
  });

  it('a kind the receipt does not cover ignores the opt-in and returns the full result', async () => {
    const full = await call<Record<string, unknown>>('entities.create', {},
      { spaceId: F.space, kind: 'channel', title: 'receipt-channel' });
    expect(full.schemaVersion).toBeUndefined();
    expect(full.entity).toBeDefined();
  });
});
