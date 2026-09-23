// @tm8/execution — the THIRD credential shape: a pasted, API-verified key.
//
// tm8 had two shapes before this file. FILE-shaped providers (anthropic,
// openai, gemini, hermes, cursor) run a vendor OAuth CLI in a login terminal
// and the CLI writes a credential the probe reads back. STRING-shaped GitHub
// runs `gh auth login` and then EXTRACTS a token from the result. Both begin
// with a vendor login command.
//
// KIMI AND GROQ HAVE NO LOGIN COMMAND TO RUN, AND THAT IS A FACT ABOUT THE
// VENDORS RATHER THAN A GAP IN OUR SURVEY.
//
// Both issue a long-lived API key from a web console. Neither publishes a
// device-code flow, a loopback OAuth flow, or any CLI whose `login` verb
// persists a credential this server could probe. Measured 2026-09-20: neither
// vendor ships a first-party CLI to npm at all, and the two obvious package
// names are BOTH FOREIGN SOFTWARE that would authenticate nothing —
//
//   * `groq-cli` is Sanity.io's CLI for GROQ, the Graph-Relational Object
//     Query language (`git+https://github.com/sanity-io/groq-cli.git`). A pure
//     name collision with Groq the inference provider.
//   * `kimi-cli@0.0.2` describes itself as "Quickly generate the project's
//     front-end tools" and has no relationship to Moonshot AI.
//
// Admitting either by plausible package name would have shipped a Connect tile
// whose login terminal installs an unrelated tool and can never succeed. This
// comment exists so that the next person to ask "why isn't there just a CLI
// for these?" gets the measurement instead of repeating it.
//
// SO THE MEMBER PASTES THE KEY, AND THE PASTE IS VERIFIED AGAINST THE VENDOR
// BEFORE IT IS STORED. That verification is not a formality: it is what keeps
// this shape as honest as the other two. A file-existence check would report
// "connected" for a typo. Both vendors answer an unauthenticated model list
// with a clean, distinguishable 401 — measured on this node, same date:
//
//   GET https://api.groq.com/openai/v1/models   → 401 {"code":"invalid_api_key"}
//   GET https://api.moonshot.ai/v1/models       → 401 {"type":"invalid_authentication_error"}
//
// which gives the probe three outcomes that map exactly onto the existing
// honesty doctrine: 200 → `active`, 401 → the key is wrong and must not be
// stored or must be marked stale, anything else (DNS, TLS, 5xx, timeout) →
// `unavailable`, meaning "cannot confirm", never silently "connected".
//
// WHY THESE TWO ARE BACKENDS AND NOT NEW AGENT TOOLS.
//
// `AGENT_TOOL_BINARIES` admits exactly three tools — `claude-code`, `codex` and
// `echo-agent` — and `schemas.ts` pins `agentTool` to the first two. There is
// no Kimi binary and no Groq binary for tm8 to launch, and inventing tool ids
// for CLIs that do not exist would repeat the cursor situation, where a
// provider row exists for a launch path nothing resolves to.
//
// What both vendors DO serve is a wire-compatible endpoint for a CLI tm8
// already launches: Kimi speaks the Anthropic message API, Groq speaks the
// OpenAI one. So a connected key does not add a tool — it points an existing
// tool at a different backend FOR THE MODELS THAT BACKEND SERVES, which is why
// the routing table below names both the tool and the catalog provider.

import { LAUNCH_MODEL_CATALOG, type LaunchModelCatalogEntry } from '@tm8/contract';

import type { CredentialProvider } from './credential-env.js';

/**
 * The providers whose credential is a pasted API key rather than the product of
 * a vendor login command.
 *
 * A union of its own, not a boolean on the main table, because every site that
 * branches on shape should fail to compile when a new one is added rather than
 * fall through a default that silently treats it as file-shaped.
 */
export type ApiKeyCredentialProvider = 'kimi' | 'groq';

export const API_KEY_CREDENTIAL_PROVIDERS: readonly ApiKeyCredentialProvider[] = [
  'kimi',
  'groq',
];

