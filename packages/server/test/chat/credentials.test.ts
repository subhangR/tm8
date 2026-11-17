import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentCredentialHome, GitHubCredential, SpaceCredentialGrant, SpaceCredentialPort,
} from '@tm8/execution';
import { createChatCredentialEnvResolver } from '../../src/chat/credentials.js';
import type { ChatLaunchConfigInput } from '../../src/chat/runtime.js';
import type { Db } from '../../src/db/types.js';

const CHAT = '019f0000-0000-7000-8000-000000000401';
const CRED = '019f0000-0000-7000-8000-000000000405';
const input: ChatLaunchConfigInput = {
  chatId: CHAT, requesterIdentityId: 'human-a', requesterAuthKind: 'browser',
  teammateId: 'teammate-b', spaceId: 'space-a', model: 'claude-opus-5',
  provider: 'anthropic', agentTool: 'claude-code', chatMode: 'ask', cwd: '/tmp/chat', mode: 'new',
};
const home: AgentCredentialHome = {
  provider: 'anthropic', homeDir: '/data/credentials/human-a', configDir: '/data/credentials/human-a/anthropic',
};
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function rig(options: {
  member?: AgentCredentialHome | null;
  mine?: string | null;
  grant?: SpaceCredentialGrant;
  policies?: {
    space: { anthropic?: ('member' | 'space' | 'node')[]; github?: ('member' | 'space' | 'node')[] };
    node: { anthropic?: boolean; github?: boolean };
  };
  refuse?: 'revoked' | 'unreadable';
  /** The member's connected GitHub row, as `DbGitHubCredentialStore` would return it. */
  gitHub?: GitHubCredential | null;
  /** This Space's default GitHub token. */
  gitHubGrant?: SpaceCredentialGrant;
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-credentials-'));
  dirs.push(dataDir);
  const memberResolve = vi.fn(async () => options.member ?? null);
  // Dispatch on PROVIDER. Chat never resolved GitHub before, so one
  // provider-blind mock was enough; now a github read that answered with the
  // anthropic grant would be a fiction the real port cannot produce.
  const read = vi.fn(async (_auth: unknown, _spaceId: string, provider: string) => {
    if (provider === 'github') {
      return options.gitHubGrant
        ? { ok: true as const, grant: options.gitHubGrant }
        : { ok: false as const, reason: 'no_default' as const };
    }
    return options.refuse
      ? { ok: false as const, reason: options.refuse }
      : options.grant ? { ok: true as const, grant: options.grant }
        : { ok: false as const, reason: 'no_default' as const };
  });
  const space = {
    readPolicies: async () => options.policies ?? { space: {}, node: {} },
    myDefaultId: async (_auth: unknown, _spaceId: string, provider: string) =>
      (provider === 'github' ? null : options.mine ?? null),
    read, activeIds: async (_auth: unknown, ids: string[]) => new Set(ids),
    repointSession: async () => ({ ok: true, credentials: [] }),
  } as unknown as SpaceCredentialPort;
  const gitHubResolve = vi.fn(async () => options.gitHub ?? null);
  const resolve = createChatCredentialEnvResolver({
    db: {} as Db, dataDir, memberCredentials: { resolve: memberResolve }, spaceCredentials: space,
    gitHubCredentials: { resolve: gitHubResolve },
    parentEnv: { ANTHROPIC_API_KEY: 'node-key', TM8_DATABASE_URL: 'must-not-leak' },
  });
  return { resolve, memberResolve, read, gitHubResolve, dataDir };
}

const GH: GitHubCredential = { provider: 'github', login: 'octocat', token: 'gho_member_token' };

/** Chat gets no GitHub credential, and says so the way a member posture does. */
function expectNoGitHubCredential(env: Record<string, string>) {
  expect(env.GH_TOKEN).toBe('');
  expect(env.GITHUB_TOKEN).toBe('');
  expect(env.GIT_TERMINAL_PROMPT).toBe('0');
  expect(env.GIT_CONFIG_VALUE_0).toBe('');
  expect(env.TM8_GIT_LOGIN).toBeUndefined();
}

const login: SpaceCredentialGrant = {
  kind: 'login', provider: 'anthropic', credentialId: CRED, label: 'shared',
  displayLogin: null, homeDir: '/data/credentials/spaces/space-a/login',
};

describe('chat model credentials', () => {
  it('uses the authorizing human lookup and the session member home, suppressing the node key', async () => {
    const { resolve, memberResolve, read } = await rig({ member: home });
    const env = await resolve(input);
    expect(memberResolve).toHaveBeenCalledWith({ identityId: 'human-a', authKind: 'browser' },
      { agentTool: 'claude-code', model: 'claude-opus-5' });
    expect(env.CLAUDE_CONFIG_DIR).toBe(home.configDir);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBeUndefined();
    expect(env.TM8_DATABASE_URL).toBeUndefined();
    // Scoped to anthropic: `read` now also serves the GitHub rung.
    expect(read).not.toHaveBeenCalledWith(expect.anything(), input.spaceId, 'anthropic', expect.anything());
  });

  it('reads the actual RLS credential index under the turn author rather than the teammate owner', async () => {
    const query = vi.fn(async () => [{ provider: 'anthropic' }]);
    const dataDir = '/data';
    const resolve = createChatCredentialEnvResolver({
      db: { query } as unknown as Db, dataDir,
      spaceCredentials: {
        readPolicies: async () => ({ space: {}, node: {} }),
        myDefaultId: async () => null,
        // The GitHub rung reaches the space read too.
        read: async () => ({ ok: false as const, reason: 'no_default' as const }),
      } as unknown as SpaceCredentialPort,
      gitHubCredentials: { resolve: async () => null },
      parentEnv: {},
    });
    expect((await resolve({ ...input, requesterIdentityId: 'human-b' })).CLAUDE_CONFIG_DIR)
      .toBe('/data/credentials/human-b/anthropic');
    expect(query.mock.calls[0]?.[0]).toEqual({ identityId: 'human-b', authKind: 'browser' });
  });

  it('prefers my default over the legacy member login, including after interrupt', async () => {
    const { resolve, memberResolve, read } = await rig({ member: home, mine: CRED, grant: login });
    expect((await resolve({ ...input, mode: 'resume-after-interrupt' })).CLAUDE_CONFIG_DIR)
      .toBe(join(login.homeDir, 'anthropic'));
    expect(memberResolve).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledWith(expect.anything(), input.spaceId, 'anthropic', CRED);
  });

  it('honors an explicit member choice over my default and refuses a missing login', async () => {
    const selected = { ...input, credentialSelection: { source: 'member' as const } };
    const rigged = await rig({ member: home, mine: CRED, grant: login });
    expect((await rigged.resolve(selected)).CLAUDE_CONFIG_DIR).toBe(home.configDir);
    expect(rigged.read).not.toHaveBeenCalledWith(expect.anything(), input.spaceId, 'anthropic', expect.anything());
    await expect((await rig({ grant: login })).resolve(selected)).rejects.toThrow();
  });

  it('honors a specific space credential and refuses revocation without falling back', async () => {
    const selected = { ...input, credentialSelection: { source: 'space' as const, credentialId: CRED } };
    const rigged = await rig({ member: home, grant: login });
    expect((await rigged.resolve(selected)).CLAUDE_CONFIG_DIR).toBe(join(login.homeDir, 'anthropic'));
    expect(rigged.read).toHaveBeenCalledWith(expect.anything(), input.spaceId, 'anthropic', CRED);
    expect(rigged.memberResolve).not.toHaveBeenCalled();
    await expect((await rig({ member: home, refuse: 'revoked' })).resolve(selected)).rejects.toThrow();
  });

  it('honors explicit node selection and still enforces node and space policy', async () => {
    const selected = { ...input, credentialSelection: { source: 'node' as const } };
    expect(await (await rig({ member: home, grant: login })).resolve(selected))
      .toMatchObject({ ANTHROPIC_API_KEY: 'node-key' });
    await expect((await rig({ policies: { space: {}, node: { anthropic: false } } })).resolve(selected)).rejects.toThrow();
    await expect((await rig({ policies: { space: { anthropic: ['member'] }, node: {} } })).resolve(selected)).rejects.toThrow();
  });

  it('uses the space default when no member credential exists, and looks GitHub up separately', async () => {
    const { resolve, read } = await rig({ grant: login });
    expect((await resolve(input)).CLAUDE_CONFIG_DIR).toBe(join(login.homeDir, 'anthropic'));
    expect(read).toHaveBeenCalledWith(expect.anything(), input.spaceId, 'anthropic', null);
    // Was `toHaveBeenCalledTimes(1)` while chat resolved no GitHub at all.
    expect(read).toHaveBeenCalledWith(expect.anything(), input.spaceId, 'github', null);
  });

  it('validates a selected space API key without rewriting the running chat home', async () => {
    const { resolve, dataDir } = await rig({ grant: {
      kind: 'secret', provider: 'anthropic', credentialId: CRED, shape: 'api_key',
      label: 'api', displayLogin: null, secret: 'space-api-key',
    } });
    const env = await resolve({ ...input, credentialValidationOnly: true });
    expect(env.ANTHROPIC_API_KEY).toBe('space-api-key');
    await expect(stat(join(dataDir, 'credentials', 'sessions', CHAT))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('materializes a space API key in the chat home and injects the selected key', async () => {
    const { resolve, dataDir } = await rig({ grant: {
      kind: 'secret', provider: 'anthropic', credentialId: CRED, shape: 'api_key',
      label: 'api', displayLogin: null, secret: 'space-api-key',
    } });
    const env = await resolve(input);
    expect(env.CLAUDE_CONFIG_DIR).toBe(join(dataDir, 'credentials', 'sessions', CHAT, 'anthropic'));
    expect(env.ANTHROPIC_API_KEY).toBe('space-api-key');
    const config = JSON.parse(await readFile(join(env.CLAUDE_CONFIG_DIR!, '.claude.json'), 'utf8'));
    expect(config.hasCompletedOnboarding).toBe(true);
  });

  it('falls back to the node key only when policy allows it', async () => {
    expect(await (await rig()).resolve(input)).toMatchObject({ ANTHROPIC_API_KEY: 'node-key' });
    const denied = await rig({ policies: { space: { anthropic: ['member', 'space'] }, node: {} } });
    await expect(denied.resolve(input)).rejects.toThrow(/no anthropic credential/);
    const nodeDenied = await rig({ policies: { space: {}, node: { anthropic: false } } });
    await expect(nodeDenied.resolve(input)).rejects.toThrow();
  });

  it('obeys space policy instead of using a connected member login', async () => {
    const { resolve, memberResolve } = await rig({ member: home, grant: login,
      policies: { space: { anthropic: ['space'] }, node: {} } });
    expect((await resolve(input)).CLAUDE_CONFIG_DIR).toBe(join(login.homeDir, 'anthropic'));
    expect(memberResolve).not.toHaveBeenCalled();
  });

  it.each(['revoked', 'unreadable'] as const)('refuses a %s personal default instead of spending a different account', async refuse => {
    const { resolve, memberResolve } = await rig({ mine: CRED, member: home, refuse });
    await expect(resolve(input)).rejects.toThrow();
    expect(memberResolve).not.toHaveBeenCalled();
  });

  // ---- GitHub ------------------------------------------------------------
  // The gap these cover: a chat answered `gh auth status` with "not logged
  // into any GitHub hosts" and could not push, while a worker session for the
  // same member in the same Space could, because only the session lane
  // (`composeEnv`) shaped GitHub into its environment.

  it("injects the member's connected GitHub credential, as a session does", async () => {
    const { resolve, gitHubResolve } = await rig({ member: home, gitHub: GH });
    const env = await resolve(input);
    expect(env.GH_TOKEN).toBe(GH.token);
    expect(env.GITHUB_TOKEN).toBe(GH.token);
    expect(env.TM8_GIT_LOGIN).toBe('octocat');
    // The HTTPS helper carries no secret: git expands $GH_TOKEN in the child.
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_1).toContain('$GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_1).not.toContain(GH.token);
    // Commits are authored by the token's own account, never the box.
    expect(env.GIT_AUTHOR_NAME).toBe('octocat');
    expect(env.GIT_AUTHOR_EMAIL).toBe('octocat@users.noreply.github.com');
    expect(env.GIT_COMMITTER_EMAIL).toBe('octocat@users.noreply.github.com');
    // Read under the TURN AUTHOR's claims, not the teammate owner's.
    expect(gitHubResolve).toHaveBeenCalledWith({ identityId: 'human-a', authKind: 'browser' });
  });

  it("takes the Space default only when the member has connected none, as a session does", async () => {
    // Session precedence (doc 13 §3e), unchanged here: my default, then the
    // member's own login, then the Space default. The member rung wins over
    // the Space DEFAULT — only a personal default outranks it.
    const spaceToken: SpaceCredentialGrant = {
      kind: 'secret', provider: 'github', credentialId: CRED, shape: 'token',
      label: 'space gh', displayLogin: 'space-bot', secret: 'gho_space_token',
    };
    const withMember = await rig({ member: home, gitHubGrant: spaceToken, gitHub: GH });
    expect((await withMember.resolve(input)).GH_TOKEN).toBe(GH.token);

    const withoutMember = await rig({ member: home, gitHubGrant: spaceToken, gitHub: null });
    const env = await withoutMember.resolve(input);
    expect(env.GH_TOKEN).toBe('gho_space_token');
    expect(env.TM8_GIT_LOGIN).toBe('space-bot');
    expect(withoutMember.gitHubResolve).toHaveBeenCalled();
  });

  it('blanks the box\'s own gh when the member has connected none', async () => {
    const env = await (await rig({ member: home })).resolve(input);
    expectNoGitHubCredential(env);
  });

  it('obeys space policy for GitHub instead of using a connected member login', async () => {
    const { resolve, gitHubResolve } = await rig({
      member: home, gitHub: GH, policies: { space: { github: ['space'] }, node: {} },
    });
    expectNoGitHubCredential(await resolve(input));
    expect(gitHubResolve).not.toHaveBeenCalled();
  });

  it('answers the turn without git rather than failing it when every GitHub rung is closed', async () => {
    // A session refuses to start here. A chat is a conversation: a human who
    // asked a question must not get an error because the Space has no token.
    const { resolve } = await resolveWithGitHubClosed();
    expectNoGitHubCredential(await resolve(input));
  });

  it('answers a link-bound turn without git rather than failing it', async () => {
    const { resolve } = await rig({ member: home });
    expectNoGitHubCredential(await resolve({ ...input, requesterAuthKind: 'link' }));
  });

  it('gives a link-bound chat the Space default when there is one', async () => {
    const { resolve } = await rig({
      member: home,
      gitHubGrant: {
        kind: 'secret', provider: 'github', credentialId: CRED, shape: 'token',
        label: 'space gh', displayLogin: 'space-bot', secret: 'gho_space_token',
      },
    });
    const env = await resolve({ ...input, requesterAuthKind: 'link' });
    expect(env.GH_TOKEN).toBe('gho_space_token');
  });

  async function resolveWithGitHubClosed() {
    return rig({ member: home, policies: { space: { github: [] }, node: { github: false } } });
  }

  it('routes Kimi through the member key and refuses missing or unreadable keys', async () => {
    const kimi = { ...input, model: 'kimi-k3', provider: 'moonshot' };
    const { resolve } = await rig({ member: { ...home, provider: 'kimi', configDir: '/data/kimi', apiKey: 'kimi-key' } });
    const env = await resolve(kimi);
    expect(env.CLAUDE_CONFIG_DIR).toBe('/data/kimi');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('kimi-key');
    expect(env.ANTHROPIC_BASE_URL).toContain('moonshot');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    await expect((await rig()).resolve(kimi)).rejects.toThrow(/no .* key is connected/);
    await expect((await rig({ member: { ...home, provider: 'kimi' } })).resolve(kimi)).rejects.toThrow(/could not be read/);
  });
});
