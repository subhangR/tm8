import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { loadConfig } from '../../src/http/config.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { Directory } from '../../../../apps/control-plane/src/directory.mjs';
import { migrate, bootstrapAdmin } from '../../../../apps/control-plane/src/migrate.mjs';
import { createControlServer } from '../../../../apps/control-plane/src/server.mjs';

vi.setConfig({ hookTimeout: 180000, testTimeout: 30000 });
describe('two distributed nodes with a separate central directory', () => {
  let centralDb: W1ScratchDatabase, central: ReturnType<typeof createControlServer>, directory: InstanceType<typeof Directory>;
  const databases: W1ScratchDatabase[] = [], nodes: BootstrappedServer[] = [];
  const machine: any[] = [], users: any[] = [], nodeTokens: string[] = [];
  let admin: string, origin: string, dir: string, aliceSpace: string;
  const verified = (email: string) => ({ id: randomUUID(), email, email_confirmed_at: new Date().toISOString(), tm8Method: 'github', tm8GithubSubject: BigInt('0x' + randomUUID().replaceAll('-', '').slice(0,12)).toString() });
  const broker = createServer(async (req, res) => { for await (const _ of req) { /* consume */ } res.end(JSON.stringify({ data: { ready: true } })); });
  async function request(node: number, path: string, body?: unknown, token = nodeTokens[node]) {
    const response = await fetch(`${nodes[node]!.url}${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as any, cookie: response.headers.get('set-cookie') };
  }
  async function code(index: number) {
    const handoff = await directory.issueHandoff(users[index].token);
    return new URLSearchParams(new URL(handoff.redirectUrl).hash.slice(1)).get('code');
  }
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tm8-distributed-'));
    centralDb = await createW1ScratchDatabase('central'); await migrate(centralDb.pool); directory = new Directory(centralDb.pool);
    admin = (await directory.login(verified('admin@example.test'), await bootstrapAdmin(centralDb.pool, 'admin@example.test'))).token;
    central = createControlServer({ directory, auth: {}, publicOrigin: 'http://127.0.0.1:4620' });
    await new Promise<void>(resolve => central.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${central.address().port}`;
    const socket = join(dir, 'broker.sock'); await new Promise<void>(resolve => broker.listen(socket, resolve));
    for (let index = 0; index < 2; index++) {
      const database = await createW1ScratchDatabase(`distributed_${index}`); databases.push(database); database.apply(migrationFiles());
      machine.push(await directory.registerMachine(admin, { name: `Node ${index}`, publicOrigin: `https://node-${index}.example.test`, provider: index ? 'azure' : 'aws', capacity: 1 }));
      const config = loadConfig({ TM8_ENV: 'dev', TM8_BIND: '127.0.0.1', TM8_DATA_DIR: join(dir, String(index)), TM8_DATABASE_URL: database.url,
        TM8_DISTRIBUTED_SYSTEM_FLAG: 'true', TM8_MACHINE_ID: machine[index].id, TM8_MACHINE_CREDENTIAL: machine[index].enrollmentCredential,
        TM8_CONTROL_ORIGIN: origin, TM8_NODE_CONTROL_DATABASE_URL: database.url, TM8_WORKSPACE_BROKER_SOCKET: socket, TM8_WORKSPACE_CPUS: '3' });
      nodes.push(await bootstrap({ config: { ...config, port: 0 } }));
      const email = `user${index}@example.test`;
      users.push(await directory.login(verified(email), (await directory.invite(admin, email, machine[index].id)).code));
    }
  });
  afterAll(async () => {
    for (const node of nodes) { await node.server.close(); await node.db?.end(); }
    if (central) { central.closeAllConnections(); await new Promise<void>(resolve => central.close(resolve)); }
    broker.closeAllConnections(); await new Promise<void>(resolve => broker.close(() => resolve()));
    for (const database of databases) await database.destroy(); await centralDb?.destroy();
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('redeems only on the assigned node, preserves identity and refuses replay', async () => {
    const firstCode = await code(0);
    expect((await request(1, '/v2/auth/handoff', { code: firstCode }, '')).status).toBe(401);
    for (let index = 0; index < 2; index++) {
      const handoffCode = index === 0 ? firstCode : await code(index);
      const response = await request(index, '/v2/auth/handoff', { code: handoffCode }, '');
      expect(response.status, JSON.stringify(response.data)).toBe(200);
      expect(response.cookie).toContain('__Host-tm8-session'); expect(response.cookie).toContain('HttpOnly');
      nodeTokens[index] = response.cookie!.split(';')[0]!.split('=')[1]!;
      expect((await request(index, '/v2/auth/handoff', { code: handoffCode }, '')).status).toBe(401);
      const me = await request(index, '/v2/workspaces/me');
      expect(me.data.data.accountId).toBe(users[index].accountId); expect(me.data.data.limits.cpus).toBe(3);
      expect((await request(index, '/v2/workspaces/me/ensure', {})).status).toBe(200);
    }
    expect((await request(1, '/v2/workspaces/me', undefined, nodeTokens[0])).status).toBe(401);
  });
  it('keeps local sign-up disabled and capacity sticky with no local administrator bootstrap', async () => {
    expect((await request(0, '/v2/auth/login', { username: 'user', password: 'test' }, '')).status).toBe(403);
    expect((await databases[0]!.query('select count(*)::int count from public.accounts where is_owner or is_node_admin'))[0]!.count).toBe(0);
    const email = 'waiting@example.test'; const pending = await directory.login(verified(email), (await directory.invite(admin, email)).code);
    await expect(directory.allocate(pending.token)).rejects.toThrow('waiting_for_capacity');
    const assigned = await directory.allocate(users[0].token);
    expect(assigned.machine_id).toBe(machine[0].id);
  });
  it('authorizes invitations on the node and explicitly refuses cross-machine sharing', async () => {
    const space = await request(0, '/v2/spaces', { name: 'Alice space', clientMutationId: randomUUID() });
    expect(space.status, JSON.stringify(space.data)).toBe(201); aliceSpace = space.data.data.space.id;
    const cross = await request(0, '/v2/workspaces/invitations', { spaceId: aliceSpace, email: 'user1@example.test', clientMutationId: randomUUID() });
    expect(cross.status).toBe(409); expect(cross.data.error.message).toContain('Cross-machine');
    const other = await request(1, '/v2/workspaces/invitations', { spaceId: aliceSpace, email: 'stranger@example.test', clientMutationId: randomUUID() });
    expect(other.status).toBe(403);
    const input = { spaceId: aliceSpace, email: 'new@example.test', clientMutationId: randomUUID() };
    const invite = await request(0, '/v2/workspaces/invitations', input);
    expect(invite.status, JSON.stringify(invite.data)).toBe(200);
    expect((await request(0, '/v2/workspaces/invitations', input)).data.data.url).toBe(invite.data.data.url);
    expect((await request(0, `/v2/workspaces/invitations/${invite.data.data.id}/revoke`, {})).status).toBe(200);
    const invitationCode = new URLSearchParams(new URL(invite.data.data.url).hash.slice(1)).get('invite');
    await expect(directory.login(verified('new@example.test'), invitationCode)).rejects.toThrow('invalid_invitation');
  });
  it('node logout revokes the central session and prevents new handoffs', async () => {
    expect((await request(1, '/v2/auth/logout', {})).status).toBe(200);
    await expect(directory.issueHandoff(users[1].token)).rejects.toThrow('invalid_session');
    expect((await request(1, '/v2/workspaces/me')).status).toBe(401);
  });
  it('accepts a same-machine space invitation and receives capacity changes by heartbeat', async () => {
    await directory.configureMachine(admin, machine[0].id, 2, false);
    const deadline = Date.now() + 25000;
    while ((await databases[0]!.query('select capacity from public.workspace_node'))[0]!.capacity !== 2) {
      if (Date.now() > deadline) throw new Error('Capacity heartbeat did not reach the node');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const response = await request(0, '/v2/workspaces/invitations', { spaceId: aliceSpace, email: 'joined@example.test', clientMutationId: randomUUID() });
    expect(response.status, JSON.stringify(response.data)).toBe(200);
    const code = new URLSearchParams(new URL(response.data.data.url).hash.slice(1)).get('invite');
    const invited = await directory.login(verified('joined@example.test'), code);
    const redirect = await directory.issueHandoff(invited.token);
    const handoffCode = new URLSearchParams(new URL(redirect.redirectUrl).hash.slice(1)).get('code');
    const handoff = await request(0, '/v2/auth/handoff', { code: handoffCode }, '');
    expect(handoff.status, JSON.stringify(handoff.data)).toBe(200);
    const token = handoff.cookie!.split(';')[0]!.split('=')[1]!;
    expect((await request(0, `/v2/spaces/${aliceSpace}`, undefined, token)).status).toBe(200);
    expect((await request(0, '/v2/workspaces/me/ensure', {}, token)).status).toBe(200);
    expect((await directory.allocate(invited.token)).machine_id).toBe(machine[0].id);
  });
  it('central revocation closes an existing event socket and rejects further requests', async () => {
    const socket = new WebSocket(nodes[0]!.url.replace('http:', 'ws:') + '/v2/ws', { headers: { authorization: `Bearer ${nodeTokens[0]}` } });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const closed = new Promise<number>(resolve => socket.once('close', resolve));
    await directory.logout(users[0].token);
    await databases[0]!.query("update public.control_session_links set lease_until=now()-interval '1 second'");
    expect(await closed).toBe(1008);
    expect((await request(0, '/v2/workspaces/me')).status).toBe(401);
  });
});
