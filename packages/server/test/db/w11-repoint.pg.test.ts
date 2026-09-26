/**
 * W11-repoint (migration 245) on an old-shaped node, the whole chain:
 *
 *   < 234  seed: folder F granted to A AND B, G to A only; a chat, a work
 *          session and a worktree on F in each space;
 *   234    without 235, 245 refuses: every pre-234 row is residue;
 *   235 .. 244
 *          the sharing refusal and decision 29: no node_policy row refuses,
 *          'one_space' refuses, 'shared' applies (dry run only); a red-check
 *          proves the gate, not something else, lets 'shared' through; the
 *          CLI's exit codes;
 *   end sharing, then 245 for real: columns dropped, FKs RESTRICT, worktrees
 *          NOT NULL, the CHECKs, the Q4 resolver and the Q5 branch key.
 *
 * Nothing here runs against anything but this scratch database.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { dryRunRepoint } from '../../src/projects/w11-repoint.js';
import { main as repointCli } from '../../src/projects/w11-repoint-cli.js';

import { createW1ScratchDatabase, migrationFiles, REPO_ROOT, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 300_000 });

const REPOINT = '245_w11_repoint_project_entity.sql';
const ordinal = (file: string): number => Number(file.slice(0, 3));
const BEFORE = migrationFiles().filter((f) => ordinal(f) < 234);
const W11_MODEL = migrationFiles().filter((f) => ordinal(f) === 234);
const W11_BACKFILL = migrationFiles().filter((f) => ordinal(f) === 235);
const MID = migrationFiles().filter((f) => ordinal(f) > 235 && ordinal(f) < 245);
const AFTER = migrationFiles().filter((f) => ordinal(f) > 245);
const repointSql = readFileSync(join(REPO_ROOT, 'db/migrations', REPOINT), 'utf8');

let database: W1ScratchDatabase;

const ids = {
  identityH: `w11r-h-${randomUUID()}`,
  accountH: randomUUID(),
  spaceA: randomUUID(),
  spaceB: randomUUID(),
  memberHA: randomUUID(),
  memberHB: randomUUID(),
  personaA: randomUUID(),
  personaB: randomUUID(),
  folderF: randomUUID(),
  folderG: randomUUID(),
  chatA: randomUUID(),
  chatB: randomUUID(),
  wsA: randomUUID(),
  wsB: randomUUID(),
  wtA: randomUUID(),
  wtB: randomUUID(),
};

type Q = Pick<PoolClient, 'query'>;

async function asOwner<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/** A browser caller of H through tm8_app, the way the facade's claims arrive. */
async function asH<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true), set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true), set_config('tm8.auth_kind','browser',true),
              set_config('tm8.request_id',$2,true)`,
      [ids.identityH, `w11r-${randomUUID()}`],
    );
    return fn(client);
  });
}

/** SQLSTATE of `fn`, or 'ok'. */
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (err) {
    return String((err as { code?: string }).code);
  }
}

async function dryRun(sql = repointSql) {
  const client = await database.pool.connect();
  try {
    return await dryRunRepoint(client, sql);
  } finally {
    client.release();
  }
}

async function setPolicy(value: string | null): Promise<void> {
  await asOwner(async (q) => {
    await q.query(`delete from internal.node_policy where key = 'project_folders'`);
    if (value !== null) {
      await q.query(`insert into internal.node_policy(key, value) values ('project_folders', $1)`, [value]);
    }
  });
}

const linkOf = async (spaceId: string, folderId: string): Promise<string> =>
  (await database.query<{ e: string }>(
    'select project_entity_id::text e from public.project_links where space_id = $1 and project_id = $2',
    [spaceId, folderId],
  ))[0]!.e;

const folderColumns = async (): Promise<number> =>
  (await database.query<{ n: number }>(
    `select count(*)::int n from information_schema.columns
      where table_schema = 'public' and column_name = 'project_id'
        and table_name in ('chats', 'work_sessions', 'worktrees')`,
  ))[0]!.n;

async function seedOldShape(): Promise<void> {
  await asOwner(async (q) => {
    await q.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H')`, [ids.identityH]);
    await q.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, $3)`,
      [ids.accountH, ids.identityH, `w11r-h-${ids.accountH.slice(0, 8)}`]);
    await q.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'W11R A', $3), ($2, 'W11R B', $3)`,
      [ids.spaceA, ids.spaceB, ids.identityH]);
    await q.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'member', $1, 'space'), ($2, $4, 'member', $2, 'space'),
              ($5, $3, 'team_member', $1, 'space'), ($6, $4, 'team_member', $2, 'space')`,
      [ids.memberHA, ids.memberHB, ids.spaceA, ids.spaceB, ids.personaA, ids.personaB]);
    await q.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $5, 'owner', 'H'), ($2, $4, $5, 'owner', 'H')`,
      [ids.memberHA, ids.memberHB, ids.spaceA, ids.spaceB, ids.identityH]);
    await q.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'W11R A mate', 'worker', 'persona'), ($3, $4, 'W11R B mate', 'worker', 'persona')`,
      [ids.personaA, ids.memberHA, ids.personaB, ids.memberHB]);
    await q.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'W11R F', '/tmp/w11r-folder-f', 'trusted'), ($2, 'W11R G', '/tmp/w11r-folder-g', 'trusted')`,
      [ids.folderF, ids.folderG]);
    // F in A AND B: legal before 234.
    await q.query(
      `insert into public.space_projects(space_id, project_id, linked_by)
       values ($1, $3, $5), ($2, $3, $6), ($1, $4, $5)`,
      [ids.spaceA, ids.spaceB, ids.folderF, ids.folderG, ids.memberHA, ids.memberHB]);
    await q.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $5, 'chat', $7, 'space'), ($2, $6, 'chat', $8, 'space'),
              ($3, $5, 'work_session', $9, 'space'), ($4, $6, 'work_session', $10, 'space'),
              ($11, $5, 'worktree', $7, 'space'), ($12, $6, 'worktree', $8, 'space')`,
      [ids.chatA, ids.chatB, ids.wsA, ids.wsB, ids.spaceA, ids.spaceB,
       ids.memberHA, ids.memberHB, ids.personaA, ids.personaB, ids.wtA, ids.wtB]);
    for (const [chat, space, mate, member] of [
      [ids.chatA, ids.spaceA, ids.personaA, ids.memberHA],
      [ids.chatB, ids.spaceB, ids.personaB, ids.memberHB],
    ] as const) {
      await q.query(
        `insert into public.chats(
           entity_id, space_id, title, teammate_id, model, provider, agent_tool,
           chat_mode, workdir_mode, project_id, cwd, native_session_id,
           configured_by_identity_id, configured_by_member_id, client_mutation_id
         ) values ($1,$2,'W11R chat',$3,'claude-opus-5','anthropic','claude-code',
                   'ask','project',$4,'/tmp/w11r-folder-f', gen_random_uuid(), $5, $6, $7)`,
        [chat, space, mate, ids.folderF, ids.identityH, member, `w11r-${randomUUID()}`]);
    }
    await q.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, project_id, started_at)
       values ($1, 'W11R run A', 'running', 'none', $3, now()), ($2, 'W11R run B', 'running', 'none', $3, now())`,
      [ids.wsA, ids.wsB, ids.folderF]);
    await q.query(
      `insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid)
       values ($1, $3, '/tmp/w11r-folder-f/.wt/a', 'w11r/a', 'main', repeat('a', 40)),
              ($2, $3, '/tmp/w11r-folder-f/.wt/b', 'w11r/b', 'main', repeat('b', 40))`,
      [ids.wtA, ids.wtB, ids.folderF]);
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('w11_repoint');
  database.apply(BEFORE);
  await seedOldShape();
  database.apply(W11_MODEL);
}, 300_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

