/**
 * 226 — the `auth_sessions.space_id` backfill (plan W0a, acceptance a5).
 *
 * Applies every migration BEFORE 226, seeds the agent-session shapes that
 * exist in the wild without a space, applies 226, and checks:
 *
 *   - each row is placed by the source its issuer resolved at mint time
 *     (work session, chat, persona), live and revoked alike;
 *   - a row nothing can place is deleted, and a human row keeps `null`;
 *   - a SECOND run changes zero rows (xmin is unchanged on every row);
 *   - the check constraint holds after it, with a paired positive.
 *
 * The token hashes seeded here are random hex, not hashes of any token.
 */
import { createHash, randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MIGRATION = '226_auth_session_space.sql';

let database: W1ScratchDatabase;

const ids = {
  spaceA: randomUUID(),
  spaceB: randomUUID(),
  identity: `backfill-226-${randomUUID()}`,
  account: randomUUID(),
  memberA: randomUUID(),
  memberB: randomUUID(),
  personaA: randomUUID(),
  personaB: randomUUID(),
  workSessionA: randomUUID(),
  chatB: randomUUID(),
  // One auth_sessions row per shape.
  agentLive: randomUUID(),
  agentRevoked: randomUUID(),
  runtimeByChat: randomUUID(),
  agentByPersonaOnly: randomUUID(),
  agentUnplaceable: randomUUID(),
  browser: randomUUID(),
};

const randomHash = (): string => createHash('sha256').update(randomUUID()).digest('hex');

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function seed(): Promise<void> {
  await asOwner(async (client) => {
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H')`, [ids.identity]);
    await client.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'backfill-226')`,
      [ids.account, ids.identity]);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'A', $3), ($2, 'B', $3)`,
      [ids.spaceA, ids.spaceB, ids.identity]);
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility) values
         ($1, $5, 'member', $1, 'space'),
         ($2, $6, 'member', $2, 'space'),
         ($3, $5, 'team_member', $1, 'space'),
         ($4, $6, 'team_member', $2, 'space'),
         ($7, $5, 'work_session', $3, 'space'),
         ($8, $6, 'chat', $2, 'space')`,
      [ids.memberA, ids.memberB, ids.personaA, ids.personaB, ids.spaceA, ids.spaceB,
       ids.workSessionA, ids.chatB]);
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $5, 'owner', 'H'), ($2, $4, $5, 'owner', 'H')`,
      [ids.memberA, ids.memberB, ids.spaceA, ids.spaceB, ids.identity]);
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'GA', 'worker', 'persona'), ($3, $4, 'GB', 'worker', 'persona')`,
      [ids.personaA, ids.memberA, ids.personaB, ids.memberB]);
    await client.query(
      // scratch: this session only places auth_sessions by its space; 245's
      // CHECK refuses an agent/project row with no project entity.
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at, workdir_mode)
       values ($1, 'run', 'running', 'none', now(), 'scratch')`, [ids.workSessionA]);
    await client.query(
      `insert into public.chats(
         entity_id, space_id, title, teammate_id, model, provider, agent_tool,
         chat_mode, workdir_mode, cwd, native_session_id,
         configured_by_identity_id, configured_by_member_id, client_mutation_id
       ) values ($1,$2,'chat',$3,'claude-opus-5','anthropic','claude-code',
                 'ask','scratch','/tmp/tm8-backfill-226', gen_random_uuid(), $4, $5, $6)`,
      [ids.chatB, ids.spaceB, ids.personaB, ids.identity, ids.memberB, `backfill-226-${randomUUID()}`]);

    const future = new Date(Date.now() + 3_600_000).toISOString();
    const insert = (cols: string, vals: unknown[]): Promise<unknown> => {
      const names = cols.split(',').map((c) => c.trim());
      const params = names.map((_, i) => `$${i + 1}`).join(', ');
      return client.query(`insert into public.auth_sessions(${cols}) values (${params})`, vals);
    };
    const base = 'id, account_id, kind, token_hash, expires_at';
    await insert(`${base}, acting_as_team_member_id, work_session_id`,
      [ids.agentLive, ids.account, 'agent', randomHash(), future, ids.personaA, ids.workSessionA]);
    await insert(`${base}, acting_as_team_member_id, work_session_id, revoked_at`,
      [ids.agentRevoked, ids.account, 'agent', randomHash(), future, ids.personaA, ids.workSessionA,
       new Date().toISOString()]);
    await insert(`${base}, acting_as_team_member_id, runtime_member_id, runtime_chat_id`,
      [ids.runtimeByChat, ids.account, 'agent_runtime', randomHash(), future, ids.personaB, ids.memberB,
       ids.chatB]);
    await insert(`${base}, acting_as_team_member_id`,
      [ids.agentByPersonaOnly, ids.account, 'agent', randomHash(), future, ids.personaB]);
    await insert(base, [ids.agentUnplaceable, ids.account, 'agent', randomHash(), future]);
    await insert(base, [ids.browser, ids.account, 'browser', randomHash(), future]);
  });
}

