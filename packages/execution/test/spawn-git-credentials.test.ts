// Per-user git credentials at the spawn seam (081).
//
// THE ASSERTION THAT MATTERS IS THE NEGATIVE ONE. That the child's environment
// carries `GH_TOKEN` is easy to get right and easy to see; that the token is in
// NO OTHER PLACE is the part that fails silently. A spawn writes a manifest file
// to disk, records a manifest row with `envVarNames`, and logs a line or two —
// each of those is a way for a credential to end up somewhere it outlives the
// session and outlives every rotation.
//
// So the sweep below is deliberately broad: every file under the node's data
// directory is read after the spawn, and every logger call is captured. A future
// change that starts persisting the resolved environment "for debugging" turns
// this suite red rather than shipping.

import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PtyHostService } from '../src/pty/PtyHostService.js';
import { SpawnService } from '../src/spawn/SpawnService.js';
import type { GitCredential, GitCredentialPort, GraphAuth } from '../src/spawn/types.js';
import { FakeGraph } from './fake-graph.js';

const AUTH = { identityId: 'identity-1', actorId: 'actor-1' };
const REQUEST = {
  clientMutationId: 'mutation-git-1',
  spaceId: '11111111-1111-4111-8111-111111111111',
  teamMemberId: '22222222-2222-4222-8222-222222222222',
  projectId: '33333333-3333-4333-8333-333333333333',
};

/** A value distinctive enough that finding it anywhere is unambiguous. */
const TOKEN = 'ghp_SPAWN_FIXTURE_TOKEN_0123456789abcdef';

function port(credential: GitCredential | null, seen?: GraphAuth[]): GitCredentialPort {
  return {
    async forSpawner(auth: GraphAuth): Promise<GitCredential | null> {
      seen?.push(auth);
      return credential;
    },
  };
}

/** Every regular file under `dir`, recursively, as raw bytes. */
async function readTree(dir: string): Promise<Array<{ path: string; body: string }>> {
  const out: Array<{ path: string; body: string }> = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push({ path: full, body: await readFile(full, 'utf8') });
    }
  };
  await walk(dir);
  return out;
}

