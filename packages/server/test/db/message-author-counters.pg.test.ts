/** 112 — human/agent message counters, including pre-migration backfill. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { loadHumanMessageAuthorIds } from '../../src/facade/message-author-projection.js';

interface Fixture {
  space: string;
  member: string;
  agent: string;
  task: string;
  humanMessage: string;
  agentMessage: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function counters(): Promise<{ messages: number; human: number; agent: number }> {
  const [row] = await database.query<{ messages: number; human_messages: number; agent_messages: number }>(
    `select messages, human_messages, agent_messages
       from public.entity_counters where entity_id = $1`,
    [fixture.task],
  );
  return {
    messages: Number(row!.messages),
    human: Number(row!.human_messages),
    agent: Number(row!.agent_messages),
  };
}

async function asOwner<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function addMessage(author: string, position: number): Promise<string> {
  return asOwner(async (client) => {
    const id = (await client.query<{ id: string }>(`select internal.new_id()::text id`)).rows[0]!.id;
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1, $2, 'message', $3, $4)`,
      [id, fixture.space, position, author],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, author_id, body)
       values ($1, $2, $3, 'count me')`,
      [id, fixture.task, author],
    );
    return id;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('messages_112');
  const files = migrationFiles();
  const cut = files.findIndex((file) => file.startsWith('112_'));
  if (cut === -1) throw new Error('112 migration not found');
  database.apply(files.slice(0, cut));

  fixture = await asOwner(async (client) => {
    const ids = (await client.query<Fixture>(
      `select internal.new_id()::text space, internal.new_id()::text member,
              internal.new_id()::text agent, internal.new_id()::text task,
              internal.new_id()::text "humanMessage", internal.new_id()::text "agentMessage"`,
    )).rows[0]!;
    await client.query(`insert into public.user_profiles(identity_id, display_name) values ('messages-member', 'Member')`);
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Messages', 'messages-member')`,
      [ids.space],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($2, $1, 'member', 0, $2), ($3, $1, 'team_member', 1, $2),
       ($4, $1, 'task', 2, $2), ($5, $1, 'message', 3, $2),
       ($6, $1, 'message', 4, $3)`,
      [ids.space, ids.member, ids.agent, ids.task, ids.humanMessage, ids.agentMessage],
    );
    await client.query(
      `insert into public.messages(entity_id, anchor_id, author_id, body) values
       ($1, $3, $4, 'human'), ($2, $3, $5, 'agent')`,
      [ids.humanMessage, ids.agentMessage, ids.task, ids.member, ids.agent],
    );
    return ids;
  });

  database.apply(files.slice(cut));
}, 300_000);

afterAll(async () => database?.destroy());

describe('112 — message author counters', () => {
  it('backfills the two author kinds while retaining the compatibility total', async () => {
    expect(await counters()).toEqual({ messages: 2, human: 1, agent: 1 });
  });

  it('projects only actual human authors for the avatar stack', async () => {
    const authors = await asOwner(async (client) => loadHumanMessageAuthorIds({
      query: async <R>(sql: string, params: readonly unknown[] = []) =>
        (await client.query(sql, [...params])).rows as R[],
      rpc: async () => { throw new Error('not used'); },
    }, [fixture.task]));
    expect(authors.get(fixture.task)).toEqual({ ids: [fixture.member], total: 1 });
  });

  it('increments and decrements each split through the message trigger', async () => {
    const human = await addMessage(fixture.member, 5);
    const agent = await addMessage(fixture.agent, 6);
    expect(await counters()).toEqual({ messages: 4, human: 2, agent: 2 });

    await asOwner((client) => client.query(`delete from public.entities where id = any($1::uuid[])`, [[human, agent]]));
    expect(await counters()).toEqual({ messages: 2, human: 1, agent: 1 });
  });
});
