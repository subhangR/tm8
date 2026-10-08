/** Disposable real tm8 node. The shared PostgreSQL cluster is never owned here. */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdir, open, mkdtemp, writeFile, copyFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const require = createRequire(resolve(repoRoot, 'packages/server/package.json'));
const { Pool } = require('pg');

export function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('TM8_')) delete env[key];
  return { ...env, ...extra };
}

export async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timeout); }
}

async function launch(command, args, env, logPath, cwd = repoRoot) {
  const log = await open(logPath, 'a', 0o600);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', log.fd, log.fd] });
  child.once('exit', () => { void log.close(); });
  return child;
}

async function ready(url, child) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Owned process exited: ${child.exitCode}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Owned listener did not become ready: ${url}`);
}

async function assertFree(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}

/** Refuses ordinary/prod ports and creates its own DB, never resets an existing DB. */
export async function startTasklandNode({ beforeClose } = {}) {
  const raw = process.env.TASKLAND_TEST_ADMIN_URL;
  if (!raw) throw new Error('Set TASKLAND_TEST_ADMIN_URL to the approved isolated PostgreSQL cluster');
  const adminUrl = new URL(raw);
  if (!['127.0.0.1', 'localhost'].includes(adminUrl.hostname) || !adminUrl.port || ['5432', '5442'].includes(adminUrl.port)) {
    throw new Error('Test PostgreSQL requires an explicit isolated loopback port');
  }
  adminUrl.pathname = '/postgres';
  const apiPort = Number(process.env.TASKLAND_TEST_API_PORT ?? 18441);
  const uiPort = Number(process.env.TASKLAND_TEST_UI_PORT ?? 18442);
  if (!Number.isInteger(apiPort) || !Number.isInteger(uiPort) || apiPort === uiPort || Math.min(apiPort, uiPort) < 1024) {
    throw new Error('Independent unprivileged API and Vite ports required');
  }
  await assertFree(apiPort);
  await assertFree(uiPort);
  const runRoot = await mkdtemp(resolve(tmpdir(), 'tm8-taskland-run-'));
  const databaseName = `tm8_taskland_${randomUUID().replaceAll('-', '')}`;
  const dbUrl = new URL(adminUrl); dbUrl.pathname = `/${databaseName}`;
  const admin = new Pool({ connectionString: adminUrl.href, max: 1 });
  let api, ui, uiBuild, migration, pool, request, created = false, closed = false;
  const sessions = new Set();
  const origin = `http://127.0.0.1:${apiPort}`;
  const uiOrigin = `http://127.0.0.1:${uiPort}`;
  const close = async () => {
    if (closed) return; closed = true;
    const sessionStopErrors = [];
    process.removeListener('SIGTERM', interrupted);
    process.removeListener('SIGINT', interrupted);
    await beforeClose?.();
    for (const id of sessions) {
      if (api?.exitCode === null && request) {
        try {
          await request(`/v2/actions?contextEntityId=${id}&schema=v2&limit=100`);
          await request(`/v2/entities/${id}/commands/terminate`, { outcome: 'stop', note: 'Owned synthetic fixture cleanup' });
        } catch (error) { sessionStopErrors.push(error.message); }
      }
    }
    await stopChild(migration);
    await stopChild(uiBuild);
    await stopChild(ui);
    await stopChild(api);
    await pool?.end();
    if (created) await admin.query(`drop database ${databaseName} with (force)`);
    await admin.end();
    return { sessions: sessions.size, sessionsStopped: sessions.size - sessionStopErrors.length, sessionStopErrors };
  };
  const interrupted = () => { void close().finally(() => process.exit(130)); };
  process.once('SIGTERM', interrupted);
  process.once('SIGINT', interrupted);
  try {
    await admin.query(`create database ${databaseName}`); created = true;
    // Stage unchanged official files through 316 so a genuine historical NULL
    // fixture can exist before the exact checkout's official 317 observation.
    const migrationRoot = resolve(runRoot, 'initial-migrations');
    await mkdir(resolve(migrationRoot, 'db/migrations'), { recursive: true });
    await copyFile(resolve(repoRoot, 'db/migrate.mjs'), resolve(migrationRoot, 'db/migrate.mjs'));
    for (const name of await readdir(resolve(repoRoot, 'db/migrations'))) {
      if (/^\d{3}_[a-z0-9_]+\.sql$/.test(name) && Number(name.slice(0, 3)) <= 316) {
        await copyFile(resolve(repoRoot, 'db/migrations', name), resolve(migrationRoot, 'db/migrations', name));
      }
    }
    migration = await launch('node', ['db/migrate.mjs', 'up'], isolatedEnv({ TM8_DATABASE_URL: dbUrl.href }), resolve(runRoot, 'migration.log'), migrationRoot);
    const [code] = await once(migration, 'exit');
    if (code !== 0) throw new Error(`Official migrations failed; inspect ${runRoot}/migration.log`);
    pool = new Pool({ connectionString: dbUrl.href, max: 4 });
    await mkdir(resolve(runRoot, 'server-data'));
    const bin = resolve(runRoot, 'bin');
    await mkdir(bin);
    // Production Claude launch/resume argv and server-issued native id, with a
    // synthetic local executable replacing only the provider process. No model,
    // provider credentials or claims about a real provider conversation.
    for (const tool of ['claude', 'codex']) await writeFile(resolve(bin, tool), `#!${process.execPath}\n` +
      `if (process.argv.includes('--version')) { console.log('2.0.0 (synthetic Taskland provider)'); process.exit(0); }\n` +
      `const {appendFile}=await import('node:fs/promises');\n` +
      `await appendFile(${JSON.stringify(resolve(runRoot, 'provider-invocations.jsonl'))}, ${JSON.stringify(JSON.stringify({ tool }) + '\n')});\n` +
      `await import(${JSON.stringify(pathToFileURL(resolve(repoRoot, 'packages/execution/harness/echo-agent.mjs')).href)});\n`, { mode: 0o700 });
    api = await launch('node', ['--enable-source-maps', 'packages/server/dist/index.js'], isolatedEnv({
      TM8_DATABASE_URL: dbUrl.href, TM8_DATA_DIR: resolve(runRoot, 'server-data'),
      TM8_BIND: '127.0.0.1', TM8_PORT: String(apiPort), TM8_PREVIEW_PORT: '0',
      PATH: `${bin}:${process.env.PATH ?? ''}`, TM8_ENV: 'dev', TM8_LAUNCH_BOOTSTRAP: '0',
      TM8_ALLOWED_ORIGINS: `${origin},${uiOrigin}`,
    }), resolve(runRoot, 'server.log'));
    await ready(`${origin}/health`, api);
    uiBuild = await launch('node', ['node_modules/vite/bin/vite.js', 'build', '--config', 'e2e/taskland-server.vite.config.ts'],
      isolatedEnv({ TM8_SERVER_ORIGIN: origin }), resolve(runRoot, 'harness-build.log'), resolve(repoRoot, 'packages/tm8-ui'));
    const [built] = await once(uiBuild, 'exit');
    if (built !== 0) throw new Error(`Immutable harness build failed; inspect ${runRoot}/harness-build.log`);
    ui = await launch('node', ['node_modules/vite/bin/vite.js', 'preview', '--config', 'e2e/taskland-server.vite.config.ts', '--port', String(uiPort)],
      isolatedEnv({ TM8_SERVER_ORIGIN: origin }), resolve(runRoot, 'vite.log'), resolve(repoRoot, 'packages/tm8-ui'));
    await ready(`${uiOrigin}/e2e/taskland-server-harness.html`, ui);
    request = async (path, body, { token, method = body === undefined ? 'GET' : 'POST' } = {}) => {
      const response = await fetch(`${origin}${path}`, {
        method, headers: { 'x-tm8-client': 'tm8-ui', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
      });
      const envelope = await response.json();
      if (!response.ok || envelope.error) throw new Error(`${method} ${path}: HTTP ${response.status}: ${envelope.error?.code}: ${envelope.error?.message}`);
      return envelope.data ?? envelope;
    };
    const finishMigrations = async () => {
      migration = await launch('node', ['db/migrate.mjs', 'up'], isolatedEnv({ TM8_DATABASE_URL: dbUrl.href }), resolve(runRoot, 'migration-final.log'));
      const [code] = await once(migration, 'exit');
      if (code !== 0) throw new Error(`Final official migrations failed; inspect ${runRoot}/migration-final.log`);
    };
    return { origin, uiOrigin, runRoot, databaseName, pool, request, close, finishMigrations,
      ownSession: id => sessions.add(id), pids: { api: api.pid, ui: ui.pid } };
  } catch (error) { await close(); throw error; }
}
