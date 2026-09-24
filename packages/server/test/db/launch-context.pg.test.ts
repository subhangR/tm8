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
                internal.new_id()::text "foreignTask", gen_random_uuid()::text "run"`,
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
    await client.query(`update public.entities set deleted_at = now() where id = $1`, [ids.deletedMemory]);
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
      agent: { memory: ['picked memory', 'gone memory', 'legacy jsonb entry'] },
      launch: { jevRunId: fixture.run },
      context: { memoryIds: [fixture.memory, fixture.deletedMemory] },
      tasks: [{ id: fixture.foreignTask, title: 'Secret task title' }],
      coordinator: { sessionId: fixture.coordinator, kind: 'work_session' },
    };
    const result = await projectLaunchContext(appDb(), { identityId: fixture.memberIdentity }, manifest);

    expect(result.entries).toEqual([
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

  it('shows every memory as text when the manifest predates memory ids', async () => {
    const result = await projectLaunchContext(
      appDb(),
      { identityId: fixture.memberIdentity },
      { agent: { memory: ['one', 'two'] } },
    );
    expect(result).toEqual({ entries: [], hiddenCount: 0, unlinkedMemories: ['one', 'two'] });
  });

  it('gives a viewer outside the space no names and no Jev ratings', async () => {
    const result = await projectLaunchContext(
      appDb(),
      { identityId: fixture.strangerIdentity },
      {
        launch: { jevRunId: fixture.run },
        context: { memoryIds: [fixture.memory] },
        coordinator: { sessionId: fixture.coordinator },
      },
    );
    expect(result.entries).toEqual([]);
    expect(result.hiddenCount).toBe(2);
  });
});
