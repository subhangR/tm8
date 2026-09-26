/**
 * DECISION 34 under owner decision L1 — the launch cookie from day one, for
 * BROWSERS.
 *
 * D34's "a local agent is never the owner" is superseded by owner decision L1
 * (form 01a0df1e, plan W2 L1, #847): a loopback PROCESS with no token and no
 * browser marker stays the owner, exactly as before W2; only a loopback
 * BROWSER needs the launch cookie. For each mode that keeps the loopback owner
 * arm (`personal`, `peer`), a real node booted with an UNTOUCHED cookie setting
 * (nothing in the env may switch it off) is walked unclaimed → claimed, over
 * the production HTTP boundary:
 *
 * - DAY ONE: the default config requires the launch cookie, before any claim
 *   and before any mode choice.
 * - A BROWSER NEEDS THE COOKIE: a browser-shaped loopback request with no
 *   cookie, or with a cookie it made up, is anonymous on an unclaimed node AND
 *   on a claimed one.
 * - L1 PAIR: the same request with no browser marker (a local process) is the
 *   owner, matching #847's pin (cross-space-token "L1 local access",
 *   launch-cookie-claim-recovery "L1 pair").
 * - POSITIVE: the cookie `tm8 open` sets (minted by the owner's session,
 *   redeemed from loopback) makes the browser the owner.
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
    options: { body?: unknown; bearer?: string; cookie?: string; browser?: boolean } = {},
  ): Promise<Reply> {
    const response = await fetch(new URL(path, node.url), {
      method,
      headers: {
        [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        // A browser marker (plan W2 L1): any one puts the request on the browser path.
        ...(options.browser ? { 'sec-fetch-site': 'same-origin' } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    return { status: response.status, body: await response.json() as never };
  }

  /** A loopback BROWSER without the real cookie: none at all, or one it made up. */
  async function expectCookielessBrowserIsAnonymous(): Promise<void> {
    const forged = `${TM8_LAUNCH_COOKIE}=v1.${Math.floor(Date.now() / 1000)}.${'A'.repeat(43)}`;
    for (const cookie of [undefined, forged]) {
      const session = await call('GET', '/v2/auth/session', { cookie, browser: true });
      expect(session.status).toBe(401);
      expect(session.body.error?.code).toBe('unauthenticated');
      const spaces = await call('GET', '/v2/spaces', { cookie, browser: true });
      expect(spaces.status).toBe(401);
      const launch = await call('POST', '/v2/auth/launch', { cookie, browser: true });
      expect(launch.status).toBe(401);
    }
  }

  /** The L1 pair: the same reads with no browser marker, no token and no cookie are the local owner. */
  async function expectLocalProcessIsOwner(): Promise<void> {
    expect((await call('GET', '/v2/auth/session')).status).toBe(200);
    expect((await call('GET', '/v2/spaces')).status).toBe(200);
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

  it(`D34 x L1 (${mode}, unclaimed): a browser without the real cookie is anonymous; a local process is the owner`, async () => {
    expect((await call('GET', '/v2/auth/claim')).body.data).toMatchObject({ claimed: false });
    await expectCookielessBrowserIsAnonymous();
    await expectLocalProcessIsOwner();
  });

  it(`D34 (${mode}): the setup token claims the node and signs the owner in`, async () => {
    const token = (await readFile(join(dataDir, 'setup-token'), 'utf8')).trim();
    const claimed = await call('POST', '/v2/auth/claim', { body: { token, username: 'owner', password: PASSWORD } });
    expect(claimed.status).toBe(200);
    ownerToken = claimed.body.data?.token as string;
    expect(claimed.body.data?.account).toMatchObject({ isOwner: true });
  });

  it(`D34 x L1 (${mode}, claimed): a browser without the real cookie is still anonymous; a local process is the owner`, async () => {
    expect((await call('GET', '/v2/auth/claim')).body.data).toMatchObject({ claimed: true });
    await expectCookielessBrowserIsAnonymous();
    await expectLocalProcessIsOwner();
    const local = await call('GET', '/v2/auth/session');
    expect(local.body.data).toMatchObject({ account: { username: 'owner', isOwner: true } });
  });

  it(`D34 positive (${mode}): the cookie tm8 open sets makes the loopback browser the owner`, async () => {
    const minted = await call('POST', '/v2/auth/launch', { bearer: ownerToken });
    expect(minted.status).toBe(200);
    const redeemed = await fetch(minted.body.data?.url as string, { redirect: 'manual' });
    await redeemed.arrayBuffer();
    expect(redeemed.status).toBe(303);
    const cookie = redeemed.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie.startsWith(`${TM8_LAUNCH_COOKIE}=`)).toBe(true);

    const session = await call('GET', '/v2/auth/session', { cookie, browser: true });
    expect(session.status).toBe(200);
    expect(session.body.data).toMatchObject({ account: { username: 'owner', isOwner: true } });
    expect((await call('GET', '/v2/spaces', { cookie, browser: true })).status).toBe(200);
  });
});
