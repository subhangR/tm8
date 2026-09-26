/**
 * `credentials.space.*` and `node.credentials.*` — the SC-3 operations over
 * 206's space credentials (design 01a0cfa8 §5, §6).
 *
 * Every entry point here is reached only through `requireHumanSession` (I2,
 * layer 1); every RPC it calls re-checks `internal.require_human_auth_kind()`
 * (layer 2). Who may change a credential (D11: its creator or a space admin),
 * who may set a policy (space admin / node admin) and who may see a row (a
 * member of its space) are all decided in SQL; this module adds the two
 * things SQL cannot do — ask the vendor (I6) and kill a PTY (D7).
 *
 * I5: a secret enters in a request body, goes to the vendor probe and to the
 * sealed store, and leaves by neither door. Every view is built field by field
 * from metadata; no error or log line here quotes an input.
 */
import { CollabError } from '@tm8/contract';
import type {
  CredentialPolicySource,
  CredentialsSpaceDeleteResult,
  CredentialsSpaceListView,
  CredentialsSpacePolicySetResult,
  CredentialsSpacePolicyView,
  NodeCredentialPolicyEntry,
  NodeCredentialsStatusView,
  SpaceCredentialProviderName,
  SpaceCredentialView,
} from '@tm8/contract';

import type { Db, DbClaims } from '../../../db/types.js';
import type { SpaceCredentialProbe } from '../../../credentials/space-credential-probe.js';
import {
  SPACE_CREDENTIAL_PROVIDERS,
  type DbSpaceCredentialStore,
  type SpaceCredential,
  type SpaceCredentialHomeKey,
  type SpaceCredentialVisibility,
} from '../../../credentials/space-credential-store.js';
import {
  containmentFailureOf,
  type AgentSessionContainmentPort,
} from '../../../credentials/agent-session-containment.js';
import type { CredentialTerminalPort } from './credential-catalog.js';

/** The node environment variable whose presence is the node fallback (D9). */
const NODE_ENV_KEYS: Record<SpaceCredentialProviderName, readonly string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  github: ['GH_TOKEN', 'GITHUB_TOKEN'],
};

type SpaceCredentialStorePort = Pick<
  DbSpaceCredentialStore,
  | 'list'
  | 'create'
  | 'rekey'
  | 'rename'
  | 'setDefault'
  | 'revoke'
  | 'setVisibility'
  | 'liveSessions'
  | 'finishLogin'
  | 'readSpacePolicy'
  | 'setSpacePolicy'
  | 'readNodePolicy'
  | 'setNodePolicy'
>;

export interface SpaceCredentialCatalogOptions {
  db: Pick<Db, 'query'>;
  store: SpaceCredentialStorePort;
  probe: SpaceCredentialProbe;
  /** Kills a login terminal's PTY on this node. */
  terminals: CredentialTerminalPort;
  /** Kills an agent session on this node and records its ending. */
  agentSessions: AgentSessionContainmentPort;
  /**
   * Remove a login credential's file home (design §3). SC-4 owns the space
   * home, so the default does nothing; an api_key/token has no file and its
   * sealed bytes are dropped by the revoke itself.
   */
  removeLoginHome?: (home: SpaceCredentialHomeKey) => Promise<void>;
  /**
   * Close one login terminal onto the (now revoked) credential: kill it, and
   * only then `finish_space_credential_login(ws, false)`. SC-4's login
   * registry provides it, so a terminal this node started is closed through
   * the same entry its sweep would use. Absent, delete kills and stamps here.
   */
  closeLogin?: (claims: DbClaims, workSessionId: string) => Promise<'closed' | 'kill_failed'>;
  /** The server environment, read for one boolean per provider. Never forwarded. */
  env?: Readonly<Record<string, string | undefined>>;
}

export class SpaceCredentialCatalogService {
  private readonly db: Pick<Db, 'query'>;
  private readonly store: SpaceCredentialStorePort;
  private readonly probe: SpaceCredentialProbe;
  private readonly terminals: CredentialTerminalPort;
  private readonly agentSessions: AgentSessionContainmentPort;
  private readonly removeLoginHome: (home: SpaceCredentialHomeKey) => Promise<void>;
  private readonly closeLogin: SpaceCredentialCatalogOptions['closeLogin'] | null;
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(options: SpaceCredentialCatalogOptions) {
    this.db = options.db;
    this.store = options.store;
    this.probe = options.probe;
    this.terminals = options.terminals;
    this.agentSessions = options.agentSessions;
    this.removeLoginHome = options.removeLoginHome ?? (async () => undefined);
    this.closeLogin = options.closeLogin ?? null;
    this.env = options.env ?? process.env;
  }

