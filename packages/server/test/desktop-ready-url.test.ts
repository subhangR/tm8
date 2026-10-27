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
import { afterEach, describe, expect, it, vi } from 'vitest';

import { desktopReadyUrl, report } from '../src/desktop.js';
import { createLaunchCookieIssuer, LAUNCH_REDEEM_PATH_PREFIX, TM8_LAUNCH_COOKIE } from '../src/http/launch-cookie.js';

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
