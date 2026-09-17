/**
 * Migration 194 — the `drawing` core kind, through the server's TWO read
 * paths at once.
 *
 * WHY THIS SUITE EXISTS, and why it is not a second copy of
 * db/test/drawing_rpcs.test.mjs (which already proves the doors): a kind is
 * read through two independent implementations that must agree —
 * `facade/entity-read.ts` (the request path) and `events/projector.ts` (the
 * event-feed path). Both files' `drawing` arms carry a "MIRRORS the other
 * twin" comment, and that comment is the whole guarantee: nothing else makes
 * them agree.
 *
 * The drift is INVISIBLE to a per-path test. A tile hydrated from the feed and
 * the same entity fetched over `entities.get` would simply disagree — different
 * title, a different element count — and each path's own suite would stay
 * green. So the assertions below read the SAME entity through BOTH and compare
 * them to each other, not only to a literal.
 *
 * The scene is also the largest payload any kind carries, which is why
 * `elementCount` is state and `elements` is content. A projector that started
 * shipping the elements themselves would still pass a "the count is right"
 * test; the last case pins that the summary state carries no scene at all.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/** One Excalidraw rectangle, trimmed to the members the row round-trips. */
const rect = (id: string, x: number) => ({
  id, type: 'rectangle', x, y: 40, width: 120, height: 60,
  angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent',
  fillStyle: 'solid', strokeWidth: 2, roughness: 1, opacity: 100,
  seed: 1234, version: 1, versionNonce: 5678, isDeleted: false,
});

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'drawing-proj-owner'::text "identityId",
              internal.new_id()::text "spaceId", internal.new_id()::text "memberId"`,
    )).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Drawing owner')`,
      [f.identityId],
    );
    await client.query(`insert into public.spaces(id,name,created_by_identity) values($1,'Drawings',$2)`,
      [f.spaceId, f.identityId]);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Drawing owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

/** A drawing entity + detail row, seeded directly as the graph owner. */
async function mintDrawing(
  title: string,
  elements: unknown[],
  appState: Record<string, unknown> = {},
  format = 'excalidraw',
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'drawing',null,0,$3)`,
      [id, fixture.spaceId, fixture.memberId],
    );
    await client.query(
      `insert into public.drawings(entity_id,title,format,elements,app_state,files)
       values($1,$2,$3,$4::jsonb,$5::jsonb,'{}'::jsonb)`,
      [id, title, format, JSON.stringify(elements), JSON.stringify(appState)],
    );
    return id;
  });
}

function querier(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Querier {
  return {
    query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
      (await client.query(sql, [...params])).rows as R[],
    rpc: async () => { throw new Error('reads only'); },
  };
}

/** The REQUEST path — facade/entity-read.ts. */
async function summaryOf(id: string) {
  return database.transaction(async (client) => {
    const summaries = await loadEntitySummariesByIds(querier(client), [id], fixture.identityId);
    expect(summaries).toHaveLength(1);
    return summaries[0]!;
  });
}

/** The EVENT-FEED path — events/projector.ts. */
async function projectedOf(id: string) {
  return database.transaction(async (client) => {
    const projected = await new PgEntityProjector().entitySummaries(querier(client), [id]);
    const summary = projected.get(id);
    expect(summary).toBeDefined();
    return summary!;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('drawing_projection');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
});

describe('the drawing kind, read through both server paths', () => {
  it('the request path carries the detail-row title and a typed state', async () => {
    const id = await mintDrawing('Auth sketch', [rect('a', 0), rect('b', 200)]);
    const summary = await summaryOf(id);

    expect(summary.kind).toBe('drawing');
    // `public.entities` has no title column: a drawing that fell back would
    // read 'Drawing', so this also pins that the detail row is reached.
    expect(summary.title).toBe('Auth sketch');
    expect(summary.state).toMatchObject({
      kind: 'drawing',
      format: 'excalidraw',
      elementCount: 2,
    });
  });

  it('the event-feed path AGREES with the request path, field for field', async () => {
    const id = await mintDrawing('Login wireframe', [rect('a', 0), rect('b', 200), rect('c', 400)]);
    const [summary, projected] = await Promise.all([summaryOf(id), projectedOf(id)]);

    // The comparison is between the two IMPLEMENTATIONS, not against a
    // literal: a literal on each side would still pass if both drifted the
    // same way, and drift is the only thing this case is here to catch.
    expect(projected.kind).toBe(summary.kind);
    expect(projected.title).toBe(summary.title);
    expect(projected.state).toEqual(summary.state);
    expect(projected.excerpt).toBe(summary.excerpt);

    // ...and the shared value is the RIGHT one, so that two paths agreeing on
    // a wrong answer is still a failure.
    expect(summary.title).toBe('Login wireframe');
    expect(summary.state).toMatchObject({ kind: 'drawing', format: 'excalidraw', elementCount: 3 });
  });

  it('an unnamed row still reads as something human, never as an id', async () => {
    // `titleOf`'s fallback, which both twins declare. A drawing seeded with an
    // empty-ish title is not reachable through the doors, so this exercises
    // the fallback the way a stray or legacy row would.
    const id = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const made = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values($1,$2,'drawing',null,0,$3)`,
        [made, fixture.spaceId, fixture.memberId],
      );
      return made;
    });

    const [summary, projected] = await Promise.all([summaryOf(id), projectedOf(id)]);
    expect(summary.title).toBe('Drawing');
    expect(projected.title).toBe('Drawing');
  });

  it('a summary never carries the scene — elements are content, not state', async () => {
    // The guard against the cheapest possible regression: widening the
    // projector to select `drw.elements` would put a megabyte-scale payload on
    // the event path, and an elementCount assertion alone would not notice.
    const many = Array.from({ length: 40 }, (_, i) => rect(`e${i}`, i * 10));
    const id = await mintDrawing('Big board', many, { viewBackgroundColor: '#ffffff' });

    const [summary, projected] = await Promise.all([summaryOf(id), projectedOf(id)]);
    expect(summary.state).toEqual({ kind: 'drawing', format: 'excalidraw', elementCount: 40 });
    expect(projected.state).toEqual(summary.state);

    const serialized = JSON.stringify(summary.state);
    expect(serialized).not.toContain('rectangle');
    expect(serialized).not.toContain('strokeColor');
    expect(JSON.stringify(projected.state)).not.toContain('rectangle');
  });

  it('a second canvas format needs no server change — format is a slug, not an enum', async () => {
    // 135's R3 lesson, carried forward: the column check is a slug grammar, so
    // a future format reaches both read paths without a migration. If either
    // twin ever hard-codes 'excalidraw', this is what reds.
    const id = await mintDrawing('Future canvas', [rect('a', 0)], {}, 'tldraw-ish');
    const [summary, projected] = await Promise.all([summaryOf(id), projectedOf(id)]);
    expect(summary.state).toMatchObject({ format: 'tldraw-ish', elementCount: 1 });
    expect(projected.state).toEqual(summary.state);
  });
});
