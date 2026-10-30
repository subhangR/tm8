/**
 * The one status badge for an agent credential: the word and the kit `Pill`
 * tone. Expiry is a health axis over a positive connection, not a fifth
 * `ConnectionVerdict` — a stale login is still stored and still connected,
 * but an agent launched with it will fail, so the badge says Expired.
 *
 * Any surface that shows a credential's state (Settings, Home, the credential
 * entity page) reads it here, so the words and colours cannot drift.
 */
import type { CredentialConnectionView } from '@tm8/contract';
import type { PillTone } from '../kit/Pill';
import { verdictOf, type ConnectionVerdict } from './port';

export type CredentialBadgeWord = 'Connected' | 'Expired' | 'Not connected' | 'Unknown' | 'Unavailable';

export interface CredentialBadge {
  verdict: ConnectionVerdict;
  word: CredentialBadgeWord;
  tone: PillTone;
  /** Connected, but recorded as stale or revoked: Reconnect is the next step. */
  expired: boolean;
}

export function isConnectedVerdict(verdict: ConnectionVerdict): boolean {
  return verdict === 'connected-named' || verdict === 'connected-unnamed';
}

export function credentialBadgeOf(
  entry: Pick<CredentialConnectionView, 'provider' | 'connected' | 'login' | 'status'>,
  gitCredentialStore: 'present' | 'absent',
): CredentialBadge {
  const verdict = verdictOf(entry, gitCredentialStore);
  if (verdict === 'unknown') return { verdict, word: 'Unknown', tone: 'info', expired: false };
  if (verdict === 'unavailable') return { verdict, word: 'Unavailable', tone: 'block', expired: false };
  if (verdict === 'disconnected') return { verdict, word: 'Not connected', tone: 'idle', expired: false };
  // A null status is the pre-status node shape: absence is not staleness.
  if (entry.status === 'stale' || entry.status === 'revoked') {
    return { verdict, word: 'Expired', tone: 'wait', expired: true };
  }
  return { verdict, word: 'Connected', tone: 'run', expired: false };
}
