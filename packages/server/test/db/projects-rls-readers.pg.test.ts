/**
 * R845-F4 / R845-F7 — two server readers of `public.projects`, as a loopback
 * owner who owns a space but is NOT a node admin, against real Postgres.
 *
 * 234 narrowed `projects_select` to an unpinned gate (node) admin. Both readers
 * below ran as the loopback owner and assumed that owner was one:
 *
 *   F4  the commit recorder joined `public.projects` for the lane's repo_url
 *       and folder name, so the join dropped every lane and the tick recorded
 *       nothing, silently. Fixed by `worktree_repo_source` (274), which keeps
 *       the FOLDER name as the `local:<name>` key (a2: no existing commit row
 *       re-keys).
 *   F7  the launch bootstrap read the launch folder from `public.projects`,
 *       missed it and called `create_project`, which fails boot: either
 *       `require_node_admin` refuses it or, for an owner account it admits
 *       (this fixture), the insert collides with the registered folder on
 *       projects_working_dir_key. Fixed by reading through the member-scoped
 *       `space_folders_for_caller` (234) and never registering as a non-admin.
 *
 * Real Postgres and not a fake: the failure IS the RLS policy answering zero
 * rows, which a fake only reproduces if it was written to (the F7 fake at
 * launch-bootstrap.test.ts did not, which is how this shipped).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ensureLaunchResources } from '../../src/bootstrap/launch-resources.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { runCommitRecorderTick } from '../../src/tracking/commit-recorder.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const OWNER = 'id_space_owner_not_node_admin';
/** A real identity with an account and no membership anywhere. */
const STRANGER = 'id_stranger_no_membership';
/** The folder's name on the gate. The space's project entity may be renamed; this is the key. */
const FOLDER_NAME = 'r845-folder';

let database: W1ScratchDatabase;
let db: Db;
let root: string;
let baseOid: string;
let headSha: string;

const ids: Record<'space' | 'member' | 'folder' | 'worktree' | 'session' | 'other' | 'otherMember', string> = {
  space: '', member: '', folder: '', worktree: '', session: '', other: '', otherMember: '',
};

/** The loopback owner's claims: a real identity, not a node admin. */
const ownerClaims: DbClaims = { identityId: OWNER, nodeAdmin: false };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'R845 lane', GIT_AUTHOR_EMAIL: 'r845@example.invalid',
      GIT_COMMITTER_NAME: 'R845 lane', GIT_COMMITTER_EMAIL: 'r845@example.invalid',
    },
  }).trim();
}

async function asGraphOwner(sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query(sql, [...params])).rows;
  });
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'tm8-r845-'));
  git(root, ['init', '--quiet', '--initial-branch=main', '.']);
  git(root, ['commit', '--allow-empty', '-q', '-m', 'base']);
  baseOid = git(root, ['rev-parse', 'HEAD']);
  git(root, ['commit', '--allow-empty', '-q', '-m', 'lane work']);
  headSha = git(root, ['rev-parse', 'HEAD']);

  database = await createW1ScratchDatabase('r845_projects_rls_readers');
  database.apply(migrationFiles());

  const fresh = await database.query<{ id: string }>(
    'select internal.new_id()::text as id from generate_series(1, 7)',
  );
  const keys = ['space', 'member', 'folder', 'worktree', 'session', 'other', 'otherMember'] as const;
  keys.forEach((key, index) => { ids[key] = fresh[index]!.id; });

  await asGraphOwner(
    `insert into public.user_profiles(identity_id, display_name) values ($1, 'Owner'), ($2, 'Stranger')`,
    [OWNER, STRANGER],
  );
  await asGraphOwner(
    `insert into public.accounts(identity_id, username, is_node_admin, is_owner)
     values ($1, $1, false, true), ($2, $2, false, false)`,
    [OWNER, STRANGER],
  );
  await asGraphOwner(
    `insert into public.spaces(id, name, created_by_identity) values ($1, 'R845 home', $3), ($2, 'R845 other', $3)`,
    [ids.space, ids.other, OWNER],
  );
  await asGraphOwner(
    `insert into public.entities(id, space_id, kind, created_by, visibility)
     values ($1, $2, 'member', $1, 'space'), ($3, $4, 'member', $3, 'space')`,
    [ids.member, ids.space, ids.otherMember, ids.other],
  );
  await asGraphOwner(
    `insert into public.members(entity_id, space_id, identity_id, role, display_name)
     values ($1, $2, $5, 'owner', 'Owner'), ($3, $4, $5, 'owner', 'Owner')`,
    [ids.member, ids.space, ids.otherMember, ids.other, OWNER],
  );
  // The launch folder, already registered on the gate and granted to the home
  // space: the F7 precondition. No remote, so the recorder writes local:<name>.
  await asGraphOwner(
    `insert into public.projects(id, name, working_dir, repo_url, trust) values ($1, $2, $3, null, 'trusted')`,
    [ids.folder, FOLDER_NAME, root],
  );
  await asGraphOwner(
    `insert into public.space_projects(space_id, project_id, linked_by) values ($1, $2, $3)`,
    [ids.space, ids.folder, ids.member],
  );
  // One active lane cut from that folder, with the session that works in it.
  await asGraphOwner(
    `insert into public.entities(id, space_id, kind, created_by, visibility)
     values ($1, $3, 'worktree', $4, 'space'), ($2, $3, 'work_session', $4, 'space')`,
    [ids.worktree, ids.session, ids.space, ids.member],
  );
  await asGraphOwner(
    // W11-repoint: a worktree is keyed on the space's project entity, not the folder.
    `insert into public.worktrees(entity_id, space_id, project_entity_id, path, branch, base_ref, base_commit_oid, status)
     select $1, $5, l.project_entity_id, $3, 'tm8/r845', 'main', $4, 'active'
       from public.project_links l where l.space_id = $5 and l.project_id = $2`,
    [ids.worktree, ids.folder, root, baseOid, ids.space],
  );
  await asGraphOwner(
    `insert into public.work_sessions(entity_id, title, status, share_mode, workdir_mode) values ($1, 'R845 lane', 'running', 'space', 'scratch')`,
    [ids.session],
  );
  await asGraphOwner(
    `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'in_worktree', $4)`,
    [ids.space, ids.session, ids.worktree, ids.member],
  );

  db = createDb(database.url);
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('the precondition: 234 hides the folder from this owner', () => {
  it('public.projects reads zero rows for a space owner who is not a node admin', async () => {
    const rows = await db.query(ownerClaims, 'select id from public.projects where id = $1', [ids.folder]);
    expect(rows).toEqual([]);
  });
});

