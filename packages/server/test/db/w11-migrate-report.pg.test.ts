/**
 * W11-migrate dry-run report (plan 01a0d9eb §3 W11 steps 1, 2, 4; K13) against
 * a real schema. Two spaces share folders the way the 7 on the prod copy do:
 * the chain is applied up to 230, the double grants are seeded there (231
 * refuses a new one), then 231 and later are applied on top.
 *
 *   folder F  granted to A and B. A: one session 40 days old. B: two sessions
 *             in the window (one running) and a chat whose cwd is under F with
 *             a message in the window  -> owner B (3), A idle -> unlink.
 *   folder G  granted to A and B. A: one exited session in the window. B: a
 *             project chat on G, created in the window, and a worktree
 *             -> tie at 1, A (created by the personal identity) owns, B active
 *             -> clone, carrying its branch.
 *   folder K  granted to A only -> not in the report.
 *
 * A chat whose cwd only LOOKS like it is under G (`_` is a LIKE wildcard) is
 * not counted. Everything runs in a READ ONLY transaction, so a write in the
 * loader would fail the test.
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildW11Report,
  loadW11Evidence,
  realRunRefusals,
  type W11Report,
} from '../../src/projects/w11-migrate.js';
import { main } from '../../src/projects/w11-migrate-cli.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const ordinal = (file: string): number => Number(file.slice(0, 3));
const BEFORE = migrationFiles().filter((f) => ordinal(f) < 231);
const FROM_W11 = migrationFiles().filter((f) => ordinal(f) >= 231);

const AS_OF = '2026-09-24T18:40:00.000Z';
const daysBefore = (n: number) => new Date(Date.parse(AS_OF) - n * 86_400_000).toISOString();

let database: W1ScratchDatabase;

const ids = {
  identityO: `w11r-o-${randomUUID()}`,
  identityH: `w11r-h-${randomUUID()}`,
  accountO: randomUUID(),
  accountH: randomUUID(),
  spaceA: randomUUID(),
  spaceB: randomUUID(),
  memberA: randomUUID(),
  memberB: randomUUID(),
  personaA: randomUUID(),
  personaB: randomUUID(),
  folderF: randomUUID(),
  folderG: randomUUID(),
  folderK: randomUUID(),
  wsAold: randomUUID(),
  wsB1: randomUUID(),
  wsB2: randomUUID(),
  wsAg: randomUUID(),
  chatBf: randomUUID(),
  chatBg: randomUUID(),
  chatBdecoy: randomUUID(),
  messageBf: randomUUID(),
  wtBg: randomUUID(),
};

const DIR_F = `/tmp/w11r-${ids.folderF.slice(0, 8)}/f`;
const DIR_G = `/tmp/w11r-${ids.folderG.slice(0, 8)}/g_dir`;

type Q = { query: (sql: string, p?: unknown[]) => Promise<{ rows: any[] }> };

const asOwner = <T>(fn: (q: Q) => Promise<T>): Promise<T> =>
  database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });

async function seed(): Promise<void> {
  await asOwner(async (q) => {
    await q.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'O'), ($2, 'H')`,
      [ids.identityO, ids.identityH]);
    await q.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, $3), ($4, $5, $6)`,
      [ids.accountO, ids.identityO, `w11r-o-${ids.accountO.slice(0, 8)}`,
       ids.accountH, ids.identityH, `w11r-h-${ids.accountH.slice(0, 8)}`]);
    // A is created by O (the personal identity for ties) and is the newer one,
    // so the tie on G is decided by the creator, not by age.
    await q.query(
      `insert into public.spaces(id, name, created_by_identity, created_at)
       values ($1, 'W11R A', $3, now() - interval '10 days'), ($2, 'W11R B', $4, now() - interval '90 days')`,
      [ids.spaceA, ids.spaceB, ids.identityO, ids.identityH],
    );
    await q.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'member', $1, 'space'), ($2, $4, 'member', $2, 'space'),
              ($5, $3, 'team_member', $1, 'space'), ($6, $4, 'team_member', $2, 'space')`,
      [ids.memberA, ids.memberB, ids.spaceA, ids.spaceB, ids.personaA, ids.personaB],
    );
    await q.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $3, $5, 'owner', 'O'), ($2, $4, $6, 'owner', 'H')`,
      [ids.memberA, ids.memberB, ids.spaceA, ids.spaceB, ids.identityO, ids.identityH],
    );
    await q.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'W11R A mate', 'worker', 'persona'), ($3, $4, 'W11R B mate', 'worker', 'persona')`,
      [ids.personaA, ids.memberA, ids.personaB, ids.memberB],
    );
    await q.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'W11R F', $4, 'trusted'), ($2, 'W11R G', $5, 'trusted'), ($3, 'W11R K', $6, 'trusted')`,
      [ids.folderF, ids.folderG, ids.folderK, DIR_F, DIR_G, `${DIR_F}-k`],
    );
    await q.query(
      `insert into public.space_projects(space_id, project_id, linked_by)
       values ($1, $3, $6), ($2, $3, $7), ($1, $4, $6), ($2, $4, $7), ($1, $5, $6)`,
      [ids.spaceA, ids.spaceB, ids.folderF, ids.folderG, ids.folderK, ids.memberA, ids.memberB],
    );

    const sessions: Array<[string, string, string, string, string]> = [
      // [entity, space, persona, status, created_at]
      [ids.wsAold, ids.spaceA, ids.personaA, 'exited', daysBefore(40)],
      [ids.wsB1, ids.spaceB, ids.personaB, 'running', daysBefore(1)],
      [ids.wsB2, ids.spaceB, ids.personaB, 'exited', daysBefore(5)],
      [ids.wsAg, ids.spaceA, ids.personaA, 'exited', daysBefore(2)],
    ];
    for (const [entity, space, persona, status, createdAt] of sessions) {
      await q.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'work_session', $3, 'space')`, [entity, space, persona]);
      await q.query(
        `insert into public.work_sessions(entity_id, title, status, share_mode, project_id, started_at, created_at)
         values ($1, 'W11R run', $2, 'none', $3, $4, $4)`,
        [entity, status, entity === ids.wsAg ? ids.folderG : ids.folderF, createdAt],
      );
    }

    const chats: Array<[string, string, string | null, string]> = [
      // [entity, cwd, project_id, created_at] — all in B. F's and the decoy are
      // scratch chats known only by cwd (every chat on the prod copy); G's is a
      // project chat.
      [ids.chatBf, `${DIR_F}/sub`, null, daysBefore(60)],
      [ids.chatBg, DIR_G, ids.folderG, daysBefore(3)],
      [ids.chatBdecoy, `${DIR_G.replace('g_dir', 'gXdir')}/sub`, null, daysBefore(3)],
    ];
    for (const [entity, cwd, folder, createdAt] of chats) {
      await q.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                     values ($1, $2, 'chat', $3, 'space')`, [entity, ids.spaceB, ids.memberB]);
      await q.query(
        `insert into public.chats(
           entity_id, space_id, title, teammate_id, model, provider, agent_tool,
           chat_mode, workdir_mode, project_id, cwd, native_session_id,
           configured_by_identity_id, configured_by_member_id, client_mutation_id, created_at
         ) values ($1,$2,'W11R chat',$3,'claude-opus-5','anthropic','claude-code',
                   'ask',$9,$10,$4, gen_random_uuid(), $5, $6, $7, $8)`,
        [entity, ids.spaceB, ids.personaB, cwd, ids.identityH, ids.memberB, `w11r-${randomUUID()}`, createdAt,
         folder ? 'project' : 'scratch', folder],
      );
    }
    // The F chat is 60 days old but was used yesterday: its message puts it in the window.
    await q.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                   values ($1, $2, 'message', $3, 'space')`, [ids.messageBf, ids.spaceB, ids.memberB]);
    await q.query(
      `insert into public.messages(entity_id, anchor_id, author_id, body, created_at)
       values ($1, $2, $3, 'still working here', $4)`,
      [ids.messageBf, ids.chatBf, ids.memberB, daysBefore(1)],
    );

    await q.query(`insert into public.entities(id, space_id, kind, created_by, visibility)
                   values ($1, $2, 'worktree', $3, 'space')`, [ids.wtBg, ids.spaceB, ids.memberB]);
    await q.query(
      `insert into public.worktrees(entity_id, project_id, path, branch, base_ref, base_commit_oid)
       values ($1, $2, $3, 'w11r/b-feature', 'main', repeat('b', 40))`,
      [ids.wtBg, ids.folderG, `${DIR_G}/.wt/b`],
    );
  });
}

async function readReport(personalIdentity: string): Promise<W11Report> {
  const evidence = await database.transaction(async (client) => {
    await client.query('set transaction read only');
    return loadW11Evidence(client, AS_OF);
  });
  return buildW11Report({
    evidence: evidence.filter((e) => ([ids.folderF, ids.folderG, ids.folderK] as string[]).includes(e.folderId)),
    personalIdentity,
    asOf: AS_OF,
  });
}

let report: W11Report;

beforeAll(async () => {
  database = await createW1ScratchDatabase('w11_migrate_report');
  database.apply(BEFORE);
  await seed();
  database.apply(FROM_W11);
  report = await readReport(ids.identityO);
}, 240_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

const project = (folderId: string) => report.projects.find((p) => p.folderId === folderId)!;
const space = (folderId: string, spaceId: string) => project(folderId).spaces.find((s) => s.spaceId === spaceId)!;

describe('W11-migrate dry-run report on a two-space node', () => {
  it('reports only the folders granted twice', () => {
    expect(report.projects.map((p) => p.folderId).sort()).toEqual([ids.folderF, ids.folderG].sort());
  });

  it('F: the space with the most 30-day activity owns it; the idle space is unlinked', () => {
    expect(project(ids.folderF)).toMatchObject({ owningSpaceId: ids.spaceB, tie: false, liveSessions: 1 });
    expect(space(ids.folderF, ids.spaceB)).toMatchObject({
      sessions: 2, sessionsInWindow: 2, liveSessions: 1, chats: 1, chatsInWindow: 1, activity: 3, action: 'keep',
    });
    expect(space(ids.folderF, ids.spaceA)).toMatchObject({
      sessions: 1, sessionsInWindow: 0, activity: 0, action: 'unlink',
    });
  });

  it('G: a tie goes to the personal identity\'s space; the active other space gets a clone with its branch', () => {
    expect(project(ids.folderG)).toMatchObject({ owningSpaceId: ids.spaceA, tie: true, liveSessions: 0 });
    expect(space(ids.folderG, ids.spaceB)).toMatchObject({
      chats: 1, chatsInWindow: 1, activity: 1, action: 'clone',
      worktrees: 1, activeWorktrees: 1, worktreeBranches: ['w11r/b-feature'],
    });
  });

  it('the tie follows the personal identity it is given', async () => {
    const other = await readReport(ids.identityH);
    expect(other.projects.find((p) => p.folderId === ids.folderG)!.owningSpaceId).toBe(ids.spaceB);
    expect(other.projects.find((p) => p.folderId === ids.folderF)!.owningSpaceId).toBe(ids.spaceB);
  });

  it('a real run refuses without the confirmed table, and refuses F for its live session while G passes', () => {
    expect(realRunRefusals(report, null)).toEqual([{ code: 'no_confirmed_table' }]);
    expect(realRunRefusals(report, { [ids.folderF]: ids.spaceB, [ids.folderG]: ids.spaceA }))
      .toEqual([{ code: 'live_sessions', folderId: ids.folderF, liveSessions: 1 }]);
  });

  it('reading the report writes nothing: the double grants are still there', async () => {
    const rows = await database.query<{ n: number }>(
      'select count(*)::int n from public.space_projects where project_id = any($1::uuid[])',
      [[ids.folderF, ids.folderG]],
    );
    expect(rows[0]!.n).toBe(4);
  });

  describe('the job entry', () => {
    const run = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
      const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err.push(String(c)); return true; });
      try {
        const code = await main(['--as-of', AS_OF, '--personal-identity', ids.identityO, ...args],
          { TM8_DATABASE_URL: database.url });
        return { code, out: out.join(''), err: err.join('') };
      } finally {
        o.mockRestore();
        e.mockRestore();
      }
    };
    const table = (t: Record<string, string>) => {
      const file = join(mkdtempSync(join(tmpdir(), 'w11r-')), 'confirmed.json');
      writeFileSync(file, JSON.stringify(t));
      return file;
    };

    it('--dry-run prints one row per folder and exits 0', async () => {
      const { code, out } = await run(['--dry-run']);
      expect(code).toBe(0);
      expect(out).toContain('| W11R F `' + DIR_F + '` | W11R B | activity 3 | W11R A → unlink | 1 → REFUSE until stopped |');
      expect(out).toContain('| W11R G `' + DIR_G + '` | W11R A | tie at 1 → tie-break | W11R B → clone (1 branch(es)) | 0 |');
      expect(out).not.toContain('W11R K');
    });

    it('a real run with no confirmed table is REFUSED (exit 2)', async () => {
      const { code, err } = await run([]);
      expect(code).toBe(2);
      expect(err).toContain('no_confirmed_table');
    });

    it('a real run with the full table is REFUSED for F\'s live session only', async () => {
      const { code, err } = await run(['--confirmed', table({ [ids.folderF]: ids.spaceB, [ids.folderG]: ids.spaceA })]);
      expect(code).toBe(2);
      expect(err).toContain(`"live_sessions","folderId":"${ids.folderF}"`);
      expect(err).not.toContain(ids.folderG);
    });

    it('with no live session and a full table nothing refuses, and the job still stops: the real run is an owner step', async () => {
      // The fixture stops B's session directly; R29's guard admits only the transition claim.
      await asOwner(async (q) => {
        await q.query(`select set_config('tm8.work_session_transition', 'on', true)`);
        await q.query(`update public.work_sessions set status = 'exited' where entity_id = $1`, [ids.wsB1]);
      });
      const { code, err } = await run(['--confirmed', table({ [ids.folderF]: ids.spaceB, [ids.folderG]: ids.spaceA })]);
      expect(code).toBe(3);
      expect(err).toContain('owner step');
      expect(err).not.toContain('REFUSED');
    });
  });
});