describe.sequential('245 needs 235 to have RUN', () => {
  it('the chain has exactly one 234, one 235 and one 245', () => {
    expect([W11_MODEL.length, W11_BACKFILL.length, migrationFiles().filter((f) => f === REPOINT).length])
      .toEqual([1, 1, 1]);
  });

  it('refuses on a 234-without-235 node: every pre-234 row is residue, and nothing is dropped', async () => {
    const run = await dryRun();
    expect(run.after).toBeNull();
    expect(run.refusal).toContain('W11-repoint (245) refused:');
    expect(run.refusal).toContain('chats: 2 row(s) whose folder has no matching entity');
    expect(run.refusal).toContain('work_sessions: 2 row(s) whose folder has no matching entity');
    expect(run.refusal).toContain('worktrees: 2 row(s) whose folder has no matching entity');
    expect(run.refusal).toContain('w11_repoint_preflight');
    expect(await folderColumns()).toBe(3);
  });
});

describe.sequential('the sharing refusal under decision 29 (after 235)', () => {
  beforeAll(() => {
    database.apply(W11_BACKFILL);
    database.apply(MID);
  });

  const sharingLine = (): string => `1 folder(s) granted to more than one space: ${ids.folderF} "W11R F" in 2 spaces`;

  it('NO node_policy row (234 inserts none): refused, naming F and its 2 spaces — the default refuses', async () => {
    await setPolicy(null);
    const run = await dryRun();
    expect(run.before.projectFoldersPolicy).toBeNull();
    expect(run.refusal).toContain(sharingLine());
    // The refusal is the sharing line alone: 235 left no residue.
    expect(run.refusal).not.toContain('no matching entity');
    expect(run.before.residue).toEqual({ chats: 0, workSessions: 0, worktrees: 0 });
    expect(run.before.sharedFolders).toEqual([
      { folderId: ids.folderF, folderName: 'W11R F', spaces: 2, confirmedSpaceId: null },
    ]);
  });

  it('a real apply refuses the same way (23514), and the three folder columns remain', async () => {
    expect(() => database.apply([REPOINT])).toThrow(/granted to more than one space/);
    expect(await folderColumns()).toBe(3);
  });

  it("'one_space': refused, the same line", async () => {
    await setPolicy('one_space');
    const run = await dryRun();
    expect(run.before.projectFoldersPolicy).toBe('one_space');
    expect(run.refusal).toContain(sharingLine());
  });

  it("'shared' (a loopback-only node): 245 applies over the shared folder — dry run, rolled back", async () => {
    await setPolicy('shared');
    const run = await dryRun();
    expect(run.refusal).toBeNull();
    expect(run.after?.folderColumns).toBe(false); // dropped inside the rolled-back txn
    expect(await folderColumns()).toBe(3);
  });

  it("red-check: with the gate removed from 245's text, 'shared' is refused again", async () => {
    const ungated = repointSql.replace('if not internal.project_folders_shared() then', 'if true then');
    expect(ungated).not.toBe(repointSql);
    const run = await dryRun(ungated);
    expect(run.refusal).toContain(sharingLine());
    await setPolicy(null);
  });

  it('the CLI: 64 without --dry-run, 64 without a URL, 2 on the refusal', async () => {
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await repointCli([], {})).toBe(64);
      expect(await repointCli(['--dry-run'], {})).toBe(64);
      expect(await repointCli(['--dry-run'], { TM8_DATABASE_URL: database.url })).toBe(2);
      expect(out.mock.calls.map((c) => String(c[0])).join('')).toContain('## 245 REFUSED');
    } finally {
      quiet.mockRestore();
      out.mockRestore();
    }
    expect(await folderColumns()).toBe(3);
  });
});

