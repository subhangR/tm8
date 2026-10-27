import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectCloneJobSchema, getOperation, type OperationName, type ProjectCloneJob } from '@tm8/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/skills/service.js', () => ({ scanSpaceSkills: vi.fn(async () => ({ scannedAt: 'test', discovered: 0, upserted: 0, missing: 0, errors: [] })) }));

import { loadOrCreateCredentialKey } from '../../src/credentials/credential-key.js';
import { sealSecret } from '../../src/credentials/secret-box.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import {
  ProjectCloneService,
  cloneEnv,
  dbCloneCredentialResolver,
  parseGithubRepo,
  redactSecret,
  validateBranch,
  type CloneCredentialResolver,
  type GitRunner,
} from '../../src/facade/services/w2/project-clone.js';
import type { RequestContext } from '../../src/http/types.js';

const SPACE = '00000000-0000-7000-8000-000000000901';
const FOLDER = '00000000-0000-7000-8000-000000000902';
const PROJECT = '00000000-0000-7000-8000-000000000903';
const TOKEN = 'ghp_SECRET_TOKEN_value_1234567890';

const OWNER = {
  identityId: 'clone-owner',
  accountId: '00000000-0000-7000-8000-000000000999',
  username: 'clone-owner',
  isNodeAdmin: true,
  isOwner: true,
};
const SPACE_ADMIN = { kind: 'bearer', identityId: 'clone-space-admin', nodeAdmin: false } as RequestContext['identity'];

class FakeDb implements Db {
  readonly calls: Array<{ fn: string; args: readonly unknown[] }> = [];
  spaceAdmin = true;
  rpcAnswers: Record<string, (args: readonly unknown[]) => unknown> = {};

  tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({ query: (sql, params) => this.query(claims, sql, params), rpc: (name, args) => this.rpc(claims, name, args) });
  }

  async query<R>(_claims: DbClaims, sql: string): Promise<R[]> {
    if (sql.includes('internal.is_space_admin')) return [{ admin: this.spaceAdmin }] as R[];
    if (sql.includes('space_projects_for_caller')) {
      return [{
        project_id: PROJECT, folder_id: FOLDER, name: 'hello', repo_url: 'https://github.com/octo/hello.git',
        trust: 'untrusted', defaults: {}, materialized_version: 1,
        created_at: '2026-10-13T10:00:00.000Z', updated_at: '2026-10-13T10:00:00.000Z',
      }] as R[];
    }
    return [];
  }

  async rpc<T>(_claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    this.calls.push({ fn, args });
    const answer = this.rpcAnswers[fn];
    if (answer) return answer(args) as T;
    if (fn === 'register_space_folder') return { spaceId: args[0], folderId: FOLDER, projectId: PROJECT, created: true } as T;
    throw new Error(`unexpected rpc: ${fn}`);
  }

  async end(): Promise<void> {}
}

function request(opName: OperationName, options: { params?: Record<string, string>; body?: unknown; identity?: RequestContext['identity'] }): RequestContext {
  const op = getOperation(opName);
  return {
    op, opName,
    params: options.params ?? {},
    query: new URLSearchParams(),
    body: options.body,
    requestId: `req-${opName}`,
    identity: options.identity ?? { kind: 'auto-owner', identityId: OWNER.identityId },
    headers: {},
    method: op.method,
    path: op.path,
  };
}

/** A git that "clones" by making the directory a repository-shaped tree; records every call. */
function fakeGit(options: { cloneCode?: number; stderr?: string } = {}) {
  const calls: Array<{ args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
  const git: GitRunner = async (args, { env }) => {
    calls.push({ args, env });
    if (args.includes('clone')) {
      const target = args[args.length - 1]!;
      if ((options.cloneCode ?? 0) !== 0) {
        await mkdir(join(target, 'partial'), { recursive: true });
        return { code: options.cloneCode!, stdout: '', stderr: options.stderr ?? 'fatal: nope', timedOut: false };
      }
      await mkdir(join(target, '.git'), { recursive: true });
      return { code: 0, stdout: '', stderr: '', timedOut: false };
    }
    if (args.includes('symbolic-ref')) return { code: 0, stdout: 'origin/trunk\n', stderr: '', timedOut: false };
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  return { git, calls };
}

let root: string;
let stateDir: string;
let previousRoots: string | undefined;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tm8-clone-root-')));
  stateDir = await mkdtemp(join(tmpdir(), 'tm8-clone-state-'));
  previousRoots = process.env.TM8_PROJECT_ROOTS;
  process.env.TM8_PROJECT_ROOTS = root;
});

