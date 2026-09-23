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
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AGENT_CREDENTIAL_CONFIG_DIR_VAR,
  AGENT_TOOL_CREDENTIAL_PROVIDER,
  API_KEY_CREDENTIAL_PROVIDERS,
  API_KEY_FILENAME,
  agentCredentialProviderFor,
  apiKeyBackendAgentTool,
  apiKeyBackendForModel,
  isApiKeyCredentialProvider,
  type AgentCredentialProvider,
  type AgentCredentialHome,
  type AgentCredentialHomePort,
  type ApiKeyCredentialProvider,
  type Logger,
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
  /**
   * Optional, and used for exactly one thing: reporting an index row whose key
   * file cannot be read. That is an INCONSISTENCY rather than an ordinary
   * "not connected", and it resolves to the same silent outcome, so it needs a
   * place to be loud. See `readApiKey`.
   */
  logger?: Logger;
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
 *
 * THE API-KEY BACKENDS CONTRIBUTE NOTHING TO `AGENT_TOOL_CREDENTIAL_PROVIDER`,
 * so they must be added here explicitly, and forgetting to would have been a
 * containment hole rather than a cosmetic gap. That table maps a tool to the
 * provider it NATIVELY authenticates with, and Kimi holds `agentTools: []`
 * there precisely so it is never mistaken for Anthropic. But a Kimi key IS
 * live in every `claude-code` process launched on a Kimi model — so if this
 * reverse projection reported no tools
 * for `kimi`, Disconnect would revoke the row, leave those processes running
 * with the key still in their environment, and report success. The second loop
 * below reads the routing table for that reason: the projection must describe
 * where a credential can REACH, not where it came from.
 */
