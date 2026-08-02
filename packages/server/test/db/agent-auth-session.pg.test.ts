import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityA: string;
  identityB: string;
  accountA: string;
  accountB: string;
  spaceId: string;
  memberA: string;
  memberB: string;
  personaId: string;
  workSessionId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asApp<T>(identityId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    return fn(client);
  });
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      identityA: 'agent-auth-owner-a',
      identityB: 'agent-auth-owner-b',
      accountA: randomUUID(),
      accountB: randomUUID(),
      spaceId: randomUUID(),
      memberA: randomUUID(),
      memberB: randomUUID(),
      personaId: randomUUID(),
      workSessionId: randomUUID(),
    };
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Owner A'), ($2, 'Owner B')`,
      [ids.identityA, ids.identityB],
    );
    await client.query(
      `insert into public.accounts(id, identity_id, username)
       values ($1, $2, 'agent-auth-a'), ($3, $4, 'agent-auth-b')`,
      [ids.accountA, ids.identityA, ids.accountB, ids.identityB],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Agent auth', $2)`,
      [ids.spaceId, ids.identityA],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $5, 'member', $1, 'space'),
              ($2, $5, 'member', $2, 'space'),
              ($3, $5, 'team_member', $1, 'space'),
              ($4, $5, 'work_session', $3, 'space')`,
      [ids.memberA, ids.memberB, ids.personaId, ids.workSessionId, ids.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $4, 'owner', 'Owner A'),
              ($2, $3, $5, 'member', 'Owner B')`,
      [ids.memberA, ids.memberB, ids.spaceId, ids.identityA, ids.identityB],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Identity Agent', 'worker', 'persona')`,
      [ids.personaId, ids.memberA],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'Agent auth session', 'running', 'none', now())`,
      [ids.workSessionId],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [ids.spaceId, ids.personaId, ids.workSessionId],
    );
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('agent_auth_session');
  database.apply(migrationFiles());
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

describe('072 persona-pinned agent auth sessions', () => {
  it('re-mints on resume, revokes the old token atomically, and resolves the work session', async () => {
    const firstHash = 'a'.repeat(64);
    const secondHash = 'b'.repeat(64);
    const first = await asApp(fixture.identityA, async (client) => {
      const result = await client.query<{ value: { id: string } }>(
        `select public.issue_agent_auth_session($1,$2,$3,now()+interval '1 hour',$4) value`,
        [fixture.workSessionId, fixture.personaId, firstHash, 'first run'],
      );
      return result.rows[0]!.value;
    });

    const resolvedFirst = await asApp(fixture.identityA, async (client) => {
      const result = await client.query<{ value: Record<string, unknown> | null }>(
        `select public.resolve_auth_session($1) value`, [firstHash],
      );
      return result.rows[0]!.value;
    });
    expect(resolvedFirst).toMatchObject({
      sessionId: first.id,
      actingAsTeamMemberId: fixture.personaId,
      workSessionId: fixture.workSessionId,
      kind: 'agent',
    });

    await asApp(fixture.identityA, async (client) => {
      await client.query(
        `select public.issue_agent_auth_session($1,$2,$3,now()+interval '1 hour',$4)`,
        [fixture.workSessionId, fixture.personaId, secondHash, 'resumed run'],
      );
    });

    expect(await asApp(fixture.identityA, async (client) =>
      (await client.query<{ value: unknown }>(
        `select public.resolve_auth_session($1) value`, [firstHash],
      )).rows[0]!.value)).toBeNull();
    const liveCount = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ count: string }>(
        `select count(*)::text count from public.auth_sessions
          where work_session_id=$1 and revoked_at is null`,
        [fixture.workSessionId],
      )).rows[0]!.count;
    });
    expect(liveCount).toBe('1');

    await asApp(fixture.identityA, async (client) => {
      await client.query(`select public.revoke_agent_auth_session($1)`, [fixture.workSessionId]);
    });
    expect(await asApp(fixture.identityA, async (client) =>
      (await client.query<{ value: unknown }>(
        `select public.resolve_auth_session($1) value`, [secondHash],
      )).rows[0]!.value)).toBeNull();
  });

  it('does not let another member mint authority for someone else\'s persona', async () => {
    await expect(asApp(fixture.identityB, async (client) => {
      await client.query(
        `select public.issue_agent_auth_session($1,$2,$3,now()+interval '1 hour',null)`,
        [fixture.workSessionId, fixture.personaId, 'c'.repeat(64)],
      );
    })).rejects.toMatchObject({ code: '42501' });
  });
});
