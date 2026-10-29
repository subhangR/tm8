/**
 * devices.* over the REAL server (TM8 Mobile S1, migration 392): bootstrap on
 * an ephemeral port against a scratch database on the staging cluster, real
 * bearer tokens, the real router (catalog binding, INPUT_SCHEMAS validation,
 * the human guard, the wire-error log) and the real auth.logout.
 *
 * What it proves for the security pass:
 *   · the push token is in no response body and in no console line the node
 *     writes while registering, rotating, refusing or unregistering (ac3);
 *   · another member gets 404 on update and "nothing to unregister" (ac1);
 *   · signing out with auth.logout ends the device, with no call to
 *     devices.unregister.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DeviceWriteResultSchema,
  DevicesUnregisterResultSchema,
  TM8_CLIENT_HEADER,
  TM8_CLIENT_HEADER_VALUE,
} from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';

import { createDb } from '../../src/db/index.js';
import type { Db } from '../../src/db/types.js';
import { loadConfig } from '../../src/http/config.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const ANA = 'devices-http-ana';
const BEN = 'devices-http-ben';
/** Every token carries this marker, so a log line holding any part of one is found. */
const MARK = 's1http';

let database: W1ScratchDatabase;
let db: Db;
let server: BootstrappedServer;
let dataDir: string;
const bearer: Record<string, string> = {};
const bearerAccount: Record<string, string> = {};
const console$: MockInstance[] = [];

function token(n: number): string {
  return `ExponentPushToken[${MARK}${String(n).padStart(4, '0')}abcdefghij]`;
}

async function mint(identity: string): Promise<string> {
  const secret = generateSecret();
  const row = await db.tx({ identityId: identity, authKind: 'cli', requestId: `devices-http-${identity}` }, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      bearerAccount[identity], hashToken(secret), 'cli',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'TM8 Mobile · test',
    ]));
  return formatToken(row.id, secret);
}
async function call(
  who: string,
  method: 'POST' | 'PUT' | 'DELETE',
  path: string,
  body: unknown,
): Promise<{ status: number; text: string; json: any }> {
  const response = await fetch(new URL(path, server.url), {
    method,
    headers: {
      [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
      authorization: `Bearer ${bearer[who]}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  return { status: response.status, text, json: parsed && 'data' in parsed ? parsed.data : parsed };
}

/** Everything the node wrote through console since the spies went on. */
function logged(): string {
  return console$.flatMap((spy) => spy.mock.calls.map((args) => args.map(String).join(' '))).join('\n');
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('devices_http');
  database.apply(migrationFiles());
  db = createDb(database.url);
  await database.transaction(async (c) => {
    await c.query('set local role tm8_graph_owner');
    // bootstrap resolves the node owner by its is_owner flag; ANA and BEN stay plain members.
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ('devices-http-owner', 'Owner')`);
    await c.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ('devices-http-owner', 'devices-http-owner', 'Owner', true, true)`,
    );
    for (const identity of [ANA, BEN]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const row = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name) values ($1, $1, $1) returning id::text`,
        [identity],
      );
      bearerAccount[identity] = row.rows[0]!.id;
    }
  });
  bearer[ANA] = await mint(ANA);
  bearer[BEN] = await mint(BEN);
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-devices-http-'));
  const configured = loadConfig({
    ...process.env,
    TM8_BIND: '127.0.0.1',
    TM8_PORT: '4610',
    TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url,
    TM8_DATA_DIR: dataDir,
    TM8_DISABLE_AUTO_OWNER: '1',
  });
  server = await bootstrap({ config: { ...configured, port: 0 } });
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    console$.push(vi.spyOn(console, method));
  }
}, 300_000);

