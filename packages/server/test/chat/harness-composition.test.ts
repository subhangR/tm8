import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HarnessRegistry, type GenerationFence, type HarnessAdapter, type HarnessCapabilities,
  type SpaceCredentialPort,
} from '@tm8/execution';
import { createChatPreparedLaunchResolver, type ChatPreparedLaunchInput } from '../../src/chat/harness-composition.js';
import type { Db } from '../../src/db/types.js';
import type { ResolvedAuthSession } from '../../src/identity/pg-auth.js';
import { composeChatBootstrap, composeChatHarnessFoundation } from '../../src/chat/compose.js';

const CHAT = '019f0000-0000-7000-8000-000000000401';
const SPACE = '019f0000-0000-7000-8000-000000000402';
const CONNECTOR = '019f0000-0000-7000-8000-000000000403';
const CREDENTIAL = '019f0000-0000-7000-8000-000000000404';
const KEY = 'sentinel-selected-model-secret';
const SECRET_ERROR = 'sentinel-private-provider-diagnostic';
const input: ChatPreparedLaunchInput = {
  chatId: CHAT, requesterIdentityId: 'human-a', requesterAuthKind: 'browser', requesterAuthSessionId: 'human-session',
  teammateId: 'teammate-a', spaceId: SPACE, model: 'gpt-6.1-sol', provider: 'openai',
  agentTool: 'codex', chatMode: 'ask', cwd: '/tmp/chat', mode: 'new',
};
const owner = { chatId: CHAT, generation: 1, ownerLeaseId: 'lease-a', claimFence: 'claim-secret' };
const fence: GenerationFence = { chatId: CHAT, bindingId: 'binding-a', generation: 1, leaseEpoch: 2, configRevision: 3 };
const caps: HarnessCapabilities = {
  schemaVersion: 1, harness: 'codex', binaryVersion: 'test', protocolRevision: 'test',
  nativeResume: 'supported', portableBootstrap: 'supported', cancelActiveTurn: 'supported', nativeTurnIds: 'supported',
  usage: 'supported', contextReading: 'supported', interactiveRequests: 'unsupported', textInputs: 'supported',
  imageInputs: 'unknown', fileInputs: 'unsupported', builtInToolRestriction: 'unknown',
  configuration: { model: 'per_turn', reasoningEffort: 'per_turn', serviceTier: 'per_turn', instructions: 'restart', tools: 'restart', credential: 'restart' },
};
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function rig() {
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-compose-'));
  dirs.push(dataDir);
  const sessions = new Map<string, ResolvedAuthSession>();
  const state = { revoked: false, denied: false, connectorCredential: CREDENTIAL, failRevoke: false };
  const rpc = vi.fn(async (_claims, name: string, args: unknown[]) => {
    if (name === 'issue_agent_runtime_session') {
      for (const id of sessions.keys()) sessions.delete(id);
      const issuedFence = JSON.parse(args[5] as string) as GenerationFence;
      const id = randomUUID();
      const session = {
        sessionId: id, identityId: _claims.identityId, kind: 'agent_runtime', runtimeChatId: CHAT,
        spaceId: SPACE, runtimeEpoch: issuedFence.leaseEpoch, runtimeNativeGeneration: issuedFence.generation,
      } as ResolvedAuthSession;
      sessions.set(id, session);
      return { id, runtime_member_id: 'runtime-member', runtime_chat_id: CHAT, expires_at: new Date(Date.now() + 60000).toISOString() };
    }
    if (name === 'resolve_auth_session') return state.revoked ? null : [...sessions.values()].at(-1) ?? null;
    if (name === 'revoke_agent_runtime_session') {
      if (state.failRevoke) throw new Error(SECRET_ERROR);
      const session = sessions.get(args[3] as string);
      if (session?.runtimeEpoch === args[1] && session.runtimeNativeGeneration === args[2]) sessions.delete(session.sessionId);
      return null;
    }
    throw new Error(`Unexpected RPC ${name}`);
  });
  const db = { rpc } as unknown as Db;
  const bind = vi.fn(async () => [{ serverId: CONNECTOR, credentialId: CREDENTIAL }]);
  const authorize = vi.fn(async () => ({
    sessionId: CHAT, spaceId: SPACE, identityId: input.requesterIdentityId, serverId: CONNECTOR,
    credentialId: state.connectorCredential, launcherIdentityId: input.requesterIdentityId, launcherAuthKind: 'browser',
  }));
  const adapters: HarnessAdapter[] = ['claude', 'codex'].map(kind => ({
    kind: kind as 'claude' | 'codex', capabilities: async () => ({ ...caps, harness: kind as 'claude' | 'codex' }),
    open: async () => { throw new Error('not opened in composition'); },
  }));
  const registry = new HarnessRegistry(adapters);
  const space = {
    readPolicies: async () => state.denied ? { space: { openai: [] }, node: {} } : { space: {}, node: {} },
    myDefaultId: async () => null,
    read: async () => ({ ok: false, reason: 'no_default' }),
  } as unknown as SpaceCredentialPort;
  const options = { db, dataDir, registry, baseUrl: 'http://127.0.0.1:7778', mcpCliPath: '/server/mcp.js',
    mcpBindings: { bind, authorize }, memberCredentials: { resolve: async () => null }, spaceCredentials: space,
    parentEnv: { OPENAI_API_KEY: KEY, ANTHROPIC_API_KEY: 'sentinel-wrong-vendor', DATABASE_URL: SECRET_ERROR },
  };
  return { options, dataDir, rpc, bind, authorize, sessions, state, resolve: createChatPreparedLaunchResolver(options) };
}

