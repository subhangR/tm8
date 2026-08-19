/**
 * `internal.entity_row_visible` and `internal.entity_readable` admit exactly
 * what they admitted before 159.
 *
 * 159 stopped both functions calling `internal.is_space_member`, inlining that
 * function's membership `exists` into each body instead. That is a ~5.3x and
 * ~3.9x win on prod-sized data, and it is also the read-authorization path for
 * the whole product: `entity_row_visible` IS the `entities_select` policy body
 * and `entity_readable` IS the SELECT policy body on 38 tables. A mistake here
 * is a disclosure bug with no user-visible symptom.
 *
 * Equivalence was verified empirically before the change landed — 507 864
 * old-vs-new comparisons on prod data across four identity classes, plus
 * row-count equality on `entities` and `messages` for all 9 member identities
 * and all 5 spaces. This file exists so the guards survive the NEXT edit, and
 * it targets the conjuncts a re-flattening could plausibly drop rather than
 * re-testing the happy path the existing suites already cover.
 *
 * Every assertion is a red/green pair. A test that only asserts "the hidden
 * thing is hidden" passes just as well against a predicate that returns false
 * for everything, so each case also asserts the visible sibling it must not
 * affect.
 *
 * 1. MEMBERSHIP is what 159 actually moved, so it is tested from both sides:
 *    a member of another space, and an identity that is set but belongs to no
 *    space at all, must see nothing — while the real member still sees the
 *    same rows.
 *
 * 2. THE PARENTHESES. This is the one real trap in 159. The shipped shape is
 *    `member and (visibility = 'space' or carve-out)`. Inlining replaces
 *    `member` with a two-term conjunction, and a rewrite that loses a bracket
 *    yields `identity is not null and (exists(member) and vis = 'space' or
 *    carve-out)` — which is not a syntax error, is not caught by any
 *    member-visible test, and hands every restricted project to every
 *    NON-member in the database. `nonMemberCannotSeeRestrictedProject` is that
 *    assertion, and it is the reason this file exists.
 *
 * 3. THE CARVE-OUT survives, in both directions: a restricted `project` is
 *    visible while its space link is active and hidden once it is not. A
 *    rewrite that dropped the carve-out entirely would still satisfy a test
 *    that only checked that restricted rows are hidden.
 *
 * 4. THE ASYMMETRY between the two functions is deliberate and load-bearing:
 *    `entity_readable` filters `deleted_at is null`, `entity_row_visible` does
 *    NOT (070 explains why — `deleted:"only"` listings must keep working). A
 *    refactor that "harmonised" the pair would break one of them, so both
 *    halves are pinned.
 */
import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/** Member of the space under test. */
const MEMBER_IDENTITY = 'rls-guard-member';
/** A real, valid identity — but a member of a DIFFERENT space. */
const OUTSIDER_IDENTITY = 'rls-guard-outsider';
/** A real identity that belongs to no space at all. */
const STRANGER_IDENTITY = 'rls-guard-stranger';

interface Fixture {
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  outsiderMemberId: string;
  openDocId: string;
  restrictedDocId: string;
  deletedDocId: string;
  projectEntityId: string;
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
 * Both predicates are SECURITY DEFINER and resolve the member from
 * `tm8.identity_id` rather than from a parameter, so the identity is the whole
 * input. `identity === null` leaves the claim UNSET, which is a distinct case
 * from "set to an identity nobody has".
 */
async function asIdentity<T>(
  identity: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    if (identity !== null) {
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [identity]);
    }
    await client.query(
      `select set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'rls-predicate-guards-pg', true)`,
    );
    return fn(client);
  });
}

/** `internal.entity_row_visible` — the `entities_select` policy body, verbatim. */
async function rowVisible(
  identity: string | null,
  args: { id: string | null; spaceId: string | null; kind: string | null; visibility: string | null },
): Promise<boolean | null> {
  return asIdentity(identity, async (client) => {
    const rows = await client.query<{ visible: boolean | null }>(
      'select internal.entity_row_visible($1, $2, $3, $4) as visible',
      [args.id, args.spaceId, args.kind, args.visibility],
    );
    return rows.rows[0]!.visible;
  });
}

