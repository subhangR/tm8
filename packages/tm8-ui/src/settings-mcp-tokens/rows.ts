/**
 * THE ROW MODEL for Settings → MCP tokens (§10.7) — pure, so the words a row
 * carries can be read and tested without a DOM.
 *
 * Nothing here takes or returns a secret: `McpTokenView` has never carried one
 * (the server's projection builds the row without `token_hash`, and `create`
 * is the only response the plaintext ever appears in).
 */
import type { McpTokenView } from '@tm8/contract';

const DAY_MS = 86_400_000;
/** §10.7's "Expires in 3 days" warning. */
export const EXPIRY_WARNING_DAYS = 3;
/** §10.7's "Unused for 60 days → consider revoking". */
export const STALE_DAYS = 60;

export type McpTokenState = 'live' | 'expiring' | 'expired' | 'revoked';

/** Milliseconds from `now` to `at`; null when `at` is not a usable instant. */
export function msUntil(at: string, now: number): number | null {
  const t = Date.parse(at);
  return Number.isFinite(t) ? t - now : null;
}

/**
 * Whole days left, ROUNDED, never below 1 for a token that is still live.
 *
 * Rounding, not `ceil`: a 90-day token read the moment it was minted is 90
 * days and a few milliseconds out, and `ceil` would call that "in 91 days" —
 * a number the member never chose. Never below 1, because the last few hours
 * of a live token are "in 1 day", not "in 0 days", and whether it has expired
 * is answered by the instant itself (`msUntil`), not by this label.
 */
export function daysUntil(at: string, now: number): number | null {
  const ms = msUntil(at, now);
  return ms === null ? null : Math.max(1, Math.round(ms / DAY_MS));
}

export function tokenState(token: McpTokenView, now: number): McpTokenState {
  if (token.revokedAt) return 'revoked';
  const ms = msUntil(token.expiresAt, now);
  if (ms === null) return 'live';
  if (ms <= 0) return 'expired';
  return ms <= EXPIRY_WARNING_DAYS * DAY_MS ? 'expiring' : 'live';
}

/** 'in 83 days' · 'in 1 day' · 'Expired' · 'Revoked'. Never a raw ISO string. */
export function expiryLabel(token: McpTokenView, now: number): string {
  if (token.revokedAt) return 'revoked';
  const state = tokenState(token, now);
  if (state === 'expired') return 'expired';
  const days = daysUntil(token.expiresAt, now);
  if (days === null) return '';
  return `expires in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * The Spaces cell. `null` is "All my spaces" — the words §10.7's radio uses,
 * so the row and the choice that made it read the same. A listed Space is
 * named where the viewer's membership list knows it, and otherwise counted
 * rather than printed as a bare uuid.
 */
export function spacesLabel(token: McpTokenView, names: ReadonlyMap<string, string>): string {
  if (token.spaceIds === null) return 'All my spaces';
  const known = token.spaceIds.filter((id) => names.has(id));
  const unknown = token.spaceIds.length - known.length;
  const parts = known.map((id) => names.get(id)!);
  if (unknown > 0) parts.push(`${unknown} more`);
  return parts.join(', ');
}

export interface McpTokenWarning {
  tone: 'warn' | 'info';
  text: string;
}

/**
 * The row warnings §10.7 lists, in the order it lists them. A revoked row
 * carries none: its own state is the whole story, and "unused for 60 days" on
 * a token nothing can use any more is noise.
 */
export function tokenWarnings(token: McpTokenView, now: number): McpTokenWarning[] {
  const state = tokenState(token, now);
  if (state === 'revoked') return [];
  const warnings: McpTokenWarning[] = [];
  if (state === 'expiring') {
    const days = daysUntil(token.expiresAt, now) ?? 0;
    warnings.push({ tone: 'warn', text: `Expires in ${days} ${days === 1 ? 'day' : 'days'}.` });
  }
  if (state === 'expired') {
    warnings.push({ tone: 'warn', text: 'Expired. Clients using it are already refused; create a new one.' });
  }
  const since = Date.parse(token.lastUsedAt ?? token.createdAt);
  if (state !== 'expired' && Number.isFinite(since) && now - since >= STALE_DAYS * DAY_MS) {
    warnings.push({
      tone: 'info',
      text: token.lastUsedAt
        ? `Unused for ${STALE_DAYS} days — consider revoking it.`
        : `Never used, and ${STALE_DAYS} days old — consider revoking it.`,
    });
  }
  if (token.missingSpaceIds.length > 0) {
    warnings.push({ tone: 'info', text: 'Some listed Spaces you’re no longer in. This token reaches nothing in those.' });
  }
  return warnings;
}
