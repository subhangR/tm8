// THE SHARED GITHUB BOT POSTURE — one node credential, no personal login
// reachable behind it.
//
// Two halves, and the second is the one that matters.
//
//  1. `readGitHubBotCredential` against REAL FILES in a real temp dir, with
//     real modes. Mocking `fs` here would delete the only interesting
//     assertions: that a `0644` drop refuses and that nothing about the file's
//     contents reaches an error message.
//
//  2. The REAL `resolveLaunchConfig` → `resolveSessionCredentials` path, with
//     a member GitHub credential genuinely present and a fake port that
//     genuinely holds a space default — so "the bot wins" is measured against
//     rungs that would otherwise answer, not against absence. The negative
//     controls (posture off) run the same fixtures, which is what makes them
//     controls.
//
// THE LOAD-BEARING TEST IS `an unusable bot file refuses the launch`. Every
// other property here is about choosing correctly; that one is about failing
// correctly, and it is the single assertion that would catch the regression
// this whole posture exists to prevent — a typo in the operator's path turning
// silently back into "run as whichever human connected a login".

import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GITHUB_BOT_CREDENTIAL_FILE_ENV,
  gitHubBotPostureActive,
  readGitHubBotCredential,
} from '../src/spawn/github-bot-credential.js';
import {
  resolveSessionCredentials,
  type CredentialResolutionDeps,
} from '../src/spawn/credential-resolution.js';
import { composeEnv, composeManifest, resolveLaunchConfig, type ResolvedLaunchConfig } from '../src/spawn/manifest.js';
import {
  SpawnError,
  type GitHubCredential,
  type SpaceCredentialGrant,
  type SpaceCredentialPolicies,
  type SpaceCredentialPort,
  type SpaceCredentialProvider,
  type SpaceCredentialRead,
  type SpawnContext,
  type SpawnRequest,
} from '../src/spawn/types.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const GH_DEFAULT = 'cccccccc-0000-4000-8000-000000000001';
const AUTH_A = { accountId: 'account-A', kind: 'human' };

/** A token-shaped string that must never appear in an error message. */
const BOT_TOKEN = 'ghp_BOT_SECRET_do_not_log_0123456789';
const MEMBER_TOKEN = 'gho_MEMBER_SECRET_0123456789';

const MEMBER_GH: GitHubCredential = { provider: 'github', login: 'member-a', token: MEMBER_TOKEN };

// ---------------------------------------------------------------------------
// Real files, real modes.
// ---------------------------------------------------------------------------

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tm8-gh-bot-'));
  dirs.push(dir);
  return dir;
}

/** Write a credential file with an explicit mode; `0o600` is the good case. */
async function botFile(body: string, mode = 0o600): Promise<string> {
  const path = join(await tempDir(), 'github-bot.json');
  await writeFile(path, body, { mode });
  // `writeFile`'s mode is masked by the umask, so set it explicitly: the
  // whole point of the 0644 case is that the mode is what we say it is.
  await chmod(path, mode);
  return path;
}

function env(path: string | undefined): NodeJS.ProcessEnv {
  return path === undefined ? {} : { [GITHUB_BOT_CREDENTIAL_FILE_ENV]: path };
}

afterEach(() => {
  dirs.length = 0;
});

