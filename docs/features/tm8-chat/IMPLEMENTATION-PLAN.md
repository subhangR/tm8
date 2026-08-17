# TM8 Chat — implementation plan (v1, ruled)

Task `019fecfa-8b95-7c08-a5a0-6143aaec044b`. 2026-08-13.
Inputs: [`DECISION.md`](./DECISION.md) (D1–D12 **ruled by Subhang 2026-08-13**, incl. §9 threads
addendum), [`BRIEF.md`](./BRIEF.md), [`SPIKE-HEADLESS-AGENT.md`](./SPIKE-HEADLESS-AGENT.md).

## 1. What v1 is

The **home screen of tm8 becomes a chat** (D1-amended). One centre composer. Conversations are
**message threads** (#153 machinery — `root_message_id`, `channel_threads_v1`, thread pane), whose
agent participant is a **hot headless Claude Code process** (D8, D11) with **graph tools only**
(D3) served over a **hierarchical stdio MCP server** (D9-amended), executing under the
**requesting human's authorization** with **teammate identity** for provenance (D2). Each thread
pins a teammate + model/provider chosen in the UI (D2-amended); vendor switch/fork is v2
(D6-amended). Rich turns are stored as a **sibling parts table** on ordinary messages (D4), cost
recorded per turn (D10). The chat delegates real work by spawning worker sessions (D7).

## 2. Pinned cross-lane contracts

Changing anything in this section requires the **advisor's sign-off** posted on your lane task,
and a message to the coordinator. Do not drift silently.

**C1 — `TurnItem` union (runtime → orchestrator):**
`thinking | text | tool_call | tool_result | usage | error | done`
(`tool_call` carries id/name/args + state `running|completed|error`; `usage` carries
tokens + `total_cost_usd`, where **absent ≠ 0**). No `approval_request` in v1 (D5).

**C2 — Parts storage (orchestrator → UI):** table `message_parts`
(`message_id` FK, `seq` int, `kind` = C1 kind, `payload` jsonb, timestamps), append-only,
ordered by `seq`. **Migration number is measured against `origin/main` at write time and
re-measured at merge** — never previous+1.

**C3 — Stream frames over the existing authed `/v2/ws`:**
`chat.turn.delta {threadRootId, messageId, seq, part}` and
`chat.turn.done {threadRootId, messageId, usage}`. The delta is durable-first: a frame is
emitted only for a part that is (or will deterministically be) persisted.

**C4 — Turn lifecycle:** the browser posts the user turn with **existing `messages.post`**
(threaded reply). The server-side orchestrator reacts, drives the runtime, persists parts,
streams frames, and posts the agent's reply **as the teammate, directly on the thread**
(no derived task, no `derived_from` — see DECISION §9). Budget: **at most ONE new catalog op**
(thread start/config: anchor, teammateId, model). One op costs ~20 files / ~32 count-pin
tests — every pin re-MEASURED, never delta'd.

**C5 — AuthKind:** a 4th `authKind` for the runtime's tool calls (suggest `agent_runtime`).
The credential-ops guard allowlist (`browser|cli`) must **NOT** include it — write the red test.

**C6 — Claude headless recipe (from the spike, measured):**
`claude -p --verbose --input-format stream-json --output-format stream-json`
+ `--mcp-config` + `--strict-mcp-config` + `--tools ""` **AND** `--allowed-tools <ours>` (both,
6× cost difference) + `--setting-sources` empty + pre-minted `--session-id` →
`native_session_id`. **Never `--bare`** (kills subscription auth). **Never override `HOME`**
(breaks keychain). Transcripts key by cwd slug — pin cwd per thread.

## 3. Lanes

| Lane | Branch | Worktree | Scope |
|---|---|---|---|
| **1 Runtime** | `feat/chat-runtime` | `~/Desktop/Projects/tm8-chat-runtime` | `packages/execution`: `AgentRuntime` port (startThread/sendTurn/interrupt/close → C1 stream), `ClaudeHeadlessAdapter` (C6), thread↔process registry, crash/exit handling. **Sibling of `SpawnService`** — do not touch `PtyHostService`. Measure interrupt mid-turn (open spike item). |
| **2 Orchestrator + storage** | `feat/chat-orchestrator` | `~/Desktop/Projects/tm8-chat-orchestrator` | `packages/server` + `db/migrations`: C2 migration, chat orchestrator (C4), C3 frames, per-turn cost recording (D10), the one catalog op. Owns the migration number. |
| **3 MCP tools + authz** | `feat/chat-mcp` | `~/Desktop/Projects/tm8-chat-mcp` | The tm8 stdio MCP server: **hierarchical tools** (D9-amended — top level ~5: e.g. `tm8_overview`, `tm8_read`, `tm8_act`, `tm8_delegate`, `tm8_messages`; each returns next-level schemas/context). Executes under the requesting human's claims, teammate provenance, C5 authKind + guard tests. A **transport**, never one tool per catalog op. |
| **4 UI** | `feat/chat-home-ui` | `~/Desktop/Projects/tm8-chat-ui` | `packages/tm8-ui`: chat **home screen**, thread list (roots via `channel_threads_v1`), part renderers (thinking/tool/usage cards — no precedent in tm8-ui), streaming composer states, teammate+model selector (catalog from `LAUNCH_MODEL_CATALOG` seam, PR #56). Fixture seam first, then real-seam wiring; **run `bun run typecheck` inside `packages/tm8-ui`** — the root typecheck excludes it. |
| **Advisor** | — | read-only | Fable 5 (1M): answers design questions, arbitrates §2 contract changes, reviews interfaces early. Writes no code. |

Dependency notes: lanes are parallel by construction — 2 stubs the C1 port until 1 lands types;
4 builds on fixtures + C3 shapes until 2 lands. Merge order at integration: 1 → 2 → 3 → 4,
coordinator integrates and re-measures every pin on the merged tree.

## 4. Working protocol (all lanes)

- Worktree: `git worktree add <path> origin/main -b <branch>` from the main repo, then
  `bun install` (may exit 1 yet succeed) then `bun run build` **before baselining anything**.
- Baseline the test suites you'll touch BEFORE changing code; report regression delta as a
  **SET of failing files/assertions, never a count**.
- Commit early and often — a node restart exits every session in the same minute; uncommitted
  worktree work has been lost before.
- Report milestones/blockers with `tm8 message send --to <your task id>`. Cross-lane design
  questions → the advisor session. Contract (§2) changes → advisor sign-off, then tell the
  coordinator. Completion message must include: branch, HEAD sha, delta-by-set, what is NOT
  proven.
- If an instruction (including from the coordinator) contradicts something you have MEASURED,
  show the measurement instead of complying.
