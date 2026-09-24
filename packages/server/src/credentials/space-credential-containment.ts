/**
 * SC-6 — MEMBER CONTAINMENT for space credentials (design 01a0cfa8 §5):
 * "sessions that member launched on space credentials are killed".
 *
 * There is no member-removal operation yet. The plan offered a SQL function
 * (`internal.kill_space_credential_sessions_for_member`) or a TS equivalent;
 * this is the TS equivalent, and no such SQL function exists, because SQL
 * cannot reach a PTY. The lookup is 206's `member_space_credential_sessions`
 * (human-only, node admin / space admin / self), and the kill is this node's
 * PTY host. It is wired into `IdentityService.disableAccount` (every space)
 * and takes a space id for the future removal op (that space only). A member
 * who is gone but whose session survived anyway cannot bring it back: the
 * resume path re-checks membership before it re-points anything (T2).
 *
 * DORMANT until a member-removal or account-disable path is composed.
 * `IdentityServiceImpl` has no production composition, no catalog operation
 * disables an account, and none removes a space member, so nothing in
 * production calls this yet. The composition that adds one of those paths
 * must pass `spaceCredentialContainment`.
 *
 * WHO "LAUNCHED" A SESSION (PLAN v2.1, C2/C3). The key is ONLY
 * `session_space_credentials.launcher_account_id` — the account whose claims
 * wrote the row: the human at a spawn, the minting human under an agent token
 * (A6: an agent-spawned child is its root launcher's), and the RESUMER after a
 * resume re-points it. Never `entities.created_by` → `owner_member_id`, which
 * names the persona's owner: A launching B's teammate is A's session.
 *
 * Consequences of keying on the re-pointed value, kept on purpose:
 *   - C3: once B resumes a session A launched, it is B's. Disabling A leaves it
 *     running; disabling B kills it.
 *   - S4: the repoint is committed BEFORE the PTY starts (so a delete racing
 *     the resume sees the new launcher). If the resume then fails — the PTY
 *     spawn fails, or the M7 re-check refuses — launcher_account_id stays on
 *     the resumer. Disabling the ORIGINAL launcher then does not touch that
 *     session; disabling the resumer does. The resumer is the last account that
 *     authorised a PTY on it, so this is the intended attribution, not a leak.
 *
 * SINGLE-NODE ASSUMPTION (#681 C). `terminate` reaches THIS node's PTY host
 * only. `not_found` means no PTY for that session here. On a single node that
 * is the state asked for: every PTY dies with the server (KillMode=
 * control-group, PtyHostService.ts:585 — the same fact the boot sweep of space
 * secrets relies on, S5), so a row still reading live has no process behind
 * it. On a multi-node deployment the PTY may be alive on another node, which
 * this cannot reach. So unlike SC-3's delete, a `not_found` is NOT reported as
 * terminated: it goes in `notOnThisNodeSessionIds`, and a multi-node build must
 * route those to their node.
 *
 * Best effort after the lookup, as the member Disconnect and SC-3's delete
 * are: the caller has already revoked what it was revoking (the account's
 * tokens), so a failed kill is named in `failures`, never thrown. This module
 * never sees a secret (I5): it reads ids and statuses only.
 *
 * SC-8 — SHARES (`killSharesOf`, migration 210). A SEPARATE question from the
 * one above, and deliberately not folded into it: `killSessionsLaunchedBy`
 * keys on who LAUNCHED (C3 must keep holding), while a share dies with its
 * SHARER — every live session on any of the sharer's revoked shares is
 * killed, whoever launched or resumed it. `revoke_member_shares` revokes the
 * shares and answers those sessions in one call; its authority (node admin,
 * space admin of that space, or the account itself) is in SQL. The SQL
 * lifecycle triggers revoke on disable, member delete, account delete and
 * personal disconnect, so a path that reaches here after them still finds
 * the sessions: the lookup reads every REVOKED share of the account.
 *
 * Callers today: `disableAccount` (every space, a second named step after
 * killSessionsLaunchedBy) and the member Disconnect of a GitHub token or a
 * login (every space, that provider). Un-share and admin remove go through
 * SC-3's delete, which kills by credential.
 *
 *   - Any FUTURE member-removal op MUST call killSharesOf(claims, account,
 *     space) BEFORE it deletes the members row (the members trigger only
 *     revokes; SQL cannot kill a PTY).
 *   - Any FUTURE account-delete op MUST call killSharesOf(claims, account,
 *     null) BEFORE it deletes the account (the FK + orphan trigger only
 *     revoke). No account-delete op exists today.
 */
