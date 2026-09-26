/**
 * TIER 2 LIVE PROOF — the mutating git verbs against a REAL Server, a REAL
 * scratch database, a REAL worktree entity born from the REAL door
 * (`public.create_worktree`, the same door the provisioning saga uses), and a
 * REAL git checkout on disk. The BUILT BINARY is what runs — `cli()` spawns
 * `packages/cli/dist/index.js` the way an agent invokes it.
 *
 * WHY THE WORKTREE ROW COMES THROUGH psql. `entities.create` refuses kind
 * `worktree` BY DESIGN (born exclusively from the provisioning saga), and the
 * spawn gate that would provision one is Phase 3 (PR #67, in review). Until
 * that lands, the only honest way to a real worktree entity is the door
 * itself, called with transaction-local claims exactly as the server binds
 * them — the same technique db/test/* uses. Nothing here fakes a row shape:
 * if the door's contract moves, this suite moves with it.
 *
 * Setup rows (Space, task, project, edge) are created by RAW FETCH,
 * deliberately — they belong to other groups, and routing them through CLI
 * commands this slot does not own would quietly claim coverage of them.
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

// ── psql access to THIS run's scratch database ──────────────────────────────

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

/**
 * The harness names its scratch database `tm8_w4_<label>_<pid>_<random>` and
 * does not export the URL; the label + THIS pid identify it uniquely.
 */
async function scratchUrl(label: string): Promise<string> {
  const name = await psql(adminBase(),
    `select datname from pg_database where datname like 'tm8_w4_${label}_${process.pid}_%'`);
  if (!/^tm8_w4_[a-z0-9_]+$/.test(name)) throw new Error(`scratch database not found for ${label}`);
  const url = new URL(adminBase());
  url.pathname = `/${name}`;
  return url.href;
}

// ── the world ───────────────────────────────────────────────────────────────

let server: RealServer;
let base: string;
let repoRoot: string;
let wt: string;
let spaceId: string;
let memberId: string;
let taskId: string;
let worktreeId: string;

let mutationSeq = 0;
const cmid = (): string => `tier2-live-${process.pid}-${++mutationSeq}`;

/** SETUP ONLY — other groups' operations, called raw so no coverage is implied. */
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
  server = await startRealServer('wtgit');

  // A real repository and a real `git worktree add` checkout.
  base = await mkdtemp(join(tmpdir(), 'tm8-tier2-live-'));
  repoRoot = join(base, 'repo');
  wt = join(base, 'session-worktree');
  await mkdir(repoRoot, { recursive: true });
  await git(['init', '-b', 'main'], repoRoot);
  await writeFile(join(repoRoot, 'shared.txt'), 'line-1\nline-2\n');
  await git(['add', '.'], repoRoot);
  await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'initial'], repoRoot);
  await git(['worktree', 'add', '-b', 'tm8/session', wt, 'HEAD'], repoRoot);
  const baseOid = await git(['rev-parse', 'HEAD'], repoRoot);

  // Space, task, project (linked to the space so the door admits the worktree).
  const created = await post<{ space: { id: string }; memberId: string }>('/v2/spaces', {
    name: `tier2 live ${process.pid}`, clientMutationId: cmid(),
  });
  spaceId = created.space.id;
  memberId = created.memberId;
  const task = await post<{ entity: { id: string } }>('/v2/entities', {
    clientMutationId: cmid(), spaceId, kind: 'task', title: 'tier2 owning task',
  });
  taskId = task.entity.id;
  const project = await post<{ project: { id: string } } & { id?: string }>('/v2/projects', {
    clientMutationId: cmid(), name: 'tier2 live project', workingDir: repoRoot,
  });
  const projectId = (project as { project?: { id: string } }).project?.id ?? (project as { id?: string }).id;
  if (!projectId) throw new Error(`projects.create returned no id: ${JSON.stringify(project)}`);
  await post(`/v2/spaces/${spaceId}/projects`, { clientMutationId: cmid(), projectId })
    .catch(() => undefined); // creation may have linked already; the door checks the link, not us

  // THE DOOR. Transaction-local claims exactly as the server binds them.
  const db = await scratchUrl('wtgit');
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

  // The owning task points at the worktree the way the saga's world does.
  await post('/v2/edges', { clientMutationId: cmid(), srcId: taskId, dstId: worktreeId, type: 'in_worktree' });
}, 180_000);

afterAll(async () => {
  await rm(base, { recursive: true, force: true }).catch(() => undefined);
  await server?.stop();
});

/**
 * The spawned binary must not inherit THIS session's agent credential — when
 * the suite runs inside a tm8-spawned agent, TM8_AGENT_TOKEN & co. point at
 * the developer's live node and are INVALID tokens on the scratch Server
 * ("unauthenticated: invalid token", found live 2026-08-09). `cli()` already
 * scrubs the journal path; the identity envelope is scrubbed here, by
 * OVERRIDING with empty strings (deleting from `extraEnv` cannot help — the
 * child merges `process.env` back in).
 */
const SCRUB = Object.fromEntries(
  ['TM8_AGENT_TOKEN', 'TM8_ACTOR_ID', 'TM8_SESSION_ID', 'TM8_SPACE_ID', 'TM8_TEAM_MEMBER_ID',
    'TM8_CREDENTIALS_PATH', 'TM8_CREDENTIALS_MODE', 'TM8_CONFIG_PATH'].map((k) => [k, '']),
);

const tm8 = (argv: readonly string[]) => cli([...argv, '--space', spaceId], server, SCRUB);

// ── the proof ───────────────────────────────────────────────────────────────

