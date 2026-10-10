/**
 * 304 + 322 against a real Postgres: `craft` (born `design` in 304, renamed
 * by 322), an ordered set of PAGES (change list items 1, 6 and 15).
 *
 * Pinned here:
 *   - the registry row, and `contains` src_kinds APPENDED (never rewritten);
 *   - the backfill: one craft per live graph that is in no craft, same
 *     title, that graph its only page — and it is idempotent;
 *   - the create/update doors and `internal.entity_content`'s craft arm, and
 *     318's tool arm beside it (the shared object 322 re-issues);
 *   - pages through the membership doors: appended positions, an explicit
 *     position, re-adding re-positions, removing never deletes the page;
 *   - `internal.craft_summary`: live pages only, kinds in page order;
 *   - THE CYCLE GUARD: a craft cannot contain itself or any craft above it,
 *     through the door and through a raw `contains` insert alike;
 *   - both read paths (facade and projector) agree on a craft's title and
 *     state; a detail read hydrates the ordered pages; `entity context`'s v2
 *     view lists them with their positions;
 *   - Run's launch context (`loadDesignContextForTask`): a task derived from
 *     the craft names the craft and its ordered pages, nested pages under
 *     their craft.
 */
import { createDb, type Db } from '../../src/db/index.js';
import type { Querier } from '../../src/db/types.js';
import { loadDesignContextForTask } from '../../src/facade/spawn-design.js';
import { loadCraftPages, loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { loadContextV2 } from '../../src/facade/services/w2/feed-context-v2.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { projectLaunchContext } from '../../src/facade/launch-context.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createW1ScratchDatabase, migrationFiles, MIGRATIONS_DIR, REPO_ROOT, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let facadeDb: Db;
let fixture: Fixture;
let backfilled: { live: string; deleted: string; alreadyPaged: string };

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `craft-304-${label}-${unique}`;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function asApp<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-304',true)`,
      [fixture.identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'craft-304-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId"`,
      )
    ).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Craft owner')`, [f.identityId]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Crafts',$2)`, [f.spaceId, f.identityId]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Craft owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

function idOf(rows: Record<string, unknown>[]): string {
  return (rows[0]!.r as { entity: { id: string } }).entity.id;
}

async function createGraph(title: string): Promise<string> {
  return idOf(await asApp((q) => q(
    `select public.create_graph_entity($1,$2,null,'entity','[]'::jsonb,'[]'::jsonb,'{}'::jsonb,null,null,null,$3) r`,
    [fixture.spaceId, title, cmid('graph')],
  )));
}

async function createDoc(title: string): Promise<string> {
  const [row] = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'doc',0,$3)`,
      [id, fixture.spaceId, fixture.memberId],
    );
    await client.query(`insert into public.documents(entity_id,title,body) values($1,$2,'')`, [id, title]);
    return [{ id }];
  });
  return row!.id;
}

async function createCraft(title: string, description = ''): Promise<string> {
  return idOf(await asApp((q) => q(
    `select public.create_craft_entity($1,$2,null,$3,null,null,$4) r`,
    [fixture.spaceId, title, description, cmid('craft')],
  )));
}

async function add(craft: string, page: string, position: number | null = null): Promise<void> {
  await asApp((q) => q(`select public.set_collection_item($1,$2,$3,null,$4)`, [craft, page, position, cmid('add')]));
}

async function remove(craft: string, page: string): Promise<void> {
  await asApp((q) => q(`select public.remove_collection_item($1,$2,null,$3)`, [craft, page, cmid('remove')]));
}

/** The pages in page order, as the read paths order them. */
async function pagesOf(craft: string): Promise<Array<{ id: string; pos: number | null }>> {
  return database.query(
    `select c.dst_id id,
            case when jsonb_typeof(c.props -> 'position') = 'number'
                 then (c.props ->> 'position')::double precision end pos
       from public.edges c where c.src_id = $1 and c.type = 'contains'
      order by pos nulls last, c.created_at, c.id`,
    [craft],
  );
}

