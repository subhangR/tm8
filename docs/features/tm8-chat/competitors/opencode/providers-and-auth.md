# OpenCode — providers, and the subscription-auth ruling

**The most consequential document in the competitor study.** It answers "can I own the loop *and*
use my subscription?" with *yes, technically* — and then shows why tm8 must not.

## Providers: one loop, many models

| Layer | What |
|---|---|
| **Model registry** | **models.dev** (`@opencode-ai/core/models-dev`) — model ids, costs, limits, provider metadata (`provider/provider.ts:13,371`) |
| **Protocol translation** | **AI SDK provider packages**, dynamically imported by npm name — `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google-vertex`, `@ai-sdk/github-copilot`, … in a `SDK_MAP` (`:110-115`) |
| **Per-provider code** | **Thin.** A `custom()` map of small loaders patching headers/quirks — e.g. anthropic just injects `anthropic-beta` betas (`:168-178`). ~40 provider defs in `packages/core/src/plugin/provider/*.ts` |

**Adding a provider ≈ a models.dev entry + optionally an auth plugin.** That is how "one loop, many
models" is actually pulled off — and it is much cheaper than t3code's five bespoke adapters,
because these are *model APIs*, not *agent programs*.

> Note the distinction that matters: OpenCode integrates **models**; t3code and Buzz integrate
> **agents**. Different problems. Integrating models is easy and commoditized; integrating agents
> is where subscription auth lives.

## The auth architecture — a clean seam

Auth is **plugin-driven**. A generic orchestrator (`ProviderAuth`) only dispatches
`authorize()`/`callback()` into plugin `auth` hooks and writes to a token store — **zero provider
OAuth logic of its own** (`provider/auth.ts:163-221`).

Token store: `~/.local/share/opencode/auth.json`, **`chmod 600`**, three kinds —
`oauth{refresh,access,expires,accountId,enterpriseUrl}` | `api{key}` | `wellknown` — overridable
via `OPENCODE_AUTH_CONTENT` (`auth/index.ts:8-35,59,79`).

Built-in auth plugins wired by default: **codex, github-copilot, modal, gitlab, poe, cloudflare×2,
azure, digitalocean, snowflake, xai** — **NOT anthropic** (`plugin/index.ts:66-84`).

### The mechanism that decouples loop from credential

Each auth plugin's `loader` returns a **custom `fetch` shim** that:

1. strips the AI SDK's `Authorization` / `api-key` header,
2. injects the OAuth **bearer**,
3. **rewrites the request URL to the vendor's subscription backend.**

**The loop is untouched.** Credential and endpoint are swapped underneath it. *This is the reusable
idea*, independent of whose credential you put in it.

### ChatGPT/Codex subscription — fully implemented

`plugin/openai/codex.ts`: `CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"`,
`ISSUER = "https://auth.openai.com"`, PKCE S256, scopes `openid profile email offline_access`,
`originator: "opencode"` (`:10-11,78-92`). Two flows: **browser loopback on port 1455** and
**device-code** (`:154,433,463`).

The shim rewrites `/v1/responses` | `/chat/completions` →
**`https://chatgpt.com/backend-api/codex/responses`**, sets `Authorization: Bearer <access>` +
`ChatGPT-Account-Id`, and **forces model cost to 0** (unmetered subscription) (`:12,340-426,297`).
Refresh via `refresh_token` grant on 401/expiry (`:361-388`).

### GitHub Copilot subscription — fully implemented

`plugin/github-copilot/copilot.ts`: `CLIENT_ID = "Ov23li8tweQw6odWQebz"`, GitHub **device-code**
flow, scope `read:user` (`:9,234-305`); shim → `api.githubcopilot.com` with bearer,
`User-Agent: opencode/<ver>`, `X-Initiator`, `Openai-Intent` (`:100-179`).

## ⚠️ Anthropic Claude Pro/Max — NOT present, and vendor-blocked

- The bundled anthropic loader is API-key-shaped: it sets betas and defers the credential to the
  plugin auth loader's combined fetch — **but no anthropic auth plugin is registered**
  (`provider/provider.ts:170-178`; `plugin/index.ts:66-84`).
- The newer `packages/llm` anthropic provider is **`x-api-key` from `ANTHROPIC_API_KEY` only**, no
  OAuth (`packages/llm/src/providers/anthropic.ts:15-17`).

**Why it's gone:** Anthropic Pro/Max OAuth moved to an *external community plugin*, and the official
`opencode-anthropic-auth` npm package **was removed after a legal request from Anthropic**. In
**January 2026 Anthropic added server-side enforcement**: consumer-subscription OAuth tokens are
**rejected at the API layer when used outside Claude Code / claude.ai**
([anomalyco/opencode#18329](https://github.com/anomalyco/opencode/issues/18329)). Historically the
flow was PKCE against `console.anthropic.com` with an `anthropic-beta: oauth-*` header and Claude
Code's hard-coded client_id.

## Honest read on the remaining plugins

Tokens live in `auth.json` (0600) or env; refresh is per-plugin. **Every plugin identifies as
`opencode` / `originator: opencode`** — a non-vendor client presenting a vendor's subscription
credential, which is precisely what the terms prohibit. The code exists for OpenAI and Copilot;
**for Anthropic the vendor has already closed it, legally and technically.** Treat OpenAI/Copilot as
"works today, same enforcement risk."

## THE RULING FOR TM8

Two things get called "using my subscription", and only one is safe:

| | Status |
|---|---|
| **Spawn the vendor's own binary**, let it use its own stored login — t3code, Buzz, tm8 today; the Agent SDK exists for this | ✅ **supported** |
| **Extract the OAuth token and call the API from your own client** — OpenCode's plugins | ❌ **closed** — legal takedown + server-side rejection |

**tm8 builds only the first row.** Not merely for compliance: the second yields a product that
breaks when a vendor flips a flag, and one already has.

**But keep OpenCode's seam.** Build the credential/transport boundary exactly this way — pluggable,
with the loop credential-agnostic — and ship it pointed at **API keys / Bedrock / Vertex /
gateways**. That way the architecture is right, the legal posture is right, and if the commercial
landscape ever changes it's a plugin, not a rewrite.
