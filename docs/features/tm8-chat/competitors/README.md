# Competitive analysis — agentic chat / coding-agent products

Root doc for the TM8 Chat competitor study. Task `019fecfa-8b95-7c08-a5a0-6143aaec044b`.
Researched **2026-08-12** by reading source, not documentation.

| Competitor | What it is | Detail |
|---|---|---|
| **t3code** | Multi-vendor agent IDE. Rents 5 vendor loops behind one narrow port | [`t3code/`](./t3code/README.md) |
| **Buzz** (Block) | Slack-like chat where agents are members. Nostr + git + ACP | [`buzz/`](./buzz/README.md) |
| **OpenCode** | Open-source coding agent that **owns its loop** | [`opencode/`](./opencode/README.md) |

Sibling docs: [`../PRIOR-ART.md`](../PRIOR-ART.md) (what this means for tm8, plus CLI facts
measured on this machine) and [`../BRIEF.md`](../BRIEF.md) (the original design brief).

---

## 1. The one axis that separates them

An agent is a loop: *send conversation → model asks for a tool → run it → send result → repeat.*
Whoever writes that loop owns the agent. Every product here sits on one side of that line.

| | t3code | Buzz | OpenCode | tm8 today |
|---|---|---|---|---|
| **Owns the loop** | ❌ rents | ❌ rents (+1 own) | ✅ **own** | ❌ rents |
| How it drives the agent | 5 bespoke adapters | ACP over stdio | its own `while` loop | **PTY byte-scraping** |
| Multi-model | 5 vendors | any ACP agent | ~40 via models.dev | 1 |
| Subscription auth | ✅ spawn CLI | ✅ spawn CLI | ⚠️ **token extraction — closed** | ✅ spawn CLI |
| Structured turn stream | ✅ normalized union | ⚠️ ephemeral only | ✅ typed parts | ❌ none |
| **Durable** structured turns | ✅ | ❌ deliberately not | ✅ **best model** | ❌ flat markdown |
| Agent replies via tool call | ❌ stdout-derived | ✅ MCP tool | ❌ loop-internal | ✅ `tm8 message send` |
| In-chat approvals | ✅ composer footer | ❌ auto-approves all | ✅ per-session ruleset | ❌ n/a |
| Cost/usage durable | ⚠️ tokens only | ✅ separate event (unrendered) | ✅ session counters | ❌ none |
| Subagents / delegation | ❌ none | ⚠️ no agent-spawn action | ✅ child sessions | ✅ spawn + dispatch |
| **Knowledge graph** | ❌ | ❌ | ❌ | ✅ |

## 2. Five conclusions

**2.1 The runtime is a solved problem.** Three mature implementations, all structured, none using
a PTY. tm8's terminal-scraping is the outlier and the thing to replace.

**2.2 Subscription auth works by *delegation*, and only by delegation.** t3code and Buzz both
spawn the vendor's own CLI and let it use its own stored OAuth. OpenCode tried the other way —
extracting the token and calling the API from its own client — and **Anthropic closed that path in
January 2026 with a legal takedown plus server-side token rejection**. See
[`opencode/providers-and-auth.md`](./opencode/providers-and-auth.md). This is the single most
consequential finding in the study.

**2.3 "Many models" ≠ "many subscriptions."** One integration plus a gateway gets you many models
(API-billed). Many *subscriptions* costs one adapter per vendor binary, always. There is no
product here that escaped that, because it is a commercial boundary, not a technical one.

**2.4 The flat-vs-structured message fork has a demonstrated wrong answer.** Buzz chose flat
messages with an ephemeral side-channel for thinking/tool-calls, explicitly marked "relays MUST
NOT persist". The result is two rendering systems that never converge and turns you cannot
re-open. OpenCode's `Session → Message → Part` model is the one to copy.

**2.5 Nobody has the graph.** None of the three has a knowledge graph, and only OpenCode has real
delegation. tm8 already has both, plus threads and spawn-on-thread. **The chat box is the
commodity; the graph underneath is the product.**

## 3. What tm8 should take from each

| From | Take |
|---|---|
| t3code | The **~12-method port** + one normalized event stream; the unified 3-kind approval vocabulary; **Codex's auth-only symlink overlay** for config isolation |
| Buzz | **Agent replies by calling a tool, not by emitting text** (tm8 already does this); cost as a separate typed per-turn record; thread counts computed at ingest |
| OpenCode | The **typed Part storage model**; the hand-rolled loop shape over a streaming SDK; the credential/transport **seam** (pointed at API keys) |

## 4. What to reject

| Reject | Why |
|---|---|
| Buzz's ephemeral agent transcript | Durable re-openable turns are the product, not a debug stream |
| Buzz's auto-approve-everything | Fine for an autonomous relay agent, wrong for human-in-the-loop |
| ACP as the *first* integration | Claude doesn't speak it; it drops reasoning, usage, cost, rate limits |
| Any subscription-OAuth extraction | Closed by Anthropic — legally and technically |
| OpenCode's framework lock-in | Two coexisting generations mid-migration; `effect@4.0.0-beta` |

## 5. Method and caveats

- **t3code** — full local source read at `~/Desktop/Projects/t3code`.
- **Buzz** — shallow clone of Block's repo, read directly. ⚠️ `VISION_*.md` files there are
  **aspirational**; several describe behaviour the code does not implement. Press coverage is also
  stale — it credits Goose/Codex/Claude Code harnesses, but only goose speaks ACP natively.
- **OpenCode** — shallow clone of `sst/opencode` (HEAD merges from `anomalyco/opencode`, MIT).
- Not verified anywhere: performance/concurrency under load, and whether Buzz's remote-agent k8s
  path works end to end (it is vision-led scaffolding).