describe('checkpoint → mutate → rollback, live', () => {
  let checkpointOid = '';

  it('checkpoint commits real WIP through the built binary and posts the receipt', async () => {
    await writeFile(join(wt, 'agent-work.txt'), 'draft v1\n');
    await writeFile(join(wt, 'shared.txt'), 'line-1 SESSION\nline-2\n');
    const res = await tm8(['session', 'checkpoint', worktreeId, '--format', 'json']);
    expect(res.code, res.stderr).toBe(0);
    const data = JSON.parse(res.stdout) as { oid: string; created: boolean; files: unknown[] };
    expect(data.created).toBe(true);
    expect(data.oid).toMatch(/^[0-9a-f]{40}$/);
    checkpointOid = data.oid;
    expect(await git(['rev-parse', 'tm8/session'], wt)).toBe(checkpointOid);
    expect(await git(['status', '--porcelain'], wt)).toBe('');

    // The durable receipt is REAL — read it back from the server.
    const page = await get<{ items: Array<{ content?: { body?: string } }> }>(
      `/v2/entities/${worktreeId}/messages?limit=10`);
    expect(page.items.some((m) => m.content?.body?.includes(checkpointOid))).toBe(true);
  }, BINARY_TIMEOUT_MS * 2);

  it('rollback refuses over an untracked file, then restores exactly with --force', async () => {
    // Mutate AFTER the checkpoint: tracked edit + a brand-new untracked file.
    await writeFile(join(wt, 'agent-work.txt'), 'draft v2 GONE WRONG\n');
    await writeFile(join(wt, 'untracked-scratch.txt'), 'never committed\n');

    const refused = await tm8(['session', 'rollback', worktreeId, '--to', checkpointOid]);
    expect(refused.code).toBe(6);
    expect(refused.stderr).toContain('untracked');
    expect(await readFile(join(wt, 'agent-work.txt'), 'utf8')).toBe('draft v2 GONE WRONG\n');

    const forced = await tm8(['session', 'rollback', worktreeId, '--to', checkpointOid, '--force']);
    expect(forced.code, forced.stderr).toBe(0);
    // RESTORED STATE, shown: the tracked edit is back at v1, the untracked
    // file is gone, the branch tip is the checkpoint, the tree is clean.
    expect(await readFile(join(wt, 'agent-work.txt'), 'utf8')).toBe('draft v1\n');
    await expect(stat(join(wt, 'untracked-scratch.txt'))).rejects.toThrow();
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(checkpointOid);
    expect(await git(['status', '--porcelain'], wt)).toBe('');
  }, BINARY_TIMEOUT_MS * 2);
});

describe('the commit rail, live', () => {
  it('stage lists first, stages what it is told, and commit writes exactly the index', async () => {
    await writeFile(join(wt, 'rail-a.txt'), 'a\n');
    await writeFile(join(wt, 'rail-b.txt'), 'b\n');

    const listed = await tm8(['worktree', 'stage', worktreeId]);
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('rail-a.txt');
    expect(listed.stdout).toContain('rail-b.txt');
    expect(await git(['diff', '--cached', '--name-only'], wt)).toBe('');

    const staged = await tm8(['worktree', 'stage', worktreeId, 'rail-a.txt']);
    expect(staged.code, staged.stderr).toBe(0);
    const done = await tm8(['worktree', 'commit', worktreeId, '--message', 'rail: a only']);
    expect(done.code, done.stderr).toBe(0);
    expect(await git(['log', '-1', '--pretty=%s'], wt)).toBe('rail: a only');
    expect((await git(['show', '--name-only', '--pretty=format:', 'HEAD'], wt)).trim()).toBe('rail-a.txt');
    // rail-b stays WIP; sweep it into a checkpoint so the merge stage starts clean.
    const sweep = await tm8(['session', 'checkpoint', worktreeId, '--message', 'tm8 checkpoint sweep']);
    expect(sweep.code, sweep.stderr).toBe(0);
  }, BINARY_TIMEOUT_MS * 4);
});

describe('merge conflict, live — durable message + attention, worktree left clean', () => {
  it('a real conflict aborts cleanly and surfaces on the owning task', async () => {
    // main edits the SAME line the session checkpointed earlier.
    await writeFile(join(repoRoot, 'shared.txt'), 'line-1 MAIN\nline-2\n');
    await git(['add', '.'], repoRoot);
    await git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'main moves'], repoRoot);
    const headBefore = await git(['rev-parse', 'HEAD'], wt);

    const res = await tm8(['worktree', 'merge', worktreeId, '--from', 'main']);
    expect(res.code).toBe(6);

    // Durable message on the OWNING TASK, naming the conflicted path.
    const page = await get<{ items: Array<{ content?: { body?: string } }> }>(
      `/v2/entities/${taskId}/messages?limit=10`);
    const conflictMsg = page.items.find((m) => m.content?.body?.includes('MERGE CONFLICT'));
    expect(conflictMsg?.content?.body).toContain('shared.txt');
    expect(conflictMsg?.content?.body).toContain('ABORTED');

    // Attention raised on the same anchor, still open.
    const attention = await get<{ items: Array<{ entityId: string; status: string; reason: string }> }>(
      `/v2/attention-requests?spaceId=${spaceId}&entityId=${taskId}&status=open`);
    expect(attention.items.some((a) => a.reason.includes('merge conflict'))).toBe(true);

    // The worktree: clean, HEAD unmoved, no merge residue, no markers.
    expect(await git(['status', '--porcelain'], wt)).toBe('');
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(headBefore);
    expect((await runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt })).code).not.toBe(0);
    expect(await readFile(join(wt, 'shared.txt'), 'utf8')).not.toContain('<<<<<<<');
  }, BINARY_TIMEOUT_MS * 2);

  it('the suite is bound to one migration chain', async () => {
    await server.assertBindCoherent();
  });
});
