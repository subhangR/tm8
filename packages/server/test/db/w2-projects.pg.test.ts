import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

const BASELINE = Array.from({ length: 15 }, (_, index) => `${String(index + 1).padStart(3, '0')}_`);

function explicitMigrations(): string[] {
  const files = migrationFiles();
  return [
    ...BASELINE.map((prefix) => {
      const file = files.find((candidate) => candidate.startsWith(prefix));
      if (!file) throw new Error(`missing baseline migration ${prefix}`);
      return file;
    }),
    '021_w2_projects.sql',
  ];
}

interface Fixture {
  ownerIdentity: string;
  memberIdentity: string;
  spaceA: string;
  spaceB: string;
  ownerA: string;
  ownerB: string;
  ordinaryMember: string;
  projectA: string;
  projectB: string;
  conditionalProject: string;
  unmatchedProject: string;
  conditionalSession: string;
  unmatchedSession: string;
  projectionA: string;
  projectionAInB: string;
  projectionB: string;
  conditionalProjection: string;
}

async function seedBeforeG06(database: W1ScratchDatabase): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<Omit<Fixture,
      'projectionA' | 'projectionAInB' | 'projectionB' | 'conditionalProjection'>>(
      `select 'g06-owner'::text "ownerIdentity",
              'g06-member'::text "memberIdentity",
              internal.new_id()::text "spaceA", internal.new_id()::text "spaceB",
              internal.new_id()::text "ownerA", internal.new_id()::text "ownerB",
              internal.new_id()::text "ordinaryMember",
              internal.new_id()::text "projectA", internal.new_id()::text "projectB",
              internal.new_id()::text "conditionalProject", internal.new_id()::text "unmatchedProject",
              internal.new_id()::text "conditionalSession", internal.new_id()::text "unmatchedSession"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'G06 Owner'), ($2, 'G06 Member')`,
      [ids.ownerIdentity, ids.memberIdentity],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'g06-owner', 'G06 Owner', true, true),
              ($2, 'g06-member', 'G06 Member', false, false)`,
      [ids.ownerIdentity, ids.memberIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'G06 A', $3), ($2, 'G06 B', $3)`,
      [ids.spaceA, ids.spaceB, ids.ownerIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($3, $1, 'member', 0, $3), ($4, $2, 'member', 0, $4),
              ($5, $1, 'member', 1, $5)`,
      [ids.spaceA, ids.spaceB, ids.ownerA, ids.ownerB, ids.ordinaryMember],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($4, $1, $3, 'owner', 'G06 Owner A'),
              ($5, $2, $3, 'owner', 'G06 Owner B'),
              ($6, $1, $7, 'member', 'G06 Member')`,
      [ids.spaceA, ids.spaceB, ids.ownerIdentity, ids.ownerA, ids.ownerB, ids.ordinaryMember, ids.memberIdentity],
    );
    await client.query(
      `insert into public.projects(id, name, repo_url, working_dir, trust)
       values ($1, 'Resource A', 'https://example.test/a.git', '/tmp/g06-a', 'trusted'),
              ($2, 'Resource B', null, '/tmp/g06-b', 'trusted'),
              ($3, 'Conditional', null, '/tmp/g06-conditional', 'trusted'),
              ($4, 'Unmatched', null, '/tmp/g06-unmatched', 'trusted')`,
      [ids.projectA, ids.projectB, ids.conditionalProject, ids.unmatchedProject],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id, linked_by)
       values ($1, $3, $5), ($2, $3, $6), ($1, $4, $5)`,
      [ids.spaceA, ids.spaceB, ids.projectA, ids.projectB, ids.ownerA, ids.ownerB],
    );

    // These rows are deliberately legacy-shaped. The conditional Project is
    // linked only after its launch-provenance session exists; the unmatched
    // resource is never linked. Migration 021 may backfill the first only.
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1, $3, 'work_session', 0, $4), ($2, $3, 'work_session', 1, $4)`,
      [ids.conditionalSession, ids.unmatchedSession, ids.spaceA, ids.ownerA],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, project_id, status, share_mode)
       values ($1, 'Conditional legacy', $3, 'exited', 'space'),
              ($2, 'Unmatched legacy', $4, 'exited', 'space')`,
      [ids.conditionalSession, ids.unmatchedSession, ids.conditionalProject, ids.unmatchedProject],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)`,
      [ids.spaceA, ids.conditionalProject, ids.ownerA],
    );

    const projections = (await client.query<{
      project_id: string;
      space_id: string;
      project_entity_id: string;
    }>(
      `select project_id::text, space_id::text, project_entity_id::text
         from public.project_links`,
    )).rows;
    const projection = (space: string, project: string): string =>
      projections.find((row) => row.space_id === space && row.project_id === project)!.project_entity_id;
    return {
      ...ids,
      projectionA: projection(ids.spaceA, ids.projectA),
      projectionAInB: projection(ids.spaceB, ids.projectA),
      projectionB: projection(ids.spaceA, ids.projectB),
      conditionalProjection: projection(ids.spaceA, ids.conditionalProject),
    };
  });
}

