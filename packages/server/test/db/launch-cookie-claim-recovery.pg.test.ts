/**
 * W2 / K4 — AN UNCLAIMED NODE STAYS CLAIMABLE WITH THE LAUNCH COOKIE REQUIRED.
 *
 * With `TM8_AUTO_OWNER_COOKIE=required` (the default), nobody can hold the
 * launch cookie before the node is claimed: `auth.launch` needs the owner's
 * human session, and the owner has no credential yet. So the loopback owner
 * arm is closed on an unclaimed node, and `auth.claim.reissue`, which rides
 * that arm, is unreachable before the claim. That is BY DESIGN (decision 34;
 * option C, #850, closes gap (c)).
 *
 * This file pins the way in that remains: the `setup-token` file the boot
 * path writes at 0600. A restart reprints the SAME live token rather than
 * rotating it, and the token from the file claims the node over the
 * credential-free `auth.claim`. Each refusal is paired with the positive it
 * could be mistaken for.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { loadConfig } from '../../src/http/config.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let database: W1ScratchDatabase;
let dataDir: string;
let node: BootstrappedServer | undefined;

async function boot(): Promise<BootstrappedServer> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The default under test: nothing in the ambient env may switch it off.
  delete env.TM8_AUTO_OWNER_COOKIE;
  const configured = loadConfig({
    ...env,
    TM8_BIND: '127.0.0.1',
    TM8_PORT: '4610',
    TM8_NODE_MODE: 'single',
    TM8_DATABASE_URL: database.url,
    TM8_DATA_DIR: dataDir,
    TM8_DISABLE_AUTO_OWNER: '0',
  });
  expect(configured.autoOwnerCookie ?? 'required').toBe('required');
  return bootstrap({ config: { ...configured, port: 0 } });
}

async function stop(): Promise<void> {
  await node?.server.close();
  await node?.db?.end();
  node = undefined;
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; bearer?: string } = {},
): Promise<{ status: number; body: { data?: Record<string, unknown>; error?: { code: string } } }> {
  const response = await fetch(new URL(path, node!.url), {
    method,
    headers: {
      [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() as never };
}

async function setupTokenFile(): Promise<{ token: string; mode: number }> {
  const path = join(dataDir, 'setup-token');
  const [raw, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  return { token: raw.trim(), mode: info.mode & 0o777 };
}

describe('W2: an unclaimed node with the launch cookie required is claimed through setup-token', () => {
  let firstToken: string;

  beforeAll(async () => {
    database = await createW1ScratchDatabase('w2_claim_recovery');
    database.apply(migrationFiles());
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-w2-claim-'));
    node = await boot();
  });

  afterAll(async () => {
    await stop();
    await database?.destroy();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it('boot wrote the live claim token to <dataDir>/setup-token at 0600', async () => {
    const file = await setupTokenFile();
    expect(file.token.startsWith('tm8c_')).toBe(true);
    expect(file.mode).toBe(0o600);
    firstToken = file.token;
  });

  it('the node reports itself UNCLAIMED over the credential-free status read', async () => {
    const status = await call('GET', '/v2/auth/claim');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ claimed: false });
  });

  it('a loopback caller with no token and no cookie is anonymous, so reissue is unreachable pre-claim', async () => {
    const session = await call('GET', '/v2/auth/session');
    expect(session.status).toBe(401);
    expect(session.body.error?.code).toBe('unauthenticated');
    const reissue = await call('POST', '/v2/auth/claim/reissue', { body: {} });
    expect(reissue.status).toBeGreaterThanOrEqual(400);
    expect(['unauthenticated', 'forbidden']).toContain(reissue.body.error?.code);
    // Refused BEFORE minting: the file still holds the live token.
    expect((await setupTokenFile()).token).toBe(firstToken);
  });

  it('a restart reprints the SAME live token rather than rotating it', async () => {
    await stop();
    node = await boot();
    const file = await setupTokenFile();
    expect(file.token).toBe(firstToken);
    expect(file.mode).toBe(0o600);
  });

  it('a wrong token does not claim, and does not burn the real one', async () => {
    const wrong = await call('POST', '/v2/auth/claim', {
      body: { token: 'tm8c_not-the-real-one', username: 'mallory', password: 'a-real-password-8+' },
    });
    expect(wrong.body.error?.code).toBe('unauthenticated');
  });

  it('positive — the token from the file claims the node, and the claim signs the owner in', async () => {
    const claimed = await call('POST', '/v2/auth/claim', {
      body: { token: firstToken, username: 'amber', password: 'a-real-password-8+' },
    });
    expect(claimed.status).toBe(200);
    const token = claimed.body.data?.token as string;
    expect(token.startsWith('tm8s_')).toBe(true);
    expect(claimed.body.data?.account).toMatchObject({ isOwner: true, isNodeAdmin: true });

    const session = await call('GET', '/v2/auth/session', { bearer: token });
    expect(session.status).toBe(200);
    expect(session.body.data).toMatchObject({ authKind: 'bearer', account: { username: 'amber', isOwner: true } });

    const status = await call('GET', '/v2/auth/claim');
    expect(status.body.data).toMatchObject({ claimed: true });
  });
});
