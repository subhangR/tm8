import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { loadConfig } from '../../src/http/config.js';
import { createDb } from '../../src/db/client.js';
import { ScryptPasswordHasher } from '../../src/identity/crypto.js';
import { signupAccount, loginWithPassword } from '../../src/identity/pg-auth.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 120000, hookTimeout: 180000 });
describe('authenticated workspace API', () => {
  let database: W1ScratchDatabase, production: BootstrappedServer, dir: string;
  let alice: { token: string; accountId: string }, bob: { token: string; accountId: string }, adminToken: string;
  let spaceId: string, projectId: string;
  const calls: Array<Record<string, unknown>> = [];
  let providerConnected = false;
  const executions = new Map<string, Record<string, unknown>>();
  // Docker behavior has a separate real-engine acceptance test. This fixture
  // asserts the public HTTP/claims/RLS/broker composition using a Unix socket.
  const broker = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body) as Record<string, unknown>;
    if (input.action === 'pending') { res.end(JSON.stringify({ data: [] })); return; }
    calls.push(input);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/credentials') {
      const data = input.action === 'start' ? { workSessionId: randomUUID(), provider: input.provider, command: 'codex login --device-auth', expiresAt: new Date(Date.now() + 600000).toISOString() }
        : { providers: [{ provider: 'anthropic', connected: providerConnected }], gitCredentialStore: 'present' };
      res.end(JSON.stringify({ data })); return;
    }
    if (req.url === '/execution') {
      const id = input.sessionId as string;
      if (input.action === 'start') executions.set(id, { ...input, exited: false, exitCode: null, reason: null });
      const run = executions.get(id);
      if (run && input.action === 'stop') Object.assign(run, { exited: true, exitCode: 137, reason: 'stopped_by_operator' });
      res.end(JSON.stringify({ data: run ?? { missing: true } })); return;
    }
    res.end(JSON.stringify({ data: { ready: true, state: 'ready', branch: 'main', status: '## main', remotes: '' } }));
  });
  async function request(path: string, token?: string, body?: unknown) {
    const response = await fetch(`${production.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as { data: any; error?: { code: string; message: string } } };
  }
  beforeAll(async () => {
    database = await createW1ScratchDatabase('private_workspaces'); database.apply(migrationFiles());
    dir = await mkdtemp(join(tmpdir(), 'tm8-workspace-api-'));
    const socket = join(dir, 'broker.sock'); await new Promise<void>(resolve => broker.listen(socket, resolve));
    const db = createDb(database.url);
    const identity = randomUUID(); const password = 'tm8-test-password-123!';
    await db.rpc({}, 'ensure_account', [identity, 'test-owner', 'Owner', 'owner@example.test', true, true, 'scrypt', await new ScryptPasswordHasher().hash(password)]);
    const ownerClaims = { identityId: identity, nodeAdmin: true, authKind: 'browser' };
    for (const name of ['alice', 'bob']) {
      const account = await signupAccount(db, ownerClaims, { username: name, password, email: `${name}@example.test` });
      const login = await loginWithPassword(db, { username: name, password });
      if (name === 'alice') alice = { token: login.token, accountId: account.id };
      else bob = { token: login.token, accountId: account.id };
    }
    adminToken = (await loginWithPassword(db, { username: 'test-owner', password })).token;
    await db.end();
    const config = loadConfig({ TM8_BIND: '127.0.0.1', TM8_DATABASE_URL: database.url, TM8_DATA_DIR: dir,
      TM8_WORKSPACE_ISOLATION: 'true', TM8_WORKSPACE_BROKER_SOCKET: socket, TM8_MACHINE_ID: randomUUID(), TM8_MAX_USERS_PER_MACHINE: '2' });
    production = await bootstrap({ config: { ...config, port: 0 } });
  });
  afterAll(async () => {
    await production?.server.close(); await production?.db?.end();
    broker.closeAllConnections(); await new Promise<void>(resolve => broker.close(() => resolve()));
    await database?.destroy(); if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('requires login even on loopback and exposes public deployment capabilities', async () => {
    expect((await request('/v2/workspaces/me')).status).toBe(401);
    const result = await request('/v2/deployment/capabilities');
    expect(result.status).toBe(200); expect(result.body.data).toMatchObject({ distributedSystemFlag: false, workspaceIsolation: true, authentication: 'local' });
  });
  it('refuses password login, signup, password changes and password-based setup', async () => {
    const credentials = { username: 'alice', password: 'tm8-test-password-123!' };
    for (const [path, body] of [
      ['/v2/auth/login', credentials], ['/v2/auth/signup', credentials],
      ['/v2/auth/claim', { ...credentials, token: 'tm8c_' + 'a'.repeat(43) }],
      ['/v2/auth/password', { currentPassword: credentials.password, newPassword: 'new-password-123!' }],
      ['/v2/auth/invite/signup', { ...credentials, code: 'inv_' + 'a'.repeat(32) }],
    ] as const) {
      const result = await request(path, alice.token, body);
      expect(result.status, path).toBe(403);
      expect(result.body.error?.message).toContain('GitHub');
    }
    expect((await request('/v2/deployment/capabilities')).body.data.signInProviders).toEqual(['github']);
  });
  it('allocates once per account, derives the runner identity, and enforces capacity', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => request('/v2/workspaces/me/ensure', alice.token, {})));
    for (const result of results) expect(result.status, result.body.error?.message).toBe(200);
    expect(new Set(results.map(result => result.body.data.id)).size).toBe(1);
    expect(results[0]!.body.data.accountId).toBe(alice.accountId);
    expect(calls[0]).toMatchObject({ workspaceId: results[0]!.body.data.id, accountId: alice.accountId });
    expect((await request('/v2/workspaces/me/ensure', bob.token, {})).status).toBe(200);
    expect((await request('/v2/workspaces/me/ensure', adminToken, {})).status).toBe(409);
    const attempt = await request('/v2/workspaces/me/ensure', bob.token, { accountId: alice.accountId });
    expect(attempt.status).toBe(400);
    expect((await request('/v2/workspaces/me', bob.token)).body.data.accountId).toBe(bob.accountId);
  });
  it('creates a space and Git project without granting node administration', async () => {
    const space = await request('/v2/spaces', alice.token, { name: 'Private team', clientMutationId: randomUUID() });
    expect(space.status, JSON.stringify(space.body)).toBe(201);
    spaceId = space.body.data.space.id;
    const input = { spaceId, name: 'Private Git project', source: { kind: 'init' }, clientMutationId: randomUUID() };
    const project = await request('/v2/workspaces/projects', alice.token, input);
    expect(project.status, JSON.stringify(project.body)).toBe(200);
    projectId = project.body.data.projectId;
    const repeated = await request('/v2/workspaces/projects', alice.token, input);
    expect(repeated.body.data.projectId).toBe(projectId);
    expect(calls.filter(call => call.action === 'project-create')).toHaveLength(1);
  });
  it('refuses another account project even for a node administrator', async () => {
    expect((await request(`/v2/workspaces/projects/${projectId}/files/content?path=secret`, bob.token)).status).toBe(404);
    const rows = await production.db!.query({ identityId: (await database.query('select identity_id from accounts where username=$1', ['test-owner']))[0]!.identity_id as string, nodeAdmin: true }, 'select * from public.user_workspaces');
    expect(rows).toHaveLength(0);
  });
  it('connects Settings credentials to the owner runner and refuses another space or arbitrary command', async () => {
    expect((await request('/v2/identity/credentials')).status).toBe(403);
    expect((await request('/v2/identity/credentials', alice.token)).status).toBe(200);
    const input = { spaceId, provider: 'openai' };
    expect((await request('/v2/identity/credentials/login-sessions', bob.token, input)).status).toBe(403);
    expect((await request('/v2/identity/credentials/login-sessions', alice.token, { ...input, command: 'env' })).status).toBe(400);
    const started = await request('/v2/identity/credentials/login-sessions', alice.token, input);
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    expect(started.body.data.socketPath).toBe(`/v2/workspaces/terminals/${started.body.data.workSessionId}/ws`);
    expect(calls.at(-1)).toMatchObject({ action: 'start', provider: 'openai', accountId: alice.accountId });
  });
  it('rejects arbitrary host paths and unknown project input fields', async () => {
    const result = await request('/v2/projects', alice.token, { name: 'escape', workingDir: '/workspace/tm8', clientMutationId: randomUUID() });
    expect(result.status).toBe(409);
    expect(result.body.error?.message).toContain('private workspace');
    const before = calls.length;
    const spoof = await request('/v2/workspaces/projects', alice.token, { spaceId, name: 'escape', source: { kind: 'init' }, workingDir: '/etc', clientMutationId: randomUUID() });
    expect(spoof.status).toBe(400); expect(calls).toHaveLength(before);
  });
  it('seeds launch personas without scheduled automation and launches only in the caller workspace', async () => {
    const teammates = await database.query("select e.id,t.agent_tool,t.model from entities e join team_members t on t.entity_id=e.id where e.space_id=$1", [spaceId]);
    expect(teammates.length).toBeGreaterThan(1);
    expect((await database.query('select count(*)::int count from loops')).at(0)?.count).toBe(0);
    const claude = teammates.find(t => t.agent_tool === 'claude-code')!;
    const input = { spaceId, teamMemberId: claude.id, workdir: { mode: 'scratch' }, clientMutationId: randomUUID() };
    const disconnected = await request('/v2/execution/spawn', alice.token, input);
    expect(disconnected.status, JSON.stringify(disconnected.body)).toBe(409);
    expect(disconnected.body.error.message).toContain('Connect Claude Code');
    providerConnected = true;
    const started = await request('/v2/execution/spawn', alice.token, input);
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const sessionId = started.body.data.entity.id;
    const replayed = await request('/v2/execution/spawn', alice.token, input);
    expect(replayed.body.data.entity.id).toBe(sessionId);
    expect(calls.filter(c => c.action === 'start' && c.sessionId === sessionId)).toHaveLength(1);
    const run = executions.get(sessionId)!;
    expect(run.accountId).toBe(alice.accountId);
    expect(run.prompt).toContain("private Ubuntu workspace");
    expect(run).not.toHaveProperty('command');
    const row = (await database.query('select node_id,workdir_path,status from work_sessions where entity_id=$1', [sessionId]))[0]!;
    expect(row.node_id).toBe(`workspace:${run.workspaceId}`);
    expect(row.workdir_path).toMatch(/^\/home\/user\/scratch\//);
    expect(row.status).toBe('running');
    expect((await request(`/v2/work-sessions/${sessionId}/launch`, bob.token)).status).toBe(404);
    expect((await request(`/v2/entities/${sessionId}/commands/streams-attach`, bob.token, { mode: 'drive' })).status).toBe(404);
    const grant = await request(`/v2/entities/${sessionId}/commands/streams-attach`, alice.token, { mode: 'drive' });
    expect(grant.status, JSON.stringify(grant.body)).toBe(200);
    expect(grant.body.data.url).toBe(`/v2/workspaces/terminals/${sessionId}/ws?mode=drive`);
    expect(grant.body.data.url).not.toContain(grant.body.data.token);
    const stopped = await request(`/v2/entities/${sessionId}/commands/terminate`, alice.token, { clientMutationId: randomUUID() });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    expect((await database.query('select status,ended_kind from work_sessions where entity_id=$1', [sessionId]))[0]).toMatchObject({ status: 'exited', ended_kind: 'stopped_by_operator' });
  });
});
