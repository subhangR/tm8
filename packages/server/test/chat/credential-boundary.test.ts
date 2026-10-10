import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCredentialHome, SpaceCredentialGrant, SpaceCredentialPort } from '@tm8/execution';
import { ChatLaunchDirectory, createChatCredentialPreparation } from '../../src/chat/credential-boundary.js';
import { chatCredentialRoute } from '../../src/chat/credentials.js';
import type { ChatLaunchConfigInput } from '../../src/chat/runtime.js';
import type { Db } from '../../src/db/types.js';

const CHAT = '019f0000-0000-7000-8000-000000000401';
const CRED = '019f0000-0000-7000-8000-000000000405';
const KEY = 'sentinel-selected-model-secret';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const input: ChatLaunchConfigInput = {
  chatId: CHAT, requesterIdentityId: 'human-a', requesterAuthKind: 'browser',
  teammateId: 'teammate-a', spaceId: 'space-a', model: 'claude-opus-5',
  provider: 'anthropic', agentTool: 'claude-code', chatMode: 'ask', cwd: '/tmp/chat', mode: 'new',
};
const owner = { chatId: CHAT, generation: 1, ownerLeaseId: 'lease-a', claimFence: 'claim-a' };

async function rig() {
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-chat-prepare-'));
  dirs.push(dataDir);
  const state: { grant?: SpaceCredentialGrant; member?: AgentCredentialHome; revoked: boolean; denied: boolean } = {
    revoked: false, denied: false,
  };
  const read = vi.fn(async () => state.revoked ? { ok: false as const, reason: 'revoked' as const }
    : state.grant ? { ok: true as const, grant: state.grant }
      : { ok: false as const, reason: 'no_default' as const });
  const space = {
    readPolicies: async () => state.denied ? { space: { anthropic: [] }, node: {} } : { space: {}, node: {} },
    myDefaultId: async () => null, read,
  } as unknown as SpaceCredentialPort;
  const member = vi.fn(async () => state.member ?? null);
  const port = createChatCredentialPreparation({
    db: {} as Db, dataDir, spaceCredentials: space, memberCredentials: { resolve: member },
    parentEnv: { ANTHROPIC_API_KEY: 'node-anthropic', OPENAI_API_KEY: 'node-openai',
      ANTHROPIC_AUTH_TOKEN: 'wrong-vendor-token', TM8_DATABASE_URL: 'sentinel-db-secret' },
  });
  return { dataDir, state, read, member, port };
}

