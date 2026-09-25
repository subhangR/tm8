/**
 * Prompt v2's embedded orientation read (spec ca8d §2.2, §6.1 test 5): the
 * spawn path's `DbGraphPort.loadTaskContextSnapshot` returns the SAME
 * `entities.context` v2 projection a fresh read serves, rendered as the new
 * session's actor — so `you:true` lands on the persona the session runs as,
 * not on the spawner.
 */
import { getOperation, type EntityContextV2View, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const OWNER = {
  identityId: IDENTITY,
  accountId: '01a0c000-0000-7000-8000-0000000000fe',
  username: 'ctx-v2-owner',
  isNodeAdmin: false,
  isOwner: true,
};

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;

beforeAll(async () => {
  database = await createW1ScratchDatabase('prompt_v2_ctx');
  database.apply(migrationFiles());
  await seedContextV2Fixtures(database);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    // WS runs AS the teammate T is assigned to.
    await c.query(
      `insert into public.edges(space_id,src_id,dst_id,type,created_by,created_at)
       values ($1,$2,$3,'participates_in',$4,'2026-09-23T12:06:00Z')`,
      [F.space, F.teammate, F.WS, F.member],
    );
  });
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

async function readAsSpawner(): Promise<EntityContextV2View> {
  const opName: OperationName = 'entities.context';
  const op = getOperation(opName);
  return (await registry.get(opName)!({
    op, opName, params: { id: F.T }, query: new URLSearchParams('schema=v2'),
    body: undefined,
    requestId: 'prompt-v2', identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {}, method: op.method, path: op.path,
  } satisfies RequestContext)) as EntityContextV2View;
}

describe('prompt v2 task-context snapshot', () => {
  it('renders the task as the spawned session: you:true on its persona, and the fresh read agrees', async () => {
    const port = new DbGraphPort(pgDb);
    const snapshot = (await port.loadTaskContextSnapshot(
      { identityId: IDENTITY, nodeAdmin: false, requestId: 'spawn' },
      { sessionId: F.WS, taskId: F.T, totalBytes: 16_384 },
    )) as unknown as EntityContextV2View;

    expect(snapshot.schemaVersion).toBe('tm8.entity-context.v2');
    expect(snapshot.id).toBe(F.T);
    expect(snapshot.assignment?.complete).toBe(true);
    expect(snapshot.acceptance?.length).toBeGreaterThan(0);
    const mine = snapshot.assignees?.filter((a) => a.you === true).map((a) => a.id);
    expect(mine).toEqual([F.teammate]);
    expect(snapshot.budget.used).toBeLessThanOrEqual(16_384);

    // Without the session actor, the spawner is not the assignee.
    const spawnerView = await readAsSpawner();
    expect(spawnerView.assignees?.some((a) => a.you === true)).toBe(false);

    // The same projection as a fresh `entities.context` read: once the
    // caller-relative marks and the byte count they move are set aside, the
    // two are equal field for field.
    const neutral = (view: EntityContextV2View): unknown => {
      const { fetchedAt: _f, budget: _b, assignees, ...rest } = view as EntityContextV2View & { fetchedAt?: string };
      return { ...rest, assignees: assignees?.map(({ you: _you, ...a }) => a) };
    };
    expect(spawnerView.asOfSeq).toBe(snapshot.asOfSeq);
    expect(neutral(snapshot)).toEqual(neutral(spawnerView));
  });

  it('loadTaskVersions reads the version and status a fresh entities.context serves (task 01a0daa4-ed02)', async () => {
    // The spawn re-reads its tasks after `execution_spawn` started them, so the
    // task turn names the version the agent's first versioned write must carry.
    const port = new DbGraphPort(pgDb);
    const auth = { identityId: IDENTITY, nodeAdmin: false, requestId: 'spawn' };
    const fresh = await readAsSpawner();
    const rows = await port.loadTaskVersions(auth, { taskIds: [F.T] });
    expect(rows).toEqual([{ id: F.T, version: fresh.version, status: expect.stringMatching(/^[a-z_]+$/) }]);
    // Moving the task moves the read: it is the row, not a cached context.
    await database.transaction(async (c) => {
      await c.query('set local role tm8_graph_owner');
      await c.query('update public.entities set version = version + 1 where id = $1', [F.T]);
    });
    const [after] = await port.loadTaskVersions(auth, { taskIds: [F.T] });
    expect(after!.version).toBe(fresh.version + 1);
    expect((await readAsSpawner()).version).toBe(after!.version);
    expect(await port.loadTaskVersions(auth, { taskIds: [] })).toEqual([]);
  });
});
