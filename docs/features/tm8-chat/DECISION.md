# TM8 Chat — final design decisions, scored

Task `019fecfa-8b95-7c08-a5a0-6143aaec044b`. **2026-08-12.**
Inputs: [`competitors/`](./competitors/README.md) (t3code, Buzz, OpenCode — source-read),
[`SPIKE-HEADLESS-AGENT.md`](./SPIKE-HEADLESS-AGENT.md) (measured runs on this machine),
[`PRIOR-ART.md`](./PRIOR-ART.md).

---

## 1. The six candidate approaches

| # | Approach | One line |
|---|---|---|
| **A** | **PTY scraping** *(status quo)* | Run `claude` in a pseudo-terminal, read the screen |
| **B** | **Headless spawned CLI** | `claude -p --input-format stream-json`, plain pipes, typed JSON — **spiked and proven** |
| **C** | **Claude Agent SDK** | Typed client over the *same binary*, plus the control channel |
| **D** | **ACP client** | One protocol, many agents — via third-party wrapper binaries |
| **E** | **Own the loop** | Hand-rolled loop over the AI SDK, OpenCode-style |
| **F** | **Embed OpenCode** | Run `opencode serve`, drive it over its SDK/ACP |

## 2. Criteria and weights

Weights reflect *this* product's constraints — subscription billing was stated as a hard
requirement, and legal durability is weighted heavily because one competitor already got shut down.

| # | Criterion | Weight | Why |
|---|---|---|---|
| 1 | **Subscription auth preserved** | **20** | Stated hard requirement |
| 2 | **Legal / ToS durability** | **15** | Anthropic already closed one path |
| 3 | **Structured turn fidelity** | **15** | thinking / tools / usage / cost — the UI's raw material |
| 4 | **Time to v1** | **15** | Nothing is built yet |
| 5 | **Control ("baked in")** | 10 | Prompt + toolset owned by tm8 |
| 6 | **Multi-model reach** | 10 | Stated goal, but secondary to #1 |
| 7 | **Approvals / human-in-loop** | 5 | Not needed in v1 (graph-only tools) |
| 8 | **Maintenance / drift risk** | 5 | |
| 9 | **Fit with tm8 graph + orchestration** | 5 | |

## 3. Scores (raw 1–5)

| Criterion | A PTY | B Headless | C SDK | D ACP | E Own loop | F Embed |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| 1 Subscription auth | 5 | 5 | 5 | 4 | **1** | 2 |
| 2 Legal durability | 5 | 5 | 5 | 5 | 5 | 2 |
| 3 Turn fidelity | **1** | 4 | **5** | 2 | 5 | 5 |
| 4 Time to v1 | 2 | **5** | 4 | 2 | **1** | 3 |
| 5 Control | 3 | 5 | 5 | 4 | 5 | 2 |
| 6 Multi-model | 2 | 3 | 3 | **5** | **5** | 5 |
| 7 Approvals | 2 | **1** | 5 | 4 | 5 | 4 |
| 8 Maintenance | 1 | 4 | 4 | 2 | 2 | 2 |
| 9 Graph fit | 3 | 5 | 5 | 4 | 5 | 2 |

### Weighted totals (out of 100)

| Rank | Approach | Score |
|:--:|---|:--:|
| 🥇 | **C — Claude Agent SDK** | **92** |
| 🥈 | **B — Headless spawned CLI** | **88** |
| 🥉 | D — ACP client | 71 |
| 4 | E — Own the loop | 69 |
| 5= | A — PTY scraping | 60 |
| 5= | F — Embed OpenCode | 60 |

### The important nuance

**B and C are not rival architectures.** Both spawn the *same binary*; C is B plus a typed wrapper
and the control channel. The 4-point gap is entirely approvals + typings. So the real winner is
**"spawn Claude Code headless"**, and SDK-vs-raw is an implementation detail you can flip later
without touching the port.

