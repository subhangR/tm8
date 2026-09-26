/**
 * W2 / K4 — the desktop window opens with the launch cookie, not anonymous.
 *
 * With `TM8_AUTO_OWNER_COOKIE=required` the loopback owner needs the launch
 * cookie, and a double-clicked app has no terminal to run `tm8 open` in. The
 * `ready` URL the server hands the shell therefore carries a one-time
 * `/launch/<code>` — a credential until burned, so it must go over IPC only and
 * never reach a log line or stdout.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { desktopReadyUrl, report } from '../src/desktop.js';
import { loadConfig } from '../src/http/config.js';
import {
  createLaunchCookieIssuer,
  LAUNCH_REDEEM_PATH_PREFIX,
  TM8_LAUNCH_COOKIE,
  wantsLaunchCookie,
} from '../src/http/launch-cookie.js';

const ORIGIN = 'http://127.0.0.1:4700';

describe('desktop ready url (W2 / K4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries a one-time launch code the issuer redeems exactly once for a valid cookie', () => {
    const issuer = createLaunchCookieIssuer(randomBytes(32));
    const url = desktopReadyUrl(`${ORIGIN}/`, undefined, issuer);

    expect(url.startsWith(`${ORIGIN}${LAUNCH_REDEEM_PATH_PREFIX}`)).toBe(true);
    const code = decodeURIComponent(url.slice(`${ORIGIN}${LAUNCH_REDEEM_PATH_PREFIX}`.length));
    const cookie = issuer.redeem(code);
    expect(cookie).not.toBeNull();
    expect(issuer.verify({ cookie: `${TM8_LAUNCH_COOKIE}=${cookie}` })).toBe(true);
    // Burned: the same URL does not open a second window as the owner.
    expect(issuer.redeem(code)).toBeNull();
  });

  it('an unclaimed node still opens its claim URL, and mints nothing', () => {
    const mintCode = vi.fn();
    expect(desktopReadyUrl(ORIGIN, `${ORIGIN}/#claim=tok`, { mintCode })).toBe(`${ORIGIN}/#claim=tok`);
    expect(mintCode).not.toHaveBeenCalled();
  });

  it('with the cookie off (no issuer) it is the bare origin', () => {
    expect(desktopReadyUrl(ORIGIN, undefined, undefined)).toBe(ORIGIN);
  });

  it('the launch URL goes over IPC only: nothing is logged or written to stdout/stderr', () => {
    const issuer = createLaunchCookieIssuer(randomBytes(32));
    const spies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
      vi.spyOn(process.stdout, 'write'),
      vi.spyOn(process.stderr, 'write'),
    ];
    const sent: unknown[] = [];
    const original = process.send;
    process.send = ((msg: unknown) => {
      sent.push(msg);
      return true;
    }) as typeof process.send;
    try {
      const url = desktopReadyUrl(ORIGIN, undefined, issuer);
      report({ phase: 'ready', message: 'Ready', url });
      expect(sent).toEqual([{ type: 'tm8:desktop', phase: 'ready', message: 'Ready', url }]);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      process.send = original;
    }
  });
});

/**
 * Node modes S2 on top of W2 / K4: the mode decides whether the desktop window
 * gets a `/launch/` URL at all. Personal and Peer keep the loopback owner arm,
 * so they keep the one-time URL over IPC; an unclaimed node of either still
 * opens its claim URL first (claim once, then the cookie). Server closes the
 * arm, so it builds no issuer and the window opens the bare origin to a
 * sign-in page. `bootstrap` builds the issuer through `wantsLaunchCookie`.
 */
describe('desktop ready url by node mode (node modes S2)', () => {
  let dataDir: string;

  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  const configFor = async (extra: Record<string, string>) => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-desktop-mode-'));
    return loadConfig({ TM8_DATABASE_URL: '', TM8_LAUNCH_BOOTSTRAP: '0', TM8_DATA_DIR: dataDir, ...extra });
  };
  const readyUrl = (wanted: boolean, claimUrl: string | undefined) =>
    desktopReadyUrl(ORIGIN, claimUrl, wanted ? createLaunchCookieIssuer(randomBytes(32)) : undefined);

  for (const mode of ['personal', 'peer', 'single'] as const) {
    it(`${mode}: unclaimed opens the claim URL, claimed opens a one-time /launch/ URL`, async () => {
      const wanted = wantsLaunchCookie(await configFor({ TM8_NODE_MODE: mode }));
      expect(wanted).toBe(true);
      expect(readyUrl(wanted, `${ORIGIN}/#claim=tok`)).toBe(`${ORIGIN}/#claim=tok`);
      expect(readyUrl(wanted, undefined).startsWith(`${ORIGIN}${LAUNCH_REDEEM_PATH_PREFIX}`)).toBe(true);
    });
  }

  it('the default mode (nothing recorded) is Personal and keeps the /launch/ URL', async () => {
    const config = await configFor({});
    expect(config.nodeMode).toBe('personal');
    expect(wantsLaunchCookie(config)).toBe(true);
  });

  for (const mode of ['server', 'multi'] as const) {
    it(`${mode}: no issuer, so the window opens the bare origin (sign in there)`, async () => {
      const wanted = wantsLaunchCookie(await configFor({ TM8_NODE_MODE: mode }));
      expect(wanted).toBe(false);
      expect(readyUrl(wanted, undefined)).toBe(ORIGIN);
    });
  }

  it('the kill switch and TM8_AUTO_OWNER_COOKIE=off each withdraw the issuer in Personal', async () => {
    expect(wantsLaunchCookie(await configFor({ TM8_NODE_MODE: 'personal', TM8_DISABLE_AUTO_OWNER: '1' }))).toBe(false);
    await rm(dataDir, { recursive: true, force: true });
    expect(wantsLaunchCookie(await configFor({ TM8_NODE_MODE: 'personal', TM8_AUTO_OWNER_COOKIE: 'off' }))).toBe(false);
  });
});