/** Narrowing helper so callers branch on the union rather than on a string. */
export function isApiKeyCredentialProvider(
  provider: string,
): provider is ApiKeyCredentialProvider {
  return (API_KEY_CREDENTIAL_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * The filename a verified key is written to, beneath the member's per-provider
 * credential directory — `<dataDir>/credentials/<identityId>/<provider>/api-key`.
 *
 * A bare file with no envelope, holding the key and a trailing newline. There
 * is no JSON wrapper because there is exactly one field, and a format with one
 * field is a format someone will later add a second field to without migrating
 * the first. The containing directory is already 0700 via `ensureCredentialHome`
 * and the file itself is written 0600 — see the paste harness.
 */
export const API_KEY_FILENAME = 'api-key';

interface ApiKeyProviderDefinition {
  /** What the member sees in the login terminal and on the credential card. */
  readonly displayName: string;
  /** Where the member obtains a key, printed by the paste prompt. */
  readonly consoleUrl: string;
  /**
   * The endpoint the paste harness and the probe both call to verify a key.
   * A model LIST rather than a completion: it costs the member nothing, needs
   * no model name that might be retired, and still requires real authentication.
   */
  readonly verifyUrl: string;
  /**
   * The key prefix, used ONLY to catch an obvious paste error before spending a
   * network round trip — a copied console URL, or the other vendor's key.
   *
   * Deliberately advisory: a prefix check is not authentication, the vendors may
   * change it, and the 401 above is the real answer. A mismatch therefore warns
   * and still verifies rather than refusing outright.
   */
  readonly keyPrefix: string;
}

const API_KEY_PROVIDER_DEFINITIONS = {
  kimi: {
    displayName: 'Kimi (Moonshot AI)',
    consoleUrl: 'https://platform.moonshot.ai/console/api-keys',
    verifyUrl: 'https://api.moonshot.ai/v1/models',
    keyPrefix: 'sk-',
  },
  groq: {
    displayName: 'Groq',
    consoleUrl: 'https://console.groq.com/keys',
    verifyUrl: 'https://api.groq.com/openai/v1/models',
    keyPrefix: 'gsk_',
  },
} as const satisfies Record<ApiKeyCredentialProvider, ApiKeyProviderDefinition>;

export const API_KEY_PROVIDER_DISPLAY_NAME: Readonly<
  Record<ApiKeyCredentialProvider, string>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(API_KEY_PROVIDER_DEFINITIONS).map(([p, d]) => [p, d.displayName]),
  ),
) as Readonly<Record<ApiKeyCredentialProvider, string>>;

export const API_KEY_PROVIDER_CONSOLE_URL: Readonly<
  Record<ApiKeyCredentialProvider, string>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(API_KEY_PROVIDER_DEFINITIONS).map(([p, d]) => [p, d.consoleUrl]),
  ),
) as Readonly<Record<ApiKeyCredentialProvider, string>>;

export const API_KEY_PROVIDER_VERIFY_URL: Readonly<
  Record<ApiKeyCredentialProvider, string>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(API_KEY_PROVIDER_DEFINITIONS).map(([p, d]) => [p, d.verifyUrl]),
  ),
) as Readonly<Record<ApiKeyCredentialProvider, string>>;

export const API_KEY_PROVIDER_KEY_PREFIX: Readonly<
  Record<ApiKeyCredentialProvider, string>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(API_KEY_PROVIDER_DEFINITIONS).map(([p, d]) => [p, d.keyPrefix]),
  ),
) as Readonly<Record<ApiKeyCredentialProvider, string>>;

// ---------------------------------------------------------------------------
// ROUTING — which existing agent tool a connected key redirects, and how.
// ---------------------------------------------------------------------------

interface ApiKeyBackendRouting {
  /** The already-launchable tool this key backs. */
  readonly agentTool: string;
  /**
   * The `LAUNCH_MODEL_CATALOG` provider whose models this key serves. A
   * session is routed here only when its model is one of those rows.
   */
  readonly servesCatalogProvider: LaunchModelCatalogEntry['provider'];
  /**
   * The native provider of `agentTool`: the one that keeps serving every
   * OTHER model on that tool. Named on the card so the member reads that their
   * native login is still in use.
   */
  readonly nativeProvider: CredentialProvider;
  /** Base-URL variable for the tool's vendor SDK. */
  readonly baseUrlVar: string;
  readonly baseUrl: string;
  /** The variable carrying the key itself. */
  readonly keyVar: string;
}

// NOTE ON WHAT IS DELIBERATELY ABSENT HERE: the node-key suppression list.
//
// It belongs to `AGENT_CREDENTIAL_SUPPRESSED_ENV_KEYS` in
// `spawn/agent-credentials.ts`, which already holds one row per provider and
// which `composeEnv` already applies. Repeating it here would create two lists
// that must agree, and for Groq the two would have to disagree in a way nobody
// could see: its suppression list and its injection variable are BOTH
// `OPENAI_API_KEY`, so the only thing keeping the injection alive is ORDER —
// suppression first, routing last. Ordering is a property of the composer, not
// of a facts table, so the composer owns it.

/**
 * Which backend each pasted key serves, and for which models.
 *
 * ROUTING IS PER MODEL, NOT PER ACCOUNT. A Kimi key serves the Kimi models in
 * the launch catalog (`provider: 'moonshot'`) and nothing else: a `claude-code`
 * session launched on a Claude model keeps authenticating with the member's
 * Anthropic login whether or not a Kimi key is connected, and a session
 * launched on a Kimi model uses the Kimi key and never the Anthropic login.
 * The same holds for Groq and `codex`/OpenAI. See `apiKeyBackendForModel`.
 *
 * This replaced an account-wide override (#638) under which a connected Kimi
 * key outranked the Anthropic login for EVERY `claude-code` session. That sent
 * `claude --model claude-opus-…` to Moonshot, a server that does not serve it,
 * and sent a Kimi model to Anthropic whenever the key was not connected.
 */
