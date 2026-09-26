/**
 * DECISION 34 — the launch cookie from day one; a local agent is never the owner.
 *
 * For each mode that keeps the loopback owner arm (`personal`, `peer`), a real
 * node booted with an UNTOUCHED cookie setting (nothing in the env may switch
 * it off) is walked unclaimed → claimed, over the production HTTP boundary:
 *
 * - DAY ONE: the default config requires the launch cookie, so the arm is
 *   closed from the first boot, before any claim and before any mode choice.
 * - NEVER THE OWNER: what a local agent can send on its own (a bare loopback
 *   request, with no token and no cookie, or a cookie it made up) is anonymous
 *   on an unclaimed node AND on a claimed one. The owner's OWN agent and
 *   agent-runtime tokens cannot mint the cookie either (cross-space-token T12).
 * - POSITIVE: the cookie `tm8 open` sets (minted by the owner's human session,
 *   redeemed from loopback) is the owner, so the refusals are not a dead node.
 *
 * Every route here is space-less (`/v2/auth/*`, `/v2/spaces`), so no cell
 * depends on how the auto-owner's claims pin to a space.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';

import { loadConfig } from '../../src/http/config.js';
import { TM8_LAUNCH_COOKIE } from '../../src/http/launch-cookie.js';
import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const PASSWORD = 'a-real-password-8+';

type Reply = { status: number; body: { data?: Record<string, unknown>; error?: { code: string } } };

describe.each(['personal', 'peer'] as const)('decision 34 on a %s node', (mode) => {
  let database: W1ScratchDatabase;
  let dataDir: string;
  let node: BootstrappedServer;
  let ownerToken: string;

  async function call(
    method: string,
    path: string,
    options: { body?: unknown; bearer?: string; cookie?: string } = {},
  ): Promise<Reply> {
    const response = await fetch(new URL(path, node.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json() as never };
  }

  /** What a local agent can send by itself: loopback, no token, no cookie — or a cookie it forged. */
  async function expectAgentIsAnonymous(): Promise<void> {
    const forged = `${TM8_LAUNCH_COOKIE}=v1.${Math.floor(Date.now() / 1000)}.${'A'.repeat(43)}`;
    for (const cookie of [undefined, forged]) {
      const session = await call('GET', '/v2/auth/session', { cookie });
      expect(session.status).toBe(401);
      expect(session.body.error?.code).toBe('unauthenticated');
      const spaces = await call('GET', '/v2/spaces', { cookie });
      expect(spaces.status).toBe(401);
      const launch = await call('POST', '/v2/auth/launch', { cookie });
      expect(launch.status).toBe(401);
    }
  }

  beforeAll(async () => {
    database = await createW1ScratchDatabase(`d34_${mode}`);
    database.apply(migrationFiles());
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-d34-'));
    const env: NodeJS.ProcessEnv = { ...process.env };
    // Day one is the DEFAULT: nothing in the ambient env may switch the cookie off.
    delete env.TM8_AUTO_OWNER_COOKIE;
    const configured = loadConfig({
      ...env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_NODE_MODE: mode,
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: dataDir,
      TM8_DISABLE_AUTO_OWNER: '0',
    });
    expect(configured.nodeMode).toBe(mode);
    node = await bootstrap({ config: { ...configured, port: 0 } });
  });

  afterAll(async () => {
    await node?.server.close();
    await node?.db?.end();
    await database?.destroy();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  it(`D34 day one (${mode}): an untouched config requires the launch cookie`, () => {
    const configured = loadConfig({ TM8_NODE_MODE: mode, TM8_DATA_DIR: dataDir });
    expect(configured.autoOwnerCookie ?? 'required').toBe('required');
  });

  it(`D34 never the owner (${mode}, unclaimed): a local agent's bare or forged request is anonymous`, async () => {
    expect((await call('GET', '/v2/auth/claim')).body.data).toMatchObject({ claimed: false });
    await expectAgentIsAnonymous();
  });

  it(`D34 (${mode}): the setup token claims the node and signs the owner in`, async () => {
    const token = (await readFile(join(dataDir, 'setup-token'), 'utf8')).trim();
    const claimed = await call('POST', '/v2/auth/claim', { body: { token, username: 'owner', password: PASSWORD } });
    expect(claimed.status).toBe(200);
    ownerToken = claimed.body.data?.token as string;
    expect(claimed.body.data?.account).toMatchObject({ isOwner: true });
  });

  it(`D34 never the owner (${mode}, claimed): a local agent's bare or forged request is still anonymous`, async () => {
    expect((await call('GET', '/v2/auth/claim')).body.data).toMatchObject({ claimed: true });
    await expectAgentIsAnonymous();
  });

  it(`D34 positive (${mode}): the cookie tm8 open sets, and only that, makes the loopback caller the owner`, async () => {
    const minted = await call('POST', '/v2/auth/launch', { bearer: ownerToken });
    expect(minted.status).toBe(200);
    const redeemed = await fetch(minted.body.data?.url as string, { redirect: 'manual' });
    await redeemed.arrayBuffer();
    expect(redeemed.status).toBe(303);
    const cookie = redeemed.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie.startsWith(`${TM8_LAUNCH_COOKIE}=`)).toBe(true);

    const session = await call('GET', '/v2/auth/session', { cookie });
    expect(session.status).toBe(200);
    expect(session.body.data).toMatchObject({ account: { username: 'owner', isOwner: true } });
    expect((await call('GET', '/v2/spaces', { cookie })).status).toBe(200);
  });
});
