# t3code

Local source read at `~/Desktop/Projects/t3code`, 2026-08-12. pnpm monorepo, ~1.17M LOC / 13.4k TS
files, **Effect 4 beta**, event-sourced **SQLite**. Product code: `apps/{server,web,mobile,desktop}`
+ `packages/{contracts,client-runtime,shared,effect-acp,effect-codex-app-server}`.

**One line:** a multi-vendor agent IDE that writes *zero* agent logic — it rents five vendor loops
behind one 12-method port and normalizes them into a single event stream.

## Sub-documents

| Doc | Covers |
|---|---|
| [`runtime-and-adapters.md`](./runtime-and-adapters.md) | The 12-method port, 5 vendor adapters, ACP viability, approvals |
| [`data-model.md`](./data-model.md) | 26 events, 2 aggregates, messages vs activities, streaming collapse |
| [`chat-ui.md`](./chat-ui.md) | The virtualized timeline, tool/diff/approval rendering, composer |
| [`auth-and-config.md`](./auth-and-config.md) | Subscription OAuth by config-dir isolation; the MCP-wipe hazard and its fix |

## Why it matters to tm8

**The most directly copyable architecture of the three.** It solved exactly our problem — many
vendors, one UI, subscription billing — and its port is narrow enough to lift wholesale.

## Headline corrections to earlier assumptions

- **It is not an Anthropic app.** `ClaudeAdapter` is one of five; the shared port is 126 lines.
- **The centre of gravity is the ingestion reactor** (1831 lines), not any adapter.
- **Messages and activities are flat sibling arrays** joined by `turnId`, not containment.
- **Streaming deltas collapse server-side** in the projector, not on the client.

## What it does *not* have

**No graph. No orchestration.** A thread cannot spawn threads or subagents; there is no
delegation and no task list. The only inter-thread link is human-driven (an agent proposes a plan
referencing another thread; a human starts it). Project → Thread → Messages over a filesystem
path, and that is the whole model.

→ tm8's graph and multi-session orchestration have **no prior art here to borrow**.

## Known weaknesses

- **The same schema is hand-projected three times** — in-memory projector (758-line switch), a
  2282-line SQL reconstruction, and a client reducer — all of which must stay byte-compatible
  forever. A live drift hazard.
- **O(n²) per thread**: every `message-sent` spreads the whole messages array then re-slices to a
  2000 cap, over a long-lived in-memory read model.
- God-files: `ProjectionSnapshotQuery` 2282, `ProviderRuntimeIngestion` 1831, `ProjectionPipeline`
  1689, `decider` 1218.
- **NUL bytes embedded in core source** (`OrchestrationEventStore`, `ChatComposer`, others) — naive
  grep silently misses symbols. Use `grep -a`. (We have the same trait in our own tree.)
- Notably clean otherwise: zero TODO/FIXME near core thread logic. The debt is structural
  duplication, not litter.
