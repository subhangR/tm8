// @tm8/execution — the READ half of per-member credential delivery.
//
// PR2 built the WRITE half: a login terminal runs in `composeCredentialEnv`
// with either its config-dir variable or its whole HOME pointed into
// `<dataDir>/credentials/<identityId>/`, and the vendor CLI writes there. This
// file makes an ORDINARY agent session use the same relocation mechanism, so
// the member's own login is the one their agent authenticates with instead of
// the node's.
//
// THE INJECTION DIRECTORY LAYOUT IS PR2's, NOT A SECOND CONVENTION. `homeDir`
// and `configDir` arrive already resolved by the server's
// `agent-credential-home.ts`, which is the single place that builds that
// layout. The node config-directory names below are separate vendor facts used
// only by the finite transcript search; they do not construct a second member
// credential home. Duplicating that builder would drift with the failure mode
// "the agent silently authenticates as the node" rather than an error.
//
// WHY THIS IS A SEPARATE MODULE FROM `credential-env.ts`.
// The provider→variable table below is deliberately NOT imported from PR2's
// `CREDENTIAL_CONFIG_DIR_VAR`. That module already imports `withAgentBinDirs`
// from `manifest.ts`, and `manifest.ts` needs this table — so importing it back
// would close an import cycle through the two files that must stay independent.
// The duplication is guarded instead of avoided: `agent-credentials.test.ts`
// imports BOTH tables and asserts they agree on every shared provider, so
// "two tables" can never quietly become "two conventions".

import type { CredentialProvider, GraphAuth } from './types.js';

/**
 * The providers an ORDINARY agent session can be given a credential for.
 *
 * Every FILE-shaped provider, and deliberately not `github`. GitHub already
 * ships through `account_git_credentials` as string-shaped env-var injection
 * (sub-doc 0, and §A5's split-by-shape rule). Adding it here would be a SECOND
 * GitHub delivery mechanism racing the first, and the shipped one carries the
 * load-bearing empty-value helper reset that stops a machine-wide credential
 * helper answering with somebody else's login.
 *
 * Gemini, Hermes and Cursor are HOME-shaped rather than config-variable-
 * shaped. They still belong in this set: the HOME redirection in
 * `agentCredentialEnv` below is what makes the login terminal's write and the
 * ordinary spawned agent's read meet at the same member-owned directory.
 */
export type AgentCredentialProvider = Exclude<CredentialProvider, 'github'>;

interface AgentCredentialProviderDefinition {
  readonly agentTools: readonly string[];
  readonly configDirVar: string | null;
  readonly nodeConfigDir: string;
  readonly suppressedEnvKeys: readonly string[];
}

/**
 * The one provider table behind tool routing, relocation, node-directory
 * discovery and node-key suppression. A new FILE-shaped provider gets one row;
 * every public projection below then changes together.
 */
const AGENT_CREDENTIAL_PROVIDER_DEFINITIONS = {
  anthropic: {
    agentTools: ['claude-code'],
    configDirVar: 'CLAUDE_CONFIG_DIR',
    nodeConfigDir: '.claude',
    suppressedEnvKeys: ['ANTHROPIC_API_KEY'],
  },
  openai: {
    agentTools: ['codex'],
    configDirVar: 'CODEX_HOME',
    nodeConfigDir: '.codex',
    suppressedEnvKeys: ['OPENAI_API_KEY'],
  },
  gemini: {
    agentTools: ['gemini'],
    configDirVar: null,
    nodeConfigDir: '.gemini',
    suppressedEnvKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  },
  hermes: {
    agentTools: ['hermes'],
    configDirVar: null,
    nodeConfigDir: '.hermes',
    // No key name has been measured for Hermes. Inventing one would suppress a
    // variable that may not exist while leaving the real precedence key live.
    suppressedEnvKeys: [],
  },
  cursor: {
    // `cursor` is the launch-layer tool id, while its executable is
    // `cursor-agent`. No supported launch tool currently resolves to this id:
    // model inference and the spawn binary table have no Cursor entry yet.
    // This mapping is ready for that separately admitted launch path rather
    // than pretending one exists now.
    agentTools: ['cursor'],
    configDirVar: null,
    nodeConfigDir: '.cursor',
    suppressedEnvKeys: ['CURSOR_API_KEY'],
  },
} as const satisfies Record<AgentCredentialProvider, AgentCredentialProviderDefinition>;

