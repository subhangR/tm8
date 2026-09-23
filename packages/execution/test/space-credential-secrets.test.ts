// SC-2: the per-session space-key home, AT REST, and GitHub isolation with a
// space source.
//
// The PTY-exit scrub is pinned end to end in space-credential-spawn.test.ts.
// This file pins the two paths that do not go through a PTY exit:
//
//   - the boot sweep, which scrubs every home whose PTY died with the server
//     and leaves alone a home a live PTY is still using;
//   - the re-seed on resume, which writes the key read NOW over whatever
//     survived, so a rekey never leaves the old secret behind (D7).
//
// It also pins composeEnv's GitHub isolation for `github: 'space'` (design §7).

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { composeEnv, composeManifest } from '../src/spawn/manifest.js';
import {
  materializeSpaceApiKeyHome,
  spaceSessionHomeDir,
  sweepSpaceSessionSecrets,
} from '../src/spawn/space-credential-session-home.js';
import type { ResolvedCredentialSources, SpawnContext, SpawnRequest } from '../src/spawn/types.js';

const DEAD = '44444444-4444-4444-8444-444444444444';
const LIVE = '55555555-5555-4555-8555-555555555555';
const ANT = 'aaaaaaaa-0000-4000-8000-000000000001';
const OAI = 'bbbbbbbb-0000-4000-8000-000000000001';
const OLD_OAI_KEY = `sk-proj-${'O'.repeat(40)}`;
const NEW_OAI_KEY = `sk-proj-${'R'.repeat(40)}`;
const ANT_KEY = `sk-ant-api03-${'S'.repeat(40)}`;

describe('per-session space-key homes at rest', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc2-home-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function seed(sessionId: string): Promise<void> {
    await materializeSpaceApiKeyHome({ dataDir, sessionId, provider: 'openai', credentialId: OAI, apiKey: OLD_OAI_KEY });
    await materializeSpaceApiKeyHome({ dataDir, sessionId, provider: 'anthropic', credentialId: ANT, apiKey: ANT_KEY });
    const rollouts = join(spaceSessionHomeDir(dataDir, sessionId), 'openai', 'sessions');
    await mkdir(rollouts, { recursive: true });
    await writeFile(join(rollouts, 'rollout.jsonl'), '{"turn":1}\n', 'utf8');
  }

  it('the boot sweep scrubs a dead session and skips one a live PTY still holds', async () => {
    await seed(DEAD);
    await seed(LIVE);

    const result = await sweepSpaceSessionSecrets(dataDir, (id) => id === LIVE);

    expect(result).toEqual({ scrubbed: [DEAD], errors: [] });
    const dead = spaceSessionHomeDir(dataDir, DEAD);
    await expect(stat(join(dead, 'openai', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    const deadClaude = await readFile(join(dead, 'anthropic', '.claude.json'), 'utf8');
    expect(deadClaude).not.toContain(ANT_KEY.slice(-20));
    expect(JSON.parse(deadClaude)).toMatchObject({ hasCompletedOnboarding: true });
    expect(await readFile(join(dead, 'openai', 'sessions', 'rollout.jsonl'), 'utf8')).toBe('{"turn":1}\n');

    // The live session keeps the key its running PTY was started with.
    const live = spaceSessionHomeDir(dataDir, LIVE);
    expect(await readFile(join(live, 'openai', 'auth.json'), 'utf8')).toContain(OLD_OAI_KEY);
    expect(await readFile(join(live, 'anthropic', '.claude.json'), 'utf8')).toContain(ANT_KEY.slice(-20));

    // Idempotent: a second boot finds nothing left to scrub.
    expect(await sweepSpaceSessionSecrets(dataDir, () => false)).toEqual({ scrubbed: [LIVE], errors: [] });
    expect(await sweepSpaceSessionSecrets(dataDir, () => false)).toEqual({ scrubbed: [], errors: [] });
  });

  it('the sweep is a no-op on a node that never held a space home', async () => {
    expect(await sweepSpaceSessionSecrets(dataDir, () => false)).toEqual({ scrubbed: [], errors: [] });
  });

  it('a resume after a rekey re-seeds from the CURRENT key; the old secret does not survive', async () => {
    await seed(DEAD);
    const home = await materializeSpaceApiKeyHome({ dataDir, sessionId: DEAD, provider: 'openai', credentialId: OAI, apiKey: NEW_OAI_KEY });
    const auth = await readFile(join(home.configDir, 'auth.json'), 'utf8');
    expect(JSON.parse(auth)).toEqual({ auth_mode: 'apikey', OPENAI_API_KEY: NEW_OAI_KEY });
    expect(auth).not.toContain(OLD_OAI_KEY);
    expect((await stat(join(home.configDir, 'auth.json'))).mode & 0o777).toBe(0o600);
    expect((await stat(home.configDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(home.configDir, 'sessions', 'rollout.jsonl'), 'utf8')).toBe('{"turn":1}\n');
  });
});

describe('GitHub isolation with a space source (design §7)', () => {
  const SPACE_ID = '11111111-1111-4111-8111-111111111111';
  const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
  const SPACE_GH = `ghp_${'G'.repeat(36)}`;
  const NODE_GH = `ghp_${'N'.repeat(36)}`;
  const request: SpawnRequest = { spaceId: SPACE_ID, teamMemberId: MEMBER_ID };
  const context: SpawnContext = {
    spaceId: SPACE_ID,
    project: { id: 'proj-1', name: 'tm8', workingDir: '/tmp/tm8-fixture', trust: 'trusted' },
    teamMember: {
      id: MEMBER_ID, name: 'Fixture Member', role: 'fixture', identity: 'fixture', memories: [],
      model: 'opus', agentTool: null, mode: 'worker', permissionMode: null, avatar: null,
      capabilities: {}, commandPermissions: {},
    },
    tasks: [],
  };
  const manifest = composeManifest({
    sessionId: 'sess-1',
    request,
    context,
    launch: { mode: 'worker', model: 'opus', agentTool: 'claude-code', permissionMode: 'acceptEdits', accessMode: 'acceptEdits', reasoningEffort: null, credentialSource: 'space', credentialSources: { github: 'space' } as ResolvedCredentialSources },
    workdir: { mode: 'scratch', path: '/tmp/tm8-fixture' },
    command: 'claude',
    baseUrl: 'http://127.0.0.1:4610',
  });
  const parent: NodeJS.ProcessEnv = { HOME: '/home/tm8', PATH: '/usr/bin:/bin', GH_TOKEN: NODE_GH, GITHUB_TOKEN: NODE_GH };

  it('the space token is the child\'s GH_TOKEN/GITHUB_TOKEN and the machine helper is reset', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', parent, undefined, undefined, undefined,
      { provider: 'github', login: 'space-bot', token: SPACE_GH }, 'space');
    expect(env.GH_TOKEN).toBe(SPACE_GH);
    expect(env.GITHUB_TOKEN).toBe(SPACE_GH);
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(Object.values(env)).not.toContain(NODE_GH);
  });

  it('control: a space source with NO credential still empties GH_TOKEN and resets the helper — never the node token', () => {
    const env = composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', parent, undefined, undefined, undefined,
      undefined, 'space');
    expect(env.GH_TOKEN).toBe('');
    expect(env.GITHUB_TOKEN).toBe('');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    expect(Object.values(env)).not.toContain(NODE_GH);
  });
});
