# TM8 Chat — prior art: t3code vs Buzz vs tm8

Task `019fecfa-8b95-7c08-a5a0-6143aaec044b`. Researched 2026-08-12.
Companion to `BRIEF.md`. **Status: research findings. Nothing built, nothing decided.**

Everything here is read from source or measured on this machine. Claims from vendor blog posts
are labelled as such and were mostly wrong — see §0.

---

## 0. What we read, and one warning

| Source | What it is | How we read it |
|---|---|---|
| **t3code** | `~/Desktop/Projects/t3code` — pnpm monorepo, ~1.17M LOC, Effect 4 beta, SQLite | Full local source read |
| **Buzz** | Block (Jack Dorsey), Apache-2.0, launched 2026-07-21. Rust relay + Tauri/React client | Cloned (116MB) and read |
| **claude / codex CLIs** | 2.1.212 / 0.147.0 | **Driven, not read** — real runs, §2 |

**Warning: the press coverage of Buzz is wrong.** It says Buzz ships harnesses for "Goose, Codex
and Claude Code". In the tree, only **goose** speaks ACP natively; codex and claude are reached
through **third-party npm wrapper binaries** (`@agentclientprotocol/codex-acp`,
`claude-agent-acp`). The shipped harness logos are `amp, devin, grok, hermes, kimi, omp,
openclaw, opencode`. Also: `VISION_*.md` in that repo is **aspirational**, not implemented —
several of them describe things the code does not do.

---

## 1. The convergence: three products, one answer on subscription auth

This was the user's hard constraint ("multiple models on the same underlying subscription as
Claude Code, Codex"). It is a **solved problem, and the solution is delegation.** You never hold
a provider credential; you spawn the vendor's own CLI and let it use its own stored OAuth.

- **t3code** injects **no API key anywhere** — grep-clean across the whole provider tree. It
  isolates each provider instance by **config dir, not `HOME`**: `CLAUDE_CONFIG_DIR:
  <per-instance>` with an explicit comment that overriding `HOME` breaks the **macOS keychain**
  and makes the CLI report "Not logged in" (`provider/Drivers/ClaudeHome.ts:27-33`). Codex
  equivalent copies `~/.codex/auth.json` per instance (`CodexHomeLayout.ts:29-40`).
  API key is a *detected alternate*, never the default (`ClaudeProvider.ts:500-538`).
- **Buzz** forwards ACP `authenticate(methodId)` to the adapter, which runs its own login and
  writes its own store. Buzz holds no secret (`lib.rs:4351`, `setup_mode.rs:99`), and models a
  `CliLogin` requirement to nudge the user in-chat.
- **Measured here:** `claude --bare` help states auth is *"strictly ANTHROPIC_API_KEY or
  apiKeyHelper (OAuth and keychain are **never read**)"* — which proves normal mode *does* read
  them.

**Consequence for tm8:** "many models on one subscription" = N spawned CLIs behind one port.
Not N API integrations. This also means the runtime must run **where the credentials are** — on
the user's machine or their own node — which is a deployment ruling, not just an adapter choice.

---

## 2. Measured on this machine (claude 2.1.212, codex 0.147.0)

### 2.1 The control channel is SDK-only — settles BRIEF §8's open question

Ran `claude -p --verbose --input-format stream-json --output-format stream-json
--permission-mode manual --setting-sources ""` with `Write` **not** pre-allowed. No
`control_request`. No `canUseTool`. Claude **auto-denies itself** and continues:

```
assistant tool_use: Write {...}
user: [{"type":"tool_result","is_error":true,
        "content":"Claude requested permissions to write to …, but you haven't granted it yet."}]
result success  cost=0.0080
```

With `--allowed-tools Write` the identical run executes the tool silently.

**Consequence:** raw stdio gives the full *read* stream — `thinking`, `tool_use`, `tool_result`,
`rate_limit_event`, per-turn `total_cost_usd` — but **no interactive approvals**. You must
pre-authorize. That is fine for a graph-tools-only v1 and is the argument *for* it. Wanting
in-chat approvals forces the Agent SDK, which is Anthropic-only and costs the multi-vendor
property. This is the cleanest justification for BRIEF's D3/D5.

