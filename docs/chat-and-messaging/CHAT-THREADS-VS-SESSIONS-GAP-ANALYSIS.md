# Chat threads vs work sessions — gap analysis

**Status:** investigation complete, no code written. Decisions open (§7).
**Investigated:** 2026-08-16, against the running `:7778` node.
**Question asked:** *make the Chat UI and Sessions able to message each other over the same tm8 message protocol.*

---

## 1. Summary

"Chat" in tm8 names **two unrelated systems**. Only one of them is on the message
protocol. Every gap below follows from that.

| | **Session Chat** | **Chat Home threads** |
|---|---|---|
| Surface | `channel-screen/SessionChatSurface.tsx` | `chat-home/ChatHomeScreen.tsx` |
| Backed by | a `work_session` entity + a real PTY | `chat_threads` / `chat_turns` (migration 104) |
| Runtime | `claude-code` in a pseudo-terminal | long-lived `claude` child, stream-json |
| Reaches tm8 via | the `tm8` CLI on `PATH` | MCP tools |
| Input path | `messages.post` → delivery ledger → PTY write | `messages` trigger → `chat_turns` queue |
| On the message protocol? | **yes, works** | **no, both directions blocked** |

Session Chat is a *chat-styled view over a terminal session*. Chat Home threads
are a genuinely separate runtime with no session, no PTY, and no presence in any
session listing.

The headline correction to the obvious plan: **the blocker is not primarily the
foreign key.** It is a deliberate policy gate plus an authority model (§6). The
schema change is easy; the ruling is not.

---

## 2. How Session Chat works (the path that works)

```
tm8 message send --to <session>
  → messages.post                      durable `messages` row (stored-first)
  → w2_record_session_message_routes   which sessions wake? (072:121)
  → reserve_session_message_delivery   one claim in the ledger
  → PtyHostService.writePromptToEntry
  → proc.write(framed bytes)           literally types into the terminal
  → submitWithVerify('\r')             presses Enter, verifies via cursor heuristics
```

Two load-bearing properties: it is **stored-first** (the message exists in the
graph before delivery is attempted), and every attempt leaves a durable row in
`session_message_deliveries`, so "did it land?" is always answerable.

What the agent actually receives is not the raw body but a framed
`<trusted_control type="tm8.session-input">` envelope built by
`packages/prompt/src/templates.ts:194` (`incomingMessageInjection`), carrying a
`<reply>` element so the agent knows where to answer.

## 3. How Chat Home threads work

### 3.1 Thread creation

`chat.threads.start` (`packages/server/src/chat/handlers.ts`) mints a
`native_session_id` and a cwd `~/.tm8-dev/chat-threads/<rootMessageId>`, then
calls `start_chat_thread`, which writes a **write-once** `chat_threads` row and
queues the first turn. The binding is keyed by `root_message_id`.

### 3.2 How Claude is actually driven

`packages/execution/src/runtime/ClaudeHeadlessAdapter.ts` spawns:

```
claude --input-format stream-json --output-format stream-json
       --model <model> --session-id <uuid>
       --mcp-config <path> --strict-mcp-config
       --allowed-tools <list> --permission-mode <mode>
       --system-prompt <text> --disable-slash-commands
```

**stdin stays open between turns.** One child per thread for its whole life, so
prompt cache and context survive. A turn is one newline-delimited JSON object
written to stdin; the reply arrives as stream-json events on stdout
(`thinking`, `text`, `tool_call`, `tool_result`, `usage`, `done`).

Each event is persisted by `append_chat_message_part(agentMessageId, seq, kind,
payload)` and published to the browser as a `chat.turn.delta` WebSocket event.
The transcript is stored part-by-part server-side — it is not scraped.

> **Note.** This is a *more* reliable transport than PTY injection. The PTY path
> writes raw bytes, sends `\r`, then verifies against cursor heuristics that the
> composer accepted it. Chat writes a JSON line to a pipe.

### 3.3 Turn injection is a database trigger

Follow-up turns are not queued by application code:

```sql
-- internal.queue_chat_human_reply(), AFTER INSERT ON messages
--   (migration 115, re-issued whole from 104)
if new.root_message_id matches a chat_threads row
   and the author is a human member of that space
then insert into chat_turns(state = 'queued')
```

