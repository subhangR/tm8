/**
 * Migration 177 — the `container` core kind (Containers P0, lane A).
 *
 * POSITION-PINNED, like `loops.pg.test.ts`: the whole chain EXCEPT 177, then a
 * pre-177 world, then 177 applied exactly as an upgrade would apply it. A
 * migration that has only ever run as part of a from-scratch chain has not been
 * tested against the database anyone actually has.
 *
 * Because the suite is position-pinned it may only assert what 177 itself
 * creates. The chain-wide guard — that EVERY core kind's `entity_content` arm
 * still resolves after 177 re-creates that function — lives in its own
 * full-chain suite, `entity-content-all-kinds.pg.test.ts`, for the same reason a
 * migration's VERIFY block may not assert chain-wide.
 *
 * What is asserted here that a "did it return without throwing" test would miss:
 *
 *  - `internal.entity_content` resolves the `container` arm, and resolves it
 *    WITHOUT `runtime_ref` or `host_spec`. A missing arm is silent (content
 *    becomes `{}` forever); a LEAKING arm is worse than silent, because it ships
 *    the host's real filesystem paths to every client (ruling R5).
 *  - `status` has exactly one writer. A direct `update containers set status`
 *    must be refused with 23514 even as the graph owner. THIS IS THE LINE THE
 *    LANE'S NEGATIVE CONTROL MUTATES.
 *  - the status machine refuses illegal edges, so a caller cannot skip
 *    `provisioning` or resurrect a destroyed machine.
 *  - a heartbeat does NOT bump `entities.version` (the migration-165 lesson;
 *    heartbeats arrive every 10-30 s per machine and would starve live renames).
 *  - RLS actually isolates two members of different spaces, tested through
 *    `tm8_app` with real claims rather than as the owner, which would prove the
 *    SQL parses and nothing about whether a real caller may run it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

/**
 * Resolved by SUFFIX, not by number — `loops.pg.test.ts`'s rule, and this lane
 * has a live reason for it: the file is numbered 177 because the union of
 * `db/migrations` across all origin heads maxes at 176, and if a branch steals
 * 177 before this merges the fix is to RENAME this one file. A hard-coded
 * '177_container_kind.sql' would turn that mechanical rename into a test failure
 * during a merge, which is the worst possible moment to be reading this suite.
 */
const CONTAINERS_MIGRATION_SUFFIX = '_container_kind.sql';

function containersMigration(files: readonly string[]): string {
  const matches = files.filter((file) => file.endsWith(CONTAINERS_MIGRATION_SUFFIX));
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one *${CONTAINERS_MIGRATION_SUFFIX} migration, found ${matches.length}: ${matches.join(', ')}`,
    );
  }
  return matches[0]!;
}

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teamMemberId: string;
  projectId: string;
  projectEntityId: string;
  strangerIdentityId: string;
  otherSpaceId: string;
  otherMemberId: string;
}

const NODE_ID = 'test-node:7777';

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seedPre177(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (await client.query<Fixture>(
      `select 'containers-owner'::text "identityId",
              'containers-stranger'::text "strangerIdentityId",
              internal.new_id()::text "spaceId",
              internal.new_id()::text "memberId",
              internal.new_id()::text "teamMemberId",
              internal.new_id()::text "projectId",
              internal.new_id()::text "projectEntityId",
              internal.new_id()::text "otherSpaceId",
              internal.new_id()::text "otherMemberId"`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id,display_name)
       values($1,'Containers owner'),($2,'Stranger')`,
      [f.identityId, f.strangerIdentityId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity)
       values($1,'Machines',$2),($3,'Elsewhere',$4)`,
      [f.spaceId, f.identityId, f.otherSpaceId, f.strangerIdentityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$2,'member',null,0,$1),
       ($3,$2,'team_member',null,1,$1),
       ($4,$5,'member',null,0,$4)`,
      [f.memberId, f.spaceId, f.teamMemberId, f.otherMemberId, f.otherSpaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Containers owner'),($4,$5,$6,'owner','Stranger')`,
      [f.memberId, f.spaceId, f.identityId, f.otherMemberId, f.otherSpaceId, f.strangerIdentityId],
    );
    await client.query(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
       values($1,$2,'Driver','','persona')`,
      [f.teamMemberId, f.memberId],
    );

    // A project to hang a `mounts` edge on.
    await client.query(
      `insert into public.projects(id,name,working_dir,trust)
       values($1,'demo','/tmp/tm8-containers-demo','trusted')`,
      [f.projectId],
    );
    // A `project` ENVELOPE is materializer-owned (015:867): the lifecycle guard
    // refuses an ordinary insert, so the seed claims that writer for the two
    // statements that need it, exactly as the materializer does.
    await client.query(`select internal.w1_set_writer('project_materializer')`);
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'project',null,2,$3)`,
      [f.projectEntityId, f.spaceId, f.memberId],
    );
    await client.query(
      `insert into public.project_projection_details(entity_id,project_id,name) values($1,$2,'demo')`,
      [f.projectEntityId, f.projectId],
    );
    await client.query(
      `insert into public.space_projects(space_id,project_id) values($1,$2)`,
      [f.spaceId, f.projectId],
    );
    await client.query(`select internal.w1_set_writer(null)`);
    return f;
  });
}

/**
 * The doors as `tm8_app` sees them — the role tm8-server actually connects as,
 * with the same claim triple the facade sets. Calling them as the graph owner
 * would prove the SQL parses and nothing about whether a real caller may run it.
 */
