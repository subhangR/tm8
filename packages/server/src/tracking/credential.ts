/**
 * Where the tracking subsystem's GitHub token comes from.
 *
 * THE DEFECT THIS CLOSES. `resolveGithubToken()` (github.ts) reads
 * `process.env` and nothing else, and it was the ONLY token source for the
 * `GithubClient` in `observer.ts` and `loops.ts`. `public.account_git_credentials`
 * (093) shipped an encrypted per-account GitHub token, `credentials.git.connect`
 * stores one, and `tracking.pr.merge` reads one — but the two POLLERS never
 * learned to. On the node where this was found, a credential had sat stored and
 * unused for nineteen days while the observer made unauthenticated calls and
 * exhausted the host's shared 60-requests-per-hour anonymous budget, at which
 * point every refresh silently stopped (a rate limit halts the tick and records
 * nothing). Measured: authenticated pool 5000/5000 unused, anonymous pool 0/60
 * remaining.
 *
 * THE IDENTITY RULE, STATED ONCE, HERE.
 *
 *   The pollers authenticate as THE NODE'S OWN ACCOUNT — the same loopback
 *   owner whose claims they already run every one of their database writes
 *   under — and as no one else.
 *
 * That is the narrow rule, and its defence is that it invents no authority. The
 * observer already runs under the node owner's claims; `claim_tracking_refresh`
 * (081) only ever hands it requests in spaces `internal.is_space_member` admits
 * for that identity. So reading that same identity's credential widens nothing:
 * the poller can already only refresh what it can already claim, and every
 * GitHub read it makes is charged to, and attributable to, the one account the
 * node acts as.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO — read this before "improving" it.
 *
 *   * It does not fall back to ANOTHER member's credential when the node
 *     account has none. That is the tempting fix on a node where exactly one
 *     person has connected GitHub, and it is an authority escalation wearing a
 *     convenience costume: it would let a background job open a token belonging
 *     to someone who never authorised the node to act as them. Whether a node
 *     may borrow a member's token is a product decision, not a wiring one.
 *   * It does not resolve per-space or per-repo. A space whose repositories only
 *     some other account's token can see stays unhydrated, visibly (see below),
 *     rather than silently borrowing.
 *   * It does not read `requested_by` from the refresh request. Charging each
 *     refresh to the member who asked for it is a coherent alternative rule —
 *     it is what `tracking.pr.merge` does for WRITES, and it is attributable in
 *     the same way — but it requires the poller to assume another identity's
 *     claims to reach `read_account_git_credential`, which is the same
 *     escalation as above by a longer route.
 *
 * When there is no token the pollers keep working, unauthenticated, exactly as
 * before — 60 requests/hour, shared with everything else on the host. The
 * change is that they now SAY so: `source` and `reason` ride into the tick's
 * `detail`, and into the `error` column of any request a rate limit abandons.
 * The nineteen days this went unnoticed are the argument for that.
 *
 * `TM8_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` still win, ahead of the
 * stored credential. Pointing one subsystem at a narrow token without
 * disturbing the box is a real operational need, and an env var that silently
 * lost to a database row would be a nasty surprise for whoever relies on it.
 */
import { DbGitHubCredentialStore } from '../credentials/github-credential-store.js';
import type { Db, DbClaims } from '../db/types.js';
import { resolveGithubToken } from './github.js';

/**
 * Where the token in hand came from. Reported; never a secret.
 *
 * `injected` is the test seam and is named rather than folded into one of the
 * others on purpose: a tick driven with a stub client resolved no credential at
 * all, and reporting that as `env` would put a false sentence into the very
 * `error` column this change exists to make trustworthy.
 */
export type TrackingCredentialSource = 'env' | 'node-account' | 'none' | 'injected';

export interface ResolvedTrackingCredential {
  /** Undefined means "call GitHub anonymously", which is a supported state. */
  readonly token: string | undefined;
  readonly source: TrackingCredentialSource;
  /** The GitHub login the token belongs to. Display metadata, never the token. */
  readonly login?: string;
  /** Why there is no token. Written to logs and to `tracking_refresh_requests.error`. */
  readonly reason?: string;
}

export interface TrackingCredentialOptions {
  db: Db;
  /** The poller's own claims — the node owner's. This IS the identity rule. */
  claims: DbClaims;
  /** Where `.git-credential.key` lives. Without it a stored token cannot be opened. */
  dataDir: string | undefined;
  env?: NodeJS.ProcessEnv;
  logger?: { warn?: (message: string, fields?: Record<string, unknown>) => void };
}

/** A one-line summary safe to put in a log line or a database column. */
export function describeTrackingCredential(credential: ResolvedTrackingCredential): string {
  if (credential.source === 'env') return 'authenticated from the environment';
  if (credential.source === 'node-account') {
    return `authenticated as the node account's GitHub login ${credential.login ?? 'unknown'}`;
  }
  if (credential.source === 'injected') return 'a GitHub client was supplied directly, so no credential was resolved';
  return `UNAUTHENTICATED (${credential.reason ?? 'no credential'}) — anonymous GitHub allows 60 requests/hour for the whole host`;
}

/**
 * NEVER THROWS. A poller that dies because a credential is unreadable stops
 * refreshing everything, which is strictly worse than refreshing anonymously
 * and saying why — and "unreadable" includes an operator rotating the key file
 * out from under a stored token, which must not take the node's tracking down.
 */
export async function resolveTrackingCredential(
  options: TrackingCredentialOptions,
): Promise<ResolvedTrackingCredential> {
  const fromEnv = resolveGithubToken(options.env ?? process.env);
  if (fromEnv) return { token: fromEnv, source: 'env' };

  if (!options.dataDir) {
    return {
      token: undefined,
      source: 'none',
      reason: 'no data directory is configured, so the credential key cannot be opened',
    };
  }

  try {
    const store = new DbGitHubCredentialStore({
      db: options.db,
      dataDir: options.dataDir,
      ...(options.logger ? { logger: options.logger } : {}),
    });
    const credential = await store.resolve(options.claims);
    if (!credential) {
      return {
        token: undefined,
        source: 'none',
        reason: 'the node account has no stored GitHub credential — connect one as the node owner, or set TM8_GITHUB_TOKEN',
      };
    }
    return { token: credential.token, source: 'node-account', login: credential.login };
  } catch (error) {
    // `DbGitHubCredentialStore.resolve` has already logged the decrypt failure
    // without the ciphertext. Everything else here is a database error, which is
    // transient far more often than not.
    options.logger?.warn?.('tracking: stored GitHub credential could not be resolved', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
    return {
      token: undefined,
      source: 'none',
      reason: `the stored GitHub credential could not be read (${
        error instanceof Error ? error.message : 'unknown error'
      })`,
    };
  }
}
