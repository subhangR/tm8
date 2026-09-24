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
// It also pins composeEnv's GitHub isolation for `github: 'space'` (design §7),
// and (SC-6, D10) that real git and gh run in that environment act as the
// space token's account and never as the node's own gh login.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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

  // t6-1 (SC-6, D10). The node's own gh login lives where HOME points
  // ($HOME/.config/gh/hosts.yml, or GH_CONFIG_DIR), its git identity and
  // credential helper in $HOME/.gitconfig, and this fleet also exports
  // GIT_AUTHOR_NAME. HOME is a process basic the child keeps, so the proof is
  // what REAL git and gh do in the composed environment, not the key set.
  describe('t6-1: the node gh login is not used — real git and gh act as the space token\'s account', () => {
    let nodeHome: string;
    let repo: string;
    const NODE_LOGIN = 'node-machine-login';
    const NODE_OAUTH = `gho_${'M'.repeat(36)}`;

    beforeEach(async () => {
      nodeHome = await mkdtemp(join(tmpdir(), 'tm8-sc6-node-home-'));
      await mkdir(join(nodeHome, '.config', 'gh'), { recursive: true });
      await writeFile(join(nodeHome, '.config', 'gh', 'hosts.yml'),
        `github.com:\n    user: ${NODE_LOGIN}\n    oauth_token: ${NODE_OAUTH}\n    git_protocol: https\n`);
      await writeFile(join(nodeHome, '.gitconfig'), [
        '[user]',
        `\tname = ${NODE_LOGIN}`,
        '\temail = node@machine.invalid',
        '[credential "https://github.com"]',
        `\thelper = "!f() { echo username=${NODE_LOGIN}; echo password=${NODE_OAUTH}; }; f"`,
        '',
      ].join('\n'));
      repo = await mkdtemp(join(tmpdir(), 'tm8-sc6-repo-'));
    });

    afterEach(async () => {
      await rm(nodeHome, { recursive: true, force: true });
      await rm(repo, { recursive: true, force: true });
    });

    const nodeParent = (): NodeJS.ProcessEnv => ({
      HOME: nodeHome,
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GH_TOKEN: NODE_GH,
      GITHUB_TOKEN: NODE_GH,
      GH_CONFIG_DIR: join(nodeHome, '.config', 'gh'),
      XDG_CONFIG_HOME: join(nodeHome, '.config'),
      GIT_AUTHOR_NAME: NODE_LOGIN,
      GIT_AUTHOR_EMAIL: 'node@machine.invalid',
    });

    const spaceEnv = () => composeEnv(manifest, '/tmp/m.json', 'http://127.0.0.1:4610', nodeParent(), undefined, undefined, undefined,
      { provider: 'github', login: 'space-bot', token: SPACE_GH }, 'space');

    it('the composed env names the space account and carries no node gh lookup path', () => {
      const env = spaceEnv();
      expect(env.HOME).toBe(nodeHome);
      expect(env.GH_CONFIG_DIR).toBeUndefined();
      expect(env.XDG_CONFIG_HOME).toBeUndefined();
      expect(env.TM8_GIT_LOGIN).toBe('space-bot');
      expect(env.GIT_AUTHOR_NAME).toBe('space-bot');
      expect(env.GIT_COMMITTER_NAME).toBe('space-bot');
      expect(env.GIT_AUTHOR_EMAIL).toBe('space-bot@users.noreply.github.com');
      expect(env.GIT_COMMITTER_EMAIL).toBe('space-bot@users.noreply.github.com');
      for (const value of Object.values(env)) {
        expect(value).not.toContain(NODE_GH);
        expect(value).not.toContain(NODE_OAUTH);
        expect(value).not.toContain(NODE_LOGIN);
      }
    });

    it('git: a commit is authored and committed by the space account, and credential fill answers the space token', () => {
      const env = spaceEnv();
      execFileSync('git', ['init', '-q', repo], { env });
      execFileSync('git', ['-C', repo, 'commit', '-q', '--allow-empty', '-m', 'sc6'], { env });
      const who = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'], { env, encoding: 'utf8' }).trim();
      expect(who).toBe('space-bot <space-bot@users.noreply.github.com>|space-bot <space-bot@users.noreply.github.com>');

      const fill = execFileSync('git', ['credential', 'fill'], {
        env, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
      });
      expect(fill).toContain('username=space-bot');
      expect(fill).toContain(`password=${SPACE_GH}`);
      expect(fill).not.toContain(NODE_OAUTH);
      expect(fill).not.toContain(NODE_LOGIN);

      // Control: the SAME node home without the space token gives the node's
      // helper — so the assertion above is the isolation, not an empty home.
      const control = execFileSync('git', ['credential', 'fill'], {
        env: { PATH: env.PATH, HOME: nodeHome, GIT_TERMINAL_PROMPT: '0' },
        input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
      });
      expect(control).toContain(`password=${NODE_OAUTH}`);
    });

    const hasGh = (process.env.PATH ?? '').split(delimiter)
      .some((dir) => spawnSync('test', ['-x', join(dir, 'gh')]).status === 0);

    it.skipIf(!hasGh)('gh: `gh auth token` is the space token, not the node login in $HOME/.config/gh', () => {
      const env = spaceEnv();
      expect(execFileSync('gh', ['auth', 'token'], { env, encoding: 'utf8' }).trim()).toBe(SPACE_GH);
      // Control: the node home alone answers the node's login.
      expect(execFileSync('gh', ['auth', 'token'], {
        env: { PATH: env.PATH, HOME: nodeHome }, encoding: 'utf8',
      }).trim()).toBe(NODE_OAUTH);
    });
  });
});