`messages.post` then fires `onMessagesCommitted`
(`packages/server/src/facade/index.ts:215`) →
`orchestrator.wakeForMessages()` → `claim_next_chat_turn` → drain.

**Turn injection is therefore already message-driven.** Any design that adds a
second path to enqueue turns duplicates this trigger and will drift from it.

---

## 4. Verification performed

**Live ping test.** Three running sessions on `:7778` were sent a message and
asked to reply. **3/3 answered**, median ~30s. Each independently confirmed
arrival via PTY injection with `transport="pty"`,
`status_source="session_message_deliveries"`. Agent↔agent messaging over the
terminal path is healthy.

**Chat thread census.** `entity query --kind work_session` returns 100/100 rows
with `sessionKind='agent'`. `chat_threads` holds exactly **one** row, and it
belongs to a *different* space. There were no chat threads in this space to ping.

So: *are chat sessions added in work sessions and maintained?* — **No.**

**Provenance census.** Across the whole database:

| | count |
|---|---|
| `team_member`-authored messages **with** `authored_from` | 6 (all PTY-authored) |
| `team_member`-authored messages **without** `authored_from` | 2 (exactly the two chat-agent messages) |

Chat is the only producer of provenance-less teammate messages — and that is
precisely the shape the delivery ledger rejects (§5.2).

---

## 5. The gaps

### 5.1 Session → chat is structurally impossible — BLOCKER

```sql
session_message_deliveries.target_work_session_id  uuid NOT NULL
  REFERENCES work_sessions(entity_id)
```

A chat thread has no `work_sessions` row, so a delivery aimed at one cannot be
stored. Compounding this, `w2_record_session_message_routes` only emits routes
for anchors of kind `work_session`; the one real thread's `anchor_id` resolves to
kind **`channel`** (verified). Zero routes → nothing ever wakes the thread.

Net effect: `tm8 message send --to <thread>` stores a message and nothing else
happens, ever.

### 5.2 Chat → session fails *silently* — BLOCKER

`reserve_session_message_delivery` raises `23514` — *"Teammate delivery requires
immutable source-session provenance"* — for a `team_member`-authored message with
no `authored_from` edge. Chat messages are exactly that shape (§4).

Chat has the capability wired and will try: the MCP direct tool
`session_followup` (`packages/mcp/src/direct-tools.ts:459`) posts
`messages.post` with `anchorIds:[sessionId]`. Then:

- `services/w2/execution.ts:718-729` — `reserve()` logs and **rethrows**
- `services/w2/message-dispatch.ts:157` — `} catch { }` — **bare, empty, comment-only**

Result: **200 OK**, message stored and visible in the graph, no delivery row, no
surfaced error, worker never woken.

> This empty catch is **not chat-specific**. It swallows *every* reservation-time
> refusal. Worth fixing on its own merits regardless of what is decided here.

### 5.3 Chat threads cannot be created or addressed outside the browser

`chat.threads.start` is listed under `operationsWithoutCommand` with reason
`browser_chat_composer_only`. No CLI command exists, so no agent and no script
can start or address a thread.

### 5.4 Chat threads are not enumerable

`packages/tm8-ui/src/chat-home/real-port.ts:44` ships the literal string:
*"Conversation history is unavailable on this node because the space-wide
chatThreads read has not landed yet."*

### 5.5 Chat threads have no checkout

The thread cwd `~/.tm8-dev/chat-threads/<id>` is an **empty directory**
(verified). The `repo_*` tools have nothing to read.

### 5.6 Two disjoint command surfaces, no shared prompt

PTY sessions get the `tm8` CLI and the kernel system prompt from
`packages/prompt`. Chat threads get MCP tools and a system prompt built
separately at `packages/server/src/chat/compose.ts:144`. **`packages/prompt`
contains zero chat templates.** Chat agents are never told the message protocol
this work is about.

---

## 6. The crux: a deliberate gate and an authority problem

The trigger in §3.3 carries this comment:

> *The one gate: the author is a human member of the thread's Space. **A
> team_member author finds no row here and the message stays inert context.***

Agents are excluded **on purpose**. And `claim_next_chat_turn` shows why:

```sql
'requesterIdentityId', binding.configured_by_identity_id   -- ALWAYS the configuring human
```

