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
// OpenAI one. So a connected key does not add a tool — it REDIRECTS an existing
// tool at a different backend, which is why the routing table below is keyed by
// `agentTool` and not by provider.

import type { CredentialProvider } from './credential-env.js';

/**
 * The providers whose credential is a pasted API key rather than the product of
 * a vendor login command.
 *
 * A union of its own, not a boolean on the main table, because every site that
 * branches on shape should fail to compile when a new one is added rather than
 * fall through a default that silently treats it as file-shaped.
 */
export type ApiKeyCredentialProvider = 'kimi' | 'groq' | 'grok' | 'gemini';

/**
 * THIS ARRAY'S ORDER IS THE PRECEDENCE RULE, and it is load-bearing.
 *
 * `apiKeyBackendsForAgentTool` filters this list, and the resolver takes the
 * first ACTIVE entry, so when two backends serve one tool the earlier one wins.
 * Two do now: `groq` and `grok` both back `codex`.
 *
 * `groq` stays ahead of `grok` for one reason, and it is not preference —
 * ADDING A BACKEND MUST NOT CHANGE WHERE AN EXISTING MEMBER'S SESSIONS GO. A
 * member who connected Groq before Grok existed has `codex` pointed at
 * api.groq.com; inserting Grok above it would silently move every one of those
 * sessions to x.ai on deploy, with no action by the member and nothing in the
 * product that changed. Appending cannot do that. The same rule binds the next
 * backend added here: it goes on the END.
 *
 * Deterministic is not the same as discoverable, so the losing card SAYS it is
 * losing — see `apiKeyBackendOutrankedBy` and `CredentialRoutingView.outrankedBy`.
 * A member choosing between two connected backends is a picker this codebase
 * does not have yet; until it does, the rule is fixed and visible rather than
 * fixed and hidden.
 *
 * MEMBERSHIP OF THIS LIST NO LONGER IMPLIES BACKEND-HOOD, AND THAT IS THE POINT
 * OF `gemini` BEING IN IT.
 *
 * This union used to fuse two independent facts, because until now they always
 * travelled together: "the credential is a key the member pastes, stored by
 * tm8" and "connecting it redirects some other provider's agent tool". Gemini
 * has the first and not the second. It is the NATIVE provider of the `gemini`
 * tool — see `agentTools: ['gemini']` in `spawn/agent-credentials.ts` — so it
 * displaces nobody and outranks nobody; it simply has a second way to
 * authenticate that tm8 could not previously accept.
 *
 * So `API_KEY_BACKEND_ROUTING` is now `Record<…, ApiKeyBackendRouting | null>`,
 * and `gemini` holds a REQUIRED null rather than being absent from the table.
 * Required-and-nullable for the same reason `CredentialRoutingView.outrankedBy`
 * is: an omitted key is indistinguishable from a forgotten one, while an
 * explicit `null` is a statement the next person has to make on purpose. Every
 * site that read routing off an api-key provider now has to answer "and if it
 * backs nothing?", which is exactly the question that was previously being
 * answered by accident.
 */
export const API_KEY_CREDENTIAL_PROVIDERS: readonly ApiKeyCredentialProvider[] = [
  'kimi',
  'groq',
  'grok',
  // Appended, under the rule stated above. It changes no existing precedence:
  // it backs no tool, so it never appears in `apiKeyBackendsForAgentTool`.
  'gemini',
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
  /**
   * HOW the key is presented to `verifyUrl`. Not cosmetic — sending the wrong
   * one is an authentication failure that looks exactly like a bad key.
   *
   * `bearer` is `Authorization: Bearer <key>`, which the three OpenAI- and
   * Anthropic-wire vendors accept. Google does not: its public generative
   * endpoint takes `x-goog-api-key`, measured in the installed
   * `@google/gemini-cli` 0.58.0 bundle, which references `x-goog-api-key`
   * alongside `generativelanguage.googleapis.com` and never a bearer header for
   * that host. A Gemini key sent as a bearer token 401s, and the probe would
   * then report a working key as rejected.
   */
  readonly verifyAuth: 'bearer' | 'x-goog-api-key';
  /**
   * The variable the provider's OWN CLI reads to pick up a pasted key, or null
   * when no such CLI exists.
   *
   * Distinct from `ApiKeyBackendRouting.keyVar`, which names the variable of the
   * tool being REDIRECTED. For a backend the two differ by nature — Kimi's key
   * goes out as `ANTHROPIC_AUTH_TOKEN` because it is impersonating Anthropic's
   * wire. For a native provider there is nothing to impersonate, so the key
   * travels under the vendor's own name.
   */
  readonly keyEnvVar: string | null;
}