async function summaryOf(craft: string): Promise<{ kind: string; pageCount: number; pageKinds: string[] }> {
  const rows = await asApp((q) => q(`select internal.craft_summary($1) s`, [craft]));
  return rows[0]!.s as { kind: string; pageCount: number; pageKinds: string[] };
}

async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (error) {
    return error as { code?: string; message: string };
  }
  throw new Error('expected a refusal');
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('craft-304');
  const files = migrationFiles();
  const migration = files.find((file) => file.endsWith('_design_kind.sql'))!;
  database.apply(files.filter((file) => file < migration));
  fixture = await seed(database);
  // Three graphs exist before 304: one live, one deleted, and one that some
  // older build already made a page — a collection holds it, which is NOT a
  // craft, so it still gets its own craft.
  const live = await createGraph('Checkout blueprint');
  const deleted = await createGraph('Retired blueprint');
  const alreadyPaged = await createGraph('Filed blueprint');
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(`update public.entities set deleted_at = now() where id = $1`, [deleted]);
    const collection = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'collection',0,$3)`,
      [collection, fixture.spaceId, fixture.memberId],
    );
    await client.query(`insert into public.collections(entity_id,name) values($1,'Filed')`, [collection]);
    await client.query(
      `insert into public.edges(space_id,src_id,dst_id,type,props,created_by) values($1,$2,$3,'contains','{"position":1}'::jsonb,$4)`,
      [fixture.spaceId, collection, alreadyPaged, fixture.memberId],
    );
  });
  backfilled = { live, deleted, alreadyPaged };
  database.apply([migration, ...files.filter((file) => file > migration)]);
  facadeDb = createDb(database.url);
});

afterAll(async () => {
  await facadeDb?.end();
  await database?.destroy();
}, 30_000);

describe('304/322: the registry and the contains edge type', () => {
  it('registers craft as a core kind in place of design, as the last contains source', async () => {
    const [kind] = await database.query(`select origin from public.entity_kinds where kind = 'craft' and space_id is null`);
    expect(kind).toEqual({ origin: 'core' });
    const [edge] = await database.query<{ src_kinds: string[] }>(`select src_kinds from public.edge_types where type = 'contains'`);
    expect(edge!.src_kinds).toEqual(expect.arrayContaining(['collection', 'story', 'craft']));
    expect(edge!.src_kinds.at(-1)).toBe('craft');
    expect(edge!.src_kinds).not.toContain('design');
    const [gone] = await database.query(`select count(*)::int n from public.entity_kinds where kind = 'design'`);
    expect(gone).toEqual({ n: 0 });
  });
});

describe('304 §9: the backfill gives every orphan graph a craft', () => {
  it('made one craft per live graph, same title, the graph its only page at position 1', async () => {
    for (const [graph, title] of [[backfilled.live, 'Checkout blueprint'], [backfilled.alreadyPaged, 'Filed blueprint']] as const) {
      const rows = await database.query<{ craft: string; title: string; pos: string; deleted_at: string | null }>(
        `select d.entity_id craft, d.title, c.props ->> 'position' pos, e.deleted_at
           from public.edges c
           join public.crafts d on d.entity_id = c.src_id
           join public.entities e on e.id = d.entity_id
          where c.dst_id = $1 and c.type = 'contains'`,
        [graph],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title, pos: '1', deleted_at: null });
      expect((await pagesOf(rows[0]!.craft)).map((p) => p.id)).toEqual([graph]);
    }
  });

  it('skipped the deleted graph, and 322 retired the one-time backfill', async () => {
    const [{ n }] = (await database.query<{ n: number }>(
      `select count(*)::int n from public.edges c join public.crafts d on d.entity_id = c.src_id where c.dst_id = $1`,
      [backfilled.deleted],
    )) as [{ n: number }];
    expect(n).toBe(0);
    const [fn] = await database.query(`select to_regprocedure('internal.backfill_graph_designs()') is null gone`);
    expect(fn).toEqual({ gone: true });
  });
});

describe('304: the doors and entity_content', () => {
  it('creates and renames a craft; entity_content carries its title and description', async () => {
    const id = await createCraft('Onboarding', 'Everything for the new signup flow');
    const [before] = await database.query<{ version: number }>(`select version from public.entities where id = $1`, [id]);
    await asApp((q) => q(`select public.update_craft_entity($1,$2,null,$3,null,$4)`, [id, before!.version, 'Onboarding v2', cmid('patch')]));
    const [content] = await database.query<{ c: Record<string, unknown> }>(`select internal.entity_content($1) c`, [id]);
    expect(content!.c).toMatchObject({ title: 'Onboarding v2', description: 'Everything for the new signup flow' });
    const [after] = await database.query<{ version: number; kind: string }>(`select version, kind from public.entities where id = $1`, [id]);
    expect(after).toEqual({ version: before!.version + 1, kind: 'craft' });
  });

  it('refuses an empty title', async () => {
    const error = await refusal(() => createCraft('   '));
    expect(error.code).toBe('22023');
  });
});

describe('304: pages ride the membership doors', () => {
  it('appends, positions explicitly, re-positions on re-add, and removes without deleting', async () => {
    const craft = await createCraft('Pages');
    const graph = await createGraph('Plan');
    const doc = await createDoc('Notes');
    const nested = await createCraft('Nested');
    await add(craft, graph);
    await add(craft, doc);
    expect(await pagesOf(craft)).toEqual([{ id: graph, pos: 1 }, { id: doc, pos: 2 }]);
    await add(craft, nested, 1.5);
    expect((await pagesOf(craft)).map((p) => p.id)).toEqual([graph, nested, doc]);
    // Re-adding moves the page: the reorder gesture.
    await add(craft, graph, 3);
    expect(await pagesOf(craft)).toEqual([{ id: nested, pos: 1.5 }, { id: doc, pos: 2 }, { id: graph, pos: 3 }]);
    expect(await summaryOf(craft)).toEqual({ kind: 'craft', pageCount: 3, pageKinds: ['craft', 'doc', 'graph'] });

    await remove(craft, doc);
    expect((await pagesOf(craft)).map((p) => p.id)).toEqual([nested, graph]);
    const [kept] = await database.query(`select deleted_at from public.entities where id = $1`, [doc]);
    expect(kept).toEqual({ deleted_at: null });
  });

  it('counts only live pages in the summary', async () => {
    const craft = await createCraft('Live only');
    const graph = await createGraph('Kept');
    const gone = await createDoc('Gone');
    await add(craft, graph);
    await add(craft, gone);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set deleted_at = now() where id = $1`, [gone]);
    });
    expect(await summaryOf(craft)).toEqual({ kind: 'craft', pageCount: 1, pageKinds: ['graph'] });
  });

  it('still refuses a container that is none of collection, story or craft', async () => {
    const doc = await createDoc('Not a container');
    const graph = await createGraph('Page');
    const error = await refusal(() => add(doc, graph));
    expect(error.code).toBe('22023');
    expect(error.message).toContain('expected a collection, a story or a craft');
  });
});

