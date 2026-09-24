/**
 * `entities.commands.tick` — bug 01a0d2f1.
 *
 * Live agents told to "tick your acceptance criteria and complete" found no
 * write for it and fell back to a 29.5 KB `entity get` to learn the stored
 * member name. This pins the one write path end to end, through the
 * production registry over a real PostgreSQL scratch database:
 *
 *   - the v2 context's `acceptanceWrite.writeOp` runs VERBATIM and ticks,
 *   - the merge is by id: criteria not named keep their stored state,
 *   - an unknown id and a stale version are refused, never dropped,
 *   - after the tick, `task complete`'s criteria gate passes.
 *
 * Writes mutate the shared fixture task, so this lives apart from the
 * read-only context-v2 acceptance suite.
 */
import type { OperationName } from '@tm8/contract';
import { getOperation } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const OWNER = {
  identityId: IDENTITY,
  accountId: '01a0c000-0000-7000-8000-0000000000fe',
  username: 'tick-owner',
  isNodeAdmin: false,
  isOwner: true,
};

interface Criterion { id: string; done: boolean; text: string; doneBy?: string; doneAt?: string }
interface V2 { version: number; acceptance: Criterion[]; acceptanceWrite?: { write: string; writeOp: { operation: string; params: Record<string, unknown> } } }
interface Result { entity: { version: number; content: { acceptanceCriteria: Criterion[] }; state: { status: string } } }

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;
let mutation = 0;

beforeAll(async () => {
  database = await createW1ScratchDatabase('tick');
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
  opts: { query?: URLSearchParams; body?: Record<string, unknown> } = {},
): Promise<T> {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`missing handler: ${opName}`);
  const op = getOperation(opName);
  const ctx: RequestContext = {
    op,
    opName,
    params,
    query: opts.query ?? new URLSearchParams(),
    body: opts.body === undefined ? undefined : { clientMutationId: `tick-${++mutation}`, ...opts.body },
    requestId: `tick-${opName}`,
    identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {},
    method: op.method,
    path: op.path,
  };
  return (await handler(ctx)) as T;
}

const context = (): Promise<V2> => call<V2>('entities.context', { id: F.T }, { query: new URLSearchParams({ schema: 'v2' }) });

const tick = (body: Record<string, unknown>): Promise<Result> =>
  call<Result>('entities.commands.tick', { id: F.T }, { body });

async function refusal(run: () => Promise<unknown>): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  try {
    await run();
  } catch (error) {
    return error as { code: string; message: string; details?: Record<string, unknown> };
  }
  throw new Error('expected a refusal');
}

describe('entities.commands.tick (bug 01a0d2f1)', () => {
  it('refuses an unknown criterion id BY NAME, listing the ids the task carries, and writes nothing', async () => {
    const before = await context();
    const err = await refusal(() => tick({ expectedVersion: before.version, criterionIds: ['a1', 'nope'] }));
    expect(err.code).toBe('invalid_input');
    expect(err.message).toContain('nope');
    expect(err.details).toMatchObject({ reason: 'unknown_criterion', unknown: ['nope'], known: ['a1', 'a2', 'a3', 'a4'] });
    expect((await context()).version).toBe(before.version);
  });

  it('refuses a stale version as version_conflict with the current detail', async () => {
    const before = await context();
    const err = await refusal(() => tick({ expectedVersion: before.version - 1, criterionIds: ['a1'] }));
    expect(err.code).toBe('version_conflict');
  });

  it('merges by id: one tick changes one criterion, stamps it, and leaves the rest as stored', async () => {
    const before = await context();
    const r = await tick({ expectedVersion: before.version, criterionIds: ['a1'] });
    expect(r.entity.version).toBe(before.version + 1);
    const byId = new Map(r.entity.content.acceptanceCriteria.map((c) => [c.id, c]));
    expect(byId.get('a1')).toMatchObject({ done: true });
    expect(byId.get('a1')?.doneAt).toEqual(expect.any(String));
    expect(byId.get('a2')?.done).toBe(true);
    expect(byId.get('a3')?.done).toBe(false);
    expect(byId.get('a4')?.done).toBe(false);
    // Texts and order are untouched — the caller never restated them.
    expect(r.entity.content.acceptanceCriteria.map((c) => [c.id, c.text]))
      .toEqual(before.acceptance.map((c) => [c.id, c.text]));
  });

  it('done:false unticks, and the context hint follows the open set', async () => {
    const before = await context();
    await tick({ expectedVersion: before.version, criterionIds: ['a1'], done: false });
    const after = await context();
    expect(after.acceptance.find((c) => c.id === 'a1')?.done).toBe(false);
    expect(after.acceptanceWrite?.write).toBe(`tm8 task tick ${F.T} a1 a3 a4 --expect-version ${after.version}`);
  });

  it('the context writeOp runs verbatim, the hint disappears, and task complete then passes the criteria gate', async () => {
    const view = await context();
    const op = view.acceptanceWrite!.writeOp;
    expect(op.operation).toBe('entities.commands.tick');
    const { id, ...body } = op.params;
    const ticked = await call<Result>(op.operation as OperationName, { id: String(id) }, { body });
    expect(ticked.entity.content.acceptanceCriteria.every((c) => c.done)).toBe(true);

    const after = await context();
    expect(after.acceptanceWrite).toBeUndefined();

    const done = await call<Result>('entities.commands.complete', { id: F.T }, {
      body: { expectedVersion: after.version, completerIds: [F.member] },
    });
    expect(done.entity.state.status).toBe('done');
  });
});