const API_KEY_PROVIDER_DEFINITIONS = {
  kimi: {
    displayName: 'Kimi (Moonshot AI)',
    consoleUrl: 'https://platform.moonshot.ai/console/api-keys',
    verifyUrl: 'https://api.moonshot.ai/v1/models',
    keyPrefix: 'sk-',
    verifyAuth: 'bearer',
    // No Moonshot CLI exists; the key only ever travels as a backend override.
    keyEnvVar: null,
  },
  groq: {
    displayName: 'Groq',
    consoleUrl: 'https://console.groq.com/keys',
    verifyUrl: 'https://api.groq.com/openai/v1/models',
    keyPrefix: 'gsk_',
    verifyAuth: 'bearer',
    keyEnvVar: null,
  },
  // GROK IS xAI, AND IT IS NOT GROQ. The two names differ by one transposed
  // letter, serve different companies, and both speak an OpenAI-compatible
  // wire — which is exactly the combination that produces a key pasted into
  // the wrong card. The prefixes are the cheap guard: an `xai-` key in the
  // Groq terminal and a `gsk_` key here each trip the advisory mismatch
  // warning before the request is spent. The display name carries the vendor
  // so the two cards are never distinguished by spelling alone.
  grok: {
    displayName: 'Grok (xAI)',
    consoleUrl: 'https://console.x.ai/team/default/api-keys',
    verifyUrl: 'https://api.x.ai/v1/models',
    keyPrefix: 'xai-',
    verifyAuth: 'bearer',
    keyEnvVar: null,
  },
  // THE FIRST NATIVE PROVIDER IN THIS TABLE, and every field below differs from
  // the three above for that reason rather than by vendor accident.
  //
  // Gemini was already a tm8 provider, and it was already broken here. The CLI
  // it wraps supports FOUR auth modes — measured in the installed
  // `@google/gemini-cli` 0.58.0 bundle, whose auth enum carries
  // `LOGIN_WITH_GOOGLE`, `USE_GEMINI`, `USE_VERTEX_AI` and `CLOUD_SHELL` — and
  // tm8's probe recognised exactly one of them, by looking for the
  // `.gemini/oauth_creds.json` that only `LOGIN_WITH_GOOGLE` writes. A member
  // authenticating the documented `USE_GEMINI` way, with an AI Studio key, was
  // told their credential state was unknown forever, because a `stale` probe
  // persists no row. This entry is the missing second mode.
  //
  // `verifyUrl` is the PUBLIC, documented generative endpoint. It is emphatically
  // not `cloudcode-pa.googleapis.com/v1internal`, which is what the third-party
  // Antigravity bridges call — that route requires shipping Google's extracted
  // OAuth client secret and spoofing a first-party IDE User-Agent, and tm8 will
  // not do either.
  //
  // `keyPrefix` is `AIza`, the Google API-key prefix. Note it is shared with
  // other Google API keys, so it is even weaker evidence than the vendor-unique
  // prefixes above — which only makes the advisory-not-authoritative rule on
  // `keyPrefix` more important here, not less.
  gemini: {
    displayName: 'Gemini',
    consoleUrl: 'https://aistudio.google.com/apikey',
    verifyUrl: 'https://generativelanguage.googleapis.com/v1beta/models',
    keyPrefix: 'AIza',
    verifyAuth: 'x-goog-api-key',
    // `GEMINI_API_KEY` over `GOOGLE_API_KEY`: the bundle reads both, but the
    // former is Gemini-specific while the latter is a general Google variable
    // that may already be set in the environment for an unrelated service.
    // Writing the specific one cannot collide with something else's credential.
    keyEnvVar: 'GEMINI_API_KEY',
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

/** How each provider's key is presented to its verify endpoint. */
export const API_KEY_PROVIDER_VERIFY_AUTH: Readonly<
  Record<ApiKeyCredentialProvider, 'bearer' | 'x-goog-api-key'>
> = Object.freeze(
  Object.fromEntries(
    Object.entries(API_KEY_PROVIDER_DEFINITIONS).map(([p, d]) => [p, d.verifyAuth]),
  ),
) as Readonly<Record<ApiKeyCredentialProvider, 'bearer' | 'x-goog-api-key'>>;

/**
 * The header a verified key is presented under, built from `verifyAuth` so the
 * probe and the paste harness cannot drift apart into two spellings of it.
 */
export function apiKeyVerifyHeaders(
  provider: ApiKeyCredentialProvider,
  apiKey: string,
): Record<string, string> {
  const base = { Accept: 'application/json' };
  return API_KEY_PROVIDER_VERIFY_AUTH[provider] === 'x-goog-api-key'
    ? { ...base, 'x-goog-api-key': apiKey }
    : { ...base, Authorization: `Bearer ${apiKey}` };
}

// ---------------------------------------------------------------------------
// ROUTING — which existing agent tool a connected key redirects, and how.
// ---------------------------------------------------------------------------

interface ApiKeyBackendRouting {
  /** The already-launchable tool this key backs. */
  readonly agentTool: string;
  /** The provider this key DISPLACES when connected. */
  readonly displaces: CredentialProvider;
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
 * The account-wide backend override, by agent tool.
 *
 * ACCOUNT-WIDE IS A DELIBERATE PRODUCT CHOICE AND IT IS NOT SILENT. A member
 * who connects Kimi has every `claude-code` session routed to Kimi, not just
 * new ones they opt in per session. That is what makes "connect" mean
 * something without a picker in every launch surface — but it also means the
 * model behind an existing workflow changes the moment a key is pasted, so
 * `credentials.status` reports the displacement in words and the credential
 * card states it on the tile. An override the member cannot see is the failure
 * mode this note exists to prevent; disconnecting the key restores the native
 * provider with no other action.
 *
 * Keyed by tool rather than by provider because the relation is many-to-one in
 * that direction: `AGENT_TOOL_CREDENTIAL_PROVIDER` already maps each tool to
 * its NATIVE provider, and this table names the alternative that outranks it.
 */
const API_KEY_BACKEND_ROUTING = {
  kimi: {
    agentTool: 'claude-code',
    displaces: 'anthropic',
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
    displaces: 'openai',
    baseUrlVar: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyVar: 'OPENAI_API_KEY',
  },
  // THE SECOND BACKEND ON ONE TOOL. Every field below matches the Groq row
  // except the base URL, and that is the whole point: both vendors serve an
  // OpenAI-compatible surface, so both redirect `codex` by rewriting the same
  // two variables. Nothing here decides which of them wins — that is
  // `API_KEY_CREDENTIAL_PROVIDERS` order, documented at the top of this file,
  // and it is reported to the member through `outrankedBy` rather than left to
  // be discovered.
  //
  // `https://api.x.ai/v1` is the OpenAI-compatible base. xAI also publishes an
  // Anthropic-compatible surface; it is deliberately NOT used here, because the
  // tool being redirected is `codex`, which speaks OpenAI. Pointing an
  // Anthropic-shaped path at the OpenAI SDK is the Moonshot mistake documented
  // on the `kimi` row above, in the other direction.
  grok: {
    agentTool: 'codex',
    displaces: 'openai',
    baseUrlVar: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    keyVar: 'OPENAI_API_KEY',
  },
  // BACKS NOTHING, ON PURPOSE. Gemini is the native provider of the `gemini`
  // tool, so there is no tool of someone else's to redirect and nobody to
  // displace. A pasted Gemini key changes which credential the `gemini` tool
  // authenticates with; it does not change WHICH tool runs, which is the only
  // thing this table describes.
  //
  // Spelled as an explicit null rather than omitted: see the note on
  // `API_KEY_CREDENTIAL_PROVIDERS`. Omission would make "native provider" and
  // "somebody forgot a row" the same shape.
  gemini: null,
} as const satisfies Record<ApiKeyCredentialProvider, ApiKeyBackendRouting | null>;

/**
 * The API-key backends that can displace a native provider for `agentTool`, in
 * preference order.
 *
 * A list rather than a single value, and the list is now genuinely plural:
 * `codex` returns `['groq', 'grok']`. Callers must treat the FIRST ACTIVE entry
 * as the winner and must not assume length 1 — the resolver already does, and
 * `apiKeyBackendOutrankedBy` exists so display code does not have to reimplement
 * the walk.
 */
export function apiKeyBackendsForAgentTool(
  agentTool: string | null | undefined,
): readonly ApiKeyCredentialProvider[] {
  if (!agentTool) return [];
  return API_KEY_CREDENTIAL_PROVIDERS.filter(
    (provider) => API_KEY_BACKEND_ROUTING[provider]?.agentTool === agentTool,
  );
}

/**
 * The backend that BEATS `provider` for the tool they share, or null.
 *
 * Answers the question a member with two keys connected actually has: "I pasted
 * a Grok key, so why do my codex sessions still reach Groq?" The resolver's
 * answer is precedence; this returns the specific provider responsible so the
 * card can name it instead of describing the rule.
 *
 * Takes the set of ACTIVE providers rather than reading any store: this module
 * holds vendor facts and must stay synchronous and side-effect free, and the
 * caller already knows which rows are active because it just queried them.
 *
 * Returns null when `provider` wins, when it is not connected (an unconnected
 * backend is not losing a contest it has not entered), and when nothing else
 * serves its tool — the kimi case, and the only case before Grok existed.
 */
export function apiKeyBackendOutrankedBy(
  provider: ApiKeyCredentialProvider,
  activeProviders: ReadonlySet<string>,
): ApiKeyCredentialProvider | null {
  if (!activeProviders.has(provider)) return null;
  const routing = API_KEY_BACKEND_ROUTING[provider];
  // A provider that backs nothing cannot lose a contest it is not in. Gemini is
  // never outranked, however many keys the member has connected.
  if (routing === null) return null;
  for (const candidate of apiKeyBackendsForAgentTool(routing.agentTool)) {
    if (candidate === provider) return null;
    if (activeProviders.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The native provider a connected `provider` key displaces, for display, or
 * null when it displaces nobody because it IS the native provider.
 */
export function apiKeyBackendDisplaces(
  provider: ApiKeyCredentialProvider,
): CredentialProvider | null {
  return API_KEY_BACKEND_ROUTING[provider]?.displaces ?? null;
}

/**
 * The tool a connected `provider` key redirects, for display, or null when the
 * key redirects nothing.
 *
 * Null here does NOT mean "no tool uses this key" — the `gemini` tool uses a
 * Gemini key. It means no tool is being pointed somewhere other than its
 * native provider, so there is no redirection for a card to announce.
 */
export function apiKeyBackendAgentTool(
  provider: ApiKeyCredentialProvider,
): string | null {
  return API_KEY_BACKEND_ROUTING[provider]?.agentTool ?? null;
}

/**
 * Whether a connected key of this provider redirects some other provider's
 * tool. The one predicate the shape check `isApiKeyCredentialProvider` used to
 * imply and no longer does.
 */
export function isApiKeyBackend(provider: ApiKeyCredentialProvider): boolean {
  return API_KEY_BACKEND_ROUTING[provider] !== null;
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
  if (routing === null) {
    // A NATIVE provider. No base URL is rewritten, because the tool is already
    // pointed at its own vendor and the key is simply the credential it was
    // missing. Writing a base URL here would be the redirection this provider
    // explicitly is not.
    const keyEnvVar = API_KEY_PROVIDER_DEFINITIONS[provider].keyEnvVar;
    return keyEnvVar === null ? {} : { [keyEnvVar]: apiKey };
  }
  return {
    [routing.baseUrlVar]: routing.baseUrl,
    [routing.keyVar]: apiKey,
  };
}
