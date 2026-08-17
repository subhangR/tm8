# t3code — auth and config isolation

**The most immediately actionable document in this study.** It contains both a working pattern for
subscription auth and the fix for a bug tm8 already has.

## Subscription auth: spawn the CLI, inject nothing

t3code authenticates by launching each vendor's own CLI and letting **it** use its stored
subscription OAuth. **It injects no API key.** Grep for `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`apiKey` across every adapter's spawn path returns **nothing**.

### The mechanism — isolate the CONFIG DIR, never `HOME`

```ts
// provider/Drivers/ClaudeHome.ts:27-33
CLAUDE_CONFIG_DIR: resolvedHomePath
// with an explicit comment: overriding HOME would break the macOS keychain
// lookup and make the CLI report "Not logged in"
```

> ⚠️ **This is a load-bearing detail.** The obvious implementation — override `HOME` to sandbox a
> spawned CLI — silently breaks subscription auth on macOS, and the symptom ("Not logged in")
> looks like a credential problem rather than a sandboxing mistake.

Codex uses the same pattern: copies the private `~/.codex/auth.json` + `models_cache.json` per
instance (`CodexHomeLayout.ts:29-40`, `:302`, `:383`).

### It reads, but does not manage, the subscription

`ClaudeProvider.ts:461-478` enumerates detected plan tiers — `claude max / max 5x / max 20x /
enterprise / team / pro / free subscription` — purely to render a label. API key is a supported
**alternate** auth method (`normalizeClaudeAuthMethod`, `:500-538`; Codex `apiKey`/`amazonBedrock`
in the generated schema; Grok `XAI_API_KEY` in `GrokAcpSupport.ts:14`) — never required, never the
default.

## MCP injection — five different mechanisms

t3code is itself an **MCP server** (`McpHttpServer.ts:219`, Effect `McpServer.layerHttp`, name
"T3 Code") exposing ~14 browser/preview tools, guarded per-thread by a bearer token minted and
hashed by `McpSessionRegistry` (`:120-168`, 24h liveness). It is **not** an MCP client.

It injects its own `t3-code` server into each vendor differently:

| Vendor | How |
|---|---|
| Claude | SDK option `mcpServers: {type:"http", url, headers:{Authorization}}` (`ClaudeAdapter.ts:3549`) |
| Codex | CLI `-c mcp_servers.t3-code.url=… -c …bearer_token_env_var` + secret in env + a forced `config/mcpServer/reload` RPC each turn (`CodexAdapter.ts:1414-1424`) |
| Cursor / Grok | ACP `session/new` `mcpServers` field (`AcpSessionRuntime.ts:563,636`) |
| OpenCode | runtime `client.mcp.add()` HTTP call (`OpenCodeAdapter.ts:1217`) |

## ⚠️ The config-isolation hazard — and its fix

**This is tm8's known `feat/spawn-credential-injection` bug, found in the wild — with the failure
mode *and* the cure, side by side in one repo.**

| Vendor | Behaviour | Verdict |
|---|---|---|
| **Claude** | Raw pointer-swap. `ClaudeHome.ts` is 53 lines: sets `CLAUDE_CONFIG_DIR`, **zero copy/seed/symlink logic**. Point it at a fresh dir and the user's `~/.claude.json` MCP servers **vanish** — only the injected server survives. Mitigated only because `homePath` defaults to `""` (`settings.ts:264`), i.e. isolation is opt-in. | ❌ the bug we have |
| **OpenCode** | Forces `OPENCODE_CONFIG_CONTENT="{}"` (`opencodeRuntime.ts:462`) — drops all user MCP servers, no opt-out. | ❌ worse |
| **Codex** | `materializeCodexShadowHome` builds an isolated home by **symlinking every entry EXCEPT `auth.json` and `models_cache.json`** (`CodexHomeLayout.ts:32`, `:373-408`). `config.toml` — where `[mcp_servers.*]` live — is symlinked through, so MCP config is preserved **by design**; only the auth file is isolated per-account. | ✅ **copy this** |

### Ruling for tm8

**Adopt the Codex pattern: isolate only the auth file, symlink or share everything else.** That
gives per-member credential separation without nuking the member's MCP servers.

Complementary lever measured directly on `claude` 2.1.212: **`--mcp-config` + `--strict-mcp-config`**
lets you specify exactly the servers you want and ignore all others — which sidesteps the config
dir entirely for the tools *we* inject.

**This fix is worth landing on its own, independent of whether TM8 Chat is ever built.**
