# TM8 Chat — design brief

Task `019fecfa-8b95-7c08-a5a0-6143aaec044b`. Written 2026-08-11.
Status: **brief for discussion — nothing built, nothing decided.**

Builds on, and in two places corrects, the earlier research doc
*"Building a tm8 Chat on the Claude Agent SDK"* (entity `019fb7aa-a854-7f4f-b933-814f88b7c951`,
2026-07-31). Read that one for the t3code comparison; this one is about the product you
described: **one chat box in the centre that works on the graph.**

---

## 0. Verdict

Feasible, and cheaper than it looks — but it is **three separable products**, and the design
work is mostly deciding which one you mean and in what order. The hard part is not the model
loop. It is (a) tool authorization and (b) the fact that a structured chat needs a durable
shape that tm8's `messages` table does not currently have.

---

## 1. Three findings, measured today on this machine

These are runs, not recollection.

### F1 — Both vendor CLIs already speak a structured, non-PTY protocol. We do not need to build one.

`claude` 2.1.77, driven over stdio with no terminal at all:

```
echo '{"type":"user","message":{"role":"user","content":"..."}}' \
  | claude -p --verbose --input-format stream-json --output-format stream-json --model haiku
```

emits typed JSONL, verbatim from the run:

```
[system/init]   model=claude-haiku-4-5-20251001 tools=0 sid=77637d1b
[assistant]     [{'type':'thinking', 'thinking':'...'}]
[assistant]     [{'type':'text', 'text':'PROTOCOL_OK'}]
[rate_limit_event]
[result/success] cost=0.004158 turns=1
```

That is the whole chat UI's data model — thinking blocks, text blocks, tool blocks, cost,
rate limits — with zero ANSI parsing. The bidirectional **control channel** is there too:
the bundled `cli.js` contains `control_request` (25), `control_response` (40), `canUseTool`
(41), `permission_request` (15), `hook_callback` (2). That channel is what the Claude Agent
SDK is a typed client *for* — approvals, interrupt, set-model mid-thread.

`codex` 0.147.0 goes further. `codex app-server generate-json-schema --out <dir>` emitted
**39 JSON Schema files describing its entire session protocol**, including 95 client methods:

```
thread/start  thread/resume  thread/fork  thread/rollback  thread/compact/start
turn/start    turn/interrupt turn/steer
model/list    account/rateLimits/read   mcpServer/tool/call
```

plus approvals as server→client JSON-RPC requests (`ExecCommandApproval`,
`ApplyPatchApproval`, `PermissionsRequestApproval`, `ToolRequestUserInput`).
`codex app-server generate-ts` will emit TypeScript bindings directly.

**Consequence:** the runtime adapter is a protocol *client*, not an agent implementation.
Both vendors independently converged on thread + turn + typed items + approval requests,
so one tm8-owned turn model covers both.

### F2 — "Same subscription as Claude Code / Codex" forces one adapter per vendor CLI. No API SDK can do it.

`~/.codex/auth.json` on this machine:

```
keys: ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh']
OPENAI_API_KEY set: False
```

Subscription OAuth tokens, no API key. A ChatGPT subscription is **not reachable** from the
`openai` SDK or a raw HTTP call — only the `codex` binary knows how to mint and refresh
against it. Same story on the Anthropic side.

**Consequence, and this is the load-bearing one:** "one chat, many models on the
subscriptions we already pay for" cannot be built as *one* SDK integration. It is
`N` thin adapters, one per vendor CLI, unified behind a tm8 turn model. The Claude Agent
SDK is then optional — it is a typed client for the `claude` stdio protocol we can also
speak directly. Adopting it buys typings and maintenance; it buys nothing structural,
and it covers only 1 of N vendors.

### F3 — MCP is the only tool transport both hosts accept. That decides the "teammate tools" question.

You said *"we'll be just calling the teammate API or teammate tools, maybe."* The constraint:

| Tool mechanism | claude | codex |
|---|---|---|
| In-process SDK `tool()` | yes | **no** |
| stdio MCP server | yes (`--mcp-config`) | yes (`codex mcp`, `mcpServer/tool/call`) |
| Shelling out to `tm8` CLI | yes (Bash) | yes (Bash) — *this is what we do today* |

In-process SDK tools would be Anthropic-only, so they lose F2 on day one.

**Consequence:** the graph tool surface must be an **stdio MCP server** — which is exactly
the outbound half of the already-scoped `docs/features/mcp/MCP-INTEGRATIONS-RESEARCH.md`
(~8 curated tools, built as a non-catalog transport). TM8 Chat and MCP are not two
roadmap items. They are one item, and the chat is its first consumer.

---

## 2. Two corrections to the prior research

