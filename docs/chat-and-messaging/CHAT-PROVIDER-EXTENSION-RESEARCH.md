# Chat composer and headless runtime: how it works today, and how to add Codex and cross-provider switching

**Status:** research. Nothing in this document is implemented.
**Date:** 2026-10-02
**Task:** 01a0fb18-32ec-7f71-ab91-0427eb86e877 ("Chat Composer")
**Baseline:** `main` at `acd0b8169` (#979)
**Host facts measured here:** `claude` 2.1.280, `codex-cli` 0.154.0

This answers five questions:

1. What recently merged in the chat composer?
2. How does chat run headless Claude?
3. What exact command does it spawn, and what goes over the pipe?
4. How could chat run on Codex and other models?
5. How could a user switch provider mid-chat so the next turn runs elsewhere?

Read §1–§3 as a description of the code as it stands. §4–§5 are proposals.

---

## 1. Recent merges touching the chat composer

Newest first. The two most recent PRs are the ones that matter for this task.

| PR | What changed |
|---|---|
| **#979** `acd0b8169` | A locked model picker now looks locked: `ModelEffortPicker` sets `aria-disabled` from the picker-level `disabled` flag, and the tooltip falls back to the picker-level reason. Follow-up to #978. |
| **#978** `3308ea281` | **A running chat can switch model and mode mid-conversation.** Migration 276 adds `chat_turns.model` and `.provider`, a `set_chat_model` RPC, and `chat.setModel` (`POST /v2/chats/:id/model`, CLI `tm8 chat model <chat-id> <model>`). The orchestrator closes the live child and re-spawns it with `--resume` on the new model. The mode chip is unlocked, and each turn now sends `mode` over the existing 153/154 carrier. Design doc: `docs/chat-and-messaging/CHAT-MODEL-SWITCH-DESIGN.md`. |
| #977 | Entity Help page for chat. Documentation only. |
| #934 | Mobile: conversations sit behind one drawer row, and the Chats section gains a "New task" verb. |
| #921 | Home list header: quick-create icons for task, chat and terminal. |
| #901 | Messages written by a chat now reach work sessions. |
| #895 | One step header per turn; every failure is kept and folded (tool-call rules R1–R8). |
| #875 / #877 / #880 / #881 / #878 / #882 / #886 / #890 | "Chat wave" L1–L5: send paints immediately, per-run step lists, created entities highlighted, a live "agent is working" row, thread switching and per-thread failures, plus follow-ups. |
| #844 | Live context number for chats; per-turn usage fix. |
| #838 | Fixed resume of an expired chat. This is the "transcript is gone, so start fresh under the same id" fallback in the adapter. |
| #834 / #825 / #824 / #822 / #821 | Entity chat: new-chat settings card, per-kind chat defaults, chat slot beside Run, subject line in the Chats list, and the server-written `[about …]` line. |

**Still open after #978 and #979** (from the design doc and checked again here):

- **The effort dial does nothing.** No `effort` field exists anywhere in `packages/server/src/chat` or `packages/execution/src/runtime`, and the headless `buildArgs` never passes `--effort`.
- **Mode is per-turn only.** No `chat.setMode` exists.
- **The model is sticky and cannot cross `agentTool`.** Chat refuses a Codex model in four places:
  - the UI, `composer-model.ts:261`
  - the handler, `handlers.ts:146`
  - the SQL, `276_…sql:126`
  - the launch resolver, `compose.ts:250`
- **Neither chip has been driven in a real browser.** The #978 commit message says so.

## 2. How chat runs headless Claude

### 2.1 The path of one turn

```
Composer (ChatHomeScreen.tsx)
  └─ postTurn {text, mode?}                     chat-home/real-port.ts
      └─ messages.post → w2_post_message_batch  (SQL; p_chat_turn_mode, 154)
          └─ trigger enqueues chat_turns row    (mode copied from messages.requested_chat_mode)
              └─ ChatOrchestrator.drain → claim_next_chat_turn(uuid)   (orchestrator.ts:416)
                    model    = coalesce(chat_turns.model,    chats.model)     ← 276, first claim wins
                    provider = coalesce(chat_turns.provider, chats.provider)
                    mode     = coalesce(chat_turns.mode,     chats.chat_mode)
                  └─ runTurn → ensureRuntime(turn)                         (orchestrator.ts:606)
                        reuse live child iff same auth identity + auth kind + model
                        else close it, then start with resume-after-interrupt
                      └─ resolveLaunchConfig                               (compose.ts:241)
                            refuse agentTool ≠ 'claude-code'
                            mint agent_runtime token (requester's claims)
                            write <dataDir>/chat/<chatId>.mcp.json (0600)
                            systemPrompt = chatSystemPrompt() (does not depend on mode)
                            tools = chatProviderToolPolicy(mode)
                      └─ ClaudeHeadlessAdapter.startThread → spawn `claude -p …`
                  └─ sendTurn(text = envelope + body) → one stream-json line on stdin
                  └─ stdout events → TurnItem union → publisher writes message parts
```

The adapter is composed once per node at `compose.ts:333`, through `wrapExecutionAgentRuntime`. That wrapper does one thing: it translates the server's `resume: {nativeSessionId, cwd}` into the execution port's `resume: 'post_interrupt'`.

### 2.2 The turn envelope

The system prompt does not depend on the mode. It describes all six modes once. Each turn's text then opens with server-written lines, built in `orchestrator.ts` around line 257:

```
[mode: build]
[about task 01a0… · "Chat Composer"]                   (entity chats only)
[from "Alice" · member 01a0…]                          (or session / chat sources)
[attached 2 files …] / [file <id> "<name>" <mime>]     (when present)
<the human's message body>
```

That is why a mode switch needs no respawn. A model switch does, because the model is an argv value fixed when the process starts.

### 2.3 Process lifecycle (`packages/execution/src/runtime/ClaudeHeadlessAdapter.ts`)

- **One hot process per chat.** stdin stays open between turns, so the prompt cache and context survive.
- **Boot:** `--session-id <tm8-minted uuid>` on first start. A 150 ms settlement window catches a missing binary or an immediate crash. A `system/init` event whose `session_id` differs from the minted id fails the turn with `native_session_mismatch`.
- **Interrupt:** `SIGINT`. Claude emits an aborted `result` and the process exits 0. The adapter writes a tombstone `{nativeSessionId, cwd}`. Since 276 the tombstone no longer records the model, so Stop → switch model → send works.
- **Close:** end stdin, wait 1 s; then `SIGTERM`, wait 1 s; then `SIGKILL`, wait 1 s; then throw `close_failed`.
- **Resume:** `--resume <same uuid>`. If no `<uuid>.jsonl` exists under any `projects/` directory (Claude deletes transcripts after 30 days), the adapter falls back to a fresh `--session-id` under the same id. The model forgets its own history; tm8's messages are untouched.
- **Environment:** an allow-list, not a copy of the server's (`chat-env.ts`):
  `HOME USER LOGNAME SHELL PATH LANG LC_ALL TERM COLORTERM TMPDIR XDG_CACHE_HOME`, plus the agent bin dirs on `PATH`. No `TM8_*`, no `ANTHROPIC_*`, no `CLAUDE_CONFIG_DIR`.
- **Usage:** Claude's `result.modelUsage` and `total_cost_usd` are running totals for the process. The adapter emits the difference between consecutive results as this turn's usage, and a resumed process starts from the remembered totals.

## 3. The exact Claude command and wire protocol

### 3.1 argv (`buildArgs`, `ClaudeHeadlessAdapter.ts:498`)

```bash
claude -p --verbose \
  --input-format stream-json --output-format stream-json \
  --model <model> \
  --setting-sources '' \
  --disable-slash-commands            # or: --plugin-dir $TM8_CHAT_SKILLS_DIR
  --mcp-config <dataDir>/chat/<chatId>.mcp.json --strict-mcp-config \
  --permission-mode bypassPermissions \
  --tools Read,Glob,Grep,Bash,WebFetch,WebSearch,Edit,Write,TodoWrite,Skill \
  --allowed-tools 'Read(/**)' WebFetch WebSearch 'Edit(/**)' TodoWrite mcp__tm8__<every exposed tool except the repo_*/web_* ones Claude has natively> \
  --session-id <uuid>                 # or: --resume <uuid> after an interrupt or model switch
  --system-prompt "<chatSystemPrompt(...)>"
```

The process is spawned with `cwd = <the thread's bound workdir>`, `shell: false`, and stdio on three pipes.

### 3.2 The per-chat MCP config it points at

```json
{ "mcpServers": { "tm8": {
    "command": "<node>", "args": ["<@tm8/mcp>/dist/cli.js"],
    "env": {
      "TM8_BASE_URL": "http://127.0.0.1:17777",
      "TM8_AGENT_RUNTIME_TOKEN": "<minted per start, ≤24h>",
      "TM8_CHAT_ID": "<chatId>", "TM8_CHAT_MODE": "<launch mode>",
      "TM8_CHAT_SPACE_ID": "<spaceId>",
      "TM8_CHAT_HIDDEN_TOOLS": "repo_read_file,repo_glob,…,web_search",
      "TM8_CHAT_PROJECT_ROOT": "<cwd>" } } } }
```

### 3.3 stdin, one line per turn

```json
{"type":"user","message":{"role":"user","content":"[mode: ask]\n[from \"…\" · member …]\n<body>"}}
```

### 3.4 How stdout events map to `TurnItem`

| Claude event | TurnItem |
|---|---|
| `system/init` | session id check only |
| `system/compact_boundary` | `context` (cleared) |
| `assistant` → `thinking` block | `thinking` |
| `assistant` → `text` block | `text` |
| `assistant` → `tool_use` block | `tool_call {state:'running'}` |
| `user` → `tool_result` block | `tool_result`, then `tool_call {state:'completed'\|'error'}` |
| `result` | `error` if failed, then `usage`, then `done {success\|error\|interrupted}` |
| assistant `message.usage` per request | `context` (live context reading) |

### 3.5 Reproducing it by hand

Run this in an empty dir. It uses no MCP and no tools:

```bash
sid=$(uuidgen)
printf '%s\n' '{"type":"user","message":{"role":"user","content":"Say PLUM-7741"}}' |
  claude -p --verbose --input-format stream-json --output-format stream-json \
    --model claude-haiku-4-5-20251001 --setting-sources '' --disable-slash-commands \
    --disallowed-tools Bash Read Edit Write --session-id "$sid" --system-prompt "test"
# then switch model and resume. The #978 design doc measured that history survives:
printf '%s\n' '{"type":"user","message":{"role":"user","content":"What codeword?"}}' |
  claude -p --verbose --input-format stream-json --output-format stream-json \
    --model claude-sonnet-5 --setting-sources '' --disable-slash-commands \
    --disallowed-tools Bash Read Edit Write --resume "$sid" --system-prompt "test"
```

## 4. Gaps found while tracing (not covered by #978)

These came from reading the code and have not been checked against a live chat. Each needs a five-minute repro before anyone fixes it.

1. **Kimi models are offered in chat but get no API-key routing.**
   - The Kimi rows (`kimi-k2-*`) are `provider: 'moonshot'` with `agentTool: 'claude-code'`.
   - So they pass the composer's filter (`composer-model.ts:261` checks only `agentTool`), pass the handler, and pass `set_chat_model`.
   - Work sessions point those rows at Moonshot through `agent-credential-injection.ts` → `apiKeyBackendForModel`, which sets `ANTHROPIC_BASE_URL=https://api.moonshot.ai/anthropic` and `ANTHROPIC_AUTH_TOKEN`.
   - **The chat path never calls it.** `createChatLaunchConfigResolver` returns no `env`, and `CHAT_ENV_KEYS` drops both variables.
   - Expected result: `claude --model kimi-k2-thinking` against the node's Anthropic login, failing on the first turn.
   - Fix: either filter `provider !== 'anthropic'` out of the chat picker, or route chat through the same credential injection.
2. **Chat runs on the node's own Claude login, never the member's or the Space's.**
   - No `CLAUDE_CONFIG_DIR` reaches the chat child, so it uses `$HOME/.claude`.
   - Work sessions resolve per-space or per-member credential homes (`space-credential-home.ts`).
   - This matters for §5: switching provider means choosing a credential, and today chat has no credential selection at all.
3. **The effort dial is decorative** (confirmed again). The fix is cheap for Claude: thread `effort` into `ChatLaunchConfigInput` and add `--effort` to `buildArgs`. Effort is argv like the model, so changing it needs the same close-and-`--resume` path.

## 5. Extending chat to Codex (and others)

### 5.1 Which Codex surface to drive

Codex has three non-interactive surfaces. All three were checked on this host (0.154.0):

| Surface | Shape | Fit for chat |
|---|---|---|
| **`codex app-server`** (stdio JSON-RPC, marked experimental) | Long-lived process, `thread/start`, `thread/resume`, **`turn/start` with a per-turn `model`/`effort`**, `turn/interrupt`, and streaming `item/*` notifications | **Best fit.** The same hot-process shape as the Claude adapter. `initialize` answered over stdio here. |
| `codex exec --json [-m model] "<prompt>"` + `codex exec resume <id>` | One process per turn, JSONL events on stdout | Workable fallback. No hot process, so each turn pays a cold start and there is no live prompt cache. Interrupt means killing the process. |
| `codex` interactive in a PTY | What work sessions use (`buildCodexArgs`, `manifest.ts:1039`) | Wrong shape. Chat is pipe-driven by design (`types.ts` header). |

The generated TypeScript (`codex app-server generate-ts`) shows what makes app-server attractive:

- `ThreadStartParams { model, modelProvider, cwd, approvalPolicy, sandbox, config, baseInstructions, developerInstructions, ephemeral }`
  - `baseInstructions` / `developerInstructions` stand in for `--system-prompt`.
  - `config` carries `mcp_servers.tm8.*`, the equivalent of `--mcp-config`.
- `TurnStartParams { threadId, input[], model?, effort?, cwd?, sandboxPolicy?, approvalPolicy? }`. Each override applies to "this turn and subsequent turns". **Switching model on Codex needs no respawn,** which is better than Claude.
- `ThreadResumeParams { threadId, model?, … }` resumes a persisted rollout.
- `turn/interrupt` interrupts the turn without killing the process.

### 5.2 Mapping Codex events onto the existing `TurnItem` union

The C1 union is provider-neutral already. Nothing in the server, publisher or UI should need to change.

| app-server notification / item | TurnItem |
|---|---|
| `item/reasoning/textDelta` · `item/reasoning/summaryTextDelta` (or `reasoning` item on completion) | `thinking` |
| `item/agentMessage/delta` / `agentMessage` item | `text` |
| `item/started` for `commandExecution` / `mcpToolCall` / `fileChange` / `webSearch` / `dynamicToolCall` | `tool_call {running}` |
| `item/completed` for the same | `tool_result`, then `tool_call {completed\|error}` |
| `thread/tokenUsage/updated` | `usage` (convert running totals to per-turn steps exactly as the Claude adapter does) and `context` |
| `thread/compacted` | `context` (cleared) |
| `error` / failed `turn/completed` | `error` |
| `turn/completed` | `done` |

**Batching decision:** the Claude adapter emits whole content blocks, not deltas. A Codex adapter should buffer the deltas and emit on `item/completed`, so the transcript UI sees the same granularity from both.

### 5.3 What has to change, file by file

| Layer | Change |
|---|---|
| `packages/execution/src/runtime/CodexAppServerAdapter.ts` (new) | `implements AgentRuntime`. Spawns one `codex app-server` per chat. Isolating credentials per process (one `CODEX_HOME` each) is simpler than multiplexing threads in one daemon. Does `initialize` → `thread/start` or `thread/resume` → `turn/start` per turn. Maps events per §5.2. Interrupt goes through `turn/interrupt`, close through the same stdin-end / SIGTERM / SIGKILL ladder. |
| `runtime/types.ts` `StartAgentThreadInput` | Today it is shaped around Claude. Generalize: <br>• `nativeSessionId` → optional on start, **returned** from `startThread`. Codex mints its own thread id; Claude accepts a pre-minted one. <br>• `mcpConfigPath` → a provider-neutral `mcpServers` description that each adapter renders (JSON file for Claude, `config.mcp_servers` for Codex). <br>• `availableTools` / `allowedTools` → stay as provider-specific output of a per-tool policy function. <br>• add `effort?`. |
| `packages/server/src/chat/runtime.ts` + `orchestrator.ts` | Add `agentTool` to `ClaimedTurn` and `liveChats`. Persist the returned native id when the adapter minted it (new RPC, or extend `mark_chat_runtime_state`). |
| `packages/server/src/chat/compose.ts` | <br>• **Runtime router:** `RoutingAgentRuntime({ 'claude-code': claude, codex })`. It picks the adapter on `startThread` from the input's `agentTool` and keeps a `threadId → adapter` map for `sendTurn` / `interrupt` / `close`. <br>• **Resolver:** drop the refusal at line 250 and branch the tool policy. `CLAUDE_NATIVE_REPLACEMENTS` becomes per tool. Codex has native `shell`, `apply_patch` and `web_search`, but no `Read`/`Glob`/`Grep`, so for Codex keep `repo_read_file` / `repo_glob` / `repo_grep` and hide `repo_bash` and `repo_write` / `repo_edit`. <br>• **System prompt:** goes through `developerInstructions`. |
| Sandbox posture | Chat's Claude posture is "full trust" (`bypassPermissions`). The Codex equivalent is `approvalPolicy: 'never'` plus a sandbox choice. Reuse `codexNetworkPreflight` and the `TM8_REQUIRE_CODEX_SANDBOX` rule from `SpawnService.ts:1033` rather than inventing a second policy. |
| `chat-env.ts` | Add a Codex allow-list: `CODEX_HOME`, plus `OPENAI_BASE_URL` / `OPENAI_API_KEY` **only** when the model routes to Groq. Mirror `API_KEY_BACKEND_ROUTING`. |
| Refusals to remove | `compose.ts:250`, `handlers.ts:146`, `composer-model.ts:261`. The SQL `22023` at `276:126` goes too, but only together with §6 (cross-tool switch). Until then a chat chooses its tool at `chat.start` and keeps it. |
| Tests | Extend `headless-agent.mjs`'s approach: a deterministic fake app-server speaking JSON-RPC over real pipes. Add one opt-in live smoke test against the real `codex app-server` (initialize, then a one-word turn). |

### 5.4 Other models

- **Kimi (Moonshot):** already speaks Anthropic's wire protocol, so it runs on the Claude adapter. It needs only the env routing from §4.1, through the existing `apiKeyBackendForModel`. **This is the cheapest "other provider" and should land first.**
- **Groq models (gpt-oss, Kimi K2 on Groq, Llama, Qwen):** `agentTool: 'codex'` with `OPENAI_BASE_URL` routing. They arrive for free once §5.3 lands, but Groq effort stops are limited to `low|medium|high` (`GROQ_GPT_OSS_EFFORTS`).
- **Gemini CLI or others:** a new adapter is worthwhile only if the CLI has a structured, long-lived headless protocol with an external MCP config and session resume. **Not verified for any CLI other than Claude and Codex.** Check each candidate against the four port methods before committing.
- **Direct API runtime** (Messages API / Responses API, with tm8 MCP tools served in process): it would make any model with tool calling available without a vendor CLI. But it means owning the agent loop, file tools and compaction. That is a separate, much larger project; not recommended as the next step.

## 6. Switching provider mid-chat for the next turn

### 6.1 What already works (since #978)

Switching model within the same `agentTool` is a sticky property of the chat:

- `chat.setModel` stores the model.
- The next claim stamps `chat_turns.model` (first claim wins).
- `ensureRuntime` sees `live.model !== turn.model`, closes the child and restarts with `--resume`.
- The conversation survives. Measured: `claude --resume <sid> --model <other>` recalls earlier turns.

Today's model switching is anthropic ↔ anthropic, which is the only same-tool switch that runs today. Kimi also shares the `claude-code` tool, but §4.1 means a Kimi turn would likely fail.

### 6.2 Why a Claude ↔ Codex switch is a different problem

The vendor transcripts are not portable. A Claude session is `~/.claude/projects/<slug>/<uuid>.jsonl`; a Codex thread is a rollout under `~/.codex/sessions`. Neither CLI can resume the other's. The only shared record of the conversation is **tm8's own: the chat's messages and their parts.** So a cross-tool switch has to hand the conversation over, not resume it.

### 6.3 Proposed design: one native session per tool, with a catch-up preamble

**Data:**

```sql
-- one native conversation per (chat, tool); chats.native_session_id stays the claude one for compat
create table chat_native_sessions (
  chat_id            uuid references chats(id),
  agent_tool         text not null,          -- 'claude-code' | 'codex'
  native_session_id  text,                   -- null until the adapter returns one (codex)
  synced_through_turn uuid,                  -- last chat_turn this native transcript has seen
  primary key (chat_id, agent_tool)
);
alter table chat_turns add column agent_tool text;   -- stamped at claim, coalesce(turn, chat) like model
```

`set_chat_model` stops refusing an `agent_tool` change. Instead it moves `chats.agent_tool` together with `model` and `provider`, still resolved server-side from the catalog (§4c of the #978 doc: callers never name a provider).

**Orchestrator (`ensureRuntime`):**

1. Add `agentTool` to the reuse check: reuse only if identity, auth kind, model **and agentTool** match.
2. On a change, close the live child (this already happens).
3. Look up `chat_native_sessions[(chat, turn.agentTool)]`:
   - **It exists:** resume it (`--resume` for Claude, `thread/resume` for Codex). Then **catch up** on the turns that ran on the other tool since `synced_through_turn`.
   - **It doesn't:** start a fresh native session and **seed** it with the whole conversation so far.
4. After each successful turn, advance `synced_through_turn` for the tool that ran it.

**Catch-up / seed preamble:**

- Built server-side from tm8 messages, not from either vendor transcript.
- Delivered as a server-written block ahead of the turn's own envelope, in the same family as `[mode: …]` and `[from …]`:

```
[handoff: this chat ran on claude-opus-5-5 for the turns below; you are now codex/gpt-6-astra]
[turn 12 · from "Alice"] <body>
[turn 12 · agent] <final text; tool calls condensed to one line each: "ran repo_grep 'x' → 14 hits">
…
```

- For Codex, it can go through `developerInstructions` on `thread/start` or through `thread/inject_items`. For Claude, prefix it to the user turn text.
- Budget it: last *N* turns verbatim, older turns as a summary. Drop tool output bodies and keep only names and one-line results. Treat the preamble as untrusted data, exactly as the system prompt already says of quoted messages.

**What does not carry over, and should be stated in the UI:**

- The previous model's private reasoning and full tool outputs.
- Its prompt cache. The first turn after a switch is a cold, full-price turn.
- Its TodoWrite scratchpad.

The working directory, the graph and repository state, and tm8 messages all carry over, because they are tm8's.

**Composer:**

- Remove the `disabledReason` for Codex models (`composer-model.ts:261`).
- When the selection crosses tools, show one inline note: "Switching to Codex: the conversation is handed over as a summary; the next turn starts a fresh context".
- Badge each agent turn with `chat_turns.model`, so a mixed-provider transcript stays readable. NULL means unknown (pre-276 rows).
- Keep the optimistic `modelOverrides` behaviour from #978. A switch still applies to the **next** claimed turn; the in-flight turn finishes on the old model.

**Security and credentials, which must land with the switch:**

- `chat.setModel` is already classed `process_start` for space-link identities. That stays correct: a cross-tool switch picks a different credential, which is exactly what that class guards.
- §4.2 has to be solved first. If chat keeps spawning on the node's ambient `~/.claude` / `~/.codex`, a cross-provider switch silently spends the node operator's OpenAI login. The launch resolver must resolve the requester's credential home for the target tool, the way `agent-credential-injection.ts` does for work sessions. It must refuse with a readable reason when the member has no Codex credential, rather than falling back to the node's.
- Keep the provider derived on the server.

**Mode tool policy:**

- Mode switching stays free only while `toolPermission` returns `allow` (`modes.ts`). That invariant does not change.
- A per-tool `chatProviderToolPolicy(mode, agentTool)` is fixed at spawn just as today. A cross-tool switch respawns anyway, so the new tool gets its own policy. Nothing half-applies.

### 6.4 Suggested phasing

Each phase can merge on its own:

1. **Correctness of what exists:** fix §4.1 (Kimi routing, or filter it out of the chat picker) and wire the effort dial (§4.3). Both are small and need no schema change.
2. **Chat credentials:** resolve a credential home per requester for the chat child (§4.2). This is a prerequisite for anything that spends a second vendor's credential.
3. **Codex chat, no switching:** `CodexAppServerAdapter`, the runtime router, the per-tool policy and env, and removing the three non-SQL refusals. A chat picks Claude or Codex at `chat.start` and keeps it. Codex model switching inside a Codex chat comes free through `turn/start.model`.
4. **Cross-tool switch:** `chat_native_sessions`, `chat_turns.agent_tool`, the relaxed `set_chat_model`, catch-up preambles and the composer note.

### 6.5 Open questions for the owner

- Is the hand-over summary acceptable UX, or should a cross-tool switch fork into a new chat that links back? The fork is simpler and more honest about the lost context, but it is not what the #978 report asked for.
- Should a cross-tool switch be blocked while a turn is in flight? #978 allows switching mid-answer, and a cross-tool switch costs more.
- Should Codex run with the full-trust posture (`--dangerously-bypass-approvals-and-sandbox` equivalent) to match chat-on-Claude, or sandboxed? The work-session rules decide this for lanes. Chat has no ruling yet.

## Provenance

- §1 comes from `git log` on `main`.
- §2–§4 come from reading the files cited, at `acd0b8169`. The code graph was not consulted. Every question here was about intent and behaviour inside a few known files, which the graph does not answer.
- The §5.1 Codex facts were checked on this host:
  - `codex exec --help` and `codex app-server --help` (0.154.0).
  - `codex app-server generate-ts`, for `TurnStartParams`, `ThreadStartParams` and `ThreadResumeParams`.
  - A real `initialize` round-trip over stdio.
- **No Codex model turn was run.** Whether app-server's `item/*` streams behave as §5.2 assumes under load is unverified.
- §4.1 (Kimi in chat) is an inference from code paths. It has not been reproduced against a live chat.
