// 167 (re-keyed onto the chat ENTITY by 176): a chat names its working
// directory, and the DATABASE is what
// resolves it. Every rule below is enforced in SQL rather than in the handler
// because the handler is not the only caller a `security definer` function can
// ever have — the contract-level `.refine` in front of it is a courtesy that
// produces a readable error, not the boundary.
//
// The rule that carries the most weight is the SPACE-LINK CHECK. This function
// runs as `security definer`, so RLS on `space_projects` is NOT evaluated
// inside it: naming a project id is otherwise enough to bind a thread to a
// directory belonging to a Space the caller is not in. That check is explicit
// in the function body, and `binds nothing for a project linked to another
// space` is the test that keeps it there.
//
// Deliberately NOT tested here, because it is deliberately NOT enforced: trust.
// `execution_spawn` refuses an untrusted project; chat does not (ruled
// 2026-08-21), so `binds an untrusted linked project` asserts a REFUSAL DOES
// NOT HAPPEN. If someone later adds a trust gate to chat, that test fails and
// they find this note.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient, QueryResultRow } from 'pg';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from './w1-pg.js';

interface Fixture {
  identityA: string;
  spaceId: string;
  otherSpaceId: string;
  memberA: string;
  otherMemberA: string;
  teammateId: string;
  anchorId: string;
  linkedProjectId: string;
  untrustedProjectId: string;
  foreignProjectId: string;
  unlinkedProjectId: string;
}

const LINKED_DIR = '/tmp/tm8-project-linked';
const UNTRUSTED_DIR = '/tmp/tm8-project-untrusted';
const FOREIGN_DIR = '/tmp/tm8-project-foreign';
const UNLINKED_DIR = '/tmp/tm8-project-unlinked';

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asIdentity<T extends QueryResultRow>(
  identityId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(`select set_config('tm8.identity_id',$1,true)`, [identityId]);
    await client.query(`select set_config('tm8.auth_kind','browser',true)`);
    return fn(client);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  const values: Fixture = {
    identityA: 'chat-binding-a',
    spaceId: randomUUID(),
    otherSpaceId: randomUUID(),
    memberA: randomUUID(),
    otherMemberA: randomUUID(),
    teammateId: randomUUID(),
    anchorId: randomUUID(),
    linkedProjectId: randomUUID(),
    untrustedProjectId: randomUUID(),
    foreignProjectId: randomUUID(),
    unlinkedProjectId: randomUUID(),
  };
  await db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    await client.query(
      `insert into public.user_profiles(identity_id, display_name) values ($1, 'Binding A')`,
      [values.identityA],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1,'Binding',$3),($2,'Other',$3)`,
      [values.spaceId, values.otherSpaceId, values.identityA],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$4,'member',0,$1), ($2,$4,'team_member',1,$1), ($3,$4,'channel',2,$1)`,
      [values.memberA, values.teammateId, values.anchorId, values.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Binding A')`,
      [values.memberA, values.spaceId, values.identityA],
    );
    // A member of the OTHER space too, so a refusal there is about the project
    // link and not merely about space membership.
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($1,$2,'member',0,$1)`,
      [values.otherMemberA, values.otherSpaceId],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1,$2,$3,'owner','Binding A')`,
      [values.otherMemberA, values.otherSpaceId, values.identityA],
    );
    await client.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, model, agent_tool)
       values ($1,$2,'Binding Agent','helper','claude-opus-5','claude-code')`,
      [values.teammateId, values.memberA],
    );
    await client.query(
      `insert into public.channels(entity_id, space_id, name, topic) values ($1,$2,'binding','')`,
      [values.anchorId, values.spaceId],
    );
    await client.query(
      `insert into public.projects(id, name, working_dir, trust) values
         ($1,'Linked',$5,'trusted'),
         ($2,'Untrusted',$6,'untrusted'),
         ($3,'Foreign',$7,'trusted'),
         ($4,'Unlinked',$8,'trusted')`,
      [
        values.linkedProjectId, values.untrustedProjectId,
        values.foreignProjectId, values.unlinkedProjectId,
        LINKED_DIR, UNTRUSTED_DIR, FOREIGN_DIR, UNLINKED_DIR,
      ],
    );
    await client.query(
      `insert into public.space_projects(space_id, project_id) values ($1,$2),($1,$3),($4,$5)`,
      [
        values.spaceId, values.linkedProjectId, values.untrustedProjectId,
        values.otherSpaceId, values.foreignProjectId,
      ],
    );
  });
  return values;
}

/**
 * A fresh candidate chat id, so every case gets its own chat.
 *
 * 176: there is no root message to post first. The id is minted by the CALLER
 * (the handler names the scratch directory after it before the RPC runs), and
 * `start_chat` writes the row at that id.
 */
function freshChatId(): string {
  return randomUUID();
}

async function configure(
  chatId: string,
  workdirMode: 'project' | 'scratch',
  projectId: string | null,
  cwd: string | null = `/tmp/tm8-chat-${chatId}`,
): Promise<Record<string, unknown>> {
  return asIdentity(fixture.identityA, async (client) => (
    await client.query<{ result: Record<string, unknown> }>(
      `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
      [
        chatId, fixture.spaceId, fixture.teammateId, 'claude-opus-5', 'anthropic',
        'claude-code', 'ask', workdirMode, projectId, randomUUID(), cwd, null,
        'binding prompt', [], null, `binding-config-${randomUUID()}`,
      ],
    )
  ).rows[0]!).then((row) => row.result as Record<string, unknown>);
}

