import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCredentialHome, SpaceCredentialGrant, SpaceCredentialPort } from '@tm8/execution';
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
  policies?: { space: { anthropic?: ('member' | 'space' | 'node')[] }; node: { anthropic?: boolean } };
  refuse?: 'revoked' | 'unreadable';
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-credentials-'));
  dirs.push(dataDir);
  const memberResolve = vi.fn(async () => options.member ?? null);
  const read = vi.fn(async () => options.refuse
    ? { ok: false as const, reason: options.refuse }
    : options.grant ? { ok: true as const, grant: options.grant }
      : { ok: false as const, reason: 'no_default' as const });
  const space: SpaceCredentialPort = {
    readPolicies: async () => options.policies ?? { space: {}, node: {} },
    myDefaultId: async () => options.mine ?? null,
    read, activeIds: async (_auth, ids) => new Set(ids),
    repointSession: async () => ({ ok: true, credentials: [] }),
  };
  const resolve = createChatCredentialEnvResolver({
    db: {} as Db, dataDir, memberCredentials: { resolve: memberResolve }, spaceCredentials: space,
    parentEnv: { ANTHROPIC_API_KEY: 'node-key', TM8_DATABASE_URL: 'must-not-leak' },
  });
  return { resolve, memberResolve, read, dataDir };
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
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the actual RLS credential index under the turn author rather than the teammate owner', async () => {
    const query = vi.fn(async () => [{ provider: 'anthropic' }]);
    const dataDir = '/data';
    const resolve = createChatCredentialEnvResolver({
      db: { query } as unknown as Db, dataDir,
      spaceCredentials: { readPolicies: async () => ({ space: {}, node: {} }), myDefaultId: async () => null } as unknown as SpaceCredentialPort,
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
    expect(rigged.read).not.toHaveBeenCalled();
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
    expect(await (await rig({ member: home, grant: login })).resolve(selected)).toEqual({ ANTHROPIC_API_KEY: 'node-key' });
    await expect((await rig({ policies: { space: {}, node: { anthropic: false } } })).resolve(selected)).rejects.toThrow();
    await expect((await rig({ policies: { space: { anthropic: ['member'] }, node: {} } })).resolve(selected)).rejects.toThrow();
  });

  it('uses the space default when no member credential exists, without looking up GitHub', async () => {
    const { resolve, read } = await rig({ grant: login });
    expect((await resolve(input)).CLAUDE_CONFIG_DIR).toBe(join(login.homeDir, 'anthropic'));
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(expect.anything(), input.spaceId, 'anthropic', null);
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
    expect(await (await rig()).resolve(input)).toEqual({ ANTHROPIC_API_KEY: 'node-key' });
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

  it('routes Kimi through the member key and refuses missing or unreadable keys', async () => {
    const kimi = { ...input, model: 'kimi-k2-thinking', provider: 'moonshot' };
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