describe('R845-F4 — the commit recorder, as a non-node-admin space owner', () => {
  it('a1: records the lane\'s commit under local:<folder name>, and a2: onto the row the old key already made', async () => {
    // An existing row under the pre-fix key, as a node-admin recorder wrote it
    // before 234: the fix must land on it, not mint a second mirror.
    await db.rpc(ownerClaims, 'public.record_session_commit', [
      ids.session, `local:${FOLDER_NAME}`, headSha, 'lane work', 'R845 lane', new Date().toISOString(),
    ]);

    const outcome = await runCommitRecorderTick({ db, claims: async () => ownerClaims });

    expect(outcome.skipped).not.toBe(true);
    expect(outcome.detail).toMatchObject({ lanes: 1, recorded: 1, unreadable: 0 });
    const commits = await asGraphOwner(
      'select repo from public.commits where space_id = $1 and sha = $2', [ids.space, headSha],
    );
    expect(commits).toEqual([{ repo: `local:${FOLDER_NAME}` }]);
  });

  it('a session pinned to another space of the same owner resolves no lane (the reader is pinned)', async () => {
    const pinned = await db.query(
      { ...ownerClaims, sessionSpaceId: ids.other },
      'select * from public.worktree_repo_source($1)', [ids.worktree],
    );
    expect(pinned).toEqual([]);
    const own = await db.query(ownerClaims, 'select * from public.worktree_repo_source($1)', [ids.worktree]);
    expect(own).toEqual([{ repo_url: null, folder_name: FOLDER_NAME }]);
  });

  it('the same pin through the tick: a recorder whose claims are pinned to the other space finds no lane', async () => {
    const outcome = await runCommitRecorderTick({
      db, claims: async () => ({ ...ownerClaims, sessionSpaceId: ids.other }),
    });
    expect(outcome).toMatchObject({ skipped: true });
  });

  it('an unpinned identity that is a member of no space resolves nothing, directly or through the tick', async () => {
    const strangerClaims: DbClaims = { identityId: STRANGER, nodeAdmin: false };
    const direct = await db.query(strangerClaims, 'select * from public.worktree_repo_source($1)', [ids.worktree]);
    expect(direct).toEqual([]);
    const outcome = await runCommitRecorderTick({ db, claims: async () => strangerClaims });
    expect(outcome).toMatchObject({ skipped: true });
  });
});

describe('R845-F7 — the launch bootstrap, as a non-node-admin space owner', () => {
  it('a1: boots with the already-registered launch folder, and neither registers nor grants it', async () => {
    const result = await ensureLaunchResources({
      db,
      owner: { identityId: OWNER, accountId: 'unused', username: OWNER, isNodeAdmin: false, isOwner: true },
      projectDir: root,
    });

    expect(result.spaces).toBe(2);
    expect(result.projectId).toBe(ids.folder);
    const folders = await asGraphOwner('select id::text from public.projects where working_dir = $1', [root]);
    expect(folders).toEqual([{ id: ids.folder }]);
    const grants = await asGraphOwner(
      'select space_id::text from public.space_projects where project_id = $1', [ids.folder],
    );
    expect(grants).toEqual([{ space_id: ids.space }]);
  });
});
