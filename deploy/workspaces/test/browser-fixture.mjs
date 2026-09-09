// Disposable real backend for a browser acceptance run. Never uses tm8_dev.
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { bootstrap } from '../../../packages/server/dist/main.js';
import { loadConfig } from '../../../packages/server/dist/http/config.js';
import { createDb } from '../../../packages/server/dist/db/client.js';
import { WorkspaceBroker } from '../../../apps/workspace-broker/src/broker.mjs';

if (process.env.TM8_TEST_DOCKER !== '1' || !process.env.TM8_TEST_DATABASE_URL) throw new Error('Use the disposable Docker test launcher');
const name = `tm8_browser_test_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: process.env.TM8_TEST_DATABASE_URL });
await admin.query(`create database ${name}`);
const url = new URL(process.env.TM8_TEST_DATABASE_URL); url.pathname = `/${name}`;
const pool = new pg.Pool({ connectionString: url.href });
const dir = await fs.mkdtemp(path.join(tmpdir(), 'tm8-browser-'));
const machineId = randomUUID(), socket = path.join(dir, 'broker.sock');
const docker = new WorkspaceBroker({ machineId, stateDir: dir });
let server, broker, relay, cleaning = false;
async function cleanup() {
  if (cleaning) return; cleaning = true;
  try {
    await server?.server.close(); await server?.db?.end(); broker?.kill('SIGTERM'); relay?.kill('SIGTERM');
    const workspaces = (await pool.query('select id from public.user_workspaces')).rows;
    for (const workspace of workspaces) {
      const container = docker.name(workspace.id);
      if (await docker.docker.inspect(container)) await docker.docker.request('DELETE', `/containers/${container}?force=true`);
      await docker.docker.request('POST', `/networks/${container}-private/disconnect`, { Container: docker.egressContainer, Force: true }).catch(() => {});
      await docker.docker.request('DELETE', `/networks/${container}-private`).catch(() => {});
      await docker.docker.request('DELETE', `/volumes/${container}-home`).catch(() => {});
    }
    if (await docker.docker.inspect(docker.repositoryContainer)) await docker.docker.request('DELETE', `/containers/${docker.repositoryContainer}?force=true`);
    await docker.docker.request('DELETE', `/volumes/${docker.repositoryContainer}-data`).catch(() => {});
  } finally {
    await pool.end(); await admin.query(`drop database ${name} with (force)`); await admin.end(); await fs.rm(dir, { recursive: true, force: true });
  }
}
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void cleanup().then(() => process.exit(0)));
try {
  for (const file of (await fs.readdir('db/migrations')).filter(file => /^\d{3}_.*\.sql$/.test(file)).sort()) {
    const result = spawnSync('/usr/lib/postgresql/16/bin/psql', ['-X', '-q', '-1', '-v', 'ON_ERROR_STOP=1', url.href, '-f', `db/migrations/${file}`], { encoding: 'utf8' });
    if (result.status) throw new Error(`Fixture migration failed: ${file}: ${result.stderr}`);
  }
  const db = createDb(url.href);
  const identityId = randomUUID();
  await db.rpc({}, 'ensure_account', [identityId, 'browser-fixture', 'Browser Fixture', 'browser@example.test', true, true, null, null]); await db.end();
  await pool.query('insert into public.local_github_accounts(subject,account_id) select $1,id from public.accounts where identity_id=$2', ['987654321', identityId]);
  // Controlled GitHub provider responses exist only in this disposable fixture.
  // The browser still traverses the real OAuth state/PKCE callback and cookie flow.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (resource, init) => {
    if (resource === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: 'fixture-github-token' });
    if (resource === 'https://api.github.com/user') return Response.json({ id: 987654321, login: 'browser-fixture' });
    if (resource === 'https://api.github.com/user/emails') return Response.json([{ email: 'browser@example.test', verified: true, primary: true }]);
    return realFetch(resource, init);
  };
  broker = spawn(process.execPath, ['apps/workspace-broker/src/main.mjs'], { env: { ...process.env, TM8_MACHINE_ID: machineId, TM8_WORKSPACE_BROKER_SOCKET: socket,
    ...(process.env.TM8_TASK_PROVIDER_FIXTURE === '1' ? { TM8_RUNNER_IMAGE: 'tm8-workspace-task-fixture:test' } : {}) }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 100; i++) { try { await fs.stat(socket); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); } }
  const config = loadConfig({ TM8_ENV: 'dev', TM8_BIND: '127.0.0.1', TM8_PORT: '4629', TM8_PUBLIC_ORIGIN: 'http://127.0.0.1:4629',
    TM8_DATABASE_URL: url.href, TM8_DATA_DIR: dir, TM8_UI_DIR: '/workspace/tm8/packages/tm8-ui/dist', TM8_WORKSPACE_ISOLATION: 'true', TM8_MACHINE_ID: machineId, TM8_WORKSPACE_BROKER_SOCKET: socket,
    TM8_GITHUB_CLIENT_ID: 'fixture-client', TM8_GITHUB_CLIENT_SECRET: 'fixture-secret', TM8_NODE_CONTROL_DATABASE_URL: url.href });
  server = await bootstrap({ config });
  relay = spawn('socat', ['TCP-LISTEN:14629,bind=0.0.0.0,reuseaddr,fork', 'TCP:127.0.0.1:4629'], { stdio: 'inherit' });
  process.stdout.write('UI_FIXTURE_READY http://127.0.0.1:4629\n');
} catch (error) { await cleanup(); throw error; }
