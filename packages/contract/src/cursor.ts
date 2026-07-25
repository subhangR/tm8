/**
 * Keyset cursor helpers (DEV-5, 04 §3).
 *
 * Every list is ordered by a keyset — `(uuidv7 id)` or `(sortValues…, id)`.
 * The wire cursor is an opaque base64url string of `{ v: 2, k: [...] }`,
 * version-tagged so stale/foreign cursors are rejected cleanly
 * (`400 invalid_cursor`), never misinterpreted. `nextCursor: null` ⇔ exhausted.
 */
import { CollabError } from './contract.js';

export const CURSOR_VERSION = 2 as const;

export type KeysetValue = string | number | null;

export interface KeysetCursor {
  v: typeof CURSOR_VERSION;
  /** `[...lastSortValues, lastId]` — the last row of the previous page. */
  k: KeysetValue[];
}

function toBase64Url(s: string): string {
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(s, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return typeof Buffer !== 'undefined'
    ? Buffer.from(b64, 'base64').toString('utf8')
    : decodeURIComponent(escape(atob(b64)));
}

/** Encode the keyset of the last row of a page into an opaque wire cursor. */
export function encodeCursor(keys: KeysetValue[]): string {
  if (keys.length === 0) throw new CollabError('invalid_input', 'encodeCursor: keyset must not be empty');
  const cursor: KeysetCursor = { v: CURSOR_VERSION, k: keys };
  return toBase64Url(JSON.stringify(cursor));
}

/**
 * Decode a wire cursor. Throws `CollabError('invalid_cursor')` on anything
 * malformed, offset-shaped, wrong-version, or structurally wrong — a bad
 * cursor is a client error, never a silent page-1 restart.
 */
export function decodeCursor(cursor: string): KeysetCursor {
  const fail = (why: string): never => {
    throw new CollabError('invalid_cursor', `invalid cursor: ${why}`);
  };
  if (typeof cursor !== 'string' || cursor.length === 0) fail('empty');
  if (/^off:/.test(cursor) || /^\d+$/.test(cursor)) fail('offset cursors are not part of the contract (DEV-5)');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(cursor));
  } catch {
    return fail('not base64url JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail('not an object');
  const c = parsed as Record<string, unknown>;
  if (c.v !== CURSOR_VERSION) return fail(`unsupported version ${String(c.v)}`);
  if (!Array.isArray(c.k) || c.k.length === 0) return fail('missing keyset');
  for (const v of c.k) {
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') return fail('keyset values must be string|number|null');
  }
  return { v: CURSOR_VERSION, k: c.k as KeysetValue[] };
}

/** True if `s` decodes as a valid v2 keyset cursor. */
export function isKeysetCursor(s: string): boolean {
  try {
    decodeCursor(s);
    return true;
  } catch {
    return false;
  }
}