### 2.2 Neither CLI speaks ACP

No `acp` in `claude --help` or `codex --help`. Buzz reaches them only via third-party npm
wrappers. So ACP cannot be tm8's *first* integration.

### 2.3 New CLI surface since the brief (measured 2.1.77, now 2.1.212)

- **`--strict-mcp-config` + `--mcp-config`** — the clean fix for our known hazard where
  replacing `CLAUDE_CONFIG_DIR` makes MCP servers vanish. Inject tools this way instead of
  relying on the config dir.
- **`--bg` / `claude agents --json`** — Claude Code now ships its *own* background-agent
  orchestration. tm8 must decide whether to compete with or delegate to it.
- **`codex mcp-server`** — codex can run **as** an MCP server over stdio. A different integration
  shape from `app-server` JSON-RPC, and possibly a cheaper one.
- `--json-schema` (structured output), `--include-partial-messages` (token deltas),
  `--max-budget-usd`, `--fork-session`, `--session-id`, `--setting-sources`.

---

## 3. t3code — a 5-vendor engine behind a 12-method port

**Correction to our prior notes: t3code is not an Anthropic app.** `ClaudeAdapter` is one of five.

`ProviderAdapterShape` (`provider/Services/ProviderAdapter.ts:45-126`) is **126 lines, 12
methods**: `startSession`, `sendTurn`, `interruptTurn`, `respondToRequest`,
`respondToUserInput`, `stopSession`, `listSessions`/`hasSession`, `readThread`,
`rollbackThread`, `stopAll`, plus `capabilities` and one `streamEvents:
Stream<ProviderRuntimeEvent>`.

| Vendor | Transport | Adapter LOC |
|---|---|---|
| Claude | `@anthropic-ai/claude-agent-sdk` `query()` | 3951 |
| Codex | own Effect wrapper of `codex app-server` JSON-RPC | 1729 |
| OpenCode | spawned subprocess | 1721 |
| Grok | **ACP** + `XAiAcpExtension` | 1464 |
| Cursor | **ACP** (`cursor agent acp`) | 1182 |

Each adapter normalizes its vendor protocol *up* into one ~44-value transient event stream; a
single 1831-line reactor (`ProviderRuntimeIngestion.ts`) translates it *down* into durable
domain events. **The reactor is the centre of gravity, not the adapters.**

**Data model** — corrections to our notes:
- `messages[]` and `activities[]` are **flat sibling arrays joined by a nullable `turnId`**, not
  containment (`orchestration.ts:380,384`). A turn's contents are reconstructed client-side by
  filtering both on `turnId`.
- **Streaming collapse is server-side in the projector** (`projector.ts:472-492`) — each delta is
  its own durable event; the log never stores a final string; clients receive the collapsed text.
- Tool payloads are **opaque** (`data: Schema.Unknown`); `status` is the only structured field.
  No typed args/result/duration.
- Activity `kind` is an **open string**, not a union. "Reasoning" is a content-stream kind, not
  an activity row.

**UI:** one virtualized flat timeline (`@legendapp/list`); tool calls collapse into log rows;
**approvals render in the composer footer, not the timeline**; diffs open a docked side panel,
never inline; the usage meter is tokens-only with **no dollar cost anywhere**; send is *blocked*
during a turn (no auto-queue) and the send button morphs into Stop.

**Weaknesses:** the same schema is hand-projected **three times** (in-memory projector, a
2282-line SQL reconstruction, and a client reducer) that must stay byte-compatible forever —
a live drift hazard. Plus O(n²) message-array spreading per event.

**t3code has no graph and no orchestration.** A thread cannot spawn threads or subagents; no
delegation, no task list; Project → Thread → Messages over a filesystem path. Zero prior art for
the two things tm8 already has.

---

## 4. Buzz — ACP everywhere, flat messages, ephemeral transcripts

Two runtimes, not to be conflated:
- **`buzz-acp`** (41k LOC) — spawns an external agent CLI and drives it over **ACP JSON-RPC on
  stdio**. No PTY, no byte-scraping.
- **`buzz-agent`** (29k LOC) — their own from-scratch ACP agent with API-key/PKCE auth to a
  gateway. Wrong model for subscription goals; ignore it.

