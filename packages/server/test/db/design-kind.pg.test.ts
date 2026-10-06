/**
 * 302 against a real Postgres: `design`, an ordered set of PAGES (Craft →
 * Designs, change list items 1, 6 and 15).
 *
 * Pinned here:
 *   - the registry row, and `contains` src_kinds APPENDED (never rewritten);
 *   - the backfill: one design per live graph that is in no design, same
 *     title, that graph its only page — and it is idempotent;
 *   - the create/update doors and `internal.entity_content`'s design arm;
 *   - pages through the membership doors: appended positions, an explicit
 *     position, re-adding re-positions, removing never deletes the page;
 *   - `internal.design_summary`: live pages only, kinds in page order;
 *   - THE CYCLE GUARD: a design cannot contain itself or any design above it,
 *     through the door and through a raw `contains` insert alike;
 *   - both read paths (facade and projector) agree on a design's title and
 *     state; a detail read hydrates the ordered pages; `entity context`'s v2
 *     view lists them with their positions;
 *   - Run's launch context (`loadDesignContextForTask`): a task derived from
 *     the design names the design and its ordered pages, nested pages under
 *     their design.
 */
import { createDb, type Db } from '../../src/db/index.js';
import type { Querier } from '../../src/db/types.js';
import { loadDesignContextForTask } from '../../src/facade/spawn-design.js';
import { loadDesignPages, loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { loadContextV2 } from '../../src/facade/services/w2/feed-context-v2.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { projectLaunchContext } from '../../src/facade/launch-context.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

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
  return `design-302-${label}-${unique}`;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function asApp<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-302',true)`,
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
        `select 'design-302-owner'::text "identityId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId"`,
      )
    ).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values($1,'Design owner')`, [f.identityId]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Designs',$2)`, [f.spaceId, f.identityId]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Design owner')`,
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

async function createDesign(title: string, description = ''): Promise<string> {
  return idOf(await asApp((q) => q(
    `select public.create_design_entity($1,$2,null,$3,null,null,$4) r`,
    [fixture.spaceId, title, description, cmid('design')],
  )));
}

async function add(design: string, page: string, position: number | null = null): Promise<void> {
  await asApp((q) => q(`select public.set_collection_item($1,$2,$3,null,$4)`, [design, page, position, cmid('add')]));
}

async function remove(design: string, page: string): Promise<void> {
  await asApp((q) => q(`select public.remove_collection_item($1,$2,null,$3)`, [design, page, cmid('remove')]));
}

/** The pages in page order, as the read paths order them. */
async function pagesOf(design: string): Promise<Array<{ id: string; pos: number | null }>> {
  return database.query(
    `select c.dst_id id,
            case when jsonb_typeof(c.props -> 'position') = 'number'
                 then (c.props ->> 'position')::double precision end pos
       from public.edges c where c.src_id = $1 and c.type = 'contains'
      order by pos nulls last, c.created_at, c.id`,
    [design],
  );
}

async function summaryOf(design: string): Promise<{ kind: string; pageCount: number; pageKinds: string[] }> {
  const rows = await asApp((q) => q(`select internal.design_summary($1) s`, [design]));
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
  database = await createW1ScratchDatabase('design-302');
  const files = migrationFiles();
  const migration = files.find((file) => file.endsWith('_design_kind.sql'))!;
  database.apply(files.filter((file) => file < migration));
  fixture = await seed(database);
  // Three graphs exist before 302: one live, one deleted, and one that some
  // older build already made a page — a collection holds it, which is NOT a
  // design, so it still gets its own design.
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

describe('302: the registry and the contains edge type', () => {
  it('registers design as a core kind and APPENDS it to contains sources', async () => {
    const [kind] = await database.query(`select origin from public.entity_kinds where kind = 'design' and space_id is null`);
    expect(kind).toEqual({ origin: 'core' });
    const [edge] = await database.query<{ src_kinds: string[] }>(`select src_kinds from public.edge_types where type = 'contains'`);
    expect(edge!.src_kinds).toEqual(expect.arrayContaining(['collection', 'story', 'design']));
    expect(edge!.src_kinds.at(-1)).toBe('design');
  });
});

describe('302 §9: the backfill gives every orphan graph a design', () => {
  it('made one design per live graph, same title, the graph its only page at position 1', async () => {
    for (const [graph, title] of [[backfilled.live, 'Checkout blueprint'], [backfilled.alreadyPaged, 'Filed blueprint']] as const) {
      const rows = await database.query<{ design: string; title: string; pos: string; deleted_at: string | null }>(
        `select d.entity_id design, d.title, c.props ->> 'position' pos, e.deleted_at
           from public.edges c
           join public.designs d on d.entity_id = c.src_id
           join public.entities e on e.id = d.entity_id
          where c.dst_id = $1 and c.type = 'contains'`,
        [graph],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title, pos: '1', deleted_at: null });
      expect((await pagesOf(rows[0]!.design)).map((p) => p.id)).toEqual([graph]);
    }
  });

  it('skipped the deleted graph, and a second run makes nothing', async () => {
    const [{ n }] = (await database.query<{ n: number }>(
      `select count(*)::int n from public.edges c join public.designs d on d.entity_id = c.src_id where c.dst_id = $1`,
      [backfilled.deleted],
    )) as [{ n: number }];
    expect(n).toBe(0);
    const again = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ made: number }>(`select internal.backfill_graph_designs() made`)).rows[0]!.made;
    });
    expect(again).toBe(0);
  });
});