describe('readGitHubBotCredential — the file', () => {
  it('is off when the variable is unset or blank, and that is the ONLY null', async () => {
    expect(gitHubBotPostureActive({})).toBe(false);
    expect(gitHubBotPostureActive({ [GITHUB_BOT_CREDENTIAL_FILE_ENV]: '   ' })).toBe(false);
    await expect(readGitHubBotCredential({})).resolves.toBeNull();
    await expect(readGitHubBotCredential({ [GITHUB_BOT_CREDENTIAL_FILE_ENV]: '' })).resolves.toBeNull();
  });

  it('reads login and token from a 0600 file, trimming both', async () => {
    const path = await botFile(JSON.stringify({ login: ' tm8-bot\n', token: ` ${BOT_TOKEN} ` }));
    expect(gitHubBotPostureActive(env(path))).toBe(true);
    await expect(readGitHubBotCredential(env(path))).resolves.toEqual({
      provider: 'github',
      login: 'tm8-bot',
      token: BOT_TOKEN,
    });
  });

  it('refuses a file readable beyond its owner, and names the mode', async () => {
    const path = await botFile(JSON.stringify({ login: 'tm8-bot', token: BOT_TOKEN }), 0o644);
    const error = await readGitHubBotCredential(env(path)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect((error as SpawnError).message).toContain('mode 644');
    expect((error as SpawnError).message).toContain('chmod 600');
  });

  it('refuses a missing path, a directory, and an oversized file', async () => {
    const missing = join(await tempDir(), 'nope.json');
    await expect(readGitHubBotCredential(env(missing))).rejects.toThrow(/could not be read/);

    const asDir = join(await tempDir(), 'adir');
    await mkdir(asDir);
    await expect(readGitHubBotCredential(env(asDir))).rejects.toThrow(/not a regular file/);

    const huge = await botFile('x'.repeat(9_000));
    await expect(readGitHubBotCredential(env(huge))).rejects.toThrow(/far larger than a credential file/);
  });

  it('refuses malformed JSON, a non-object, and an empty login or token', async () => {
    await expect(readGitHubBotCredential(env(await botFile('{not json'))))
      .rejects.toThrow(/is not valid JSON/);
    await expect(readGitHubBotCredential(env(await botFile('["a"]'))))
      .rejects.toThrow(/is not a JSON object/);
    await expect(readGitHubBotCredential(env(await botFile(JSON.stringify({ token: BOT_TOKEN })))))
      .rejects.toThrow(/has no "login"/);
    await expect(readGitHubBotCredential(env(await botFile(JSON.stringify({ login: 'tm8-bot', token: '  ' })))))
      .rejects.toThrow(/has no "token"/);
  });

  it('never puts the token, or any of the file, in the refusal', async () => {
    // The realistic leak: a JSON parse error quotes the input it choked on,
    // and the input is a secret. So the bad file here IS a secret with a
    // syntax error, which is what an operator's half-saved file looks like.
    const path = await botFile(`{"login":"tm8-bot","token":"${BOT_TOKEN}"`);
    const error = (await readGitHubBotCredential(env(path)).catch((e: unknown) => e)) as SpawnError;
    const everything = `${error.message} ${JSON.stringify(error.detail ?? {})}`;
    expect(everything).not.toContain(BOT_TOKEN);
    expect(everything).not.toContain('ghp_');
    // It still says which file, or the operator cannot act on it.
    expect(error.message).toContain(path);
  });
});

// ---------------------------------------------------------------------------
// The resolution gate, driven through the real launch path.
// ---------------------------------------------------------------------------

function context(agentTool: string | null = null): SpawnContext {
  return {
    spaceId: SPACE,
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    teamMember: {
      id: 'teammate-1', name: 'TB', role: 'fixture', identity: 'fixture', memories: [],
      model: 'opus', agentTool, mode: 'worker', permissionMode: null, avatar: null,
      capabilities: {}, commandPermissions: {},
    },
    tasks: [],
  };
}

function ghGrant(credentialId: string): SpaceCredentialGrant {
  return {
    kind: 'secret', credentialId, provider: 'github', shape: 'token',
    label: 'space gh', displayLogin: 'space-bot', secret: 'gho_SPACE_SECRET',
  };
}

/** A space that really does hold a default GitHub credential. */
function fakePort(policies?: SpaceCredentialPolicies): SpaceCredentialPort {
  return {
    async readPolicies() { return policies ?? { space: {}, node: {} }; },
    async read(_auth, _spaceId, provider, credentialId): Promise<SpaceCredentialRead> {
      if (provider !== 'github') return { ok: false, reason: 'no_default' };
      const id = credentialId ?? GH_DEFAULT;
      return id === GH_DEFAULT ? { ok: true, grant: ghGrant(id) } : { ok: false, reason: 'not_found' };
    },
    async activeIds(_auth, ids) { return new Set(ids); },
    async repointSession() { return { ok: true, credentials: [] }; },
  };
}

/**
 * Deps with a member GitHub credential PRESENT and a counter on it. "The bot
 * wins" is only worth asserting against a member rung that would answer.
 */
function deps(options: {
  botPath?: string;
  policies?: SpaceCredentialPolicies;
  withPort?: boolean;
} = {}): CredentialResolutionDeps & { memberGitHubAsks: number } {
  const state = { memberGitHubAsks: 0 };
  return {
    get memberGitHubAsks() { return state.memberGitHubAsks; },
    ...(options.withPort === false ? {} : { spaceCredentials: fakePort(options.policies) }),
    async resolveMemberHome() { return null; },
    async resolveMemberGitHub() {
      state.memberGitHubAsks += 1;
      return MEMBER_GH;
    },
    readGitHubBot: () => readGitHubBotCredential(env(options.botPath)),
    async materializeApiKeyHome({ provider, credentialId, apiKey }) {
      return {
        provider, homeDir: '/d/s1', configDir: `/d/s1/${provider}`,
        space: { credentialId, apiKey },
      };
    },
  } as CredentialResolutionDeps & { memberGitHubAsks: number };
}

function launch(request: Partial<SpawnRequest> = {}): ResolvedLaunchConfig {
  return resolveLaunchConfig(
    { spaceId: SPACE, teamMemberId: 'teammate-1', ...request },
    context(),
    {},
    null,
  );
}

async function resolve(l: ResolvedLaunchConfig, d: CredentialResolutionDeps, resume = false) {
  return resolveSessionCredentials({ auth: AUTH_A, spaceId: SPACE, launch: l, resume }, d);
}

async function goodBotFile(): Promise<string> {
  return botFile(JSON.stringify({ login: 'tm8-bot', token: BOT_TOKEN }));
}

describe('the bot posture in resolveSessionCredentials', () => {
  it('OFF: the member credential still wins, and the space default is still there', async () => {
    // The control. Same fixtures as every test below; only the posture differs.
    const d = deps();
    const r = await resolve(launch(), d);
    expect(r.gitHubCredential).toEqual(MEMBER_GH);
    expect(r.launch.effectiveCredentialSources?.github).toBe('member');
    expect(d.memberGitHubAsks).toBeGreaterThan(0);
  });

  it('ON: auto runs on the bot, and the member rung is never even asked', async () => {
    const d = deps({ botPath: await goodBotFile() });
    const r = await resolve(launch(), d);
    expect(r.gitHubCredential).toEqual({ provider: 'github', login: 'tm8-bot', token: BOT_TOKEN });
    // Not merely "not chosen": not READ. No personal token is decrypted on
    // this node, which is a stronger and much easier property to keep true.
    expect(d.memberGitHubAsks).toBe(0);
    expect(r.launch.effectiveCredentialSources?.github).toBe('node');
    expect(r.launch.credentialSources.github).toBe('node');
    // The space default was not picked up either, so no space credential id
    // is recorded against this session.
    expect(r.spaceCredentialIds).not.toContain(GH_DEFAULT);
  });

  it('ON: an explicit member or space request REFUSES, naming the posture', async () => {
    const botPath = await goodBotFile();
    for (const source of ['member', 'space'] as const) {
      const d = deps({ botPath });
      const error = (await resolve(launch({ credentialSources: { github: source } }), d)
        .catch((e: unknown) => e)) as SpawnError;
      expect(error).toBeInstanceOf(SpawnError);
      expect(error.detail?.['reason']).toBe('bot_posture');
      expect(error.message).toContain('shared bot credential');
      expect(d.memberGitHubAsks).toBe(0);
    }
  });

  it("ON: an explicit 'node' is honoured — the bot IS this node's credential", async () => {
    const d = deps({ botPath: await goodBotFile() });
    const r = await resolve(launch({ credentialSources: { github: 'node' } }), d);
    expect(r.gitHubCredential?.login).toBe('tm8-bot');
  });

  it('ON: a RESUME carrying a recorded `member` moves onto the bot instead of refusing', async () => {
    // A session spawned before the posture was turned on recorded `member`.
    // Refusing here would make it unresumable, with no fix its caller could
    // apply; moving it onto the bot can only narrow what it reaches.
    const d = deps({ botPath: await goodBotFile() });
    const r = await resolve(launch({ credentialSources: { github: 'member' } }), d, true);
    expect(r.gitHubCredential?.login).toBe('tm8-bot');
    expect(d.memberGitHubAsks).toBe(0);
  });

  it('ON: a space policy that excludes `node` does not switch git off for everyone', async () => {
    // Documented judgement, pinned here so a reviewer who disagrees sees a
    // failing test rather than a comment: in this posture the policy rows are
    // not consulted, because there is no second source for them to choose.
    const d = deps({
      botPath: await goodBotFile(),
      policies: { space: { github: ['member'] }, node: { github: false } },
    });
    const r = await resolve(launch(), d);
    expect(r.gitHubCredential?.login).toBe('tm8-bot');
    expect(d.memberGitHubAsks).toBe(0);
  });

  it('ON but UNUSABLE: the launch refuses — it does NOT fall back to the member', async () => {
    // The regression this posture exists to prevent. An operator typo in the
    // path must not quietly restore "run as whichever human has a login".
    const d = deps({ botPath: join(await tempDir(), 'typo.json') });
    const error = (await resolve(launch(), d).catch((e: unknown) => e)) as SpawnError;
    expect(error).toBeInstanceOf(SpawnError);
    expect(error.detail?.['reason']).toBe('bot_credential_unusable');
    expect(d.memberGitHubAsks).toBe(0);
  });

  it('ON with no space credential store at all: still the bot, never the machine gh', async () => {
    const d = deps({ botPath: await goodBotFile(), withPort: false });
    const r = await resolve(launch(), d);
    expect(r.gitHubCredential?.login).toBe('tm8-bot');
  });
});

// ---------------------------------------------------------------------------
// What the agent's process actually gets.
// ---------------------------------------------------------------------------

describe('the composed agent environment on the bot credential', () => {
  /**
   * A server env polluted exactly as this node's was: a machine-wide token and
   * a global `gh` credential helper. Recording `node` as the effective source
   * means `composeEnv` is NOT asked for strict member isolation, so this
   * asserts the containment that remains — and it has to, because "the bot
   * token wins over the machine's" is the claim the runbook makes.
   */
  const POLLUTED: NodeJS.ProcessEnv = {
    HOME: '/home/tm8',
    PATH: '/usr/bin:/bin',
    GH_TOKEN: 'ghp_MACHINE_WIDE',
    GITHUB_TOKEN: 'ghp_MACHINE_WIDE',
  };

  const manifest = composeManifest({
    sessionId: 'sess-1',
    request: { spaceId: SPACE, teamMemberId: 'teammate-1' },
    context: context('claude-code'),
    launch: {
      mode: 'worker', model: 'opus', agentTool: 'claude-code',
      permissionMode: 'acceptEdits', accessMode: 'acceptEdits', reasoningEffort: null,
    },
    workdir: { mode: 'scratch', path: '/tmp/tm8-fixture' },
    command: 'claude',
    baseUrl: 'http://127.0.0.1:4610',
  });

  it('injects the bot token, attributes commits to the bot, and resets the machine helper', () => {
    const bot: GitHubCredential = { provider: 'github', login: 'tm8-bot', token: BOT_TOKEN };
    const env = composeEnv(
      manifest, '/tmp/m.json', 'http://x', POLLUTED,
      undefined, undefined, undefined, bot, 'node',
    );

    expect(env.GH_TOKEN).toBe(BOT_TOKEN);
    expect(env.GITHUB_TOKEN).toBe(BOT_TOKEN);
    // The machine-wide value is REPLACED, not merely accompanied.
    expect(env.GH_TOKEN).not.toContain('MACHINE_WIDE');
    // The global `!gh auth git-credential` helper in /home/tm8/.gitconfig is
    // overridden by a process-local one, so git cannot reach the node's own
    // `gh` login even though this session's source records as `node`.
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toContain('TM8_GIT_LOGIN');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    // Attribution: a push from any session on this node reads as the bot.
    expect(env.TM8_GIT_LOGIN).toBe('tm8-bot');
    expect(env.GIT_AUTHOR_NAME).toBe('tm8-bot');
    expect(env.GIT_AUTHOR_EMAIL).toBe('tm8-bot@users.noreply.github.com');
    expect(env.GIT_COMMITTER_EMAIL).toBe('tm8-bot@users.noreply.github.com');
  });
});
