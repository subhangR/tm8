import { createHash, randomBytes } from 'node:crypto';
import { PTY_GRANT_PROTOCOL_PREFIX, PTY_WS_PROTOCOL } from '@tm8/contract';

/** Short-lived PTY capability. Distinct from the long-lived tm8s_ auth pass. */
export const PTY_GRANT_PREFIX = 'tm8g_';
/** Back-compatible local name. The value itself lives in the shared contract. */
export const PTY_PROTOCOL = PTY_WS_PROTOCOL;
export { PTY_GRANT_PROTOCOL_PREFIX };

const SECRET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export interface IssuedPtyGrantToken {
  readonly token: string;
  readonly tokenHash: string;
}

export function issuePtyGrantToken(): IssuedPtyGrantToken {
  const token = `${PTY_GRANT_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashPtyGrantToken(token) };
}

export function hashPtyGrantToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function isPtyGrantToken(token: string): boolean {
  return token.startsWith(PTY_GRANT_PREFIX)
    && SECRET_SHAPE.test(token.slice(PTY_GRANT_PREFIX.length));
}

/**
 * Parse the browser's offered protocols. The credential is a request header,
 * never a URL and never the selected protocol in the 101 response.
 */
export function ptyGrantFromProtocolHeader(
  raw: string | string[] | undefined,
): { token: string; protocolOffered: boolean } | null {
  const joined = Array.isArray(raw) ? raw.join(',') : (raw ?? '');
  if (joined.length === 0 || joined.length > 512) return null;
  const offered = joined.split(',').map((part) => part.trim()).filter(Boolean);
  const protocolOffered = offered.includes(PTY_PROTOCOL);
  const carriers = offered.filter((part) => part.startsWith(PTY_GRANT_PROTOCOL_PREFIX));
  if (!protocolOffered || carriers.length !== 1) return null;
  const token = carriers[0]!.slice(PTY_GRANT_PROTOCOL_PREFIX.length);
  return isPtyGrantToken(token) ? { token, protocolOffered } : null;
}
