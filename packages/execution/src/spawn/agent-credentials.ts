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
 *
 * Kimi and Groq arrive here automatically, because this type SUBTRACTS github
 * rather than listing members. That is the behaviour we want — they are
 * file-shaped, their credential lives in the same per-identity directory, and
 * the only thing unusual about them is that tm8 wrote the file instead of a
 * vendor CLI. The `satisfies` below is what makes the widening safe rather than
 * silent: adding a provider to `CredentialProvider` fails this file's build
 * until someone states its row here deliberately.
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

  // THE TWO API-KEY BACKENDS. Read `agentTools: []` before anything else here:
  // it is EMPTY ON PURPOSE and it is the most important value in this file.
  //
  // `AGENT_TOOL_CREDENTIAL_PROVIDER` below is built by flat-mapping these
  // arrays into a tool→provider record. Writing `agentTools: ['claude-code']`
  // here — the obvious thing, since Kimi does back Claude Code — would emit a
  // SECOND `claude-code` entry, and the later one wins. Every member on this
  // node would silently resolve `claude-code` to `kimi`, including the ones who
  // never connected it, whose sessions would then find no credential at all.
  // One plausible line, no type error, no failing test, and Anthropic login
  // stops working for everybody.
  //
  // The relation these two need is not the one that table expresses. That table
  // is "the provider this tool NATIVELY authenticates with", which is a
  // property of the tool. Backing is per-MEMBER and conditional: it applies
  // only where a key is connected, and it DISPLACES the native provider rather
  // than replacing it. That lives in `API_KEY_BACKEND_ROUTING`
  // (`credentials/api-key-credentials.ts`), consulted per spawn by the resolver
  // that knows which member is spawning. Here they contribute rows for
  // relocation, node-directory discovery and suppression, and no tool mapping.
  kimi: {
    agentTools: [],
    // Pointed at the DISPLACED vendor's variable, which is not a mistake.
    //
    // A Kimi-backed session runs the `claude` binary, so `CLAUDE_CONFIG_DIR` is
    // the variable that decides where that binary looks — and pointing it at
    // the member's `kimi/` directory is what makes the routing DETERMINISTIC.
    // That directory holds an `api-key` file and no Anthropic login, so the CLI
    // finds no stored OAuth account to prefer and uses the bearer token the
    // composer injects. Leaving it null would let a previously connected
    // Anthropic login in the member's own home quietly outrank the Kimi key
    // they just connected, which is the exact ambiguity this feature exists to
    // avoid.
    configDirVar: 'CLAUDE_CONFIG_DIR',
    // The same node directory as Anthropic, because it is the same binary.
    // A shared value here is a true statement about `claude`, not a collision:
    // this field names where the CLI writes beneath the NODE's home, and the
    // CLI does not change its mind about that because of who is paying for the
    // tokens.
    nodeConfigDir: '.claude',
    // Both Anthropic-precedence names. `ANTHROPIC_API_KEY` for the same
    // measured reason as the Anthropic row above; `ANTHROPIC_AUTH_TOKEN`
    // additionally, because that is the very variable the routing step sets and
    // a node-forwarded one would otherwise be indistinguishable from ours.
    // Suppression runs BEFORE routing in `composeEnv`; see the note in
    // `api-key-credentials.ts` about why that order is load-bearing.
    suppressedEnvKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  },
  groq: {
    agentTools: [],
    configDirVar: 'CODEX_HOME',
    nodeConfigDir: '.codex',
    // `OPENAI_API_KEY` is BOTH the key suppressed here and the key the routing
    // step injects, so this row is only correct because suppression happens
    // first. `OPENAI_BASE_URL` is not listed: routing overwrites it
    // unconditionally, so a forwarded node value cannot survive either way.
    suppressedEnvKeys: ['OPENAI_API_KEY'],
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
  /**
   * The member's API key, present ONLY for an API-key provider WHOSE KEY WAS
   * READABLE.
   *
   * ABSENT IS A MEANINGFUL STATE FOR KIMI AND GROQ, not merely the shape every
   * other provider has. The server returns a KEYLESS home — this provider, this
   * directory, no secret — when an `active` index row's key file cannot be read,
   * and `composeEnv` depends on the difference: the home is still present, so
   * the node's own key is suppressed and the config directory is pinned to the
   * member's, while the routing step is skipped because there is no key to send.
   * The session then fails for want of any credential instead of silently
   * succeeding on the node's. Injecting an empty string here instead would
   * satisfy every type and route the session to Moonshot unauthenticated.
   *
   * THIS IS THE ONE SECRET THAT TRAVELS THROUGH THIS INTERFACE, and it is worth
   * saying why it has to. Every other provider's credential is delivered by
   * POINTING A VARIABLE AT A DIRECTORY the vendor CLI then reads for itself, so
   * the secret never enters the server's memory and `agentCredentialEnv` can
   * stay a pure, synchronous path computation. Kimi and Groq have no CLI to do
   * that reading; the key has to arrive as an environment variable, so somebody
   * has to read the file.
   *
   * The reader is the server's `DbAgentCredentialHome`, which already owns the
   * credential home, its 0700 modes and its identity check — so the read
   * happens in the one place already trusted with that directory, and this
   * interface receives a value rather than growing an async method. It is
   * absent, not empty, for every other provider: `undefined` means "this shape
   * has no inline secret", which is a different statement from "the key is
   * blank" and the routing step treats it as such.
   *
   * It must never be logged. `CredentialSessionLauncher` already declines to log
   * its composed environment for exactly this reason, and that restraint stops
   * being merely prudent the moment this field is populated.
   */
  apiKey?: string;
  /**
   * Set when this home belongs to a SPACE credential (design 01a0cfa8 §4), not
   * the member. `apiKey` here is the space's API key for anthropic/openai: the
   * home is then a per-session directory seeded for that key, and `composeEnv`
   * sets the vendor variable AFTER deleting every node value (I4). Absent for a
   * space LOGIN, whose home is the credential's own login directory.
   */
  space?: { credentialId: string; apiKey?: string };
}

/**
 * The node's own variables a SPACE credential must displace for its provider,
 * deleted before the space value is set (I4). Wider than the member list for
 * anthropic: `ANTHROPIC_AUTH_TOKEN` is a bearer the CLI prefers over an API
 * key, so a node carrying one would outrank the space's key.
 */
export const SPACE_CREDENTIAL_SUPPRESSED_ENV_KEYS: Readonly<
  Partial<Record<AgentCredentialProvider, readonly string[]>>
> = Object.freeze({
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  openai: ['OPENAI_API_KEY'],
});

/** The variable a space API key is delivered in, per provider. */
export const SPACE_CREDENTIAL_API_KEY_ENV: Readonly<
  Partial<Record<AgentCredentialProvider, string>>
> = Object.freeze({
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
});

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
 *
 * It means ONLY that. A member who HAS connected always resolves to a home,
 * even when their stored key turns out to be unreadable — see `apiKey` above.
 * Answering `null` there would leave the node's own key live in the composed
 * environment and run that member's session on the machine account, which is
 * the one outcome this port exists to make impossible.
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