**C1 — `PtyHostService` is not a port, so "swap the pipe" is not a drop-in.**
The 2026-07-31 doc frames this as replacing an injected transport. In the tree,
`SpawnServiceOptions.pty` (`packages/execution/src/spawn/SpawnService.ts:51`) is typed
against the **concrete class** `PtyHostService` — ~1300 lines, 25 public methods, most of
them irreducibly terminal-shaped: `write`, `resize`, `getReplay`, `getSize`, `getEpoch`,
`addSubscriber`, `activatePendingSubscriber`, `attach`, `onFrames`, `deliverPrompt`.
There is no `interface PtyHostService` anywhere. A chat runtime satisfying that surface
would be mostly stubs.

*Ruling this implies:* build the chat runtime as a **sibling service** to `SpawnService`,
not a substitution inside it. Terminal sessions and chat threads are two runtimes over one
graph. Extracting a real port is a later refactor, if ever.

**C2 — `execution.transcript` is not a canonical turn model.**
It reads provider JSONL *after the fact* and its `stats.userMessages/assistantMessages`
count raw records, so a real transcript reads ~16x wrong (a tool *result* is a
`type:'user'` record). It stays useful as a read-side fallback for PTY sessions. It cannot
be the chat's storage.

---

## 3. What already exists — do not rebuild it

Measured in `packages/tm8-ui`:

- **`ChannelScreen.tsx` is already a pure view** — it takes an `EntityFeedPage` as a prop and
  fetches nothing. That is the right shape for a new host to reuse.
- **`SessionChatSurface.tsx`** is the data orchestrator pattern (store + controller +
  mutations via `useChannelFeed`), keyed `[viewerMemberId, sessionId, scope, filter]`,
  with durable drafts. Copy this, don't reinvent it.
- **Feed scopes** already exist: `session_chat_v1`, `channel_chat_v1`, `direct_v1`.
- **The graph screen exists** (`graph/GraphScreen.tsx`, plus `session-graph/`) with
  degree-of-interest relevance already landed.
