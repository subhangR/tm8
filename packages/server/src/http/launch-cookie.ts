/**
 * The LAUNCH COOKIE (plan 01a0d9eb W2, decision K4).
 *
 * WHAT IT GATES (plan W2 L1, owner form 01a0df1e). The cookie is for BROWSERS
 * only. On a single-mode node a loopback request that carries any browser
 * marker (Origin, Sec-Fetch-Site/-Dest, a Cookie, or Sec-Fetch-Mode navigate)
 * is the auto-owner only with this cookie (`TM8_AUTO_OWNER_COOKIE=required`,
 * the default), so a page the owner did not open through `tm8 open` is not the
 * owner. A local PROCESS with no token and no browser marker is still the
 * node owner, exactly as before W2: the owner's CLI on loopback is unchanged.
 * Plan finding F1 (an agent's `curl 127.0.0.1` acting as the owner) is
 * therefore NOT closed by this cookie; see doc 11 P10.
 *
 * HOW A BROWSER GETS IT. It opens a ONE-TIME URL that `tm8 open`
 * prints; `tm8 open` mints that URL through `auth.launch`, which only the
 * node owner's HUMAN session (`tm8 auth login`, kind `cli`/`browser`) may call.
 * An agent's token is refused there, so an agent never sees the URL, and the
 * cookie itself is HttpOnly: it lives in the browser's jar and nowhere else.
 *
 *   - One-time codes live in THIS PROCESS only, as sha256 hashes, for
 *     `LAUNCH_CODE_TTL_MS`, and are burned on first use. Nothing is written to
 *     disk or the database, and nothing is logged.
 *   - The cookie is `v1.<issuedAt>.<hmac>` under a node-local key file
 *     (`<dataDir>/.launch-cookie.key`, 0600). It survives a restart, expires
 *     after `LAUNCH_COOKIE_MAX_AGE_S`, and deleting the key file revokes every
 *     cookie at once. No cookie is stored anywhere: the server recomputes it.
 *
 * WHAT IT DOES NOT CLOSE (doc 11 P10). A token-less local process is the
 * owner by design (L1), so the cookie is no barrier to a local agent. Even
 * for a browser, an agent running as the same OS user can read the 0600 key
 * file (and the CLI's credential file) and forge a cookie. Sandboxing agents
 * is what closes that, and it is not this change.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

import { loadOrCreateNodeKeyFile } from '../credentials/credential-key.js';

/** `__Host-` forbids Domain and requires Secure + Path=/, like the session cookie. */
export const TM8_LAUNCH_COOKIE = '__Host-tm8-launch';

/** The node-local key the cookie MAC is computed under. Distinct from every other key. */
export const LAUNCH_COOKIE_KEY_FILE = '.launch-cookie.key';

/** The browser path a one-time launch URL points at. Outside `/v2`: it is a page, not an API. */
export const LAUNCH_REDEEM_PATH_PREFIX = '/launch/';

/** A printed launch URL works once, and only for this long. */
export const LAUNCH_CODE_TTL_MS = 5 * 60 * 1000;

/** A redeemed cookie keeps the browser in for 30 days, then `tm8 open` again. */
export const LAUNCH_COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;

/** Outstanding (minted, unredeemed) codes are capped so minting cannot grow memory. */
const MAX_OUTSTANDING_CODES = 64;

const CODE_PREFIX = 'tm8l_';
const COOKIE_VERSION = 'v1';
const MAC_LABEL = 'tm8-launch-cookie';
/** Clock skew tolerated on a cookie's issued-at before it reads as forged. */
const FUTURE_SKEW_S = 300;

export interface LaunchCookieIssuer {
  /** Mint a one-time code. The caller builds the URL; the code is never logged. */
  mintCode(): { code: string; expiresAt: string };
  /** Burn `code` and return the cookie value, or null if it is unknown, used or expired. */
  redeem(code: string): string | null;
  /** True when the request carries a valid, unexpired launch cookie. */
  verify(headers: IncomingHttpHeaders): boolean;
}

