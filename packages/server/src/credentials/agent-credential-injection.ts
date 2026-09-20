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
  apiKeyBackendsForAgentTool,
  isApiKeyBackend,
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
 * there precisely so it cannot displace Anthropic for members who never
 * connected it. But a Kimi key IS live in every `claude-code` process of a
 * member who did connect it — so if this reverse projection reported no tools
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
    // `null` for a NATIVE api-key provider such as gemini, which reaches its
    // tool through `AGENT_TOOL_CREDENTIAL_PROVIDER` in the loop above and needs
    // nothing added here. Only a backend reaches a tool that the first loop
    // credits to somebody else, and only that case belongs in this one.
    const agentTool = apiKeyBackendAgentTool(provider);
    if (agentTool === null) continue;
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
    input: { agentTool: string },
  ): Promise<AgentCredentialHome | null> {
    const nativeProvider = credentialProviderForAgentTool(input.agentTool);
    // An API-key backend can exist for a tool with no native provider in
    // principle, so both are computed before deciding there is nothing to do.
    const backends = apiKeyBackendsForAgentTool(input.agentTool);

    // `echo-agent`, an operator wrapper, or any tool that authenticates against
    // no admitted vendor. Nothing to inject and nothing to look up.
    if (!nativeProvider && backends.length === 0) return null;

    const claims = auth as DbClaims;
    // No identity means no RLS-visible row anyway; asking would be a pointless
    // round trip whose only possible answer is "none".
    if (!claims?.identityId) return null;

    // THE PREFERENCE ORDER, AND THE PRODUCT DECISION IT ENCODES.
    //
    // API-key backends first, native provider last. A member who has connected
    // Kimi gets Kimi for EVERY `claude-code` session, not just ones that opted
    // in, and it outranks a connected Anthropic login rather than losing to it.
    // That is the account-wide default this feature was asked for, and it is
    // the reason the order is stated here as data rather than left to whichever
    // row the database happened to return first.
    //
    // It is also the surprising half, so it is made VISIBLE rather than
    // silent: `credentials.status` reports the displacement in words and the
    // connection card says which tool now routes where. Disconnecting the key
    // restores the native provider with no other action — nothing about the
    // Anthropic credential is altered or revoked by connecting Kimi, it is
    // simply outranked while the key is live.
    //
    // `backends` IS NOW GENUINELY PLURAL, and the `find` below is doing real
    // work because of it: `codex` has two, `groq` and `grok`, so a member can
    // hold two connected keys that both claim one tool. `find` takes the first
    // ACTIVE candidate in `API_KEY_CREDENTIAL_PROVIDERS` order, which is the
    // documented precedence and the reason that array is ordered rather than a
    // set. The loser is not an error and is not disconnected — it is simply not
    // reached, and `credentials.status` says so on its own card through
    // `routing.outrankedBy` rather than leaving the member to infer it from
    // which vendor's dashboard shows the traffic.
    const candidates: AgentCredentialProvider[] = [
      ...backends,
      ...(nativeProvider ? [nativeProvider] : []),
    ];

    const rows = await this.db.query<CredentialIndexRow>(
      claims,
      `select provider
         from public.account_agent_credentials
        where provider = any($1::text[])
          and status = 'active'`,
      [candidates],
    );
    // 'stale' and 'revoked' deliberately do NOT inject. A stale credential must
    // fail visibly and attributably to the member ("reconnect your account"),
    // never silently fall back to the node's identity — which is the lie this
    // whole build exists to stop telling, produced at the exact moment the
    // member is least able to notice it.
    if (rows.length === 0) return null;

    const active = new Set(rows.map((row) => row.provider));
    // Ordered by OUR preference list, never by the row order the query returned.
    const provider = candidates.find((candidate) => active.has(candidate));
    if (!provider) return null;

    const homeDir = credentialHomeDir(this.dataDir, claims.identityId);
    const configDir = credentialConfigDir(this.dataDir, claims.identityId, provider);

    if (isApiKeyCredentialProvider(provider)) {
      // WHETHER A MISSING KEY IS AN INCONSISTENCY DEPENDS ON WHETHER THE
      // PROVIDER HAS A SECOND ROUTE, and `gemini` is the first that does.
      //
      // A BACKEND has exactly one: the pasted key IS the credential, and there
      // is no vendor CLI whose stored login could serve instead. A NATIVE
      // api-key provider has two — Gemini's own CLI authenticates either from
      // `GEMINI_API_KEY` or from the OAuth credentials under its config dir —
      // so for Gemini an absent key file is the ORDINARY state of every member
      // who connected before the paste flow existed, not a fault.
      const absenceIsInconsistent = isApiKeyBackend(provider);
      const apiKey = await this.readApiKey(
        configDir,
        provider,
        claims.identityId,
        absenceIsInconsistent,
      );
      if (apiKey !== null) return { provider, homeDir, configDir, apiKey };

      // An index row with no readable key is an INCONSISTENCY FOR A BACKEND,
      // and the honest response is the same one an unconnected member gets:
      // inject nothing.
      //
      // The two alternatives are both worse. Falling through to the native
      // provider would silently run the member on Anthropic's billing after
      // they deliberately connected Kimi — a quiet substitution of one vendor
      // for another, which is the precise class of lie this subsystem exists to
      // prevent. Throwing would fail the spawn outright over a credential
      // problem, turning a degraded session into no session. So: no injection,
      // the node's own configuration applies exactly as it would for anyone who
      // has not connected, and the inconsistency is logged rather than
      // swallowed, because nothing else in the system will notice it.
      if (absenceIsInconsistent) return null;

      // Gemini with no pasted key falls THROUGH to the file-shaped injection
      // below — the same home and config dir this provider has always been
      // given. Returning null here instead would have silently un-injected
      // every existing OAuth-connected member the moment `gemini` joined
      // `API_KEY_CREDENTIAL_PROVIDERS`, which is a regression this branch
      // exists to prevent rather than a behaviour anybody asked for.
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
    absenceIsInconsistent: boolean,
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
      // A PLAIN ABSENCE IS NOT LOGGED WHEN ABSENCE IS LEGITIMATE. For an
      // OAuth-connected Gemini member there is no key file and never was, so
      // logging one error per spawn would fill the log with a non-event and
      // teach operators to ignore the line that DOES mean something. Every
      // other failure — a directory, a permissions error, an unreadable file —
      // is still reported for both kinds of provider, because none of those is
      // explained by "this member uses the other route".
      if (!absenceIsInconsistent && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
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