  async list(claims: DbClaims, spaceId: string): Promise<CredentialsSpaceListView> {
    const rows = await this.store.list(claims, spaceId);
    return { spaceId, credentials: rows.map(spaceCredentialViewOf) };
  }

  /** D1: any member. The vendor is asked first; a refused key is never stored (I6). */
  async create(
    claims: DbClaims,
    spaceId: string,
    input: { provider: SpaceCredentialProviderName; shape: 'api_key' | 'token'; label: string; secret: string },
  ): Promise<SpaceCredentialView> {
    // Refuse before the probe, not after it: the probe sends the key to the
    // vendor from this node, so a caller the RPC would refuse must not reach
    // it (an agent, or a non-member testing keys from the node's address).
    requireHumanClaims(claims);
    const [space] = await this.db.query<{ is_member: boolean }>(
      claims,
      'select internal.is_space_member($1::uuid) as is_member',
      [spaceId],
    );
    // The same answer create_space_credential's require_space_member gives.
    if (space?.is_member !== true) {
      throw new CollabError('forbidden', 'not a member of this space');
    }
    const displayLogin = await this.probeOrRefuse(input.provider, input.secret);
    try {
      return spaceCredentialViewOf(await this.store.create(claims, {
        spaceId,
        provider: input.provider,
        shape: input.shape,
        label: input.label,
        secret: input.secret,
        displayLogin,
      }));
    } catch (error) {
      throw storeError(error);
    }
  }

  /**
   * D11: creator or space admin — the RPC decides. The new key is probed
   * before it replaces the old one; the old one stays if the vendor refuses.
   * D7: the next spawn reads the new sealed bytes; live sessions keep theirs.
   */
  async rekey(claims: DbClaims, credentialId: string, secret: string): Promise<SpaceCredentialView> {
    // Every refusal the RPC would make is made HERE first, before the probe:
    // otherwise any member could use this node to test arbitrary keys against
    // a vendor. `can_manage` is internal.can_manage_space_credential's body
    // (206, D11) — that function is granted to nobody, its three predicates
    // are granted to tm8_app. provider and shape never change, so reading them
    // before the locked RPC cannot probe against a stale value; the RPC
    // re-checks rights and status under its lock. RLS answers a non-member nothing.
    requireHumanClaims(claims);
    const [current] = await this.db.query<{
      provider: SpaceCredentialProviderName;
      shape: string;
      status: string;
      can_manage: boolean;
    }>(
      claims,
      `select provider, shape, status,
              internal.is_space_member(space_id)
                and (internal.is_space_admin(space_id)
                     or (created_by_account_id is not null
                         and created_by_account_id = internal.current_account_id())) as can_manage
         from public.space_credentials where id = $1`,
      [credentialId],
    );
    if (!current) throw notFound();
    if (current.can_manage !== true) {
      throw new CollabError('forbidden', 'only the credential\'s creator or a space admin can change it');
    }
    if (current.shape === 'login') {
      throw new CollabError('invalid_input', 'a login credential is renewed by logging in again, not by pasting a key');
    }
    if (current.status !== 'active' && current.status !== 'stale') {
      throw new CollabError('invariant_violation', `space credential is ${current.status}`);
    }
    const displayLogin = await this.probeOrRefuse(current.provider, secret);
    try {
      return spaceCredentialViewOf(await this.store.rekey(claims, credentialId, secret, displayLogin));
    } catch (error) {
      throw storeError(error);
    }
  }

  async rename(claims: DbClaims, credentialId: string, label: string): Promise<SpaceCredentialView> {
    return spaceCredentialViewOf(await this.store.rename(claims, credentialId, label));
  }

  async setDefault(claims: DbClaims, credentialId: string): Promise<SpaceCredentialView> {
    return spaceCredentialViewOf(await this.store.setDefault(claims, credentialId));
  }

  /**
   * W10a: the owner makes their credential public or private. Going private
   * kills every live session another member launched on it — the same
   * containment delete uses, which also scrubs each session's key home — and
   * the spawn gate refuses the rest (a session still `spawning` is refused by
   * its own pre- and post-PTY re-check). The credential's own login home is
   * the owner's and stays. Kills are best effort after the committed switch,
   * so a failed one is named in `failures`, never thrown.
   */
  async setVisibility(
    claims: DbClaims,
    credentialId: string,
    visibility: SpaceCredentialVisibility,
  ): Promise<{
    credential: SpaceCredentialView;
    terminatedAgentSessionIds: string[];
    failures: Array<{ sessionId: string; reason: string }>;
  }> {
    const { killSessions, ...stored } = await this.store.setVisibility(claims, credentialId, visibility);
    const terminatedAgentSessionIds: string[] = [];
    const failures: Array<{ sessionId: string; reason: string }> = [];
    for (const session of killSessions) {
      const contained = await this.agentSessions.containCredentialSession(
        session.workSessionId,
        'space_credential_made_private',
      );
      const failure = containmentFailureOf(contained);
      if (failure !== null) failures.push({ sessionId: session.workSessionId, reason: failure });
      if (contained.outcome === 'error') continue;
      terminatedAgentSessionIds.push(session.workSessionId);
    }
    return { credential: spaceCredentialViewOf(stored), terminatedAgentSessionIds, failures };
  }