### 4.1 The headline: the agent replies by CALLING A TOOL

The prompt has hints appended telling the agent to reply via
`buzz messages send --reply-to <event_id>`, with `buzz-cli` wired in as an **MCP server**
(`queue.rs:1164-1180`, `config.rs:261`). Buzz merely **logs** `agent_message_chunk` to tracing
(`acp.rs:1746-1750`). Stdout is never the output channel.

**tm8 already works this way** — our agents post back with `tm8 message send --to <anchor>`, over
a shelled CLI rather than MCP. The thing Buzz's authors call the key architectural move, tm8 has
had from the start. We are not missing the output path; we are missing the structured *read*
stream.

### 4.2 ACP as the port

No per-harness trait exists — **ACP *is* the interface.** One ~20-method `AcpClient`; vendor
variance is ~3 match arms (`config.rs:700-706`). They escaped ACP exactly twice: mid-turn
**steer** (vendor extensions `_goose/unstable/session/steer`, `_session/steering`, selected via
an `initialize._meta.steering.supported` capability flag) and codex sandbox networking via a
`CODEX_CONFIG` env var.

Costs of that choice: they **squat `protocolVersion: 2` ahead of the upstream RFD**
(`acp.rs:599-601`), already ship an `AdapterOutdated` state, and depend on third-party npm
wrappers for the two vendors that matter most to us. **No ACP-level resume** (no `session/load`) —
kill the process and the transcript is gone.

### 4.3 The flat-vs-structured ruling, and its price

Buzz resolved this fork **toward flat, and paid for it.**

- Durable message = flat string (`content TEXT`; client `body: string`). Agent-ness is a
  **boolean flag** (`isAgent`), and structured rendering keys off `message.kind`, not authorship.
  The only rich body in the timeline is a **diff card (kind 40008)**.
- A real typed transcript union (`message|thought|plan|lifecycle|tool` with `args`, `result`,
  `isError`) **does** exist — but it is decoded from **ephemeral, owner-encrypted observer frames
  (kind 24200)** that *"relays MUST NOT persist… historical replay is not supported"*, and it
  renders **only in side panels, never in the channel timeline**.
- Cost/usage is a third plane: a separate durable encrypted per-turn event (**kind 44200**) —
  which **no UI renders at all**.

**Price paid:** two disjoint rendering systems that never converge, and an agent transcript that
cannot be re-opened after the fact. For tm8, durable re-openable agent turns are the product, not
a debug stream. **Reject this one.**

### 4.4 Permissions

Buzz **auto-approves every tool permission** (`allow_once`, falling back to `reject_once` only if
absent — `acp.rs:1918-1951`). There is no in-chat approval UX. Safety rests on the sandbox,
a workdir jail, and operator trust. The only approve/deny buttons in the app are for *workflows*.

### 4.5 Threads — independent convergence with tm8's `#153`

Thread is a **projection, not an entity**: ordinary messages with a NIP-10 reply tag, plus a
relay-maintained `thread_metadata` sidecar (parent/root/depth/reply_count/descendant_count/
last_reply_at) computed **at ingest**, and a synthesized summary overlay kind. UI is a roots feed
with inline "N replies" rows plus a side thread panel. That is almost exactly what tm8 shipped in
`#153`. Validation, not a new idea.

### 4.6 Maturity

High where it counts: 725 test fns in `buzz-acp`; the agent loop, steer, cancel, permission race
and stop-reason parsing all have regression tests; the **git subsystem is the most mature part**
(real Smart-HTTP server, NIP-98 auth, Schnorr commit signing, PR review UI) with zero stubs.
Scaffolded or dead: workflow **approval gating marks runs Failed** ("not yet implemented"),
`send_dm`/`set_channel_topic` return `NotImplemented`, **no workflow action can spawn an agent**,
no cost UI anywhere, and remote agents are vision-led scaffolding.

---

## 4A. ACP verdict — a real port, but lossy, unstable, and it cannot drive Claude

Two products use ACP, so we investigated whether tm8 should write *one* client instead of N
adapters. **Answer: no, not first.**