- **The events WebSocket exists and is authenticated** (`/v2/ws`, cookie-based since #91).
- **Orchestration already works**: `execution.spawn`, `execution.dispatch`, loops, the
  resident Dispatcher teammate, `remembers`/`triggered_by`/`authored_from` provenance edges.
  A chat agent that "orchestrates sessions" is *calling things that already ship*.

**The gap that matters:** a tm8 message is a **flat markdown string**
(`content: { body, mentions, attachments }`). There is no notion anywhere in tm8-ui of a
thinking block, a tool call, a tool result, a diff, or an approval. That single absence is
most of the UI work.

---

## 4. Proposed architecture — five layers

```
  ┌─ L5  UI ─────────────────────────────────────────────────────────┐
  │  new top-level destination: centre composer + turn items         │
  │  + entity/graph rail. Reuses ChannelScreen's view discipline.    │
  ├─ L4  Stream ─────────────────────────────────────────────────────┤
  │  existing authed /v2/ws events socket, new frame kind            │
  ├─ L3  Tools ──────────────────────────────────────────────────────┤
  │  tm8 stdio MCP server, ~8-12 curated graph tools                 │
  │  executed under the REQUESTING HUMAN's claims                    │
  ├─ L2  Turn store ─────────────────────────────────────────────────┤
  │  message = durable unit (keeps anchors/mentions/notifications)   │
  │  + sibling items table keyed by message id                       │
  ├─ L1  Runtime ────────────────────────────────────────────────────┤
  │  AgentRuntime port; ClaudeAdapter (stream-json stdio)            │
  │                     CodexAdapter (app-server JSON-RPC)           │
  │  SIBLING of SpawnService — not a PtyHostService replacement      │
  └──────────────────────────────────────────────────────────────────┘
```

**L1 port shape** (small on purpose — both vendors already fit it):
`startThread` · `sendTurn` · `interrupt` · `respondToApproval` · `close`,
emitting a tm8-owned `TurnItem` union: `text` · `thinking` · `tool_call` ·
`tool_result` · `approval_request` · `usage` · `error` · `done`.

**L1 mapping already verified:**
`composePrompt`'s existing `{system, task}` split maps exactly onto claude's
`--system-prompt` / first user message. Pre-minted `--session-id <uuid>` maps onto the
`native_session_id` column tm8 already backfilled for resume. `thread/resume` and
`thread/fork` on the codex side give the same two properties.

**One gotcha to bake in from day one:** `--setting-sources` must be passed empty, or a
server-hosted agent silently inherits the operator's `~/.claude` and the repo `CLAUDE.md`.

---

## 5. Decisions I need from you

Researched positions, not a blank menu. Each has a recommendation and a reason.

**D1 — Is this the front door, or a fifth surface?**
`ContentSurface` today is `terminal | chat | debug | graph`, per session.
*Recommend:* a **new top-level destination** ("Chat"), one thread list, not a per-session
tab. The existing per-session chat surface stays as-is for terminal sessions. Your phrase
"a single point" reads as front door — confirm.

**D2 — Who does the chat agent act AS?**
Options: (a) as you, (b) as a teammate acting on your behalf.
*Recommend (b) with tools executing under YOUR authorization.* Identity gives provenance
(`authored_from`, avatars, "who did this"); authorization must stay yours so the agent can
never exceed you. This needs a fourth `authKind` — today the credential guard allowlists
`browser|cli` and an in-process caller would silently inherit human privileges including
the credential ops.

**D3 — Does the chat agent get a filesystem?**
*Recommend: no cwd, no file/shell tools in v1 — graph tools only.* It orchestrates by
spawning real worker sessions that have filesystems. This removes the entire sandbox and
tool-approval problem class, and is why D5 falls out for free.

**D4 — Turn durability: full fidelity, or flat + activities?**
*Recommend: message stays the durable unit* (so anchors, mentions, attachments, unseen
marks, notifications and the whole existing graph keep working unchanged), **with a sibling
items table keyed by message id** for thinking/tool/usage. t3code's model, adapted so it
composes with tm8's anchoring instead of replacing it.

**D5 — Approvals in the browser?**
*Recommend: not in v1.* With D3 the tool set is closed and read/write-scoped to the graph,
so there is nothing to approve. Both protocols support approval requests, so this stays
open for v2 when the chat agent gets a workspace.

**D6 — Model switching inside one thread?**
Thread state lives in the **vendor's** store (`~/.claude/projects/…`, `~/.codex/sessions/…`).
Cross-vendor continuity is therefore impossible without tm8 replaying its own history into
the new vendor. *Recommend:* model is chosen per thread; switching vendors **forks** a new
thread seeded with a tm8-rendered summary. Switching *within* a vendor is cheap.

**D7 — Can the chat agent spawn and dispatch?**
*Recommend: yes* — that is the entire point, and `execution.spawn` / `execution.dispatch`
already work. Note `execution.dispatch` shipped dead from the browser and is fixed in PR
#154; TM8 Chat would be its second consumer, so that fix is a dependency.

---

## 6. Work breakdown — what this design task actually contains

Phase ordering is dependency-driven, not ambition-driven.

| # | Work | Depends on | Notes |
|---|---|---|---|
| 0 | **Settle D1–D7** | you | Everything below branches on D2/D3 |
| 1 | Spike: drive both CLIs from a Node harness, dump both event streams side by side | — | Half a day. Produces the real `TurnItem` union instead of a guessed one. Cheap, and it is the only honest way to size the rest |
| 2 | `AgentRuntime` port + `ClaudeAdapter` | 1 | The stdio protocol is proven; this is plumbing + lifecycle + crash handling |
| 3 | `CodexAdapter` | 2 | `generate-ts` gives bindings; validates the port is not Anthropic-shaped |
| 4 | Turn storage (migration + read model) | D4 | Number must be union-computed against `origin/main` at the moment of writing |
| 5 | tm8 MCP server, ~8-12 curated tools | D2, D3 | Non-catalog transport. **Never one tool per catalog op** — a catalog row costs ~20 files and ~32 pins, and 130 tool defs would eat the context window |
| 6 | Browser stream frames over `/v2/ws` | 4 | Socket + auth already exist |
| 7 | UI: turn-item renderers (thinking / tool / usage cards) | 4, 6 | The genuinely new UI. No precedent in tm8-ui |
| 8 | UI: the destination — centre composer + entity/graph rail | 7 | Reuses `ChannelScreen` discipline + existing graph screen |
| 9 | Orchestration affordances (spawn/dispatch from chat, task status) | 5, D7 | Mostly wiring existing ops |

---

## 7. Hazards to budget now

- **Branch currency.** This brief was researched on `agent/session-message-replies`, which is
  an *ancestor* of `origin/main` and **15 catalog operations behind it** (127 vs 142 — main
  has since landed credentials, files, `execution.dispatch`, `entities.commands.gate`).
  Any implementation branches from `origin/main`, and every count is re-measured there.
- **Catalog pin blast radius.** One new catalog op breaks ~32 tests via count pins, digest
  and the generated conformance manifest. This is the strongest argument for L3 being a
  transport rather than a set of new operations.
- **Per-member credential injection** replaces `CLAUDE_CONFIG_DIR` rather than layering it,
  which would make MCP servers vanish from spawned sessions. Whoever builds L3 owns writing
  into that per-member dir.
- **Vendor protocol drift.** `codex app-server` is flagged *experimental* and its method set
  is large and moving. Regenerate the schemas in CI and diff them; do not hand-transcribe.
- **Cost and rate limits are now visible.** `result.total_cost_usd` and `rate_limit_event`
  arrive per turn on the claude side, `account/rateLimits/read` on the codex side. Decide
  early whether the graph records them, because retrofitting billing data is painful.

---

## 8. What I have NOT verified

- Whether `claude`'s control channel exposes `canUseTool` **over the CLI stdio pipe** as
  opposed to only through the SDK wrapper. The strings are in the bundle; I did not drive it.
  Phase 1 settles this, and D3/D5 make it non-blocking for v1.
- Whether `codex app-server`'s protocol is stable enough to depend on. Unknowable from here;
  Phase 1's spike is the measurement.
- Any performance or concurrency characteristics — how many live threads one node sustains.
- Nothing in this document has been built or run against a tm8 node.
