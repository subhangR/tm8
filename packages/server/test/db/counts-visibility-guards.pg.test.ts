/**
 * The two counting RPCs hide exactly what they hid before 158.
 *
 * 158 stopped `public.space_kind_counts` and `public.unread_counts` calling
 * `internal.entity_readable(<id>)` once per row — a primary-key lookup for a
 * row the surrounding query has already joined — and made them read the same
 * predicate off the row instead. That is a ~12x and ~28x win respectively, and
 * it is also the single most dangerous shape of change available in this
 * schema: both functions are `security definer`, both exist BECAUSE a counter
 * must never disclose an entity the corresponding list would hide (063), and a
 * mistake here is a disclosure bug that no user-visible symptom would reveal.
 *
 * Equivalence was verified empirically before the change landed (all 17 kinds
 * on prod for `space_kind_counts`; 163 anchors and a summed total of 506 for
 * `unread_counts`; 29 376 input combinations across both). This file exists so
 * that the guards survive the NEXT edit, and it targets the two conjuncts that
 * the rewrite could plausibly have dropped rather than re-testing the happy
 * path the existing suites already cover.
 *
 * Every assertion is a red/green pair. A test that only asserts "the hidden
 * thing is absent" passes just as well against a function that returns nothing
 * at all, so each case below also asserts the visible sibling it must NOT
 * affect.
 *
 * 1. `unread_counts` — a message anchored to a DELETED entity.
 *    This is the one real trap in 158. The existing `anchor_entity` join
 *    constrains `id` and `space_id` only, so `entity_readable(anchor_id)` was
 *    the SOLE thing excluding these; dropping the call without restating
 *    `anchor_entity.deleted_at is null` would silently have inflated every
 *    unread count in the product.
 *
 * 2. `space_kind_counts` — the `restricted` / `project` carve-out.
 *    A restricted entity is invisible UNLESS it is a `project` whose space link
 *    is active. Both halves are asserted, in both directions, because a rewrite
 *    that dropped the carve-out entirely would still pass a test that only
 *    checked that restricted rows are hidden.
 */
import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const VIEWER_IDENTITY = 'counts-guard-viewer';
const AUTHOR_IDENTITY = 'counts-guard-author';