describe('304 D2: the cycle guard', () => {
  it('refuses a craft containing itself', async () => {
    const a = await createCraft('Self');
    const error = await refusal(() => add(a, a));
    expect(error.code).toBe('22023');
  });

  it('refuses a craft containing any craft above it, at any depth', async () => {
    const top = await createCraft('Top');
    const middle = await createCraft('Middle');
    const bottom = await createCraft('Bottom');
    await add(top, middle);
    await add(middle, bottom);
    for (const [container, item] of [[middle, top], [bottom, middle], [bottom, top]] as const) {
      const error = await refusal(() => add(container, item));
      expect(error.code).toBe('22023');
      expect(error.message).toContain('would make a loop');
    }
    // Nesting sideways (no loop) is fine, and a craft may be a page twice over.
    const other = await createCraft('Other');
    await add(other, bottom);
    await add(top, bottom);
    expect((await pagesOf(top)).map((p) => p.id)).toEqual([middle, bottom]);
  });

  it('guards a raw contains insert too, so no door can go round it', async () => {
    const outer = await createCraft('Outer');
    const inner = await createCraft('Inner');
    await add(outer, inner);
    const error = await refusal(() => database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.edges(space_id,src_id,dst_id,type,props,created_by) values($1,$2,$3,'contains','{}'::jsonb,$4)`,
        [fixture.spaceId, inner, outer, fixture.memberId],
      );
    }));
    expect(error.code).toBe('22023');
  });
});

describe('304: Run on a craft — the launch context', () => {
  it('names the craft the task was derived from, and its pages in order with nested pages under their craft', async () => {
    const craft = await createCraft('Launchable', 'Build the export');
    const graph = await createGraph('Export plan');
    const doc = await createDoc('Spec');
    const nested = await createCraft('Sub-craft');
    const nestedGraph = await createGraph('Sub plan');
    await add(craft, doc);
    await add(craft, nested);
    await add(craft, graph);
    await add(nested, nestedGraph);
    const task = await asApp(async (q) =>
      ((await q(`select public.derive_task_for_entity($1,$2,null,false) r`, [fixture.spaceId, craft]))[0]!.r as { taskId: string }).taskId);

    const claims = { identityId: fixture.identityId };
    const context = await loadDesignContextForTask(facadeDb, claims, task);
    expect(context).toMatchObject({
      id: craft, title: 'Launchable', taskId: task, snapshot: 'loaded', description: 'Build the export', pageCount: 3,
    });
    expect(context!.pages!.map((p) => [p.depth, p.kind, p.title, p.designId])).toEqual([
      [0, 'doc', 'Spec', craft],
      [0, 'craft', 'Sub-craft', craft],
      [1, 'graph', 'Sub plan', nested],
      [0, 'graph', 'Export plan', craft],
    ]);
    expect(context!.pages!.find((p) => p.id === graph)).toMatchObject({ graphType: 'entity', position: 3 });
    expect(context!.confirmOnlyKinds).toEqual(expect.arrayContaining(['team_member']));
  });

  it('the session\'s Connections name the craft and its pages, via the task, with their titles', async () => {
    const craft = await createCraft('Connected');
    const graph = await createGraph('Connected plan');
    const doc = await createDoc('Connected spec');
    await add(craft, graph);
    await add(craft, doc);
    const task = await asApp(async (q) =>
      ((await q(`select public.derive_task_for_entity($1,$2,null,false) r`, [fixture.spaceId, craft]))[0]!.r as { taskId: string }).taskId);
    const claims = { identityId: fixture.identityId };
    const hand = await loadDesignContextForTask(facadeDb, claims, task);
    const projected = await projectLaunchContext(facadeDb, claims, { tasks: [{ id: task }], design: hand });
    expect(projected.entries.map((e) => [e.role, e.kind, e.title, e.viaTaskId])).toEqual([
      ['task', 'task', 'Work on: Connected', null],
      ['reference', 'craft', 'Connected', task],
      ['reference', 'graph', 'Connected plan', task],
      ['reference', 'doc', 'Connected spec', task],
    ]);
  });

  it('is null for a task that was not launched from a craft', async () => {
    const doc = await createDoc('Plain');
    const task = await asApp(async (q) =>
      ((await q(`select public.derive_task_for_entity($1,$2,null,false) r`, [fixture.spaceId, doc]))[0]!.r as { taskId: string }).taskId);
    expect(await loadDesignContextForTask(facadeDb, { identityId: fixture.identityId }, task)).toBeNull();
  });
});

describe('304: the read paths', () => {
  const caller = <T>(fn: (q: Querier) => Promise<T>): Promise<T> => facadeDb.tx({ identityId: fixture.identityId }, fn);

  it('the facade and the projector agree on title, excerpt and state (pageCount, pageKinds in order)', async () => {
    const craft = await createCraft('Twins', 'Both paths, one function');
    const doc = await createDoc('First');
    const graph = await createGraph('Second');
    await add(craft, graph, 2);
    await add(craft, doc, 1);
    const [summary] = await caller((q) => loadEntitySummariesByIds(q, [craft], fixture.identityId));
    const projected = (await caller((q) => new PgEntityProjector().entitySummaries(q, [craft]))).get(craft);
    expect(summary).toMatchObject({
      kind: 'craft', title: 'Twins', excerpt: 'Both paths, one function',
      state: { kind: 'craft', pageCount: 2, pageKinds: ['doc', 'graph'] },
    });
    expect(projected?.title).toBe(summary!.title);
    expect(projected?.excerpt).toBe(summary!.excerpt);
    expect(projected?.state).toEqual(summary!.state);
  });

  it('a detail read hydrates the pages in page order, each a summary with its pagePosition', async () => {
    const craft = await createCraft('Detail');
    const graph = await createGraph('Plan page');
    const doc = await createDoc('Notes page');
    await add(craft, graph);
    await add(craft, doc, 0.5);
    const pages = await caller((q) => loadCraftPages(q, craft, fixture.identityId));
    expect(pages.map((p) => [p.id, p.kind, p.title, p.pagePosition])).toEqual([
      [doc, 'doc', 'Notes page', 0.5],
      [graph, 'graph', 'Plan page', 1],
    ]);
  });

  it('entity context (v2) lists the pages with kind, title, id and position', async () => {
    const craft = await createCraft('Context', 'What the agent reads');
    const graph = await createGraph('Blueprint');
    const nested = await createCraft('Inner craft');
    await add(craft, graph);
    await add(craft, nested);
    const view = await caller((q) => loadContextV2(q, craft, { sections: null, totalBytes: 16_384 })) as unknown as Record<string, unknown>;
    expect(view.kind).toBe('craft');
    expect(view.assignment).toMatchObject({ text: 'What the agent reads' });
    expect(view.pages).toEqual([
      { id: graph, kind: 'graph', title: 'Blueprint', status: expect.any(String), position: 1 },
      { id: nested, kind: 'craft', title: 'Inner craft', status: expect.any(String), position: 2 },
    ]);
    const only = await caller((q) => loadContextV2(q, craft, { sections: new Set(['pages']), totalBytes: 16_384 })) as unknown as Record<string, unknown>;
    expect((only.pages as unknown[]).length).toBe(2);
  });
});

describe('322: the rename and its rollback', () => {
  const up = readFileSync(join(MIGRATIONS_DIR, '322_design_to_craft.sql'), 'utf8');
  const down = readFileSync(join(REPO_ROOT, 'db', 'rollback', '322_design_to_craft.down.sql'), 'utf8');
  const swap = (text: string): string => text
    .replace(/design/g, '\u0001').replace(/Design/g, '\u0002').replace(/DESIGN/g, '\u0003')
    .replace(/craft/g, 'design').replace(/Craft/g, 'Design').replace(/CRAFT/g, 'DESIGN')
    .replace(/\u0001/g, 'craft').replace(/\u0002/g, 'Craft').replace(/\u0003/g, 'CRAFT');
  const statements = (text: string): string =>
    text.split('\n').filter((l) => l.trim() !== '' && !l.trimStart().startsWith('--')).join('\n');
  const run = (script: string): Promise<void> => database.transaction(async (client) => { await client.query(script); });
  const kindOf = async (id: string): Promise<string> =>
    ((await database.query<{ kind: string }>(`select kind from public.entities where id = $1`, [id]))[0]!).kind;

  // Each file ends in a hand-written NOT SWAPPED tail (321_craft_workspaces'
  // kind check); everything before it is mechanical.
  const swapped = (text: string): string => text.split('-- NOT SWAPPED')[0]!;

  it('the rollback is 322 with design<->craft swapped, statement for statement', () => {
    expect(statements(swapped(down))).toBe(swap(statements(swapped(up))));
    expect(down).toContain(`$k$e.kind in ('craft', 'design')$k$`);
  });

  it('round-trips a populated database: down restores 304, up restores craft', async () => {
    const outer = await createCraft('Round trip');
    const inner = await createCraft('Round trip inner');
    const doc = await createDoc('Round trip page');
    await add(outer, doc);
    await add(outer, inner);

    await run(down);
    expect([await kindOf(outer), await kindOf(inner)]).toEqual(['design', 'design']);
    const [old] = await database.query(`select internal.design_summary($1) s`, [outer]);
    expect(old).toEqual({ s: { kind: 'design', pageCount: 2, pageKinds: ['doc', 'design'] } });
    const [table] = await database.query(`select to_regclass('public.designs') is not null back, to_regclass('public.crafts') is null gone`);
    expect(table).toEqual({ back: true, gone: true });

    await run(up);
    expect([await kindOf(outer), await kindOf(inner)]).toEqual(['craft', 'craft']);
    expect(await summaryOf(outer)).toEqual({ kind: 'craft', pageCount: 2, pageKinds: ['doc', 'craft'] });
    const error = await refusal(() => add(inner, outer));
    expect(error.message).toContain('would make a loop');
    expect(await kindOf(await createCraft('After the round trip'))).toBe('craft');
  });

  it('narrows 321_craft_workspaces\' kind check to craft, and the rollback widens it back', async () => {
    const save = async (): Promise<string | null> => ((await database.query<{ src: string | null }>(
      `select prosrc src from pg_proc where oid = to_regprocedure('public.craft_workspace_save(uuid,uuid,bigint,bigint,jsonb,uuid,boolean)')`,
    ))[0] ?? { src: null }).src;
    const before = await save();
    if (before === null) return; // 321 is not on this branch yet: the tails are no-ops.
    expect(before).toContain(`e.kind = 'craft'`);
    expect(before).not.toMatch(/design/i);
    await run(down);
    expect(await save()).toContain(`e.kind in ('craft', 'design')`);
    await run(up);
    expect(await save()).toBe(before);
  });

  // SHARED OBJECT: 318_tools re-issued entity_content with a `tool` arm; 322
  // re-issues it again. Both arms must survive here, after down and after up.
  it('keeps entity_content non-null for a craft AND a tool, through down and up', async () => {
    const craft = await createCraft('Shared object', 'craft arm');
    const tool = idOf(await asApp((q) => q(
      `select public.create_tool_entity($1,$2::jsonb,null,$3) r`,
      [fixture.spaceId, JSON.stringify({ name: 'shared-object-tool', description: 'tool arm', help: '', runtime: 'bash',
        source: 'true', inputs: [], tm8Access: 'none', timeoutSeconds: 900 }), cmid('tool')],
    )));
    const content = async (id: string): Promise<Record<string, unknown> | null> =>
      ((await database.query<{ c: Record<string, unknown> | null }>(`select internal.entity_content($1) c`, [id]))[0]!).c;
    const both = async (): Promise<void> => {
      expect(await content(craft)).toMatchObject({ title: 'Shared object', description: 'craft arm' });
      expect(await content(tool)).toMatchObject({ definition: { name: 'shared-object-tool' }, config: {}, secretBindings: [] });
    };
    await both();
    await run(down);
    await both();
    await run(up);
    await both();
  });
});
