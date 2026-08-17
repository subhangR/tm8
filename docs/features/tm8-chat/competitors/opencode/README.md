# OpenCode

`sst/opencode` — HEAD now merges from **anomalyco/opencode**, the org backing it. **MIT.**
TypeScript on **Bun**, Effect 4 (beta), Hono/Effect-HttpApi server, **Drizzle + SQLite**,
Vercel **AI SDK v6** for single model calls. TUI is SolidJS-in-terminal via **OpenTUI**.

Read from a clone, 2026-08-12.

**One line:** the only major player that **owns its agent loop** — and therefore the best
reference implementation for the half of TM8 Chat we might eventually build ourselves.

## Sub-documents

| Doc | Covers |
|---|---|
| [`agent-loop.md`](./agent-loop.md) | The hand-rolled loop, streaming, compaction, interrupts |
| [`providers-and-auth.md`](./providers-and-auth.md) | models.dev + AI SDK; **the subscription-OAuth finding and the ruling it forces** |
| [`storage-and-sessions.md`](./storage-and-sessions.md) | Session→Message→Part, typed parts — **the model tm8 should copy** |
| [`embedding-and-multiagent.md`](./embedding-and-multiagent.md) | Server/SDK/ACP surfaces, subagents, tools, maturity |

## ⚠️ Structural caveat

The repo carries **two generations side by side**. `packages/opencode` is the shipped binary;
`packages/core`, `packages/llm`, `packages/schema` are a newer Effect/Drizzle rewrite that
`opencode` already imports. Anything you read may be current, superseded, or not-yet-live. Take
patterns, not the codebase.

## The two things that matter most

**1. It proves the loop and the credential are separable.** Auth is plugin-driven: each plugin
returns a **`fetch` shim** that strips the SDK's key, injects an OAuth bearer, and rewrites the URL
to the vendor's subscription backend. The loop never touches credentials. *Architecturally*, owning
the loop does **not** force API keys.

**2. But that path is closed for Anthropic — legally and technically.** The shipped tree has **no
Anthropic auth plugin**. The official `opencode-anthropic-auth` package was **removed after a legal
request from Anthropic**, and in **January 2026 Anthropic added server-side enforcement rejecting
consumer-subscription OAuth tokens used outside Claude Code / claude.ai**.

> **RULING for tm8:** subscription = **spawn the vendor's own binary**. Own-loop = **API keys /
> Bedrock / Vertex / gateway**. Never build token extraction. See
> [`providers-and-auth.md`](./providers-and-auth.md).

## Scorecard

| | |
|---|---|
| Owns the agent loop | ✅ **yes** — hand-written, ~1–2k lines of real loop code |
| Multi-model | ✅ ~40 providers via models.dev + `@ai-sdk/*` |
| Subscription auth | ⚠️ works for ChatGPT/Copilot; **Anthropic closed** |
| Structured turns | ✅ **typed Part union, durable in SQLite** |
| Fork / resume / revert | ✅ all three |
| Subagents | ✅ child sessions, foreground or background, resumable |
| Approvals | ✅ per-session permission ruleset, derived for subagents |
| Embeddable | ✅ as a **server** (HTTP+SDK, or ACP) — ❌ not as a library |
| Knowledge graph | ❌ |