import type { CredentialContainmentCause } from '@tm8/execution';

import type { DbClaims } from '../db/types.js';
import {
  containmentFailureOf,
  type AgentSessionContainmentPort,
} from './agent-session-containment.js';
import type { DbSpaceCredentialStore, SpaceCredentialProvider } from './space-credential-store.js';

export interface MemberContainmentResult {
  accountId: string;
  /** Null when the containment spanned every space (account disable). */
  spaceId: string | null;
  /** Sessions whose PTY this node killed. */
  terminatedSessionIds: string[];
  /** Recorded live, but no PTY on this node: see SINGLE-NODE ASSUMPTION. */
  notOnThisNodeSessionIds: string[];
  failures: Array<{ sessionId?: string; reason: string }>;
}

/** SC-8: what `killSharesOf` revoked and killed. */
export interface ShareContainmentResult extends MemberContainmentResult {
  provider: SpaceCredentialProvider | null;
  /** Shares this call revoked; ones a trigger already revoked are not listed. */
  revokedCredentialIds: string[];
  /** Share login terminals closed (killed, then stamped finished). */
  closedLoginSessionIds: string[];
}

type ContainmentStore = Pick<DbSpaceCredentialStore, 'memberSessions'> &
  Partial<Pick<DbSpaceCredentialStore, 'revokeMemberShares'>>;

export interface SpaceCredentialMemberContainmentOptions {
  store: ContainmentStore;
  /** Kills the session and records its ending (`SpawnService.containCredentialSession`). */
  agentSessions: AgentSessionContainmentPort;
  /**
   * Closes one login terminal onto a revoked share: kill, then stamp it
   * finished (SC-4's login registry). Absent, open share terminals are
   * reported in `failures` and the pending sweep closes them.
   */
  closeLogin?: (claims: DbClaims, workSessionId: string) => Promise<'closed' | 'kill_failed'>;
}

export class SpaceCredentialMemberContainment {
  private readonly store: ContainmentStore;
  private readonly agentSessions: AgentSessionContainmentPort;
  private readonly closeLogin: SpaceCredentialMemberContainmentOptions['closeLogin'] | null;

  constructor(options: SpaceCredentialMemberContainmentOptions) {
    this.store = options.store;
    this.agentSessions = options.agentSessions;
    this.closeLogin = options.closeLogin ?? null;
  }