**Claude Code does not speak ACP.** Confirmed two independent ways: no `acp` in `claude --help`
(measured, §2.2), and in t3code's 41k-file tree only `CursorAdapter` and `GrokAdapter` import the
ACP runtime — `ClaudeAdapter` has zero ACP references. Buzz reaches claude/codex only through
third-party npm wrapper binaries. An ACP-only client cannot drive our primary model.

**t3code's `packages/effect-acp`** is their own Effect-native implementation (~3,922 LOC + a
506KB generated schema), targeting **ACP schema v0.11.3, `PROTOCOL_VERSION = 1`**. Surface: 14
agent methods (`initialize`, `authenticate`, `session/new|load|resume|fork|list|close|prompt|
cancel|set_model|set_mode|set_config_option`) and 11 client callbacks the host must serve
(`session/update`, `session/request_permission`, `session/elicitation`, `fs/read_text_file`,
`fs/write_text_file`, `terminal/*`).

> **Note the version split:** t3code pins protocol **1** (schema v0.11.3); Buzz **squats protocol
> 2** ahead of the upstream RFD. The standard is genuinely in motion — that is a real cost of
> adopting it now.
>
> **Cross-check correction:** Buzz's harness reportedly has "no ACP-level resume". ACP *does*
> define `session/load`, `session/resume` and `session/fork` natively. Buzz simply didn't
> implement them — not a protocol limitation.

### The fidelity price (the important table)

t3code's parser handles only **5 of 11** `session/update` variants and `default: break;` silently
drops the rest (`AcpRuntimeModel.ts:577-580`) — dropping `agent_thought_chunk`, `usage_update`,
`available_commands_update`, `config_option_update`, `session_info_update`.

| Signal | Claude (SDK) | Codex (app-server) | Cursor/Grok (ACP) |
|---|---|---|---|
| Thinking / reasoning | ✅ | ✅ | **❌ dropped** |
| Token usage | ✅ | ✅ | **❌ dropped** |
| Cost ($) | ✅ `totalCostUsd` | ❌ | **❌** |
| Rate limits | ✅ | ✅ | **❌ no ACP concept** |
| Context window | ✅ | ✅ | **❌** |
| Plan / todo | ✅ | ✅ | ✅ native |
| Rollback | fake (local splice) | ✅ real | fake / rejected |
| In-session model switch | ✅ real | ✅ real | ⚠️ spec-marked **UNSTABLE** |

Partly self-inflicted — but ACP's own generated doc-comments mark the usage/cost/`set_model`
schemas *"UNSTABLE… may be removed or changed at any point"*. And **no adapter ever declares
`capabilities: unsupported`** — all five claim full capability, so there is no fallback when an
ACP `set_model` silently no-ops; the host just believes it worked.

### Vendors already escape it

- **Grok** (`XAiAcpExtension.ts`) adds a non-standard `x.ai/ask_user_question` smuggled through
  ACP's `_meta` extension bag, plus a shim for non-conformant stop-reason handling.
- **Cursor** hard-codes mode alias tables (`plan|architect`, `code|agent|default|chat|implement`)
  because ACP session modes are free strings, not a standardized vocabulary.
- **Buzz** escapes twice more: mid-turn steer via vendor extensions, and codex sandbox networking
  via an env var.

