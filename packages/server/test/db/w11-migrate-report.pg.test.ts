/**
 * W11-migrate dry-run report (plan 01a0d9eb §3 W11 steps 1, 2, 4; K13 as the
 * owner's explicit mapping) against a real schema. Two spaces share folders the
 * way the 7 on the prod copy do: the chain is applied up to 233, the double
 * grants are seeded there (234 refuses a new one), then 234 and later are
 * applied on top. The owning space always comes from the mapping; activity is
 * a report column.
 *
 *   folder F  granted to A and B. A: one session 40 days old. B: two sessions
 *             in the window (one running) and a chat whose cwd is under F with
 *             a message in the window  -> activity B 3, A 0.
 *   folder G  granted to A and B. A: one exited session in the window. B: a
 *             project chat on G, created in the window, and a worktree
 *             -> activity 1 each.
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
  type W11Evidence,
  type W11Report,
} from '../../src/projects/w11-migrate.js';
import type { OwningSpaceMapping } from '../../src/projects/owning-space.js';
import { main } from '../../src/projects/w11-migrate-cli.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

const ordinal = (file: string): number => Number(file.slice(0, 3));
const BEFORE = migrationFiles().filter((f) => ordinal(f) < 234);
const FROM_W11 = migrationFiles().filter((f) => ordinal(f) >= 234);

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
  /** Never created: a mapping target that is not one of the folder's grants. */
  spaceX: randomUUID(),
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
    // A is created by O (the node owner in the report's createdByOwner column).
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

/** The owner's mapping used throughout: F -> B, G -> A. */
const mapOf = (entries: Record<string, string>): OwningSpaceMapping => new Map(Object.entries(entries));

let evidence: W11Evidence[];

const reportFor = (mapping: OwningSpaceMapping): W11Report =>
  buildW11Report({ evidence, mapping, nodeOwnerIdentity: ids.identityO, asOf: AS_OF });

let report: W11Report;

beforeAll(async () => {
  database = await createW1ScratchDatabase('w11_migrate_report');
  database.apply(BEFORE);
  await seed();
  database.apply(FROM_W11);
  const all = await database.transaction(async (client) => {
    await client.query('set transaction read only');
    return loadW11Evidence(client, AS_OF);
  });
  evidence = all.filter((e) => ([ids.folderF, ids.folderG, ids.folderK] as string[]).includes(e.folderId));
  report = reportFor(mapOf({ [ids.folderF]: ids.spaceB, [ids.folderG]: ids.spaceA }));
}, 240_000);

afterAll(async () => {
  await database?.destroy();
}, 180_000);

const projectIn = (r: W11Report, folderId: string) => r.projects.find((p) => p.folderId === folderId)!;
const spaceIn = (r: W11Report, folderId: string, spaceId: string) =>
  projectIn(r, folderId).spaces.find((s) => s.spaceId === spaceId)!;