describe('generation-owned chat credentials', () => {
  it('derives native/inference/policy providers from admitted model/harness routes', () => {
    expect(chatCredentialRoute(input)).toMatchObject({ nativeProvider: 'anthropic', inferenceProvider: 'anthropic' });
    expect(chatCredentialRoute({ model: 'kimi-k2-thinking', agentTool: 'claude-code' }))
      .toMatchObject({ nativeProvider: 'anthropic', inferenceProvider: 'kimi', policyProvider: 'anthropic' });
    expect(chatCredentialRoute({ model: 'gpt-6.1-sol', agentTool: 'codex' }))
      .toMatchObject({ nativeProvider: 'openai', inferenceProvider: 'openai', harness: 'codex' });
    expect(chatCredentialRoute({ model: 'openai/gpt-oss-120b', agentTool: 'codex' }))
      .toMatchObject({ nativeProvider: 'openai', inferenceProvider: 'groq', policyProvider: 'openai' });
    expect(() => chatCredentialRoute({ model: input.model, agentTool: 'codex' })).toThrow();
    expect(() => chatCredentialRoute({ model: 'unknown-model', agentTool: 'claude-code' })).toThrow();
  });

  it('previews sealed-key selection without writing directories or exposing secrets', async () => {
    const { port, state, dataDir } = await rig();
    state.grant = { kind: 'secret', provider: 'anthropic', credentialId: CRED, shape: 'api_key',
      label: 'key', displayLogin: null, secret: KEY };
    const binding = await port.preview({ ...input, provider: 'untrusted-provider' });
    expect(binding).toMatchObject({ source: 'space', credentialId: CRED,
      accountGeneration: null, materialRevision: null, hotReuse: false,
      route: { inferenceProvider: 'anthropic' } });
    expect(JSON.stringify(binding)).not.toContain(KEY);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it('materializes only selected account auth in private files and returns secret-free metadata', async () => {
    const { port, state } = await rig();
    state.grant = { kind: 'secret', provider: 'anthropic', credentialId: CRED, shape: 'api_key',
      label: 'key', displayLogin: null, secret: KEY };
    const prepared = await port.prepare(input, owner);
    expect(JSON.stringify(prepared)).not.toContain(KEY);
    const material = await prepared.materialize();
    expect(material.env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(material.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(material.env.OPENAI_API_KEY).toBeUndefined();
    expect(material.env.TM8_DATABASE_URL).toBeUndefined();
    expect(material.env.CLAUDE_CONFIG_DIR).toBe(material.modelConfigDir);
    expect((await stat(material.modelConfigDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(material.modelConfigDir, '.claude.json'))).mode & 0o777).toBe(0o600);
    await prepared.release();
    await expect(stat(material.modelConfigDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(prepared.materialize()).rejects.toThrow('released');
  });

  it('routes native OpenAI node fallback and persists the key where Codex authenticates', async () => {
    const { port } = await rig();
    const prepared = await port.prepare({ ...input, model: 'gpt-6.1-sol', provider: 'openai', agentTool: 'codex' }, owner);
    const material = await prepared.materialize();
    expect(material.env.OPENAI_API_KEY).toBe('node-openai');
    expect(material.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(material.env.CODEX_HOME).toBe(material.modelConfigDir);
    expect(JSON.parse(await readFile(join(material.modelConfigDir, 'auth.json'), 'utf8')))
      .toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: 'node-openai' });
    await prepared.release();
  });

  it('snapshots member OAuth without copying settings, history or deleting the source', async () => {
    const { port, state, dataDir } = await rig();
    const configDir = join(dataDir, 'member-login');
    await mkdir(configDir);
    await writeFile(join(configDir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: KEY } }));
    await writeFile(join(configDir, 'settings.json'), JSON.stringify({ maliciousPlugin: true }));
    await mkdir(join(configDir, 'projects'));
    state.member = { provider: 'anthropic', configDir, homeDir: dataDir };
    const prepared = await port.prepare({ ...input, credentialSelection: { source: 'member' } }, owner);
    const material = await prepared.materialize();
    expect(material.modelConfigDir).not.toBe(configDir);
    expect(await readdir(material.modelConfigDir)).toEqual(['.claude.json', '.credentials.json']);
    expect(material.env.ANTHROPIC_API_KEY).toBeUndefined();
    await prepared.release();
    expect(await readFile(join(configDir, '.credentials.json'), 'utf8')).toContain(KEY);
    expect(await stat(join(configDir, 'projects'))).toBeDefined();
  });

  it('isolates a Kimi member key and refuses an unsupported node source before preparation', async () => {
    const { port, state, dataDir } = await rig();
    state.member = { provider: 'kimi', homeDir: dataDir, configDir: join(dataDir, 'kimi'), apiKey: KEY };
    const target = { ...input, model: 'kimi-k2-thinking', provider: 'moonshot' };
    await expect(port.prepare({ ...target, credentialSelection: { source: 'node' } }, owner)).rejects.toThrow();
    expect(await readdir(dataDir)).toEqual([]);
    const prepared = await port.prepare(target, owner);
    const material = await prepared.materialize();
    expect(material.env.ANTHROPIC_AUTH_TOKEN).toBe(KEY);
    expect(material.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(material.env.ANTHROPIC_BASE_URL).toBe('https://api.moonshot.ai/anthropic');
    await prepared.release();
  });

  it('keeps a selected Auto space binding pinned during revalidation and refuses revocation', async () => {
    const { port, state, read } = await rig();
    state.grant = { kind: 'secret', provider: 'anthropic', credentialId: CRED, shape: 'api_key',
      label: 'key', displayLogin: null, secret: KEY };
    const prepared = await port.prepare(input, owner);
    await prepared.revalidate();
    expect(read.mock.calls.at(-1)?.[3]).toBe(CRED);
    state.revoked = true;
    await expect(prepared.materialize()).rejects.toThrow('authorization is no longer available');
    await prepared.release();
  });

  it('refuses credential-home relocation without touching either source home', async () => {
    const { port, state, dataDir } = await rig();
    const first = join(dataDir, 'first-home');
    const second = join(dataDir, 'second-home');
    for (const dir of [first, second]) {
      await mkdir(dir);
      await writeFile(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: KEY } }));
    }
    state.member = { provider: 'anthropic', configDir: first, homeDir: dataDir };
    const prepared = await port.prepare(input, owner);
    state.member = { ...state.member, configDir: second };
    await expect(prepared.materialize()).rejects.toThrow('authorization is no longer available');
    await prepared.release();
    expect(await readFile(join(first, '.credentials.json'), 'utf8')).toContain(KEY);
    expect(await readFile(join(second, '.credentials.json'), 'utf8')).toContain(KEY);
  });

  it('cleans a refused post-copy boot race without publishing private diagnostics', async () => {
    const { port, state, read, dataDir } = await rig();
    state.grant = { kind: 'secret', provider: 'anthropic', credentialId: CRED, shape: 'api_key',
      label: 'key', displayLogin: null, secret: KEY };
    read.mockImplementationOnce(async () => ({ ok: true, grant: state.grant! }));
    read.mockImplementation(async () => { throw new Error(KEY); });
    await expect(port.prepare(input, owner)).rejects.toThrow('cannot be prepared in an isolated runtime');
    expect(await readdir(join(dataDir, 'chat', 'launches', CHAT, '1'))).toEqual([]);
  });

  it('refuses ownership mismatches and leaves successor resources untouched', async () => {
    const { port } = await rig();
    const first = await port.prepare(input, owner);
    const second = await port.prepare(input, { ...owner, generation: 2, ownerLeaseId: 'lease-b' });
    const firstMaterial = await first.materialize();
    const secondMaterial = await second.materialize();
    await expect(first.release({ ...owner, ownerLeaseId: 'lease-b' })).rejects.toThrow('owner mismatch');
    expect(await stat(firstMaterial.modelConfigDir)).toBeDefined();
    await first.release();
    await first.release();
    expect(await stat(secondMaterial.modelConfigDir)).toBeDefined();
    await second.release();
  });

  it('refuses symlinked authentication files and unsupported/missing snapshots without leaking contents', async () => {
    const { port, state, dataDir } = await rig();
    const configDir = join(dataDir, 'member-login');
    await mkdir(configDir);
    const secretPath = join(dataDir, 'secret.json');
    await writeFile(secretPath, JSON.stringify({ accessToken: KEY }));
    await symlink(secretPath, join(configDir, '.credentials.json'));
    state.member = { provider: 'anthropic', homeDir: dataDir, configDir };
    await expect(port.prepare(input, owner)).rejects.toThrow('cannot be prepared');
    expect(await readFile(secretPath, 'utf8')).toContain(KEY);
  });

  it('refuses traversal and a replaced resource root rather than deleting its successor', async () => {
    const { dataDir } = await rig();
    const directory = await ChatLaunchDirectory.create(dataDir, owner);
    await expect(directory.write('../secret', KEY)).rejects.toThrow();
    await expect(directory.write('..', KEY)).rejects.toThrow();
    await rm(directory.path, { recursive: true });
    await mkdir(directory.path);
    await writeFile(join(directory.path, 'successor'), 'keep');
    await expect(directory.release()).rejects.toThrow('ownership changed');
    expect(await readFile(join(directory.path, 'successor'), 'utf8')).toBe('keep');
  });
});