/** `internal.entity_readable` — the SELECT policy body on 38 tables. */
async function readable(identity: string | null, target: string | null): Promise<boolean | null> {
  return asIdentity(identity, async (client) => {
    const rows = await client.query<{ readable: boolean | null }>(
      'select internal.entity_readable($1) as readable',
      [target],
    );
    return rows.rows[0]!.readable;
  });
}

/** The predicate as the product actually meets it: through the live policy. */
async function visibleEntityIds(identity: string | null): Promise<string[]> {
  return asIdentity(identity, async (client) => {
    const rows = await client.query<{ id: string }>(
      'select id from public.entities where space_id = $1 order by id',
      [fixture.spaceId],
    );
    return rows.rows.map((r) => r.id);
  });
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const ids = (await client.query<{
      space_id: string;
      other_space_id: string;
      member_id: string;
      outsider_member_id: string;
      open_doc_id: string;
      restricted_doc_id: string;
      deleted_doc_id: string;
    }>(
      `select internal.new_id() space_id, internal.new_id() other_space_id,
              internal.new_id() member_id, internal.new_id() outsider_member_id,
              internal.new_id() open_doc_id, internal.new_id() restricted_doc_id,
              internal.new_id() deleted_doc_id`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Guard member'), ($2, 'Guard outsider'), ($3, 'Guard stranger')`,
      [MEMBER_IDENTITY, OUTSIDER_IDENTITY, STRANGER_IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'RLS guards', $3), ($2, 'RLS guards elsewhere', $4)`,
      [ids.space_id, ids.other_space_id, MEMBER_IDENTITY, OUTSIDER_IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $3, 'member', 0, $1), ($2, $4, 'member', 0, $2)`,
      [ids.member_id, ids.outsider_member_id, ids.space_id, ids.other_space_id],
    );
    // The outsider is a member of `other_space_id` and NOTHING else. The
    // stranger gets no `members` row at all.
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $3, $5, 'owner', 'Guard member'), ($2, $4, $6, 'owner', 'Guard outsider')`,
      [
        ids.member_id,
        ids.outsider_member_id,
        ids.space_id,
        ids.other_space_id,
        MEMBER_IDENTITY,
        OUTSIDER_IDENTITY,
      ],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, visibility, created_by) values
       ($1, $4, 'doc', 10, 'space',      $5),
       ($2, $4, 'doc', 11, 'restricted', $5),
       ($3, $4, 'doc', 12, 'space',      $5)`,
      [
        ids.open_doc_id,
        ids.restricted_doc_id,
        ids.deleted_doc_id,
        ids.space_id,
        ids.member_id,
      ],
    );
    await client.query(
      `insert into public.documents(entity_id, title, body, format) values
       ($1, 'open', '', 'markdown'), ($2, 'restricted', '', 'markdown'),
       ($3, 'deleted', '', 'markdown')`,
      [ids.open_doc_id, ids.restricted_doc_id, ids.deleted_doc_id],
    );
    await client.query(`update public.entities set deleted_at = now() where id = $1`, [
      ids.deleted_doc_id,
    ]);

    // Linking a project IS the public way to mint a `project` projection —
    // inserting the entity directly is refused by
    // `entities_project_lifecycle_guard`. The materializer creates it
    // `restricted`, so it is reachable ONLY through the carve-out.
    const projectId = (await client.query<{ id: string }>('select internal.new_id() id')).rows[0]!.id;
    await client.query(
      `insert into public.projects(id, name, working_dir) values ($1, 'rls-guard-project', $2)`,
      [projectId, `/tmp/rls-guard-${randomUUID()}`],
    );
    await client.query(`insert into public.space_projects(space_id, project_id) values ($1, $2)`, [
      ids.space_id,
      projectId,
    ]);
    const projectEntityId = (await client.query<{ project_entity_id: string }>(
      `select project_entity_id from public.project_links
        where space_id = $1 and project_id = $2`,
      [ids.space_id, projectId],
    )).rows[0]!.project_entity_id;

    return {
      spaceId: ids.space_id,
      otherSpaceId: ids.other_space_id,
      memberId: ids.member_id,
      outsiderMemberId: ids.outsider_member_id,
      openDocId: ids.open_doc_id,
      restrictedDocId: ids.restricted_doc_id,
      deletedDocId: ids.deleted_doc_id,
      projectEntityId,
    };
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('rls_predicate_guards');
  database.apply(migrationFiles());
  fixture = await seed();
});

