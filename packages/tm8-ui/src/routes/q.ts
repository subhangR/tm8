/**
 * `q` codec v1 (LLD §6, SPEC-FINAL §4.2.4).
 *
 * `q = base64url(JSON)` of `{ v: 1, filters?, sortBy?, groupBy? }` — a strict
 * subset of `CollectionQuery` (no `kinds`: the slug fixes the kind; no
 * limit/cursor: those never belong in a URL). An unknown `v` is treated as
 * UNPARSEABLE and discarded atomically — the version byte is what lets the
 * dossier supersede this codec later without breaking old links.
 */
import type { QValue } from './types';

const SORT_KEYS = new Set(['activityAt_desc', 'createdAt_desc', 'position', 'dueDate', 'priority']);

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
    value.filters = candidate.filters as QValue['filters'];
  }
  if (candidate.sortBy !== undefined) {
    if (typeof candidate.sortBy !== 'string' || !SORT_KEYS.has(candidate.sortBy)) return null;
    value.sortBy = candidate.sortBy as QValue['sortBy'];
  }
  if (candidate.groupBy !== undefined) {
    const groupBy = candidate.groupBy;
    if (typeof groupBy !== 'string') return null;
    if (groupBy !== 'workStatus' && groupBy !== 'assignee' && !groupBy.startsWith('axis:')) return null;
    value.groupBy = groupBy as QValue['groupBy'];
  }
  return value;
}
