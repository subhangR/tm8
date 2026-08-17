# Spike — headless graph-only agent, and how a session stays alive

**Everything here was RUN on this machine, 2026-08-12.** `claude` 2.1.212. Not design, not docs —
transcripts of real processes. Scratch harness:
`<scratch>/acptest/` (`tm8-mcp.mjs`, `mcp.json`, `multiturn.mjs`).

> ⚠️ Scratch dirs do not survive reboots. The recipe below is the durable artefact; re-create the
> harness from it if needed.

---

## 1. There is no terminal — that's the point

tm8 today runs `claude` in a **PTY** and reads the screen. The upgrade is not to *hide* that
terminal; it is to **not allocate one**. Headless mode is plain pipes with structured JSON:

- stdin ← newline-delimited JSON user messages
- stdout → newline-delimited typed events (`system/init`, `assistant` with `thinking`/`text`/
  `tool_use` blocks, `user` with `tool_result`, `rate_limit_event`, `result`)
- **zero ANSI parsing**

## 2. The proven recipe — a graph-only agent

```bash
claude -p --verbose \
  --input-format stream-json --output-format stream-json \
  --model <model> \
  --setting-sources ""          `# don't inherit ~/.claude or repo CLAUDE.md` \
  --disable-slash-commands      `# no skills` \
  --mcp-config mcp.json --strict-mcp-config   `# ONLY our MCP server` \
  --tools ""                    `# drop ALL built-in tools` \
  --allowed-tools "mcp__tm8__tm8_entity_context" "mcp__tm8__tm8_message_send" \
  --system-prompt "You are the tm8 graph agent. …"
```

Measured result:

```
INIT  tools = ['mcp__tm8__tm8_entity_context','mcp__tm8__tm8_message_send']
      mcp_servers = [{'name':'tm8','status':'connected'}]   slash_commands = 0
  TOOL_USE mcp__tm8__tm8_entity_context  → ok
  TOOL_USE mcp__tm8__tm8_message_send    → ok
RESULT success  turns=3  cost=$0.0073
```

The agent read the graph, reasoned, and **replied by calling `tm8_message_send`** — the same
output-by-tool-call pattern tm8 already uses via its CLI, and the one Buzz identifies as the key
architectural move.

### ⚠️ `--tools` and `--allowed-tools` are DIFFERENT and you need BOTH

| Flag | Job | Alone |
|---|---|---|
| `--tools ""` | removes built-ins from the tool **list** | tools are visible-but-denied → **agent fails** |
| `--allowed-tools …` | grants **permission** | built-ins still listed → 30 tools of context bloat, extra `ToolSearch` round-trip |

Measured: `--allowed-tools` only → 4 turns, **$0.044**. Both together → 3 turns, **$0.0073**.
**~6× cheaper** purely from a clean tool surface.

### ⚠️ Do NOT use `--bare` for this

It looks perfect ("skip hooks, LSP, plugin sync, auto-memory, CLAUDE.md auto-discovery") but it
also states: *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper — OAuth and keychain
are **never read**."* **`--bare` kills subscription auth.** Compose the individual flags instead.

## 3. Approvals are SDK-only over raw stdio

With a tool not pre-authorized, no `control_request` / `canUseTool` is emitted. The model
**auto-denies itself** and continues:

```
user: [{"type":"tool_result","is_error":true,
        "content":"Claude requested permissions to use X, but you haven't granted it yet."}]
```

**Consequence:** raw stdio gives the full *read* stream but no interactive approvals — you must
pre-authorize. With a closed graph-only tool set there is nothing to approve, so this is the
*enabling* choice for v1, not a limitation. Wanting in-chat approve/deny buttons means the Agent
SDK (Anthropic-only) or your own loop.

## 4. How a session stays alive — two models, both proven

### Model A — hot process (stdin held open)

One process, many turns. **Same `session_id` throughout; context carries.**

```
  993  INIT   session_id=5eecf52b…
 2719  RESULT turn=1  cost=0.00199  dur=1735ms
 5328  TEXT: 4271                        ← recalled from turn 1
 5368  RESULT turn=2  cost=0.00334  dur=2393ms
 9036  RESULT turn=3  cost=0.00678  dur=3404ms
 9630  PROCESS EXIT code=0
```

- Write a JSON line to stdin per user turn; each turn emits its own `init` … `result`.
- `init` repeats per turn but carries the **same** `session_id` — it is per-turn framing, not
  per-process.
- **Closing stdin ends the process cleanly** (exit 0). That is the shutdown signal.
- ~1s cold start, then **1.7–3.4s per turn**. Cost climbs as context accumulates.

### Model B — cold resume (process per turn)

Process exits between turns; a **brand-new** process reattaches:

```
claude -p … --resume 5eecf52b-407b-43ce-a05d-0363d06d6989
→ INIT sid=5eecf52b…   TEXT: 4271   RESULT cost=$0.01414
```

Context fully intact. Transcripts persist at
**`~/.claude/projects/<cwd-slug>/<session-id>.jsonl`**.

**Cost of cold resume: $0.014 vs $0.003 hot** on a 3-turn thread — ~4× more, because the
transcript is replayed with no warm prompt cache. That gap **widens as the thread grows**.

### ⚠️ Two gotchas

1. **Transcripts are keyed by CWD slug.** Resume from a different working directory may not find
   the session. Pin the cwd per thread.
2. `--no-session-persistence` exists — using it disables the on-disk transcript and therefore
   **breaks resume**.

### Recommendation for tm8: hybrid, matching the existing session lifecycle

| State | Runtime |
|---|---|
| User actively chatting | **hot process**, stdin open — fast and cheap per turn |
| Idle past a timeout | let it exit; free the process slot |
| Next message arrives | **`--resume`** into a fresh process, transparently |

Pre-mint the id with **`--session-id <uuid>`** so tm8 creates the thread row *first* and hands the
CLI its own identifier — this maps directly onto tm8's existing `native_session_id` column already
backfilled for resume. Thread identity then lives in the graph, not in the vendor's store.

## 5. What this spike settles

| Question | Answer |
|---|---|
| Can we run without a terminal? | ✅ proven |
| Can tm8 own the prompt and the whole tool surface? | ✅ proven (`--system-prompt`, `--tools ""`, `--mcp-config`) |
| Can the agent be graph-only (no fs/shell)? | ✅ proven |
| Does it reply via tool call rather than stdout? | ✅ proven |
| Multi-turn chat on one process? | ✅ proven, context carries |
| Survive process death? | ✅ proven via `--resume` |
| Interactive approvals over raw stdio? | ❌ **no — SDK only** |
| Subscription auth preserved? | ✅ yes — provided you avoid `--bare` |

## 6. Not yet spiked

- The **real** tm8 MCP server (this used a 2-tool fake) and auth for it.
- Concurrency: how many hot processes one node sustains, and memory per process.
- Interrupt mid-turn in headless mode.
- `codex` equivalent via `app-server`, and whether one port covers both cleanly.
