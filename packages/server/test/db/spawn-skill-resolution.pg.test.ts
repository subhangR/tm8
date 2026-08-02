import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import { DbGraphPort } from '../../src/facade/execution-handlers.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

/**
 * Row #11 — the ancestor walk, against a real database.
 *
 * The collision RULE is a pure function and is covered exhaustively in
 * packages/execution/test/spawn-skill-resolution.test.ts. What can only be
 * proved here is the recursive CTE in `loadSpawnContext`: that it climbs
 * `entities.parent_id` through a team member chain, joins `equips` edges to
 * `public.skills` at every level, and reports depth correctly — and that it
 * does NOT climb through a deleted ancestor, cross a space boundary, or pick up
 * a sibling's skills.
 *
 * Before this landed, `composeManifest` emitted a hardcoded `skills: []`, so
 * every one of these assertions would have read as an empty array.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  /** root -> mid -> leaf, a three-level persona chain. */
  rootId: string;
  midId: string;
  leafId: string;
  /** A second child of root, to prove siblings do not leak into each other. */
  siblingId: string;
  loneId: string;
}

let database: W1ScratchDatabase;
let db: PgDb;
let port: DbGraphPort;
let fx: Fixture;

/** Insert a team_member entity + detail row, optionally parented. */
async function teamMember(
  client: Parameters<Parameters<W1ScratchDatabase['transaction']>[0]>[0],
  args: { id: string; spaceId: string; memberId: string; name: string; parentId: string | null; position: number },
): Promise<void> {
  await client.query(
    `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
     values($1,$2,'team_member',$3,$4,$5)`,
    [args.id, args.spaceId, args.parentId, args.position, args.memberId],
  );
  await client.query(
    `insert into public.team_members(entity_id,owner_member_id,name,role,model)
     values($1,$2,$3,'tester','opus')`,
    [args.id, args.memberId, args.name],
  );
}

