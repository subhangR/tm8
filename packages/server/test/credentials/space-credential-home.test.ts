/**
 * SC-4 — a login-shaped space credential's file home, on a real filesystem.
 *
 * t4-2: every path segment is allowlisted and every level is 0700, repaired
 * when it was not. A6: a promote never shows a reader a missing or half-written
 * credential file, and it keeps what agents wrote to Claude's state file. M6:
 * a promote that lost the race to a delete writes nothing. The injection path:
 * the live config dir this module promotes into is the one SC-2's spawn port
 * points CLAUDE_CONFIG_DIR / CODEX_HOME at.
 */
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { credentialHomeDir } from '../../src/credentials/agent-credential-home.js';
import {
  SpaceLoginHomes,
  spaceLoginConfigDir,
  spaceLoginCredentialDir,
  type SpaceLoginHomeKey,
} from '../../src/credentials/space-credential-home.js';
import { spaceCredentialLoginHome } from '../../src/credentials/space-credential-port.js';

let dataDir: string;
let homes: SpaceLoginHomes;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc4-home-'));
  homes = new SpaceLoginHomes({ dataDir });
});

afterEach(async () => {
  if (dataDir.includes('tm8-sc4-home-')) await rm(dataDir, { recursive: true, force: true });
});

const key = (provider: 'anthropic' | 'openai' = 'anthropic'): SpaceLoginHomeKey => ({
  spaceId: randomUUID(),
  credentialId: randomUUID(),
  provider,
});

async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

/** Log in "inside the terminal": what the vendor CLI leaves in its config dir. */
async function stageLogin(k: SpaceLoginHomeKey, ws: string, token: string): Promise<void> {
  const { configDir } = await homes.ensureStaging(k, ws);
  if (k.provider === 'anthropic') {
    await writeFile(join(configDir, '.credentials.json'), JSON.stringify({ token }));
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({ oauthAccount: { email: token }, hasCompletedOnboarding: true, projects: { staged: 1 } }));
  } else {
    await writeFile(join(configDir, 'auth.json'), JSON.stringify({ token }));
  }
}

