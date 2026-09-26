/**
 * TIER 2 COMPLETION LIVE PROOF — cherry-pick / branch / stash through the
 * BUILT BINARY against a REAL Server, a REAL scratch database, and a REAL
 * worktree entity born from the REAL door (`public.create_worktree`). The
 * shape (and the setup rationale) is worktree-git.test.ts's, verbatim: rows
 * that belong to other groups are created by raw fetch/psql so no coverage
 * is implied, and the door is called with transaction-local claims exactly
 * as the server binds them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

import { runGit } from '@tm8/execution/worktree';

import { assertBuilt, cli, startRealServer, type RealServer } from './harness.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const exec = promisify(execFile);
const BINARY_TIMEOUT_MS = 60_000;

const PSQL = ['-w', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-q', '-t', '-A'] as const;
const PG_ENV = { ...process.env, PGCONNECT_TIMEOUT: '10' };

function adminBase(): string {
  const explicit = process.env['TM8_W4_ADMIN_DATABASE_URL'] ?? process.env['TM8_MIGRATION_DATABASE_URL'];
  if (explicit) return explicit;
  const port = process.env['TM8_PG_PORT'] ?? '5442';
  const user = process.env['TM8_PG_USER'] ?? 'tm8';
  return `postgres://${user}@127.0.0.1:${port}/postgres`;
}

async function psql(url: string, sql: string): Promise<string> {
  const { stdout } = await exec('psql', [...PSQL, url, '-c', sql], { env: PG_ENV });
  return stdout.trim();
}

async function scratchUrl(label: string): Promise<string> {
  const name = await psql(adminBase(),
    `select datname from pg_database where datname like 'tm8_w4_${label}_${process.pid}_%'`);
  if (!/^tm8_w4_[a-z0-9_]+$/.test(name)) throw new Error(`scratch database not found for ${label}`);
  const url = new URL(adminBase());
  url.pathname = `/${name}`;
  return url.href;
}

let server: RealServer;
let base: string;
let repoRoot: string;
let wt: string;
let spaceId: string;
let memberId: string;
let taskId: string;
let worktreeId: string;

let mutationSeq = 0;
const cmid = (): string => `tier2c-live-${process.pid}-${++mutationSeq}`;

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(new URL(path, server.baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { data?: T; error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`setup ${path} answered ${res.status}: ${JSON.stringify(parsed.error)}`);
  return parsed.data as T;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(new URL(path, server.baseUrl));
  const parsed = (await res.json()) as { data?: T };
  if (!res.ok) throw new Error(`read ${path} answered ${res.status}`);
  return parsed.data as T;
}

async function git(args: string[], cwd: string): Promise<string> {
  const res = await runGit(args, { cwd });
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

beforeAll(async () => {
  await assertBuilt();
  server = await startRealServer('wtgit2');

  base = await mkdtemp(join(tmpdir(), 'tm8-tier2c-live-'));
  repoRoot = join(base, 'repo');
  wt = join(base, 'session-worktree');
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(join(repoRoot, 'shared.txt'), 'line-1\nline-2\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'], repoRoot);
  await git(['worktree', 'add', '-b', 'tm8/session', wt, 'HEAD'], repoRoot);
  const baseOid = await git(['rev-parse', 'HEAD'], repoRoot);

  const created = await post<{ space: { id: string }; memberId: string }>('/v2/spaces', {
    name: `tier2c live ${process.pid}`, clientMutationId: cmid(),
  });
  spaceId = created.space.id;
  memberId = created.memberId;
  void memberId;
  const task = await post<{ entity: { id: string } }>('/v2/entities', {
    clientMutationId: cmid(), spaceId, kind: 'task', title: 'tier2c owning task',
  });
  taskId = task.entity.id;
  const project = await post<{ project: { id: string } } & { id?: string }>('/v2/projects', {
    clientMutationId: cmid(), name: 'tier2c live project', workingDir: repoRoot,
  });
  const projectId = (project as { project?: { id: string } }).project?.id ?? (project as { id?: string }).id;
  if (!projectId) throw new Error(`projects.create returned no id: ${JSON.stringify(project)}`);
  await post(`/v2/spaces/${spaceId}/projects`, { clientMutationId: cmid(), projectId })
    .catch(() => undefined);

  const db = await scratchUrl('wtgit2');
  const identityId = await psql(db, `select identity_id from public.members where entity_id = '${memberId}'`);
  if (!identityId) throw new Error('owner member has no identity_id');
  const doorResult = await psql(db, [
    'begin;',
    `select set_config('tm8.identity_id', '${identityId}', true);`,
    `select set_config('tm8.node_admin', 'false', true);`,
    `select public.create_worktree('${spaceId}'::uuid, '${projectId}'::uuid, ` +
      `'${wt}', 'tm8/session', 'main', '${baseOid}', null, '${randomUUID()}');`,
    'commit;',
  ].join('\n'));
  const doorJson = JSON.parse(doorResult.split('\n').filter((l) => l.startsWith('{')).pop() ?? '{}') as {
    entity?: { id?: string }; entityId?: string; affectedEntityIds?: string[];
  };
  worktreeId = doorJson.entity?.id ?? doorJson.entityId ?? doorJson.affectedEntityIds?.[0] ?? '';
  if (!worktreeId) throw new Error(`create_worktree returned no entity id: ${doorResult}`);

  await post('/v2/edges', { clientMutationId: cmid(), srcId: taskId, dstId: worktreeId, type: 'in_worktree' });
}, 180_000);

afterAll(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
  await server?.stop();
});

const SCRUB = Object.fromEntries(
  ['TM8_AGENT_TOKEN', 'TM8_ACTOR_ID', 'TM8_SESSION_ID', 'TM8_SPACE_ID', 'TM8_TEAM_MEMBER_ID',
    'TM8_CREDENTIALS_PATH', 'TM8_CREDENTIALS_MODE', 'TM8_CONFIG_PATH'].map((k) => [k, '']),
);

const tm8 = (argv: readonly string[]) => cli([...argv, '--space', spaceId], server, SCRUB);

// ── the proof ───────────────────────────────────────────────────────────────

describe('cherry-pick, live', () => {
  it('applies a main-side commit onto the session branch and posts the receipt', async () => {
    await writeFile(join(repoRoot, 'main-feature.txt'), 'from main\n');
    await git(['add', '.'], repoRoot);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main feature'], repoRoot);
    const oid = await git(['rev-parse', 'HEAD'], repoRoot);

    const res = await tm8(['worktree', 'cherry-pick', worktreeId, oid, '--format', 'json']);
    expect(res.code, res.stderr).toBe(0);
    const data = JSON.parse(res.stdout) as { status: string; newOids: string[] };
    expect(data.status).toBe('picked');
    expect(data.newOids).toHaveLength(1);
    await stat(join(wt, 'main-feature.txt'));

    const page = await get<{ items: Array<{ content?: { body?: string } }> }>(
      `/v2/entities/${worktreeId}/messages?limit=10`);
    expect(page.items.some((m) => m.content?.body?.includes('cherry-pick'))).toBe(true);
  }, BINARY_TIMEOUT_MS * 2);

  it('a REAL conflict exits 6, surfaces on the owning task, and leaves the worktree verifiably clean', async () => {
    // Session commits one version of shared.txt; main commits another.
    await writeFile(join(wt, 'shared.txt'), 'line-1 SESSION\nline-2\n');
    const cp = await tm8(['session', 'checkpoint', worktreeId, '--format', 'json']);
    expect(cp.code, cp.stderr).toBe(0);
    await writeFile(join(repoRoot, 'shared.txt'), 'line-1 MAIN\nline-2\n');
    await git(['add', '.'], repoRoot);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main edits shared'], repoRoot);
    const conflictOid = await git(['rev-parse', 'HEAD'], repoRoot);
    const headBefore = await git(['rev-parse', 'HEAD'], wt);

    const res = await tm8(['worktree', 'cherry-pick', worktreeId, conflictOid]);
    expect(res.code).toBe(6);

    // Durable message on the OWNING TASK naming the path; open attention there.
    const page = await get<{ items: Array<{ content?: { body?: string } }> }>(
      `/v2/entities/${taskId}/messages?limit=10`);
    const msg = page.items.find((m) => m.content?.body?.includes('CHERRY-PICK CONFLICT'));
    expect(msg?.content?.body).toContain('shared.txt');
    expect(msg?.content?.body).toContain('ABORTED');
    const attention = await get<{ items: Array<{ entityId: string; status: string; reason: string }> }>(
      `/v2/attention-requests?spaceId=${spaceId}&entityId=${taskId}&status=open`);
    expect(attention.items.some((a) => a.reason.includes('cherry-pick conflict'))).toBe(true);

    // The worktree, read from git state: clean, HEAD unmoved, no sequencer.
    expect(await git(['status', '--porcelain'], wt)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(headBefore);
    expect((await runGit(['rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'], { cwd: wt })).code).not.toBe(0);
  }, BINARY_TIMEOUT_MS * 2);
});

describe('branch ops, live', () => {
  it('create succeeds; deleting a checked-out or base branch refuses; unmerged delete gates on --force', async () => {
    const created = await tm8(['worktree', 'branch', 'create', worktreeId, 'feat/spike', '--format', 'json']);
    expect(created.code, created.stderr).toBe(0);

    // main is checked out in the PRIMARY tree AND is the recorded base.
    const primary = await tm8(['worktree', 'branch', 'delete', worktreeId, 'main', '--force']);
    expect(primary.code).toBe(6);
    expect(primary.stderr).toContain('checked out');

    // Make feat/spike unmerged: give it a commit the session lacks.
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit',
      '--allow-empty', '-m', 'spike-only'], repoRoot);
    await git(['update-ref', 'refs/heads/feat/spike', await git(['rev-parse', 'main'], repoRoot)], repoRoot);

    const refused = await tm8(['worktree', 'branch', 'delete', worktreeId, 'feat/spike']);
    expect(refused.code).toBe(6);
    expect(refused.stderr).toContain('not merged into');
    expect(refused.stderr).toContain('tm8/session'); // what "unmerged" was measured against

    const forced = await tm8(['worktree', 'branch', 'delete', worktreeId, 'feat/spike', '--force', '--format', 'json']);
    expect(forced.code, forced.stderr).toBe(0);
    const data = JSON.parse(forced.stdout) as { deletedOid: string; forced: boolean };
    expect(data.forced).toBe(true);
    expect(data.deletedOid).toMatch(/^[0-9a-f]{40}$/);
  }, BINARY_TIMEOUT_MS * 4);
});

describe('stash, live', () => {
  it('push sweeps WIP (untracked included), list shows it, pop restores it, drop gates on --force', async () => {
    await writeFile(join(wt, 'stash-me.txt'), 'wip\n');
    const pushed = await tm8(['worktree', 'stash', 'push', worktreeId, '--message', 'tm8 live wip', '--format', 'json']);
    expect(pushed.code, pushed.stderr).toBe(0);
    expect(await git(['status', '--porcelain'], wt)).toBe('');

    const listed = await tm8(['worktree', 'stash', 'list', worktreeId]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('tm8 live wip');

    const bare = await tm8(['worktree', 'stash', 'drop', worktreeId]);
    expect(bare.code).toBe(6);
    expect(bare.stderr).toContain('force');

    const popped = await tm8(['worktree', 'stash', 'pop', worktreeId]);
    expect(popped.code, popped.stderr).toBe(0);
    expect(await readFile(join(wt, 'stash-me.txt'), 'utf8')).toBe('wip\n');

    // Push again and destroy it, with the recoverable oid in the output.
    const again = await tm8(['worktree', 'stash', 'push', worktreeId, '--format', 'json']);
    expect(again.code, again.stderr).toBe(0);
    const dropped = await tm8(['worktree', 'stash', 'drop', worktreeId, '--force', '--format', 'json']);
    expect(dropped.code, dropped.stderr).toBe(0);
    const data = JSON.parse(dropped.stdout) as { droppedOid: string };
    expect(data.droppedOid).toMatch(/^[0-9a-f]{40}$/);
  }, BINARY_TIMEOUT_MS * 6);

  it('the suite is bound to one migration chain', async () => {
    await server.assertBindCoherent();
  });
});