function mapAgentCredentialProviders<Value>(
  select: (definition: AgentCredentialProviderDefinition) => Value,
): Record<AgentCredentialProvider, Value> {
  return Object.fromEntries(
    (Object.entries(AGENT_CREDENTIAL_PROVIDER_DEFINITIONS) as Array<
      [AgentCredentialProvider, AgentCredentialProviderDefinition]
    >).map(([provider, definition]) => [provider, select(definition)]),
  ) as Record<AgentCredentialProvider, Value>;
}

/**
 * Which vendor credential an agent tool actually authenticates with.
 *
 * Keyed on the resolved `launch.tool` string rather than a union, because that
 * is what `Tm8Manifest` carries and it also admits `echo-agent` and any
 * operator-configured tool — both of which correctly resolve to "no provider"
 * and therefore to no injection at all.
 */
export const AGENT_TOOL_CREDENTIAL_PROVIDER: Readonly<Record<string, AgentCredentialProvider>> =
  Object.freeze(Object.fromEntries(
    (Object.entries(AGENT_CREDENTIAL_PROVIDER_DEFINITIONS) as Array<
      [AgentCredentialProvider, AgentCredentialProviderDefinition]
    >).flatMap(([provider, definition]) =>
      definition.agentTools.map((agentTool) => [agentTool, provider]),
    ),
  ));

/**
 * The ONE variable that redirects each tool's credential lookup, or `null`
 * when the CLI offers no override and must instead be isolated through HOME.
 *
 * `CLAUDE_CONFIG_DIR` REPLACES Claude's default config location and alone
 * decides it — verified in both directions, including a positive control, so it
 * may be relied on rather than belt-and-braced with a second mechanism.
 */
export const AGENT_CREDENTIAL_CONFIG_DIR_VAR: Readonly<
  Record<AgentCredentialProvider, string | null>
> = Object.freeze(mapAgentCredentialProviders((definition) => definition.configDirVar));

/**
 * The finite config-directory name each CLI uses beneath the node's real HOME.
 * Member directories use the same name only for HOME-scoped providers; a CLI
 * with a config-dir variable instead reads `<credential-home>/<provider>`.
 */
export const AGENT_CREDENTIAL_NODE_CONFIG_DIR: Readonly<
  Record<AgentCredentialProvider, string>
> = Object.freeze(mapAgentCredentialProviders((definition) => definition.nodeConfigDir));

/**
 * The node's OWN key for a provider, which must be removed from a session that
 * carries the member's credential instead — finding C8, architect ruling 13.
 *
 * MEASURED, not inferred (`claude auth status`, synthetic credentials, real
 * CLI): with `CLAUDE_CONFIG_DIR` pointed at an identity home AND the server's
 * `ANTHROPIC_API_KEY` forwarded, the CLI reports
 * `apiKeySource: "ANTHROPIC_API_KEY"` — and with an EMPTY identity home it
 * reports `authMethod: "api_key"` outright. So a node-level key silently
 * outranks, or at minimum competes with, the member's own login. That is C5's
 * shape one channel over: an allowlist copies something with higher precedence
 * out of the server environment, and it is latent only while the variable
 * happens to be unset on the deployed unit.
 *
 * An agent environment therefore never carries two competing credentials for
 * one provider. The suppression is scoped to the connected provider ONLY: a
 * member who has not connected keeps today's behaviour byte for byte. Gemini's
 * two measured key names and Cursor's measured key name are now suppressed for
 * their own member credential; Hermes remains empty because no key name has
 * been measured and a plausible guess would provide no isolation guarantee.
 *
 * Deliberately NOT a fallback: a stale member credential must fail visibly and
 * attributably ("reconnect your Anthropic account"), never quietly revert to
 * the node's key at the moment the member is least able to notice.
 */