afterAll(async () => {
  await database?.destroy();
});

describe('membership — the conjunct 159 actually moved', () => {
  it('admits the member, and the same call denies a member of another space', async () => {
    const args = {
      id: fixture.openDocId,
      spaceId: fixture.spaceId,
      kind: 'doc',
      visibility: 'space',
    };
    // GREEN half: without this, every assertion below would pass against a
    // predicate that had simply stopped returning true.
    expect(await rowVisible(MEMBER_IDENTITY, args)).toBe(true);
    expect(await rowVisible(OUTSIDER_IDENTITY, args)).toBe(false);
    expect(await rowVisible(STRANGER_IDENTITY, args)).toBe(false);
  });

  it('denies an UNSET identity, without ever returning NULL', async () => {
    // `exists` never yields NULL and `identity_id() is not null` guards the
    // rest, so an unset claim is false — not NULL, which a policy would treat
    // as deny but which would mean the two halves had stopped agreeing.
    expect(
      await rowVisible(null, {
        id: fixture.openDocId,
        spaceId: fixture.spaceId,
        kind: 'doc',
        visibility: 'space',
      }),
    ).toBe(false);
    expect(await readable(null, fixture.openDocId)).toBe(false);
  });

  it('is false, never NULL, for NULL arguments', async () => {
    expect(
      await rowVisible(MEMBER_IDENTITY, {
        id: null,
        spaceId: null,
        kind: null,
        visibility: null,
      }),
    ).toBe(false);
    expect(await readable(MEMBER_IDENTITY, null)).toBe(false);
  });

  it('scopes the member to their OWN space, not to membership in general', async () => {
    // A flattening that inlined `exists (select 1 from members where
    // identity_id = …)` and lost the `space_id` correlation would say true
    // here for every space in the database.
    expect(
      await rowVisible(MEMBER_IDENTITY, {
        id: fixture.openDocId,
        spaceId: fixture.otherSpaceId,
        kind: 'doc',
        visibility: 'space',
      }),
    ).toBe(false);
    expect(
      await rowVisible(OUTSIDER_IDENTITY, {
        id: fixture.openDocId,
        spaceId: fixture.otherSpaceId,
        kind: 'doc',
        visibility: 'space',
      }),
    ).toBe(true);
  });
});