  /**
   * Design §5, in the member Disconnect's order:
   *   1. revoke the row (authorises the caller; drops the sealed bytes),
   *   2. read every live session and open login terminal on it,
   *   3. kill each, WHOEVER launched it (D7, M6),
   *   4. stamp each login terminal finished,
   *   5. remove a login's file home.
   * Nothing after step 1 can un-revoke it, so every later step is best effort
   * and a step that fails is named in `failures` rather than thrown.
   */
  async delete(claims: DbClaims, credentialId: string): Promise<CredentialsSpaceDeleteResult> {
    // 1. Revoke. A refusal here (not a manager, not found) is the answer.
    const revoked = await this.store.revoke(claims, credentialId);
    const failures: CredentialsSpaceDeleteResult['failures'] = [];
    const terminatedLoginSessionIds: string[] = [];
    const terminatedAgentSessionIds: string[] = [];

    // 2. Everything live on it, whoever launched it.
    let live: Awaited<ReturnType<SpaceCredentialStorePort['liveSessions']>> | null = null;
    try {
      live = await this.store.liveSessions(claims, credentialId);
    } catch (error) {
      // No session was read, so none was killed: a retried delete finishes it.
      failures.push({ step: 'agentSession', reason: `lookup_failed: ${reasonOf(error)}` });
    }

    // 3. Kill every PTY first — login terminals and agent sessions alike.
    const killedLogins: string[] = [];
    // 3+4 for a login terminal, through the login registry: kill, then stamp.
    for (const login of this.closeLogin ? live?.loginTerminals ?? [] : []) {
      try {
        if ((await this.closeLogin!(claims, login.workSessionId)) === 'kill_failed') {
          failures.push({
            step: 'loginSession',
            sessionId: login.workSessionId,
            reason: 'the PTY host could not kill this login terminal',
          });
          continue;
        }
      } catch (error) {
        failures.push({ step: 'loginSession', sessionId: login.workSessionId, reason: reasonOf(error) });
        continue;
      }
      terminatedLoginSessionIds.push(login.workSessionId);
    }
    for (const login of this.closeLogin ? [] : live?.loginTerminals ?? []) {
      if (this.terminals.terminate(login.workSessionId) === 'error') {
        failures.push({
          step: 'loginSession',
          sessionId: login.workSessionId,
          reason: 'the PTY host could not kill this login terminal',
        });
        continue;
      }
      killedLogins.push(login.workSessionId);
    }
    for (const session of live?.sessions ?? []) {
      // Kill, then record the ending through the stop path `terminate` uses,
      // so the row does not read `running` after its process is gone. A failed
      // kill leaves the row as it was.
      const contained = await this.agentSessions.containCredentialSession(
        session.workSessionId,
        'space_credential_deleted',
      );
      const failure = containmentFailureOf(contained);
      if (failure !== null) {
        failures.push({ step: 'agentSession', sessionId: session.workSessionId, reason: failure });
      }
      if (contained.outcome === 'error') continue;
      // `not_found`: no live PTY on this node — the state asked for.
      terminatedAgentSessionIds.push(session.workSessionId);
    }

    // 4. Then stamp each killed terminal finished. Stamping one whose PTY is
    // still streaming would record a live terminal as closed, so a terminal
    // the host could not kill stays open and is reported instead.
    for (const workSessionId of killedLogins) {
      try {
        await this.store.finishLogin(claims, workSessionId, false);
      } catch (error) {
        failures.push({ step: 'loginSession', sessionId: workSessionId, reason: reasonOf(error) });
        continue;
      }
      terminatedLoginSessionIds.push(workSessionId);
    }

    // 5. The file home, last.
    if (revoked.shape === 'login') {
      try {
        await this.removeLoginHome({
          spaceId: revoked.spaceId,
          credentialId: revoked.id,
          provider: revoked.provider,
        });
      } catch (error) {
        failures.push({ step: 'files', reason: reasonOf(error) });
      }
    }

    return {
      credentialId,
      revoked: revoked.revoked,
      terminatedLoginSessionIds,
      terminatedAgentSessionIds,
      failures,
    };
  }