afterAll(async () => {
  for (const spy of console$) spy.mockRestore();
  await server?.server.close();
  await server?.db?.end();
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

describe('devices over HTTP', () => {
  let deviceId = '';
  let version = 0;

  it('register answers {deviceId, device} with no token in it', async () => {
    const res = await call(ANA, 'POST', '/v2/devices', {
      clientMutationId: 'devices-http-register-1',
      platform: 'ios', relay: 'expo', token: token(1),
      appVersion: '1.0.0 (42)', locale: 'en-US', label: 'TM8 Mobile · iPhone',
    });
    expect(res.status).toBe(200);
    const result = DeviceWriteResultSchema.parse(res.json);
    expect(result.device).toMatchObject({ platform: 'ios', relay: 'expo', previews: 'sender', version: 1 });
    expect(res.text).not.toContain(MARK);
    deviceId = result.deviceId;
    version = result.device.version;
  });

  it('update rotates the token and changes previews; the answer carries neither token', async () => {
    const res = await call(ANA, 'PUT', `/v2/devices/${deviceId}`, {
      clientMutationId: 'devices-http-update-1', expectedVersion: version,
      token: token(2), previews: 'none', quietUntil: '2026-10-30T07:00:00Z',
    });
    expect(res.status).toBe(200);
    const result = DeviceWriteResultSchema.parse(res.json);
    expect(result.device).toMatchObject({ previews: 'none', version: version + 1 });
    expect(result.device.quietUntil).not.toBeNull();
    expect(res.text).not.toContain(MARK);
    version = result.device.version;
  });

  it('refuses a malformed token and a stale version without echoing the token', async () => {
    const bad = `ExponentPushToken[${MARK} has a space]`;
    const malformed = await call(ANA, 'POST', '/v2/devices', {
      clientMutationId: 'devices-http-register-bad', platform: 'ios', relay: 'expo', token: bad,
      appVersion: '1.0.0', locale: 'en', label: 'x',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.json.error.code).toBe('invalid_input');
    expect(malformed.text).not.toContain(MARK);
    const stale = await call(ANA, 'PUT', `/v2/devices/${deviceId}`, {
      clientMutationId: 'devices-http-update-stale', expectedVersion: version + 9, token: token(3),
    });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('version_conflict');
    expect(stale.text).not.toContain(MARK);
  });

  it('another member gets 404 on update and nothing to unregister (ac1)', async () => {
    const update = await call(BEN, 'PUT', `/v2/devices/${deviceId}`, {
      clientMutationId: 'devices-http-ben-update', expectedVersion: version, previews: 'full',
    });
    expect(update.status).toBe(404);
    const removal = await call(BEN, 'DELETE', `/v2/devices/${deviceId}`, { clientMutationId: 'devices-http-ben-delete' });
    expect(removal.status).toBe(200);
    expect(DevicesUnregisterResultSchema.parse(removal.json)).toEqual({ deviceId, unregistered: false });
  });

  it('unregister removes the caller’s own device, once', async () => {
    const first = await call(ANA, 'DELETE', `/v2/devices/${deviceId}`, { clientMutationId: 'devices-http-delete-1' });
    expect(DevicesUnregisterResultSchema.parse(first.json)).toEqual({ deviceId, unregistered: true });
    const again = await call(ANA, 'DELETE', `/v2/devices/${deviceId}`, { clientMutationId: 'devices-http-delete-2' });
    expect(DevicesUnregisterResultSchema.parse(again.json)).toEqual({ deviceId, unregistered: false });
  });

  it('auth.logout ends the sign-in and its device, with no devices.unregister call', async () => {
    const res = await call(BEN, 'POST', '/v2/devices', {
      clientMutationId: 'devices-http-register-ben', platform: 'android', relay: 'expo', token: token(4),
      appVersion: '1.0.0', locale: 'de', label: 'TM8 Mobile · Pixel',
    });
    expect(res.status).toBe(200);
    const benDevice = DeviceWriteResultSchema.parse(res.json).deviceId;
    const count = async () => (await database.query<{ n: string }>(
      'select count(*)::text n from public.devices where id = $1', [benDevice]))[0]!.n;
    expect(await count()).toBe('1');
    const logout = await call(BEN, 'POST', '/v2/auth/logout', {});
    expect(logout.status).toBeLessThan(300);
    expect(await count()).toBe('0');
  });

  it('wrote no token, hash or marker to any console line (ac3)', () => {
    const lines = logged();
    // Control: the capture is live — the refusals above were logged.
    expect(lines).toContain('invalid_input');
    expect(lines).not.toContain(MARK);
    expect(lines).not.toMatch(/ExponentPushToken\[/);
  });
});