interface Fixture {
  spaceId: string;
  viewerMemberId: string;
  authorMemberId: string;
  liveChannelId: string;
  doomedChannelId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/** Seeding runs as the graph owner — it is setup, never the thing under test. */
async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/**
 * Both RPCs are SECURITY DEFINER and resolve the member from `tm8.identity_id`
 * rather than from a parameter, so a call without claims measures nobody.
 */
async function asViewer<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'counts-visibility-guards-pg', true)`,
      [VIEWER_IDENTITY],
    );
    return fn(client);
  });
}

/** `public.unread_counts` for one anchor, as the assembler calls it. */
async function unreadFor(anchorId: string): Promise<number> {
  return asViewer(async (client) => {
    const rows = await client.query<{ anchor_id: string; unread: number }>(
      'select * from public.unread_counts($1)',
      [fixture.spaceId],
    );
    const row = rows.rows.find((r) => r.anchor_id === anchorId);
    return row ? Number(row.unread) : 0;
  });
}

/** `public.space_kind_counts` total for one kind. Absent reads as zero. */
async function totalForKind(kind: string): Promise<number> {
  return asViewer(async (client) => {
    const rows = await client.query<{ kind: string; total: number }>(
      'select * from public.space_kind_counts($1)',
      [fixture.spaceId],
    );
    const row = rows.rows.find((r) => r.kind === kind);
    return row ? Number(row.total) : 0;
  });
}

/** Post one message to `anchorId`, authored by someone other than the viewer. */
async function post(anchorId: string): Promise<string> {
  return asOwner(async (client) => {
    const id = (await client.query<{ id: string }>('select internal.new_id() id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1, $2, 'message', null, $3)`,
      [id, fixture.spaceId, fixture.authorMemberId],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, author_id, body, client_msg_id)
       values ($1, $2, $3, 'guard', $4)`,
      [id, anchorId, fixture.authorMemberId, randomUUID()],
    );
    return id;
  });
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const ids = (await client.query<{
      space_id: string;
      viewer_member_id: string;
      author_member_id: string;
      live_channel_id: string;
      doomed_channel_id: string;
    }>(
      `select internal.new_id() space_id, internal.new_id() viewer_member_id,
              internal.new_id() author_member_id, internal.new_id() live_channel_id,
              internal.new_id() doomed_channel_id`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Guard viewer'), ($2, 'Guard author')`,
      [VIEWER_IDENTITY, AUTHOR_IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Counts guards', $2)`,
      [ids.space_id, VIEWER_IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $3, 'member', 0, $1), ($2, $3, 'member', 1, $2),
       ($4, $3, 'channel', 2, $1), ($5, $3, 'channel', 3, $1)`,
      [
        ids.viewer_member_id,
        ids.author_member_id,
        ids.space_id,
        ids.live_channel_id,
        ids.doomed_channel_id,
      ],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $3, $4, 'owner', 'Guard viewer'), ($2, $3, $5, 'member', 'Guard author')`,
      [
        ids.viewer_member_id,
        ids.author_member_id,
        ids.space_id,
        VIEWER_IDENTITY,
        AUTHOR_IDENTITY,
      ],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic) values
       ($1, $3, 'live', 'stays'), ($2, $3, 'doomed', 'gets deleted')`,
      [ids.live_channel_id, ids.doomed_channel_id, ids.space_id],
    );

    return {
      spaceId: ids.space_id,
      viewerMemberId: ids.viewer_member_id,
      authorMemberId: ids.author_member_id,
      liveChannelId: ids.live_channel_id,
      doomedChannelId: ids.doomed_channel_id,
    };
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('counts_visibility_guards');
  database.apply(migrationFiles());
  fixture = await seed();
});

afterAll(async () => {
  await database?.destroy();
});

describe('unread_counts hides a message whose ANCHOR is deleted', () => {
  it('counts messages on both channels while both anchors are alive', async () => {
    await post(fixture.liveChannelId);
    await post(fixture.doomedChannelId);
    await post(fixture.doomedChannelId);
    // GREEN half: without this, the assertion below would pass against an RPC
    // that had simply stopped returning anything.
    expect(await unreadFor(fixture.liveChannelId)).toBe(1);
    expect(await unreadFor(fixture.doomedChannelId)).toBe(2);
  });

  it('drops the deleted anchor entirely, and leaves the live one untouched', async () => {
    await asOwner(async (client) => {
      await client.query(
        `update public.entities set deleted_at = now() where id = $1`,
        [fixture.doomedChannelId],
      );
    });
    // THE 158 TRAP. The `anchor_entity` join constrains id and space_id only,
    // so nothing but an explicit `deleted_at is null` excludes these now.
    expect(await unreadFor(fixture.doomedChannelId)).toBe(0);
    expect(await unreadFor(fixture.liveChannelId)).toBe(1);
  });
});

describe('space_kind_counts honours the restricted / project carve-out', () => {
  it('counts a space-visible doc, and hides a restricted non-project one', async () => {
    await asOwner(async (client) => {
      const ids = (await client.query<{ open_id: string; shut_id: string }>(
        'select internal.new_id() open_id, internal.new_id() shut_id',
      )).rows[0]!;
      await client.query(
        `insert into public.entities(id, space_id, kind, position, visibility, created_by) values
         ($1, $3, 'doc', 10, 'space', $4), ($2, $3, 'doc', 11, 'restricted', $4)`,
        [ids.open_id, ids.shut_id, fixture.spaceId, fixture.viewerMemberId],
      );
      await client.query(
        `insert into public.documents(entity_id, title, body, format) values
         ($1, 'open', '', 'markdown'), ($2, 'shut', '', 'markdown')`,
        [ids.open_id, ids.shut_id],
      );
    });
    // One of the two is counted. A rewrite that dropped the visibility
    // predicate altogether would say 2 here; one that hid everything, 0.
    // `restricted` is only ever readable via the project carve-out, and a doc
    // can never satisfy it — so this is the plain-deny half.
    expect(await totalForKind('doc')).toBe(1);
  });

  it('counts a RESTRICTED project while its space link is active', async () => {
    await asOwner(async (client) => {
      const projectId = (await client.query<{ id: string }>('select internal.new_id() id')).rows[0]!.id;
      await client.query(
        `insert into public.projects(id, name, working_dir) values ($1, 'guard-project', '/tmp/guard')`,
        [projectId],
      );
      // The projection entity and its `project_links` row are
      // materializer-owned (`internal.after_space_project_link`) — inserting a
      // `project` entity directly is refused by
      // `entities_project_lifecycle_guard`. Linking the project IS the public
      // way to create one, so the fixture drives the real pipeline rather than
      // forging its output.
      await client.query(
        `insert into public.space_projects(space_id, project_id) values ($1, $2)`,
        [fixture.spaceId, projectId],
      );
    });
    // The materializer creates it `restricted`, so this row is visible ONLY
    // through the carve-out. If 158 had dropped the carve-out, this is 0.
    expect(await totalForKind('project')).toBe(1);
  });

  it('hides that same project once the space link is gone but the row lives on', async () => {
    await asOwner(async (client) => {
      await client.query(`delete from public.space_projects where space_id = $1`, [
        fixture.spaceId,
      ]);
      // Unlinking soft-deletes the projection, which would hide it via
      // `deleted_at` and prove nothing about the carve-out. Revive it, leaving
      // exactly one difference from the previous test: no active space link.
      // That isolates the carve-out's `exists (...)` and nothing else.
      await client.query(`select internal.w1_set_writer('project_materializer')`);
      await client.query(
        `update public.entities set deleted_at = null
          where space_id = $1 and kind = 'project'`,
        [fixture.spaceId],
      );
      await client.query(`select internal.w1_set_writer(null)`);
    });
    // The RED half: the carve-out is a live join, not a rubber stamp on
    // anything that happens to be `kind = 'project'`.
    expect(await totalForKind('project')).toBe(0);
    // The doc count is unmoved, so the change above was scoped to projects.
    expect(await totalForKind('doc')).toBe(1);
  });
});