function toolsByCredentialProvider(): Record<AgentCredentialProvider, readonly string[]> {
  const result = Object.fromEntries(
    (Object.keys(AGENT_CREDENTIAL_CONFIG_DIR_VAR) as AgentCredentialProvider[])
      .map((provider) => [provider, [] as string[]]),
  ) as Record<AgentCredentialProvider, string[]>;
  for (const [agentTool, provider] of Object.entries(AGENT_TOOL_CREDENTIAL_PROVIDER)) {
    result[provider].push(agentTool);
  }
  for (const provider of API_KEY_CREDENTIAL_PROVIDERS) {
    const agentTool = apiKeyBackendAgentTool(provider);
    if (!result[provider].includes(agentTool)) result[provider].push(agentTool);
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
  private readonly logger: Logger | undefined;

  constructor(options: DbAgentCredentialHomeOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
    this.logger = options.logger;
  }

  async resolve(
    auth: unknown,
    input: { agentTool: string; model: string | null },
  ): Promise<AgentCredentialHome | null> {
    // THE MODEL CHOOSES THE CREDENTIAL, and exactly one is looked up.
    //
    // A Kimi model (`provider: 'moonshot'` in the launch catalog) is served by
    // the member's Kimi key and by nothing else; every other `claude-code`
    // model is served by their Anthropic login and never by the Kimi key. Groq
    // and `codex`/OpenAI are the same. There is no fallback from one to the
    // other in either direction: a Claude model sent to Moonshot, or a Kimi
    // model sent to Anthropic, is a request to a server that does not serve it.
    //
    // This used to be an account-wide preference list, `[kimi, anthropic]`,
    // under which a connected Kimi key outranked the Anthropic login for every
    // `claude-code` session regardless of model (#638).
    //
    // Connecting or disconnecting one provider never alters the other's row.
    const provider: AgentCredentialProvider | null =
      apiKeyBackendForModel(input.agentTool, input.model)
      ?? credentialProviderForAgentTool(input.agentTool);

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
          and status = 'active'`,
      [provider],
    );
    // 'stale' and 'revoked' deliberately do NOT inject. A stale credential must
    // fail visibly and attributably to the member ("reconnect your account"),
    // never silently fall back to the node's identity — which is the lie this
    // whole build exists to stop telling, produced at the exact moment the
    // member is least able to notice it.
    if (!rows.some((row) => row.provider === provider)) return null;

    const homeDir = credentialHomeDir(this.dataDir, claims.identityId);
    const configDir = credentialConfigDir(this.dataDir, claims.identityId, provider);

    if (isApiKeyCredentialProvider(provider)) {
      const apiKey = await this.readApiKey(configDir, provider, claims.identityId);
      // An index row with no readable key is an INCONSISTENCY, and the honest
      // response is a KEYLESS HOME — this provider, this directory, no secret.
      //
      // `return null` WAS THE OBVIOUS ANSWER AND IT IS THE WRONG ONE, so the
      // reason is written here rather than left to be rediscovered. `null` is
      // this port's documented word for "has not connected", and for that member
      // it is right: injecting an empty config directory would leave someone who
      // never connected with no agent authentication at all. But this member DID
      // connect — the index row is `active` and says so. Returning the
      // unconnected answer for a connected member is not the conservative
      // choice; it is a different claim, and a false one.
      //
      // WHAT IT ACTUALLY DOES, which is the opposite of "inject nothing".
      // `composeEnv` forwards the node's own `ANTHROPIC_API_KEY` from
      // `AUTH_ENV_KEYS`, and every line that removes it again — the C8
      // suppression loop — lives inside `if (credentialHome)`. Hand back `null`
      // and that block never runs, so the node's key stays in the environment
      // and the member's `claude-code` session authenticates as the NODE. They
      // connected Kimi; they get Anthropic, on the machine account's bill, with
      // nothing red anywhere. That is the exact silent vendor substitution the
      // paragraph below rules out, arriving through the door left open beside it.
      //
      // The keyless home closes it. It carries `provider`, so suppression runs
      // and `CLAUDE_CONFIG_DIR` is pinned to the member's own `kimi/` directory,
      // which holds no Anthropic login either; `apiKey` is absent, so the
      // routing step injects no bearer token and no base URL — a base URL
      // without a key would only move the failure to a 401 far from here. The
      // session therefore starts with no credential for ANYONE and fails
      // visibly and attributably, which is what this file's header already
      // demands for a `stale` row and is owed equally to one that is active but
      // unreadable.
      //
      // The two alternatives remain worse. Falling through to the native
      // provider would silently run the member on Anthropic's billing after
      // they deliberately connected Kimi — a quiet substitution of one vendor
      // for another, which is the precise class of lie this subsystem exists to
      // prevent. Throwing here would take the decision away from the spawn
      // layer, which is the one that knows the posture — and which, for a model
      // only this key serves, refuses the launch naming the unreadable key.
      // The inconsistency is logged by `readApiKey` rather than swallowed,
      // because nothing else in the system will notice it.
      if (apiKey === null) return { provider, homeDir, configDir };
      return { provider, homeDir, configDir, apiKey };
    }

    return { provider, homeDir, configDir };
  }

  /**
   * Read a member's pasted key from their credential home.
   *
   * Returns `null` for every failure, deliberately without distinguishing them
   * to the caller: a missing file, a directory, a permissions error and a
   * blank file all mean "there is no usable key here", and the caller's
   * response to each is identical. The distinction that matters goes to the
   * log, not to the control flow.
   *
   * The value is trimmed because it is written with a trailing newline by the
   * paste harness, and a key with a newline in the `Authorization` header is a
   * request that fails for a reason nobody would guess from the message.
   */
  private async readApiKey(
    configDir: string,
    provider: ApiKeyCredentialProvider,
    identityId: string,
  ): Promise<string | null> {
    const path = join(configDir, API_KEY_FILENAME);
    try {
      const apiKey = (await readFile(path, 'utf8')).trim();
      if (apiKey.length === 0) {
        this.logger?.error('DbAgentCredentialHome: stored API key is empty', undefined, {
          provider,
          identityId,
        });
        return null;
      }
      return apiKey;
    } catch (err) {
      // The PATH is logged and the CONTENTS never are. A path is what an
      // operator needs to fix this; the file is the secret itself.
      this.logger?.error(
        'DbAgentCredentialHome: active credential has no readable key',
        err instanceof Error ? err : undefined,
        { provider, identityId, path },
      );
      return null;
    }
  }
}
