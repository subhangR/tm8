/**
 * WHO IS RUNNING THIS SESSION, on the summary.
 *
 * `state.teammate` resolves through the SAME `participates_in` hop that
 * attributes a session's messages, so the two can never disagree about who a
 * run belongs to. Both halves are asserted here because they are different
 * claims and only one of them is the happy path: an ATTRIBUTED session names
 * its persona, and an UNATTRIBUTED one — a human at a terminal — projects
 * `null` rather than a placeholder actor that a renderer would draw as an
 * agent nobody spawned.
 */
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Querier } from '../../src/db/types.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const IDENTITY = 'session-teammate-owner';

interface Fixture {
  spaceId: string;
  memberId: string;
  personaId: string;
  attributedSessionId: string;
  bareSessionId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asApp<T>(fn: (q: Querier) => Promise<T>): Promise<T> {
  return database.transaction(async (client: PoolClient) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'session-teammate-pg', true)`,
      [IDENTITY],
    );
    const q: Querier = {
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async <T2>(fnName: string, args: readonly unknown[] = []): Promise<T2> => {
        const placeholders = args.map((_, index) => `$${index + 1}`).join(', ');
        const result = await client.query(`select public.${fnName}(${placeholders}) result`, [...args]);
        return result.rows[0]?.result as T2;
      },
    };
    return fn(q);
  });
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client: PoolClient) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (await client.query<{
      space_id: string;
      member_id: string;
      persona_id: string;
      attributed_id: string;
      bare_id: string;
    }>(
      `select internal.new_id() space_id,
              internal.new_id() member_id,
              internal.new_id() persona_id,
              internal.new_id() attributed_id,
              internal.new_id() bare_id`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Session owner')`,
      [IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Session teammate', $2)`,
      [ids.space_id, IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $2, 'member', 0, $1),
       ($3, $2, 'team_member', 1, $1),
       ($4, $2, 'work_session', 2, $1),
       ($5, $2, 'work_session', 3, $1)`,
      [ids.member_id, ids.space_id, ids.persona_id, ids.attributed_id, ids.bare_id],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Session owner')`,
      [ids.member_id, ids.space_id, IDENTITY],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role)
       values ($1, $2, 'Fable', 'engineer')`,
      [ids.persona_id, ids.member_id],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, agent_tool, share_mode, started_at)
       values ($1, 'Attributed run', 'running', 'claude-code', 'none', now()),
              ($2, 'Bare terminal', 'running', null, 'none', now())`,
      [ids.attributed_id, ids.bare_id],
    );
    await client.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by)
       values ($1, $2, $3, 'participates_in', $2)`,
      [ids.space_id, ids.persona_id, ids.attributed_id],
    );

    return {
      spaceId: ids.space_id,
      memberId: ids.member_id,
      personaId: ids.persona_id,
      attributedSessionId: ids.attributed_id,
      bareSessionId: ids.bare_id,
    };
  });
}

describe.sequential('a work_session summary names its teammate', () => {
  beforeAll(async () => {
    database = await createW1ScratchDatabase('session_teammate');
    database.apply(migrationFiles());
    fixture = await seed();
  }, 180_000);

  afterAll(async () => {
    await database?.destroy();
  }, 30_000);

  it('projects the persona from participates_in, and null where there is none', async () => {
    const summaries = await asApp((q) =>
      loadEntitySummariesByIds(q, [fixture.attributedSessionId, fixture.bareSessionId], IDENTITY),
    );
    const byId = new Map(summaries.map((s) => [s.id, s]));

    const attributed = byId.get(fixture.attributedSessionId)?.state;
    expect(attributed?.kind).toBe('work_session');
    if (attributed?.kind !== 'work_session') throw new Error('unreachable');
    expect(attributed.teammate).toEqual({
      id: fixture.personaId,
      kind: 'team_member',
      displayName: 'Fable',
      avatar: null,
      role: null,
      ownerMemberId: fixture.memberId,
      isAgent: true,
      via: { sessionId: fixture.attributedSessionId },
    });

    const bare = byId.get(fixture.bareSessionId)?.state;
    if (bare?.kind !== 'work_session') throw new Error('unreachable');
    // NOT `unknownActor`: nobody failed to resolve here, there is simply no
    // persona, and a placeholder would be a person this run never had.
    expect(bare.teammate).toBeNull();
  });
});
