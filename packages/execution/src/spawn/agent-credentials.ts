// @tm8/execution — the READ half of per-member credential delivery.
//
// PR2 built the WRITE half: a login terminal runs in `composeCredentialEnv`,
// with its config-dir variable pointed at
// `<dataDir>/credentials/<identityId>/<provider>/`, and the vendor CLI writes
// its `.credentials.json` there. This file is what makes an ORDINARY agent
// session read that same directory, so the member's own login is the one their
// agent authenticates with instead of the node's.
//
// THE DIRECTORY LAYOUT IS PR2's, NOT A SECOND CONVENTION. Nothing here builds
// a path. `homeDir` and `configDir` arrive already resolved by the server's
// `agent-credential-home.ts`, which is the single place that knows the layout.
// A second path builder would be a second convention, and the two would drift
// the first time either moved — with the failure mode "the agent silently
// authenticates as the node" rather than an error.
//
// WHY THIS IS A SEPARATE MODULE FROM `credential-env.ts`.
// The provider→variable table below is deliberately NOT imported from PR2's
// `CREDENTIAL_CONFIG_DIR_VAR`. That module already imports `withAgentBinDirs`
// from `manifest.ts`, and `manifest.ts` needs this table — so importing it back
// would close an import cycle through the two files that must stay independent.
// The duplication is guarded instead of avoided: `agent-credentials.test.ts`
// imports BOTH tables and asserts they agree on the two shared providers, so
// "two tables" can never quietly become "two conventions".

import type { GraphAuth } from './types.js';

/**
 * The providers an ORDINARY agent session can be given a credential for.
 *
 * TWO, out of the five a member can now LOG IN to. The two lists are different
 * on purpose and the difference is not an oversight:
 *
 *  * `github` is string-shaped and already ships through
 *    `account_git_credentials` as env-var injection (sub-doc 0, and §A5's
 *    split-by-shape rule). Adding it here would be a SECOND GitHub delivery
 *    mechanism racing the first, and the shipped one carries the load-bearing
 *    empty-value helper reset that stops a machine-wide credential helper
 *    answering with somebody else's login.
 *
 *  * `gemini` and `hermes` are admitted as LOGIN providers (migration 123) but
 *    NOT yet as spawn-time injections. Login and injection are separate
 *    admissions with separate evidence: login needed a verb and a probe, both
 *    of which gemini now has. Injection additionally needs the API-KEY
 *    PRECEDENCE measurement that finding C8 / ruling 13 forced for anthropic —
 *    whether a node-level `GEMINI_API_KEY` or `GOOGLE_API_KEY` silently
 *    outranks a member's stored login, exactly as `ANTHROPIC_API_KEY` was
 *    measured to do. Until someone runs that experiment, suppressing those keys
 *    would be a guess and NOT suppressing them would risk the member's session
 *    quietly authenticating as the node. So a member can connect a Google
 *    account here and see it on the card, and a spawned gemini agent still uses
 *    whatever the node uses. That is the honest intermediate state, and it is
 *    the one thing on this surface that a reader should not mistake for done.
 */
export type AgentCredentialProvider = 'anthropic' | 'openai';

/**
 * Which vendor credential an agent tool actually authenticates with.
 *
 * Keyed on the resolved `launch.tool` string rather than a union, because that
 * is what `Tm8Manifest` carries and it also admits `echo-agent` and any
 * operator-configured tool — both of which correctly resolve to "no provider"
 * and therefore to no injection at all.
 */
export const AGENT_TOOL_CREDENTIAL_PROVIDER: Readonly<Record<string, AgentCredentialProvider>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};

/**
 * The ONE variable that redirects each tool's credential lookup.
 *
 * `CLAUDE_CONFIG_DIR` REPLACES Claude's default config location and alone
 * decides it — verified in both directions, including a positive control, so it
 * may be relied on rather than belt-and-braced with a second mechanism.
 */
export const AGENT_CREDENTIAL_CONFIG_DIR_VAR = {
  anthropic: 'CLAUDE_CONFIG_DIR',
  openai: 'CODEX_HOME',
} as const satisfies Record<AgentCredentialProvider, string>;

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
 * member who has not connected keeps today's behaviour byte for byte, and
 * `GEMINI_API_KEY` / `GOOGLE_API_KEY` are untouched. Ruling 6's original reason
 * ("no gemini provider is admitted") expired with migration 123, which admits
 * gemini as a LOGIN provider; the conclusion survives on the narrower ground
 * above — gemini is not a spawn-time injection, so there is no member
 * credential here for a node key to outrank yet. Do not generalise this beyond
 * the injected set.
 *
 * Deliberately NOT a fallback: a stale member credential must fail visibly and
 * attributably ("reconnect your Anthropic account"), never quietly revert to
 * the node's key at the moment the member is least able to notice.
 */
export const AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
} as const satisfies Record<AgentCredentialProvider, readonly string[]>;

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
  /** `<homeDir>/<provider>` — the vendor CLI's config directory. */
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
 */
export function agentCredentialEnv(home: AgentCredentialHome): Record<string, string> {
  return {
    [AGENT_CREDENTIAL_CONFIG_DIR_VAR[home.provider]]: home.configDir,
    XDG_CONFIG_HOME: agentCredentialXdgConfigHome(home.homeDir),
  };
}