describe('the restricted / project carve-out', () => {
  it('admits a restricted project while its space link is active', async () => {
    // The materializer created this `restricted`, so it is visible ONLY
    // through the carve-out. If the carve-out were dropped, this is false.
    expect(await rowVisible(MEMBER_IDENTITY, {
      id: fixture.projectEntityId,
      spaceId: fixture.spaceId,
      kind: 'project',
      visibility: 'restricted',
    })).toBe(true);
    expect(await readable(MEMBER_IDENTITY, fixture.projectEntityId)).toBe(true);
  });

  it('denies a restricted non-project, and a project whose id is not linked', async () => {
    // The plain-deny half: `restricted` is not a synonym for visible, and the
    // carve-out is a live join rather than a rubber stamp on `kind='project'`.
    expect(await rowVisible(MEMBER_IDENTITY, {
      id: fixture.restrictedDocId,
      spaceId: fixture.spaceId,
      kind: 'doc',
      visibility: 'restricted',
    })).toBe(false);
    expect(await rowVisible(MEMBER_IDENTITY, {
      id: fixture.openDocId,
      spaceId: fixture.spaceId,
      kind: 'project',
      visibility: 'restricted',
    })).toBe(false);
    expect(await readable(MEMBER_IDENTITY, fixture.restrictedDocId)).toBe(false);
  });

  it('NEVER shows a linked restricted project to a NON-member', async () => {
    // THE 159 TRAP, and the reason this file exists. The shipped shape is
    // `member and (vis = 'space' or carve-out)`. Inlining `member` as a
    // two-term conjunction and losing one bracket gives
    // `identity is not null and (exists(member) and vis = 'space' or carve-out)`,
    // where `and` binds tighter than `or` — so the carve-out escapes the
    // membership check entirely and every restricted project in the database
    // becomes readable by anyone holding any identity at all. That is a silent
    // cross-space disclosure, and no member-visible assertion can see it.
    const args = {
      id: fixture.projectEntityId,
      spaceId: fixture.spaceId,
      kind: 'project',
      visibility: 'restricted',
    };
    expect(await rowVisible(OUTSIDER_IDENTITY, args)).toBe(false);
    expect(await rowVisible(STRANGER_IDENTITY, args)).toBe(false);
    expect(await rowVisible(null, args)).toBe(false);
    expect(await readable(OUTSIDER_IDENTITY, fixture.projectEntityId)).toBe(false);
    expect(await readable(STRANGER_IDENTITY, fixture.projectEntityId)).toBe(false);
  });

  it('hides that project once the space link is gone but the row lives on', async () => {
    await asOwner(async (client) => {
      await client.query(`delete from public.space_projects where space_id = $1`, [
        fixture.spaceId,
      ]);
      // Unlinking soft-deletes the projection, which would hide it via
      // `deleted_at` and prove nothing about the carve-out. Revive it, leaving
      // exactly one difference from the test above: no active space link.
      await client.query(`select internal.w1_set_writer('project_materializer')`);
      await client.query(
        `update public.entities set deleted_at = null where id = $1`,
        [fixture.projectEntityId],
      );
      await client.query(`select internal.w1_set_writer(null)`);
    });
    expect(await rowVisible(MEMBER_IDENTITY, {
      id: fixture.projectEntityId,
      spaceId: fixture.spaceId,
      kind: 'project',
      visibility: 'restricted',
    })).toBe(false);
    // Scoped: the space-visible doc is unmoved by any of the above.
    expect(await rowVisible(MEMBER_IDENTITY, {
      id: fixture.openDocId,
      spaceId: fixture.spaceId,
      kind: 'doc',
      visibility: 'space',
    })).toBe(true);
  });
});

describe('the two predicates disagree on tombstones, deliberately', () => {
  it('entity_readable EXCLUDES a deleted entity that is otherwise visible', async () => {
    expect(await readable(MEMBER_IDENTITY, fixture.openDocId)).toBe(true);
    // 021's `deleted_at is null`. Dropping it would admit tombstones to all 38
    // tables whose SELECT policy is this function.
    expect(await readable(MEMBER_IDENTITY, fixture.deletedDocId)).toBe(false);
  });

  it('entity_row_visible INCLUDES it — 070 omits the filter on purpose', async () => {
    // `deleted:"only"` listings read `public.entities` through this policy, so
    // a refactor that harmonised the pair would break tombstone presentation.
    const args = {
      id: fixture.deletedDocId,
      spaceId: fixture.spaceId,
      kind: 'doc',
      visibility: 'space',
    };
    expect(await rowVisible(MEMBER_IDENTITY, args)).toBe(true);
    // …but only for a member. The asymmetry is about `deleted_at`, nothing else.
    expect(await rowVisible(OUTSIDER_IDENTITY, args)).toBe(false);
  });
});

describe('through the live entities_select policy, not just the function', () => {
  it('shows the member exactly the rows the predicate admits', async () => {
    const visible = await visibleEntityIds(MEMBER_IDENTITY);
    // Space-visible docs, including the tombstone, and the member row itself.
    expect(visible).toContain(fixture.openDocId);
    expect(visible).toContain(fixture.deletedDocId);
    expect(visible).toContain(fixture.memberId);
    // Restricted and no longer carved out.
    expect(visible).not.toContain(fixture.restrictedDocId);
    expect(visible).not.toContain(fixture.projectEntityId);
  });

  it('shows a non-member nothing at all in that space', async () => {
    expect(await visibleEntityIds(OUTSIDER_IDENTITY)).toEqual([]);
    expect(await visibleEntityIds(STRANGER_IDENTITY)).toEqual([]);
    expect(await visibleEntityIds(null)).toEqual([]);
  });
});
