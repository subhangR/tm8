import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import {
  CollabError,
  isCollabError,
  type ProjectCloneCredentialSource,
  type ProjectCloneInput,
  type ProjectCloneJob,
  type ProjectCloneJobStatus,
} from '@tm8/contract';

import { DbGitHubCredentialStore } from '../../../credentials/github-credential-store.js';
import { DbSpaceCredentialStore } from '../../../credentials/space-credential-store.js';
import type { Db, DbClaims } from '../../../db/types.js';
import type { RequestContext } from '../../../http/types.js';
import { scanSpaceSkills } from '../../../skills/service.js';
import { resolveGithubToken } from '../../../tracking/github.js';
import { claimsFor, commandEnvelope, requireUuidParam } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { canonicalDirectory, requireAllowed } from './project-directories.js';
import { isSecretBasename } from './project-file-policy.js';
import {
  isGateAdmin,
  registerSpaceFolderRow,
  toSpaceProject,
  type SpaceProjectRow,
} from './projects-associations.js';
import { requireTrustAllowed, spaceProjectRoots } from './space-project-roots.js';

/** A clone that has not finished in this long is killed and fails. */
const DEFAULT_CLONE_TIMEOUT_MS = 30 * 60 * 1_000;
/** Clones run at most this many at once per node; the rest wait their turn as `queued`. */
const DEFAULT_MAX_CONCURRENT = 2;
/** How much of git's stderr a failure keeps (the tail — where git says why). */
const STDERR_TAIL_BYTES = 4_000;

const TERMINAL: ReadonlySet<ProjectCloneJobStatus> = new Set(['succeeded', 'failed']);

// ---------------------------------------------------------------------------
// Input: the repository, the branch, the directory name
// ---------------------------------------------------------------------------

export interface GithubRepoRef {
  owner: string;
  repo: string;
  /** `https://github.com/<owner>/<repo>.git` — what git fetches and what the project records. */
  url: string;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * A GitHub repository reference, normalized to its https remote, or a refusal.
 *
 * Deliberately narrow, because the result is both FETCHED and RECORDED:
 * GitHub only (the credential chain is GitHub's), https only (an `ssh` remote
 * would need a key this node does not manage — `git@github.com:o/r` is read as
 * the same repository over https), and NEVER with userinfo — a URL that carries
 * `user:token@` would put a credential into `.git/config` and into the project
 * row, which is the one thing this flow promises not to do.
 */
export function parseGithubRepo(raw: string): GithubRepoRef {
  const value = raw.trim();
  let owner: string | undefined;
  let repo: string | undefined;
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(value);
  // `owner/repo`. An owner never contains a dot, so `github.com/o` is a URL.
  const shorthand = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/.exec(value);
  if (ssh) {
    [, owner, repo] = ssh;
  } else if (shorthand) {
    [, owner, repo] = shorthand;
  } else {
    let url: URL;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw new CollabError('invalid_input', 'repoUrl is not a GitHub repository URL');
    }
    if (url.username || url.password) {
      throw new CollabError('invalid_input', 'repoUrl must not carry credentials; the node supplies them');
    }
    if (url.protocol !== 'https:') {
      throw new CollabError('invalid_input', 'repoUrl must be an https GitHub URL');
    }
    if (!/^(?:www\.)?github\.com$/i.test(url.hostname) || url.port || url.search || url.hash) {
      throw new CollabError('invalid_input', 'repoUrl must be a github.com repository URL');
    }
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) {
      throw new CollabError('invalid_input', 'repoUrl must name one repository: https://github.com/<owner>/<repo>');
    }
    owner = segments[0];
    repo = segments[1]!.replace(/\.git$/i, '');
  }
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || repo === '.' || repo === '..') {
    throw new CollabError('invalid_input', 'repoUrl must name a GitHub owner and repository');
  }
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

/** A branch name git will accept and that cannot be read as an option. */
export function validateBranch(branch: string): string {
  const value = branch.trim();
  if (
    !/^[A-Za-z0-9._/-]{1,255}$/.test(value)
    || value.startsWith('-') || value.startsWith('/') || value.endsWith('/')
    || value.endsWith('.lock') || value.includes('..') || value.includes('//') || value === '@'
  ) {
    throw new CollabError('invalid_input', `not a valid branch name: ${branch}`);
  }
  return value;
}