describe('private generation launch composition', () => {
  it('prepares Codex from exact bridge descriptors, with isolated auth and no ambient secrets', async () => {
    const { resolve, rpc, bind } = await rig();
    const prepared = await resolve(input, owner, fence);
    expect(prepared.launchFingerprint).toBeNull();
    expect(prepared.credentialRevision).toBeNull();
    expect(JSON.stringify(prepared)).not.toContain(KEY);
    expect(JSON.stringify(prepared)).not.toContain('tm8s_');
    const material = await prepared.launch.materialize();
    expect(material.harness).toBe('codex');
    expect(material.env.OPENAI_API_KEY).toBe(KEY);
    expect(material.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(material.env.DATABASE_URL).toBeUndefined();
    expect(material.env.TM8_AGENT_RUNTIME_TOKEN).toBeUndefined();
    expect(material.mcpServers).toHaveLength(2);
    const connector = material.mcpServers[1]!;
    expect(connector.args).toEqual(['/server/mcp.js', '--connector', CONNECTOR]);
    expect(connector.env.TM8_AGENT_RUNTIME_TOKEN).toBe(material.mcpServers[0]!.env.TM8_AGENT_RUNTIME_TOKEN);
    expect(connector.env).not.toHaveProperty('OPENAI_API_KEY');
    expect(material.providerConfig).toMatchObject({ mcp_servers: { [connector.name]: {
      command: process.execPath, args: connector.args, env: connector.env, cwd: input.cwd,
    } } });
    expect(material.mcpServers[0]!.env.TM8_CHAT_HIDDEN_TOOLS).toBe('');
    expect((await stat(material.mcpConfigPath)).mode & 0o777).toBe(0o600);
    expect((await stat(material.modelConfigDir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(material.mcpConfigPath, 'utf8')).mcpServers[connector.name].env)
      .toEqual(connector.env);
    expect(bind).toHaveBeenCalledOnce();
    const issue = rpc.mock.calls.find(call => call[1] === 'issue_agent_runtime_session')!;
    expect(issue[0]).toMatchObject({ authSessionId: 'human-session', authKind: 'browser' });
    expect(JSON.parse(issue[2][5] as string)).toEqual(fence);
    await prepared.launch.release();
    expect(rpc.mock.calls.find(call => call[1] === 'revoke_agent_runtime_session')![2])
      .toEqual([CHAT, fence.leaseEpoch, fence.generation, prepared.launch.runtimeGrantId]);
    await expect(stat(material.modelConfigDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(material.mcpConfigPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves Claude native policy and hides only replaced tm8 tools', async () => {
    const { resolve } = await rig();
    const prepared = await resolve({ ...input, agentTool: 'claude-code', model: 'claude-opus-5', provider: 'anthropic' }, owner, fence);
    const material = await prepared.launch.materialize();
    expect(material.nativeTools).toContain('Bash');
    expect(material.allowedTools).toContain('mcp__tm8__tm8_delegate');
    expect(material.allowedTools).not.toContain('mcp__tm8__repo_read_file');
    expect(material.mcpServers[0]!.env.TM8_CHAT_HIDDEN_TOOLS).toContain('repo_read_file');
    await prepared.launch.release();
  });

  it('routes Groq and Kimi through only the selected backend account', async () => {
    const { options, dataDir, rpc } = await rig();
    const groq = createChatPreparedLaunchResolver({ ...options, memberCredentials: { resolve: async () => ({
      provider: 'groq', homeDir: dataDir, configDir: join(dataDir, 'groq'), apiKey: KEY,
    }) } });
    const prepared = await groq({ ...input, model: 'openai/gpt-oss-120b', provider: 'groq' }, owner, fence);
    const material = await prepared.launch.materialize();
    expect(material.env.OPENAI_BASE_URL).toBe('https://api.groq.com/openai/v1');
    expect(material.env.OPENAI_API_KEY).toBe(KEY);
    expect(material.providerConfig).toMatchObject({ model_providers: { groq: {
      name: 'Groq', base_url: material.env.OPENAI_BASE_URL, env_key: 'OPENAI_API_KEY',
      wire_api: 'responses', requires_openai_auth: false, supports_websockets: false,
    } } });
    expect(JSON.stringify(material.providerConfig)).not.toContain(KEY);
    expect(prepared.target.provider).toBe('groq');
    await prepared.launch.release();
    const kimi = createChatPreparedLaunchResolver({ ...options, memberCredentials: { resolve: async () => ({
      provider: 'kimi', homeDir: dataDir, configDir: join(dataDir, 'kimi'), apiKey: KEY,
    }) } });
    const next = await kimi({ ...input, model: 'kimi-k2-thinking', agentTool: 'claude-code', provider: 'moonshot' }, owner, fence);
    const kimiMaterial = await next.launch.materialize();
    expect(kimiMaterial.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    expect(kimiMaterial.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(kimiMaterial.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(kimiMaterial.env.OPENAI_API_KEY).toBeUndefined();
    await next.launch.release();
    rpc.mockClear();
    await expect(groq({ ...input, model: 'openai/gpt-oss-120b', credentialSelection: { source: 'node' } }, owner, fence)).rejects.toThrow();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('rejects unknown required capabilities before directories, binding or minting', async () => {
    const { options, dataDir, rpc, bind } = await rig();
    const resolve = createChatPreparedLaunchResolver({ ...options, requiredCapabilities: ['imageInputs'] });
    await expect(resolve(input, owner, fence)).rejects.toThrow('imageInputs');
    expect(await readdir(dataDir)).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('registers both production adapters and refuses unavailable Codex restrictions before mint', async () => {
    const { options, rpc, dataDir } = await rig();
    const foundation = composeChatHarnessFoundation({ ...options, registry: undefined, nodeId: 'node-a', requiredCapabilities: ['builtInToolRestriction'] });
    expect(foundation.harnessRegistry.get('claude').kind).toBe('claude');
    expect(foundation.harnessRegistry.get('codex').kind).toBe('codex');
    await expect(foundation.resolvePreparedLaunch(input, owner, fence)).rejects.toThrow('builtInToolRestriction');
    expect(rpc).not.toHaveBeenCalled();
    expect(await readdir(dataDir)).toEqual([]);
    expect(() => composeChatHarnessFoundation({ ...options, nodeId: ' ' })).toThrow('node identity');
  });

  it('uses the human poster for model selection and grant authority without creator inheritance', async () => {
    const { options, rpc, bind, authorize, dataDir } = await rig();
    const homes = { creator: join(dataDir, 'creator'), poster: join(dataDir, 'poster') };
    for (const who of ['creator', 'poster'] as const) {
      await mkdir(homes[who]);
      await writeFile(join(homes[who], 'auth.json'), JSON.stringify({ tokens: { access_token: `secret-${who}` } }));
    }
    const member = vi.fn(async (claims: { identityId?: string }) => ({ provider: 'openai' as const,
      homeDir: dataDir, configDir: claims.identityId === 'poster' ? homes.poster : homes.creator,
    }));
    const resolve = createChatPreparedLaunchResolver({ ...options, memberCredentials: { resolve: member } });
    const posted = { ...input, requesterIdentityId: 'poster', requesterAuthSessionId: 'poster-session', credentialSelection: { source: 'member' as const } };
    const prepared = await resolve(posted, owner, fence);
    const material = await prepared.launch.materialize();
    expect(await readFile(join(material.modelConfigDir, 'auth.json'), 'utf8')).toContain('secret-poster');
    expect(await readFile(join(material.modelConfigDir, 'auth.json'), 'utf8')).not.toContain('secret-creator');
    expect(material.env.OPENAI_API_KEY).toBeUndefined();
    expect(member.mock.calls.every(call => call[0].identityId === 'poster')).toBe(true);
    expect(rpc.mock.calls.find(call => call[1] === 'issue_agent_runtime_session')![0])
      .toEqual({ identityId: 'poster', authKind: 'browser', authSessionId: 'poster-session' });
    expect(bind.mock.calls[0]![0]).toMatchObject({ identityId: 'poster', authSessionId: 'poster-session' });
    expect(authorize.mock.calls.at(-1)![0]).toMatchObject({ identityId: 'poster', authKind: 'agent_runtime' });
    await prepared.launch.release();
    expect(await readFile(join(homes.creator, 'auth.json'), 'utf8')).toContain('secret-creator');
  });

  it('refuses mismatched owner/snapshot and provider routes before any grant', async () => {
    const { resolve, rpc, dataDir } = await rig();
    await expect(resolve(input, { ...owner, chatId: 'other-chat' }, fence)).rejects.toThrow('claimed generation');
    await expect(resolve({ ...input, model: 'claude-opus-5' }, owner, fence)).rejects.toThrow('admitted combination');
    expect(rpc).not.toHaveBeenCalled();
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('revalidates purely and refuses token/policy/selected-connector revocation', async () => {
    const { resolve, rpc, state, bind } = await rig();
    const prepared = await resolve(input, owner, fence);
    rpc.mockClear();
    await prepared.revalidate();
    await prepared.launch.materialize();
    expect(rpc.mock.calls.every(call => call[1] === 'resolve_auth_session')).toBe(true);
    expect(bind).toHaveBeenCalledOnce();
    state.connectorCredential = 'different-account';
    await expect(prepared.launch.materialize()).rejects.toThrow('authorization is no longer available');
    state.connectorCredential = CREDENTIAL;
    state.revoked = true;
    await expect(prepared.revalidate()).rejects.toThrow('authorization is no longer available');
    state.revoked = false;
    state.denied = true;
    await expect(prepared.revalidate()).rejects.toThrow('authorization is no longer available');
    await prepared.launch.release();
  });

  it('cleans the exact grant and private files after a connector binding boot race', async () => {
    const { resolve, bind, rpc, dataDir } = await rig();
    bind.mockRejectedValueOnce(new Error(SECRET_ERROR));
    await expect(resolve(input, owner, fence)).rejects.toThrow('Chat launch could not be prepared');
    expect(await readdir(join(dataDir, 'chat', 'launches', CHAT, '1'))).toEqual([]);
    expect(rpc.mock.calls.filter(call => call[1] === 'revoke_agent_runtime_session')).toHaveLength(1);
  });

  it('never removes or revokes a successor when the old generation is released', async () => {
    const { resolve, sessions } = await rig();
    const first = await resolve(input, owner, fence);
    const next = await resolve(input, { ...owner, generation: 2, ownerLeaseId: 'lease-b' }, { ...fence, generation: 2, leaseEpoch: 3 });
    const material = await next.launch.materialize();
    await first.launch.release();
    await first.launch.release();
    expect(sessions.has(next.launch.runtimeGrantId)).toBe(true);
    expect(await stat(material.mcpConfigPath)).toBeDefined();
    await next.revalidate();
    await next.launch.release();
    await expect(next.revalidate()).rejects.toThrow('released');
  });

  it('reports a failed grant cleanup safely, removes files and supplies an exact retry', async () => {
    const { options, state, bind, dataDir, sessions } = await rig();
    state.failRevoke = true;
    bind.mockRejectedValueOnce(new Error(SECRET_ERROR));
    const cleanup = vi.fn();
    const resolve = createChatPreparedLaunchResolver({ ...options, onCleanupFailure: cleanup });
    await expect(resolve(input, owner, fence)).rejects.toThrow('Chat launch cleanup is pending');
    expect(await readdir(join(dataDir, 'chat', 'launches', CHAT, '1'))).toEqual([]);
    expect(cleanup).toHaveBeenCalledOnce();
    state.failRevoke = false;
    await cleanup.mock.calls[0]![0]();
    expect(sessions.size).toBe(0);
  });

  it('coalesces post-launch cleanup and retries only the retired generation', async () => {
    const { options, state, rpc, sessions, dataDir } = await rig();
    const cleanup = vi.fn();
    const resolve = createChatPreparedLaunchResolver({ ...options, onCleanupFailure: cleanup });
    const first = await resolve(input, owner, fence);
    state.failRevoke = true;
    const releasing = first.launch.release();
    const concurrent = first.launch.release();
    const results = await Promise.allSettled([releasing, concurrent]);
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(rpc.mock.calls.filter(call => call[1] === 'revoke_agent_runtime_session')).toHaveLength(1);
    expect(await readdir(join(dataDir, 'chat', 'launches', CHAT, '1'))).toEqual([]);

    state.failRevoke = false;
    const next = await resolve(input, { ...owner, generation: 2, ownerLeaseId: 'lease-b' }, { ...fence, generation: 2, leaseEpoch: 3 });
    const material = await next.launch.materialize();
    await cleanup.mock.calls[0]![0]();
    await first.launch.release();
    expect(rpc.mock.calls.filter(call => call[1] === 'revoke_agent_runtime_session').map(call => call[2]))
      .toEqual([
        [CHAT, fence.leaseEpoch, fence.generation, first.launch.runtimeGrantId],
        [CHAT, fence.leaseEpoch, fence.generation, first.launch.runtimeGrantId],
      ]);
    expect(sessions.has(next.launch.runtimeGrantId)).toBe(true);
    expect(await stat(material.mcpConfigPath)).toBeDefined();
    await next.revalidate();
    await next.launch.release();
  });

  it('keeps a failed post-launch cleanup retryable when its reporting hook throws', async () => {
    const { options, state, sessions } = await rig();
    const cleanup = vi.fn(() => { throw new Error(SECRET_ERROR); });
    const resolve = createChatPreparedLaunchResolver({ ...options, onCleanupFailure: cleanup });
    const prepared = await resolve(input, owner, fence);
    state.failRevoke = true;
    await expect(prepared.launch.release()).rejects.toThrow('Chat launch cleanup is pending');
    expect(cleanup).toHaveBeenCalledOnce();
    state.failRevoke = false;
    await prepared.launch.release();
    expect(sessions.size).toBe(0);
  });

  it('forwards the production factory cleanup hook for failed preparation unwind', async () => {
    const { options, state, bind, sessions } = await rig();
    const { registry: _registry, ...factoryOptions } = options;
    const cleanup = vi.fn();
    const foundation = composeChatBootstrap({ ...factoryOptions, nodeId: 'node-a', onCleanupFailure: cleanup });
    state.failRevoke = true;
    bind.mockRejectedValueOnce(new Error(SECRET_ERROR));
    await expect(foundation.resolvePreparedLaunch(input, owner, fence)).rejects.toThrow('Chat launch cleanup is pending');
    expect(cleanup).toHaveBeenCalledOnce();
    state.failRevoke = false;
    await cleanup.mock.calls[0]![0]();
    expect(sessions.size).toBe(0);
  });
});