**Why the losers lost:**
- **A (60)** — cannot produce structured turns at all. Scores well only on auth, which every
  approach shares.
- **D (71)** — Claude doesn't speak ACP; it drops reasoning/usage/cost/rate-limits; needs
  third-party wrapper binaries; the spec is unstable and two products already pin different
  versions.
- **E (69)** — architecturally excellent, but **kills the hard requirement**: Anthropic closed
  subscription-OAuth for non-vendor clients in Jan 2026. Great Stage 2, impossible Stage 1.
- **F (60)** — inherits someone else's session model and loop, giving two sources of truth for
  "what is a session", and imports their subscription-auth legal exposure.

---

## 4. THE DECISION

> **Stage 1: spawn Claude Code headless (B), upgrade to the Agent SDK (C) when approvals are
> needed. Put both behind a ~12-method port so Stage 2 (E, own-loop for API-key models) is a new
> implementation, not a rewrite.**

Proven end to end already — see the spike. The agent read the graph, reasoned, and replied by
calling `tm8_message_send`, with our prompt and only our tools, for **$0.0073 / 3 turns**.

---

## 5. Design rulings

Supersedes `BRIEF.md` §5 (D1–D7).

> **RULED BY SUBHANG 2026-08-13** (on the task anchor, in-session). All twelve accepted, four
> amended:
> - **D1 amended — the chat IS the home screen**, not merely a new destination. "This becomes
>   the home screen completely."
> - **D2 amended — a dedicated chat teammate is created, AND the chat lets you select the
>   teammate / model / provider** per thread.
> - **D6 amended — fork-on-vendor-switch is v2.** V1 pins one vendor+model per thread; the
>   fork affordance ships later.
> - **D9 amended — hierarchical tools**: top-level tools return the context/schemas of
>   next-level tools (progressive disclosure), rather than a flat list of 8–12.
> - D3, D4, D5, D7, D8, D10, D11, D12: accepted as written.
> Implementation plan: [`IMPLEMENTATION-PLAN.md`](./IMPLEMENTATION-PLAN.md).

| # | Decision | Ruling | Basis |
|---|---|---|---|
| **D1** | Front door or 5th surface? | **New top-level destination.** `ContentSurface` `'chat'` is a per-session *panel tab* — a different axis. | seam recheck |
| **D2** | Who does the agent act as? | **A teammate identity, with tools executing under the requesting human's authorization.** Needs a 4th `authKind`. | Buzz agents-as-members |
| **D3** | Filesystem? | **No. Graph tools only in v1.** | spike — deletes the approval problem |
| **D4** | Turn durability | **Message stays the durable unit + a sibling typed `part` table** (`text/reasoning/tool_call/tool_result/patch/usage/error`), ordered, with real tool state. | OpenCode's Part model; Buzz's ephemeral failure |
| **D5** | Approvals in v1? | **No** — D3 makes the tool set closed and pre-authorizable. Raw stdio can't do them anyway. | spike |
| **D6** | Model switching in a thread | **Per-thread.** Vendor switch **forks**. Gateway swap (`ANTHROPIC_BASE_URL`) is same-code-path. | measured |
| **D7** | Can chat spawn/dispatch? | **Yes** — `execution.dispatch` is live from the browser today. | seam recheck |
| **D8** | Session lifecycle | **Stage 1: hot process only** (stdin open). Resume deferred. Pre-mint `--session-id` → `native_session_id`. | spike |
| **D9** | Tool transport | **stdio MCP**, `--mcp-config` + `--strict-mcp-config` + **`--tools ""`** + `--allowed-tools`. ~8–12 curated tools, **never one per catalog op**. | spike (6× cheaper) |
| **D10** | Cost/usage | **Record per turn from day one** (`None ≠ 0`, store pricing identity). | Buzz kind:44200 |
| **D11** | Subscription auth | **Spawn the vendor binary only. Never extract tokens.** Isolate **auth file only**, symlink the rest. | OpenCode takedown; Codex shadow-home |
| **D12** | ACP | **Not in v1.** Revisit as breadth once the port exists. | measured + t3code |

