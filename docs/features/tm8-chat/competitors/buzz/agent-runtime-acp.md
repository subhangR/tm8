# Buzz — agent runtime, ACP harnesses, and the message→agent→message loop

## Two runtimes — do not conflate them

| | `buzz-acp` (41k LOC) | `buzz-agent` (29k LOC) |
|---|---|---|
| What | **Harness bridge** — spawns an external agent CLI, drives it over ACP JSON-RPC on stdio | Their **own** from-scratch ACP agent: LLM client + own tool loop, calls MCP tools |
| PTY? | **No.** `spawn()` with stdin/stdout piped (`acp.rs:451,459`) | n/a |
| Auth | **Delegated** — the adapter owns its own OAuth | **API key / OAuth2-PKCE to a gateway** |
| Relevance to tm8 | ✅ this is the model | ❌ wrong model for subscription goals |

That split is itself the finding: **Block wrote their own agent and it could not use subscriptions.**
They shipped both because neither alone covers the ground.

## ACP as implemented

Their **own** Rust client implementation — a single hand-written `AcpClient` struct, no
`agent-client-protocol` crate in deps. They **pin `protocolVersion: 2`** with a comment admitting
it's a squat: *"intentional temporary pin — we are squatting on ACP v2 ahead of the upstream ACP
RFD"* (`acp.rs:599-601`).

> Compare: t3code targets ACP schema **v0.11.3 / PROTOCOL_VERSION 1**. Two serious products, two
> different protocol versions. **The standard is in motion.**

**Outbound:** `initialize`, `authenticate{methodId}`, `session/new`, `session/set_config_option`,
`session/set_model`, `session/prompt`, `session/cancel`.
**Inbound** (read loop `:1242-1268`): `session/update` (→ `handle_session_update :1738`),
`session/request_permission` (→ `:1896`), `_goose/unstable/session/update` (usage telemetry).
**`session/update` variants handled:** `agent_message_chunk`, `agent_thought_chunk`, `tool_call`,
`tool_call_update`, `plan`, `available_commands_update`, `session_info_update`, `keepalive`.

A turn ends when `session/prompt` returns a `stopReason`
(`end_turn|cancelled|max_tokens|max_turn_requests|refusal`).

### There is NO per-harness trait

`grep 'trait (Harness|Adapter|Agent|Runtime|Backend)'` → **nothing**. **ACP *is* the interface.**
One ~20-method `AcpClient`; per-harness difference is a couple of match arms on the normalized
binary name (`config.rs:700-706`):

| Harness | Binary | ACP-native? |
|---|---|---|
| **goose** | `goose acp` | ✅ yes |
| **codex** | `codex-acp` | ❌ third-party npm wrapper `@agentclientprotocol/codex-acp` |
| **claude** | `claude-agent-acp` / `claude-code-acp` | ❌ third-party npm wrapper |
| buzz-agent | own binary | ✅ |

Invocation is just `Command::new(binary).args(default_args)` with stdio piped, stderr inherited,
`kill_on_drop`, own process group (`acp.rs:459-526`). **Model is selected after session creation**
via `set_model`/`set_config_option`, not argv (`pool.rs:1140`).

### Where they escaped ACP — twice

1. **Mid-turn steer** — core ACP lacks it. Goose's `_goose/unstable/session/steer` and
   claude-agent-acp's `_session/steering`, chosen at runtime from an
   `initialize._meta.steering.supported` capability flag (`acp.rs:361,367,596`).
2. **Codex sandbox networking** — injected as an **env var**, not ACP:
   `CODEX_CONFIG={"sandbox_workspace_write":{"network_access":true}}` (`config.rs:748-778`), so the
   agent's tools can reach the relay.

## Authentication — delegation, and Buzz never holds a secret

For goose/codex/claude the flow is: spawn adapter → `initialize` → read advertised `authMethods` →
forward `authenticate(methodId)` → **the adapter runs its own login and writes its own credential
store** (`~/.claude`, `~/.codex/auth.json`) (`lib.rs:4351`, `:4303`).