  /**
   * SC-8: revoke `accountId`'s shares — in `spaceId`, or every space when it
   * is null; of `provider`, or every provider — and kill every live session
   * and login terminal on them, WHOEVER launched it. `claims` authorise it in
   * SQL: a node admin, a space admin of `spaceId`, or the account itself.
   */
  async killSharesOf(
    claims: DbClaims,
    accountId: string,
    spaceId: string | null = null,
    provider: SpaceCredentialProvider | null = null,
  ): Promise<ShareContainmentResult> {
    const result: ShareContainmentResult = {
      accountId,
      spaceId,
      provider,
      revokedCredentialIds: [],
      terminatedSessionIds: [],
      notOnThisNodeSessionIds: [],
      closedLoginSessionIds: [],
      failures: [],
    };
    if (!this.store.revokeMemberShares) {
      result.failures.push({ reason: 'lookup_failed: share store not composed' });
      return result;
    }
    let found;
    try {
      found = await this.store.revokeMemberShares(claims, spaceId, accountId, provider);
    } catch (error) {
      // Nothing was revoked by this call: a retry finishes it.
      result.failures.push({ reason: `lookup_failed: ${reasonOf(error)}` });
      return result;
    }
    result.revokedCredentialIds = found.revokedCredentialIds;

    for (const login of found.loginTerminals) {
      if (!this.closeLogin) {
        result.failures.push({ sessionId: login.workSessionId, reason: 'login_terminal_left_to_sweep' });
        continue;
      }
      try {
        if ((await this.closeLogin(claims, login.workSessionId)) === 'kill_failed') {
          result.failures.push({ sessionId: login.workSessionId, reason: 'kill_failed' });
          continue;
        }
        result.closedLoginSessionIds.push(login.workSessionId);
      } catch (error) {
        result.failures.push({ sessionId: login.workSessionId, reason: reasonOf(error) });
      }
    }

    await this.kill(
      [...new Set(found.sessions.map((s) => s.workSessionId))],
      'space_credential_unshared',
      result,
    );
    return result;
  }

  /**
   * Kill every live session `accountId` launched on a space credential — in
   * `spaceId`, or in every space when it is null. `claims` authorise the
   * lookup: a node admin for every space, a space admin for theirs.
   */
  async killSessionsLaunchedBy(
    claims: DbClaims,
    accountId: string,
    spaceId: string | null = null,
  ): Promise<MemberContainmentResult> {
    const result: MemberContainmentResult = {
      accountId,
      spaceId,
      terminatedSessionIds: [],
      notOnThisNodeSessionIds: [],
      failures: [],
    };

    let sessionIds: string[];
    try {
      const found = await this.store.memberSessions(claims, spaceId, accountId);
      // One row per (session, provider): a session on a space anthropic key AND
      // a space GitHub token is one PTY, killed once.
      sessionIds = [...new Set(found.sessions.map((s) => s.workSessionId))];
    } catch (error) {
      // Nothing was read, so nothing was killed: a retry finishes it.
      result.failures.push({ reason: `lookup_failed: ${reasonOf(error)}` });
      return result;
    }

    await this.kill(sessionIds, 'member_removed', result);
    return result;
  }

  private async kill(
    sessionIds: readonly string[],
    cause: CredentialContainmentCause,
    result: MemberContainmentResult,
  ): Promise<void> {
    for (const sessionId of sessionIds) {
      // Kill, then record the ending — the stop path `terminate` uses. A
      // failed kill leaves the row as it was.
      const contained = await this.agentSessions.containCredentialSession(sessionId, cause);
      const failure = containmentFailureOf(contained);
      if (failure !== null) result.failures.push({ sessionId, reason: failure });
      if (contained.outcome === 'error') {
        continue;
      } else if (contained.outcome === 'not_found') {
        result.notOnThisNodeSessionIds.push(sessionId);
      } else {
        result.terminatedSessionIds.push(sessionId);
      }
    }
  }
}

/**
 * The `IdentityService.disableAccount` seam: every space, under the acting
 * node admin's claims (206 lets only a node admin, or the account itself, ask
 * across spaces). `claims` is a function so a per-request composition can hand
 * over the caller it is serving.
 */
export function accountDisableContainment(
  containment: SpaceCredentialMemberContainment,
  claims: () => DbClaims,
): {
  killSessionsLaunchedBy(accountId: string): Promise<MemberContainmentResult>;
  killSharesOf(accountId: string): Promise<ShareContainmentResult>;
} {
  return {
    killSessionsLaunchedBy: (accountId) => containment.killSessionsLaunchedBy(claims(), accountId, null),
    killSharesOf: (accountId) => containment.killSharesOf(claims(), accountId, null),
  };
}

/** An error's code or class name: never its message, which may quote input. */
function reasonOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') return code;
  return error instanceof Error ? error.name : 'unknown';
}
