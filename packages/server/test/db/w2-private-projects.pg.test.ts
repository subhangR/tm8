// =============================================================================
// 078 — per-user PRIVATE Projects, proved through the ROLE THAT ACTUALLY READS.
//
// WHY THIS FILE EXISTS SEPARATELY FROM w2-projects.pg.test.ts. That suite seeds
// and then reads back as `tm8_graph_owner`. The graph owner owns every table in
// `public`, and a table owner is exempt from its own row-level security unless
// the table is FORCE'd — which none of them are. So every "is this row visible"
// assertion in that file is answered by a role for which the policies do not
// run at all. It is a real suite and it proves real things about materializing
// and relinking, but it cannot prove anything whatsoever about who may SEE a
// projection, because the reader it uses can always see everything.
//
// Every read below therefore goes through `asApp`, which does what
// `db/client.ts` does in production: `set local role tm8_app`, then bind
// `tm8.identity_id` as a transaction-local claim. That is the role the
// `entities_select` and `projects_select` policies are written `to`, and it is
// the only role whose answer to "can B see A's private project" means anything.
//
// THE TWO-PREDICATE ASSERTION. The `kind='project'` carve-out is duplicated in
// `internal.entity_row_visible` (the row policy, 070) and
// `internal.entity_readable` (the satellite predicate, 021). Migration 070
// exists because those two once disagreed. So the tests below do not check them
// one at a time: for each subject they assert the direct `entities` read and
// `internal.entity_readable()` give the SAME answer on the SAME row. A future
// edit to one and not the other is a red here, not a support ticket.
// =============================================================================
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

import type { PoolClient } from 'pg';

interface Fixture {
  adminIdentity: string;
  ownerIdentity: string;
  otherIdentity: string;
  outsiderIdentity: string;
  adminAccount: string;
  ownerAccount: string;
  otherAccount: string;
  spaceId: string;
  otherSpaceId: string;
  adminMember: string;
  ownerMember: string;
  otherMember: string;
  outsiderMember: string;
}

interface ProjectRow {
  id: string;
  name: string;
  working_dir: string;
  trust: string;
  share_mode: 'private' | 'space';
  owner_account_id: string | null;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/**
 * The production read path: the real `tm8_app` role plus a bound identity
 * claim. NOT the owner role — see this file's header.
 *
 * `nodeAdmin` binds `tm8.node_admin` as well, because `projects_select`'s
 * node-admin branch (008:179, unchanged by 078) reads that CLAIM rather than
 * the `accounts` table — so an admin who is merely an admin in the database,
 * with no claim bound, is correctly not one here. The server binds it in
 * `db/client.ts`; a test that never binds it would be quietly asserting the
 * branch does not exist.
 */
async function asApp<T>(
  identityId: string,
  fn: (client: PoolClient) => Promise<T>,
  options: { nodeAdmin?: boolean } = {},
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id', $1, true)`, [identityId]);
    if (options.nodeAdmin) {
      await client.query(`select set_config('tm8.node_admin', 'true', true)`);
    }
    return fn(client);
  });
}

/** Privileged seeding/inspection. Never used to answer a visibility question. */
async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/**
 * Both halves of the read seam for one entity, as one subject sees it.
 * `entity` is the row policy (`internal.entity_row_visible`); `readable` is
 * `internal.entity_readable`. They must never disagree.
 */
async function seenBy(
  identityId: string,
  entityId: string,
  options: { nodeAdmin?: boolean } = {},
): Promise<{ entity: boolean; readable: boolean }> {
  return asApp(identityId, async (client) => {
    const rows = await client.query<{ id: string }>(
      `select id from public.entities where id = $1`,
      [entityId],
    );
    const readable = await client.query<{ readable: boolean }>(
      `select internal.entity_readable($1) readable`,
      [entityId],
    );
    return { entity: rows.rowCount === 1, readable: readable.rows[0]!.readable === true };
  }, options);
}

/** The registry row, as `tm8_app` sees it through `projects_select`. */
async function projectRowVisibleTo(
  identityId: string,
  projectId: string,
  options: { nodeAdmin?: boolean } = {},
): Promise<boolean> {
  return asApp(identityId, async (client) => {
    const rows = await client.query(`select id from public.projects where id = $1`, [projectId]);
    return rows.rowCount === 1;
  }, options);
}

/** The registry row id for a seeded workingDir, read privileged. */
async function projectIdByDir(workingDir: string): Promise<string> {
  return asOwner(async (client) => {
    const rows = await client.query<{ id: string }>(
      `select id from public.projects where working_dir = $1`,
      [workingDir],
    );
    return rows.rows[0]!.id;
  });
}