async function storedRow(chatId: string) {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query<{ cwd: string; project_id: string | null; workdir_mode: string }>(
      'select cwd, project_id, workdir_mode from public.chats where entity_id = $1',
      [chatId],
    )).rows[0]!;
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('chat_thread_project_binding');
  database.apply(migrationFiles());
  fixture = await seed(database);
}, 240_000);

afterAll(async () => {
  await database?.destroy();
});

describe.sequential('start_chat project binding', () => {
  it('resolves the cwd from the project rather than from the caller', async () => {
    const chat = freshChatId();
    // The caller passes a DIFFERENT path on purpose. If the function ever
    // trusts `p_cwd` for a project chat, a caller can pair a linked project id
    // with somebody else's directory and the row will believe it.
    const result = await configure(chat, 'project', fixture.linkedProjectId, '/tmp/attacker-chosen');
    expect(result.chatId).toBe(chat);
    // The RESOLVED PATH STAYS SERVER-SIDE (R5): the caller learns the chat's
    // id, and reads its binding through the ordinary entity projection.
    expect(JSON.stringify(result)).not.toContain('/tmp/attacker-chosen');
    expect(JSON.stringify(result)).not.toContain(LINKED_DIR);
    expect(await storedRow(chat)).toMatchObject({
      cwd: LINKED_DIR,
      project_id: fixture.linkedProjectId,
      workdir_mode: 'project',
    });
  });

  it('binds an untrusted linked project — chat does not gate on trust', async () => {
    // ASSERTS A REFUSAL DOES NOT HAPPEN. `execution_spawn` refuses this exact
    // shape; chat deliberately does not, because it runs headless under
    // bypassPermissions where the CLI trust dialog is unreachable. If a trust
    // gate is ever added to chat, this test is where that decision surfaces.
    const chat = freshChatId();
    await configure(chat, 'project', fixture.untrustedProjectId);
    expect(await storedRow(chat)).toMatchObject({
      cwd: UNTRUSTED_DIR,
      workdir_mode: 'project',
    });
  });

  it('binds nothing for a project linked to another space', async () => {
    await expect(configure(freshChatId(), 'project', fixture.foreignProjectId))
      .rejects.toThrow(/project is not linked to this space/);
  });

  it('binds nothing for a project linked to no space at all', async () => {
    await expect(configure(freshChatId(), 'project', fixture.unlinkedProjectId))
      .rejects.toThrow(/project is not linked to this space/);
  });

  it('refuses project mode with no project, and scratch mode with one', async () => {
    await expect(configure(freshChatId(), 'project', null))
      .rejects.toThrow(/project mode requires a project id/);
    await expect(configure(freshChatId(), 'scratch', fixture.linkedProjectId))
      .rejects.toThrow(/scratch mode does not take a project id/);
  });

  it('refuses an unknown workdir mode, including the one work_sessions allows', async () => {
    // `worktree` is valid for work_sessions and NOT for chat. It is the most
    // likely wrong value anyone will send, precisely because the vocabularies
    // otherwise match.
    await expect(configure(freshChatId(), 'worktree' as 'project', fixture.linkedProjectId))
      .rejects.toThrow(/workdir mode must be project or scratch/);
  });

  it('keeps the caller-owned path for scratch, and requires it to be absolute', async () => {
    const chat = freshChatId();
    await configure(chat, 'scratch', null, `/tmp/tm8-chat-${chat}`);
    expect(await storedRow(chat)).toMatchObject({
      cwd: `/tmp/tm8-chat-${chat}`,
      project_id: null,
      workdir_mode: 'scratch',
    });
    await expect(configure(freshChatId(), 'scratch', null, 'not-absolute'))
      .rejects.toThrow(/scratch mode requires an absolute cwd/);
  });

  it('treats the binding as part of the replay identity', async () => {
    // A replayed clientMutationId carrying a DIFFERENT project must be refused
    // rather than silently answered with the original thread — which would read
    // to the caller as "your project was accepted" when it was discarded.
    const mutationId = `binding-replay-${randomUUID()}`;
    // A retry mints a FRESH candidate id every time — that is what a real
    // client does, because the handler names the scratch directory before the
    // RPC runs — so the id is deliberately not part of the request identity.
    // The BINDING is, which is what this case pins.
    const send = (projectId: string) => asIdentity(fixture.identityA, async (client) => (
      await client.query<{ result: Record<string, unknown> }>(
        `select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) result`,
        [
          randomUUID(), fixture.spaceId, fixture.teammateId, 'claude-opus-5', 'anthropic',
          'claude-code', 'ask', 'project', projectId, randomUUID(), null, null,
          'binding prompt', [], null, mutationId,
        ],
      )
    ).rows[0]!);

    const first = await send(fixture.linkedProjectId);
    const firstChatId = (first.result as Record<string, unknown>).chatId;
    // Same mutation id, same everything else, different project.
    await expect(send(fixture.untrustedProjectId))
      .rejects.toThrow(/replay does not match the original request/);
    // The identical request still replays cleanly, and to the SAME chat.
    const replayed = await send(fixture.linkedProjectId);
    expect((replayed.result as Record<string, unknown>).chatId).toBe(firstChatId);
    expect(await storedRow(String(firstChatId)))
      .toMatchObject({ project_id: fixture.linkedProjectId, workdir_mode: 'project' });
  });

  it('defaults an insert that names neither column to scratch/null', async () => {
    // Every thread written before this migration ran in a server-owned scratch
    // directory, so the column default is the honest description of them — not
    // a guess. A backfill that claimed `project` would retroactively tell the
    // runtime to work somewhere those threads have never been.
    //
    // THE EARLIER VERSION OF THIS TEST DID NOT TEST THAT. It called
    // `configure(root, 'scratch', null)` — passing 'scratch' EXPLICITLY — and
    // asserted it came back 'scratch', which is the assertion the
    // "keeps the caller-owned path for scratch" case above already makes. It
    // exercised the argument, never `default 'scratch'`, while standing where
    // the backfill's verification was supposed to be and reading as though it
    // covered it. Review finding F5 on #479.
    //
    // The insert below omits the project column, which is the shape of every
    // row 167 had to migrate, and it goes in as the owner because a pre-167 row
    // was written by a function, not by this RPC. 176 keeps `workdir_mode` NOT
    // NULL with no default (the column is written by `start_chat` on every
    // path), so the surviving half of the case is the PAIRING CONSTRAINT: a
    // scratch row must carry no project, and the check is what enforces it.
    const chat = freshChatId();
    const row = await database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      await client.query(
        `insert into public.entities(id, space_id, kind, position, created_by)
         values ($1,$2,'chat',99,$3)`,
        [chat, fixture.spaceId, fixture.memberA],
      );
      await client.query(
        `insert into public.chats(
           entity_id, space_id, title, teammate_id,
           model, provider, agent_tool, chat_mode, workdir_mode, cwd,
           native_session_id, configured_by_identity_id, configured_by_member_id,
           client_mutation_id
         ) values ($1,$2,'legacy',$3,'claude-opus-5','anthropic','claude-code',
                   'ask','scratch',$4, gen_random_uuid(), $5, $6, $7)`,
        [
          chat, fixture.spaceId, fixture.teammateId, `/tmp/tm8-chat-${chat}`,
          fixture.identityA, fixture.memberA, `binding-default-${randomUUID()}`,
        ],
      );
      return (await client.query<{ project_id: string | null; workdir_mode: string }>(
        'select project_id, workdir_mode from public.chats where entity_id = $1',
        [chat],
      )).rows[0]!;
    });
    // The default landed, AND the pairing constraint accepted the pair it
    // produced — which is the half that would have failed had the default been
    // 'project', and the half no explicit-argument test can reach.
    expect(row.workdir_mode).toBe('scratch');
    expect(row.project_id).toBeNull();
  });
});
