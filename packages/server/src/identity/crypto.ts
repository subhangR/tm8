/**
 * Credential + token primitives. Node stdlib only — no dependencies, so this
 * adds nothing to bun.lock and runs identically under the node runtime the
 * server is pinned to.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { PasswordAlgorithm } from './types.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Standard interactive-login parameters (N=16384, r=8 → ~16MB per hash).
 * Measured 0.6-1.0s per derivation on this machine under a heavy multi-agent
 * load; budget for it on the login path and keep it off anything hot. The
 * parameters travel with each verifier, so raising them later does not need a
 * re-hash sweep.
 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

/**
 * Verifier encoding: `scrypt$N$r$p$<salt b64url>$<derived b64url>`.
 * Parameters travel with the hash so they can be raised later and old verifiers
 * keep validating.
 */
export interface PasswordHasher {
  readonly algorithm: PasswordAlgorithm;
  hash(password: string): Promise<string>;
  /** Constant-time. Returns false (never throws) on a malformed stored verifier. */
  verify(password: string, stored: string): Promise<boolean>;
}

export class ScryptPasswordHasher implements PasswordHasher {
  readonly algorithm = 'scrypt' as const;

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const derived = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
    return [
      'scrypt',
      SCRYPT.N,
      SCRYPT.r,
      SCRYPT.p,
      salt.toString('base64url'),
      derived.toString('base64url'),
    ].join('$');
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

    let salt: Buffer;
    let expected: Buffer;
    try {
      salt = Buffer.from(parts[4]!, 'base64url');
      expected = Buffer.from(parts[5]!, 'base64url');
    } catch {
      return false;
    }
    if (expected.length === 0) return false;

    let derived: Buffer;
    try {
      derived = await scrypt(password, salt, expected.length, { N, r, p, maxmem: SCRYPT.maxmem });
    } catch {
      return false;
    }
    return timingSafeEqual(derived, expected);
  }
}

/**
 * A verifier for a password that can never match, used to spend the same work
 * on an unknown login as on a known one. Without it, "no such account" returns
 * in microseconds and "wrong password" in ~100ms, which enumerates accounts.
 */
export const UNMATCHABLE_VERIFIER =
  'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** sha256 hex. What lands in `auth_sessions.token_hash`; the secret itself never persists. */
export function hashToken(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Bearer token wire format: `tm8s_<sessionId>.<secret>`.
 *
 * The session id rides along so verification is a single indexed lookup rather
 * than a scan, and the secret is what gets hashed. Splitting on the LAST `.`
 * would be wrong — uuids contain no dots, but ids are opaque, so we split on
 * the first `.` after the prefix and treat everything after it as the secret.
 */
export const TOKEN_PREFIX = 'tm8s_';

export interface ParsedToken {
  sessionId: string;
  secret: string;
}

export function formatToken(sessionId: string, secret: string): string {
  return `${TOKEN_PREFIX}${sessionId}.${secret}`;
}

/** Returns null for anything that is not a well-formed tm8 token. */
export function parseToken(token: string): ParsedToken | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const body = token.slice(TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot <= 0 || dot === body.length - 1) return null;
  return { sessionId: body.slice(0, dot), secret: body.slice(dot + 1) };
}

export function generateSecret(): string {
  return randomBytes(32).toString('base64url');
}
