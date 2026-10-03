import { decodeCursor, encodeCursor, EntityContextV2ViewSchema, getOperation, type EntityContextV2View, type StoryContent } from '@tm8/contract';
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
const fixtureId = (n: number): string => `01a0c000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const DENSE = fixtureId(0x2000);
const DENSE_BODY = 'Reader é 😀. '.repeat(1000);
const PARENT = fixtureId(0x2001);
const DENSE_ROOTS = Array.from({ length: 12 }, (_, i) => fixtureId(0x2100 + i));
const DENSE_TEAM = Array.from({ length: 6 }, (_, i) => fixtureId(0x2200 + i));
const DENSE_SESSIONS = Array.from({ length: 6 }, (_, i) => fixtureId(0x2300 + i));
const DENSE_CHILDREN = Array.from({ length: 6 }, (_, i) => fixtureId(0x2400 + i));
const CHILDREN = Array.from({ length: 61 }, (_, i) => ({ id: fixtureId(0x2500 + i), index: i }))
  .sort((a, b) => a.index % 3 - b.index % 3 || a.index % 2 - b.index % 2 || a.index - b.index)
  .map(row => row.id);
const HIDDEN_CHILD = fixtureId(0x2600);
const DELETED_CHILD = fixtureId(0x2601);
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

    const entity = async (id: string, kind: string, parent: string | null = null) => {
      await c.query(`insert into public.entities(id, space_id, kind, parent_id, created_by)
        values ($1, $2, $3, $4, $5)`, [id, F.space, kind, parent, F.member]);
    };
    const edge = async (src: string, dst: string, type: string) => {
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by)
        values ($1, $2, $3, $4, $5)`, [F.space, src, dst, type, F.member]);
    };
    for (const id of [DENSE, PARENT]) {
      await entity(id, 'story');
      await c.query(`insert into public.stories(entity_id, title, description) values ($1, 'Reader regression', $2)`,
        [id, id === DENSE ? DENSE_BODY : '']);
    }
    // Deliberately insert out of order and tie position/time independently, so
    // the child cursor must honor all three ordering keys, including microseconds.
    for (let i = 60; i >= 0; i--) {
      const id = fixtureId(0x2500 + i);
      await c.query(`insert into public.entities(id, space_id, kind, parent_id, created_by, position, created_at)
        values ($1, $2, 'story', $3, $4, $5, $6::timestamptz)`,
      [id, F.space, PARENT, F.member, i % 3, `2026-09-01T00:00:00.00000${i % 2}Z`]);
      await c.query(`insert into public.stories(entity_id, title) values ($1, $2)`, [id, `Child ${i}`]);
    }
    for (const id of [HIDDEN_CHILD, DELETED_CHILD]) {
      await entity(id, 'story', PARENT);
      await c.query(`insert into public.stories(entity_id, title) values ($1, 'Invisible child')`, [id]);
      await c.query(`update public.entities set position = 0,
        visibility = case when id = $2 then 'restricted' else 'space' end,
        deleted_at = case when id = $3 then now() else null end where id = $1`,
      [id, HIDDEN_CHILD, DELETED_CHILD]);
    }
    for (const id of DENSE_ROOTS) {
      await entity(id, 'task');
      await c.query(`insert into public.tasks(entity_id, title, work_status) values ($1, $2, 'open')`, [id, '😀'.repeat(80)]);
      await edge(DENSE, id, 'contains');
      await edge(id, F.B, 'depends_on');
    }
    for (const [i, id] of DENSE_SESSIONS.entries()) {
      const teammate = DENSE_TEAM[i]!;
      await entity(teammate, 'team_member');
      await c.query(`insert into public.team_members(entity_id, owner_member_id, name, role, identity, model, agent_tool)
        values ($1, $2, $3, 'worker', $4, 'claude-opus-5', 'claude-code')`,
      [teammate, F.member, `Reader ${i}`, `reader-budget-${i}`]);
      await entity(id, 'work_session');
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, agent_tool, model, skills, drive_mode, workdir_mode)
        values ($1, $2, 'running', 'space', 'claude-code', 'claude-opus-5', '[]'::jsonb, 'owner', 'project')`, [id, '😀'.repeat(80)]);
      await edge(teammate, id, 'participates_in');
      for (const task of DENSE_ROOTS) await edge(id, task, 'working_on');
      await entity(DENSE_CHILDREN[i]!, 'story', DENSE);
      await c.query(`insert into public.stories(entity_id, title) values ($1, $2)`, [DENSE_CHILDREN[i], '😀'.repeat(40)]);
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

async function read(query = new URLSearchParams('schema=v2'), id = STORY): Promise<EntityContextV2View> {
  const op = getOperation('entities.context');
  const view = await registry.get('entities.context')!({
    op, opName: 'entities.context', params: { id }, query, body: undefined,
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

async function detailContent(id: string, browser = false): Promise<StoryContent> {
  const op = getOperation('entities.get');
  const detail = await registry.get('entities.get')!({
    op, opName: 'entities.get', params: { id }, query: new URLSearchParams(browser ? '' : 'story=context'), body: undefined,
    requestId: 'story-detail-budget', identity: { kind: 'auto-owner', identityId: IDENTITY },
    headers: {}, method: op.method, path: op.path,
  } satisfies RequestContext) as { content: StoryContent };
  return detail.content;
}

type StoryList = 'roots' | 'blocked' | 'sessions' | 'team' | 'childStories';
function assertBudget(page: EntityContextV2View): void {
  const bytes = Buffer.byteLength(JSON.stringify(page));
  expect(bytes).toBeLessThanOrEqual(16_384);
  expect(page.budget.used).toBe(bytes);
  expect(page.errors).toEqual([]);
}

async function allRows(id: string, first: EntityContextV2View, list: StoryList): Promise<string[]> {
  const seen: string[] = [];
  const cursors = new Set<string>();
  let page = first;
  for (let n = 0; n < 100; n++) {
    assertBudget(page);
    seen.push(...(page.story?.[list] ?? []).map(row => row.id));
    const omitted = page.omitted.find(row => row.section === `story.${list}`);
    if (!omitted) {
      expect(new Set(seen).size).toBe(seen.length);
      return seen;
    }
    const cursor = omitted.expandOp?.params['cursor'];
    expect(typeof cursor).toBe('string');
    expect(cursors.has(cursor as string)).toBe(false);
    cursors.add(cursor as string);
    page = await read(new URLSearchParams({ schema: 'v2', sections: 'story', cursor: cursor as string }), id);
    // Even a list trimmed to zero in the mixed head read must make progress
    // when followed on its own, and it must not reload any sibling list.
    expect(page.story?.[list]?.length).toBeGreaterThan(0);
    for (const other of ['roots', 'blocked', 'sessions', 'team', 'childStories'] as const) {
      if (other !== list) expect(page.story?.[other]).toBeUndefined();
    }
  }
  throw new Error(`non-terminating story.${list} cursor`);
}

it('fits dense Unicode stories in 16 KiB and recovers every list, including a zero-row trim', async () => {
  const browser = await detailContent(DENSE, true);
  expect(browser.context).toBeUndefined();
  expect(browser.page?.roots.map(row => row.id).sort()).toEqual([...DENSE_ROOTS].sort());
  const content = await detailContent(DENSE);
  expect(content.page).toBeNull();
  const first = EntityContextV2ViewSchema.parse(content.context);
  assertBudget(first);
  expect(first.story?.state.rootCount).toBe(12);
  const zero = first.omitted.find(row => row.section.startsWith('story.') && row.reason === 'budget' && row.kept === 0);
  expect(zero).toBeDefined();
  expect(decodeCursor(zero!.expandOp!.params['cursor'] as string).k[2]).toBeNull();
  for (const [list, expected] of [
    ['roots', DENSE_ROOTS], ['blocked', DENSE_ROOTS], ['sessions', DENSE_SESSIONS],
    ['team', DENSE_TEAM], ['childStories', DENSE_CHILDREN],
  ] as const) {
    expect((await allRows(DENSE, first, list)).sort()).toEqual([...expected].sort());
  }
  // The default context path shares the same budget fitter as entity get.
  const context = await read(new URLSearchParams('schema=v2'), DENSE);
  assertBudget(context);
  expect(context.story?.state).toEqual(first.story?.state);
  expect(context.assignment?.complete).toBe(false);
  expect((await allRows(DENSE, context, 'roots')).sort()).toEqual([...DENSE_ROOTS].sort());
  const body = [context.assignment!.text];
  let assignment = context.assignment!;
  while (!assignment.complete) {
    const offset = assignment.expandOp!.params['offset'] as number;
    const next = await read(new URLSearchParams({ schema: 'v2', sections: 'assignment', offset: String(offset) }), DENSE);
    assertBudget(next);
    assignment = next.assignment!;
    body.push(assignment.text);
  }
  expect(body.join('')).toBe(DENSE_BODY);
});

it('pages all 61 child stories in deterministic order under RLS while preserving the browser preview', async () => {
  const browser = await detailContent(PARENT, true);
  expect(browser.page?.childStories.map(row => row.id)).toEqual(CHILDREN.slice(0, 50));
  expect(browser.context).toBeUndefined();
  const first = EntityContextV2ViewSchema.parse((await detailContent(PARENT)).context);
  expect(await allRows(PARENT, first, 'childStories')).toEqual(CHILDREN);
  expect(first.story?.truncated).toBe(false);
});

it('binds start and continuation cursors to their entity, list and section and refuses unreadable child anchors', async () => {
  const dense = EntityContextV2ViewSchema.parse((await detailContent(DENSE)).context);
  const zero = dense.omitted.find(row => row.section.startsWith('story.') && row.kept === 0)!;
  const start = zero.expandOp!.params['cursor'] as string;
  const params = (cursor: string, sections = 'story') => new URLSearchParams({ schema: 'v2', sections, cursor });
  await expect(read(params(start), PARENT)).rejects.toMatchObject({ code: 'invalid_cursor' });
  await expect(read(params(start, 'hierarchy'), DENSE)).rejects.toMatchObject({ code: 'invalid_cursor' });
  const keys = decodeCursor(start).k;
  await expect(read(params(encodeCursor([keys[0], keys[1] === 'team' ? 'roots' : 'team', null])), DENSE))
    .rejects.toMatchObject({ code: 'invalid_cursor' });

  const child = EntityContextV2ViewSchema.parse((await detailContent(PARENT)).context);
  const cursor = child.omitted.find(row => row.section === 'story.childStories')!.expandOp!.params['cursor'] as string;
  const childKeys = decodeCursor(cursor).k;
  for (const id of [HIDDEN_CHILD, DELETED_CHILD, DENSE_CHILDREN[0]!, fixtureId(0xffff)]) {
    await expect(read(params(encodeCursor([childKeys[0], childKeys[1], id])), PARENT))
      .rejects.toMatchObject({ code: 'invalid_cursor' });
  }
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