describe('SpawnService — the launching human git credential', () => {
  let dataDir: string;
  let projectDir: string;
  let graph: FakeGraph;
  let pty: PtyHostService;
  let logged: unknown[];
  let logger: { info: (m: string, f?: unknown) => void; warn: (m: string, f?: unknown) => void; error: (m: string, f?: unknown) => void };

  const build = (gitCredentials?: GitCredentialPort): SpawnService =>
    new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      bootSettlementMs: 5,
      logger,
      ...(gitCredentials ? { gitCredentials } : {}),
    });

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-gitcred-data-'));
    projectDir = await mkdtemp(join(tmpdir(), 'tm8-gitcred-project-'));
    graph = new FakeGraph({ workingDir: projectDir });
    pty = new PtyHostService();
    logged = [];
    const capture = (message: string, fields?: unknown): void => {
      logged.push(message, fields);
    };
    logger = { info: capture, warn: capture, error: capture };

    vi.spyOn(pty, 'beginPromptHandoff').mockImplementation(() => {});
    vi.spyOn(pty, 'waitForBootSettlement').mockResolvedValue(null);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  it('puts the credential in the child environment and NOWHERE else', async () => {
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    const service = build(port({ provider: 'github', login: 'octocat', token: TOKEN }));

    const result = await service.spawn(AUTH, REQUEST);

    // 1. The child gets it, under the names git and gh actually read.
    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.GH_TOKEN).toBe(TOKEN);
    expect(env.GITHUB_TOKEN).toBe(TOKEN);
    // …and git is pointed at it without a prompt and without a file.
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
    // The helper is a shell snippet that READS the variable; it must not be a
    // place the secret got copied into.
    expect(env.GIT_CONFIG_VALUE_1).not.toContain(TOKEN);
    // The empty first entry resets any machine-wide helper before ours runs.
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    // Commits are attributed to the human this session is acting for.
    expect(env.GIT_AUTHOR_NAME).toBe('octocat');
    expect(env.GIT_COMMITTER_EMAIL).toBe('octocat@users.noreply.github.com');

    // 2. The manifest ROW records names, never values.
    expect(graph.manifests).toHaveLength(1);
    const recorded = graph.manifests[0]!;
    expect(recorded.envVarNames).toContain('GH_TOKEN');
    expect(JSON.stringify(recorded.manifest)).not.toContain(TOKEN);
    expect(JSON.stringify(recorded.envVarNames)).not.toContain(TOKEN);
    expect(recorded.prompts.system).not.toContain(TOKEN);
    expect(recorded.prompts.task).not.toContain(TOKEN);
    // The names are what 006's guard admits: uppercase env identifiers.
    for (const name of recorded.envVarNames) expect(name).toMatch(/^[A-Z][A-Z0-9_]{0,80}$/);

    // 3. The manifest FILE on disk — the one artefact that outlives the process
    // — does not contain it, and is 0600 either way.
    const manifestOnDisk = await readFile(result.manifestPath, 'utf8');
    expect(manifestOnDisk).not.toContain(TOKEN);
    expect((await stat(result.manifestPath)).mode & 0o777).toBe(0o600);

    // The JOURNAL is the other durable artefact. It is written by the agent's
    // own `tm8` invocations, so nothing exists yet at spawn — what is checkable
    // here is that its path is inside the directory the sweep below covers, so
    // a journal that later grew a token would be caught by this same assertion
    // rather than by nobody.
    expect(env.TM8_JOURNAL_PATH.startsWith(dataDir)).toBe(true);

    // Nothing under the node data directory — manifest, journal, or anything a
    // future change decides to write there — contains it.
    const files = await readTree(dataDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(file.body, `${file.path} contains the token`).not.toContain(TOKEN);
    }

    // 4. Nor does anything this spawn logged.
    expect(JSON.stringify(logged)).not.toContain(TOKEN);

    // 5. Nor the result the caller is handed back.
    expect(JSON.stringify(result.manifest)).not.toContain(TOKEN);
    expect(result.command).not.toContain(TOKEN);
    expect(JSON.stringify(result.envVarNames)).not.toContain(TOKEN);
  });

  it('leaves the environment with no GitHub identity when the account has none', async () => {
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    const service = build(port(null));

    await service.spawn(AUTH, REQUEST);

    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    // Not an empty string, not a placeholder — ABSENT. `gh` treats an empty
    // GH_TOKEN as a configured-but-broken credential and fails differently
    // from one that was never set.
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
    expect(env).not.toHaveProperty('GIT_CONFIG_COUNT');
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME');
  });

  it('never inherits the server own GH_TOKEN', async () => {
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    // The operator has a token in the server's environment. It is THEIRS, not
    // this session's, and inheriting it would be the shared-login failure this
    // whole feature exists to end.
    const service = new SpawnService({
      graph,
      pty,
      baseUrl: 'http://127.0.0.1:4610',
      dataDir,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GH_TOKEN: 'ghp_OPERATOR_MACHINE_TOKEN' },
      bootSettlementMs: 5,
      logger,
      gitCredentials: port(null),
    });

    await service.spawn(AUTH, REQUEST);

    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env).not.toHaveProperty('GH_TOKEN');
  });

  it('asks with the SPAWNER claims, so a session gets the launching human credential', async () => {
    vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    const seen: GraphAuth[] = [];
    const service = build(port({ provider: 'github', login: 'octocat', token: TOKEN }, seen));

    await service.spawn(AUTH, REQUEST);

    expect(seen).toEqual([AUTH]);
  });

  it('launches without a credential when the lookup fails, and says so', async () => {
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    const service = build({
      async forSpawner(): Promise<GitCredential | null> {
        throw new Error('credential key file is unreadable');
      },
    });

    // A launch must not die because of a credential nobody has asked it to use.
    const result = await service.spawn(AUTH, REQUEST);
    expect(result.sessionId).toBeTruthy();

    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env).not.toHaveProperty('GH_TOKEN');
    expect(JSON.stringify(logged)).toContain('git credential lookup failed');
  });

  it('omits author identity, but still injects the token, for a login-less row', async () => {
    const spawnIfAbsent = vi.spyOn(pty, 'spawnIfAbsent').mockReturnValue({ reused: false });
    const service = build(port({ provider: 'github', login: null, token: TOKEN }));

    await service.spawn(AUTH, REQUEST);

    const env = spawnIfAbsent.mock.calls[0]![0].env as Record<string, string>;
    expect(env.GH_TOKEN).toBe(TOKEN);
    // Falls back to `x-access-token` inside the helper rather than inventing a
    // name and attributing commits to a person who does not exist.
    expect(env).not.toHaveProperty('GIT_AUTHOR_NAME');
    expect(env.GIT_CONFIG_VALUE_1).toContain('x-access-token');
  });
});
