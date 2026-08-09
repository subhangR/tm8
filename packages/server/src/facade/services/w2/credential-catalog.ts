/**
 * The two credential operations that read and revoke: `credentials.status` and
 * `credentials.delete`.
 *
 * They live BESIDE `credential-sessions.ts` rather than inside it because that
 * class owns a lifecycle — an in-memory registry of live login terminals, an
 * interval sweep, a TTL. These two own neither. Folding a stateless read and a
 * revoke into a class that holds a timer would mean every test of "what does
 * status return" has to construct and later dispose a sweeper.
 *
 * ---------------------------------------------------------------------------
 * WHY `status` READS TWO TABLES AND TOLERATES ONE OF THEM MISSING
 * ---------------------------------------------------------------------------
 *
 * The credential stores are split by SHAPE, not by vendor preference (sub-doc 0,
 * ruling R6):
 *
 *   * FILE-shaped credentials — anthropic, openai — are a 0600 file in a
 *     per-account config directory. `account_agent_credentials` (083) indexes
 *     them and holds no secret column at all.
 *   * A GitHub token is a STRING, and its home is `account_git_credentials`,
 *     which shipped in migration 079 — on the DEPLOYED STAGING LINE. It is
 *     reachable from no local git object. `git grep current_account_id` over
 *     every origin ref finds it only on `feat/per-user-private-workspaces`
 *     (as 081) and `deploy/channels-on-staging` (as 079); `origin/main` has
 *     zero hits.
 *
 * So on this line the second table DOES NOT EXIST, and the merged view has to
 * say so. The alternative — letting an absent table read as "no rows" and
 * therefore "not connected" — collapses two different facts into one, and it
 * collapses them in the dangerous direction: a member who IS connected on a
 * node that has 079 would be shown a confident "Not connected", and a member
 * here would be shown one that was never measured. `gitCredentialStore` is
 * therefore part of the answer rather than an implementation detail.
 *
 * ---------------------------------------------------------------------------
 * WHY `delete` IS ORDERED THE WAY IT IS (architect ruling R3)
 * ---------------------------------------------------------------------------
 *
 * Disconnect TERMINATES. The order is load-bearing at every step and the
 * reasons are different at each:
 *
 *   1. REVOKE FIRST — the index row and the on-disk credential — so that no
 *      spawn occurring during the rest of the operation can inject the secret.
 *      Doing this last would leave a window in which we have killed the
 *      member's sessions and a new one picks the credential straight back up.
 *   2. THE LOGIN TERMINAL for that (account, provider). With PR0's socket
 *      authorization in place this is no longer space-drivable, but a live
 *      terminal still holds a half-finished OAuth flow that can complete AFTER
 *      the revoke and write a fresh credential to disk.
 *   3. THE ACCOUNT'S LIVE AGENT SESSIONS carrying that provider. `anthropic`
 *      maps to the claude tool, `openai` to codex, and `github` to ALL of them
 *      because the git credential injects universally.
 *
 * BEST-EFFORT, AND IT NEVER RESURRECTS. A kill that fails is recorded in
 * `failures` and changes nothing about the revoke. `revoked: true` alongside a
 * non-empty `failures` is the correct description of a partial disconnect, not
 * a contradiction — and it is strictly better than rolling the revoke back,
 * which would restore a credential the member has asked us to forget because we
 * could not kill a process.
 *
 * AND IT IS CONTAINMENT, NOT REVOCATION. A process that already read the
 * credential holds it in memory and keeps holding it. Only rotating at the
 * vendor actually invalidates the secret. The confirm dialog must say both
 * things (R3); this service's job is to make the first one true.
 */
import { CollabError } from '@tm8/contract';
import type {
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsDeleteResult,
  CredentialsStatusView,
} from '@tm8/contract';
import type { Logger } from '@tm8/execution';

import type { Db } from '../../../db/types.js';
import { credentialConfigDir } from '../../../credentials/agent-credential-home.js';
import type { CredentialPrincipal } from './credential-sessions.js';