**Recommendation: Claude Agent SDK first, ACP client second.** The SDK gives reasoning, context
usage, cost and rate limits — exactly the signals our UI needs and precisely what ACP drops — and
it takes `mcpServers` as an in-process option, so the graph-tools-over-MCP plan drops straight in.
Raw stdio is viable but means re-implementing the whole control channel yourself (most of
t3code's 3,950-line adapter) for strictly less signal.

### Approvals: one signature, three implementations

Claude parks a promise (`canUseTool`); Codex answers server→client JSON-RPC
(`item/*/requestApproval`); ACP uses `session/request_permission`. All three normalize to the
**same three approval kinds** — `command_execution` / `file_read` / `file_change` — behind one
`respondToRequest` signature. The port unifies the interface; there is no shared approval engine.
**That 3-kind vocabulary is a clean abstraction worth copying.**

### The MCP config hazard — solved, and we should copy the solution

This is our known `feat/spawn-credential-injection` bug, found in the wild with both the failure
and the fix:

- **Claude (t3code): raw pointer-swap, no merge.** `ClaudeHome.ts` sets `CLAUDE_CONFIG_DIR` with
  zero copy/seed/symlink logic — point it at a fresh dir and the user's MCP servers **vanish**.
  Mitigated only because `homePath` defaults to `""` (isolation is opt-in).
- **OpenCode: wipes unconditionally** — forces `OPENCODE_CONFIG_CONTENT="{}"`, no opt-out.
- **Codex: solved deliberately.** `materializeCodexShadowHome` symlinks *every* entry **except
  `auth.json` and `models_cache.json`** (`CodexHomeLayout.ts:373-408`). `config.toml` — where
  `[mcp_servers.*]` live — is symlinked through, so MCP config survives by design and only auth
  is isolated per-account.

**Adopt the Codex pattern: isolate only the auth file, symlink everything else.** That gives
per-member credential separation without nuking the member's MCP servers. (`--strict-mcp-config`
from §2.3 is the complementary lever on the Claude side.)

---

## 4B. OpenCode — the best "own the loop" reference, and the ruling it forces

`sst/opencode` (HEAD now merges from **anomalyco/opencode**), **MIT**. TypeScript on Bun, Effect 4,
Drizzle/SQLite. The only major player that owns its agent loop.

**The loop** — hand-written `while(true)` at `packages/opencode/src/session/prompt.ts:1088
(runLoop)`, *not* the AI SDK agent loop. One model turn = Vercel AI SDK `streamText().fullStream`
(`session/llm.ts`), so the AI SDK is only a streaming + tool-parse adapter; opencode owns
everything above it. Inline compaction, AbortController interrupts, and subagents via a `task`
tool that spawns a **child session** (`parent_id`), foreground or background, resumable by
`task_id`. Providers = **models.dev registry + one `@ai-sdk/*` package per provider**, so adding a
provider is roughly a registry entry.

**Storage — copy this.** SQLite `Session(parent_id, revert, permission, …)` → `Message` → **`Part`**,
with a typed part union (`@opencode-ai/schema/session-v1`): `TextPart, ReasoningPart, ToolPart,
FilePart, AgentPart, SubtaskPart, CompactionPart, PatchPart, SnapshotPart, StepStart/FinishPart,
RetryPart`. Tool parts carry running/completed/error and stream as deltas. **Durable, forkable,
re-openable structured turns** — exactly tm8's requirement, and the precise opposite of Buzz's
deliberately-ephemeral transcript.

**Embedding**: `opencode serve` exposes OpenAPI + a generated typed SDK + a WS event stream; it
also implements **ACP agent-side** as a thin wrapper over its own HTTP client. So it embeds as a
*server*, not a library — you cannot swap in your own loop without forking `session/prompt.ts`.

### ⚠ The auth finding, and the ruling it forces

OpenCode proves the loop and the credential are **separable**: auth is plugin-driven, and each
plugin's loader returns a **`fetch` shim** that strips the SDK's key, injects an OAuth bearer, and
rewrites the URL to the vendor's subscription backend —
`chatgpt.com/backend-api/codex/responses` (ChatGPT), `api.githubcopilot.com` (Copilot), with
`originator: "opencode"`. So *technically*, owning the loop does **not** force API keys.

