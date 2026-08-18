/**
 * `q` codec v1 (LLD §6, SPEC-FINAL §4.2.4).
 *
 * `q = base64url(JSON)` of `{ v: 1, filters?, sortBy?, groupBy? }` — a strict
 * subset of `CollectionQuery` (no `kinds`: the slug fixes the kind; no
 * limit/cursor: those never belong in a URL). An unknown `v` is treated as
 * UNPARSEABLE and discarded atomically — the version byte is what lets the
 * dossier supersede this codec later without breaking old links.
 *
 * ## PHASE 9 — `workStatus` LINKS STILL WORK, and they are translated here
 *
 * The vocabulary sweep renamed `CollectionQuery.filters.workStatus` to
 * `filters.status` and the `groupBy` literal with it. That is a change to the
 * VOCABULARY OF v1, not a new codec version, so `v` stays 1 and this decoder
 * accepts both spellings and emits the new one.
 *
 * A link is the one place the old word can still ARRIVE from, because a URL
 * outlives the build that wrote it. Without this, an old link degraded two
 * ways and both were worse than they look: an old `groupBy` failed the
 * validation below and discarded the WHOLE `q` atomically — losing the user's
 * filters and sort as well — and an old `filters` key sailed through
 * unvalidated into a `.strict()` server schema, turning a bookmark into a
 * REFUSED read rather than a degraded one.
 *
 * This is a migration shim, not a second live sense of the word: nothing
 * WRITES `workStatus` any more, and `encodeQ` emits only the new spelling, so
 * a translated link normalises itself the first time the URL is rewritten.
 */
import type { QValue } from './types';

const SORT_KEYS = new Set(['activityAt_desc', 'createdAt_desc', 'position', 'dueDate', 'priority']);

/** The pre-phase-9 spelling of `filters.status` / `groupBy: 'status'`. */
const LEGACY_STATUS_KEY = 'workStatus';

/**
 * Move a legacy `workStatus` filter onto `status`, leaving everything else
 * alone. An explicit `status` in the same payload WINS — a link carrying both
 * was written by a newer build, and the new key is the one it meant.
 */
function renameLegacyStatus(filters: Record<string, unknown>): Record<string, unknown> {
  if (!(LEGACY_STATUS_KEY in filters)) return filters;
  const { [LEGACY_STATUS_KEY]: legacy, ...rest } = filters;
  return rest.status === undefined && legacy !== undefined ? { ...rest, status: legacy } : rest;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function encodeQ(value: QValue): string {
  // Serialize only the three carried members, in a stable key order, so the
  // same query always encodes to the same string (idempotent replaceState).
  const payload: Record<string, unknown> = { v: 1 };
  if (value.filters !== undefined) payload.filters = value.filters;
  if (value.sortBy !== undefined) payload.sortBy = value.sortBy;
  if (value.groupBy !== undefined) payload.groupBy = value.groupBy;
  return toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
}

/** Returns `null` for anything unparseable — the caller discards atomically. */
export function decodeQ(raw: string): QValue | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(raw)));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;
  // Unknown version ⇒ unparseable. Never a partial read.
  if (candidate.v !== 1) return null;

  const value: QValue = { v: 1 };
  if (candidate.filters !== undefined) {
    if (typeof candidate.filters !== 'object' || candidate.filters === null) return null;
    value.filters = renameLegacyStatus(candidate.filters as Record<string, unknown>) as QValue['filters'];
  }
  if (candidate.sortBy !== undefined) {
    if (typeof candidate.sortBy !== 'string' || !SORT_KEYS.has(candidate.sortBy)) return null;
    value.sortBy = candidate.sortBy as QValue['sortBy'];
  }
  if (candidate.groupBy !== undefined) {
    const groupBy = candidate.groupBy;
    if (typeof groupBy !== 'string') return null;
    const current = groupBy === LEGACY_STATUS_KEY ? 'status' : groupBy;
    if (current !== 'status' && current !== 'assignee' && !current.startsWith('axis:')) return null;
    value.groupBy = current as QValue['groupBy'];
  }
  return value;
}