/**
 * Every provider a card is rendered for, in display order.
 *
 * The list is the SESSION table's three-value CHECK, not the credential table's
 * two. A member can run a GitHub login here even though what it produces is
 * stored elsewhere, so a status view that omitted github would be describing
 * the storage rather than the feature.
 */
export const CREDENTIAL_STATUS_PROVIDERS: readonly CredentialProviderName[] = [
  'anthropic',
  'openai',
  'github',
] as const;

/**
 * Which agent tool a provider's credential is consumed by — R3 step 3's
 * targeting rule, and the only place it is written down.
 *
 * The values are the ones `SpawnService` actually branches on
 * (`SpawnService.ts:379,556,685`): `claude-code` and `codex`, NOT `claude`.
 *
 * `github` maps to `null` meaning EVERY tool rather than to an empty list
 * meaning none. The git credential is injected into every agent session
 * regardless of which CLI it runs, so narrowing it would leave live sessions
 * holding a token the member believes they just disconnected. R3 says "all of
 * A's live agent sessions" for exactly this reason.
 */
const PROVIDER_AGENT_TOOLS: Record<CredentialProviderName, readonly string[] | null> = {
  anthropic: ['claude-code'],
  openai: ['codex'],
  github: null,
};

/** Statuses that mean a work session may still be holding a credential. */
const LIVE_SESSION_STATUSES = ['spawning', 'running', 'idle'] as const;

interface AgentCredentialRow {
  provider: string;
  login: string | null;
  auth_method: string | null;
  status: string;
  connected_at: Date | string;
  last_verified_at: Date | string | null;
}

interface GitCredentialRow {
  provider: string;
  login: string | null;
}

interface OpenCredentialSessionRow {
  work_session_id: string;
}

interface LiveAgentSessionRow {
  work_session_id: string;
}

/**
 * The narrow slice of the PTY host this service needs.
 *
 * Declared here rather than importing `CredentialSessionLauncher` so that the
 * dependency reads as what it is — the ability to kill a terminal — and so a
 * test can supply one without constructing a launcher and a PTY host.
 * `CredentialSessionLauncher` satisfies it structurally.
 */
export interface CredentialTerminalPort {
  terminate(sessionId: string): string;
  hasLiveTerminal(sessionId: string): boolean;
}

export interface W2CredentialCatalogServiceOptions {
  db: Db;
  terminals: CredentialTerminalPort;
  /** Node data root; the per-identity credential home hangs off it. */
  dataDir: string;
  logger?: Logger;
  /**
   * Remove the on-disk credential material for one provider.
   *
   * Injected so that a test can prove the ORDER (revoke before any kill)
   * without a real filesystem, and defaulted to the real implementation below.
   */
  removeCredentialFiles?: (input: {
    dataDir: string;
    identityId: string;
    provider: CredentialProviderName;
  }) => Promise<void>;
  /**
   * Revoke a GitHub credential from 090's string-shaped table.
   *
   * This remains injected for testability and rolling-deploy honesty. If the
   * production composition has no store, `credentials.delete('github')`
   * reports `revoked: false` and names the reason instead of claiming it
   * revoked something.
   */
  revokeGitCredential?: (input: {
    principal: CredentialPrincipal;
  }) => Promise<void>;
}

export class W2CredentialCatalogService {
  private readonly db: Db;
  private readonly terminals: CredentialTerminalPort;
  private readonly dataDir: string;
  private readonly logger: Logger | undefined;
  private readonly removeCredentialFiles: NonNullable<
    W2CredentialCatalogServiceOptions['removeCredentialFiles']
  >;
  private readonly revokeGitCredential:
    | W2CredentialCatalogServiceOptions['revokeGitCredential']
    | undefined;