describe('W11-migrate dry-run report on a two-space node', () => {
  it('reports only the folders granted twice', () => {
    expect(report.projects.map((p) => p.folderId).sort()).toEqual([ids.folderF, ids.folderG].sort());
  });

  it('F -> B from the mapping; the idle space is unlinked; activity and creator are report columns', () => {
    expect(projectIn(report, ids.folderF)).toMatchObject({ decision: { ok: true, spaceId: ids.spaceB }, liveSessions: 1 });
    expect(spaceIn(report, ids.folderF, ids.spaceB)).toMatchObject({
      sessions: 2, sessionsInWindow: 2, liveSessions: 1, chats: 1, chatsInWindow: 1,
      activity30d: 3, createdByOwner: false, action: 'keep',
    });
    expect(spaceIn(report, ids.folderF, ids.spaceA)).toMatchObject({
      sessions: 1, sessionsInWindow: 0, activity30d: 0, createdByOwner: true, action: 'unlink',
    });
  });

  it('G -> A from the mapping; the active other space is the owner\'s call, with its branch as evidence', () => {
    expect(projectIn(report, ids.folderG)).toMatchObject({ decision: { ok: true, spaceId: ids.spaceA }, liveSessions: 0 });
    expect(spaceIn(report, ids.folderG, ids.spaceB)).toMatchObject({
      chats: 1, chatsInWindow: 1, activity30d: 1, action: 'owner_decides',
      worktrees: 1, activeWorktrees: 1, worktreeBranches: ['w11r/b-feature'],
    });
  });

  it('activity decides nothing: F mapped to its idle space is owned by that space', () => {
    const r = reportFor(mapOf({ [ids.folderF]: ids.spaceA, [ids.folderG]: ids.spaceA }));
    expect(projectIn(r, ids.folderF).decision).toEqual({ ok: true, spaceId: ids.spaceA });
    expect(spaceIn(r, ids.folderF, ids.spaceB)).toMatchObject({ activity30d: 3, action: 'owner_decides' });
  });

  it('a folder the mapping leaves out is refused, and so is one mapped outside its grants', () => {
    const r = reportFor(mapOf({ [ids.folderF]: ids.spaceB, [ids.folderG]: ids.spaceX }));
    expect(projectIn(r, ids.folderG).decision).toEqual({ ok: false, reason: 'mapped_space_not_granted', spaceId: ids.spaceX });
    const unmapped = reportFor(mapOf({ [ids.folderF]: ids.spaceB }));
    expect(projectIn(unmapped, ids.folderG).decision).toEqual({ ok: false, reason: 'unmapped' });
    expect(projectIn(unmapped, ids.folderG).spaces.map((s) => s.action)).toEqual([null, null]);
    expect(realRunRefusals(unmapped)).toContainEqual({ code: 'unmapped', folderId: ids.folderG });
    expect(realRunRefusals(r)).toContainEqual({ code: 'mapped_space_not_granted', folderId: ids.folderG, spaceId: ids.spaceX });
  });

  it('with the full mapping a real run refuses F for its live session while G passes', () => {
    expect(realRunRefusals(report)).toEqual([{ code: 'live_sessions', folderId: ids.folderF, liveSessions: 1 }]);
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
        const code = await main(['--as-of', AS_OF, ...args], { TM8_DATABASE_URL: database.url });
        return { code, out: out.join(''), err: err.join('') };
      } finally {
        o.mockRestore();
        e.mockRestore();
      }
    };
    const mappingFile = (t: Record<string, string>) => {
      const file = join(mkdtempSync(join(tmpdir(), 'w11r-')), 'mapping.json');
      writeFileSync(file, JSON.stringify(t));
      return file;
    };
    const full = () => mappingFile({ [ids.folderF]: ids.spaceB, [ids.folderG]: ids.spaceA });

    it('without --mapping the job does not run at all (exit 64), dry run or not', async () => {
      for (const args of [['--dry-run'], []]) {
        const { code, err, out } = await run(args);
        expect(code).toBe(64);
        expect(err).toContain('--mapping');
        expect(out).toBe('');
      }
    });

    it('--dry-run prints one row per folder from the mapping and exits 0', async () => {
      const { code, out } = await run(['--mapping', full(), '--dry-run']);
      expect(code).toBe(0);
      expect(out).toContain('| W11R F `' + DIR_F + '` | W11R B | W11R A → unlink | 1 → REFUSE until stopped |');
      expect(out).toContain('| W11R G `' + DIR_G + '` | W11R A | W11R B → owner_decides | 0 |');
      expect(out).not.toContain('W11R K');
    });

    it('a real run with G missing from the mapping is REFUSED for G (exit 2)', async () => {
      const { code, err } = await run(['--mapping', mappingFile({ [ids.folderF]: ids.spaceB })]);
      expect(code).toBe(2);
      expect(err).toContain(`"unmapped","folderId":"${ids.folderG}"`);
    });

    it('a real run with the full mapping is REFUSED for F\'s live session only', async () => {
      const { code, err } = await run(['--mapping', full()]);
      expect(code).toBe(2);
      expect(err).toContain(`"live_sessions","folderId":"${ids.folderF}"`);
      expect(err).not.toContain(ids.folderG);
    });

    it('with no live session and a full mapping nothing refuses, and the job still stops: the real run is an owner step', async () => {
      // The fixture stops B's session directly; R29's guard admits only the transition claim.
      await asOwner(async (q) => {
        await q.query(`select set_config('tm8.work_session_transition', 'on', true)`);
        await q.query(`update public.work_sessions set status = 'exited' where entity_id = $1`, [ids.wsB1]);
      });
      const { code, err } = await run(['--mapping', full()]);
      expect(code).toBe(3);
      expect(err).toContain('owner step');
      expect(err).not.toContain('REFUSED');
    });
  });
});
