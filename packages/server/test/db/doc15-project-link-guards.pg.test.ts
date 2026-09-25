import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';

import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

/**
 * DOC 15 B3 + B4 (migration 228) — the project link/unlink guards, on a
 * two-space fixture.
 *
 * B3: the unlink guard counted live work sessions but not CHATS. A chat bound
 * to a project (`chats.project_id` -> `projects.id`, 176) survived its space
 * unlinking that project.
 *
 * B4: `link_project_w2` checked only `require_space_admin`, so a space admin
 * could link any project on the node by id — including one living only in a
 * space they are not in. Linking now needs the caller to SEE the project
 * (`projects_select`'s rule: node admin, or member of a space it is linked
 * into), and an invisible project answers like a missing one.
 *
 * Every refusal is paired with a positive by the SAME caller, so a guard that
 * refused everything would fail this file, not pass it.
 */

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  /** Owner of spaces A and B. Not a node admin. */
  identityH: string;
  /** Owner of space C, ordinary member of A, never in B. Not a node admin. */
  identityH2: string;
  spaceA: string;
  spaceB: string;
  spaceC: string;
  memberHA: string;
  memberHB: string;
  memberH2A: string;
  memberH2C: string;
  personaA: string;
  /** Linked into A only. */
  projectA: string;
  /** Linked into B only. */
  projectB: string;
  /** Linked into A AND B; two chats in A are bound to it. */
  projectChat: string;
  chatA: string;
  chatA2: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asApp<T>(
  identityId: string,
  fn: (client: PoolClient) => Promise<T>,
  nodeAdmin = false,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', $2, true),
              set_config('tm8.auth_kind', 'browser', true),
              set_config('tm8.request_id', $3, true)`,
      [identityId, String(nodeAdmin), `doc15-${randomUUID()}`],
    );
    return fn(client);
  });
}

/** 'ok', or the SQLSTATE the statement raised. */
async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
}

async function seed(): Promise<Fixture> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids: Fixture = {
      identityH: 'doc15-h',
      identityH2: 'doc15-h2',
      spaceA: randomUUID(),
      spaceB: randomUUID(),
      spaceC: randomUUID(),
      memberHA: randomUUID(),
      memberHB: randomUUID(),
      memberH2A: randomUUID(),
      memberH2C: randomUUID(),
      personaA: randomUUID(),
      projectA: randomUUID(),
      projectB: randomUUID(),
      projectChat: randomUUID(),
      chatA: randomUUID(),
      chatA2: randomUUID(),
    };
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H2')`,
      [ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, is_node_admin, is_owner)
       values ($1, 'doc15-h', false, false), ($2, 'doc15-h2', false, false)`,
      [ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Doc15 A', $4), ($2, 'Doc15 B', $4), ($3, 'Doc15 C', $5)`,
      [ids.spaceA, ids.spaceB, ids.spaceC, ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $6, 'member', $1, 'space'),
              ($2, $7, 'member', $2, 'space'),
              ($3, $6, 'member', $3, 'space'),
              ($4, $8, 'member', $4, 'space'),
              ($5, $6, 'team_member', $1, 'space')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.memberH2C, ids.personaA,
        ids.spaceA, ids.spaceB, ids.spaceC],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $5, $8, 'owner', 'H'),
              ($2, $6, $8, 'owner', 'H'),
              ($3, $5, $9, 'member', 'H2'),
              ($4, $7, $9, 'owner', 'H2')`,
      [ids.memberHA, ids.memberHB, ids.memberH2A, ids.memberH2C,
        ids.spaceA, ids.spaceB, ids.spaceC, ids.identityH, ids.identityH2],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Doc15 agent', 'worker', 'persona')`,
      [ids.personaA, ids.memberHA],
    );
    await client.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'Doc15 A project', '/tmp/doc15-a', 'trusted'),
              ($2, 'Doc15 B project', '/tmp/doc15-b', 'trusted'),
              ($3, 'Doc15 chat project', '/tmp/doc15-chat', 'trusted')`,
      [ids.projectA, ids.projectB, ids.projectChat],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id, linked_by)
       values ($1, $3, $6), ($2, $4, $7), ($1, $5, $6), ($2, $5, $7)`,
      [ids.spaceA, ids.spaceB, ids.projectA, ids.projectB, ids.projectChat, ids.memberHA, ids.memberHB],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'chat', $4, 'space'), ($2, $3, 'chat', $4, 'space')`,
      [ids.chatA, ids.chatA2, ids.spaceA, ids.memberHA],
    );
    // Two chats bound to the project, both left at the column defaults: cold
    // runtime, no turns — idle chats, never started.
    for (const chatId of [ids.chatA, ids.chatA2]) {
      await client.query(
        `insert into public.chats(
           entity_id, space_id, title, teammate_id, model, provider, agent_tool,
           chat_mode, workdir_mode, project_id, cwd, native_session_id,
           configured_by_identity_id, configured_by_member_id, client_mutation_id
         ) values ($1,$2,'Doc15 bound chat',$3,'claude-opus-5','anthropic','claude-code',
                   'ask','project',$4,'/tmp/doc15-chat', gen_random_uuid(), $5, $6, $7)`,
        [chatId, ids.spaceA, ids.personaA, ids.projectChat, ids.identityH, ids.memberHA,
          `doc15-chat-${randomUUID()}`],
      );
    }
    return ids;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('doc15_project_link_guards');
  database.apply(migrationFiles());
  fixture = await seed();
}, 180_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

async function linked(spaceId: string, projectId: string): Promise<boolean> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const rows = await client.query(
      'select 1 from public.space_projects where space_id = $1 and project_id = $2',
      [spaceId, projectId],
    );
    return rows.rowCount === 1;
  });
}

interface Refusal { code: string; detail?: string; message: string; hint?: string }

/** Unlink `projectChat` from `spaceId` as H; the refusal's fields, or 'ok'. */
async function unlinkAsH(spaceId: string): Promise<Refusal | 'ok'> {
  try {
    await asApp(fixture.identityH, (client) => client.query(
      'select public.unlink_project_w2($1, $2, $3)',
      [spaceId, fixture.projectChat, `doc15-b3-${randomUUID()}`],
    ));
    return 'ok';
  } catch (error) {
    const e = error as { code?: string; detail?: string; message: string; hint?: string };
    if (typeof e.code !== 'string') throw error;
    return { code: e.code, detail: e.detail, message: e.message, hint: e.hint };
  }
}

async function deleteChat(chatId: string): Promise<void> {
  await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query('update public.entities set deleted_at = now() where id = $1', [chatId]);
  });
}

describe.sequential('doc 15 B3 — unlink is refused while a chat in the space is bound to the project', () => {
  it('precondition — both bound chats are idle: cold runtime, zero turns, not deleted', async () => {
    const rows = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      return (await client.query<{ runtime_state: string; turns: number; deleted: boolean }>(
        `select chat.runtime_state,
                (select count(*)::integer from public.chat_turns t where t.chat_id = chat.entity_id) turns,
                e.deleted_at is not null deleted
           from public.chats chat join public.entities e on e.id = chat.entity_id
          where chat.entity_id = any($1::uuid[])`,
        [[fixture.chatA, fixture.chatA2]],
      )).rows;
    });
    expect(rows).toEqual([
      { runtime_state: 'cold', turns: 0, deleted: false },
      { runtime_state: 'cold', turns: 0, deleted: false },
    ]);
  });

  it('refuses H unlinking from A while two idle chats are bound — 23514 project_not_linked, count and remedy stated', async () => {
    const result = await unlinkAsH(fixture.spaceA);
    expect(result).toMatchObject({ code: '23514', detail: 'project_not_linked' });
    const refusal = result as Refusal;
    expect(refusal.message).toBe('Project is bound to 2 chat(s) in this Space; delete them to unlink it');
    expect(refusal.hint).toMatch(/^Delete the 2 chat\(s\) bound to this project/);
    expect(await linked(fixture.spaceA, fixture.projectChat)).toBe(true);
  });

  it('positive — the same caller unlinks the same project from B, where no chat is bound to it', async () => {
    expect(await unlinkAsH(fixture.spaceB)).toBe('ok');
    expect(await linked(fixture.spaceB, fixture.projectChat)).toBe(false);
  });

  it('a deleted chat is not counted: one deleted, one idle left -> still refused, "1 chat(s)"', async () => {
    await deleteChat(fixture.chatA2);
    const result = await unlinkAsH(fixture.spaceA);
    expect(result).toMatchObject({ code: '23514', detail: 'project_not_linked' });
    expect((result as Refusal).message).toBe('Project is bound to 1 chat(s) in this Space; delete them to unlink it');
    expect(await linked(fixture.spaceA, fixture.projectChat)).toBe(true);
  });

  it('positive — a deleted chat does not block: with only deleted chats bound, the same caller unlinks from A', async () => {
    await deleteChat(fixture.chatA);
    expect(await unlinkAsH(fixture.spaceA)).toBe('ok');
    expect(await linked(fixture.spaceA, fixture.projectChat)).toBe(false);
  });
});

describe.sequential('doc 15 B4 — link_project requires that the caller can see the project', () => {
  it('refuses H2 (admin of C, not in B) linking B\'s project into C — answered as not found (P0002)', async () => {
    expect(await outcome(() => asApp(fixture.identityH2, (client) => client.query(
      `select public.link_project_w2($1, $2, null, 'doc15-b4-refused')`,
      [fixture.spaceC, fixture.projectB],
    )))).toBe('P0002');
    expect(await linked(fixture.spaceC, fixture.projectB)).toBe(false);
  });

  it('the refusal is not an existence oracle: a project id that does not exist answers the same', async () => {
    expect(await outcome(() => asApp(fixture.identityH2, (client) => client.query(
      `select public.link_project_w2($1, $2, null, 'doc15-b4-missing')`,
      [fixture.spaceC, randomUUID()],
    )))).toBe('P0002');
  });

  it('refuses the legacy public.link_project door the same way', async () => {
    expect(await outcome(() => asApp(fixture.identityH2, (client) => client.query(
      `select public.link_project($1, $2, null, 'doc15-b4-legacy-refused')`,
      [fixture.spaceC, fixture.projectB],
    )))).toBe('P0002');
    expect(await linked(fixture.spaceC, fixture.projectB)).toBe(false);
  });

  it('positive — the same caller links A\'s project (a space they are in) into C', async () => {
    expect(await outcome(() => asApp(fixture.identityH2, (client) => client.query(
      `select public.link_project_w2($1, $2, null, 'doc15-b4-visible')`,
      [fixture.spaceC, fixture.projectA],
    )))).toBe('ok');
    expect(await linked(fixture.spaceC, fixture.projectA)).toBe(true);
  });

  it('positive — a node admin still administers the registry: B\'s project links into C', async () => {
    expect(await outcome(() => asApp(fixture.identityH2, (client) => client.query(
      `select public.link_project_w2($1, $2, null, 'doc15-b4-node-admin')`,
      [fixture.spaceC, fixture.projectB],
    ), true))).toBe('ok');
    expect(await linked(fixture.spaceC, fixture.projectB)).toBe(true);
  });
});