/** Read the launch cookie's raw value off a request, or null. */
export function readLaunchCookie(headers: IncomingHttpHeaders): string | null {
  const header = headers.cookie;
  if (header === undefined) return null;
  const raw = Array.isArray(header) ? header.join(';') : header;
  for (const pair of raw.split(';')) {
    const equals = pair.indexOf('=');
    if (equals < 0) continue;
    if (pair.slice(0, equals).trim() !== TM8_LAUNCH_COOKIE) continue;
    const value = pair.slice(equals + 1).trim();
    return value.length > 0 && value.length <= 256 ? value : null;
  }
  return null;
}

/** The `Set-Cookie` value a redemption answers with. */
export function launchCookieHeader(value: string): string {
  return [
    `${TM8_LAUNCH_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    `Max-Age=${LAUNCH_COOKIE_MAX_AGE_S}`,
  ].join('; ');
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface LaunchCookieIssuerOptions {
  /** Test seam. */
  readonly now?: () => number;
}

/** Build the issuer over a 32-byte key. Pure: no I/O. */
export function createLaunchCookieIssuer(
  key: Buffer,
  options: LaunchCookieIssuerOptions = {},
): LaunchCookieIssuer {
  if (key.length < 32) throw new Error('launch cookie key is too short');
  const now = options.now ?? Date.now;
  /** sha256(code) -> expiry (ms). Insertion order is mint order. */
  const codes = new Map<string, number>();

  const mac = (issuedAt: number): string =>
    createHmac('sha256', key).update(`${MAC_LABEL}|${COOKIE_VERSION}|${issuedAt}`).digest('base64url');

  const prune = (): void => {
    const at = now();
    for (const [hash, expiresAt] of codes) {
      if (expiresAt <= at) codes.delete(hash);
    }
    while (codes.size >= MAX_OUTSTANDING_CODES) {
      const oldest = codes.keys().next().value;
      if (oldest === undefined) break;
      codes.delete(oldest);
    }
  };

  return {
    mintCode() {
      prune();
      const code = `${CODE_PREFIX}${randomBytes(32).toString('base64url')}`;
      const expiresAt = now() + LAUNCH_CODE_TTL_MS;
      codes.set(sha256(code), expiresAt);
      return { code, expiresAt: new Date(expiresAt).toISOString() };
    },

    redeem(code) {
      if (!code.startsWith(CODE_PREFIX) || code.length > 128) return null;
      const hash = sha256(code);
      const expiresAt = codes.get(hash);
      // Burned whatever the outcome: a code is tried at most once.
      codes.delete(hash);
      if (expiresAt === undefined || expiresAt <= now()) return null;
      const issuedAt = Math.floor(now() / 1000);
      return `${COOKIE_VERSION}.${issuedAt}.${mac(issuedAt)}`;
    },

    verify(headers) {
      const value = readLaunchCookie(headers);
      if (!value) return false;
      const parts = value.split('.');
      if (parts.length !== 3 || parts[0] !== COOKIE_VERSION) return false;
      const [, issuedRaw, presented] = parts as [string, string, string];
      if (!/^\d{1,12}$/.test(issuedRaw)) return false;
      const issuedAt = Number(issuedRaw);
      const nowS = Math.floor(now() / 1000);
      if (issuedAt > nowS + FUTURE_SKEW_S) return false;
      if (nowS - issuedAt > LAUNCH_COOKIE_MAX_AGE_S) return false;
      return safeEqual(presented, mac(issuedAt));
    },
  };
}

/**
 * Whether a node gets a launch cookie issuer at all: only where the loopback
 * owner arm is live and the cookie is `required`. `server` implies the kill
 * switch (node modes S2), so a Server node never mints a `/launch/` URL, while
 * Personal and Peer keep the desktop window's one-time URL over IPC.
 */
export function wantsLaunchCookie(
  config: { readonly disableAutoOwner?: boolean; readonly autoOwnerCookie?: 'required' | 'off' },
): boolean {
  return config.disableAutoOwner !== true && config.autoOwnerCookie !== 'off';
}

/** Load (creating on first boot) the node's launch cookie key and build the issuer. */
export async function loadLaunchCookieIssuer(dataDir: string): Promise<LaunchCookieIssuer> {
  return createLaunchCookieIssuer(await loadOrCreateNodeKeyFile(dataDir, LAUNCH_COOKIE_KEY_FILE));
}
