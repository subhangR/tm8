import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolateCodexMcpHome } from '../src/spawn/mcp-home.js';

/*
 * The session's Codex login is a link to the source login, so a refresh the
 * session's Codex saves lands in the source (see "THE LOGIN IS SHARED" in
 * mcp-home.ts). Fixture tokens only; the canary checks that no token value
 * reaches a log line or an error.
 */
let dir: string;
let source: string;
const ACCOUNT = 'acct-fixture';
const login = (refresh: string, lastRefresh: string, account = ACCOUNT): string =>
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: 'id-fixture', access_token: `access-${refresh}`, refresh_token: refresh, account_id: account },
    last_refresh: lastRefresh,
  });
const sessionHome = (name: string): string => join(dir, 'mcp-homes', name, 'codex');
const isolate = async (name: string, home = source): Promise<Record<string, string>> => {
  const env = { CODEX_HOME: home };
  await isolateCodexMcpHome(join(dir, `${name}.json`), env);
  return env;
};
const refreshOf = async (path: string): Promise<string> => JSON.parse(await readFile(path, 'utf8')).tokens.refresh_token;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-login-'));
  source = join(dir, 'source');
  await mkdir(source);
  await writeFile(join(source, 'auth.json'), login('rt-source', '2026-10-01T00:00:00Z'), { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

it('links the session login to the source instead of copying it', async () => {
  const env = await isolate('s1');
  const auth = join(env.CODEX_HOME, 'auth.json');
  expect((await lstat(auth)).isSymbolicLink()).toBe(true);
  expect(await readlink(auth)).toBe(join(source, 'auth.json'));
  expect(await refreshOf(auth)).toBe('rt-source');
});

it('a refresh saved the way Codex saves it (truncate in place) lands in the source and in every other session', async () => {
  const first = await isolate('s1');
  const second = await isolate('s2');
  const sourceInode = (await stat(join(source, 'auth.json'))).ino;
  // FileAuthStorage::save: OpenOptions truncate+write+create on $CODEX_HOME/auth.json.
  await writeFile(join(first.CODEX_HOME, 'auth.json'), login('rt-rotated', '2026-10-19T00:00:00Z'), { flag: 'w' });
  expect(await refreshOf(join(source, 'auth.json'))).toBe('rt-rotated');
  expect(await refreshOf(join(second.CODEX_HOME, 'auth.json'))).toBe('rt-rotated');
  expect((await stat(join(source, 'auth.json'))).ino).toBe(sourceInode);
  expect((await lstat(join(first.CODEX_HOME, 'auth.json'))).isSymbolicLink()).toBe(true);
});

it('resume keeps the link and removing it (logout, exit scrub) leaves the source login alone', async () => {
  const env = await isolate('s1');
  await isolate('s1');
  expect((await lstat(join(env.CODEX_HOME, 'auth.json'))).isSymbolicLink()).toBe(true);
  await rm(join(env.CODEX_HOME, 'auth.json'));
  expect(await refreshOf(join(source, 'auth.json'))).toBe('rt-source');
});

it('a pre-upgrade copy holding a newer refresh of the same account is written back before the link replaces it', async () => {
  await mkdir(sessionHome('legacy'), { recursive: true });
  await writeFile(join(sessionHome('legacy'), 'auth.json'), login('rt-session-newer', '2026-10-10T00:00:00Z'));
  const env = await isolate('legacy');
  expect(await refreshOf(join(source, 'auth.json'))).toBe('rt-session-newer');
  expect((await stat(join(source, 'auth.json'))).mode & 0o777).toBe(0o600);
  expect((await lstat(join(env.CODEX_HOME, 'auth.json'))).isSymbolicLink()).toBe(true);
});

it.each([
  ['an older copy', login('rt-session-old', '2026-09-01T00:00:00Z')],
  ['a copy with the same timestamp', login('rt-session-tie', '2026-10-01T00:00:00Z')],
  ['a copy of another account', login('rt-other', '2026-10-15T00:00:00Z', 'acct-other')],
  ['a copy that is not a ChatGPT login', JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-fixture' })],
  ['an unreadable copy', '{not json'],
])('the source wins over %s', async (_label, copy) => {
  await mkdir(sessionHome('legacy'), { recursive: true });
  await writeFile(join(sessionHome('legacy'), 'auth.json'), copy);
  const env = await isolate('legacy');
  expect(await refreshOf(join(source, 'auth.json'))).toBe('rt-source');
  expect((await lstat(join(env.CODEX_HOME, 'auth.json'))).isSymbolicLink()).toBe(true);
});

it('a logged-out source is not resurrected from a session copy, and the session loses its login too', async () => {
  await mkdir(sessionHome('legacy'), { recursive: true });
  await writeFile(join(sessionHome('legacy'), 'auth.json'), login('rt-session-newer', '2026-10-10T00:00:00Z'));
  await rm(join(source, 'auth.json'));
  const env = await isolate('legacy');
  await expect(lstat(join(source, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(lstat(join(env.CODEX_HOME, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('concurrent resumes of pre-upgrade copies leave the newest refresh in the source', async () => {
  const stamps = ['2026-10-03', '2026-10-09', '2026-10-05', '2026-10-12', '2026-10-02', '2026-10-07'];
  await Promise.all(stamps.map(async (day, i) => {
    await mkdir(sessionHome(`c${i}`), { recursive: true });
    await writeFile(join(sessionHome(`c${i}`), 'auth.json'), login(`rt-${day}`, `${day}T00:00:00Z`));
  }));
  const envs = await Promise.all(stamps.map((_day, i) => isolate(`c${i}`)));
  expect(await refreshOf(join(source, 'auth.json'))).toBe('rt-2026-10-12');
  for (const env of envs) expect((await lstat(join(env.CODEX_HOME, 'auth.json'))).isSymbolicLink()).toBe(true);
  await expect(lstat(join(source, 'auth.json.tm8-lock'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('writes back through a source login that is itself a link', async () => {
  const real = join(dir, 'vault');
  await mkdir(real);
  await writeFile(join(real, 'auth.json'), login('rt-source', '2026-10-01T00:00:00Z'));
  await rm(join(source, 'auth.json'));
  const { symlink } = await import('node:fs/promises');
  await symlink(join(real, 'auth.json'), join(source, 'auth.json'));
  await mkdir(sessionHome('legacy'), { recursive: true });
  await writeFile(join(sessionHome('legacy'), 'auth.json'), login('rt-session-newer', '2026-10-10T00:00:00Z'));
  await isolate('legacy');
  expect((await lstat(join(source, 'auth.json'))).isSymbolicLink()).toBe(true);
  expect(await refreshOf(join(real, 'auth.json'))).toBe('rt-session-newer');
});

it('keeps a linked login in a file when the source config asks for the keyring', async () => {
  await writeFile(join(source, 'config.toml'), 'cli_auth_credentials_store = "auto"\nmodel = "fixture-model"\n');
  const env = await isolate('s1');
  const config = await readFile(join(env.CODEX_HOME, 'config.toml'), 'utf8');
  expect(config).toContain('cli_auth_credentials_store = "file"');
  expect(config).toContain('fixture-model');
  expect(await readFile(join(source, 'config.toml'), 'utf8')).toContain('"auto"');
});

it('never logs or throws a token value', async () => {
  const canary = 'rt-CANARY-9f3c';
  const lines: string[] = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  }
  await mkdir(sessionHome('legacy'), { recursive: true });
  await writeFile(join(sessionHome('legacy'), 'auth.json'), `{"tokens":{"refresh_token":"${canary}",`);
  await writeFile(join(source, 'auth.json'), `{"tokens":{"refresh_token":"${canary}"`);
  await expect(isolate('legacy')).resolves.toBeDefined();
  await writeFile(join(source, 'config.toml'), `model = "${canary}`);
  const failure = await isolate('other').catch((error: unknown) => error);
  expect(String(failure)).not.toContain(canary);
  expect(lines.join('\n')).not.toContain(canary);
});
