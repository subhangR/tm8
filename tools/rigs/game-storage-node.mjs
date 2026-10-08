/** Real process lifecycle for synthetic Game storage acceptance. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const runRoot = resolve(process.env.GAME_STORAGE_RUN_DIR ?? '/tmp/tm8-storage-acceptance');
export const apiPort = Number(process.env.GAME_STORAGE_API_PORT ?? 18432);
export const uiPort = Number(process.env.GAME_STORAGE_UI_PORT ?? 18433);
export const origin = `http://127.0.0.1:${apiPort}`;

export function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  // A fixture must never inherit the worker's authenticated production identity.
  for (const key of Object.keys(env)) if (key.startsWith('TM8_')) delete env[key];
  return { ...env, ...extra };
}

export function databaseUrl() {
  const raw = process.env.GAME_STORAGE_DATABASE_URL;
  if (!raw) throw new Error('Set GAME_STORAGE_DATABASE_URL to an isolated migrated PostgreSQL database');
  const url = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !url.port || ['5432', '5442'].includes(url.port)) {
    throw new Error('Acceptance database must use explicit isolated loopback port (never 5432/5442)');
  }
  return url.href;
}

export async function waitReady(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Owned child exited (${child.exitCode}); inspect local lifecycle log`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1_000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Owned listener did not become ready at ${url}`);
}

async function launch(command, args, env, name, cwd = repoRoot) {
  await mkdir(runRoot, { recursive: true });
  const log = await open(resolve(runRoot, `${name}.log`), 'a', 0o600);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
  child.once('exit', () => { void log.close(); });
  return child;
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try { await exited; } finally { clearTimeout(timer); }
}

export async function startServer() {
  const child = await launch('node', ['--enable-source-maps', 'packages/server/dist/index.js'], isolatedEnv({
    TM8_DATABASE_URL: databaseUrl(), TM8_DATA_DIR: resolve(runRoot, 'server-data'),
    TM8_BIND: '127.0.0.1', TM8_PORT: String(apiPort), TM8_PREVIEW_PORT: '0', TM8_ENV: 'dev',
  }), 'server');
  try { await waitReady(`${origin}/health`, child); return child; }
  catch (error) { await stopChild(child); throw error; }
}

export async function startUi() {
  const child = await launch('bun', ['run', 'dev', '--', '--port', String(uiPort)], isolatedEnv({
    TM8_SERVER_ORIGIN: origin,
  }), 'vite', resolve(repoRoot, 'packages/tm8-ui'));
  try { await waitReady(`http://127.0.0.1:${uiPort}/e2e/game-storage-harness.html`, child); return child; }
  catch (error) { await stopChild(child); throw error; }
}

export async function request(path, body, { token, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: { 'x-tm8-client': 'tm8-ui', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const envelope = await response.json();
  return { status: response.status, data: envelope.data ?? envelope, error: envelope.error };
}

export async function runCli(args, env = {}) {
  const child = spawn('node', ['packages/cli/dist/index.js', ...args, '--format', 'json'], {
    cwd: repoRoot, env: isolatedEnv({ TM8_BASE_URL: origin, TM8_NO_CACHE: '1', TM8_JOURNAL_CLASS: 'harness', ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [code] = await once(child, 'exit');
  clearTimeout(timer);
  return { code, stdout, stderr };
}