describe.sequential('245 applied once sharing has ended', () => {
  beforeAll(async () => {
    // What W11-migrate's real run leaves: F belongs to A alone; B's rows on F
    // are moved off it (the session and chat to scratch, the worktree gone).
    await database.transaction(async (client) => {
      await client.query(`set local session_replication_role = replica`);
      await client.query(
        `update public.chats set workdir_mode = 'scratch', project_id = null, project_entity_id = null
          where entity_id = $1`, [ids.chatB]);
      await client.query(
        `update public.work_sessions set workdir_mode = 'scratch', project_id = null, project_entity_id = null
          where entity_id = $1`, [ids.wsB]);
      await client.query('delete from public.worktrees where entity_id = $1', [ids.wtB]);
      await client.query('delete from public.entities where id = $1', [ids.wtB]);
      await client.query('delete from public.project_links where space_id = $1 and project_id = $2', [ids.spaceB, ids.folderF]);
      await client.query('delete from public.space_projects where space_id = $1 and project_id = $2', [ids.spaceB, ids.folderF]);
    });
    const run = await dryRun();
    if (run.refusal !== null) throw new Error(`dry run still refuses:\n${run.refusal}`);
    database.apply([REPOINT]);
    database.apply(AFTER);
  }, 300_000);

  it('the three project_id columns are gone', async () => {
    expect(await folderColumns()).toBe(0);
  });

  it('the three project_entity_id FKs are ON DELETE RESTRICT; worktrees.project_entity_id is NOT NULL', async () => {
    const fks = await database.query<{ rel: string; confdeltype: string }>(
      `select c.conrelid::regclass::text rel, c.confdeltype::text confdeltype
         from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and a.attname = 'project_entity_id'
          and c.conrelid in ('public.chats'::regclass, 'public.work_sessions'::regclass, 'public.worktrees'::regclass)
        order by 1`);
    expect(fks).toEqual([
      { rel: 'chats', confdeltype: 'r' },
      { rel: 'work_sessions', confdeltype: 'r' },
      { rel: 'worktrees', confdeltype: 'r' },
    ]);
    const [nn] = await database.query<{ attnotnull: boolean }>(
      `select attnotnull from pg_attribute where attrelid = 'public.worktrees'::regclass and attname = 'project_entity_id'`);
    expect(nn!.attnotnull).toBe(true);
  });

  it('a hard delete of a project entity with rows on it is refused (23503) by one of the three 245 FKs', async () => {
    const entityAF = await linkOf(ids.spaceA, ids.folderF);
    let refused: { code?: string; table?: string; constraint?: string } = {};
    try {
      await database.transaction(async (client) => {
        await client.query(`select internal.w1_set_writer('forward_compensation')`);
        await client.query('delete from public.entities where id = $1', [entityAF]);
      });
    } catch (err) {
      refused = err as typeof refused;
    }
    expect(refused.code).toBe('23503');
    expect(['chats', 'work_sessions', 'worktrees']).toContain(refused.table);
    expect(refused.constraint).toMatch(/project_entity/);
  });

  it('positive — the same delete of a project entity with NO rows on it (G in A) goes through (rolled back)', async () => {
    const entityAG = await linkOf(ids.spaceA, ids.folderG);
    const ROLLBACK = new Error('w11r rollback');
    let deleted = -1;
    await expect(database.transaction(async (client) => {
      await client.query(`select internal.w1_set_writer('forward_compensation')`);
      deleted = (await client.query('delete from public.entities where id = $1', [entityAG])).rowCount ?? -1;
      throw ROLLBACK;
    })).rejects.toBe(ROLLBACK);
    expect(deleted).toBe(1);
    expect(await linkOf(ids.spaceA, ids.folderG)).toBe(entityAG);
  });

  it('every surviving row still maps back to its folder', async () => {
    const rows = await database.query<{ id: string; folder: string | null }>(
      `select entity_id::text id, internal.project_folder_for(space_id, project_entity_id)::text folder
         from public.chats where entity_id = any($1::uuid[])
       union all
       select ws.entity_id::text, internal.project_folder_for(e.space_id, ws.project_entity_id)::text
         from public.work_sessions ws join public.entities e on e.id = ws.entity_id
        where ws.entity_id = any($1::uuid[])
       union all
       select entity_id::text, internal.project_folder_for(space_id, project_entity_id)::text
         from public.worktrees where entity_id = any($1::uuid[])
       order by 1`,
      [[ids.chatA, ids.chatB, ids.wsA, ids.wsB, ids.wtA]]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.folder]));
    expect(byId).toEqual({
      [ids.chatA]: ids.folderF, [ids.chatB]: null,
      [ids.wsA]: ids.folderF, [ids.wsB]: null,
      [ids.wtA]: ids.folderF,
    });
  });

  describe('the fallback CHECK on work_sessions', () => {
    const insertSession = (kind: string, mode: string, entity: string | null) => async () => {
      const id = randomUUID();
      await database.transaction(async (client) => {
        await client.query(
          `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'work_session', $3, 'space')`,
          [id, ids.spaceA, ids.personaA]);
        await client.query(
          `insert into public.work_sessions(entity_id, title, status, share_mode, started_at, session_kind, workdir_mode, project_entity_id)
           values ($1, 'W11R check', 'running', 'none', now(), $2, $3, $4)`,
          [id, kind, mode, entity]);
      });
    };

    it('refuses an agent session in project mode with no project entity (23514)', async () => {
      expect(await outcome(insertSession('agent', 'project', null))).toBe('23514');
    });

    it('positive — the same session with its project entity', async () => {
      expect(await outcome(insertSession('agent', 'project', await linkOf(ids.spaceA, ids.folderF)))).toBe('ok');
    });

    it('positive — scratch, and a credential session on 001\'s default mode, with no entity', async () => {
      expect(await outcome(insertSession('agent', 'scratch', null))).toBe('ok');
      expect(await outcome(insertSession('credential', 'project', null))).toBe('ok');
    });
  });

  describe('the CHECKs on chats', () => {
    const insertChat = (mode: string, entity: string | null) => async () => {
      const id = randomUUID();
      await asOwner(async (q) => {
        await q.query(
          `insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'chat', $3, 'space')`,
          [id, ids.spaceA, ids.memberHA]);
        await q.query(
          `insert into public.chats(
             entity_id, space_id, title, teammate_id, model, provider, agent_tool,
             chat_mode, workdir_mode, project_entity_id, cwd, native_session_id,
             configured_by_identity_id, configured_by_member_id, client_mutation_id
           ) values ($1,$2,'W11R check chat',$3,'claude-opus-5','anthropic','claude-code',
                     'ask',$4,$5,'/tmp/w11r-folder-f', gen_random_uuid(), $6, $7, $8)`,
          [id, ids.spaceA, ids.personaA, mode, entity, ids.identityH, ids.memberHA, `w11r-${randomUUID()}`]);
      });
    };

    it('refuses a project chat with no project entity (23514)', async () => {
      expect(await outcome(insertChat('project', null))).toBe('23514');
    });

    it('refuses a scratch chat that names a project entity (23514)', async () => {
      expect(await outcome(insertChat('scratch', await linkOf(ids.spaceA, ids.folderF)))).toBe('23514');
    });

    it('positive — a project chat with its entity, and a scratch chat with none', async () => {
      expect(await outcome(insertChat('project', await linkOf(ids.spaceA, ids.folderF)))).toBe('ok');
      expect(await outcome(insertChat('scratch', null))).toBe('ok');
    });
  });

  describe('Q5: the branch key is (space, project entity, branch)', () => {
    it('a second worktree row for one branch of one project entity is refused (23505), and no row is left', async () => {
      const branch = `w11r/q5-${randomUUID().slice(0, 8)}`;
      const create = () => asH((q) => q.query(
        'select public.create_worktree($1,$2,$3,$4,$5,$6,null,null,null)',
        [ids.spaceA, ids.folderF, `/tmp/w11r-folder-f/.wt/${randomUUID()}`, branch, 'main', 'c'.repeat(40)]));
      expect(await outcome(create)).toBe('ok');
      expect(await outcome(create)).toBe('23505');
      const [row] = await database.query<{ n: number }>(
        'select count(*)::int n from public.worktrees where branch = $1', [branch]);
      expect(row!.n).toBe(1);
    });
  });

  describe('Q4: one resolver; a folder mapped twice in one space is refused (22023), never guessed', () => {
    beforeAll(async () => {
      // An impossible state on purpose: project_links' pkey forbids it, so the
      // key goes first. G, in A, now maps to two project entities.
      const dup = randomUUID();
      await database.transaction(async (client) => {
        await client.query(`select internal.w1_set_writer('project_materializer')`);
        await client.query(
          `insert into public.entities(id, space_id, kind, parent_id, position, created_by)
           values ($1, $2, 'project', null, 9, $3)`, [dup, ids.spaceA, ids.memberHA]);
        await client.query(
          `insert into public.project_projection_details(entity_id, project_id, name) values ($1, $2, 'W11R G twice')`,
          [dup, ids.folderG]);
        await client.query('alter table public.project_links drop constraint project_links_pkey');
        await client.query(
          'insert into public.project_links(space_id, project_id, project_entity_id) values ($1, $2, $3)',
          [ids.spaceA, ids.folderG, dup]);
      });
    });

    const code = async (fn: () => Promise<unknown>): Promise<string> => {
      try {
        await fn();
        return 'ok';
      } catch (err) {
        const e = err as { code?: string; detail?: string };
        return e.detail === 'project_ref_ambiguous' ? `${e.code}:ambiguous` : String(e.code);
      }
    };

    it('the resolver itself', async () => {
      expect(await code(() => asOwner((q) => q.query('select internal.project_entity_for($1,$2)', [ids.spaceA, ids.folderG]))))
        .toBe('22023:ambiguous');
      const [row] = await asOwner((q) => q.query<{ e: string }>(
        'select internal.project_entity_for($1,$2)::text e', [ids.spaceA, ids.folderF])).then((r) => r.rows);
      expect(row!.e).toBe(await linkOf(ids.spaceA, ids.folderF));
    });

    const spawn = (folder: string) => () => asH((q) => q.query(
      `select public.execution_spawn($1,$2,'{}'::uuid[],$3,'project',null,null,null,null,null,'W11R spawn',
                                     null,false,64,null,$4,null)`,
      [ids.spaceA, ids.personaA, folder, `w11r-spawn-${randomUUID()}`]));

    it('execution_spawn on the ambiguous folder', async () => {
      expect(await code(spawn(ids.folderG))).toBe('22023:ambiguous');
    });

    it('positive — execution_spawn on F', async () => {
      expect(await code(spawn(ids.folderF))).toBe('ok');
    });

    const chat = (folder: string) => () => asH((q) => q.query(
      'select public.start_chat($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
      [randomUUID(), ids.spaceA, ids.personaA, 'claude-opus-5', 'anthropic', 'claude-code', 'ask',
       'project', folder, randomUUID(), null, null, 'W11R prompt', [], null, `w11r-chat-${randomUUID()}`]));

    it('start_chat on the ambiguous folder', async () => {
      expect(await code(chat(ids.folderG))).toBe('22023:ambiguous');
    });

    it('positive — start_chat on F', async () => {
      expect(await code(chat(ids.folderF))).toBe('ok');
    });

    const worktree = (folder: string) => () => asH((q) => q.query(
      'select public.create_worktree($1,$2,$3,$4,$5,$6,null,null,null)',
      [ids.spaceA, folder, `/tmp/w11r/.wt/${randomUUID()}`, `w11r/q4-${randomUUID().slice(0, 8)}`, 'main', 'd'.repeat(40)]));

    it('create_worktree on the ambiguous folder', async () => {
      expect(await code(worktree(ids.folderG))).toBe('22023:ambiguous');
    });

    it('positive — create_worktree on F', async () => {
      expect(await code(worktree(ids.folderF))).toBe('ok');
    });
  });
});