  constructor(options: W2CredentialCatalogServiceOptions) {
    this.db = options.db;
    this.terminals = options.terminals;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
    this.removeCredentialFiles = options.removeCredentialFiles ?? removeCredentialDirectory;
    this.revokeGitCredential = options.revokeGitCredential;
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  /**
   * The merged view. Always all three providers, in a fixed order.
   *
   * A provider with no row is `connected: false` with every other field null —
   * an ABSENT row is the encoding of "not connected" (PR2 is deliberate about
   * this: a `stale` probe writes no row at all rather than a `stale` row,
   * because "connected once, cannot confirm now" would put a Connected card in
   * front of someone who has no credential).
   *
   * Both reads are plain selects under the caller's own claims. Row-level
   * security does the scoping — `account_agent_credentials`'s only policy is
   * `account_id = internal.current_account_id()` — so there is no account
   * parameter here to get wrong, and Bob cannot ask for Alice's row because
   * there is no way to spell the request.
   */
  async status(principal: CredentialPrincipal): Promise<CredentialsStatusView> {
    const rows = await this.db.query<AgentCredentialRow>(
      principal.claims,
      `select provider, login, auth_method, status, connected_at, last_verified_at
         from public.account_agent_credentials`,
    );

    const byProvider = new Map<string, CredentialConnectionView>();
    for (const row of rows) {
      byProvider.set(row.provider, {
        provider: row.provider as CredentialProviderName,
        // ONLY `active` is a connection. A `revoked` row is a tombstone and a
        // `stale` one means "cannot confirm", and rendering either as connected
        // is how a member ends up trusting a credential that no longer works.
        connected: row.status === 'active',
        login: row.login,
        authMethod: row.auth_method,
        status: row.status as CredentialConnectionView['status'],
        connectedAt: toIso(row.connected_at),
        lastVerifiedAt: toIso(row.last_verified_at),
      });
    }

    const git = await this.readGitCredentials(principal);
    for (const row of git.rows) {
      byProvider.set(row.provider, {
        provider: row.provider as CredentialProviderName,
        // 079's table has no status column of its own that this line can read,
        // so the presence of a row IS the connection. Deliberately not widened
        // into a guess about staleness.
        connected: true,
        login: row.login,
        authMethod: null,
        status: 'active',
        connectedAt: null,
        lastVerifiedAt: null,
      });
    }

    return {
      providers: CREDENTIAL_STATUS_PROVIDERS.map(
        (provider) => byProvider.get(provider) ?? notConnected(provider),
      ),
      gitCredentialStore: git.store,
    };
  }

  /**
   * Read 079's table if it is here, and say plainly when it is not.
   *
   * `to_regclass` rather than a caught error, because catching would also
   * swallow a permission failure and report it as "absent" — and 079's grant is
   * column-level with the cipher deliberately omitted, so a 42501 from this
   * table is a REAL and interesting failure that must not be laundered into a
   * shrug. The read is still guarded, but the two outcomes are logged
   * differently.
   */
  private async readGitCredentials(
    principal: CredentialPrincipal,
  ): Promise<{ store: 'present' | 'absent'; rows: GitCredentialRow[] }> {
    const [probe] = await this.db.query<{ present: boolean }>(
      principal.claims,
      `select to_regclass('public.account_git_credentials') is not null as present`,
    );
    if (!probe?.present) return { store: 'absent', rows: [] };

    try {
      const rows = await this.db.query<GitCredentialRow>(
        principal.claims,
        `select provider, login from public.account_git_credentials`,
      );
      return { store: 'present', rows };
    } catch (error) {
      // The table exists and we could not read it. Report `absent` — which the
      // contract defines as "not readable here", so the github card says
      // unknown rather than "not connected" — and log loudly, because this is
      // a grant or a schema drift, not a normal state.
      this.logger?.warn?.('account_git_credentials exists but could not be read', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { store: 'absent', rows: [] };
    }
  }

  // -------------------------------------------------------------------------
  // delete — R3's Disconnect
  // -------------------------------------------------------------------------

  async delete(
    provider: CredentialProviderName,
    principal: CredentialPrincipal,
  ): Promise<CredentialsDeleteResult> {
    assertStatusProvider(provider);

    const failures: CredentialsDeleteResult['failures'] = [];

    // ---- 1. REVOKE, before anything is killed. -----------------------------
    const revoked = await this.revoke(provider, principal, failures);

    // ---- 2. The login terminal for this (account, provider). --------------
    const terminatedCredentialSessionIds = await this.terminateCredentialSessions(
      provider,
      principal,
      failures,
    );

    // ---- 3. The account's live agent sessions carrying this provider. -----
    const terminatedAgentSessionIds = await this.terminateAgentSessions(
      provider,
      principal,
      failures,
    );

    return {
      provider,
      revoked,
      terminatedCredentialSessionIds,
      terminatedAgentSessionIds,
      failures,
    };
  }

  /**
   * Step 1. The index row AND the bytes on disk.
   *
   * `delete_account_agent_credential` removes the metadata row only — its own
   * comment at `083:656-663` says the file and the sessions are the caller's
   * job. Deleting the row alone would leave the credential fully usable by
   * every future spawn while the UI showed "Not connected", which is the exact
   * inverse of an honest disconnect.
   *
   * The file removal is best-effort and SECOND: if it fails we still want the
   * row gone, because the row is what the injection path consults.
   */
  private async revoke(
    provider: CredentialProviderName,
    principal: CredentialPrincipal,
    failures: CredentialsDeleteResult['failures'],
  ): Promise<boolean> {
    if (provider === 'github') {
      // The string-shaped store is not on this line. Say so rather than
      // returning a success that revoked nothing.
      if (!this.revokeGitCredential) {
        failures.push({
          step: 'revoke',
          reason:
            'the string-shaped credential store (migration 079) is not present on this node, so nothing was revoked',
        });
        return false;
      }
      try {
        await this.revokeGitCredential({ principal });
      } catch (error) {
        failures.push({ step: 'revoke', reason: errorMessage(error) });
        return false;
      }
      return true;
    }

    let removedRow = false;
    try {
      const result = await this.db.rpc<{ deleted: boolean }>(
        principal.claims,
        'delete_account_agent_credential',
        [provider],
      );
      removedRow = result.deleted === true;
    } catch (error) {
      failures.push({ step: 'revoke', reason: errorMessage(error) });
      // Do NOT return here. The bytes on disk are the credential; the row is an
      // index. Failing to drop the index is no reason to leave the secret.
    }

    try {
      await this.removeCredentialFiles({
        dataDir: this.dataDir,
        identityId: principal.identityId,
        provider,
      });
    } catch (error) {
      failures.push({ step: 'revoke', reason: `credential files: ${errorMessage(error)}` });
      return false;
    }

    // The row may legitimately have been absent already — disconnecting twice
    // is idempotent, not an error — so a clean file removal is a revoke.
    return removedRow || failures.length === 0;
  }

  /**
   * Step 2. Any unfinished login terminal for this provider.
   *
   * RLS scopes `credential_sessions` to the caller's own account, so `where
   * provider = $1 and finished_at is null` is already "(this account, this
   * provider)" — there is no account predicate to forget.
   */
  private async terminateCredentialSessions(
    provider: CredentialProviderName,
    principal: CredentialPrincipal,
    failures: CredentialsDeleteResult['failures'],
  ): Promise<string[]> {
    const terminated: string[] = [];
    let rows: OpenCredentialSessionRow[];
    try {
      rows = await this.db.query<OpenCredentialSessionRow>(
        principal.claims,
        `select work_session_id
           from public.credential_sessions
          where provider = $1 and finished_at is null`,
        [provider],
      );
    } catch (error) {
      failures.push({ step: 'credentialSession', reason: errorMessage(error) });
      return terminated;
    }

    for (const row of rows) {
      // Kill first, then stamp. `finish_credential_session` writes `finished_at`
      // and nothing else (R7) — stamping a row whose PTY is still streaming
      // would record a terminal as closed while it is live.
      const outcome = this.terminals.terminate(row.work_session_id);
      if (outcome === 'error') {
        failures.push({
          step: 'credentialSession',
          sessionId: row.work_session_id,
          reason: 'the PTY host could not kill this login terminal',
        });
      }
      try {
        await this.db.rpc(principal.claims, 'finish_credential_session', [row.work_session_id]);
      } catch (error) {
        failures.push({
          step: 'credentialSession',
          sessionId: row.work_session_id,
          reason: errorMessage(error),
        });
        continue;
      }
      terminated.push(row.work_session_id);
    }
    return terminated;
  }

  /**
   * Step 3. This account's live agent sessions that carry the provider.
   *
   * SELF-SCOPED WITH NO NEW SQL OBJECT, which is why this needed no migration.
   * Three things make it safe:
   *
   *   * `work_sessions_select` is `internal.entity_readable(entity_id)` and
   *     `members_select` is `internal.is_space_member(space_id)`, so the query
   *     can only see rows this caller may already see;
   *   * the identity comes from `principal.identityId` — SERVER-RESOLVED, bound
   *     as a parameter — rather than from `internal.identity_id()`, which is
   *     not granted to `tm8_app`;
   *   * `entities.created_by` may be a MEMBER or a TEAM_MEMBER (finding D2
   *     measured 19 such rows on prod), so both arms are resolved and a persona
   *     is traced back through `team_members.owner_member_id` to the human who
   *     owns it. Matching only the member arm would silently skip every session
   *     an agent spawned — which is most of the ones actually holding a
   *     credential.
   *
   * `session_kind = 'agent'` keeps this from killing login terminals a second
   * time, which step 2 has already handled.
   */
  private async terminateAgentSessions(
    provider: CredentialProviderName,
    principal: CredentialPrincipal,
    failures: CredentialsDeleteResult['failures'],
  ): Promise<string[]> {
    const tools = PROVIDER_AGENT_TOOLS[provider];
    const terminated: string[] = [];

    let rows: LiveAgentSessionRow[];
    try {
      rows = await this.db.query<LiveAgentSessionRow>(
        principal.claims,
        `select ws.entity_id::text as work_session_id
           from public.work_sessions ws
           join public.entities e on e.id = ws.entity_id
           left join public.members m on m.entity_id = e.created_by
           left join public.team_members tm on tm.entity_id = e.created_by
           left join public.members owner on owner.entity_id = tm.owner_member_id
          where ws.session_kind = 'agent'
            and ws.status = any($1)
            and coalesce(m.identity_id, owner.identity_id) = $2
            and ($3::text[] is null or ws.agent_tool = any($3::text[]))`,
        [[...LIVE_SESSION_STATUSES], principal.identityId, tools ? [...tools] : null],
      );
    } catch (error) {
      failures.push({ step: 'agentSession', reason: errorMessage(error) });
      return terminated;
    }

    for (const row of rows) {
      const outcome = this.terminals.terminate(row.work_session_id);
      if (outcome === 'error') {
        failures.push({
          step: 'agentSession',
          sessionId: row.work_session_id,
          reason: 'the PTY host could not kill this agent session',
        });
        continue;
      }
      // `not_found` is reported as terminated on purpose: it means no live PTY
      // on THIS node, which is the state the caller asked for. Recording it as
      // a failure would make a perfectly successful disconnect of a session
      // that had already exited look broken.
      terminated.push(row.work_session_id);
    }
    return terminated;
  }
}

/** A provider the member has not connected. Every field null but the name. */
function notConnected(provider: CredentialProviderName): CredentialConnectionView {
  return {
    provider,
    connected: false,
    login: null,
    authMethod: null,
    status: null,
    connectedAt: null,
    lastVerifiedAt: null,
  };
}

function assertStatusProvider(provider: string): asserts provider is CredentialProviderName {
  if (!(CREDENTIAL_STATUS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new CollabError('invalid_input', `unsupported credential provider: ${provider}`);
  }
}

function toIso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Delete `<dataDir>/credentials/<identityId>/<provider>` and everything under
 * it.
 *
 * The path is composed by `credentialConfigDir` from three server-derived
 * values, so no caller input reaches it — the provider is already checked
 * against the fixed list before this runs. `force: true` makes a missing
 * directory a success, which is what disconnecting an already-disconnected
 * provider should be.
 */
async function removeCredentialDirectory(input: {
  dataDir: string;
  identityId: string;
  provider: CredentialProviderName;
}): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const dir = credentialConfigDir(input.dataDir, input.identityId, input.provider);
  await rm(dir, { recursive: true, force: true });
}
