/**
 * P0f: where an entity belongs (Design Rules 01a10c5d §2.4), at the operation
 * seam over a real PostgreSQL scratch database:
 *   - a cross-kind parent is still refused, now with reason
 *     `parent_kind_mismatch` and `details.next` naming the edge to make
 *     (on create and on move);
 *   - a valid create carries no placement warning: what an entity is about is
 *     the agent's call (PLACEMENT_RULE, #1065), not the server's;
 *   - `collection add <story>` of a child warns `story_root_not_root`, of a
 *     child whose ancestor is already a root warns `story_root_redundant`, and
 *     of a root says nothing; a plain collection never warns.
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
  accountId: '01a0c000-0000-7000-8000-0000000000fd',
  username: 'placement-owner',
  isNodeAdmin: false,
  isOwner: true,
};

interface Warning { code: string; message: string }
interface Created { data: { entity: { id: string; kind: string; version: number }; warnings?: Warning[] } }
interface Refusal { code: string; message: string; details?: Record<string, unknown> }

let database: W1ScratchDatabase;
let pgDb: Db;
let registry: HandlerRegistry;
let mutation = 0;

beforeAll(async () => {
  database = await createW1ScratchDatabase('placement');
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

async function call<T>(opName: OperationName, params: Record<string, string>, body?: Record<string, unknown>): Promise<T> {
  const handler = registry.get(opName);
  if (!handler) throw new Error(`missing handler: ${opName}`);
  const op = getOperation(opName);
  const ctx: RequestContext = {
    op,
    opName,
    params,
    query: new URLSearchParams(),
    body: body === undefined ? undefined : { clientMutationId: `placement-${++mutation}`, ...body },
    requestId: `placement-${opName}`,
    identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {},
    method: op.method,
    path: op.path,
  };
  return (await handler(ctx)) as T;
}

const create = (body: Record<string, unknown>): Promise<Created> =>
  call<Created>('entities.create', {}, { spaceId: F.space, ...body });

async function refusal(run: () => Promise<unknown>): Promise<Refusal> {
  try {
    await run();
  } catch (error) {
    return error as Refusal;
  }
  throw new Error('expected a refusal');
}

const codes = (warnings: Warning[] | undefined): string[] => (warnings ?? []).map((w) => w.code);
const resultWarnings = (r: unknown): Warning[] | undefined =>
  ((r as { data?: { warnings?: Warning[] }; warnings?: Warning[] }).data ?? r as { warnings?: Warning[] }).warnings;

describe('a cross-kind parent is refused with the edge to make instead', () => {
  it('on create: a doc under a task names `produces` from the task', async () => {
    const err = await refusal(() => create({ kind: 'doc', title: 'Doc under a task', parentId: F.T }));
    expect(err.code).toBe('invariant_violation');
    expect(err.details).toMatchObject({ reason: 'parent_kind_mismatch', parentId: F.T, parentKind: 'task', kind: 'doc' });
    expect(err.details?.['next']).toEqual([`tm8 edge create ${F.T} produces <new-doc-id>`]);
    expect(err.message).toContain('--parent only nests the same kind');
  });

  it('on move: a doc moved under a task is refused the same way, naming the doc', async () => {
    const doc = (await create({ kind: 'doc', title: 'A doc to move' })).data.entity;
    const err = await refusal(() => call('entities.move', { id: doc.id },
      { parentId: F.T, position: 0, expectedVersion: doc.version }));
    expect(err.details).toMatchObject({ reason: 'parent_kind_mismatch', parentKind: 'task', kind: 'doc' });
    expect(err.details?.['next']).toEqual([`tm8 edge create ${F.T} produces ${doc.id}`]);
  });
});

describe('a valid create is never second-guessed', () => {
  it('a root task and a root doc made from a session with a claim carry no warning', async () => {
    expect((await create({ kind: 'task', title: 'Unrelated root task', workSessionId: F.WS })).data.warnings ?? []).toEqual([]);
    expect((await create({ kind: 'doc', title: 'Unrelated root doc', workSessionId: F.WS })).data.warnings ?? []).toEqual([]);
  });
});

describe('collection add: only roots go into a story', () => {
  it('warns on a child and on a redundant child; a root and a plain collection say nothing', async () => {
    const story = (await create({ kind: 'story', title: 'Placement story', content: { description: 'd' } })).data.entity.id;
    const parent = (await create({ kind: 'task', title: 'Story root task' })).data.entity.id;
    const child = (await create({ kind: 'task', title: 'Child task', parentId: parent })).data.entity.id;
    const grandchild = (await create({ kind: 'task', title: 'Grandchild task', parentId: child })).data.entity.id;

    const add = (collection: string, entityId: string): Promise<unknown> =>
      call('collections.addItem', { id: collection }, { entityId });

    const notRoot = resultWarnings(await add(story, child));
    expect(codes(notRoot)).toEqual(['story_root_not_root']);
    expect(notRoot?.[0]?.message).toContain(`tm8 collection add ${story} ${parent}`);

    expect(codes(resultWarnings(await add(story, parent)))).toEqual([]);
    const redundant = resultWarnings(await add(story, grandchild));
    expect(codes(redundant)).toEqual(['story_root_redundant']);

    const plain = (await create({ kind: 'collection', title: 'Plain collection' })).data.entity.id;
    expect(codes(resultWarnings(await add(plain, grandchild)))).toEqual([]);
  });
});