**Every chat turn runs on the configuring human's identity.** `requestedBy*` is
provenance only. If an agent could queue a turn, that turn would execute
`repo_edit`, `git_pr`, `web_fetch` **under a human's authority**.

That is privilege escalation, and it is almost certainly why the gate exists.
This is a product ruling, not a plumbing fix, and it must be answered before any
code is written for §5.1.

---

## 7. Options and recommendation

The work splits cleanly in two. Only one half has an open question.

### W1 · chat → session — safe, no ruling needed

Fixes §5.2. The chat agent acts **as itself**; no escalation risk.

1. Add `'chat'` to the `work_sessions.session_kind` CHECK — it already permits
   `agent | credential | shell`, so this is precedented and one line.
2. Mint the `work_session` row inside `start_chat_thread`, in the **same
   transaction** as the `chat_threads` row. Status goes straight to `running`;
   no PTY, no `node_id`.
3. Write `authored_from` on chat-authored messages, pointing at that row.
4. Replace `message-dispatch.ts:157`'s empty catch with a logged failure and a
   `failed_permanent` delivery row.

Unblocks the chat agent steering real workers via `session_followup`.

### W2 · session → chat — needs a ruling first

Relaxing the trigger to accept `team_member` authors is trivial. Deciding whose
authority the resulting turn runs under is not.

- **Recommended:** run agent-queued turns under the **agent's own identity**,
  never the configuring human's. Note this is real work, not a flag — the chat
  runtime currently mints its token from a human identity (`compose.ts`, R9
  "truthful replay").
- **Alternative:** gate W2 behind a per-thread opt-in from the configuring human.
  Cheaper, but leaves the escalation shape in place and merely consents to it.

### What the `work_session` row does and does not buy

It is **not** the turn-injection mechanism — the trigger already is. It buys:

- **addressability** — routing only emits routes for `work_session` anchors
- **provenance** — an `authored_from` target, fixing §5.2
- **discoverability** — threads appear in session listings at all

### Rejected: generalise the ledger off `work_sessions`

Touches the foreign key, every delivery RPC, and the pair-budget shape. Far more
invasive for the same outcome.

---

## 8. Open decisions

1. **W2 authority.** Agent's own identity (recommended), or per-thread human
   opt-in? Blocks all session→chat work.
2. **Should chat threads get a checkout** (§5.5), or stay repo-less by design?
3. **Is `chat.threads.start` browser-only on purpose** (§5.3), or an unfinished
   edge?
4. **Should chat agents receive the tm8 prompt kernel** (§5.6), or is the
   separate chat system prompt deliberate?

Items 2–4 are independent of 1 and can be answered in any order.

---

## Appendix A — reproducing the evidence

```bash
# session census — expect 100/100 sessionKind='agent'
tm8 entity query --kind work_session --limit 100 --format json

# chat threads — expect 1 row, in another space, anchored to a channel
psql "postgres://tm8@127.0.0.1:5442/tm8_dev" -c \
  "select t.root_message_id, e.kind from chat_threads t join entities e on e.id=t.anchor_id;"

# the provenance census of §4
psql "postgres://tm8@127.0.0.1:5442/tm8_dev" -c \
  "select exists(select 1 from edges e where e.src_id=m.entity_id and e.type='authored_from') as has_edge,
          count(*)
     from messages m join entities a on a.id=m.author_id
    where a.kind='team_member' group by 1;"

# the hard FK behind §5.1
psql "postgres://tm8@127.0.0.1:5442/tm8_dev" -c \
  "select conname, pg_get_constraintdef(oid) from pg_constraint
    where conrelid='session_message_deliveries'::regclass and contype='f';"
```

## Appendix B — reading trap

**Read chat and MCP code from `~/.local/share/tm8-stable`**, which is what the
running `:7778` node actually executes (at `97e18ab7`). The working tree branch
`agent/session-message-replies` does **not** contain the chat commit
`dcd96498`; `packages/mcp` and `packages/server/src/chat` appear not to exist
there. An agent reading the working tree during this investigation concluded
chat threads do not exist at all.

Two instrument warnings, corroborated independently: `tm8 session transcript`
and `tm8 entity context` both **understate** message counts. For delivery ground
truth query `session_message_deliveries` directly.