export const AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS: Readonly<
  Record<AgentCredentialProvider, readonly string[]>
> = Object.freeze(mapAgentCredentialProviders((definition) => definition.suppressedEnvKeys));

/** The provider `agentTool` authenticates with, or null when it needs none. */
export function agentCredentialProviderFor(
  agentTool: string | null | undefined,
): AgentCredentialProvider | null {
  if (!agentTool) return null;
  return AGENT_TOOL_CREDENTIAL_PROVIDER[agentTool] ?? null;
}

/**
 * One identity's resolved credential home, as the server hands it to the spawn
 * loop. Both paths come from `agent-credential-home.ts`; see the header.
 */
export interface AgentCredentialHome {
  provider: AgentCredentialProvider;
  /** `<dataDir>/credentials/<identityId>` — the identity's credential home. */
  homeDir: string;
  /** `<homeDir>/<provider>` — used by CLIs with a config-directory override. */
  configDir: string;
}

/**
 * How the spawn loop asks whether the spawning identity has a credential to
 * inject for a given agent tool.
 *
 * OPTIONAL on `SpawnService` by design. A node with no credential wiring
 * resolves nothing and behaves exactly as it did before, which is what keeps
 * this change safe to land ahead of the settings screen that populates it.
 *
 * `null` means "this identity has not connected this provider" and is the
 * ordinary answer, not an error: injecting an EMPTY per-identity config
 * directory would leave every member who has not connected with no agent
 * authentication at all.
 */
export interface AgentCredentialHomePort {
  resolve(
    auth: GraphAuth,
    input: { agentTool: string },
  ): Promise<AgentCredentialHome | null>;
}

/**
 * `XDG_CONFIG_HOME` for an identity's credential home — sub-doc 14's channel C5.
 *
 * A per-identity `HOME` is NOT sufficient, and this is the reason: `gh`
 * resolves its config directory as `GH_CONFIG_DIR` > `$XDG_CONFIG_HOME/gh` >
 * `$HOME/.config/gh`. With `XDG_CONFIG_HOME` inherited from the server process,
 * the middle rung wins and points at the NODE's `gh` credentials no matter what
 * `HOME` says. Pointing it inside the identity's own home means even the
 * fallback rung lands somewhere that belongs to this member.
 *
 * The same path `composeCredentialEnv` computes for a login terminal, so the
 * terminal that WRITES and the agent that READS agree on one directory.
 */
export function agentCredentialXdgConfigHome(homeDir: string): string {
  return `${homeDir}/.config`;
}

/**
 * The environment fragment that delivers one identity's credential to an agent.
 *
 * Returned as a record rather than mutating an env in place so that the exact
 * set of keys this feature adds is a value a test can assert on directly —
 * an allowlist regression is invisible to a per-name assertion.
 *
 * HOME IS THE ISOLATION BOUNDARY for Gemini, Hermes and Cursor because those
 * CLIs have no config-directory environment variable. It is set only for those
 * providers: Claude and Codex retain the node's real HOME byte for byte and use
 * their dedicated override instead. The cost is real and intentional: a
 * long-lived HOME-redirected agent loses the node's `~/.gitconfig`, npm/pnpm
 * caches, and anything else beneath the real home. That is the price of
 * preventing a HOME-only vendor from silently reading the node's credential.
 */
export function agentCredentialEnv(home: AgentCredentialHome): Record<string, string> {
  const configDirVar = AGENT_CREDENTIAL_CONFIG_DIR_VAR[home.provider];
  if (configDirVar === null) {
    return {
      HOME: home.homeDir,
      XDG_CONFIG_HOME: agentCredentialXdgConfigHome(home.homeDir),
    };
  }
  return {
    [configDirVar]: home.configDir,
    XDG_CONFIG_HOME: agentCredentialXdgConfigHome(home.homeDir),
  };
}