  async policy(claims: DbClaims, spaceId: string): Promise<CredentialsSpacePolicyView> {
    const [space, node] = await Promise.all([
      this.store.readSpacePolicy(claims, spaceId),
      this.store.readNodePolicy(claims),
    ]);
    return {
      spaceId,
      providers: SPACE_CREDENTIAL_PROVIDERS.map((provider) => ({
        provider,
        allowedSources: (space[provider] as CredentialPolicySource[] | undefined) ?? null,
      })),
      node: nodeEntries(node),
    };
  }

  /** Space admin — the RPC decides (D5). */
  async setPolicy(
    claims: DbClaims,
    spaceId: string,
    provider: SpaceCredentialProviderName,
    allowedSources: CredentialPolicySource[] | null,
  ): Promise<CredentialsSpacePolicySetResult> {
    const result = await this.store.setSpacePolicy(claims, spaceId, provider, allowedSources);
    return { spaceId: result.spaceId, provider: result.provider, allowedSources: result.allowedSources ?? null };
  }

  /** Node admin — the caller checks the bearer, the RPC re-checks. */
  async nodeStatus(claims: DbClaims): Promise<NodeCredentialsStatusView> {
    const node = await this.store.readNodePolicy(claims);
    return {
      providers: nodeEntries(node).map((entry) => ({
        ...entry,
        envKeyPresent: NODE_ENV_KEYS[entry.provider].some((name) => Boolean(this.env[name]?.trim())),
      })),
    };
  }

  async setNodePolicy(
    claims: DbClaims,
    provider: SpaceCredentialProviderName,
    allowNode: boolean | null,
  ): Promise<NodeCredentialPolicyEntry> {
    const result = await this.store.setNodePolicy(claims, provider, allowNode);
    return { provider: result.provider, allowNode: result.allowNode ?? null };
  }

  /**
   * I6: the vendor's verdict before any write. A refusal and an unreachable
   * vendor both refuse the write; they differ only in what the member does
   * next. Neither message carries the key.
   */
  private async probeOrRefuse(provider: SpaceCredentialProviderName, secret: string): Promise<string | null> {
    const result = await this.probe({ provider, secret });
    if (result.ok) return result.displayLogin;
    if (result.reason === 'rejected') {
      throw new CollabError('invalid_input', `the ${provider} key was refused by the vendor; nothing was stored`, {
        details: { reason: 'credential_rejected', probe: result.detail },
      });
    }
    throw new CollabError('upstream_unavailable', `the ${provider} key could not be checked; nothing was stored`, {
      details: { reason: 'credential_probe_unreachable', probe: result.detail },
    });
  }

}

export function spaceCredentialViewOf(row: SpaceCredential): SpaceCredentialView {
  return {
    id: row.id,
    spaceId: row.spaceId,
    provider: row.provider,
    shape: row.shape,
    label: row.label,
    isDefault: row.isDefault,
    status: row.status,
    createdByAccountId: row.createdByAccountId,
    displayLogin: row.displayLogin,
    keyHint: row.keyHint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    lastProbeAt: row.lastProbeAt,
  };
}

function nodeEntries(node: Partial<Record<SpaceCredentialProviderName, boolean>>): NodeCredentialPolicyEntry[] {
  return SPACE_CREDENTIAL_PROVIDERS.map((provider) => ({ provider, allowNode: node[provider] ?? null }));
}

/**
 * The auth kinds `internal.require_human_auth_kind()` accepts, checked here
 * only so that a caller the RPC will refuse never reaches the vendor probe.
 * Fail closed: an absent or unrecognised kind refuses. The facade's
 * `requireHumanSession` is layer 1; the RPC is layer 2; this is not a layer.
 */
const HUMAN_AUTH_KINDS: readonly string[] = ['browser', 'cli'];

function requireHumanClaims(claims: DbClaims): void {
  if (claims.authKind === undefined || !HUMAN_AUTH_KINDS.includes(claims.authKind)) {
    throw new CollabError('forbidden', 'credentials are human-only');
  }
}

function notFound(): CollabError {
  return new CollabError('not_found', 'space credential not found');
}

/** The store's own plain Errors carry no secret, but are not in the taxonomy. */
function storeError(error: unknown): unknown {
  if (error instanceof CollabError) return error;
  if (error instanceof Error && error.message === 'space credential not found') return notFound();
  // Neither the value nor its length is in the store's message; none here.
  if (error instanceof Error && error.message === 'credential is too short') {
    return new CollabError('invalid_input', 'the key is too short to be a credential; nothing was stored');
  }
  return error;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
