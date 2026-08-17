# OpenCode — embedding, tools, multi-agent, maturity

## Three ways in

| # | Surface | Detail |
|---|---|---|
| 1 | **HTTP + generated SDK** *(primary)* | `opencode serve` runs an Effect `HttpApi` app emitting OpenAPI (`OpenApi.fromApi(PublicApi)`), MDNS-discoverable, with a **WebSocket event stream** (`server/server.ts:8,55,70`). The typed `@opencode-ai/sdk` (`createOpencodeClient`) is generated from that OpenAPI. This is how their own TUI and web UI drive the engine. |
| 2 | **ACP (agent-side)** | Full Agent Client Protocol implementation over `@agentclientprotocol/sdk` — `Initialize, NewSession, Load/Fork/Resume Session, Prompt, Cancel, SetSessionModel/Mode, Authenticate, ListSessions` (`acp/agent.ts:1-30`). Notably it is a **thin adapter over the OpencodeClient SDK** — ACP wraps the HTTP server, it is not a separate engine. So opencode embeds as an ACP agent in Zed and friends. |
| 3 | **MCP** | **Client only.** It *consumes* MCP (stdio + http, with OAuth); no evidence it exposes itself as an MCP server. |

### Embed as a server, not a library

To use OpenCode as an engine you **run its process** and speak SDK/HTTP or ACP. You get durable
sessions, structured parts and streaming events for free — but you **inherit its session model
wholesale**, and you **cannot swap in your own loop** without forking `session/prompt.ts`.

> **Verdict for tm8: copy the loop, don't embed the engine.** Embedding means running a second
> stateful service with its own SQLite, its own session identity and its own project model
> alongside tm8's graph — two sources of truth for "what is a session". Since the goal is for tm8 to
> *own* the agent, inheriting someone else's session aggregate is precisely the wrong trade.

## Tools

Built-ins (`packages/opencode/src/tool/`): `read, write, edit, apply_patch, glob, grep,
ls/external-directory, shell, lsp, webfetch, websearch, mcp-websearch, question, plan, skill, task,
todo, code-mode`. Effect-based, prompts in sibling `.txt` files, registered in `tool/registry.ts`,
JSON-schema'd via `tool/json-schema.ts`.

**MCP client** with OAuth (`mcp/{index,auth,oauth-provider,oauth-callback,catalog,browser}.ts`);
remote MCP tools fold into the same registry.

**Permissions** are real: `packages/opencode/src/permission/` plus a per-session `permission:
Ruleset` column (`core/session/sql.ts:50`), and **subagents get *derived* (narrowed) permissions**
(`agent/subagent-permissions.ts`). Tool allowlisting is per-agent via `SessionTools.resolve`
(`prompt.ts:1226`).

> **Derived subagent permissions is a genuinely good idea** and directly relevant to tm8: a chat
> agent that spawns worker sessions should not be able to grant them more authority than it has.

## Multi-agent

The **`task` tool is real delegation** (`tool/task.ts:44-66`):

```
params: description, prompt, subagent_type, task_id?, background?
```

- Spawns a **child session** (its own `parent_id` row).
- **Foreground** (default) returns the result; **background** returns immediately and notifies on
  completion via `BackgroundJob` (`:23-40`).
- **Resumable** — pass a prior `task_id` to continue the same subagent session (`:50`).
- Narrowed permissions per subagent.

**Orchestration is persistent, not ephemeral fan-out** — every subagent is a durable session row.

> This is the closest any competitor gets to tm8's orchestration. But note the ceiling: it is
> subagents *within one product's session tree*, with no graph, no cross-project entities, no
> human/agent shared workspace. tm8's spawn/dispatch over a typed entity graph is still a
> materially bigger thing.

## Maturity

**MIT.** Very active: multi-package monorepo, turbo, husky, oxlint, extensive
`packages/opencode/test/**` including HTTP API coverage gates.

**Solid:** the loop, the provider/models.dev layer, SQL storage, SDK/OpenAPI, ACP.
**Rough / in flux:** two coexisting generations mid-migration; Effect-beta churn;
subscription-auth plugins are a moving target against vendor enforcement.

## Summary of what to take

| Take | Leave |
|---|---|
| The typed **Part** storage model | SQLite as the engine |
| The hand-rolled loop shape over a streaming SDK | `effect@4.0.0-beta` lock-in |
| The credential/transport **seam** (pointed at API keys) | Subscription-OAuth plugins |
| **Derived subagent permissions** | The two-generation codebase split |
| models.dev-style registry for "many models cheaply" | Embedding the whole engine as a service |