async function asApp<T>(
  identityId: string,
  fn: (q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),
              set_config('tm8.request_id','req-containers-pg',true)`,
      [identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

interface CommandResult {
  entity: { id: string; version?: number };
}

let mutationSeq = 0;
function cmid(tag: string): string {
  mutationSeq += 1;
  return `containers-test-${tag}-${mutationSeq}`;
}

async function createContainer(
  overrides: {
    title?: string;
    profile?: string;
    spec?: unknown;
    lifecycle?: unknown;
    projectId?: string | null;
    templateId?: string | null;
    parentId?: string | null;
    cap?: number;
    clientMutationId?: string;
    identityId?: string;
    spaceId?: string;
  } = {},
): Promise<string> {
  const rows = await asApp(overrides.identityId ?? fixture.identityId, (q) =>
    q(
      `select public.create_container_entity(
         $1,$2,$3,$4,'docker','container',$5,'tm8/shell:1',
         $6::jsonb,$7::jsonb,'none','machine',$8,$9,$10,null,$11,$12) result`,
      [
        overrides.spaceId ?? fixture.spaceId,
        overrides.title ?? 'Shell',
        fixture.memberId,
        overrides.profile ?? 'shell',
        NODE_ID,
        JSON.stringify(overrides.spec ?? {}),
        JSON.stringify(overrides.lifecycle ?? { ephemeral: true }),
        overrides.parentId ?? null,
        overrides.projectId ?? null,
        overrides.templateId ?? null,
        overrides.cap ?? 50,
        overrides.clientMutationId ?? cmid('create'),
      ],
    ));
  return (rows[0]!.result as CommandResult).entity.id;
}

/** Move status through the node-internal (unledgered) mode. */
async function setStatus(
  id: string,
  status: string,
  extra: { runtimeRef?: string | null; surfaces?: unknown; error?: string | null } = {},
): Promise<void> {
  await asApp(fixture.identityId, (q) =>
    q(`select public.set_container_status($1,$2,$3,$4::jsonb,$5,$6,null,null,null)`, [
      id,
      status,
      extra.runtimeRef ?? null,
      extra.surfaces === undefined ? null : JSON.stringify(extra.surfaces),
      extra.error ?? null,
      fixture.memberId,
    ]));
}

async function statusOf(id: string): Promise<string> {
  const rows = await database.query<{ status: string }>(
    `select status from public.containers where entity_id = $1`,
    [id],
  );
  return rows[0]!.status;
}

async function versionOf(id: string): Promise<number> {
  const rows = await database.query<{ version: number }>(
    `select version from public.entities where id = $1`,
    [id],
  );
  return rows[0]!.version;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('containers');
  const files = migrationFiles();
  const containers = containersMigration(files);
  database.apply(files.filter((f) => f !== containers));
  fixture = await seedPre177(database);
  database.apply([containers]);
});

afterAll(async () => {
  await database?.destroy();
});

describe('177 registers container as a core kind', () => {
  it('seeds the kind row with core origin and no owning space', async () => {
    const rows = await database.query<{ origin: string; space_id: string | null }>(
      `select origin, space_id from public.entity_kinds where kind = 'container'`,
    );
    expect(rows).toEqual([{ origin: 'core', space_id: null }]);
  });

  it('registers all five container edge types with their kind pairs', async () => {
    const rows = await database.query<{ type: string; src_kinds: string[]; dst_kinds: string[]; acyclic: boolean }>(
      `select type, src_kinds, dst_kinds, acyclic from public.edge_types
        where type in ('runs_in','drives','mounts','snapshot_of','controls')
        order by type`,
    );
    expect(rows.map((r) => r.type)).toEqual(['controls', 'drives', 'mounts', 'runs_in', 'snapshot_of']);
    expect(rows.find((r) => r.type === 'runs_in')).toMatchObject({
      src_kinds: ['work_session'],
      dst_kinds: ['container'],
    });
    expect(rows.find((r) => r.type === 'mounts')).toMatchObject({
      src_kinds: ['container'],
      dst_kinds: ['project'],
    });
    // A snapshot chain that loops is a fork with no origin.
    expect(rows.find((r) => r.type === 'snapshot_of')?.acyclic).toBe(true);
  });
});

describe('create_container_entity', () => {
  it('creates the envelope, the detail row, and content the container arm resolves', async () => {
    const id = await createContainer({ title: 'Shell one' });

    const detail = await database.query<{ title: string; status: string; node_id: string; provider: string }>(
      `select title, status, node_id, provider from public.containers where entity_id = $1`,
      [id],
    );
    expect(detail[0]).toMatchObject({
      title: 'Shell one',
      status: 'requested',
      node_id: NODE_ID,
      provider: 'docker',
    });

    // The silent failure this asserts against: a missing arm resolves to `{}`
    // forever and every other check here still passes.
    const content = await database.query<{ content: Record<string, unknown> }>(
      `select internal.entity_content($1) content`,
      [id],
    );
    expect(content[0]!.content).toMatchObject({ title: 'Shell one', profile: 'shell', status: 'requested' });
  });

  it('writes a mounts edge when a project is named and a snapshot_of edge when a template is', async () => {
    const template = await createContainer({ title: 'Template' });
    const id = await createContainer({
      title: 'From template',
      projectId: fixture.projectEntityId,
      templateId: template,
    });

    const edges = await database.query<{ type: string; dst_id: string }>(
      `select type, dst_id from public.edges where src_id = $1 order by type`,
      [id],
    );
    expect(edges).toEqual([
      { type: 'mounts', dst_id: fixture.projectEntityId },
      { type: 'snapshot_of', dst_id: template },
    ]);
  });

  it('refuses a secret-looking env key — secrets never enter the machine through the graph', async () => {
    await expect(
      createContainer({ spec: { env: { ANTHROPIC_API_KEY: 'x' } } }),
    ).rejects.toThrow(/secret-looking key/i);

    // The rule is about the KEY NAME, which is what a caller controls.
    await expect(createContainer({ spec: { env: { GITHUB_TOKEN: 'x' } } })).rejects.toThrow(/secret-looking/i);
    await expect(createContainer({ spec: { env: { DB_PASSWORD: 'x' } } })).rejects.toThrow(/secret-looking/i);

    // An ordinary variable is fine.
    await expect(createContainer({ spec: { env: { TERM: 'xterm-256color' } } })).resolves.toBeTruthy();
  });

  it('refuses a relative or traversing mount path, on either side', async () => {
    await expect(
      createContainer({ spec: { mounts: [{ host: 'relative/path', guest: '/workspace' }] } }),
    ).rejects.toThrow(/host path must be absolute/i);
    await expect(
      createContainer({ spec: { mounts: [{ host: '/tmp/../etc', guest: '/workspace' }] } }),
    ).rejects.toThrow(/host path must be absolute/i);
    await expect(
      createContainer({ spec: { mounts: [{ host: '/tmp/ok', guest: 'workspace' }] } }),
    ).rejects.toThrow(/guest path must be absolute/i);
  });

  it('refuses a container with no node — nothing would ever collect its runtime', async () => {
    await expect(
      asApp(fixture.identityId, (q) =>
        q(
          `select public.create_container_entity($1,'No node',$2,'shell','docker','container',
             null,'',' {}'::jsonb,'{}'::jsonb,'none','machine',null,null,null,null,4,$3)`,
          [fixture.spaceId, fixture.memberId, cmid('nonode')],
        )),
    ).rejects.toThrow(/node_id is required/i);
  });

  it('refuses to exceed the per-node cap with 53400', async () => {
    await expect(createContainer({ cap: 1 })).rejects.toMatchObject({ code: '53400' });
  });
});

describe('R5 — the client-visible record carries no host path and no runtime ref', () => {
  it('splits mounts into a guest-only spec and a server-only host_spec', async () => {
    const id = await createContainer({
      title: 'Mounted',
      spec: { mounts: [{ host: '/Users/someone/secret-project', guest: '/workspace', ro: true }] },
    });
    await setStatus(id, 'provisioning', { runtimeRef: 'docker://deadbeef' });

    const content = (await database.query<{ content: Record<string, unknown> }>(
      `select internal.entity_content($1) content`,
      [id],
    ))[0]!.content;

    // `internal.command_entity` embeds this in what a CLIENT receives.
    expect(JSON.stringify(content)).not.toContain('/Users/someone/secret-project');
    expect(content).not.toHaveProperty('host_spec');
    expect(content).not.toHaveProperty('runtime_ref');

    const spec = content['spec'] as { mounts: Record<string, unknown>[] };
    expect(spec.mounts).toEqual([{ guest: '/workspace', ro: true }]);

    // The host half is not lost — it is server-side, where the node reads it.
    const stored = await database.query<{ host_spec: { mounts: { host: string }[] }; runtime_ref: string }>(
      `select host_spec, runtime_ref from public.containers where entity_id = $1`,
      [id],
    );
    expect(stored[0]!.host_spec.mounts[0]!.host).toBe('/Users/someone/secret-project');
    expect(stored[0]!.runtime_ref).toBe('docker://deadbeef');
  });
});

describe('the status machine', () => {
  it('walks create -> provisioning -> running -> stopping -> stopped -> destroying -> destroyed', async () => {
    const id = await createContainer({ title: 'Lifecycle' });
    expect(await statusOf(id)).toBe('requested');

    for (const next of ['provisioning', 'running', 'stopping', 'stopped', 'destroying', 'destroyed']) {
      await setStatus(id, next);
      expect(await statusOf(id)).toBe(next);
    }

    // `running` stamps started_at; the terminal statuses stamp stopped_at.
    const stamps = await database.query<{ started_at: Date | null; stopped_at: Date | null }>(
      `select started_at, stopped_at from public.containers where entity_id = $1`,
      [id],
    );
    expect(stamps[0]!.started_at).not.toBeNull();
    expect(stamps[0]!.stopped_at).not.toBeNull();

    // `destroyed` is terminal AND soft-deletes the envelope: the record stays
    // for history, the runtime is gone.
    const deleted = await database.query<{ deleted_at: Date | null }>(
      `select deleted_at from public.entities where id = $1`,
      [id],
    );
    expect(deleted[0]!.deleted_at).not.toBeNull();
  });

  it('refuses an illegal transition with 23514', async () => {
    const id = await createContainer({ title: 'Illegal' });
    // requested -> running skips provisioning, so nothing ever called
    // provider.create and there is no runtime behind the claim.
    await expect(setStatus(id, 'running')).rejects.toMatchObject({ code: '23514' });
    expect(await statusOf(id)).toBe('requested');
  });

  it('refuses to resurrect a destroyed machine', async () => {
    const id = await createContainer({ title: 'Gone' });
    for (const next of ['provisioning', 'running', 'stopping', 'stopped', 'destroying', 'destroyed']) {
      await setStatus(id, next);
    }

    // TWO guards refuse this, and the OUTER one answers first: `destroyed`
    // soft-deletes the envelope, so `internal.live_entity` raises P0002 before
    // the transition table is ever consulted. Asserting 23514 here would be
    // asserting an error this path cannot produce.
    await expect(setStatus(id, 'running')).rejects.toMatchObject({ code: 'P0002' });

    // The inner guard is real too, and this is where it is visible: the status
    // machine itself says `destroyed` is terminal, independently of the
    // soft-delete that happens to shadow it.
    const allowed = await database.query<{ ok: boolean }>(
      `select internal.container_transition_allowed('destroyed','running') ok`,
    );
    expect(allowed[0]!.ok).toBe(false);
  });

  it('allows failure and teardown from anywhere that is not already terminal', async () => {
    const failed = await createContainer({ title: 'Fails' });
    await setStatus(failed, 'provisioning');
    await setStatus(failed, 'failed', { error: 'image pull failed' });
    expect(await statusOf(failed)).toBe('failed');

    const torn = await createContainer({ title: 'Torn down early' });
    await setStatus(torn, 'destroying');
    expect(await statusOf(torn)).toBe('destroying');
  });

  /**
   * THE NEGATIVE-CONTROL HINGE.
   *
   * The lane's mutation comments out the `tm8.container_transition` claim check
   * in `internal.guard_container_status`. THIS test must go red and nothing
   * else must. If more than this reds, the guard is doing more than it should;
   * if zero red, the mutation did not apply or the runner never ran.
   */
  it('refuses a direct update of containers.status, even as the graph owner', async () => {
    const id = await createContainer({ title: 'Single writer' });

    await expect(
      database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        // A legal EDGE, so only the single-writer claim can be what refuses it.
        await client.query(`update public.containers set status = 'provisioning' where entity_id = $1`, [id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });

    expect(await statusOf(id)).toBe('requested');
  });

  it('lets the door through the very same edge it just refused', async () => {
    const id = await createContainer({ title: 'Door works' });
    await setStatus(id, 'provisioning');
    expect(await statusOf(id)).toBe('provisioning');
  });

  it('does not leak the transition claim past the door', async () => {
    const id = await createContainer({ title: 'Claim scope' });
    // Same transaction, two statements: the door sets the claim `is_local`, so
    // a direct update AFTER it must still be refused. A leaked claim would make
    // the single-writer guard a no-op for the rest of the connection.
    await expect(
      database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(
          `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
                  set_config('tm8.node_admin','false',true),set_config('tm8.request_id','r',true)`,
          [fixture.identityId],
        );
        await client.query(`select public.set_container_status($1,'provisioning',null,null,null,$2,null,null,null)`, [
          id,
          fixture.memberId,
        ]);
        await client.query('set local role tm8_graph_owner');
        await client.query(`update public.containers set status = 'running' where entity_id = $1`, [id]);
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the universal category tabs (§22b)', () => {
  /**
   * THE ASSERTION WHOSE ABSENCE LET THE work_session VERSION SHIP.
   *
   * Not "the mapping function returns the right string" — that would pass with
   * the bridge trigger missing entirely, which is the whole defect. This walks a
   * real container through every status via the real door and reads the
   * envelope after each step.
   *
   * Both columns are asserted at every step, deliberately. Checking only
   * `status_category` would pass while `status_id` stayed pinned at the seeded
   * "To Do" state — the half of the original defect that made the two disagree,
   * so that a destroyed machine would file under Done while its pill still read
   * "To Do".
   */
  const WALK: ReadonlyArray<readonly [string, string]> = [
    ['requested', 'to_do'],
    ['provisioning', 'to_do'],
    ['running', 'in_progress'],
    ['paused', 'in_progress'],
    ['running', 'in_progress'],
    ['stopping', 'in_progress'],
    ['stopped', 'done'],
    // `containers.start` on a stopped machine. Under a status_id bridge this
    // edge is `done -> in_progress`, which `internal.category_transition_allowed`
    // refuses — it would raise 23514 from inside set_container_status and ABORT
    // THE DOOR. It must simply work.
    ['running', 'in_progress'],
    ['stopping', 'in_progress'],
    ['stopped', 'done'],
    ['destroying', 'in_progress'],
    ['destroyed', 'done'],
  ];

  it('moves status_category through every status and never lies with a status_id', async () => {
    const id = await createContainer({ title: 'Category walk' });

    const seen: string[] = [];
    for (const [status, expected] of WALK) {
      if (status !== 'requested') await setStatus(id, status);
      const row = (await database.query<{ status_category: string | null; status_id: string | null }>(
        `select status_category, status_id from public.entities where id = $1`,
        [id],
      ))[0]!;
      seen.push(`${status}=${row.status_category}`);
      expect(row.status_category, `at ${status}`).toBe(expected);
      // A container uses no workflow state, so there is nothing to disagree.
      expect(row.status_id, `status_id at ${status} must be null`).toBeNull();
    }

    // The regression this whole section exists for: the category must not be
    // the same value at the start and the end.
    expect(seen[0]).toBe('requested=to_do');
    expect(seen.at(-1)).toBe('destroyed=done');
    expect(new Set(seen.map((s) => s.split('=')[1])).size).toBeGreaterThan(1);
  });

  it('starts a stopped machine — the edge a status_id bridge would refuse', async () => {
    const id = await createContainer({ title: 'Restartable' });
    for (const next of ['provisioning', 'running', 'stopping', 'stopped']) await setStatus(id, next);
    expect(await statusOf(id)).toBe('stopped');

    // Would be `done -> in_progress` = 23514 under 155's three-piece bridge.
    await expect(setStatus(id, 'running')).resolves.toBeUndefined();
    expect(await statusOf(id)).toBe('running');
    const row = (await database.query<{ status_category: string }>(
      `select status_category from public.entities where id = $1`, [id]))[0]!;
    expect(row.status_category).toBe('in_progress');
  });

  it('destroys a failed machine — the other edge that would be refused', async () => {
    const id = await createContainer({ title: 'Failed then torn down' });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'failed', { error: 'boom' });
    expect((await database.query<{ status_category: string }>(
      `select status_category from public.entities where id = $1`, [id]))[0]!.status_category).toBe('done');

    await expect(setStatus(id, 'destroying')).resolves.toBeUndefined();
    expect(await statusOf(id)).toBe('destroying');
  });

  it('clears the seeded workflow state at birth rather than leaving a pill that will lie', async () => {
    const id = await createContainer({ title: 'Born stateless' });
    const row = (await database.query<{ status_category: string | null; status_id: string | null }>(
      `select status_category, status_id from public.entities where id = $1`, [id]))[0]!;
    expect(row.status_id).toBeNull();
    expect(row.status_category).toBe('to_do');
  });

  it('files a container as resolved once it is over, and not before', async () => {
    // internal.is_resolved reads status_category, so the bridge is what makes
    // this answer at all — before §22b every container was permanently unresolved.
    const id = await createContainer({ title: 'Resolution' });
    const resolved = async (): Promise<boolean> =>
      (await database.query<{ r: boolean }>(`select internal.is_resolved($1) r`, [id]))[0]!.r;

    expect(await resolved()).toBe(false);
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running');
    expect(await resolved()).toBe(false);
    await setStatus(id, 'stopping');
    await setStatus(id, 'stopped');
    expect(await resolved()).toBe(true);
  });

  it('leaves the column alone for a status it has no bucket for', async () => {
    const unknown = await database.query<{ c: string | null }>(
      `select internal.container_status_category('not-a-status') c`,
    );
    expect(unknown[0]!.c).toBeNull();
  });
});

describe('idempotency', () => {
  it('returns the same row when a create is replayed with the same mutation id', async () => {
    const key = cmid('replay');
    const first = await createContainer({ title: 'Replayed', clientMutationId: key });
    const second = await createContainer({ title: 'Replayed', clientMutationId: key });
    expect(second).toBe(first);

    const count = await database.query<{ n: string }>(
      `select count(*)::text n from public.containers c
        join public.entities e on e.id = c.entity_id
       where c.title = 'Replayed'`,
    );
    expect(count[0]!.n).toBe('1');
  });

  it('refuses a replay of the same mutation id under a different operation with 23514', async () => {
    const key = cmid('wrongop');
    const id = await createContainer({ title: 'Wrong op', clientMutationId: key });

    // One clientMutationId belongs to one operation (DEV-9).
    const version = await versionOf(id);
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.update_container($1,$2,$3,'Renamed',null,null,null,$4)`, [
          id,
          version,
          fixture.memberId,
          key,
        ])),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a replay addressed at a different resource', async () => {
    const key = cmid('subject');
    const id = await createContainer({ title: 'Bound', clientMutationId: key });
    const other = await createContainer({ title: 'Other' });

    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.update_container($1,$2,$3,'Nope',null,null,null,$4)`, [other, 1, fixture.memberId, key]),
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await statusOf(id)).toBe('requested');
  });
});

describe('update_container', () => {
  it('patches title, share_mode and labels, and bumps the version', async () => {
    const id = await createContainer({ title: 'Before' });
    const before = await versionOf(id);

    await asApp(fixture.identityId, (q) =>
      q(`select public.update_container($1,$2,$3,'After',null,'space',$4::jsonb,$5)`, [
        id,
        before,
        fixture.memberId,
        JSON.stringify({ tier: 'gold' }),
        cmid('update'),
      ]));

    const rows = await database.query<{ title: string; share_mode: string; labels: Record<string, string> }>(
      `select title, share_mode, labels from public.containers where entity_id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ title: 'After', share_mode: 'space', labels: { tier: 'gold' } });
    expect(await versionOf(id)).toBeGreaterThan(before);
  });

  it('refuses a stale expected version with 40001', async () => {
    const id = await createContainer({ title: 'Versioned' });
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.update_container($1,$2,$3,'Stale',null,null,null,$4)`, [
          id,
          999,
          fixture.memberId,
          cmid('stale'),
        ])),
    ).rejects.toMatchObject({ code: '40001' });
  });

  it('cannot reach status', async () => {
    // There is no status parameter at all — the guard is not the only thing
    // stopping this door, the signature is.
    const args = await database.query<{ n: string }>(
      `select pg_get_function_arguments(p.oid) n from pg_proc p
        join pg_namespace ns on ns.oid = p.pronamespace
       where ns.nspname = 'public' and p.proname = 'update_container'`,
    );
    expect(args[0]!.n).not.toContain('status');
  });
});

describe('heartbeats stay off the entity (the migration-165 lesson)', () => {
  it('records runtime state without bumping entities.version', async () => {
    const id = await createContainer({ title: 'Chatty' });
    const before = await versionOf(id);

    for (let i = 0; i < 5; i += 1) {
      await asApp(fixture.identityId, (q) =>
        q(`select public.record_container_heartbeat($1,$2,$3::jsonb,$4::jsonb)`, [
          id,
          NODE_ID,
          JSON.stringify({ cpuPct: i, memMiB: 128 }),
          JSON.stringify({ screen: true }),
        ]));
    }

    // Five heartbeats, zero version bumps. At 10-30 s per beat per machine this
    // is the difference between a quiet graph and one that starves live renames.
    expect(await versionOf(id)).toBe(before);

    const state = await database.query<{ usage: { cpuPct: number }; node_id: string }>(
      `select usage, node_id from public.container_runtime_state where container_entity_id = $1`,
      [id],
    );
    expect(state[0]).toMatchObject({ node_id: NODE_ID });
    expect(state[0]!.usage.cpuPct).toBe(4);
  });

  it('DOES bump the version when a surface comes live, because that is a real change', async () => {
    const id = await createContainer({ title: 'Surfaced' });
    const before = await versionOf(id);

    await asApp(fixture.identityId, (q) =>
      q(`select public.record_container_surfaces($1,$2::jsonb)`, [
        id,
        JSON.stringify({ screen: { live: true, port: 5900 } }),
      ]));

    expect(await versionOf(id)).toBeGreaterThan(before);
  });
});

describe('edge kind validation', () => {
  it('accepts the five registered pairs and refuses the reverses', async () => {
    const container = await createContainer({ title: 'Wired' });
    const other = await createContainer({ title: 'Wired template' });

    const sessionId = (await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const row = (await client.query<{ id: string }>(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values(internal.new_id(),$1,'work_session',null,9,$2) returning id`,
        [fixture.spaceId, fixture.memberId],
      )).rows[0]!;
      await client.query(
        `insert into public.work_sessions(entity_id,title,node_id,workdir_mode,status,session_kind)
         values($1,'S',$2,'scratch','running','shell')`,
        [row.id, NODE_ID],
      );
      return row.id;
    }));

    const writeEdge = (src: string, dst: string, type: string) =>
      database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(
          `insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,$4,$5)`,
          [fixture.spaceId, src, dst, type, fixture.memberId],
        );
      });

    await expect(writeEdge(sessionId, container, 'runs_in')).resolves.toBeUndefined();
    await expect(writeEdge(sessionId, container, 'drives')).resolves.toBeUndefined();
    await expect(writeEdge(container, fixture.projectEntityId, 'mounts')).resolves.toBeUndefined();
    await expect(writeEdge(container, other, 'snapshot_of')).resolves.toBeUndefined();
    await expect(writeEdge(fixture.teamMemberId, container, 'controls')).resolves.toBeUndefined();

    // Reversed endpoints are refused by `internal.validate_edge` (001:778).
    await expect(writeEdge(container, sessionId, 'runs_in')).rejects.toMatchObject({ code: '23514' });
    await expect(writeEdge(fixture.projectEntityId, container, 'mounts')).rejects.toMatchObject({ code: '23514' });
    await expect(writeEdge(container, fixture.teamMemberId, 'controls')).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses a snapshot_of cycle, because a fork chain that loops has no origin', async () => {
    const a = await createContainer({ title: 'Cycle a' });
    const b = await createContainer({ title: 'Cycle b' });
    const writeEdge = (src: string, dst: string) =>
      database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(
          `insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'snapshot_of',$4)`,
          [fixture.spaceId, src, dst, fixture.memberId],
        );
      });
    await writeEdge(a, b);
    await expect(writeEdge(b, a)).rejects.toMatchObject({ code: '23514' });
  });

  it('record_container_drive writes the drives edge exactly once', async () => {
    const container = await createContainer({ title: 'Driven' });
    const sessionId = (await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const row = (await client.query<{ id: string }>(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values(internal.new_id(),$1,'work_session',null,10,$2) returning id`,
        [fixture.spaceId, fixture.memberId],
      )).rows[0]!;
      await client.query(
        `insert into public.work_sessions(entity_id,title,node_id,workdir_mode,status,session_kind)
         values($1,'D',$2,'scratch','running','agent')`,
        [row.id, NODE_ID],
      );
      return row.id;
    }));

    // Called per action by a real driver; an edge write fires ~15 triggers, so
    // "exactly once" is the whole point of the door.
    for (let i = 0; i < 4; i += 1) {
      await asApp(fixture.identityId, (q) =>
        q(`select public.record_container_drive($1,$2)`, [sessionId, container]));
    }

    const rows = await database.query<{ n: string }>(
      `select count(*)::text n from public.edges
        where src_id = $1 and dst_id = $2 and type = 'drives'`,
      [sessionId, container],
    );
    expect(rows[0]!.n).toBe('1');
  });
});

describe('RLS — two users, two spaces', () => {
  it('hides a container from a member of another space', async () => {
    const id = await createContainer({ title: 'Private machine' });

    const mine = await asApp(fixture.identityId, (q) =>
      q(`select entity_id from public.containers where entity_id = $1`, [id]));
    expect(mine).toHaveLength(1);

    // Not "returns an error" — RETURNS NOTHING. RLS is a filter, and a stranger
    // must not even learn the row exists.
    const theirs = await asApp(fixture.strangerIdentityId, (q) =>
      q(`select entity_id from public.containers where entity_id = $1`, [id]));
    expect(theirs).toHaveLength(0);
  });

  it('refuses a create into a space the caller is not a member of', async () => {
    await expect(
      createContainer({ identityId: fixture.strangerIdentityId, spaceId: fixture.spaceId }),
    ).rejects.toThrow();
  });

  it('hides the operational side tables from a stranger too', async () => {
    const id = await createContainer({ title: 'Private runtime' });
    await asApp(fixture.identityId, (q) =>
      q(`select public.record_container_heartbeat($1,$2,'{}'::jsonb,'{}'::jsonb)`, [id, NODE_ID]));

    const mine = await asApp(fixture.identityId, (q) =>
      q(`select container_entity_id from public.container_runtime_state where container_entity_id = $1`, [id]));
    expect(mine).toHaveLength(1);

    const theirs = await asApp(fixture.strangerIdentityId, (q) =>
      q(`select container_entity_id from public.container_runtime_state where container_entity_id = $1`, [id]));
    expect(theirs).toHaveLength(0);
  });

  it('grants tm8_app no write path to the detail table', async () => {
    const id = await createContainer({ title: 'Read only' });
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`update public.containers set title = 'hacked' where entity_id = $1`, [id])),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('node_containers and sweep_containers', () => {
  it('returns this node rows with the runtime facts joined', async () => {
    const id = await createContainer({ title: 'On this node' });
    await asApp(fixture.identityId, (q) =>
      q(`select public.record_container_heartbeat($1,$2,'{}'::jsonb,'{}'::jsonb)`, [id, NODE_ID]));

    const rows = await asApp(fixture.identityId, (q) =>
      q(`select * from public.node_containers($1) where container_entity_id = $2`, [NODE_ID, id]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ node_id: NODE_ID, status: 'requested', entity_exists: true, deleted: false });
    expect(rows[0]!['last_seen_at']).not.toBeNull();

    const elsewhere = await asApp(fixture.identityId, (q) =>
      q(`select * from public.node_containers($1)`, ['some-other-node:1']));
    expect(elsewhere.every((r) => r['container_entity_id'] !== id)).toBe(true);
  });

  it('reports an expired ephemeral machine as due for destroy, and a persistent one for stop', async () => {
    const ephemeral = await createContainer({ title: 'TTL ephemeral', lifecycle: { ephemeral: true } });
    const persistent = await createContainer({ title: 'TTL persistent', lifecycle: { ephemeral: false } });
    for (const id of [ephemeral, persistent]) {
      await setStatus(id, 'provisioning');
      await setStatus(id, 'running');
    }
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `update public.containers set expires_at = now() - interval '1 minute'
          where entity_id = any($1::uuid[])`,
        [[ephemeral, persistent]],
      );
    });

    const due = await asApp(fixture.identityId, (q) =>
      q(`select * from public.sweep_containers($1, now())`, [NODE_ID]));
    const byId = new Map(due.map((r) => [r['container_entity_id'] as string, r]));
    expect(byId.get(ephemeral)).toMatchObject({ action: 'destroy', reason: 'ttl' });
    expect(byId.get(persistent)).toMatchObject({ action: 'stop', reason: 'ttl' });
  });

  it('leaves a machine with no deadline and no idle policy alone', async () => {
    const id = await createContainer({ title: 'Quiet' });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running');
    const due = await asApp(fixture.identityId, (q) =>
      q(`select * from public.sweep_containers($1, now())`, [NODE_ID]));
    expect(due.some((r) => r['container_entity_id'] === id)).toBe(false);
  });

  it('never reports two actions for one machine', async () => {
    const due = await asApp(fixture.identityId, (q) =>
      q(`select * from public.sweep_containers($1, now())`, [NODE_ID]));
    const ids = due.map((r) => r['container_entity_id'] as string);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('surface grants', () => {
  async function runningWithScreen(title: string): Promise<string> {
    const id = await createContainer({ title });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running', { surfaces: { screen: { live: true, port: 5900 } } });
    return id;
  }

  const HASH_A = 'a'.repeat(64);
  const HASH_B = 'b'.repeat(64);

  /**
   * A distinct hash per test. 087's `stream_grants_token_hash_live_idx` is
   * UNIQUE on `token_hash` across the WHOLE table while `revoked_at is null` —
   * not per session and not per container — so reusing one literal across two
   * live grants is a duplicate-key error rather than a container bug. That
   * global uniqueness is the invariant that stops one leaked bearer opening a
   * second machine, so the test bends and the index does not.
   */
  let hashSeq = 0;
  const freshHash = (): string => {
    hashSeq += 1;
    return hashSeq.toString(16).padStart(64, 'd');
  };

  it('mints a single-use grant and consumes it exactly once', async () => {
    const id = await runningWithScreen('Screened');

    const granted = await asApp(fixture.identityId, (q) =>
      q(`select public.grant_surface_attach($1,'screen','view',$2,interval '30 seconds',false) g`, [id, HASH_A]));
    expect((granted[0]!.g as { grantId: string }).grantId).toBeTruthy();

    const consumed = await asApp(fixture.identityId, (q) =>
      q(`select public.consume_surface_attach($1,'screen','view',$2) c`, [id, HASH_A]));
    expect(consumed[0]!.c).toMatchObject({ surface: 'screen', mode: 'view', canDrive: false });

    // Replay of a consumed single-use grant is refused, and refused with the
    // SAME message every other failure gives.
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.consume_surface_attach($1,'screen','view',$2)`, [id, HASH_A])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a grant to a surface the machine never announced', async () => {
    const id = await runningWithScreen('No browser here');
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.grant_surface_attach($1,'browser','view',$2,interval '30 seconds',false)`, [id, freshHash()])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses a grant on a machine that is not running', async () => {
    const id = await createContainer({ title: 'Not up' });
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.grant_surface_attach($1,'screen','view',$2,interval '30 seconds',false)`, [id, HASH_A])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('gives every credential failure the same refusal', async () => {
    const id = await runningWithScreen('Opaque');
    await asApp(fixture.identityId, (q) =>
      q(`select public.grant_surface_attach($1,'screen','view',$2,interval '30 seconds',false)`, [id, HASH_A]));

    // Wrong hash, wrong surface, wrong mode, unknown container: one message.
    for (const args of [
      [id, 'screen', 'view', HASH_B],
      [id, 'adb', 'view', HASH_A],
      [id, 'screen', 'drive', HASH_A],
    ] as const) {
      await expect(
        asApp(fixture.identityId, (q) =>
          q(`select public.consume_surface_attach($1,$2,$3,$4)`, [...args])),
      ).rejects.toThrow(/surface attach refused/);
    }
  });

  it('keeps a multi-use CDP grant alive across two dials and clamps it to an hour', async () => {
    const id = await createContainer({ title: 'CDP' });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running', { surfaces: { browser: { live: true, port: 9222 } } });

    const granted = await asApp(fixture.identityId, (q) =>
      q(`select public.grant_surface_attach($1,'browser','view',$2,interval '9 hours',true) g`, [id, HASH_B]));
    const expiresAt = new Date((granted[0]!.g as { expiresAt: string }).expiresAt).getTime();
    // Clamped to 1 h, not the 9 h asked for.
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(3_600_000 + 60_000);

    // Playwright dials once over HTTP and once over WS: both must succeed.
    for (let i = 0; i < 2; i += 1) {
      const consumed = await asApp(fixture.identityId, (q) =>
        q(`select public.consume_surface_attach($1,'browser','view',$2) c`, [id, HASH_B]));
      expect(consumed[0]!.c).toMatchObject({ surface: 'browser' });
    }
  });

  it('holds an ordinary grant to 60 seconds however long a TTL is asked for', async () => {
    const id = await runningWithScreen('Clamped');
    const granted = await asApp(fixture.identityId, (q) =>
      q(`select public.grant_surface_attach($1,'screen','view',$2,interval '9 hours',false) g`, [id, freshHash()]));
    const expiresAt = new Date((granted[0]!.g as { expiresAt: string }).expiresAt).getTime();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000 + 5_000);
  });

  it('stores only the hash — the bearer never lands', async () => {
    const id = await runningWithScreen('Hashed');
    await asApp(fixture.identityId, (q) =>
      q(`select public.grant_surface_attach($1,'screen','view',$2,interval '30 seconds',false)`, [id, freshHash()]));
    const rows = await database.query<{ token_hash: string }>(
      `select token_hash from public.stream_grants where container_entity_id = $1`,
      [id],
    );
    expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('keeps exactly one subject per grant row', async () => {
    await expect(
      database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        await client.query(
          `insert into public.stream_grants(subject_identity,mode,granted_by,token_hash,expires_at)
           values($1,'view',$2,$3,now() + interval '30 seconds')`,
          [fixture.identityId, fixture.memberId, 'c'.repeat(64)],
        );
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('container_exec sessions', () => {
  it('starts a terminal bound to the machine by a runs_in edge', async () => {
    const id = await createContainer({ title: 'Execable', spec: { workdir: '/srv/app' } });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running');

    const rows = await asApp(fixture.identityId, (q) =>
      q(`select public.start_container_exec_session($1,'Shell',$2,80,24,8,$3) r`, [
        id,
        fixture.memberId,
        cmid('exec'),
      ]));
    const result = rows[0]!.r as { sessionId: string; cols: number; rows: number };
    expect(result.cols).toBe(80);
    expect(result.rows).toBe(24);

    const session = await database.query<{
      session_kind: string; workdir_mode: string; workdir_path: string; node_id: string; agent_tool: string | null;
    }>(
      `select session_kind, workdir_mode, workdir_path, node_id, agent_tool
         from public.work_sessions where entity_id = $1`,
      [result.sessionId],
    );
    expect(session[0]).toMatchObject({
      session_kind: 'container_exec',
      workdir_mode: 'container',
      // Read off the MACHINE, never accepted from the caller.
      workdir_path: '/srv/app',
      node_id: NODE_ID,
      agent_tool: null,
    });

    const edge = await database.query<{ type: string }>(
      `select type from public.edges where src_id = $1 and dst_id = $2`,
      [result.sessionId, id],
    );
    expect(edge).toEqual([{ type: 'runs_in' }]);
  });

  it('defaults the working directory to /workspace when the spec names none', async () => {
    const id = await createContainer({ title: 'No workdir' });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running');
    const rows = await asApp(fixture.identityId, (q) =>
      q(`select public.start_container_exec_session($1,null,$2,null,null,8,$3) r`, [
        id,
        fixture.memberId,
        cmid('exec-default'),
      ]));
    const sessionId = (rows[0]!.r as { sessionId: string }).sessionId;
    const session = await database.query<{ workdir_path: string; title: string }>(
      `select workdir_path, title from public.work_sessions where entity_id = $1`,
      [sessionId],
    );
    expect(session[0]).toMatchObject({ workdir_path: '/workspace', title: 'Terminal' });
  });

  it('refuses to exec into a machine that is not running', async () => {
    const id = await createContainer({ title: 'Down' });
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.start_container_exec_session($1,null,$2,null,null,8,$3)`, [
          id,
          fixture.memberId,
          cmid('exec-down'),
        ])),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('refuses past its own cap with 53400 without touching the agent cap', async () => {
    const id = await createContainer({ title: 'Capped' });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running');

    // The cap is per NODE, and earlier tests in this file have already started
    // exec terminals on it. A literal `1` here would be refused on the FIRST
    // call and the test would pass for the wrong reason — it would never prove
    // that one more is allowed before the cap bites.
    const live = Number(
      (await database.query<{ n: number }>(`select internal.container_exec_session_count($1) n`, [NODE_ID]))[0]!.n,
    );
    const cap = live + 1;

    await asApp(fixture.identityId, (q) =>
      q(`select public.start_container_exec_session($1,null,$2,null,null,$3,$4)`, [
        id,
        fixture.memberId,
        cap,
        cmid('exec-cap-1'),
      ]));
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.start_container_exec_session($1,null,$2,null,null,$3,$4)`, [
          id,
          fixture.memberId,
          cap,
          cmid('exec-cap-2'),
        ])),
    ).rejects.toMatchObject({ code: '53400' });
  });

  it('counts exec sessions disjointly from agent sessions', async () => {
    // The whole reason live_work_session_count keeps its `= 'agent'` filter: a
    // wall of exec terminals must never make a real spawn answer "cap reached".
    //
    // Asserted as a DELTA, not as an absolute. Other tests in this file create
    // an agent session of their own, so pinning the agent count at zero would
    // couple this test to their bookkeeping and would pass or fail for reasons
    // that have nothing to do with disjointness.
    const agentBefore = Number(
      (await database.query<{ n: number }>(`select internal.live_work_session_count(null) n`))[0]!.n,
    );

    const id = await createContainer({ title: 'Disjoint' });
    await setStatus(id, 'provisioning');
    await setStatus(id, 'running');
    await asApp(fixture.identityId, (q) =>
      q(`select public.start_container_exec_session($1,null,$2,null,null,99,$3)`, [
        id,
        fixture.memberId,
        cmid('exec-disjoint'),
      ]));

    const agentAfter = Number(
      (await database.query<{ n: number }>(`select internal.live_work_session_count(null) n`))[0]!.n,
    );
    const execAfter = Number(
      (await database.query<{ n: number }>(`select internal.container_exec_session_count($1) n`, [NODE_ID]))[0]!.n,
    );

    // A new exec terminal moved the exec count and left the agent count alone.
    expect(execAfter).toBeGreaterThan(0);
    expect(agentAfter).toBe(agentBefore);
  });

  it('counts an exec terminal in the rail, because a member started it and expects to find it', async () => {
    const counts = await asApp(fixture.identityId, (q) =>
      q(`select kind, total from public.space_kind_counts($1) where kind = 'work_session'`, [fixture.spaceId]));
    expect(Number(counts[0]!['total'])).toBeGreaterThan(0);
  });

  it('counts containers in the rail with no migration change to space_kind_counts', async () => {
    const counts = await asApp(fixture.identityId, (q) =>
      q(`select kind, total from public.space_kind_counts($1) where kind = 'container'`, [fixture.spaceId]));
    expect(Number(counts[0]!['total'])).toBeGreaterThan(0);
  });
});

describe('work_session_transition learns the two container endings', () => {
  it('accepts container_stopped and runtime_lost', async () => {
    for (const endedKind of ['container_stopped', 'runtime_lost']) {
      const sessionId = (await database.transaction(async (client) => {
        await client.query('set local role tm8_graph_owner');
        const row = (await client.query<{ id: string }>(
          `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
           values(internal.new_id(),$1,'work_session',null,20,$2) returning id`,
          [fixture.spaceId, fixture.memberId],
        )).rows[0]!;
        await client.query(
          `insert into public.work_sessions(entity_id,title,node_id,workdir_mode,status,session_kind)
           values($1,'E',$2,'container','running','container_exec')`,
          [row.id, NODE_ID],
        );
        return row.id;
      }));

      await asApp(fixture.identityId, (q) =>
        q(`select public.work_session_transition($1,'exited',null,null,null,$2,$3,'The machine stopped.')`, [
          sessionId,
          cmid(`end-${endedKind}`),
          endedKind,
        ]));

      const rows = await database.query<{ ended_kind: string }>(
        `select ended_kind from public.work_sessions where entity_id = $1`,
        [sessionId],
      );
      expect(rows[0]!.ended_kind).toBe(endedKind);
    }
  });

  it('still refuses an ending it has never heard of', async () => {
    const sessionId = (await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const row = (await client.query<{ id: string }>(
        `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
         values(internal.new_id(),$1,'work_session',null,21,$2) returning id`,
        [fixture.spaceId, fixture.memberId],
      )).rows[0]!;
      await client.query(
        `insert into public.work_sessions(entity_id,title,node_id,workdir_mode,status,session_kind)
         values($1,'E',$2,'container','running','container_exec')`,
        [row.id, NODE_ID],
      );
      return row.id;
    }));

    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.work_session_transition($1,'exited',null,null,null,$2,'vaporised',null)`, [
          sessionId,
          cmid('end-bogus'),
        ])),
    ).rejects.toMatchObject({ code: '22023' });
  });
});

describe('exposed ports', () => {
  it('records a port and refuses a link share with no credential', async () => {
    const id = await createContainer({ title: 'Serving' });

    const v0 = await versionOf(id);
    await asApp(fixture.identityId, (q) =>
      q(`select public.expose_container_port($1,$2,8080,'space',null,$3,$4)`, [
        id,
        v0,
        fixture.memberId,
        cmid('expose'),
      ]));

    const rows = await database.query<{ port: number; share: string }>(
      `select port, share from public.container_exposures where container_entity_id = $1`,
      [id],
    );
    expect(rows).toEqual([{ port: 8080, share: 'space' }]);

    // A link share with nothing to check is a public port wearing a private label.
    const v1 = await versionOf(id);
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.expose_container_port($1,$2,9090,'link',null,$3,$4)`, [
          id,
          v1,
          fixture.memberId,
          cmid('expose-link'),
        ])),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('refuses a port outside 1..65535', async () => {
    const id = await createContainer({ title: 'Bad port' });
    const version = await versionOf(id);
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.expose_container_port($1,$2,70000,'none',null,$3,$4)`, [
          id,
          version,
          fixture.memberId,
          cmid('expose-bad'),
        ])),
    ).rejects.toMatchObject({ code: '22023' });
  });

  it('unexposes what it exposed', async () => {
    const id = await createContainer({ title: 'Retracted' });
    const beforeExpose = await versionOf(id);
    await asApp(fixture.identityId, (q) =>
      q(`select public.expose_container_port($1,$2,3000,'none',null,$3,$4)`, [
        id,
        beforeExpose,
        fixture.memberId,
        cmid('expose-3000'),
      ]));
    const beforeUnexpose = await versionOf(id);
    await asApp(fixture.identityId, (q) =>
      q(`select public.unexpose_container_port($1,$2,3000,$3,$4)`, [
        id,
        beforeUnexpose,
        fixture.memberId,
        cmid('unexpose-3000'),
      ]));
    const rows = await database.query(
      `select port from public.container_exposures where container_entity_id = $1`,
      [id],
    );
    expect(rows).toHaveLength(0);
  });
});