async function projectionOf(projectId: string, spaceId: string): Promise<string | null> {
  return asOwner(async (client) => {
    const rows = await client.query<{ project_entity_id: string }>(
      `select project_entity_id from public.project_links
        where project_id = $1 and space_id = $2`,
      [projectId, spaceId],
    );
    return rows.rows[0]?.project_entity_id ?? null;
  });
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const ids = (await client.query<Fixture>(
      `select 'pp-admin'::text "adminIdentity",
              'pp-owner'::text "ownerIdentity",
              'pp-other'::text "otherIdentity",
              'pp-outsider'::text "outsiderIdentity",
              internal.new_id()::text "adminAccount",
              internal.new_id()::text "ownerAccount",
              internal.new_id()::text "otherAccount",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "otherSpaceId",
              internal.new_id()::text "adminMember",
              internal.new_id()::text "ownerMember",
              internal.new_id()::text "otherMember",
              internal.new_id()::text "outsiderMember"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'PP Admin'), ($2, 'PP Owner'), ($3, 'PP Other'), ($4, 'PP Outsider')`,
      [ids.adminIdentity, ids.ownerIdentity, ids.otherIdentity, ids.outsiderIdentity],
    );
    await client.query(
      `insert into public.accounts(id, identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, $4, 'pp-admin', 'PP Admin', true, true),
              ($2, $5, 'pp-owner', 'PP Owner', false, false),
              ($3, $6, 'pp-other', 'PP Other', false, false)`,
      [
        ids.adminAccount, ids.ownerAccount, ids.otherAccount,
        ids.adminIdentity, ids.ownerIdentity, ids.otherIdentity,
      ],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'PP shared space', $3), ($2, 'PP unrelated space', $3)`,
      [ids.spaceId, ids.otherSpaceId, ids.adminIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1, $5, 'member', 0, $1),
              ($2, $5, 'member', 1, $2),
              ($3, $5, 'member', 2, $3),
              ($4, $6, 'member', 0, $4)`,
      [
        ids.adminMember, ids.ownerMember, ids.otherMember, ids.outsiderMember,
        ids.spaceId, ids.otherSpaceId,
      ],
    );
    // `otherMember` is deliberately a SPACE ADMIN. The privacy claim under test
    // is not "other members cannot see it" but "nobody else can, admins
    // included" — so the second subject is the strongest one available.
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $5, $7,  'owner',  'PP Admin'),
              ($2, $5, $8,  'member', 'PP Owner'),
              ($3, $5, $9,  'admin',  'PP Other'),
              ($4, $6, $10, 'owner',  'PP Outsider')`,
      [
        ids.adminMember, ids.ownerMember, ids.otherMember, ids.outsiderMember,
        ids.spaceId, ids.otherSpaceId,
        ids.adminIdentity, ids.ownerIdentity, ids.otherIdentity, ids.outsiderIdentity,
      ],
    );
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('private_projects');
  database.apply(migrationFiles());
  fixture = await seed();
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('078 · per-user private Projects', () => {
  it('a member creates a private Project in their own name, and it is theirs', async () => {
    const created = await asApp(fixture.ownerIdentity, async (client) => {
      const result = await client.query<{ result: { project: ProjectRow } }>(
        `select public.create_owned_project(
           'Owner private', '/tmp/pp-owner-private', null, 'untrusted', '{}'::jsonb,
           'private', null, $1, $2
         ) result`,
        [fixture.spaceId, `pp-create-${randomUUID()}`],
      );
      return result.rows[0]!.result.project;
    });

    expect(created.share_mode).toBe('private');
    expect(created.owner_account_id).toBe(fixture.ownerAccount);
    // The relaxation is genuine: this caller is not a node admin, and the
    // pre-078 `create_project` would have refused them outright.
    expect(created.trust).toBe('untrusted');
    expect(created.working_dir).toBe('/tmp/pp-owner-private');
  });

  it('the owner sees their own private Project — projection and registry row', async () => {
    const projectId = await projectIdByDir('/tmp/pp-owner-private');
    const projection = await projectionOf(projectId, fixture.spaceId);
    expect(projection, 'linking in create_owned_project must materialize a projection').not.toBeNull();

    expect(await seenBy(fixture.ownerIdentity, projection!)).toEqual({
      entity: true,
      readable: true,
    });
    expect(await projectRowVisibleTo(fixture.ownerIdentity, projectId)).toBe(true);
  });

  it('a second member of the SAME space — a space ADMIN — does not see it', async () => {
    const projectId = await projectIdByDir('/tmp/pp-owner-private');
    const projection = (await projectionOf(projectId, fixture.spaceId))!;

    // Both halves of the seam, and both must be false. If only one is, the two
    // predicates have drifted apart again — the exact defect 070 was written for.
    expect(await seenBy(fixture.otherIdentity, projection)).toEqual({
      entity: false,
      readable: false,
    });
    // ...and the registry row is not a side door onto the same information.
    expect(await projectRowVisibleTo(fixture.otherIdentity, projectId)).toBe(false);

    // The node admin keeps the REGISTRY row (documented, deliberate) but NOT the
    // Space projection: privacy is enforced on the graph seam without pretending
    // the machine's administrator cannot read the machine's own paths. Note the
    // second assertion binds the node-admin claim and still comes back hidden —
    // `entity_row_visible` has no node-admin branch at all, by design.
    expect(await projectRowVisibleTo(fixture.adminIdentity, projectId, { nodeAdmin: true }))
      .toBe(true);
    expect(await seenBy(fixture.adminIdentity, projection, { nodeAdmin: true })).toEqual({
      entity: false,
      readable: false,
    });
    // And without the claim the admin is just another member of this Space: the
    // registry branch is claim-driven, so nothing leaks to an unelevated session.
    expect(await projectRowVisibleTo(fixture.adminIdentity, projectId)).toBe(false);
  });

  it('a shared Project is still visible to both members — nothing regressed', async () => {
    const shared = await asApp(fixture.adminIdentity, async (client) => {
      const result = await client.query<{ result: { project: ProjectRow } }>(
        `select public.create_project(
           'Team shared', '/tmp/pp-shared', null, 'untrusted', '{}'::jsonb, $1
         ) result`,
        [`pp-shared-create-${randomUUID()}`],
      );
      const project = result.rows[0]!.result.project;
      await client.query(`select public.link_project_w2($1, $2, null, $3)`, [
        fixture.spaceId,
        project.id,
        `pp-shared-link-${randomUUID()}`,
      ]);
      return project;
    });

    // Untouched by 078: no owner, and the backfilled default share mode.
    expect(shared.owner_account_id).toBeNull();
    expect(shared.share_mode).toBe('space');

    const projection = (await projectionOf(shared.id, fixture.spaceId))!;
    for (const identity of [fixture.ownerIdentity, fixture.otherIdentity]) {
      expect(await seenBy(identity, projection), `visible to ${identity}`).toEqual({
        entity: true,
        readable: true,
      });
      expect(await projectRowVisibleTo(identity, shared.id)).toBe(true);
    }
    // Membership still bounds everything: a shared project is shared with the
    // linked SPACE, not with the node.
    expect(await seenBy(fixture.outsiderIdentity, projection)).toEqual({
      entity: false,
      readable: false,
    });
  });

  it('a member cannot create a Project owned by somebody else', async () => {
    await expect(
      asApp(fixture.ownerIdentity, (client) =>
        client.query(
          `select public.create_owned_project(
             'Impersonated', '/tmp/pp-impersonated', null, 'untrusted', '{}'::jsonb,
             'private', $1, $2, $3
           )`,
          [fixture.otherAccount, fixture.spaceId, `pp-impersonate-${randomUUID()}`],
        )),
    ).rejects.toThrow(/caller's own name/);

    // The refusal is total, not a silent substitution to the caller's own
    // account: no row was written under either name.
    const written = await asOwner(async (client) => (
      await client.query(`select 1 from public.projects where working_dir = '/tmp/pp-impersonated'`)
    ).rowCount);
    expect(written).toBe(0);
  });

  it('a member cannot create a SHARED or a TRUSTED Project', async () => {
    await expect(
      asApp(fixture.ownerIdentity, (client) =>
        client.query(
          `select public.create_owned_project(
             'Sneaky share', '/tmp/pp-sneaky', null, 'untrusted', '{}'::jsonb,
             'space', null, $1, $2
           )`,
          [fixture.spaceId, `pp-sneaky-${randomUUID()}`],
        )),
    ).rejects.toThrow(/node admin/);

    await expect(
      asApp(fixture.ownerIdentity, (client) =>
        client.query(
          `select public.create_owned_project(
             'Self trusted', '/tmp/pp-self-trusted', null, 'trusted', '{}'::jsonb,
             'private', null, $1, $2
           )`,
          [fixture.spaceId, `pp-trust-${randomUUID()}`],
        )),
    ).rejects.toThrow(/trust is a node-admin grant/);
  });

  it('workingDir shape is refused as a typed error, but the ROOT is not this layer\'s business', async () => {
    await expect(
      asApp(fixture.ownerIdentity, (client) =>
        client.query(
          `select public.create_owned_project(
             'Relative', 'tmp/relative', null, 'untrusted', '{}'::jsonb, 'private', null, $1, $2
           )`,
          [fixture.spaceId, `pp-relative-${randomUUID()}`],
        )),
    ).rejects.toThrow(/absolute path/);

    await expect(
      asApp(fixture.ownerIdentity, (client) =>
        client.query(
          `select public.create_owned_project(
             'Traversal', '/tmp/../etc', null, 'untrusted', '{}'::jsonb, 'private', null, $1, $2
           )`,
          [fixture.spaceId, `pp-traversal-${randomUUID()}`],
        )),
    ).rejects.toThrow(/absolute path/);
  });

  it('the owner can edit their private Project; the space admin cannot', async () => {
    const projectId = await projectIdByDir('/tmp/pp-owner-private');

    const edited = await asApp(fixture.ownerIdentity, async (client) => {
      const result = await client.query<{ result: { project: ProjectRow } }>(
        `select public.update_owned_project($1, $2::jsonb, $3) result`,
        [projectId, JSON.stringify({ name: 'Owner private, renamed' }), `pp-edit-${randomUUID()}`],
      );
      return result.rows[0]!.result.project;
    });
    expect(edited.name).toBe('Owner private, renamed');
    expect(edited.share_mode).toBe('private');

    // The other member is a space ADMIN and is still refused — and is refused
    // with `not found`, because a distinguishable "not yours" would confirm the
    // row exists to somebody with no right to know that.
    await expect(
      asApp(fixture.otherIdentity, (client) =>
        client.query(`select public.update_owned_project($1, $2::jsonb, $3)`, [
          projectId,
          JSON.stringify({ name: 'Taken over' }),
          `pp-steal-${randomUUID()}`,
        ])),
    ).rejects.toThrow(/not found/i);

    // Nor may the owner promote their own project's trust.
    await expect(
      asApp(fixture.ownerIdentity, (client) =>
        client.query(`select public.update_owned_project($1, $2::jsonb, $3)`, [
          projectId,
          JSON.stringify({ trust: 'trusted' }),
          `pp-self-trust-${randomUUID()}`,
        ])),
    ).rejects.toThrow(/trust is a node-admin grant/);
  });

  it('publishing to the Space, and withdrawing again, is the owner\'s call and flips visibility', async () => {
    const projectId = await projectIdByDir('/tmp/pp-owner-private');
    const projection = (await projectionOf(projectId, fixture.spaceId))!;

    await asApp(fixture.ownerIdentity, (client) =>
      client.query(`select public.update_owned_project($1, $2::jsonb, $3)`, [
        projectId,
        JSON.stringify({ shareMode: 'space' }),
        `pp-publish-${randomUUID()}`,
      ]));
    // No relink, no rematerialization: the predicates read `share_mode` live,
    // which is exactly why privacy could not live on `entities.visibility` (021
    // re-asserts 'restricted' on every relink).
    expect(await seenBy(fixture.otherIdentity, projection)).toEqual({
      entity: true,
      readable: true,
    });

    await asApp(fixture.ownerIdentity, (client) =>
      client.query(`select public.update_owned_project($1, $2::jsonb, $3)`, [
        projectId,
        JSON.stringify({ shareMode: 'private' }),
        `pp-withdraw-${randomUUID()}`,
      ]));
    expect(await seenBy(fixture.otherIdentity, projection)).toEqual({
      entity: false,
      readable: false,
    });
    expect(await seenBy(fixture.ownerIdentity, projection)).toEqual({
      entity: true,
      readable: true,
    });
  });

  it('every pre-078 Project row was backfilled to the shape that keeps it visible', async () => {
    const rows = await asOwner(async (client) => (
      await client.query<{ share_mode: string; owner_account_id: string | null }>(
        `select share_mode, owner_account_id from public.projects where working_dir = '/tmp/pp-shared'`,
      )
    ).rows);
    expect(rows).toEqual([{ share_mode: 'space', owner_account_id: null }]);

    // And the schema refuses the one row shape that would be invisible to
    // everybody, its author included.
    await expect(
      asOwner((client) =>
        client.query(
          `insert into public.projects(name, working_dir, share_mode)
           values ('Ownerless private', '/tmp/pp-ownerless', 'private')`,
        )),
    ).rejects.toThrow(/projects_private_needs_owner/);
  });
});
