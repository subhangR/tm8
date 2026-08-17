# t3code — runtime, adapters, and the ACP verdict

## The port — 126 lines, 12 methods

`apps/server/src/provider/Services/ProviderAdapter.ts:45-126` — `ProviderAdapterShape<TError>`:

```
startSession · sendTurn · interruptTurn · respondToRequest · respondToUserInput
stopSession  · listSessions/hasSession · readThread · rollbackThread · stopAll
+ capabilities (incl. sessionModelSwitch: "in-session" | "unsupported")
+ streamEvents: Stream<ProviderRuntimeEvent>
```

Five driver kinds (`packages/contracts/src/model.ts:130-134`): `codex`, `claudeAgent`, `cursor`,
`grok`, `opencode`.

| Vendor | Transport | LOC |
|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` `query()` (ClaudeAdapter.ts:22, :1366) | 3951 |
| Codex | own Effect wrapper of `codex app-server` JSON-RPC; 38k-line generated schema | 1729 |
| OpenCode | spawned subprocess | 1721 |
| Grok | **ACP** + `XAiAcpExtension` (GrokAdapter.ts:45) | 1464 |
| Cursor | **ACP** — `cursor agent acp` (CursorAdapter.ts:2) | 1182 |

Each adapter normalizes its vendor protocol **up** into one ~44-value transient event union
(`packages/contracts/src/providerRuntime.ts:148-196`); one reactor
(`ProviderRuntimeIngestion.ts`, 1831 lines) translates it **down** into durable domain events.
**The reactor is the centre of gravity.**

## The engine

Single unbounded `Queue` + one worker fiber (`OrchestrationEngine.ts:90,303`) → strict
serialization. Idempotency is a real `commandId` receipt row (`orchestration_command_receipts`,
PK on command_id) checked **before** the decider (`:138-151`); append → project → receipt all
inside one `sql.withTransaction`; PubSub publish **after** commit (`:169-217`).

> This removes the concurrent-clobber failure class **by construction**, and it means optimistic
> client sends are safe. tm8's idempotency default is currently OFF — that must be revisited
> before building an optimistic composer, not after.

Transport to clients: a 79-method single `WsRpcGroup` over long-lived **WebSocket** RPC
(`packages/contracts/src/rpc.ts:786`). Not SSE, not polling.

## ACP — a real port, but lossy and leaking

`packages/effect-acp` is **their own** Effect-native implementation (~3,922 LOC + a 506KB
generated schema), targeting **ACP schema v0.11.3, `PROTOCOL_VERSION = 1`**.

- **14 agent methods**: `initialize`, `authenticate`, `logout`, `session/new|load|resume|fork|
  list|close|prompt|cancel|set_model|set_mode|set_config_option`.
- **11 client callbacks** the host must serve: `session/update`, `session/request_permission`,
  `session/elicitation(/complete)`, `fs/read_text_file`, `fs/write_text_file`, `terminal/*`.

### Coverage of the 12-method port

| Port method | ACP mechanism | Clean? |
|---|---|---|
| startSession / sendTurn / interruptTurn / stopSession | `session/new` / `prompt` / `cancel` / `close` | ✅ |
| listSessions | `session/list` (native) | ✅ |
| respondToRequest | `session/request_permission` | ✅ shape, per-vendor body |
| respondToUserInput | `session/elicitation` — **Grok escapes it** | ⚠️ leaks |
| sessionModelSwitch | `session/set_model` — spec-flagged **UNSTABLE** | ⚠️ risky |
| rollbackThread | **no ACP primitive** — Cursor fakes a local splice; Grok returns an error | ❌ escapes |

### The fidelity price

The parser handles **5 of 11** `session/update` variants; `default: break;` silently drops the
rest (`AcpRuntimeModel.ts:577-580`) — dropping `agent_thought_chunk`, `usage_update`,
`available_commands_update`, `config_option_update`, `session_info_update`.

| Signal | Claude (SDK) | Codex | Cursor/Grok (ACP) |
|---|---|---|---|
| Thinking / reasoning | ✅ | ✅ | **❌** |
| Token usage | ✅ | ✅ | **❌** |
| Cost ($) | ✅ | ❌ | **❌** |
| Rate limits | ✅ | ✅ | **❌** |
| Context window | ✅ | ✅ | **❌** |
| Plan / todo | ✅ | ✅ | ✅ |
| Rollback | fake | ✅ real | fake / rejected |

Partly self-inflicted — but ACP's own generated doc-comments mark usage/cost/`set_model` as
*"UNSTABLE… may be removed or changed at any point"*. And **no adapter ever declares
`capabilities: unsupported`** — all five claim full capability, so there is no fallback when an
ACP `set_model` silently no-ops.

### Vendors already escape it

- **Grok** (`XAiAcpExtension.ts:50,246`) adds non-standard `x.ai/ask_user_question` smuggled
  through ACP's `_meta` bag, plus a shim for non-conformant stop-reason handling (`:391`).
- **Cursor** hard-codes mode alias tables — `plan|architect`, `code|agent|default|chat|implement`,
  `ask` (`CursorAdapter.ts:84-86`) — because ACP session modes are free strings.

### Decisive fact

**Claude Code does not speak ACP.** Only `CursorAdapter` and `GrokAdapter` import the ACP runtime;
`ClaudeAdapter` has zero ACP references. Independently confirmed by running `claude --help` (no
`acp`). An ACP-only client cannot drive our primary model.

## Approvals — one signature, three implementations

| Vendor | Mechanism |
|---|---|
| Claude | SDK `canUseTool` callback parks a promise (`ClaudeAdapter.ts:3259`) |
| Codex | server→client JSON-RPC `item/{commandExecution,fileRead,fileChange}/requestApproval` |
| Cursor/Grok | ACP `session/request_permission` |

All three normalize to the **same three kinds** — `command_execution` / `file_read` /
`file_change` — answered through one `respondToRequest` signature. The port unifies the
*interface*; there is no shared approval engine. **That 3-kind vocabulary is worth copying.**

## Verdict for tm8

Build the **Claude Agent SDK** integration first — it surfaces reasoning, context usage, cost and
rate limits, which is exactly what the UI needs and exactly what ACP drops, and it accepts
`mcpServers` as an in-process option. Add an ACP client **second**, for breadth, with eyes open.
