import { EntityContextV2ViewSchema, getOperation, type EntityContextV2View } from '@tm8/contract';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { F, IDENTITY, seedContextV2Fixtures } from './context-v2/fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const STORY = '01a0c000-0000-7000-8000-000000001000';
const ROOTS = Array.from({ length: 120 }, (_, i) =>
  `01a0c000-0000-7000-8000-${(0x1100 + i).toString(16).padStart(12, '0')}`);
let database: W1ScratchDatabase;
let db: Db;
let registry: HandlerRegistry;

beforeAll(async () => {
  database = await createW1ScratchDatabase('story_context_budget');
  database.apply(migrationFiles());
  await seedContextV2Fixtures(database);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    await c.query(`insert into public.entities(id, space_id, kind, created_by)
      values ($1, $2, 'story', $3)`, [STORY, F.space, F.member]);
    await c.query(`insert into public.stories(entity_id, title) values ($1, '120-root story')`, [STORY]);
    for (const [i, id] of ROOTS.entries()) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by, position)
        values ($1, $2, 'task', $3, $4)`, [id, F.space, F.member, i]);
      await c.query(`insert into public.tasks(entity_id, title, work_status)
        values ($1, $2, 'open')`, [id, `Root ${i}: ${'context budget '.repeat(20)}`]);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
        values ($1, $2, $3, 'contains', $4)`, [F.space, STORY, id, F.member]);
    }
  });
  db = createDb(database.url);
  registry = new HandlerRegistry();
  registerFacadeHandlers(registry, {
    db,
    config: { host: '127.0.0.1', port: 0, databaseUrl: database.url } as unknown as ServerConfig,
    owner: async () => ({ identityId: IDENTITY, accountId: F.member,
      username: 'story-budget-owner', isNodeAdmin: false, isOwner: true }),
  });
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

async function read(query = new URLSearchParams('schema=v2')): Promise<EntityContextV2View> {
  const op = getOperation('entities.context');
  const view = await registry.get('entities.context')!({
    op, opName: 'entities.context', params: { id: STORY }, query, body: undefined,
    requestId: 'story-context-budget', identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {}, method: op.method, path: op.path,
  } satisfies RequestContext);
  return EntityContextV2ViewSchema.parse(view);
}

it('reads 120 roots within the default budget and pages every root exactly once', async () => {
  let page = await read();
  expect(page.story?.state.rootCount).toBe(120);
  expect(page.story?.roots?.length).toBeGreaterThan(0);
  expect(page.story?.roots?.length).toBeLessThan(120);
  const seen: string[] = [];
  const cursors = new Set<string>();
  for (let n = 0; n < 120; n++) {
    const bytes = Buffer.byteLength(JSON.stringify(page), 'utf8');
    expect(page.errors).toEqual([]);
    expect(bytes).toBeLessThanOrEqual(16_384);
    expect(page.budget.used).toBe(bytes);
    seen.push(...(page.story?.roots ?? []).map((root) => root.id));
    const omitted = page.omitted.find((row) => row.section === 'story.roots');
    if (!omitted) break;
    expect(omitted.more).toBe(true);
    expect(omitted.expandOp?.operation).toBe('entities.context');
    const cursor = omitted.expandOp?.params['cursor'];
    expect(typeof cursor).toBe('string');
    expect(cursors.has(cursor as string)).toBe(false);
    cursors.add(cursor as string);
    page = await read(new URLSearchParams({ schema: 'v2', sections: 'story', cursor: cursor as string }));
  }
  expect(seen).toHaveLength(120);
  expect(new Set(seen).size).toBe(120);
  expect([...seen].sort()).toEqual([...ROOTS].sort());
});


it('CLI story detail carries a bounded context page and usable continuation instead of the full graph', async () => {
  const op = getOperation('entities.get');
  const detail = await registry.get('entities.get')!({
    op, opName: 'entities.get', params: { id: STORY }, query: new URLSearchParams('story=context'), body: undefined,
    requestId: 'story-detail-budget', identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {}, method: op.method, path: op.path,
  } satisfies RequestContext) as { content: { page: unknown; description: string; context: EntityContextV2View } };
  expect(detail.content.page).toBeNull();
  expect(typeof detail.content.description).toBe('string');
  const context = EntityContextV2ViewSchema.parse(detail.content.context);
  expect(context.story?.state.rootCount).toBe(120);
  expect(Buffer.byteLength(JSON.stringify(context))).toBeLessThanOrEqual(16_384);
  const omitted = context.omitted.find(row => row.section === 'story.roots')!;
  expect(omitted.expand).toContain('entity context');
  const cursor = omitted.expandOp?.params['cursor'];
  expect(typeof cursor).toBe('string');
  const next = await read(new URLSearchParams({ schema: 'v2', sections: 'story', cursor: cursor as string }));
  expect(next.story?.roots?.length).toBeGreaterThan(0);
  const shown = new Set(context.story?.roots?.map(root => root.id));
  expect(next.story?.roots?.every(root => !shown.has(root.id))).toBe(true);
});
