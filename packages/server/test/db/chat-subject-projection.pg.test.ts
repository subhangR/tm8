/**
 * Entity chat §3.6 — a chat's `about` subject rides its SUMMARY, so the global
 * Chats list can draw each chat's subject without a read per row.
 *
 * Read through BOTH server paths (`facade/entity-read.ts` and
 * `events/projector.ts`) and compared, for the drawing-projection suite's
 * reason: a subject that rode the boot read and vanished on the next
 * `entity.upsert` would look like the link being removed, and each path's own
 * test would stay green.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import type { Querier } from '../../src/db/types.js';
import { loadEntitySummariesByIds } from '../../src/facade/entity-read.js';
import { PgEntityProjector } from '../../src/events/projector.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  spaceId: string;
  memberId: string;
  teammateId: string;
  channelId: string;
  goneChannelId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const f: Fixture = {
    identityId: 'chat-subject-owner',
    spaceId: randomUUID(),
    memberId: randomUUID(),
    teammateId: randomUUID(),
    channelId: randomUUID(),
    goneChannelId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Subject owner')`,
      [f.identityId],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Subjects', $2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$5,'member',0,$1), ($2,$5,'team_member',1,$1),
              ($3,$5,'channel',2,$1), ($4,$5,'channel',3,$1)`,
      [f.memberId, f.teammateId, f.channelId, f.goneChannelId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Subject owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Chat Agent','helper','gpt-5.6-sol','codex')`,
      [f.teammateId, f.memberId],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic)
       values ($1,$3,'launch-plan',''), ($2,$3,'soon-gone','')`,
      [f.channelId, f.goneChannelId, f.spaceId],
    );
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

function querier(client: PoolClient): Querier {
  return {
    query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> =>
      (await client.query(sql, [...params])).rows as R[],
    rpc: async () => { throw new Error('reads only'); },
  };
}

async function startChat(aboutId: string | null): Promise<string> {
  const candidateId = randomUUID();
  await asOwner((client) => client.query(
    `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
    [
      candidateId, fixture.spaceId, fixture.teammateId, 'gpt-5.6-sol', 'openai', 'codex',
      'ask', 'scratch', null, randomUUID(), `/tmp/tm8-chat-${candidateId}`, null,
      'first prompt', [], aboutId, `chat-subject-${candidateId}`,
    ],
  ));
  return candidateId;
}

/** Both paths, one transaction each, under the owner's claims. */
async function bothPaths(ids: string[]) {
  const read = await asOwner((client) =>
    loadEntitySummariesByIds(querier(client), ids, fixture.identityId));
  const projected = await asOwner((client) =>
    new PgEntityProjector().entitySummaries(querier(client), ids));
  return { read: new Map(read.map((s) => [s.id, s])), projected };
}

function aboutOf(summary: { state?: unknown } | undefined) {
  const state = summary?.state as { kind?: string; about?: unknown } | undefined;
  expect(state?.kind).toBe('chat');
  return state?.about;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_subject_projection');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
});

describe('a chat summary carries its about subject (§3.6)', () => {
  it('names the subject — id, kind and title — identically on both paths, for a whole page', async () => {
    const about = await startChat(fixture.channelId);
    const bare = await startChat(null);
    const { read, projected } = await bothPaths([about, bare]);

    const expected = { id: fixture.channelId, kind: 'channel', title: 'launch-plan' };
    expect(aboutOf(read.get(about))).toEqual(expected);
    expect(aboutOf(projected.get(about))).toEqual(expected);

    // null is "no subject", and it is explicit — not absent — on both paths.
    expect(aboutOf(read.get(bare))).toBeNull();
    expect(aboutOf(projected.get(bare))).toBeNull();
  });

  it('drops a soft-deleted subject rather than drawing a chip to a tombstone', async () => {
    const chat = await startChat(fixture.goneChannelId);
    await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query('update public.entities set deleted_at = now() where id = $1', [fixture.goneChannelId]);
    });
    const { read, projected } = await bothPaths([chat]);
    expect(aboutOf(read.get(chat))).toBeNull();
    expect(aboutOf(projected.get(chat))).toBeNull();
  });
});
