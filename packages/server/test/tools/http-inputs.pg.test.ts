import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { ToolViewSchema } from '@tm8/contract';
import { PtyHostService, type SpawnService } from '@tm8/execution';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { createSessionIdentityResolver } from '../../src/http/identity-resolver.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { registerToolHandlers } from '../../src/tools/handlers.js';
import { ToolRuntime } from '../../src/tools/runtime.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60000, hookTimeout: 300000 });
let database: W1ScratchDatabase, db: Db, server: FacadeServer, runtime: ToolRuntime;
let base: string, dir: string;
const pty = new PtyHostService(), sessions = new Set<string>();
const space = randomUUID(), member = randomUUID(), account = randomUUID(), authSession = randomUUID();
const identityId = 'tools-http-owner', secret = generateSecret(), token = formatToken(authSession, secret);
const claims: DbClaims = { identityId, authKind: 'cli', sessionSpaceId: space };
const owner = async () => ({ identityId, accountId: account, username: identityId, isNodeAdmin: false, isOwner: false });
const definition = () => ({ name: `http-tool-${randomUUID()}`, description: '', help: '', runtime: 'bash',
  source: 'exit 0', tm8Access: 'none', timeoutSeconds: 10,
  inputs: [{ name: 'message', type: 'string' }, { name: 'key', type: 'secret' }] });

beforeAll(async () => {
  database = await createW1ScratchDatabase('tool_http_inputs');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$1)', [identityId]);
    await c.query('insert into public.accounts(id,identity_id,username,display_name) values($1,$2,$2,$2)', [account, identityId]);
    await c.query("insert into public.spaces(id,name,created_by_identity) values($1,'Tool HTTP fixture',$2)", [space, identityId]);
    await c.query("insert into public.entities(id,space_id,kind,position,created_by) values($1,$2,'member',0,$1)", [member, space]);
    await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner',$3)", [member, space, identityId]);
    await c.query("insert into public.auth_sessions(id,account_id,kind,space_id,token_hash,expires_at) values($1,$2,'cli',$3,$4,now()+interval '1 hour')", [authSession, account, space, hashToken(secret)]);
  });
  dir = await mkdtemp(join(tmpdir(), 'tm8-tool-http-'));
  const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024,
    databaseUrl: database.url, disableAutoOwner: true };
  const registry = new HandlerRegistry();
  runtime = new ToolRuntime({ db, pty, spawnService: { adoptToolSession: vi.fn() } as unknown as SpawnService,
    dataDir: dir, baseUrl: 'http://127.0.0.1:1', nodeId: 'tool-http-test' });
  registerToolHandlers(registry, { db, config, owner }, runtime);
  server = createFacadeServer({ config, registry, identityResolver: createSessionIdentityResolver({ db, owner }) });
  base = (await server.listen()).url;
});
afterAll(async () => {
  for (const id of sessions) pty.kill(id);
  await server?.close();
  await db?.end();
  await database?.destroy();
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function version(id: string): Promise<number> {
  return (await database.query<{ version: number }>('select version from public.entities where id=$1', [id]))[0]!.version;
}
async function createFixture(): Promise<string> {
  return (await db.rpc<{ entity: { id: string } }>(claims, 'create_tool_entity', [space, definition(), null, randomUUID()])).entity.id;
}
async function request(method: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, { method, headers: {
    authorization: `Bearer ${token}`, 'content-type': 'application/json',
  }, body: JSON.stringify({ clientMutationId: randomUUID(), ...body }) });
  return { status: response.status, json: await response.json() };
}

const mutations = [
  ['tools.create', 'POST', ''], ['tools.update', 'PATCH', ''],
  ['tools.config.set', 'PUT', '/config'], ['tools.config.unset', 'POST', '/config/unset'],
  ['tools.secrets.bind', 'POST', '/secrets/bind'], ['tools.secrets.unbind', 'POST', '/secrets/unbind'],
  ['tools.run', 'POST', '/run'],
] as const;
for (const [op, method, suffix] of mutations) {
  for (const mode of ['route-only', 'matching body', 'mismatched body'] as const) {
    it(`${op} handles a ${mode} id through authenticated HTTP`, async () => {
      const id = op === 'tools.create' ? space : await createFixture();
      const field = op === 'tools.create' ? 'spaceId' : 'toolId';
      if (op === 'tools.secrets.unbind') {
        await runtime.createSecret(claims, { toolId: id, inputName: 'key', value: 'seed-secret', expectedVersion: await version(id), clientMutationId: randomUUID() });
      }
      const before = op === 'tools.create' ? undefined : await version(id);
      const body: Record<string, unknown> = op === 'tools.create' ? { definition: definition() }
        : op === 'tools.update' ? { expectedVersion: before, definition: definition() }
        : op === 'tools.config.set' ? { expectedVersion: before, inputName: 'message', value: 'configured' }
        : op === 'tools.config.unset' ? { expectedVersion: before, inputName: 'message' }
        : op === 'tools.secrets.bind' ? { expectedVersion: before, inputName: 'key', value: 'private-bind-value' }
        : op === 'tools.secrets.unbind' ? { expectedVersion: before, inputName: 'key' }
        : { expectedVersion: before, inputs: { message: 'run-value' }, keepOpen: false };
      if (mode !== 'route-only') body[field] = mode === 'matching body' ? id : randomUUID();
      const path = op === 'tools.create' ? `/v2/spaces/${id}/tools` : `/v2/tools/${id}${suffix}`;
      const result = await request(method, path, body);
      if (mode === 'mismatched body') {
        expect(result.status, JSON.stringify(result.json)).toBe(400);
        expect(result.json.error).toMatchObject({ code: 'invalid_input', message: `body ${field} does not match route` });
        if (before !== undefined) expect(await version(id)).toBe(before);
        return;
      }
      expect(result.status, JSON.stringify(result.json)).toBe(200);
      if (op === 'tools.run') {
        const sessionId = result.json.data.sessionId as string; sessions.add(sessionId);
        expect(result.json.data.toolId).toBe(id);
        expect(JSON.stringify(result.json.data)).not.toContain('run-value');
        await vi.waitFor(async () => {
          const [row] = await database.query('select tool_id,tool_state from public.work_sessions where entity_id=$1', [sessionId]);
          expect(row).toMatchObject({ tool_id: id, tool_state: 'exited' });
        }, { timeout: 15000 });
      } else if (op === 'tools.secrets.bind') {
        expect(result.json.data).toEqual({ inputName: 'key', keyHint: '••••' });
      } else {
        const view = ToolViewSchema.parse(result.json.data);
        expect(view.spaceId).toBe(space);
        if (op !== 'tools.create') expect(view.id).toBe(id);
        if (op === 'tools.config.set') expect(view.config).toEqual({ message: 'configured' });
        if (op === 'tools.config.unset') expect(view.config).toEqual({});
        if (op === 'tools.secrets.unbind') expect(view.secretBindings).toEqual([]);
      }
    });
  }
}

it.each([{}, { value: 'secret', credentialId: randomUUID() }])('keeps the bind XOR strict for route-only bodies %j', async extra => {
  const id = await createFixture();
  const result = await request('POST', `/v2/tools/${id}/secrets/bind`, { expectedVersion: await version(id), inputName: 'key', ...extra });
  expect(result.status).toBe(400);
  expect(result.json.error.code).toBe('invalid_input');
});
it('keeps unknown run fields strict for route-only bodies', async () => {
  const id = await createFixture();
  const result = await request('POST', `/v2/tools/${id}/run`, { source: 'unreviewed code' });
  expect(result.status).toBe(400);
  expect(result.json.error.code).toBe('invalid_input');
});