/** The clone target is ONE new directory name: no separators, no dot-dirs, no secrets. */
export function validateDirectoryName(name: string): string {
  const value = name.trim();
  if (
    value.length === 0 || value === '.' || value === '..' || value.startsWith('-')
    || /[\\/\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new CollabError('invalid_input', 'directoryName must be one directory name');
  }
  if (value === '.git' || isSecretBasename(value)) {
    throw new CollabError('invalid_input', 'directoryName names a protected file');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Credentials: the caller's, then the space's, then the node's
// ---------------------------------------------------------------------------

export type CloneCredential =
  | { source: Exclude<ProjectCloneCredentialSource, 'none'>; token: string }
  | { source: 'none' };

export type CloneCredentialResolver = (claims: DbClaims, spaceId: string) => Promise<CloneCredential>;

/**
 * The GitHub token a clone into `spaceId` runs on, in the owner's order:
 *
 *   1. the CALLER's own — their account GitHub login (093), else the space
 *      GitHub credential they picked as their default;
 *   2. the SPACE's default GitHub credential;
 *   3. the NODE's token (`TM8_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`), only
 *      while `node_credential_policies` does not forbid GitHub (absent means
 *      allowed — the spawn resolver's reading, `credential-resolution.ts`).
 *
 * The space's own policy (206, D5) is honoured on every step exactly as a
 * launch honours it: a space that allows only `space` never clones on a
 * member's token or the node's.
 *
 * A credential that is absent, pending, revoked or unreadable is skipped, not
 * fatal — the next source is tried and, failing all, the clone runs without
 * one (a public repository needs none). Nothing here logs or returns a secret.
 */
export function dbCloneCredentialResolver(db: Db, dataDir: string, env: NodeJS.ProcessEnv = process.env): CloneCredentialResolver {
  const spaceStore = new DbSpaceCredentialStore({ db, dataDir });
  const accountStore = new DbGitHubCredentialStore({ db, dataDir });
  return async (claims, spaceId) => {
    const [spacePolicy, nodePolicy] = await Promise.all([
      spaceStore.readSpacePolicy(claims, spaceId),
      spaceStore.readNodePolicy(claims),
    ]);
    const list = spacePolicy.github;
    const allows = (source: 'member' | 'space' | 'node') => list === undefined || list.includes(source);

    if (allows('member')) {
      const own = await accountStore.resolve(claims).catch(() => null);
      if (own?.token) return { source: 'member', token: own.token };
      const mine = await spaceStore.myDefaultId(claims, spaceId, 'github').catch(() => null);
      if (mine) {
        const picked = await spaceStore.readForSpawn(claims, spaceId, 'github', mine).catch(() => null);
        if (picked?.kind === 'secret') return { source: 'member', token: picked.secret };
      }
    }
    if (allows('space')) {
      const shared = await spaceStore.readForSpawn(claims, spaceId, 'github', null).catch(() => null);
      if (shared?.kind === 'secret') return { source: 'space', token: shared.secret };
    }
    if (allows('node') && nodePolicy.github !== false) {
      const token = resolveGithubToken(env);
      if (token) return { source: 'node', token };
    }
    return { source: 'none' };
  };
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

export interface GitRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type GitRunner = (
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<GitRunResult>;

export const runGit: GitRunner = (args, options) => new Promise((resolvePromise) => {
  const child = spawn('git', [...args], { env: options.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
  }, options.timeoutMs);
  child.stdout.on('data', (chunk: Buffer) => {
    stdout = (stdout + chunk.toString('utf8')).slice(-64_000);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES * 4);
  });
  child.on('error', (error) => {
    clearTimeout(timer);
    resolvePromise({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut });
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    resolvePromise({ code, stdout, stderr, timedOut });
  });
});

/**
 * The environment a clone runs in. The token rides an `http.<github>.extraheader`
 * set through `GIT_CONFIG_COUNT` — the environment, never argv (which every
 * user on the box can read in `ps`), never the remote URL, and never a config
 * FILE: git does not write command-line or environment config into the
 * clone's `.git/config`, so the checkout records only the bare https remote.
 * No credential helper and no terminal prompt, so a refused token fails the
 * job instead of hanging it on a prompt nobody can answer.
 */
export function cloneEnv(base: NodeJS.ProcessEnv, token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    // The server's own git environment (askpass, config overrides, a
    // credential an operator exported) never reaches a clone it runs for a user.
    if (key.startsWith('GIT_') || key === 'SSH_ASKPASS') continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  return env;
}

/** Every rendering of `token` a git message could carry, replaced. */
export function redactSecret(text: string, token: string | null): string {
  if (!token) return text;
  const forms = [token, Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')];
  let out = text;
  for (const form of forms) out = out.split(form).join('[redacted]');
  return out;
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_BYTES ? `…${trimmed.slice(-STDERR_TAIL_BYTES)}` : trimmed;
}

// ---------------------------------------------------------------------------
// The job service
// ---------------------------------------------------------------------------

/** What is persisted: no claims, no token. */
interface StoredCloneJob extends Omit<ProjectCloneJob, 'workingDir' | 'project'> {
  identityId: string;
  workingDir: string;
  projectId: string | null;
  name: string;
  branch: string | null;
  trust: 'trusted' | 'untrusted';
}

export interface ProjectCloneServiceOptions {
  /** Where job records live; absent ⇒ `<dataDir>/project-clone-jobs`. */
  readonly stateDir?: string;
  readonly dataDir?: string;
  readonly resolveCredential?: CloneCredentialResolver;
  readonly git?: GitRunner;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly now?: () => Date;
  readonly logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

/**
 * `spaces.projects.clone` / `spaces.projects.cloneJobs.get` (task 01a13574).
 *
 * `clone` validates everything it can WITHOUT the network — the caller is an
 * admin of the space, the URL is a GitHub repository, the target is one new
 * directory inside the caller's allowed roots — creates that directory, and
 * answers 202 with a `queued` job. The clone itself runs after the response,
 * so a large repository never meets an HTTP deadline; the client reads the
 * job until it is `succeeded` (with the space's project) or `failed`.
 *
 * A job is a JSON record under `stateDir`, like a folder upload's session. A
 * node that restarts mid-clone loses the git process, so a record found
 * unfinished with no live job behind it is failed as `interrupted`, and the
 * partial checkout it created is removed.
 *
 * A failed clone removes the directory it created. Only that directory: the
 * service creates it with an exclusive mkdir, so it never deletes a folder it
 * did not make.
 */
export class ProjectCloneService {
  private readonly live = new Map<string, StoredCloneJob>();
  private readonly queue: Array<{ job: StoredCloneJob; claims: DbClaims; done: () => void }> = [];
  private running = 0;
  private readonly git: GitRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly maxConcurrent: number;
  private readonly now: () => Date;
  private readonly resolveCredential: CloneCredentialResolver | null;
  private readonly stateDir: string | null;
  /** Settles when a started job has finished; tests await it. */
  readonly settled = new Map<string, Promise<void>>();

  constructor(private readonly deps: FacadeDeps, private readonly options: ProjectCloneServiceOptions = {}) {
    const dataDir = options.dataDir ?? deps.config.dataDir;
    this.stateDir = options.stateDir ?? (dataDir ? join(dataDir, 'project-clone-jobs') : null);
    this.resolveCredential = options.resolveCredential
      ?? (dataDir ? dbCloneCredentialResolver(deps.db, dataDir, options.env ?? process.env) : null);
    this.git = options.git ?? runGit;
    this.env = options.env ?? process.env;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    this.now = options.now ?? (() => new Date());
  }

  readonly clone = async (ctx: RequestContext): Promise<ProjectCloneJob> => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const input = ctx.body as ProjectCloneInput;
    const owner = await this.deps.owner();
    const claims = claimsFor(owner, ctx, commandEnvelope(ctx));
    const identityId = claims.identityId;
    if (!identityId) throw new CollabError('unauthenticated', 'authentication is required');
    if (!this.stateDir || !this.resolveCredential) {
      throw new CollabError('upstream_unavailable', 'this node has no data directory, so it cannot clone a repository');
    }

    // Pure validation first: nothing below touches the filesystem until every
    // name in the request has been cleared.
    const repo = parseGithubRepo(input.repoUrl);
    const directoryName = validateDirectoryName(input.directoryName ?? repo.repo);
    const branch = input.branch === undefined ? null : validateBranch(input.branch);
    const name = (input.name ?? repo.repo).trim();
    if (!isAbsolute(input.destinationParent)) {
      throw new CollabError('invalid_input', 'destinationParent must be absolute');
    }

    // Authorization and the roots window, before any stat (space-project-roots).
    const roots = await spaceProjectRoots(this.deps.db, claims, spaceId);
    requireTrustAllowed(claims, input.trust);
    requireAllowed(resolve(input.destinationParent, directoryName), roots);
    const parent = await canonicalDirectory(input.destinationParent);
    requireAllowed(parent, roots);
    const workingDir = join(parent, directoryName);
    requireAllowed(workingDir, roots);
    try {
      await mkdir(workingDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new CollabError('conflict', `${directoryName} already exists in that folder; choose another name`);
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new CollabError('forbidden', 'the node cannot create a directory in that folder');
      }
      throw new CollabError('upstream_unavailable', 'could not create the clone directory');
    }

    const at = this.now().toISOString();
    const job: StoredCloneJob = {
      id: randomUUID(),
      spaceId,
      identityId,
      repoUrl: repo.url,
      directoryName,
      workingDir,
      name,
      branch,
      trust: input.trust ?? 'untrusted',
      status: 'queued',
      credentialSource: null,
      defaultBranch: null,
      projectId: null,
      error: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    try {
      await this.save(job);
    } catch (error) {
      await rm(workingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    this.live.set(job.id, job);
    let done!: () => void;
    this.settled.set(job.id, new Promise<void>((settle) => { done = settle; }));
    this.queue.push({ job, claims, done });
    this.pump();
    return this.view(job, claims);
  };

  readonly get = async (ctx: RequestContext): Promise<ProjectCloneJob> => {
    const spaceId = requireUuidParam(ctx, 'spaceId');
    const jobId = requireUuidParam(ctx, 'jobId');
    const owner = await this.deps.owner();
    const claims = claimsFor(owner, ctx);
    const job = this.live.get(jobId) ?? await this.load(jobId);
    // Another identity's job, or another space's, answers exactly like none.
    if (!job || job.identityId !== claims.identityId || job.spaceId !== spaceId) {
      throw new CollabError('not_found', `no such clone job: ${jobId}`);
    }
    if (!TERMINAL.has(job.status) && !this.live.has(job.id)) {
      // The process that ran it is gone (a restart). A half-written checkout
      // is the service's own directory: remove it unless registration had
      // already begun, when the clone itself is complete.
      if (job.status !== 'registering') {
        await rm(job.workingDir, { recursive: true, force: true }).catch(() => undefined);
      }
      this.finish(job, 'failed', {
        code: 'interrupted',
        message: 'the node restarted while this clone was running; start the clone again',
      });
      await this.save(job).catch(() => undefined);
    }
    return this.view(job, claims);
  };

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running += 1;
      void this.run(next.job, next.claims).finally(() => {
        this.running -= 1;
        this.live.delete(next.job.id);
        this.settled.delete(next.job.id);
        next.done();
        this.pump();
      });
    }
  }

  private async run(job: StoredCloneJob, claims: DbClaims): Promise<void> {
    let token: string | null = null;
    try {
      const credential = await this.resolveCredential!(claims, job.spaceId);
      token = credential.source === 'none' ? null : credential.token;
      job.credentialSource = credential.source;
      await this.transition(job, 'cloning');

      const env = cloneEnv(this.env, token);
      const cloned = await this.git([
        '-c', 'credential.helper=',
        'clone', '--origin', 'origin',
        ...(job.branch ? ['--branch', job.branch] : []),
        '--', job.repoUrl, job.workingDir,
      ], { env, timeoutMs: this.timeoutMs });
      if (cloned.timedOut) {
        throw new CollabError('upstream_unavailable', `the clone did not finish within ${Math.round(this.timeoutMs / 60_000)} minutes`);
      }
      if (cloned.code !== 0) {
        const reason = redactSecret(tail(cloned.stderr), token);
        const refused = /could not read Username|Authentication failed|returned error: 40[13]|Repository not found/i.test(cloned.stderr);
        const hint = token === null
          ? ' No GitHub credential was available: for a private repository, sign in to GitHub in your settings or add a space GitHub credential.'
          : refused
            ? ` The ${job.credentialSource} GitHub credential was refused, or it cannot read this repository.`
            : '';
        throw new CollabError('upstream_unavailable', `git clone failed: ${reason || `exit ${cloned.code}`}${hint}`);
      }

      const plain = cloneEnv(this.env, null);
      const head = await this.git(
        ['-C', job.workingDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        { env: plain, timeoutMs: 30_000 },
      );
      const remoteHead = head.code === 0 ? head.stdout.trim().replace(/^origin\//, '') : '';
      if (remoteHead) {
        job.defaultBranch = remoteHead;
      } else {
        const local = await this.git(['-C', job.workingDir, 'rev-parse', '--abbrev-ref', 'HEAD'], { env: plain, timeoutMs: 30_000 });
        job.defaultBranch = local.code === 0 && local.stdout.trim() !== 'HEAD' ? local.stdout.trim() : null;
      }
      // The recorded remote is the bare https URL; assert it rather than
      // trust it, since the project row repeats it to every member.
      await this.git(['-C', job.workingDir, 'remote', 'set-url', 'origin', job.repoUrl], { env: plain, timeoutMs: 30_000 });

      await this.transition(job, 'registering');
      const canonical = await canonicalDirectory(job.workingDir);
      const raw = await registerSpaceFolderRow(this.deps.db, claims, job.spaceId, {
        name: job.name,
        workingDir: canonical,
        trust: job.trust,
        clientMutationId: null,
        repoUrl: job.repoUrl,
        defaultBranch: job.defaultBranch,
      });
      job.projectId = raw.projectId;
      await scanSpaceSkills(this.deps.db, claims, raw.spaceId, { root: raw.folderId }).catch(() => undefined);
      this.finish(job, 'succeeded', null);
    } catch (error) {
      const failure = isCollabError(error)
        ? { code: error.code, message: redactSecret(error.message, token) }
        : { code: 'internal', message: redactSecret(error instanceof Error ? error.message : String(error), token) };
      if (job.projectId === null) {
        await rm(job.workingDir, { recursive: true, force: true }).catch(() => undefined);
      }
      this.finish(job, 'failed', failure);
      this.options.logger?.warn?.('project clone failed', { jobId: job.id, spaceId: job.spaceId, code: failure.code });
    } finally {
      token = null;
      await this.save(job).catch(() => undefined);
    }
  }

  private async transition(job: StoredCloneJob, status: ProjectCloneJobStatus): Promise<void> {
    job.status = status;
    job.updatedAt = this.now().toISOString();
    await this.save(job);
  }

  private finish(job: StoredCloneJob, status: 'succeeded' | 'failed', error: ProjectCloneJob['error']): void {
    const at = this.now().toISOString();
    job.status = status;
    job.error = error;
    job.updatedAt = at;
    job.finishedAt = at;
  }

  private async view(job: StoredCloneJob, claims: DbClaims): Promise<ProjectCloneJob> {
    let project: ProjectCloneJob['project'] = null;
    if (job.projectId) {
      const rows = await this.deps.db.query<SpaceProjectRow>(
        claims,
        'select * from public.space_projects_for_caller($1::uuid) where project_id = $2',
        [job.spaceId, job.projectId],
      );
      project = rows[0] ? toSpaceProject(job.spaceId, rows[0]) : null;
    }
    return {
      id: job.id,
      spaceId: job.spaceId,
      repoUrl: job.repoUrl,
      directoryName: job.directoryName,
      ...(isGateAdmin(claims) ? { workingDir: job.workingDir } : {}),
      status: job.status,
      credentialSource: job.credentialSource,
      defaultBranch: job.defaultBranch,
      project,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt,
    };
  }

  private statePath(jobId: string): string {
    return join(this.stateDir!, `${jobId}.json`);
  }

  private async save(job: StoredCloneJob): Promise<void> {
    if (!this.stateDir) return;
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    await writeFile(this.statePath(job.id), JSON.stringify(job), { mode: 0o600 });
  }

  private async load(jobId: string): Promise<StoredCloneJob | null> {
    if (!this.stateDir) return null;
    try {
      return JSON.parse(await readFile(this.statePath(jobId), 'utf8')) as StoredCloneJob;
    } catch {
      return null;
    }
  }
}
