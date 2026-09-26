/**
 * Status strip — `execution.liveness`'s live-chat counts, against real SQL.
 *
 * Four chats cover every cell of runtime_state x turn state that matters:
 *
 *   live    + queued turn     -> live, working
 *   live    + completed turn  -> live, not working
 *   stopped + queued turn     -> neither (node restarted; the message is still
 *                                coming, but nothing is running it)
 *   cold    + queued turn     -> neither
 *
 * plus a DELETED live chat and a live chat in ANOTHER space, neither of which
 * may count. The negative control runs the same statement with its `live`
 * filter widened and asserts the fixture notices — a count that cannot tell
 * `stopped` from `live` must go red here.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import { LIVE_CHAT_COUNTS_SQL, type LiveChatCountRow } from '../../src/facade/live-counts.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  otherMemberId: string;
  teammateId: string;
  otherTeammateId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seedSpace(
  client: PoolClient,
  identityId: string,
  spaceId: string,
  memberId: string,
  teammateId: string,
  name: string,
): Promise<void> {
  await client.query(
    `insert into public.spaces(id, name, created_by_identity) values ($1, $2, $3)`,
    [spaceId, name, identityId],
  );
  await client.query(
    `insert into public.entities(id, space_id, kind, position, created_by)
     values ($1,$3,'member',0,$1), ($2,$3,'team_member',1,$1)`,
    [memberId, teammateId, spaceId],
  );
  await client.query(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name)
     values ($1,$2,$3,'owner','Strip owner')`,
    [memberId, spaceId, identityId],
  );
  await client.query(
    `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
     values ($1,$2,'Chat Agent','helper','gpt-5.6-sol','codex')`,
    [teammateId, memberId],
  );
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const f: Fixture = {
    identityId: 'live-chat-owner',
    spaceId: randomUUID(),
    otherSpaceId: randomUUID(),
    memberId: randomUUID(),
    otherMemberId: randomUUID(),
    teammateId: randomUUID(),
    otherTeammateId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Strip owner')`,
      [f.identityId],
    );
    await seedSpace(client, f.identityId, f.spaceId, f.memberId, f.teammateId, 'Strip');
    await seedSpace(client, f.identityId, f.otherSpaceId, f.otherMemberId, f.otherTeammateId, 'Elsewhere');
  });
  return f;
}

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [fixture.identityId]);
    await client.query(`select set_config('tm8.auth_kind','browser',true)`);
    return fn(client);
  });
}

async function asGraphOwner(sql: string, params: unknown[]): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(sql, params);
  });
}

/** `start_chat` leaves the chat `cold` with its first turn `queued`. */
async function startChat(spaceId: string, teammateId: string): Promise<string> {
  const id = randomUUID();
  await asOwner((client) => client.query(
    `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
    [
      id, spaceId, teammateId, 'gpt-5.6-sol', 'openai', 'codex',
      'ask', 'scratch', null, randomUUID(), `/tmp/tm8-chat-${id}`, null,
      'first prompt', [], null, `live-chat-${id}`,
    ],
  ));
  return id;
}

async function setChat(id: string, runtime: 'cold' | 'live' | 'stopped', turn: 'queued' | 'completed'): Promise<void> {
  await asGraphOwner(`update public.chats set runtime_state = $2 where entity_id = $1`, [id, runtime]);
  await asGraphOwner(`update public.chat_turns set state = $2 where chat_id = $1`, [id, turn]);
}

async function counts(sql: string, spaceId: string): Promise<{ live: number; working: number }> {
  const rows = await asOwner(async (client) => (await client.query<LiveChatCountRow>(sql, [spaceId])).rows);
  return { live: Number(rows[0]?.live), working: Number(rows[0]?.working) };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('live_chat_counts');
  database.apply(migrationFiles());
  fixture = await seed(database);

  const liveWorking = await startChat(fixture.spaceId, fixture.teammateId);
  const liveIdle = await startChat(fixture.spaceId, fixture.teammateId);
  const stoppedQueued = await startChat(fixture.spaceId, fixture.teammateId);
  await startChat(fixture.spaceId, fixture.teammateId); // cold + queued, as started
  const deletedLive = await startChat(fixture.spaceId, fixture.teammateId);
  const elsewhereLive = await startChat(fixture.otherSpaceId, fixture.otherTeammateId);

  await setChat(liveWorking, 'live', 'queued');
  await setChat(liveIdle, 'live', 'completed');
  await setChat(stoppedQueued, 'stopped', 'queued');
  await setChat(deletedLive, 'live', 'queued');
  await asGraphOwner(`update public.entities set deleted_at = now() where id = $1`, [deletedLive]);
  await setChat(elsewhereLive, 'live', 'queued');
});

afterAll(async () => {
  await database?.destroy();
});

describe('live chat counts (status strip)', () => {
  it('counts live chats, and working as a SUBSET of them', async () => {
    expect(await counts(LIVE_CHAT_COUNTS_SQL, fixture.spaceId)).toEqual({ live: 2, working: 1 });
  });

  it('a space with no chats reads 0 — a measured zero, not an absent row', async () => {
    const empty = randomUUID();
    const member = randomUUID();
    const teammate = randomUUID();
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await seedSpace(client, fixture.identityId, empty, member, teammate, 'Empty');
    });
    expect(await counts(LIVE_CHAT_COUNTS_SQL, empty)).toEqual({ live: 0, working: 0 });
  });

  it('NEGATIVE CONTROL: a count that admits `stopped` chats is caught by this fixture', async () => {
    const widened = LIVE_CHAT_COUNTS_SQL.replace(
      "c.runtime_state = 'live'",
      "c.runtime_state in ('live', 'stopped')",
    );
    expect(widened).not.toBe(LIVE_CHAT_COUNTS_SQL);
    // The stopped chat's queued turn would read as a WORKING chat too.
    expect(await counts(widened, fixture.spaceId)).toEqual({ live: 3, working: 2 });
  });

  it('a deleted live chat never counts — RLS hides it even without the explicit filter', async () => {
    // MEASURED: removing `e.deleted_at is null` does NOT change the answer,
    // because the entities read policy already hides deleted rows from a
    // member. The filter stays as belt-and-braces for a non-RLS caller; this
    // test records that it is not the only guard, so nobody mistakes it for a
    // negative control.
    const undeleted = LIVE_CHAT_COUNTS_SQL.replace('e.deleted_at is null and ', '');
    expect(undeleted).not.toBe(LIVE_CHAT_COUNTS_SQL);
    expect(await counts(undeleted, fixture.spaceId)).toEqual({ live: 2, working: 1 });
  });
});
