/**
 * The launch cookie issuer (plan W2, K4) and its config switch.
 *
 * Every refusal is paired with the positive it would otherwise be mistaken
 * for, so a test cannot pass because everything is refused.
 */
import { mkdtemp, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/http/config.js';
import {
  createLaunchCookieIssuer,
  LAUNCH_CODE_TTL_MS,
  LAUNCH_COOKIE_KEY_FILE,
  LAUNCH_COOKIE_MAX_AGE_S,
  launchCookieHeader,
  loadLaunchCookieIssuer,
  readLaunchCookie,
  TM8_LAUNCH_COOKIE,
} from '../src/http/launch-cookie.js';

const KEY = randomBytes(32);
const as = (value: string) => ({ cookie: `other=1; ${TM8_LAUNCH_COOKIE}=${value}; more=2` });

function clock(start = 1_800_000_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe('launch codes', () => {
  it('a minted code redeems once into a cookie the same issuer verifies', () => {
    const issuer = createLaunchCookieIssuer(KEY);
    const { code } = issuer.mintCode();
    expect(code.startsWith('tm8l_')).toBe(true);
    const cookie = issuer.redeem(code);
    expect(cookie).not.toBeNull();
    expect(issuer.verify(as(cookie!))).toBe(true);
  });

  it('a code is single-use: the second redemption is null', () => {
    const issuer = createLaunchCookieIssuer(KEY);
    const { code } = issuer.mintCode();
    expect(issuer.redeem(code)).not.toBeNull();
    expect(issuer.redeem(code)).toBeNull();
  });

  it('a code expires after the TTL; positive — just before it, it redeems', () => {
    const t = clock();
    const issuer = createLaunchCookieIssuer(KEY, { now: t.now });
    const late = issuer.mintCode().code;
    const early = issuer.mintCode().code;
    t.advance(LAUNCH_CODE_TTL_MS - 1);
    expect(issuer.redeem(early)).not.toBeNull();
    t.advance(1);
    expect(issuer.redeem(late)).toBeNull();
  });

  it('an unknown, malformed or foreign code redeems nothing', () => {
    const issuer = createLaunchCookieIssuer(KEY);
    const foreign = createLaunchCookieIssuer(randomBytes(32)).mintCode().code;
    for (const code of ['', 'tm8l_', 'tm8l_nope', 'not-a-code', foreign, `tm8l_${'x'.repeat(200)}`]) {
      expect(issuer.redeem(code), code.slice(0, 12)).toBeNull();
    }
  });

  it('outstanding codes are capped: the oldest is evicted first, the newest still redeems', () => {
    const issuer = createLaunchCookieIssuer(KEY);
    const codes = Array.from({ length: 65 }, () => issuer.mintCode().code);
    expect(issuer.redeem(codes[0]!)).toBeNull();
    expect(issuer.redeem(codes[64]!)).not.toBeNull();
  });
});

describe('launch cookie verification', () => {
  it('no cookie, an empty cookie or a different cookie name is not verified', () => {
    const issuer = createLaunchCookieIssuer(KEY);
    const cookie = issuer.redeem(issuer.mintCode().code)!;
    expect(issuer.verify({})).toBe(false);
    expect(issuer.verify({ cookie: `${TM8_LAUNCH_COOKIE}=` })).toBe(false);
    expect(issuer.verify({ cookie: `tm8-launch=${cookie}` })).toBe(false);
    expect(issuer.verify(as(cookie))).toBe(true);
  });

  it('a tampered MAC or issued-at is refused; positive — the untouched value verifies', () => {
    const issuer = createLaunchCookieIssuer(KEY);
    const cookie = issuer.redeem(issuer.mintCode().code)!;
    const [version, issuedAt, mac] = cookie.split('.') as [string, string, string];
    expect(issuer.verify(as(`${version}.${issuedAt}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`))).toBe(false);
    expect(issuer.verify(as(`${version}.${Number(issuedAt) - 1}.${mac}`))).toBe(false);
    expect(issuer.verify(as(`v2.${issuedAt}.${mac}`))).toBe(false);
    expect(issuer.verify(as(cookie))).toBe(true);
  });

  it('a cookie minted under another key is refused (deleting the key file revokes every cookie)', () => {
    const other = createLaunchCookieIssuer(randomBytes(32));
    const cookie = other.redeem(other.mintCode().code)!;
    expect(createLaunchCookieIssuer(KEY).verify(as(cookie))).toBe(false);
    expect(other.verify(as(cookie))).toBe(true);
  });

  it('a cookie older than its max-age is refused; positive — one second younger verifies', () => {
    const t = clock();
    const issuer = createLaunchCookieIssuer(KEY, { now: t.now });
    const cookie = issuer.redeem(issuer.mintCode().code)!;
    t.advance(LAUNCH_COOKIE_MAX_AGE_S * 1000);
    expect(issuer.verify(as(cookie))).toBe(true);
    t.advance(1000);
    expect(issuer.verify(as(cookie))).toBe(false);
  });

  it('the Set-Cookie is __Host-, HttpOnly, Secure, SameSite=Strict, Path=/', () => {
    const header = launchCookieHeader('v1.1.x');
    expect(header.startsWith(`${TM8_LAUNCH_COOKIE}=v1.1.x;`)).toBe(true);
    expect(TM8_LAUNCH_COOKIE.startsWith('__Host-')).toBe(true);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${LAUNCH_COOKIE_MAX_AGE_S}`]) {
      expect(header).toContain(attribute);
    }
    expect(header).not.toMatch(/Domain=/i);
  });

  it('readLaunchCookie finds the pair among others and ignores oversize values', () => {
    expect(readLaunchCookie(as('abc'))).toBe('abc');
    expect(readLaunchCookie(as('x'.repeat(300)))).toBeNull();
    expect(readLaunchCookie({ cookie: 'a=b' })).toBeNull();
  });
});

describe('the node-local key file', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('is created 0600, survives a reload (restart keeps cookies), and another data dir is another key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tm8-launch-key-'));
    dirs.push(dir);
    const first = await loadLaunchCookieIssuer(dir);
    const cookie = first.redeem(first.mintCode().code)!;
    const info = await stat(join(dir, LAUNCH_COOKIE_KEY_FILE));
    expect(info.mode & 0o777).toBe(0o600);

    // A second load in this process is the same key (a restart reads the file).
    expect((await loadLaunchCookieIssuer(dir)).verify(as(cookie))).toBe(true);

    // A fresh data dir is a fresh key: the cookie does not travel.
    const elsewhere = await mkdtemp(join(tmpdir(), 'tm8-launch-key-'));
    dirs.push(elsewhere);
    expect((await loadLaunchCookieIssuer(elsewhere)).verify(as(cookie))).toBe(false);
    await unlink(join(dir, LAUNCH_COOKIE_KEY_FILE));
  });
});

describe('TM8_AUTO_OWNER_COOKIE', () => {
  const base = { TM8_NODE_MODE: 'single' } as NodeJS.ProcessEnv;

  it('defaults to required', () => {
    expect(loadConfig({ ...base }).autoOwnerCookie).toBe('required');
  });

  it('accepts off and required', () => {
    expect(loadConfig({ ...base, TM8_AUTO_OWNER_COOKIE: 'off' }).autoOwnerCookie).toBe('off');
    expect(loadConfig({ ...base, TM8_AUTO_OWNER_COOKIE: 'required' }).autoOwnerCookie).toBe('required');
  });

  it('refuses anything else rather than guessing', () => {
    expect(() => loadConfig({ ...base, TM8_AUTO_OWNER_COOKIE: 'maybe' })).toThrow();
  });
});