## 6. Traps to encode now

1. **`--tools ""` and `--allowed-tools` are different flags — you need both.** One alone = denied
   tools; the other alone = 30 tools of bloat. Measured **6× cost difference**.
2. **Never `--bare`** — it forces API-key auth and silently kills subscription.
3. **Never override `HOME`** to sandbox a CLI — breaks the macOS keychain, and the symptom
   ("Not logged in") looks like a credential bug.
4. **Transcripts are keyed by CWD slug** — pin cwd per thread or resume won't find the session.
5. **Adopt Codex's auth-only symlink overlay** — fixes our existing
   `feat/spawn-credential-injection` MCP-wipe bug. **Worth landing independently of this project.**
6. **One catalog op costs ~20 files / ~32 test pins** — MCP must be a transport, not new ops.

## 7. Open, and not ours to answer

**Whether hosting this for multiple users is permitted.** Every product here makes subscriptions
work by spawning the vendor's logged-in binary — clean for a local or single-user node. If TM8 Chat
becomes a hosted multi-user service, that is a **commercial question**, and it should be settled
before the architecture depends on it.

## 8. Still unmeasured

- Concurrency: how many hot processes one node sustains, and memory each.
- Interrupt mid-turn in headless mode.
- The real tm8 MCP server (the spike used a 2-tool fake) and its authorization model.
- Whether `codex`'s `app-server` fits the same port cleanly.
- ~~**`#153` threads delta**~~ — **RESOLVED 2026-08-13, see §9.**

---

## 9. Addendum 2026-08-13 — the `#153` threads question, answered from the merged tree

**Question:** can TM8 Chat be *a thread whose participant is an agent runtime*, reusing
threads/anchoring/notifications instead of new storage?

**Answer: YES for the conversation container — with one deliberate divergence from `#153`'s
spawn-on-thread model.** Verified on `origin/main` (PR `#153` MERGED 2026-08-10):

- **Threads are real and Slack-shaped in the DB**: `root_message_id`, reply-anchor = parent-anchor
  (DB-enforced), roots-only scope `channel_threads_v1` (contract + `feed-context.ts`), a
  three-column thread pane already in `ChannelScreen.tsx`, reply counts / `lastReplyAt` /
  `replyParticipants` on the grouped read.
- **Migrations 098 + 099 landed** derivation feed scopes and thread-spawn (`derive_task_for_entity`
  with `p_force_new`); `execution-handlers.ts:406` already targets thread roots.

**What this buys D4:** the "turn store" migration shrinks to **only the sibling `parts` table**.
A chat thread = a message thread. Roots list = the chat's thread list. Anchoring a thread root to
any entity = "chat about X" with graph context for free. Mentions, unseen marks, notifications,
attachments — all inherited, zero new storage for the conversation itself.

**The divergence:** `#153`'s spawn-on-thread mints a *derived task* and a PTY worker, and the
worker's messages reach the thread via the `derived_from` read. TM8 Chat's runtime is a **direct
participant**: the hot headless process posts its reply as a normal threaded `messages.post` under
the teammate identity — no derived task, no `derived_from` hop (whose `src` is DB-constrained to
`task` by 064 anyway, so the chat runtime *couldn't* use it without schema relaxation). Both
models coexist: chat-agent-as-participant for the conversation; spawn-on-thread stays exactly
what the chat agent *calls* when it delegates real work (D7).

**Work-breakdown consequence** (BRIEF §6): phase 4 shrinks (parts table only), phase 8 shrinks
(reuse thread pane + roots list rather than a new thread-list UI). Streaming deltas, the parts
renderers, the runtime binding (thread root ↔ hot process), MCP server and the 4th `authKind`
remain the real work.