**But this path is closed for Anthropic, legally and technically.** The shipped tree has **no
Anthropic auth plugin**; `packages/llm`'s Anthropic provider is `x-api-key`-only. The official
`opencode-anthropic-auth` package was **removed after a legal request from Anthropic**, and in
**January 2026 Anthropic added server-side enforcement rejecting consumer-subscription OAuth
tokens used outside Claude Code / claude.ai** (anomalyco/opencode#18329). OpenAI/Copilot shims
still work and carry the same enforcement risk.

> **RULING — the line tm8 must not cross.** Two things get called "using my subscription":
>
> | | Status |
> |---|---|
> | **Spawn the vendor's own binary**, let it use its own stored login (t3code, Buzz, tm8 today; the Agent SDK exists for this) | ✅ supported |
> | **Extract the OAuth token and call the API from your own client** (OpenCode's plugins) | ❌ closed — legal takedown + server-side blocking |
>
> **tm8 builds only the top row.** Not merely for compliance: the bottom row yields a product that
> breaks when a vendor flips a flag, and one already has.

**Steal:** the typed Part storage model; the loop shape; the credential/transport **seam** (shipped
pointed at API keys). **Avoid:** shipping any subscription-OAuth plugin, and inheriting their
mid-migration two-generation tree or `effect@4.0.0-beta` lock-in.

---

## 5. Where tm8 actually stands

| Capability | t3code | Buzz | OpenCode | tm8 today |
|---|---|---|---|---|
| Owns the agent loop | ❌ rents | ❌ rents (+1 own) | ✅ **own** | ❌ rents |
| Multi-vendor runtime | ✅ 5 behind a 12-method port | ✅ ACP, 1 client | ✅ models.dev + `@ai-sdk/*` | ❌ PTY byte-scraping |
| Subscription auth | ✅ spawn CLI, isolated config dir | ✅ delegated to adapter | ⚠️ **token extraction — closed** | ✅ *(spawns logged-in CLIs)* |
| Structured turn stream | ✅ normalized event union | ⚠️ ephemeral only | ✅ typed parts | ❌ none |
| Durable structured turns | ✅ events + activities | ❌ deliberately not | ✅ **Session→Message→Part** | ❌ flat markdown |
| Agent replies via tool call | ❌ stdout-derived | ✅ MCP tool | ❌ loop-internal | ✅ `tm8 message send` |
| In-chat approvals | ✅ composer footer | ❌ auto-approve | ✅ per-session ruleset | ❌ n/a |
| Cost/usage durable | ⚠️ tokens, no cost | ✅ kind 44200 (unrendered) | ✅ counters on session | ❌ none |
| Threads (roots feed + panel) | ❌ | ✅ projection | ⚠️ session tree | ✅ `#153` |
| Subagents / delegation | ❌ none | ⚠️ no agent-spawn action | ✅ child sessions | ✅ spawn + dispatch |
| **Knowledge graph of typed entities** | ❌ | ❌ | ❌ | ✅ |

**The strategic read:** the chat box is the commodity. Both prior-art products solved the runtime
and neither has a graph or real orchestration. tm8's differentiators are exactly the two columns
at the bottom — and there is no prior art to copy for them, which is both the risk and the moat.

---

## 6. What this changes in BRIEF.md

1. **D3/D5 are now evidence-backed, not preference.** The control channel is SDK-only over raw
   stdio (§2.1), so a closed pre-authorized graph-tool set is the *enabling* choice for
   multi-vendor, not merely the conservative one.
2. **D4 should go structured-durable** — Buzz shows the cost of flat + ephemeral (§4.3), and
   t3code shows a workable middle: flat sibling arrays joined by `turnId`, collapsed server-side.
3. **The port is ~12 methods.** Two independent products agree on roughly the same surface. Do not
   design a wider one.
4. **ACP is a v2 question, not v1** (§4A) — Claude Code doesn't speak it, and it drops exactly the
   signals our UI needs (reasoning, usage, cost, rate limits). **First integration = Claude Agent
   SDK.**
5. **Deployment ruling implied:** subscription auth is CLI-bound and machine-bound, so the chat
   runtime lives next to the credentials.
6. **New, actionable, and independent of TM8 Chat:** adopt Codex's *auth-only symlink overlay*
   for per-member config isolation (§4A). This fixes the known `feat/spawn-credential-injection`
   MCP-vanishing hazard today, whether or not we build the chat.
7. Corrections: PR #154 is **open**, not merged; `execution.dispatch` **is** live from the browser
   (`ops.ts:659`); `ContentSurface` has 4 members; migration **100** is the next free number.

---

## 7. Not verified

- Whether ACP can drive `claude`/`codex` acceptably through the third-party wrappers (we did not
  install or run them).
- Any performance or concurrency numbers for either product; no load testing.
- Buzz's remote-agent k8s path end to end — it is vision-led and we did not deploy it.
- Whether Anthropic's terms permit subscription-auth CLI spawning in a hosted multi-user product.
  **This is a commercial question, not a technical one, and it should be answered before any
  hosted deployment.**
