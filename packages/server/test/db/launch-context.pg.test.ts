/**
 * `projectLaunchContext` — the Connections tab's LAUNCH CONTEXT section, proved
 * against a REAL PostgreSQL, because what it promises is an RLS property:
 *
 *   · every entity the manifest names is read under the VIEWER's claims, so an
 *     entity they cannot read (another space) or one since deleted is counted
 *     in `hiddenCount` and never named;
 *   · titles and kinds come from that read, not from the manifest;
 *   · the Jev level comes from the launch's `jev_runs` row, and a suggested
 *     memory is badged `jev`;
 *   · `unlinkedMemories` is the id-less tail of `agent.memory` when ids are
 *     recorded, and all of it when they are not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import { projectLaunchContext } from '../../src/facade/launch-context.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  memberIdentity: string;
  strangerIdentity: string;
  space: string;
  otherSpace: string;
  member: string;
  stranger: string;
  session: string;
  coordinator: string;
  memory: string;
  deletedMemory: string;
  foreignTask: string;
  run: string;
  teammate: string;
  taskA: string;
  taskB: string;
  doc: string;
  file: string;
  skillNative: string;
  skillIndexed: string;
  mTeammate: string;
  mTask: string;
  mForeignTask: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

/** A `Db` whose reads run as `tm8_app` under the given identity, like the facade's. */
function appDb(): Db {
  return {
    query: <R>(claims: DbClaims, sql: string, params?: readonly unknown[]) =>
      database.transaction(async (client) => {
        await client.query('set local role tm8_app');
        await client.query(
          `select set_config('tm8.identity_id', $1, true),
                  set_config('tm8.actor_id', '', true),
                  set_config('tm8.node_admin', 'false', true),
                  set_config('tm8.request_id', 'req-launch-context', true),
                  set_config('tm8.auth_kind', 'browser', true)`,
          [claims.identityId ?? ''],
        );
        return (await client.query(sql, params as unknown[])).rows as R[];
      }),
  } as unknown as Db;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('launch_context');
  database.apply(migrationFiles());
  fixture = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (
      await client.query<Fixture>(
        `select 'lc-member'::text "memberIdentity", 'lc-stranger'::text "strangerIdentity",
                internal.new_id()::text "space", internal.new_id()::text "otherSpace",
                internal.new_id()::text "member", internal.new_id()::text "stranger",
                internal.new_id()::text "session", internal.new_id()::text "coordinator",
                internal.new_id()::text "memory", internal.new_id()::text "deletedMemory",
                internal.new_id()::text "foreignTask", gen_random_uuid()::text "run",
                internal.new_id()::text "teammate", internal.new_id()::text "taskA",
                internal.new_id()::text "taskB", internal.new_id()::text "doc",
                internal.new_id()::text "file", internal.new_id()::text "skillNative",
                internal.new_id()::text "skillIndexed", internal.new_id()::text "mTeammate",
                internal.new_id()::text "mTask", internal.new_id()::text "mForeignTask"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Member'), ($2, 'Stranger')`,
      [ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'lc-member', 'Member', false, true),
              ($2, 'lc-stranger', 'Stranger', false, false)`,
      [ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Launch', $3), ($2, 'Elsewhere', $4)`,
      [ids.space, ids.otherSpace, ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($2, $1, 'member', 0, $2),
              ($3, $1, 'work_session', 1, $2),
              ($4, $1, 'work_session', 2, $2),
              ($5, $1, 'memory', 3, $2),
              ($6, $1, 'memory', 4, $2),
              ($8, $7, 'member', 0, $8),
              ($9, $7, 'task', 1, $8)`,
      [ids.space, ids.member, ids.session, ids.coordinator, ids.memory, ids.deletedMemory,
        ids.otherSpace, ids.stranger, ids.foreignTask],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Member'), ($4, $5, $6, 'owner', 'Stranger')`,
      [ids.member, ids.space, ids.memberIdentity, ids.stranger, ids.otherSpace, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, workdir_mode)
       values ($1, 'Launched session', 'running', 'project'),
              ($2, 'Coordinator session', 'running', 'project')`,
      [ids.session, ids.coordinator],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       select id, $1, kind, 10, $2 from unnest($3::uuid[], $4::text[]) as x(id, kind)`,
      [ids.space, ids.member,
        [ids.teammate, ids.taskA, ids.taskB, ids.doc, ids.file, ids.skillNative, ids.skillIndexed,
          ids.mTeammate, ids.mTask, ids.mForeignTask],
        ['team_member', 'task', 'task', 'doc', 'file', 'skill', 'skill', 'memory', 'memory', 'memory']],
    );
    await client.query(
      `insert into public.memories(entity_id, statement, mechanism, subject_scope, does_not_establish)
       values ($1, 'The teammate remembers this', 'seed', 'scratch', 'runtime'),
              ($2, 'A task remembers this', 'seed', 'scratch', 'runtime'),
              ($3, 'Only a hidden task remembers this', 'seed', 'scratch', 'runtime')`,
      [ids.mTeammate, ids.mTask, ids.mForeignTask],
    );
    await client.query(
      `insert into public.skills(entity_id, space_id, name, description)
       values ($1, $3, 'deploy', 'deploy help'), ($2, $3, 'review', 'review help')`,
      [ids.skillNative, ids.skillIndexed, ids.space],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
       values ($1, $3, $4, 'remembers', '{}'::jsonb, $2),
              ($1, $5, $6, 'remembers', '{}'::jsonb, $2)`,
      [ids.space, ids.member, ids.teammate, ids.mTeammate, ids.taskA, ids.mTask],
    );
    // A task in this space that remembers a memory and is then deleted: the
    // edge exists, but the viewer can no longer read the task it names.
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
       values ($1, $3, $4, 'remembers', '{}'::jsonb, $2)`,
      [ids.space, ids.member, ids.taskB, ids.mForeignTask],
    );
    await client.query(`update public.entities set deleted_at = now() where id = any($1::uuid[])`, [[ids.deletedMemory, ids.taskB]]);
    await client.query(
      `insert into public.jev_runs(id, space_id, subject_id, requested_by, session_id, suggestions)
       values ($1, $2, $3, $4, $3, $5::jsonb)`,
      [ids.run, ids.space, ids.session, ids.memberIdentity, JSON.stringify({
        memories: { status: 'ok', items: [{ id: ids.memory, score: 3, level: 'critical', suggested: true }] },
      })],
    );
    return ids;
  });
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('projectLaunchContext', () => {
  it('names what the viewer can read, counts the rest, and badges the Jev pick', async () => {
    const manifest = {
      agent: { teamMemberId: fixture.teammate, memory: ['picked memory', 'gone memory', 'legacy jsonb entry'] },
      launch: { jevRunId: fixture.run },
      context: { memoryIds: [fixture.memory, fixture.deletedMemory] },
      tasks: [{ id: fixture.foreignTask, title: 'Secret task title' }],
      coordinator: { sessionId: fixture.coordinator, kind: 'work_session' },
    };
    const result = await projectLaunchContext(appDb(), { identityId: fixture.memberIdentity }, manifest);

    expect(result.entries.map((e) => e.role)).toEqual(['teammate', 'memory', 'coordinator']);
    expect(result.entries.slice(1)).toEqual([
      {
        entityId: fixture.memory, role: 'memory', kind: 'memory', title: 'memory',
        source: 'jev', viaTaskId: null, skillLoad: null, jev: { level: 'critical', score: 3 },
      },
      {
        entityId: fixture.coordinator, role: 'coordinator', kind: 'work_session',
        title: 'Coordinator session', source: 'launch', viaTaskId: null, skillLoad: null, jev: null,
      },
    ]);
    // The other space's task and the deleted memory.
    expect(result.hiddenCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain('Secret task title');
    expect(JSON.stringify(result)).not.toContain(fixture.foreignTask);
    expect(result.unlinkedMemories).toEqual(['legacy jsonb entry']);
  });

  it('shows every memory as text when the manifest predates memory ids, if the viewer can read the teammate', async () => {
    const result = await projectLaunchContext(
      appDb(),
      { identityId: fixture.memberIdentity },
      { agent: { teamMemberId: fixture.teammate, memory: ['one', 'two'] } },
    );
    expect(result.unlinkedMemories).toEqual(['one', 'two']);
    expect(result.hiddenCount).toBe(0);
  });

  it('counts text-only memories instead of showing them when the teammate is unreadable', async () => {
    const result = await projectLaunchContext(
      appDb(),
      { identityId: fixture.memberIdentity },
      { agent: { teamMemberId: fixture.stranger, memory: ['secret one', 'secret two'] } },
    );
    expect(result).toEqual({ entries: [], hiddenCount: 3, unlinkedMemories: [] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('names skills, task references and attachments, with real titles and sources, once each', async () => {
    const result = await projectLaunchContext(appDb(), { identityId: fixture.memberIdentity }, {
      agent: { teamMemberId: fixture.teammate, memory: [] },
      context: { memoryIds: [fixture.mTeammate, fixture.mTask, fixture.mForeignTask] },
      tasks: [
        {
          id: fixture.taskA,
          linked: [{ entityId: fixture.doc, kind: 'doc', link: 'relates_to', title: 'x' }],
          attachments: [{ fileEntityId: fixture.file, name: 'f', mime: 'text/plain' }],
        },
        // Carries the same doc: still one row, through the first task.
        { id: fixture.foreignTask, linked: [{ entityId: fixture.doc, kind: 'doc', link: 'relates_to', title: 'x' }] },
        // Deleted since the launch, and the only task that remembers mForeignTask.
        { id: fixture.taskB },
      ],
      effectiveSkills: {
        native: [{ entityId: fixture.skillNative, viaTaskId: fixture.taskA }],
        indexed: [{ entityId: fixture.skillIndexed }],
        skipped: [],
      },
    });
    const byId = new Map(result.entries.map((e) => [e.entityId, e]));
    expect(byId.get(fixture.mTeammate)).toMatchObject({ title: 'The teammate remembers this', source: 'teammate' });
    expect(byId.get(fixture.mTask)).toMatchObject({ title: 'A task remembers this', source: 'task' });
    // Its only remembering task was deleted, so it is not credited to a task.
    expect(byId.get(fixture.mForeignTask)).toMatchObject({ source: 'requested' });
    expect(byId.get(fixture.skillNative)).toMatchObject({
      title: 'deploy', role: 'skill', skillLoad: 'native', source: 'task', viaTaskId: fixture.taskA,
    });
    expect(byId.get(fixture.skillIndexed)).toMatchObject({ title: 'review', skillLoad: 'indexed', source: 'teammate' });
    expect(result.entries.filter((e) => e.entityId === fixture.doc)).toEqual([
      expect.objectContaining({ role: 'reference', source: 'task', viaTaskId: fixture.taskA }),
    ]);
    expect(byId.get(fixture.file)).toMatchObject({ role: 'attachment', viaTaskId: fixture.taskA });
    expect(result.hiddenCount).toBe(2); // the foreign task and the deleted one
  });

  it('gives a viewer outside the space no names and no Jev ratings', async () => {
    const result = await projectLaunchContext(
      appDb(),
      { identityId: fixture.strangerIdentity },
      {
        agent: { teamMemberId: fixture.teammate, memory: ['picked memory', 'legacy'] },
        launch: { jevRunId: fixture.run },
        context: { memoryIds: [fixture.memory] },
        coordinator: { sessionId: fixture.coordinator },
      },
    );
    expect(result.entries).toEqual([]);
    expect(result.unlinkedMemories).toEqual([]);
    // teammate, memory, coordinator, and the one text-only memory.
    expect(result.hiddenCount).toBe(4);
  });
});
