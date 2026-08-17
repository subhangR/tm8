# OpenCode — storage and sessions

**The model tm8 should copy.** It is the only one of the three that stores durable, typed,
re-openable agent turns — exactly what Buzz declined to build and t3code only half-built.

## Durable SQL, not flat files

SQLite via Drizzle (`packages/core/src/session/sql.ts:1`) — a deliberate departure from classic
opencode's flat JSON files.

| Table | Columns that matter |
|---|---|
| `SessionTable` | `id`, `project_id`, `workspace_id`, **`parent_id`**, `slug`, `title`, `version`, `share_url`, **token counters**, **`revert` JSON**, **`permission` JSON**, `agent`, `model` JSON, `time_archived` |
| `MessageTable` | `id`, `session_id`, `data` JSON |
| **`PartTable`** | `id`, `message_id`, `session_id`, `data` JSON, **`ordered`** |
| `TodoTable` | — |

Three levels: **Session → Message → Part.**

## The typed Part union

From `@opencode-ai/schema/session-v1` (`core/v1/session.ts:8-45`):

```
TextPart · ReasoningPart · ToolPart · FilePart · AgentPart · SubtaskPart
CompactionPart · PatchPart · SnapshotPart · StepStartPart · StepFinishPart · RetryPart
```

**Tool parts carry running / completed / error state** and stream as deltas over the event bus
(`session/message-v2.ts:55-60`).

> This is the direct answer to tm8's central design question. Compare:
>
> | Product | Agent turn representation |
> |---|---|
> | Buzz | flat string + **ephemeral** side-channel — cannot be re-opened |
> | t3code | flat message + sibling `activities[]` with **opaque** tool payloads |
> | **OpenCode** | **typed parts, durable, ordered, per-part state** |
>
> Only OpenCode's model lets you re-render a turn faithfully weeks later, including which tool ran,
> what it returned, and whether it failed.

## Sessions are a tree

`parent_id` gives the session tree — which is how subagents work (a child session per subtask) and
how fork works. `revert` state is stored **per session**, so undo is a first-class column, not a
derived guess.

## Re-openable, forkable, revertable

All three are real, and exposed over ACP as `ForkSession`, `ResumeSession`, `LoadSession`,
`ListSessions` (`acp/agent.ts`). Contrast Buzz, which implements **none** of these despite ACP
defining them.

## What tm8 should take

**Copy the three-level shape**, adapted to tm8's graph rather than replacing it:

- **Keep the tm8 `message` as the durable unit** — anchors, mentions, attachments, unseen marks,
  notifications and the whole existing graph keep working unchanged.
- **Add a sibling `part` table keyed by message id**, with an `ordered` column and a typed
  discriminated union: `text | reasoning | tool_call | tool_result | patch | usage | error |
  step_start | step_finish`.
- **Give tool parts real state** (`running | completed | error`) plus typed args/result — this is
  where t3code's opaque `data: Schema.Unknown` blob falls down, and it is why their UI can only
  render tool calls as a `<pre>` dump.
- **Store cost/usage per turn** (Buzz's kind:44200 discipline, `None ≠ 0`) rather than only tokens.
- **Session tree via parent id** maps naturally onto tm8's existing spawn/derivation edges — we
  already model derived sessions in the graph, so this is a projection we largely have.

## What to avoid

- **The two-generation split.** `packages/opencode` (shipped) vs `packages/core|llm|schema` (newer
  rewrite, already partly imported) means any given file may be current or superseded.
- **`effect@4.0.0-beta` lock-in.** Their storage model is good; their framework commitment is a
  separate bet tm8 shouldn't inherit.
- **SQLite.** Fine for a local single-user tool, wrong for tm8's multi-tenant Postgres graph. Take
  the schema shape, not the engine.