afterEach(async () => {
  if (previousRoots === undefined) delete process.env.TM8_PROJECT_ROOTS;
  else process.env.TM8_PROJECT_ROOTS = previousRoots;
  await rm(root, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

function service(db: FakeDb, git: GitRunner, resolveCredential: CloneCredentialResolver): ProjectCloneService {
  const deps: FacadeDeps = { db, config: {} as FacadeDeps['config'], owner: async () => OWNER };
  return new ProjectCloneService(deps, { stateDir, git, resolveCredential, env: { PATH: '/usr/bin', GIT_ASKPASS: '/evil' } });
}

async function startAndSettle(clones: ProjectCloneService, body: Record<string, unknown>, identity = SPACE_ADMIN): Promise<ProjectCloneJob> {
  const queued = await clones.clone(request('spaces.projects.clone', { params: { spaceId: SPACE }, body, identity }));
  await clones.settled.get(queued.id);
  return clones.get(request('spaces.projects.cloneJobs.get', { params: { spaceId: SPACE, jobId: queued.id }, identity }));
}

describe('parseGithubRepo', () => {
  it('normalizes every accepted spelling to the bare https remote', () => {
    for (const raw of [
      'https://github.com/octo/hello', 'https://github.com/octo/hello.git', 'github.com/octo/hello',
      'www.github.com/octo/hello/', 'octo/hello', 'git@github.com:octo/hello.git',
    ]) {
      expect(parseGithubRepo(raw).url, raw).toBe('https://github.com/octo/hello.git');
    }
  });

  it('refuses credentials in the URL, other hosts, other schemes and extra path', () => {
    for (const raw of [
      'https://x-access-token:abc@github.com/octo/hello', 'https://user@github.com/octo/hello',
      'https://gitlab.com/octo/hello', 'http://github.com/octo/hello', 'file:///etc/passwd',
      'https://github.com/octo', 'https://github.com/octo/hello/tree/main', 'https://github.com/octo/hello?x=1',
      '--upload-pack=evil', 'octo/..',
    ]) {
      expect(() => parseGithubRepo(raw), raw).toThrow();
    }
  });

  it('refuses branch names git could read as an option', () => {
    expect(validateBranch('feature/x')).toBe('feature/x');
    for (const bad of ['-x', '--upload-pack=x', 'a..b', 'a b', 'x.lock']) expect(() => validateBranch(bad), bad).toThrow();
  });
});

describe('the clone environment never carries the token anywhere but the header', () => {
  it('sets the header through GIT_CONFIG_*, drops inherited git/askpass env, and redacts both renderings', () => {
    const env = cloneEnv({ PATH: '/bin', GIT_ASKPASS: '/x', GIT_CONFIG_PARAMETERS: "'a=b'", SSH_ASKPASS: '/y' }, TOKEN);
    expect(env.GIT_ASKPASS).toBeUndefined();
    expect(env.SSH_ASKPASS).toBeUndefined();
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.https://github.com/.extraheader');
    const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
    expect(env.GIT_CONFIG_VALUE_0).toBe(`AUTHORIZATION: basic ${basic}`);
    expect(redactSecret(`bad ${TOKEN} and ${basic}`, TOKEN)).toBe('bad [redacted] and [redacted]');
    expect(cloneEnv({ PATH: '/bin' }, null).GIT_CONFIG_COUNT).toBeUndefined();
  });
});

describe('spaces.projects.clone', () => {
  it('clones as a job, records the bare remote and default branch, and registers the folder for the space', async () => {
    const db = new FakeDb();
    const { git, calls } = fakeGit();
    const clones = service(db, git, async () => ({ source: 'member', token: TOKEN }));

    const queued = await clones.clone(request('spaces.projects.clone', {
      params: { spaceId: SPACE }, body: { repoUrl: 'https://github.com/octo/hello', destinationParent: root }, identity: SPACE_ADMIN,
    }));
    expect(['queued', 'cloning']).toContain(queued.status);
    expect(queued.workingDir).toBeUndefined();
    await clones.settled.get(queued.id);
    const job = await clones.get(request('spaces.projects.cloneJobs.get', {
      params: { spaceId: SPACE, jobId: queued.id }, identity: SPACE_ADMIN,
    }));

    expect(ProjectCloneJobSchema.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({
      status: 'succeeded', repoUrl: 'https://github.com/octo/hello.git', directoryName: 'hello',
      credentialSource: 'member', defaultBranch: 'trunk', error: null, project: { id: PROJECT, spaceId: SPACE },
    });
    const register = db.calls.find((c) => c.fn === 'register_space_folder')!;
    expect(register.args).toEqual([SPACE, 'hello', join(root, 'hello'), 'https://github.com/octo/hello.git', 'trunk', 'untrusted', null]);

    // The token is in the clone's env header and nowhere else: not argv, not
    // the follow-up git calls, not the remote, not the job record on disk.
    const clone = calls.find((c) => c.args.includes('clone'))!;
    expect(clone.args.join(' ')).not.toContain(TOKEN);
    expect(clone.args).toContain('credential.helper=');
    expect(clone.env.GIT_CONFIG_VALUE_0).toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
    expect(clone.env.GIT_ASKPASS).toBeUndefined();
    for (const other of calls.filter((c) => !c.args.includes('clone'))) {
      expect(JSON.stringify(other)).not.toContain(Buffer.from(`x-access-token:${TOKEN}`).toString('base64'));
    }
    expect(calls.find((c) => c.args.includes('set-url'))!.args).toContain('https://github.com/octo/hello.git');
    for (const file of await readdir(stateDir)) {
      expect(await readFile(join(stateDir, file), 'utf8')).not.toContain(TOKEN);
    }
  });

  it('fails a refused clone, removes only the directory it made, and redacts the token from the reason', async () => {
    const db = new FakeDb();
    const { git } = fakeGit({ cloneCode: 128, stderr: `fatal: Authentication failed for ${TOKEN}` });
    const clones = service(db, git, async () => ({ source: 'node', token: TOKEN }));
    const job = await startAndSettle(clones, { repoUrl: 'octo/private', destinationParent: root });
    expect(job.status).toBe('failed');
    expect(job.credentialSource).toBe('node');
    expect(job.error!.message).toContain('[redacted]');
    expect(job.error!.message).not.toContain(TOKEN);
    expect(job.error!.message).toContain('The node GitHub credential was refused');
    await expect(stat(join(root, 'private'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(db.calls.map((c) => c.fn)).not.toContain('register_space_folder');
  });

  it('a public clone runs with no credential and says so on failure', async () => {
    const { git, calls } = fakeGit({ cloneCode: 128 });
    const clones = service(new FakeDb(), git, async () => ({ source: 'none' }));
    const job = await startAndSettle(clones, { repoUrl: 'octo/hello', destinationParent: root });
    expect(job.credentialSource).toBe('none');
    expect(job.error!.message).toMatch(/No GitHub credential/);
    expect(calls[0]!.env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('refuses before touching the disk: non-admins, missing roots, outside the roots, an existing target, trust', async () => {
    const { git, calls } = fakeGit();
    const db = new FakeDb();
    const clones = service(db, git, async () => ({ source: 'none' }));
    const start = (body: Record<string, unknown>, identity = SPACE_ADMIN) =>
      clones.clone(request('spaces.projects.clone', { params: { spaceId: SPACE }, body, identity }));

    db.spaceAdmin = false;
    await expect(start({ repoUrl: 'octo/hello', destinationParent: root })).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'space_admin_required' } });
    db.spaceAdmin = true;

    const outside = await mkdtemp(join(tmpdir(), 'tm8-clone-outside-'));
    try {
      await expect(start({ repoUrl: 'octo/hello', destinationParent: outside })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(start({ repoUrl: 'octo/hello', destinationParent: root, directoryName: '../escape' })).rejects.toMatchObject({ code: 'invalid_input' });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    await expect(start({ repoUrl: 'octo/hello', destinationParent: root, trust: 'trusted' }))
      .rejects.toMatchObject({ code: 'forbidden', details: { reason: 'trust_requires_node_admin' } });
    await mkdir(join(root, 'hello'));
    await expect(start({ repoUrl: 'octo/hello', destinationParent: root })).rejects.toMatchObject({ code: 'conflict' });

    delete process.env.TM8_PROJECT_ROOTS;
    await expect(start({ repoUrl: 'octo/hello', destinationParent: root, directoryName: 'other' }))
      .rejects.toMatchObject({ code: 'forbidden', details: { reason: 'project_roots_unset' } });
    expect(calls).toHaveLength(0);
  });

  it("answers another identity's job, or another space's, as not found", async () => {
    const { git } = fakeGit();
    const clones = service(new FakeDb(), git, async () => ({ source: 'none' }));
    const job = await startAndSettle(clones, { repoUrl: 'octo/hello', destinationParent: root });
    await expect(clones.get(request('spaces.projects.cloneJobs.get', {
      params: { spaceId: SPACE, jobId: job.id }, identity: { kind: 'bearer', identityId: 'someone-else', nodeAdmin: false },
    }))).rejects.toMatchObject({ code: 'not_found' });
    await expect(clones.get(request('spaces.projects.cloneJobs.get', {
      params: { spaceId: '00000000-0000-7000-8000-000000000999', jobId: job.id }, identity: SPACE_ADMIN,
    }))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('fails a job left unfinished by a restart as interrupted, and removes its partial checkout', async () => {
    let release!: () => void;
    const hanging: GitRunner = async (args) => {
      if (args.includes('clone')) {
        await mkdir(join(args[args.length - 1]!, 'partial'), { recursive: true });
        await new Promise<void>((r) => { release = r; });
      }
      return { code: 1, stdout: '', stderr: '', timedOut: false };
    };
    const first = service(new FakeDb(), hanging, async () => ({ source: 'none' }));
    const queued = await first.clone(request('spaces.projects.clone', {
      params: { spaceId: SPACE }, body: { repoUrl: 'octo/hello', destinationParent: root }, identity: SPACE_ADMIN,
    }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    // A fresh service over the same state dir is the restarted node.
    const restarted = service(new FakeDb(), fakeGit().git, async () => ({ source: 'none' }));
    const job = await restarted.get(request('spaces.projects.cloneJobs.get', {
      params: { spaceId: SPACE, jobId: queued.id }, identity: SPACE_ADMIN,
    }));
    expect(job).toMatchObject({ status: 'failed', error: { code: 'interrupted' } });
    await expect(stat(join(root, 'hello'))).rejects.toMatchObject({ code: 'ENOENT' });
    release();
    await first.settled.get(queued.id);
  });
});

describe('dbCloneCredentialResolver: the user, then the space, then the node (policy-gated)', () => {
  const ACCOUNT = '00000000-0000-7000-8000-000000000a01';
  const CREDENTIAL = '00000000-0000-7000-8000-000000000a02';
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-clone-keys-'));
  });
  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function db(options: {
    member?: boolean; space?: boolean; spacePolicy?: string[]; nodeAllowed?: boolean | undefined;
  }): Promise<FakeDb> {
    const key = await loadOrCreateCredentialKey(dataDir);
    const member = sealSecret(key, 'member-token', { accountId: ACCOUNT, provider: 'github' });
    const space = sealSecret(key, 'space-token', { spaceId: SPACE, credentialId: CREDENTIAL, provider: 'github' });
    const fake = new FakeDb();
    fake.rpcAnswers = {
      read_space_credential_policy: () => (options.spacePolicy ? { github: options.spacePolicy } : {}),
      read_node_credential_policy: () => (options.nodeAllowed === undefined ? {} : { github: options.nodeAllowed }),
      read_account_git_credential: () => (options.member ? {
        accountId: ACCOUNT, provider: 'github', login: 'me',
        tokenCiphertext: member.ciphertext.toString('base64'), tokenNonce: member.nonce.toString('base64'),
      } : null),
      my_space_credential_default_id: () => null,
      read_space_credential_for_spawn: () => {
        if (!options.space) throw Object.assign(new Error('no default'), { details: { reason: 'no_default' } });
        return {
          credentialId: CREDENTIAL, spaceId: SPACE, provider: 'github', shape: 'token', label: 'ci', displayLogin: null,
          secretCiphertext: space.ciphertext.toString('base64'), secretNonce: space.nonce.toString('base64'),
        };
      },
    };
    return fake;
  }

  const claims = { identityId: 'x' } as DbClaims;
  const env = { TM8_GITHUB_TOKEN: 'node-token' };

  it("prefers the caller's own credential", async () => {
    const resolve = dbCloneCredentialResolver(await db({ member: true, space: true }), dataDir, env);
    expect(await resolve(claims, SPACE)).toEqual({ source: 'member', token: 'member-token' });
  });

  it('falls back to the space default, then the node token', async () => {
    expect(await dbCloneCredentialResolver(await db({ space: true }), dataDir, env)(claims, SPACE))
      .toEqual({ source: 'space', token: 'space-token' });
    expect(await dbCloneCredentialResolver(await db({}), dataDir, env)(claims, SPACE))
      .toEqual({ source: 'node', token: 'node-token' });
  });

  it('never uses the node token when node policy forbids GitHub, or the space allows only its own', async () => {
    expect(await dbCloneCredentialResolver(await db({ nodeAllowed: false }), dataDir, env)(claims, SPACE)).toEqual({ source: 'none' });
    expect(await dbCloneCredentialResolver(await db({ member: true, spacePolicy: ['space'] }), dataDir, env)(claims, SPACE))
      .toEqual({ source: 'none' });
    expect(await dbCloneCredentialResolver(await db({}), dataDir, {})(claims, SPACE)).toEqual({ source: 'none' });
  });
});