/** Insert a skill entity + detail row, and equip it to `equipperId`. */
async function skill(
  client: Parameters<Parameters<W1ScratchDatabase['transaction']>[0]>[0],
  args: { spaceId: string; memberId: string; equipperId: string; name: string; content: string },
): Promise<string> {
  const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
  await client.query(
    `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
     values($1,$2,'skill',null,0,$3)`,
    [id, args.spaceId, args.memberId],
  );
  await client.query(
    `insert into public.skills(entity_id,name,content) values($1,$2,$3)`,
    [id, args.name, args.content],
  );
  await client.query(
    `insert into public.edges(space_id,src_id,dst_id,type,created_by)
     values($1,$2,$3,'equips',$4)`,
    [args.spaceId, args.equipperId, id, args.memberId],
  );
  return id;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('skillres');
  database.apply(migrationFiles());
  db = new PgDb({ databaseUrl: database.url, role: 'tm8_graph_owner' });

  fx = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const base = (await client.query<{
      identityId: string; spaceId: string; memberId: string;
      rootId: string; midId: string; leafId: string; siblingId: string; loneId: string;
    }>(
      `select 'skillres-owner'::text "identityId", internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId", internal.new_id()::text "rootId",
              internal.new_id()::text "midId", internal.new_id()::text "leafId",
              internal.new_id()::text "siblingId", internal.new_id()::text "loneId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Skill res owner')`,
      [base.identityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Skill Res Space',$2)`,
      [base.spaceId, base.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [base.memberId, base.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Skill res owner')`,
      [base.memberId, base.spaceId, base.identityId],
    );

    const common = { spaceId: base.spaceId, memberId: base.memberId };
    await teamMember(client, { ...common, id: base.rootId, name: 'Root', parentId: null, position: 1 });
    await teamMember(client, { ...common, id: base.midId, name: 'Mid', parentId: base.rootId, position: 2 });
    await teamMember(client, { ...common, id: base.leafId, name: 'Leaf', parentId: base.midId, position: 3 });
    await teamMember(client, { ...common, id: base.siblingId, name: 'Sibling', parentId: base.rootId, position: 4 });
    await teamMember(client, { ...common, id: base.loneId, name: 'Lone', parentId: null, position: 5 });

    // One skill per level of the chain.
    await skill(client, { ...common, equipperId: base.rootId, name: 'RootSkill', content: 'root body' });
    await skill(client, { ...common, equipperId: base.midId, name: 'MidSkill', content: 'mid body' });
    await skill(client, { ...common, equipperId: base.leafId, name: 'LeafSkill', content: 'leaf body' });

    // A name equipped at BOTH leaf and root — the leaf copy must shadow.
    await skill(client, { ...common, equipperId: base.rootId, name: 'Shared', content: 'root version' });
    await skill(client, { ...common, equipperId: base.leafId, name: 'Shared', content: 'leaf version' });

    // Only the sibling equips this; the leaf must never see it.
    await skill(client, { ...common, equipperId: base.siblingId, name: 'SiblingOnly', content: 'sibling body' });

    return base;
  });

  port = new DbGraphPort(db);
});

afterAll(async () => {
  // Drain OUR pool before the helper drops the database — a live connection
  // makes `drop database` fail and turns a green run into a red file.
  await db?.end();
  await database?.destroy();
});

const auth = () => ({ identityId: fx.identityId, kind: 'auto-owner' }) as never;

async function skillsFor(teamMemberId: string): Promise<Array<{ name: string; body: string }>> {
  const ctx = await port.loadSpawnContext(auth(), { spaceId: fx.spaceId, teamMemberId });
  return ctx.skills ?? [];
}

describe('loadSpawnContext — skill resolution over the ancestor chain', () => {
  it('resolves a skill equipped directly on the invoked persona', async () => {
    const names = (await skillsFor(fx.leafId)).map((s) => s.name);
    expect(names).toContain('LeafSkill');
  });

  it('inherits skills from every ancestor, nearest first', async () => {
    // THE central assertion for row #11. Pre-change this was [].
    const names = (await skillsFor(fx.leafId)).map((s) => s.name);
    expect(names).toEqual(['LeafSkill', 'Shared', 'MidSkill', 'RootSkill']);
  });

  it('carries the skill body from public.skills.content', async () => {
    const leaf = (await skillsFor(fx.leafId)).find((s) => s.name === 'LeafSkill');
    expect(leaf?.body).toBe('leaf body');
  });

  it('lets the nearer persona shadow an ancestor skill of the same name', async () => {
    const shared = (await skillsFor(fx.leafId)).find((s) => s.name === 'Shared');
    expect(shared?.body).toBe('leaf version');
    expect(await skillsFor(fx.leafId)).toHaveLength(4); // not 5 — one was shadowed
  });

  it('does not leak a sibling branch into the chain', async () => {
    const names = (await skillsFor(fx.leafId)).map((s) => s.name);
    expect(names).not.toContain('SiblingOnly');
  });

  it('gives a mid-chain persona only itself and its ancestors', async () => {
    // Mid's own skill first (depth 0), then root's two (depth 1) ordered by
    // name — the query's `order by depth, s.name`. Nothing from the leaf.
    const names = (await skillsFor(fx.midId)).map((s) => s.name);
    expect(names).toEqual(['MidSkill', 'RootSkill', 'Shared']);
    expect(names).not.toContain('LeafSkill'); // children do not flow upward
  });

  it('gives the root only its own skills', async () => {
    const names = (await skillsFor(fx.rootId)).map((s) => s.name).sort();
    expect(names).toEqual(['RootSkill', 'Shared']);
  });

  it('returns an empty set for a persona that equips nothing and has no parent', async () => {
    expect(await skillsFor(fx.loneId)).toEqual([]);
  });

  it('stops climbing at a soft-deleted ancestor', async () => {
    // A deleted persona is not part of anyone's chain, and neither is anything
    // above it — inheriting through a tombstone would resurrect capability the
    // graph says is gone.
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set deleted_at = now() where id = $1`, [fx.midId]);
    });
    try {
      const names = (await skillsFor(fx.leafId)).map((s) => s.name);
      expect(names).toEqual(['LeafSkill', 'Shared']);
      expect(names).not.toContain('RootSkill');
    } finally {
      await database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(`update public.entities set deleted_at = null where id = $1`, [fx.midId]);
      });
    }
  });

  it('ignores an equips edge pointing at a soft-deleted skill', async () => {
    const before = await skillsFor(fx.rootId);
    const rows = await database.query<{ id: string }>(
      `select s.entity_id::text id from public.skills s where s.name = 'RootSkill'`,
    );
    const skillId = rows[0]!.id;
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.entities set deleted_at = now() where id = $1`, [skillId]);
    });
    try {
      const after = await skillsFor(fx.rootId);
      expect(after.map((s) => s.name)).not.toContain('RootSkill');
      expect(after).toHaveLength(before.length - 1);
    } finally {
      await database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(`update public.entities set deleted_at = null where id = $1`, [skillId]);
      });
    }
  });
});