const API_KEY_BACKEND_ROUTING = {
  kimi: {
    agentTool: 'claude-code',
    servesCatalogProvider: 'moonshot',
    nativeProvider: 'anthropic',
    // Moonshot serves an Anthropic-wire-compatible surface at this path; the
    // plain `/v1` base is the OpenAI-compatible one and is NOT what Claude Code
    // speaks. Pointing the Anthropic SDK at `/v1` yields 404s on every message.
    baseUrlVar: 'ANTHROPIC_BASE_URL',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    // `ANTHROPIC_AUTH_TOKEN`, not `ANTHROPIC_API_KEY`: the SDK sends the former
    // as a bearer `Authorization` header, which is what a third-party
    // Anthropic-compatible endpoint authenticates, while the latter goes out as
    // the vendor-specific `x-api-key` header.
    keyVar: 'ANTHROPIC_AUTH_TOKEN',
  },
  groq: {
    agentTool: 'codex',
    servesCatalogProvider: 'groq',
    nativeProvider: 'openai',
    baseUrlVar: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyVar: 'OPENAI_API_KEY',
  },
} as const satisfies Record<ApiKeyCredentialProvider, ApiKeyBackendRouting>;

/**
 * The API-key backends that serve some of `agentTool`'s models. Which one a
 * given session uses is decided by its model; see `apiKeyBackendForModel`.
 *
 * A list rather than a single value so a second Anthropic-compatible vendor is
 * an added entry rather than a restructure. Today each tool has exactly one.
 */
export function apiKeyBackendsForAgentTool(
  agentTool: string | null | undefined,
): readonly ApiKeyCredentialProvider[] {
  if (!agentTool) return [];
  return API_KEY_CREDENTIAL_PROVIDERS.filter(
    (provider) => API_KEY_BACKEND_ROUTING[provider].agentTool === agentTool,
  );
}

/**
 * The API-key backend that must serve `model` on `agentTool`, or null when the
 * tool's native provider serves it.
 *
 * Decided by the launch catalog: a model is a Kimi model because its catalog
 * row says `provider: 'moonshot'`, not because of how its id is spelled. Groq's
 * ids have no common prefix (`llama-3.3-70b-versatile`, `qwen/qwen3-32b`), so
 * a spelling rule could not work for both backends anyway.
 *
 * A model that is not in the catalog, or no model at all (the CLI's own
 * default), resolves to null — the native provider — because the native
 * provider is the one that serves the tool's own default model. The row's
 * `agentTool` must match too: a catalog model launched on a tool that cannot
 * speak its backend's wire protocol is not rerouted by guessing.
 */
export function apiKeyBackendForModel(
  agentTool: string | null | undefined,
  model: string | null | undefined,
): ApiKeyCredentialProvider | null {
  if (!agentTool || !model) return null;
  const entry = LAUNCH_MODEL_CATALOG.find((row) => row.model === model);
  if (!entry || entry.agentTool !== agentTool) return null;
  return API_KEY_CREDENTIAL_PROVIDERS.find((provider) => {
    const routing = API_KEY_BACKEND_ROUTING[provider];
    return routing.agentTool === agentTool
      && routing.servesCatalogProvider === entry.provider;
  }) ?? null;
}

/** The native provider that keeps serving `provider`'s tool for other models. */
export function apiKeyBackendNativeProvider(
  provider: ApiKeyCredentialProvider,
): CredentialProvider {
  return API_KEY_BACKEND_ROUTING[provider].nativeProvider;
}

/** The tool a connected `provider` key runs its models on, for display. */
export function apiKeyBackendAgentTool(provider: ApiKeyCredentialProvider): string {
  return API_KEY_BACKEND_ROUTING[provider].agentTool;
}

/**
 * The environment fragment that points an agent tool at an API-key backend.
 *
 * Takes the key as a VALUE rather than reading the file itself: this module is
 * pure vendor facts, and a secret read belongs to the server layer that already
 * owns the member's credential home and its permissions. That also keeps the
 * function synchronous, which is what lets `composeEnv` stay synchronous.
 */
export function apiKeyBackendEnv(
  provider: ApiKeyCredentialProvider,
  apiKey: string,
): Record<string, string> {
  const routing = API_KEY_BACKEND_ROUTING[provider];
  return {
    [routing.baseUrlVar]: routing.baseUrl,
    [routing.keyVar]: apiKey,
  };
}