async function asApp<T>(
  database: W1ScratchDatabase,
  identity: string,
  nodeAdmin: boolean,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', $2, true),
              set_config('tm8.request_id', 'req-g06-pg', true)`,
      [identity, String(nodeAdmin)],
    );
    return fn(client);
  });
}

async function createLinkedProject(
  database: W1ScratchDatabase,
  fixture: Fixture,
  suffix: string,
): Promise<{ projectId: string; projectionId: string }> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const projectId = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.projects(id, name, working_dir, trust) values ($1, $2, $3, 'trusted')`,
      [projectId, `G06 ${suffix}`, `/tmp/g06-${suffix}`],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id, linked_by) values ($2, $1, $3)`,
      [projectId, fixture.spaceA, fixture.ownerA],
    );
    const projectionId = (await client.query<{ id: string }>(
      `select project_entity_id::text id from public.project_links where space_id = $1 and project_id = $2`,
      [fixture.spaceA, projectId],
    )).rows[0]!.id;
    return { projectId, projectionId };
  });
}

async function createSession(
  database: W1ScratchDatabase,
  fixture: Fixture,
  title: string,
  projectId: string | null = null,
): Promise<string> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by) values ($1, $2, 'work_session', $3)`,
      [id, fixture.spaceA, fixture.ownerA],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, project_id, status, share_mode)
       values ($1, $2, $3, 'running', 'space')`,
      [id, title, projectId],
    );
    return id;
  });
}

describe.sequential('W2.G06 projects and associations PostgreSQL semantics', () => {
  let database: W1ScratchDatabase;
  let fixture: Fixture;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_g06');
    const migrations = explicitMigrations();
    database.apply(migrations.slice(0, 15));
    fixture = await seedBeforeG06(database);
    database.apply(migrations.slice(15));
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('applies exactly after 001-015 with closed grants and materialized projection fields', async () => {
    const functions = await database.query<{ name: string; app_exec: boolean; public_exec: boolean }>(
      `select p.proname name,
              has_function_privilege('tm8_app', p.oid, 'EXECUTE') app_exec,
              has_function_privilege('public', p.oid, 'EXECUTE') public_exec
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('update_project_w2','link_project_w2','unlink_project_w2',
                            'correct_project_association') order by p.proname`,
    );
    expect(functions).toHaveLength(4);
    expect(functions.every((row) => row.app_exec && !row.public_exec)).toBe(true);
    const projection = (await database.query<{
      visibility: string;
      name: string;
      repo_url: string | null;
    }>(
      `select e.visibility, d.name, d.repo_url from public.entities e
       join public.project_projection_details d on d.entity_id = e.id where e.id = $1`,
      [fixture.projectionA],
    ))[0]!;
    expect(projection).toEqual({
      visibility: 'restricted',
      name: 'Resource A',
      repo_url: 'https://example.test/a.git',
    });
  });

  it('conditionally backfills launch provenance only through an active stable mapping and audits skips', async () => {
    const conditional = await database.query<{ count: number; origin: string }>(
      `select count(*)::integer count, max(edge.props->>'origin') origin
         from public.edges edge where edge.src_id = $1 and edge.dst_id = $2 and edge.type = 'in_project'`,
      [fixture.conditionalSession, fixture.conditionalProjection],
    );
    expect(conditional[0]).toEqual({ count: 1, origin: 'backfill' });
    const unmatched = await database.query<{ edges: number; audits: number }>(
      `select (select count(*)::integer from public.edges where src_id = $1 and type = 'in_project') edges,
              (select count(*)::integer from public.workspace_events
                where space_id = $2 and event_type = 'migration.w1.audit'
                  and payload->>'kind' = 'w2_project_launch_unmatched'
                  and payload #>> '{details,workSessionId}' = $1::text) audits`,
      [fixture.unmatchedSession, fixture.spaceA],
    );
    expect(unmatched[0]).toEqual({ edges: 0, audits: 1 });
  });

  it('fans a resource update to every active Space projection and replays without another version', async () => {
    const first = await asApp(database, fixture.ownerIdentity, true, async (client) => (
      await client.query<{ result: { project: { repo_url: string | null; active_link_count: number } } }>(
        `select public.update_project_w2($1, $2::jsonb, $3) result`,
        [fixture.projectA, JSON.stringify({ name: 'Resource A2', repoUrl: null }), 'g06-update-fanout'],
      )
    ).rows[0]!.result);
    expect(first.project).toMatchObject({ repo_url: null, active_link_count: 2 });
    const afterFirst = await database.query<{ id: string; name: string; repo_url: string | null; version: number }>(
      `select e.id::text, d.name, d.repo_url, e.version
         from public.project_projection_details d join public.entities e on e.id = d.entity_id
        where d.project_id = $1 order by e.id`,
      [fixture.projectA],
    );
    expect(afterFirst).toHaveLength(2);
    expect(afterFirst.every((row) => row.name === 'Resource A2' && row.repo_url === null && row.version > 1)).toBe(true);
    await asApp(database, fixture.ownerIdentity, true, (client) =>
      client.query(`select public.update_project_w2($1, $2::jsonb, $3)`, [
        fixture.projectA,
        JSON.stringify({ name: 'ignored replay' }),
        'g06-update-fanout',
      ]));
    const replayVersions = await database.query<{ id: string; version: number }>(
      `select e.id::text, e.version from public.entities e
       join public.project_projection_details d on d.entity_id = e.id where d.project_id = $1 order by e.id`,
      [fixture.projectA],
    );
    expect(replayVersions).toEqual(afterFirst.map(({ id, version }) => ({ id, version })));
  });

  it('unlinks and relinks by restoring the same stable projection id with count parity', async () => {
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.write_edge($1, $2, 'likes', '{}'::jsonb, null, 'g06-stable-like')`,
      [fixture.ownerA, fixture.projectionB],
    ));
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.unlink_project_w2($1, $2, 'g06-stable-unlink')`,
      [fixture.spaceA, fixture.projectB],
    ));
    let state = (await database.query<{ deleted: boolean; active_link_count: number; likes: number }>(
      `select e.deleted_at is not null deleted, p.active_link_count, c.likes
         from public.entities e cross join public.projects p
         join public.entity_counters c on c.entity_id = e.id
        where e.id = $1 and p.id = $2`,
      [fixture.projectionB, fixture.projectB],
    ))[0]!;
    expect(state).toEqual({ deleted: true, active_link_count: 0, likes: 1 });
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.link_project_w2($1, $2, null, 'g06-stable-relink')`,
      [fixture.spaceA, fixture.projectB],
    ));
    const mapping = (await database.query<{
      projection: string;
      deleted: boolean;
      active_link_count: number;
      likes: number;
    }>(
      `select l.project_entity_id::text projection, e.deleted_at is not null deleted,
              p.active_link_count, c.likes
         from public.project_links l join public.entities e on e.id = l.project_entity_id
         join public.projects p on p.id = l.project_id
         join public.entity_counters c on c.entity_id = e.id
        where l.space_id = $1 and l.project_id = $2`,
      [fixture.spaceA, fixture.projectB],
    ))[0]!;
    expect(mapping).toEqual({
      projection: fixture.projectionB,
      deleted: false,
      active_link_count: 1,
      likes: 1,
    });
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.link_project_w2($1, $2, null, 'g06-stable-relink')`,
      [fixture.spaceA, fixture.projectB],
    ));
    state = (await database.query<{ deleted: boolean; active_link_count: number; likes: number }>(
      `select e.deleted_at is not null deleted, p.active_link_count, c.likes
         from public.entities e cross join public.projects p
         join public.entity_counters c on c.entity_id = e.id
        where e.id = $1 and p.id = $2`,
      [fixture.projectionB, fixture.projectB],
    ))[0]!;
    expect(state).toEqual({ deleted: false, active_link_count: 1, likes: 1 });
    const invalidations = await database.query<{ event_type: string; client_mutation_id: string }>(
      `select event_type, client_mutation_id from public.workspace_events
        where space_id = $1 and payload->>'id' = $2
          and client_mutation_id in ('g06-stable-unlink','g06-stable-relink')
        order by seq`,
      [fixture.spaceA, fixture.projectionB],
    );
    expect(invalidations[0]).toEqual({
      event_type: 'entity.deleted',
      client_mutation_id: 'g06-stable-unlink',
    });
    expect(invalidations.slice(1)).toEqual([
      { event_type: 'entity.upsert', client_mutation_id: 'g06-stable-relink' },
      { event_type: 'entity.upsert', client_mutation_id: 'g06-stable-relink' },
    ]);
  });

  it('enforces the union unlink guard but permits exited launch provenance without mutating it', async () => {
    const associated = await createLinkedProject(database, fixture, 'associated-guard');
    const associatedSession = await createSession(database, fixture, 'Associated guard');
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, null, 'g06-associated-edge')`,
      [associatedSession, associated.projectionId],
    ));
    await expect(asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.unlink_project_w2($1, $2, 'g06-associated-refused')`,
      [fixture.spaceA, associated.projectId],
    ))).rejects.toMatchObject({ code: '23514', detail: 'project_not_linked' });
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.delete_edge((select id from public.edges where src_id = $1 and dst_id = $2 and type = 'in_project'), null, 'g06-associated-remove')`,
      [associatedSession, associated.projectionId],
    ));
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.unlink_project_w2($1, $2, 'g06-associated-unlink')`,
      [fixture.spaceA, associated.projectId],
    ));

    const launch = await createLinkedProject(database, fixture, 'launch-guard');
    const launchSession = await createSession(database, fixture, 'Launch guard', launch.projectId);
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.delete_edge((select id from public.edges where src_id = $1 and dst_id = $2 and type = 'in_project'), null, 'g06-launch-edge-remove')`,
      [launchSession, launch.projectionId],
    ));
    await expect(asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.unlink_project_w2($1, $2, 'g06-launch-refused')`,
      [fixture.spaceA, launch.projectId],
    ))).rejects.toMatchObject({ code: '23514', detail: 'project_not_linked' });
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.work_session_transition($1, 'exited', 0, null, null, 'g06-launch-exit')`,
      [launchSession],
    ));
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.unlink_project_w2($1, $2, 'g06-launch-exited-unlink')`,
      [fixture.spaceA, launch.projectId],
    ));
    const provenance = (await database.query<{ project_id: string; deleted: boolean }>(
      `select ws.project_id::text, e.deleted_at is not null deleted from public.work_sessions ws
       cross join public.entities e where ws.entity_id = $1 and e.id = $2`,
      [launchSession, launch.projectionId],
    ))[0]!;
    expect(provenance).toEqual({ project_id: launch.projectId, deleted: true });
  });

  it('keeps ordinary multi-project session edges writable and enforces the frozen 16/17 cap', async () => {
    const sessionId = await createSession(database, fixture, 'Sixteen projects');
    const projects = [] as Array<{ projectId: string; projectionId: string }>;
    for (let index = 0; index < 17; index += 1) {
      projects.push(await createLinkedProject(database, fixture, `cap-${index}`));
    }
    for (const [index, project] of projects.slice(0, 16).entries()) {
      await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
        `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, null, $3)`,
        [sessionId, project.projectionId, `g06-cap-${index}`],
      ));
    }
    await expect(asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, null, 'g06-cap-17')`,
      [sessionId, projects[16]!.projectionId],
    ))).rejects.toMatchObject({ code: '53400', detail: 'project_association_cap' });
    const count = (await database.query<{ count: number }>(
      `select count(*)::integer count from public.edges where src_id = $1 and type = 'in_project'`,
      [sessionId],
    ))[0]!.count;
    expect(count).toBe(16);
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.delete_edge((select id from public.edges where src_id = $1 and dst_id = $2 and type = 'in_project'), null, 'g06-cap-curate')`,
      [sessionId, projects[0]!.projectionId],
    ));
    await asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.write_edge($1, $2, 'in_project', '{}'::jsonb, null, 'g06-cap-17-retry')`,
      [sessionId, projects[16]!.projectionId],
    ));
  });

  it('corrects pure and promoted materialized artifact associations with replay and role/version guards', async () => {
    const artifacts = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const ids = (await client.query<{ pr: string; commit: string }>(
        `select internal.new_id()::text pr, internal.new_id()::text commit`,
      )).rows[0]!;
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1, $3, 'pull_request', 0, $4), ($2, $3, 'commit', 1, $4)`,
        [ids.pr, ids.commit, fixture.spaceA, fixture.ownerA],
      );
      await client.query(
        `insert into public.pull_requests(entity_id, space_id, url, repo, number, title)
         values ($1, $2, 'https://example.test/pr/6', 'tm8/g06', 6, 'G06 PR')`,
        [ids.pr, fixture.spaceA],
      );
      await client.query(
        `insert into public.commits(entity_id, space_id, repo, sha, message)
         values ($1, $2, 'tm8/g06', 'abcdef0', 'G06 commit')`,
        [ids.commit, fixture.spaceA],
      );
      await client.query(`select internal.w1_set_writer('materialized')`);
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
         values ($3, $1, $5, 'in_project', '{}'::jsonb, $4),
                ($3, $2, $5, 'in_project', '{"promotedFromOrigin":"user"}'::jsonb, $4)`,
        [ids.pr, ids.commit, fixture.spaceA, fixture.ownerA, fixture.projectionA],
      );
      await client.query(`select internal.w1_set_writer(null)`);
      return ids;
    });
    await expect(asApp(database, fixture.memberIdentity, false, (client) => client.query(
      `select public.correct_project_association($1, $2, 1, 'g06-role-negative')`,
      [artifacts.pr, fixture.projectA],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.correct_project_association($1, $2, 99, 'g06-version-negative')`,
      [artifacts.pr, fixture.projectA],
    ))).rejects.toMatchObject({ code: '40001' });
    const removed = await asApp(database, fixture.ownerIdentity, true, async (client) => (
      await client.query<{ result: { outcome: string; edgeId: string | null } }>(
        `select public.correct_project_association($1, $2, 1, 'g06-correct-remove') result`,
        [artifacts.pr, fixture.projectA],
      )
    ).rows[0]!.result);
    expect(removed).toEqual(expect.objectContaining({ outcome: 'removed', edgeId: null }));
    const demoted = await asApp(database, fixture.ownerIdentity, true, async (client) => (
      await client.query<{ result: { outcome: string; edgeId: string } }>(
        `select public.correct_project_association($1, $2, 1, 'g06-correct-demote') result`,
        [artifacts.commit, fixture.projectA],
      )
    ).rows[0]!.result);
    expect(demoted.outcome).toBe('demoted');
    const props = (await database.query<{ props: Record<string, unknown> }>(
      `select props from public.edges where id = $1`, [demoted.edgeId],
    ))[0]!.props;
    expect(props).toEqual({ origin: 'user' });
    const replay = await asApp(database, fixture.ownerIdentity, true, async (client) => (
      await client.query<{ result: { outcome: string; edgeId: string } }>(
        `select public.correct_project_association($1, $2, 1, 'g06-correct-demote') result`,
        [artifacts.commit, fixture.projectA],
      )
    ).rows[0]!.result);
    expect(replay).toEqual(demoted);
  });

  it('keeps launchProjectId immutable and denies direct tm8_app DML and generic projection deletion', async () => {
    await expect(database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(`update public.work_sessions set project_id = $2 where entity_id = $1`, [
        fixture.conditionalSession,
        fixture.projectA,
      ]);
    })).rejects.toMatchObject({ code: '23514' });
    await expect(asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `update public.projects set name = 'forbidden' where id = $1`, [fixture.projectA],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `update public.project_projection_details set name = 'forbidden' where entity_id = $1`,
      [fixture.projectionA],
    ))).rejects.toMatchObject({ code: '42501' });
    await expect(asApp(database, fixture.ownerIdentity, true, (client) => client.query(
      `select public.delete_entity($1, null, 'g06-generic-project-delete')`, [fixture.projectionA],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('serializes create-vs-unlink on ProjectResource and rechecks the active mapping', async () => {
    const raced = await createLinkedProject(database, fixture, 'race');
    const sessionId = await createSession(database, fixture, 'Race session');
    const unlinker = await database.pool.connect();
    const writer = await database.pool.connect();
    try {
      await unlinker.query('begin');
      await unlinker.query('set local role tm8_app');
      await unlinker.query(`select set_config('tm8.identity_id', $1, true), set_config('tm8.node_admin', 'true', true)`, [fixture.ownerIdentity]);
      await unlinker.query(`select public.update_project_w2($1, '{}'::jsonb, null)`, [raced.projectId]);

      await writer.query('begin');
      await writer.query('set local role tm8_graph_owner');
      const prechecked = await writer.query(
        `select count(*)::integer count from public.entities
          where id in ($1, $2) and deleted_at is null`,
        [sessionId, raced.projectionId],
      );
      expect(prechecked.rows[0]!.count).toBe(2);
      const pending = writer.query(
        `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
         values ($1, $2, $3, 'in_project', '{}'::jsonb, $4)`,
        [fixture.spaceA, sessionId, raced.projectionId, fixture.ownerA],
      );
      await Promise.resolve();
      await unlinker.query(
        `select public.unlink_project_w2($1, $2, 'g06-race-unlink')`,
        [fixture.spaceA, raced.projectId],
      );
      await unlinker.query('commit');
      await expect(pending).rejects.toMatchObject({ code: '23514', detail: 'project_not_linked' });
      await writer.query('rollback');
    } finally {
      unlinker.release();
      writer.release();
    }
    const state = (await database.query<{ links: number; edges: number; deleted: boolean }>(
      `select (select count(*)::integer from public.space_projects where space_id = $1 and project_id = $2) links,
              (select count(*)::integer from public.edges where src_id = $3 and dst_id = $4) edges,
              (select deleted_at is not null from public.entities where id = $4) deleted`,
      [fixture.spaceA, raced.projectId, sessionId, raced.projectionId],
    ))[0]!;
    expect(state).toEqual({ links: 0, edges: 0, deleted: true });
  });
});
