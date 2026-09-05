/**
 * The spawn side of per-member credential delivery: given the claims a spawn is
 * running under, decide whether that identity has their OWN vendor credential
 * and hand the spawn loop the directory it lives in.
 *
 * WHY THE EXISTENCE CHECK IS NOT OPTIONAL, AND NOT A FILESYSTEM CHECK.
 *
 * Injecting unconditionally would point `CLAUDE_CONFIG_DIR` at an EMPTY
 * per-identity directory for every member who has not connected — and because
 * that variable REPLACES the default config location rather than adding to it,
 * those members would get an agent with no authentication at all. A total
 * launch regression for everyone, delivered in exchange for a feature nobody
 * had switched on yet. So the injection is gated on the credential index.
 *
 * The gate is the DATABASE row, not the presence of a file on disk. Sub-doc 15
 * measured that a populated config directory is NOT a success signal: both
 * Claude login verbs write `.claude.json` plus a `backups/` entry within
 * seconds of launch, BEFORE any authentication happens. A directory-exists
 * check would therefore report "connected" for a login the member abandoned at
 * the paste-code prompt. `account_agent_credentials` is written only by the
 * finish step, after a probe, which is the whole reason it exists.
 *
 * WHY `identityId` AND NOT `account_id` — architect ruling 14.
 *
 * The credential home is keyed on the identity id, because that is what PR2's
 * login terminal WRITES (`ensureCredentialHome(dataDir, principal.identityId,
 * provider)`); an agent that reads any other path reads a directory nobody
 * wrote. The index queried below is keyed on `account_id` via RLS, so the two
 * are only interchangeable because `public.accounts.identity_id` is
 * `text not null UNIQUE` — constraint `accounts_identity_id_key`,
 * `002_identity.sql:47` — which makes identity↔account 1:1 BY CONSTRAINT rather
 * than by convention.
 *
 * **If that constraint is ever dropped, this file is wrong** and the credential
 * home must be re-keyed to `account_id` in the same change: one account holding
 * two identities would mean one index row saying "connected" while two separate
 * directories exist, and this function would hand an agent an empty one.
 * `identity_id` is also the stable external name, where `account_id` is a
 * surrogate that changes across an account delete/recreate — so an
 * identity-keyed directory is correctly re-adopted by the same human's
 * re-created account, and an account-keyed one would orphan on every recreate.
 */
import {
  AGENT_CREDENTIAL_CONFIG_DIR_VAR,
  AGENT_TOOL_CREDENTIAL_PROVIDER,
  agentCredentialProviderFor,
  type AgentCredentialProvider,
  type AgentCredentialHome,
  type AgentCredentialHomePort,
} from '@tm8/execution';

import type { Db, DbClaims } from '../db/types.js';
import { credentialConfigDir, credentialHomeDir } from './agent-credential-home.js';

interface CredentialIndexRow {
  provider: string;
}

export interface DbAgentCredentialHomeOptions {
  db: Db;
  /** The node data root — the same one SpawnService and the launcher use. */
  dataDir: string;
}

/**
 * Which agent tools consume each FILE-shaped provider credential.
 *
 * This provider-to-tools view is derived from execution's canonical
 * tool-to-provider table. Spawn lookup reads that source directly; Disconnect
 * imports this reverse projection to find every live tool process that may
 * already hold the provider. A provider therefore cannot be injected into new
 * sessions but omitted from the containment kill, or killed on disconnect
 * without ever having been delivered.
 *
 * GitHub is deliberately absent: its string-shaped token is injected into all
 * tools through `account_git_credentials`, so the catalog represents it with
 * `null` (all tools) rather than one row here.
 */
function toolsByCredentialProvider(): Record<AgentCredentialProvider, readonly string[]> {
  const result = Object.fromEntries(
    (Object.keys(AGENT_CREDENTIAL_CONFIG_DIR_VAR) as AgentCredentialProvider[])
      .map((provider) => [provider, [] as string[]]),
  ) as Record<AgentCredentialProvider, string[]>;
  for (const [agentTool, provider] of Object.entries(AGENT_TOOL_CREDENTIAL_PROVIDER)) {
    result[provider].push(agentTool);
  }
  return result;
}

export const AGENT_TOOLS_BY_CREDENTIAL_PROVIDER: Readonly<
  Record<AgentCredentialProvider, readonly string[]>
> = toolsByCredentialProvider();

export type AgentFileCredentialProvider = AgentCredentialProvider;

/** The provider `agentTool` consumes, or null when it has no admitted mapping. */
export function credentialProviderForAgentTool(
  agentTool: string | null | undefined,
): AgentFileCredentialProvider | null {
  return agentCredentialProviderFor(agentTool);
}

/**
 * Resolves a spawning identity's credential home from the credential index.
 *
 * Reads under the CALLER'S OWN claims, with no account parameter: 082's
 * `account_agent_credentials_self_select` policy is
 * `account_id = internal.current_account_id()`, so the query below can only
 * ever see the spawner's own row. There is deliberately no node-admin bypass to
 * lean on — an operator has no business learning which member is connected to
 * which vendor identity — and passing an account id in would be inventing an
 * authorization decision this layer has no right to make.
 */
export class DbAgentCredentialHome implements AgentCredentialHomePort {
  private readonly db: Db;
  private readonly dataDir: string;

  constructor(options: DbAgentCredentialHomeOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
  }

  async resolve(
    auth: unknown,
    input: { agentTool: string },
  ): Promise<AgentCredentialHome | null> {
    const provider = credentialProviderForAgentTool(input.agentTool);
    // `echo-agent`, an operator wrapper, or any tool that authenticates against
    // no admitted vendor. Nothing to inject and nothing to look up.
    if (!provider) return null;

    const claims = auth as DbClaims;
    // No identity means no RLS-visible row anyway; asking would be a pointless
    // round trip whose only possible answer is "none".
    if (!claims?.identityId) return null;

    const rows = await this.db.query<CredentialIndexRow>(
      claims,
      `select provider
         from public.account_agent_credentials
        where provider = $1
          and status = 'active'
        limit 1`,
      [provider],
    );
    // 'stale' and 'revoked' deliberately do NOT inject. A stale credential must
    // fail visibly and attributably to the member ("reconnect your account"),
    // never silently fall back to the node's identity — which is the lie this
    // whole build exists to stop telling, produced at the exact moment the
    // member is least able to notice it.
    if (rows.length === 0) return null;

    return {
      provider,
      homeDir: credentialHomeDir(this.dataDir, claims.identityId),
      configDir: credentialConfigDir(this.dataDir, claims.identityId, provider),
    };
  }
}