describe('t4-2 — the home path is allowlisted, and every level is 0700', () => {
  it('lays out <dataDir>/credentials/spaces/<space>/<credential>/<provider>', () => {
    const k = key();
    expect(spaceLoginConfigDir(dataDir, k)).toBe(
      join(dataDir, 'credentials', 'spaces', k.spaceId, k.credentialId, 'anthropic'),
    );
  });

  it.each([
    ['a traversal', '../../etc'],
    ['a slash', 'a/b'],
    ['an uppercase uuid', randomUUID().toUpperCase()],
    ['an empty id', ''],
    ['a slug', 'spaces'],
  ])('refuses %s as a space id and as a credential id', (_name, bad) => {
    expect(() => spaceLoginCredentialDir(dataDir, bad, randomUUID())).toThrow(/space id/);
    expect(() => spaceLoginCredentialDir(dataDir, randomUUID(), bad)).toThrow(/credential id/);
  });

  it('refuses a provider a space login does not exist for', () => {
    expect(() => spaceLoginConfigDir(dataDir, { ...key(), provider: 'github' as never })).toThrow();
  });

  it('refuses a work session id that is not a uuid for the staging home', async () => {
    await expect(homes.ensureStaging(key(), '../live')).rejects.toThrow(/work session id/);
  });

  it('creates every level at 0700 and REPAIRS a level that was 0755', async () => {
    const k = key();
    await mkdir(join(dataDir, 'credentials', 'spaces', k.spaceId), { recursive: true, mode: 0o755 });
    await chmod(join(dataDir, 'credentials'), 0o755);
    await chmod(join(dataDir, 'credentials', 'spaces'), 0o755);
    await chmod(join(dataDir, 'credentials', 'spaces', k.spaceId), 0o755);

    const ws = randomUUID();
    const staging = await homes.ensureStaging(k, ws);
    const live = await homes.ensureLive(k);

    const levels = [
      join(dataDir, 'credentials'),
      join(dataDir, 'credentials', 'spaces'),
      join(dataDir, 'credentials', 'spaces', k.spaceId),
      live.homeDir,
      live.configDir,
      join(live.homeDir, '.login'),
      staging.homeDir,
      staging.configDir,
    ];
    for (const level of levels) expect({ level, mode: await modeOf(level) }).toEqual({ level, mode: 0o700 });
  });

  it('refuses a symlink planted at a level instead of following it', async () => {
    const k = key();
    const elsewhere = await mkdtemp(join(tmpdir(), 'tm8-sc4-elsewhere-'));
    try {
      await mkdir(join(dataDir, 'credentials', 'spaces', k.spaceId), { recursive: true });
      await symlink(elsewhere, join(dataDir, 'credentials', 'spaces', k.spaceId, k.credentialId));
      await expect(homes.ensureLive(k)).rejects.toThrow(/not a directory/);
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('a member home can never be named "spaces" — it would sit inside the space root', () => {
    expect(() => credentialHomeDir(dataDir, 'spaces')).toThrow(/not usable/);
  });
});

describe('injection — the live config dir is the one the SC-2 spawn port points agents at', () => {
  it.each(['anthropic', 'openai'] as const)('%s: join(spawn home, provider) is the promote target', (provider) => {
    const k = key(provider);
    // credential-resolution.ts spaceHome(): configDir = join(grant.homeDir, provider),
    // and the grant's homeDir comes from spaceCredentialLoginHome.
    expect(join(spaceCredentialLoginHome(dataDir, k.spaceId, k.credentialId), provider)).toBe(
      spaceLoginConfigDir(dataDir, k),
    );
  });
});

describe('A6 — a re-login swaps the live files atomically', () => {
  it('promotes the staged credential at 0600 and keeps what agents wrote to .claude.json', async () => {
    const k = key();
    const { configDir } = await homes.ensureLive(k);
    await writeFile(join(configDir, '.claude.json'), JSON.stringify({ projects: { agentWrote: true }, oauthAccount: { email: 'old' } }));
    const ws = randomUUID();
    await stageLogin(k, ws, 'new-token');

    expect(await homes.promote(k, ws, async () => true)).toBe(true);

    const credentials = join(configDir, '.credentials.json');
    expect(JSON.parse(await readFile(credentials, 'utf8'))).toEqual({ token: 'new-token' });
    expect((await lstat(credentials)).mode & 0o777).toBe(0o600);
    const state = JSON.parse(await readFile(join(configDir, '.claude.json'), 'utf8')) as Record<string, unknown>;
    expect(state).toEqual({
      projects: { agentWrote: true },
      oauthAccount: { email: 'new-token' },
      hasCompletedOnboarding: true,
    });
    // No temp file is left behind for a reader to trip over.
    expect((await readdir(configDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it.each(['anthropic', 'openai'] as const)(
    '%s: a reader polling the live file during repeated re-logins never sees it missing or partial',
    async (provider) => {
      const k = key(provider);
      const file = provider === 'anthropic' ? '.credentials.json' : 'auth.json';
      const firstWs = randomUUID();
      // A large payload, so a non-atomic write would be observable half-done.
      const pad = 'x'.repeat(256 * 1024);
      await stageLogin(k, firstWs, `token-0-${pad}`);
      await homes.promote(k, firstWs, async () => true);
      const live = join(spaceLoginConfigDir(dataDir, k), file);

      let stop = false;
      let reads = 0;
      const seen: string[] = [];
      const reader = (async () => {
        while (!stop) {
          try {
            const parsed = JSON.parse(await readFile(live, 'utf8')) as { token: string };
            seen.push(parsed.token.slice(0, 8));
          } catch (error) {
            seen.push(`BROKEN:${(error as Error).message.slice(0, 60)}`);
          }
          reads += 1;
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      for (let i = 1; i <= 25; i += 1) {
        const ws = randomUUID();
        await stageLogin(k, ws, `token-${String(i)}-${pad}`);
        await homes.promote(k, ws, async () => true);
        await homes.removeStaging(k, ws);
      }
      stop = true;
      await reader;
      expect(reads).toBeGreaterThan(0);
      expect(seen.filter((token) => token.startsWith('BROKEN'))).toEqual([]);
      expect(JSON.parse(await readFile(live, 'utf8'))).toEqual({ token: `token-25-${pad}` });
    },
  );

  it('an abandoned re-login (staging only) never touches the live home', async () => {
    const k = key('openai');
    const first = randomUUID();
    await stageLogin(k, first, 'good');
    await homes.promote(k, first, async () => true);
    const abandoned = randomUUID();
    const { configDir } = await homes.ensureStaging(k, abandoned);
    await writeFile(join(configDir, 'auth.json'), '{"tok'); // the CLI died half way
    await homes.removeStaging(k, abandoned);
    expect(JSON.parse(await readFile(join(spaceLoginConfigDir(dataDir, k), 'auth.json'), 'utf8'))).toEqual({ token: 'good' });
  });

  it('a staging dir with no credential file promotes nothing', async () => {
    const k = key();
    const ws = randomUUID();
    await homes.ensureStaging(k, ws);
    expect(await homes.stagingHasLogin(k, ws)).toBe(false);
    expect(await homes.promote(k, ws, async () => true)).toBe(false);
    await expect(stat(join(spaceLoginConfigDir(dataDir, k), '.credentials.json'))).rejects.toThrow(/ENOENT/);
  });
});

describe('M6 — a promote that lost the race to a delete writes nothing', () => {
  it('asks the row UNDER the lock, after an in-flight remove, and writes no file when it is gone', async () => {
    const k = key();
    const ws = randomUUID();
    await stageLogin(k, ws, 'late');
    let revoked = false;
    // The delete revokes and removes; the promote queued behind it re-asks.
    const removing = homes.remove(k).then(() => { revoked = true; });
    const promoted = homes.promote(k, ws, async () => !revoked);
    await removing;
    expect(await promoted).toBe(false);
    await expect(stat(spaceLoginCredentialDir(dataDir, k.spaceId, k.credentialId))).rejects.toThrow(/ENOENT/);
  });

  it('a revoke the row shows before remove() has run: the staged login is there, and still nothing is written', async () => {
    // The test above cannot see a missing re-check on its own — remove()
    // takes the staging dir with it. Here the staging survives, so only the
    // re-asked row stands between the promote and the live home.
    const k = key();
    const ws = randomUUID();
    await stageLogin(k, ws, 'revoked');
    expect(await homes.promote(k, ws, async () => false)).toBe(false);
    await expect(stat(spaceLoginConfigDir(dataDir, k))).rejects.toThrow(/ENOENT/);
  });

  it('remove() deletes the whole credential home, staging included', async () => {
    const k = key();
    const ws = randomUUID();
    await stageLogin(k, ws, 'a');
    await homes.promote(k, ws, async () => true);
    await homes.remove(k);
    await expect(stat(spaceLoginCredentialDir(dataDir, k.spaceId, k.credentialId))).rejects.toThrow(/ENOENT/);
  });
});

describe('R1/R17 narrow scrub — a switch to private removes only non-owner launches\' transcripts', () => {
  const FAKE_LOGIN = '{"claudeAiOauth":{"accessToken":"fake-W10bFakeCanary7d41-access","refreshToken":"fake-W10bFakeCanary7d41-refresh"}}\n';
  const FAKE_STATE = '{"hasCompletedOnboarding":true,"oauthAccount":{"emailAddress":"owner@example.com"}}\n';
  const FAKE_CODEX = '{"auth_mode":"chatgpt","tokens":{"refresh_token":"fake-W10bFakeCanary7d41"}}\n';

  async function put(path: string, content: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }

  const exists = async (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

  it('claude: the foreign session file goes from every project dir; the owner\'s, history, the auth files and a symlinked dir stay', async () => {
    const k = key('anthropic');
    const { configDir } = await homes.ensureLive(k);
    const owner = randomUUID();
    const foreign = randomUUID();
    await put(join(configDir, '.credentials.json'), FAKE_LOGIN);
    await put(join(configDir, '.claude.json'), FAKE_STATE);
    await put(join(configDir, 'history.jsonl'), `{"sessionId":"${foreign}"}\n`);
    await put(join(configDir, 'projects', '-work-a', `${owner}.jsonl`), 'owner turn\n');
    await put(join(configDir, 'projects', '-work-a', `${foreign}.jsonl`), 'foreign turn\n');
    await put(join(configDir, 'projects', '-work-b', `${foreign}.jsonl`), 'foreign turn\n');
    // A symlinked project dir pointing outside the home is never followed.
    const outside = await mkdtemp(join(dataDir, 'outside-'));
    await put(join(outside, `${foreign}.jsonl`), 'outside\n');
    await symlink(outside, join(configDir, 'projects', '-evil'));

    const removed = await homes.scrubForeignLaunches(k, [{ workSessionId: foreign, nativeSessionId: foreign }]);

    expect(removed).toBe(2);
    expect(await exists(join(configDir, 'projects', '-work-a', `${foreign}.jsonl`))).toBe(false);
    expect(await exists(join(configDir, 'projects', '-work-b', `${foreign}.jsonl`))).toBe(false);
    expect(await readFile(join(configDir, 'projects', '-work-a', `${owner}.jsonl`), 'utf8')).toBe('owner turn\n');
    expect(await readFile(join(outside, `${foreign}.jsonl`), 'utf8')).toBe('outside\n');
    // Not attributable by file: stays.
    expect(await exists(join(configDir, 'history.jsonl'))).toBe(true);
    // The login survives byte for byte, and the home still serves the next launch.
    expect(await readFile(join(configDir, '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
    expect(await readFile(join(configDir, '.claude.json'), 'utf8')).toBe(FAKE_STATE);
    expect((await homes.ensureLive(k)).configDir).toBe(configDir);
  });

  it('claude: a launch with no recorded native id, or a non-uuid one, removes nothing', async () => {
    const k = key('anthropic');
    const { configDir } = await homes.ensureLive(k);
    await put(join(configDir, 'projects', '-w', '..jsonl'), 'x\n');
    await put(join(configDir, '.credentials.json'), FAKE_LOGIN);
    expect(await homes.scrubForeignLaunches(k, [
      { workSessionId: randomUUID(), nativeSessionId: null },
      { workSessionId: randomUUID(), nativeSessionId: '../.credentials' },
    ])).toBe(0);
    expect(await readFile(join(configDir, '.credentials.json'), 'utf8')).toBe(FAKE_LOGIN);
  });

  it('codex: only a rollout whose USER message carries the session marker goes; a mere mention stays, and auth.json stays', async () => {
    const k = key('openai');
    const { configDir } = await homes.ensureLive(k);
    const owner = randomUUID();
    const foreign = randomUUID();
    const rollout = (id: string, userText: string, extra = ''): string => [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-09-26T07:00:00Z', payload: { id, cwd: '/w' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: userText }] } }),
      extra,
    ].join('\n');
    const day = join(configDir, 'sessions', '2026', '09', '26');
    await put(join(configDir, 'auth.json'), FAKE_CODEX);
    await put(join(day, 'rollout-foreign.jsonl'), rollout(randomUUID(), `task <tm8_session_id>${foreign}</tm8_session_id>`));
    await put(join(day, 'rollout-owner.jsonl'), rollout(randomUUID(), `task <tm8_session_id>${owner}</tm8_session_id>`));
    // The owner's coordinator output names the foreign session: not ownership.
    await put(join(day, 'rollout-mention.jsonl'), rollout(randomUUID(), `task <tm8_session_id>${owner}</tm8_session_id>`,
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: `<tm8_session_id>${foreign}</tm8_session_id>` } })));

    expect(await homes.scrubForeignLaunches(k, [{ workSessionId: foreign, nativeSessionId: null }])).toBe(1);
    expect((await readdir(day)).sort()).toEqual(['rollout-mention.jsonl', 'rollout-owner.jsonl']);
    expect(await readFile(join(configDir, 'auth.json'), 'utf8')).toBe(FAKE_CODEX);
  });

  it('a home that is absent, or a config dir that is a symlink, is a no-op', async () => {
    const k = key('anthropic');
    expect(await homes.scrubForeignLaunches(k, [{ workSessionId: randomUUID(), nativeSessionId: randomUUID() }])).toBe(0);
    const credentialDir = spaceLoginCredentialDir(dataDir, k.spaceId, k.credentialId);
    await mkdir(credentialDir, { recursive: true });
    const elsewhere = await mkdtemp(join(dataDir, 'elsewhere-'));
    const id = randomUUID();
    await put(join(elsewhere, 'projects', '-w', `${id}.jsonl`), 'x\n');
    await symlink(elsewhere, spaceLoginConfigDir(dataDir, k));
    expect(await homes.scrubForeignLaunches(k, [{ workSessionId: id, nativeSessionId: id }])).toBe(0);
    expect(await exists(join(elsewhere, 'projects', '-w', `${id}.jsonl`))).toBe(true);
  });
});
