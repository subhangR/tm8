import { getOperation, type OperationName } from '@tm8/contract';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });


const IDS = ['a1234567-0000-7000-8000-000000000001', 'a1234567-1000-7000-8000-000000000002'];
const HIDDEN = 'a1234567-0000-7000-8000-000000000000';
let database: W1ScratchDatabase;
let db: Db;
let registry: HandlerRegistry;
beforeAll(async () => {
  database = await createW1ScratchDatabase('entity_read_prefix');
  database.apply(migrationFiles());
  await seedContextV2Fixtures(database);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    for (const id of IDS) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'story', $3)`, [id, F.space, F.member]);
      await c.query(`insert into public.stories(entity_id, title) values ($1, 'Prefix story')`, [id]);
    }
    await c.query(`insert into public.entities(id, space_id, kind, created_by, deleted_at) values ('a1234567-0000-7000-8000-000000000003', $1, 'story', $2, now())`, [F.space, F.member]);
    // This unreadable row sorts before the visible collision. RLS must filter
    // before LIMIT 2, or a unique readable prefix will become ambiguous.
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
      values ($1, $2, 'story', $3, 'restricted')`, [HIDDEN, F.space, F.member]);
    await c.query(`insert into public.stories(entity_id, title) values ($1, 'Hidden collision')`, [HIDDEN]);
  });
  db = createDb(database.url);
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, { db,
    config: { host: '127.0.0.1', port: 0, databaseUrl: database.url } as unknown as ServerConfig,
    owner: async () => ({ identityId: IDENTITY, accountId: F.member, username: 'prefix-owner', isNodeAdmin: false, isOwner: true }),
  });
});
afterAll(async () => { await db?.end(); await database?.destroy(); });
function call(opName: OperationName, id: string, identityId = IDENTITY) {
  const op = getOperation(opName);
  return registry.get(opName)!({ op, opName, params: { id }, query: new URLSearchParams('schema=v2'), body: undefined,
    requestId: 'prefix-test', identity: { kind: 'bearer', identityId, nodeAdmin: false }, headers: {}, method: op.method, path: op.path,
  } satisfies RequestContext);
}
for (const op of ['entities.get', 'entities.context'] as const) {
  it(`${op} resolves unique prefixes and returns canonical ids`, async () => {
    for (const id of ['a1234567-0000', 'A12345670000', IDS[0]!]) {
      expect(await call(op, id)).toMatchObject({ id: IDS[0] });
    }
  });
  it(`${op} refuses ambiguous, missing, malformed and unreadable prefixes`, async () => {
    await expect(call(op, 'a1234567')).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining(IDS[0]!), details: { candidates: IDS } });
    for (const id of ['ffffffff', 'a123', 'a1234567%']) await expect(call(op, id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(op, 'a1234567-0000', 'no-access')).rejects.toMatchObject({ code: 'not_found' });
  });
  it(`${op} resolves a readable prefix despite a hidden collision and never lists the hidden candidate`, async () => {
    expect(await call(op, 'a1234567-0000')).toMatchObject({ id: IDS[0] });
    await expect(call(op, HIDDEN)).rejects.toMatchObject({ code: 'not_found' });
    await expect(call(op, 'a1234567')).rejects.toMatchObject({
      code: 'invalid_input', details: { candidates: IDS },
      message: expect.not.stringContaining(HIDDEN),
    });
  });
}
it('mutation path still refuses a unique short id', async () => {
  await expect(call('entities.patch', 'a1234567-0000')).rejects.toMatchObject({ code: 'not_found' });
});
