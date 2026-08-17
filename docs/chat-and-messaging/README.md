# Chat and messaging

Messages are how work becomes visible. This section covers the mechanics (how a
message is stored, routed and delivered) and the surface (how it is read and
written).

> **"Chat" names two unrelated systems.** *Session Chat* is a chat-styled view
> over a `work_session` and its PTY — it is on the message protocol. *Chat Home
> threads* (`chat_threads`/`chat_turns`) are a separate headless runtime with no
> session and no PTY — they are not. Conflating them wastes hours; see
> [`CHAT-THREADS-VS-SESSIONS-GAP-ANALYSIS.md`](CHAT-THREADS-VS-SESSIONS-GAP-ANALYSIS.md).

## Mechanics

| Document | What it is |
|---|---|
| [`CHAT-SYSTEM-DESIGN.md`](CHAT-SYSTEM-DESIGN.md) | **Start here.** The end-to-end system design |
| [`SESSION-COMMUNICATION-MODEL.md`](SESSION-COMMUNICATION-MODEL.md) | How sessions address each other, and what an anchor is |
| [`BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md`](BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md) | The backend as it actually stands, written for whoever builds chat and agent templates on it |
| [`MESSAGE-LOOPBACK-ANALYSIS.md`](MESSAGE-LOOPBACK-ANALYSIS.md) | Analysis of the loopback path |
| [`CHAT-THREADS-VS-SESSIONS-GAP-ANALYSIS.md`](CHAT-THREADS-VS-SESSIONS-GAP-ANALYSIS.md) | Why Chat Home threads and work sessions **cannot** message each other, and what it would take. Decisions open |

## Surface

| Document | What it is |
|---|---|
| [`CHAT-UI-AND-LAYOUT-DESIGN.md`](CHAT-UI-AND-LAYOUT-DESIGN.md) | The chat UI and its place in the workspace layout |
| [`NEW-CHAT-UI-IMPLEMENTATION-PLAN.md`](NEW-CHAT-UI-IMPLEMENTATION-PLAN.md) | The production implementation plan for the new chat UI |
| [`CHAT-SURFACE-CHANGESET.md`](CHAT-SURFACE-CHANGESET.md) | The complete changeset that landed the surface |
| [`CHAT-SURFACE-CONTEXT-AND-HANDOFF.md`](CHAT-SURFACE-CONTEXT-AND-HANDOFF.md) | How it works, what was broken, what is still missing |
| [`NEW-CHAT-UI-UNRELATED-FAILURE-LEDGER.md`](NEW-CHAT-UI-UNRELATED-FAILURE-LEDGER.md) | Tree failures found during that work that were **not** caused by it |

## Operating note

Delivery to a *running* agent is slow, not lost — roughly a minute to reach a busy
session. Judge delivery by the `session_message_deliveries` rows, never by whether
the agent has visibly reacted. See
[`../ops/MESSAGE-DELIVERY-LATENCY.md`](../ops/MESSAGE-DELIVERY-LATENCY.md).
