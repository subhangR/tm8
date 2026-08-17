# OpenCode — the agent loop

The reference implementation for "own the loop". If tm8 ever writes its own agent, this is the
shape to copy.

## It is a hand-written `while` loop

`packages/opencode/src/session/prompt.ts:1088` — `runLoop`. **Not** the AI SDK's agent loop: no
`stopWhen`, no `stepCountIs`. The step cap is their own `maxSteps = agent.steps ?? Infinity`
(`:1178`).

Per step:

```
load messages
  → detect unfinished tool calls
  → call the model (one streaming turn)
  → execute tools
  → persist to SQLite
  → loop
```

**Exit condition** (`:1106-1130`): the last assistant message finished with a **non-`tool-calls`**
reason **and** there are no pending tool parts. That second clause is the important one — it's what
makes the loop crash-safe, because "unfinished tool calls" is a *persisted* state it can rediscover
on restart rather than a variable held in memory.

## The AI SDK is only a single-call adapter

One model turn uses `streamText(...)` and consumes `result.fullStream`
(`packages/opencode/src/session/llm.ts:9,280,373`). A processor normalizes fullStream parts into
their **own** event/part model (`session/llm/ai-sdk.ts`, `session/processor.ts`).

> So the AI SDK does exactly two jobs: **stream a turn** and **parse tool calls**. Everything above
> — orchestration, persistence, compaction, subagents — is theirs. That's the right seam, and it's
> why the loop is only ~1–2k lines rather than 29k.

## Streaming, interrupts, compaction, subagents

| Concern | How |
|---|---|
| **Streaming** | `fullStream` async-iterable, normalized into typed parts, streamed as deltas over the event bus |
| **Interrupt** | `AbortController` per step + Effect interruption; **orphaned tool-calls are explicitly cleaned up** (`prompt.ts:323,815,1203`) |
| **Compaction** | Inline in the loop — overflow check → auto-compaction task → **re-enters the loop** (`:1149-1168`, `session/compaction.ts`) |
| **Subagents** | A `handleSubtask` branch inside the same loop (`:1144`) |
| **Durability** | Every step writes to SQLite — the loop is resumable, not in-memory |

## Why this shape is right

Three properties worth calling out, because they're the difference between a demo loop and a
production one:

1. **State lives in the store, not the closure.** "Are there unfinished tool calls?" is answered by
   querying persisted parts. A crashed process can be resumed by another one.
2. **Compaction re-enters the loop** rather than being a pre-processing step. Context overflow is
   just another thing that happens mid-turn.
3. **Orphaned tool-call cleanup on interrupt** — the failure mode nobody thinks about until a user
   hits Stop while three tools are in flight and the next turn starts with a malformed message
   history.

## What it costs you

Owning this means owning, forever: context-window accounting, compaction strategy, retry/backoff,
tool-call parsing across providers with different function-calling dialects, streaming
reconciliation, and interrupt-safety. OpenCode does it well — but it is a full-time surface.

**By comparison**, spawning `claude` gets all of the above for free, already tuned for the model,
and is what tm8 can ship in Stage 1.

## Verdict for tm8

**Copy the pattern, don't embed the engine** (see
[`embedding-and-multiagent.md`](./embedding-and-multiagent.md)). If and when tm8 builds an own-loop
runtime for API-key/gateway models, this is the blueprint:

- hand-rolled `while` over AI SDK `streamText().fullStream`
- persist every step; derive loop state from the store
- inline compaction that re-enters the loop
- AbortController interrupts **with orphan cleanup**
- subagents as a branch in the same loop, backed by child sessions

And it slots in behind the **same ~12-method port** as the spawned-CLI runtime — which is precisely
why the port is worth defining first.