const spaceOf = async (): Promise<Map<string, string | null>> =>
  new Map((await database.query<{ id: string; space_id: string | null }>(
    'select id::text, space_id::text from public.auth_sessions',
  )).map((r) => [r.id, r.space_id]));

beforeAll(async () => {
  database = await createW1ScratchDatabase('backfill_226');
  const all = migrationFiles();
  const at = all.indexOf(MIGRATION);
  expect(at).toBeGreaterThan(0);
  database.apply(all.slice(0, at));
  await seed();
  database.apply([MIGRATION]);
});

afterAll(async () => {
  await database?.destroy();
});

describe('226 backfill', () => {
  it('places each agent row by the space its issuer resolved', async () => {
    const spaces = await spaceOf();
    expect(spaces.get(ids.agentLive)).toBe(ids.spaceA); // work session
    expect(spaces.get(ids.agentRevoked)).toBe(ids.spaceA); // revoked rows too
    expect(spaces.get(ids.runtimeByChat)).toBe(ids.spaceB); // chat
    expect(spaces.get(ids.agentByPersonaOnly)).toBe(ids.spaceB); // persona
  });

  it('deletes the agent row nothing can place, and leaves the human row unpinned', async () => {
    const spaces = await spaceOf();
    expect(spaces.has(ids.agentUnplaceable)).toBe(false);
    expect(spaces.has(ids.browser)).toBe(true);
    expect(spaces.get(ids.browser)).toBeNull();
  });

  it('is idempotent: a second run changes zero rows', async () => {
    const snapshot = async (): Promise<Array<{ id: string; xmin: string; space_id: string | null }>> =>
      database.query('select id::text, xmin::text, space_id::text from public.auth_sessions order by id');
    const before = await snapshot();
    database.apply([MIGRATION]);
    // xmin moves on any UPDATE, even one that writes the same value.
    expect(await snapshot()).toEqual(before);
  });

  it('holds the check constraint after the backfill — an unplaced agent row is refused', async () => {
    const code = await asOwner((client) => client.query(
      `insert into public.auth_sessions(account_id, kind, token_hash, expires_at)
       values ($1, 'agent', $2, now() + interval '1 hour')`, [ids.account, randomHash()],
    )).then(() => 'ok', (err: { code?: string }) => err.code);
    expect(code).toBe('23514');
  });

  it('positive — the same insert with a space, and a human row without one, are accepted', async () => {
    await asOwner(async (client) => {
      await client.query(
        `insert into public.auth_sessions(account_id, kind, token_hash, expires_at, space_id)
         values ($1, 'agent', $2, now() + interval '1 hour', $3)`, [ids.account, randomHash(), ids.spaceA]);
      await client.query(
        `insert into public.auth_sessions(account_id, kind, token_hash, expires_at)
         values ($1, 'cli', $2, now() + interval '1 hour')`, [ids.account, randomHash()]);
    });
  });

  it('applies the migrations after it cleanly', () => {
    const all = migrationFiles();
    database.apply(all.slice(all.indexOf(MIGRATION) + 1));
  });
});