describe('302: the doors and entity_content', () => {
  it('creates and renames a design; entity_content carries its title and description', async () => {
    const id = await createDesign('Onboarding', 'Everything for the new signup flow');
    const [before] = await database.query<{ version: number }>(`select version from public.entities where id = $1`, [id]);
    await asApp((q) => q(`select public.update_design_entity($1,$2,null,$3,null,$4)`, [id, before!.version, 'Onboarding v2', cmid('patch')]));
    const [content] = await database.query<{ c: Record<string, unknown> }>(`select internal.entity_content($1) c`, [id]);
    expect(content!.c).toMatchObject({ title: 'Onboarding v2', description: 'Everything for the new signup flow' });
    const [after] = await database.query<{ version: number; kind: string }>(`select version, kind from public.entities where id = $1`, [id]);
    expect(after).toEqual({ version: before!.version + 1, kind: 'design' });
  });

  it('refuses an empty title', async () => {
    const error = await refusal(() => createDesign('   '));
    expect(error.code).toBe('22023');
  });
});

describe('302: pages ride the membership doors', () => {
  it('appends, positions explicitly, re-positions on re-add, and removes without deleting', async () => {
    const design = await createDesign('Pages');
    const graph = await createGraph('Plan');
    const doc = await createDoc('Notes');
    const nested = await createDesign('Nested');
    await add(design, graph);
    await add(design, doc);
    expect(await pagesOf(design)).toEqual([{ id: graph, pos: 1 }, { id: doc, pos: 2 }]);
    await add(design, nested, 1.5);
    expect((await pagesOf(design)).map((p) => p.id)).toEqual([graph, nested, doc]);
    // Re-adding moves the page: the reorder gesture.
    await add(design, graph, 3);
    expect(await pagesOf(design)).toEqual([{ id: nested, pos: 1.5 }, { id: doc, pos: 2 }, { id: graph, pos: 3 }]);
    expect(await summaryOf(design)).toEqual({ kind: 'design', pageCount: 3, pageKinds: ['design', 'doc', 'graph'] });

    await remove(design, doc);
    expect((await pagesOf(design)).map((p) => p.id)).toEqual([nested, graph]);
    const [kept] = await database.query(`select deleted_at from public.entities where id = $1`, [doc]);
    expect(kept).toEqual({ deleted_at: null });
  });

  it('counts only live pages in the summary', async () => {
    const design = await createDesign('Live only');
    const graph = await createGraph('Kept');
    const gone = await createDoc('Gone');
    await add(design, graph);
    await add(design, gone);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set deleted_at = now() where id = $1`, [gone]);
    });
    expect(await summaryOf(design)).toEqual({ kind: 'design', pageCount: 1, pageKinds: ['graph'] });
  });

  it('still refuses a container that is none of collection, story or design', async () => {
    const doc = await createDoc('Not a container');
    const graph = await createGraph('Page');
    const error = await refusal(() => add(doc, graph));
    expect(error.code).toBe('22023');
    expect(error.message).toContain('expected a collection, a story or a design');
  });
});

describe('302 D2: the cycle guard', () => {
  it('refuses a design containing itself', async () => {
    const a = await createDesign('Self');
    const error = await refusal(() => add(a, a));
    expect(error.code).toBe('22023');
  });

  it('refuses a design containing any design above it, at any depth', async () => {
    const top = await createDesign('Top');
    const middle = await createDesign('Middle');
    const bottom = await createDesign('Bottom');
    await add(top, middle);
    await add(middle, bottom);
    for (const [container, item] of [[middle, top], [bottom, middle], [bottom, top]] as const) {
      const error = await refusal(() => add(container, item));
      expect(error.code).toBe('22023');
      expect(error.message).toContain('would make a loop');
    }
    // Nesting sideways (no loop) is fine, and a design may be a page twice over.
    const other = await createDesign('Other');
    await add(other, bottom);
    await add(top, bottom);
    expect((await pagesOf(top)).map((p) => p.id)).toEqual([middle, bottom]);
  });

  it('guards a raw contains insert too, so no door can go round it', async () => {
    const outer = await createDesign('Outer');
    const inner = await createDesign('Inner');
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

describe('302: Run on a design — the launch context', () => {
  it('names the design the task was derived from, and its pages in order with nested pages under their design', async () => {
    const design = await createDesign('Launchable', 'Build the export');
    const graph = await createGraph('Export plan');
    const doc = await createDoc('Spec');
    const nested = await createDesign('Sub-design');
    const nestedGraph = await createGraph('Sub plan');
    await add(design, doc);
    await add(design, nested);
    await add(design, graph);
    await add(nested, nestedGraph);
    const task = await asApp(async (q) =>
      ((await q(`select public.derive_task_for_entity($1,$2,null,false) r`, [fixture.spaceId, design]))[0]!.r as { taskId: string }).taskId);

    const claims = { identityId: fixture.identityId };
    const context = await loadDesignContextForTask(facadeDb, claims, task);
    expect(context).toMatchObject({
      id: design, title: 'Launchable', taskId: task, snapshot: 'loaded', description: 'Build the export', pageCount: 3,
    });
    expect(context!.pages!.map((p) => [p.depth, p.kind, p.title, p.designId])).toEqual([
      [0, 'doc', 'Spec', design],
      [0, 'design', 'Sub-design', design],
      [1, 'graph', 'Sub plan', nested],
      [0, 'graph', 'Export plan', design],
    ]);
    expect(context!.pages!.find((p) => p.id === graph)).toMatchObject({ graphType: 'entity', position: 3 });
    expect(context!.confirmOnlyKinds).toEqual(expect.arrayContaining(['team_member']));
  });

  it('the session\'s Connections name the design and its pages, via the task, with their titles', async () => {
    const design = await createDesign('Connected');
    const graph = await createGraph('Connected plan');
    const doc = await createDoc('Connected spec');
    await add(design, graph);
    await add(design, doc);
    const task = await asApp(async (q) =>
      ((await q(`select public.derive_task_for_entity($1,$2,null,false) r`, [fixture.spaceId, design]))[0]!.r as { taskId: string }).taskId);
    const claims = { identityId: fixture.identityId };
    const hand = await loadDesignContextForTask(facadeDb, claims, task);
    const projected = await projectLaunchContext(facadeDb, claims, { tasks: [{ id: task }], design: hand });
    expect(projected.entries.map((e) => [e.role, e.kind, e.title, e.viaTaskId])).toEqual([
      ['task', 'task', 'Work on: Connected', null],
      ['reference', 'design', 'Connected', task],
      ['reference', 'graph', 'Connected plan', task],
      ['reference', 'doc', 'Connected spec', task],
    ]);
  });

  it('is null for a task that was not launched from a design', async () => {
    const doc = await createDoc('Plain');
    const task = await asApp(async (q) =>
      ((await q(`select public.derive_task_for_entity($1,$2,null,false) r`, [fixture.spaceId, doc]))[0]!.r as { taskId: string }).taskId);
    expect(await loadDesignContextForTask(facadeDb, { identityId: fixture.identityId }, task)).toBeNull();
  });
});

describe('302: the read paths', () => {
  const caller = <T>(fn: (q: Querier) => Promise<T>): Promise<T> => facadeDb.tx({ identityId: fixture.identityId }, fn);

  it('the facade and the projector agree on title, excerpt and state (pageCount, pageKinds in order)', async () => {
    const design = await createDesign('Twins', 'Both paths, one function');
    const doc = await createDoc('First');
    const graph = await createGraph('Second');
    await add(design, graph, 2);
    await add(design, doc, 1);
    const [summary] = await caller((q) => loadEntitySummariesByIds(q, [design], fixture.identityId));
    const projected = (await caller((q) => new PgEntityProjector().entitySummaries(q, [design]))).get(design);
    expect(summary).toMatchObject({
      kind: 'design', title: 'Twins', excerpt: 'Both paths, one function',
      state: { kind: 'design', pageCount: 2, pageKinds: ['doc', 'graph'] },
    });
    expect(projected?.title).toBe(summary!.title);
    expect(projected?.excerpt).toBe(summary!.excerpt);
    expect(projected?.state).toEqual(summary!.state);
  });

  it('a detail read hydrates the pages in page order, each a summary with its pagePosition', async () => {
    const design = await createDesign('Detail');
    const graph = await createGraph('Plan page');
    const doc = await createDoc('Notes page');
    await add(design, graph);
    await add(design, doc, 0.5);
    const pages = await caller((q) => loadDesignPages(q, design, fixture.identityId));
    expect(pages.map((p) => [p.id, p.kind, p.title, p.pagePosition])).toEqual([
      [doc, 'doc', 'Notes page', 0.5],
      [graph, 'graph', 'Plan page', 1],
    ]);
  });

  it('entity context (v2) lists the pages with kind, title, id and position', async () => {
    const design = await createDesign('Context', 'What the agent reads');
    const graph = await createGraph('Blueprint');
    const nested = await createDesign('Inner design');
    await add(design, graph);
    await add(design, nested);
    const view = await caller((q) => loadContextV2(q, design, { sections: null, totalBytes: 16_384 })) as unknown as Record<string, unknown>;
    expect(view.kind).toBe('design');
    expect(view.assignment).toMatchObject({ text: 'What the agent reads' });
    expect(view.pages).toEqual([
      { id: graph, kind: 'graph', title: 'Blueprint', status: expect.any(String), position: 1 },
      { id: nested, kind: 'design', title: 'Inner design', status: expect.any(String), position: 2 },
    ]);
    const only = await caller((q) => loadContextV2(q, design, { sections: new Set(['pages']), totalBytes: 16_384 })) as unknown as Record<string, unknown>;
    expect((only.pages as unknown[]).length).toBe(2);
  });
});