- **No `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` injected anywhere** in the persona/env path.
- Setup detection models a **`CliLogin`** requirement and nudges the user in-chat to run the
  vendor's own login — it never captures the secret (`setup_mode.rs:99`, `:61-69`).
- Contrast `buzz-agent`: real API key or OAuth2-PKCE-with-browser, built for Block's Databricks
  gateway (`buzz-agent/src/auth.rs:92`). Does **not** read subscription files.

**This is the multi-model-on-subscriptions answer: N adapters, not N API integrations.**

## The loop — @agent → reply, in code order

1. Relay WebSocket delivers a **kind:9** chat event; a subscription/mention filter gates it
   (`relay.rs`, `filter.rs evaluate_filter`).
2. Events are deduped and batched per channel; a prompt is built and — **critically** — hints are
   appended telling the agent to reply with **`buzz messages send --reply-to <event_id>`**
   (`queue.rs:1164-1180`).
3. `run_prompt_task` (`pool.rs:1454`) fetches core memory + thread context;
   `create_session_and_apply_model` (`:961`) issues `session/new` with the framed system prompt +
   **MCP servers** (`:1106`), applies model and permission mode, then `session/prompt`.
4. **The agent posts its reply by CALLING A TOOL** — `buzz-cli` is wired in as an MCP server
   (`--mcp-command` / `BUZZ_ACP_MCP_COMMAND`, `config.rs:261`).
   **Buzz does NOT scrape `agent_message_chunk`** — `handle_session_update` merely *logs* chunks to
   tracing (`acp.rs:1746-1750`).
5. `session/prompt` returns `stopReason` → `send_prompt_result` finalizes; a **kind:44200** turn
   metric is published (`pool.rs:1424`); 👀/💬 reaction guards clean up.

> **The steal:** output is a signed tool call into the chat API, not stdout parsing. That deletes
> the entire terminal-scraping surface — and tm8 already works this way.

## Identity and authority

The agent has its **own Nostr keypair** (`BUZZ_PRIVATE_KEY`, zeroized after parse) and signs its own
relay events **as itself** — a first-class member, not a human's proxy (`config.rs:243,843-849`).
Authority is scoped by relay/community.

### ⚠️ Buzz auto-approves everything

`session/request_permission` is answered `allow_once`, falling back to `reject_once` only if allow
is absent (`acp.rs:1918-1951`). **There is no in-chat approval UX.** What stops a destructive agent
is the sandbox/workdir jail and operator trust — *"shell runs at the operator's trust level, like
bash"*. The only approve/deny buttons in the whole app are for **workflows**.

**Reject this for tm8** if human-in-the-loop matters: you would have to intercept
`session/request_permission` and surface it, which Buzz does not do.

## Interrupt / steer / resume

| | Status |
|---|---|
| **Interrupt** | ✅ real — a mid-turn event can cancel+merge; `CancelReason::Interrupt` (`queue.rs:65-68`), `cancel_with_cleanup` (`acp.rs:944`) |
| **Steer** | ✅ real — inject mid-turn without killing the turn, via the vendor extensions; falls back to cancel+merge when unsupported |
| **Resume** | ❌ **not implemented** — no `session/load` anywhere. Per-channel sessions persist in-process across turns, but kill the process and the transcript is gone |

> Note: ACP itself **does** define `session/load`, `session/resume` and `session/fork`
> (per t3code's implementation). **Buzz simply didn't implement them** — not a protocol limit.

## Maturity

Strong. Real TODO/FIXME in the agent crates is near-zero (the "91" grep hits are false positives
inside `buzz-dev-mcp/src/todo.rs`, a TODO-*list* tool). Test density is high — **buzz-acp 725 test
fns**, buzz-agent 464, buzz-persona 145 — covering the agent loop, steer, cancel, permission races,
usage poisoning and stop-reason parsing. Complete: goose, buzz-agent, and codex/claude via installed
adapters. Weakest: remote-agent k8s lifecycle (vision-led) and any in-chat approval UX
(deliberately absent).
