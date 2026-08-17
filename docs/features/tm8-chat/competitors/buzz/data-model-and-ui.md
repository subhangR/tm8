# Buzz — data model and chat UI

**This document contains the single most instructive result of the whole competitor study**: Buzz
resolved the flat-vs-structured message fork *toward flat*, and visibly paid for it.

## The headline: three separate planes

| Plane | Kind | Durable? | Where it renders |
|---|---|---|---|
| **Visible answer** | 9 (and 40002) | ✅ durable | main timeline, as plain markdown |
| **Cost / usage** | **44200** | ✅ durable, encrypted, append-only | **nowhere — no UI renders it** |
| **Thinking / tool calls / diffs** | **24200** | ❌ **ephemeral, "MUST NOT persist"** | side panels only |

## The message shape — flat string

Wire: `content TEXT NOT NULL` (`migrations/0001_initial_schema.sql:197`).
Client (`desktop/src/features/messages/types.ts:14-52`):

```ts
export type TimelineMessage = {
  id: string; createdAt: number; pubkey?: string;
  isAgent?: boolean;        // ← agent-ness is a BOOLEAN FLAG, not a content type
  body: string;             // ← the ENTIRE message content, flat markdown
  parentId?: string|null; rootId?: string|null; depth: number;
  kind?: number;            // ← structured rendering keys off THIS, not off agent-ness
  tags?: string[][]; reactions?: TimelineReaction[];
};
```

An agent turn is **(a) plain messages + (c) a separate metric event** — *not* progressive edit,
*not* typed parts. `MessageRow.renderBody()` switches on `message.kind` (`MessageRow.tsx:365-464`);
the **only** kind-keyed structured body is the **40008 diff card** (`DiffMessage`→`DiffViewer`), and
it isn't agent-specific. Everything conversational falls through to `<Markdown>` (react-markdown +
remark-gfm/breaks).

## The typed transcript exists — but it's ephemeral

There **is** a real discriminated union
(`desktop/src/features/agents/ui/agentSessionTypes.ts:71-141`):

```
message | thought | plan | lifecycle | tool
  with renderClass, status, args, result, isError, outcome
```

But it is decoded from **kind:24200 observer frames** — NIP-44 encrypted, `payload.kind ∈
{acp_read, acp_write, turn_started, session_resolved}`, i.e. the **raw ACP frames** between harness
and model. NIP-AO is explicit:

> *"Relays MUST NOT persist kind 24200… Clients SHOULD subscribe with `since=now`; historical
> replay is not supported… bounded in-memory ring buffer."*

**A client joining mid-turn sees only frames from the join point on. The thinking/tool transcript
can never be reconstructed.** The only durable proof a turn happened is the kind:9 text it posted
plus the kind:44200 metric. Token deltas are ephemeral and never compacted — there is nothing to
compact.

## Cost/usage — good design, unused

`AgentTurnMetricPayload` (`crates/buzz-core/src/agent_turn_metric.rs:106-160`):
`{harness, model, turn: TokenCounts, cumulative: TokenCounts, stopReason, pricingIdentity, …}` —
NIP-44 encrypted agent→owner, **one event per turn, append-only, owner-read-only**.

Clean model — with **`None` meaning "unreported", never 0**, and a provable `pricingIdentity`. But
the desktop app consumes it only to seed a local archive (`useAgentMetricArchiveSeed.ts`) and
**renders no cost UI at all**.

## The chat UI

**Stack:** Tauri desktop, React 18, TanStack Router+Query, TipTap composer, Radix UI, **`virtua`
VList** virtualization. `MessageTimeline` → `TimelineMessageList` (VList) → `MessageRow`.

**Blunt ruling: in the channel timeline, agent output has essentially no structured rendering.**
It's markdown plus the 40008 diff card. **Absent from the timeline:** thinking blocks, tool-call
cards, tool results, interactive approve/deny, per-turn errors, and any cost/token UI whatsoever.
Agent messages differ only by cosmetic chips (`MessageAgentOwner`, persona name, respond-to badge).

**The rich rendering lives in separate observer panels** — an `ACTIVITY_RENDER_CLASS_PRESENTERS`
table over the typed union → `ThoughtActivity` (collapsible), `ToolActivity`/`ToolItem`
(params/result/shell/file-read/**FileEditDiffBlock**), `PlanActivity`, `LifecycleActivity`
(permission + error cards, **display-only, no buttons**). A long turn shows as animating segments
plus a `TurnLivenessIndicator` — **not** as a collapsing block in the main feed.

## Streaming

Transport is the **Nostr relay WebSocket** — no SSE anywhere. Two streams: durable kind:9 events
reconciled into the TanStack cache, and ephemeral kind:24200 observer frames. **Edits are separate
kind:40003 events overlaid onto the row** (`applyEditTagOverlay`), *not* in-place progressive
editing of streaming tokens.

## Threads — independent convergence with tm8 `#153`

A thread is a **projection, not an entity**: replies are ordinary kind:9 events with a NIP-10
`["e", root, "", "reply"]` tag, and the relay atomically maintains a `thread_metadata` row
(parent/root/depth/**reply_count**/**descendant_count**/last_reply_at) **at ingest**
(`migrations/0001_initial_schema.sql:512-537`). The relay also synthesizes non-stored overlay kinds
**39005** (thread summary) and **39006** (window bounds) at query time.

UI = **roots feed with inline "N replies" summary rows + a dedicated side `MessageThreadPanel`**
that reuses `MessageRow`.

**That is almost exactly what tm8 shipped in `#153`.** Validation, not a new idea.

## Verdict for tm8

**Steal:**
1. **Cost as a separate typed, append-only per-turn record** keyed `(session_id, turn_seq)`, with
   `None ≠ 0` discipline and a provable pricing identity. Retrofitting billing data is painful.
2. **Thread counts computed at ingest** with a synthesized summary overlay — cheap "N replies"
   badges, roots feed never counts rows.
3. **Diff as its own message kind with a dedicated card, keyed on kind not author** — a clean way to
   get structured agent output into the timeline without a full block model.

**Reject:**
1. **Ephemeral rich transcript.** Great for privacy and debugging; fatal for a product whose value
   is durable, re-openable agent turns.
2. **Agent-ness as a boolean on a flat string.** It forced two disjoint rendering systems that never
   converge. If tool calls and approvals belong **inline in the timeline**, you need typed content
   parts — the thing Buzz declined to build.
