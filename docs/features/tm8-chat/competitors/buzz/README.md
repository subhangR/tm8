# Buzz (Block)

Open-source team chat where AI agents are first-class members, with git hosting, built on Nostr.
Launched **2026-07-21** by Block (Jack Dorsey). **Apache-2.0.** ~22k GitHub stars in two weeks.
Rust workspace (28 crates) + Tauri/React desktop + web client + Postgres relay.

Read from a clone of the real repo, 2026-08-12.

**One line:** the closest shipped analogue to what TM8 Chat wants to be — and the clearest
demonstration of which design choices to *avoid*.

## Sub-documents

| Doc | Covers |
|---|---|
| [`architecture-and-nostr.md`](./architecture-and-nostr.md) | Crate layout, how deep Nostr really goes, event kinds, storage and query |
| [`agent-runtime-acp.md`](./agent-runtime-acp.md) | The two runtimes, ACP harnesses, auth by delegation, the message→agent→message loop |
| [`data-model-and-ui.md`](./data-model-and-ui.md) | Flat messages, the ephemeral transcript, threads, how agent turns render |
| [`workflows-and-git.md`](./workflows-and-git.md) | YAML workflows, git-on-Nostr, PR review, maturity audit |

## ⚠️ Two warnings before reading anything about Buzz

1. **`VISION_*.md` files are aspirational.** There are nine of them and several describe behaviour
   the code does not implement. Never cite one as an implemented fact.
2. **The press coverage is stale.** It credits harnesses for "Goose, Codex and Claude Code". In the
   tree only **goose** speaks ACP natively; codex and claude are reached through **third-party npm
   wrapper binaries**. The shipped harness logos are `amp, devin, grok, hermes, kimi, omp,
   openclaw, opencode`.

## The one big idea worth stealing

**The agent replies by calling a tool, not by emitting text.** Buzz appends hints to the prompt
telling the agent to reply via `buzz messages send --reply-to <event_id>`, with `buzz-cli` wired in
as an **MCP server**. Streaming chunks are merely *logged to tracing*. Stdout is never the output
channel.

**tm8 already does this** (`tm8 message send --to <anchor>`), over a shelled CLI rather than MCP.
So tm8 is not missing the output path — it is missing the structured **read** stream.

## The one big idea worth rejecting

**Buzz made the rich agent transcript ephemeral.** Thinking, tool calls and diffs travel as
owner-encrypted observer frames (kind 24200) that *"relays MUST NOT persist"*, rendered only in
side panels. The durable chat message stays a flat string with an `isAgent` boolean.

The result is **two rendering systems that never converge**, and agent turns you cannot re-open
after the fact. For tm8, durable re-openable turns are the product.

## Scorecard

| | |
|---|---|
| Owns the agent loop | ❌ rents via ACP (plus one own agent, API-key-based) |
| Subscription auth | ✅ delegated to the adapter's own login |
| Structured turns | ⚠️ typed, but **ephemeral and side-panel only** |
| In-chat approvals | ❌ **auto-approves everything** |
| Cost/usage durable | ✅ separate per-turn event — but **no UI renders it** |
| Threads | ✅ projection + roots feed + side panel (≈ tm8 `#153`) |
| Orchestration | ⚠️ agents are members, but no workflow action can spawn one |
| Knowledge graph | ❌ |
| Git | ✅ **the most mature subsystem in the repo** |
