# t3code — data model

Event-sourced **SQLite** (`@effect/sql-sqlite-bun` + a bespoke `NodeSqliteClient`), append-only
`OrchestrationEventStore`. No Postgres.

## 26 events, 2 aggregates

`packages/contracts/src/orchestration.ts:906-933` — 3× `project.*` + 23× `thread.*`.
Common envelope `EventBaseFields` (`:1152-1162`): `sequence`, `eventId`, `aggregateKind/Id`,
`commandId`, `causationEventId`, `correlationId`, `metadata`.

Aggregates are only **project** and **thread**. Structure: 1 project → many threads;
1 thread → exactly one `session` (`:386`). A project is
`{workspaceRoot (fs path), repositoryIdentity (git), scripts, defaultModelSelection}` (`:213-224`);
a thread pins its own git `branch` + `worktreePath` (`:352-388`).

## Messages and activities are SIBLINGS, not nested

This is the correction that matters most. `messages[]` and `activities[]` are two **flat arrays**
on the thread aggregate (`:380`, `:384`), correlated only by a shared **nullable `turnId`** — not
containment. "A turn's contents" is reconstructed client-side by filtering both arrays.
**No turn entity holds `items[]`.**

```ts
// :229-239
Message = { id, role, text, attachments?, turnId, streaming, createdAt, updatedAt }

// :315-325
Activity = { id, tone: info|tool|approval|error, kind: OPEN STRING,
             summary, payload: Schema.Unknown, turnId, sequence?, createdAt }
```

**`kind` is not a closed union** — a free string validated only at emission. The ~17 kinds
actually emitted (`ProviderRuntimeIngestion.ts:329-670`): `approval.requested/resolved`,
`runtime.error`, `tool.denied`, `runtime.warning`, `turn.plan.updated`,
`user-input.requested/resolved`, `task.started/progress/completed`, `context-compaction`,
`context-window.updated`, `tool.started/updated/completed`.

**"Reasoning" is NOT an activity kind.** It is a content-stream kind (`reasoning_text`,
`reasoning_summary_text`, `providerRuntime.ts:81-89`) folded into streamed text — never a
discrete row.

## Tool calls are opaque

```ts
// providerRuntime.ts:404-411
ItemLifecyclePayload = {
  itemType,
  status?: inProgress | completed | failed | declined,
  title?, detail?,
  data?: Schema.Unknown        // ← persisted verbatim, untyped
}
```

No typed args, no typed result, no duration. **`status` is the only structured field.**

## Streaming collapse happens SERVER-SIDE

Correction to a common assumption ("the client concatenates"). Each delta is its own durable
event `thread.message-sent {text: delta, streaming: true}` (`decider.ts:1038-1056`); completion
emits `text: "", streaming: false` (`:1059-1084`). **The log never stores a final collapsed
string.** Concatenation happens in the server projector:

```ts
// projector.ts:472-492
text: message.streaming ? `${entry.text}${message.text}` : ...
```

Clients receive the already-collapsed `OrchestrationMessage.text`; the client reducer does not
re-derive it from raw deltas.

## The triple-projection hazard

The same event log is hand-projected into the same `OrchestrationThread` shape **three times**:

1. in-memory fold — `projector.ts:194` (758-line switch)
2. SQL reconstruction — `ProjectionSnapshotQuery.ts` (2282 lines, largest file in the repo)
3. client mirror — `client-runtime/src/state/threadReducer.ts` (`applyThreadDetailEvent`,
   ~30-case switch, 599 lines)

Two of these are independent hand-written derivations that must stay byte-compatible forever.
**This is a cost, not a freebie** — and the strongest argument for tm8 deriving its read model
once, server-side, rather than mirroring it in the client.

## Implications for tm8

- ✅ **Copy:** flat sibling arrays joined by `turnId`; server-side delta collapse; the durable
  `commandId` receipt checked before the decider.
- ⚠️ **Improve on:** type the tool payload. Opaque `data` means the UI can never render a tool
  call better than "here is a blob" — which is exactly what their UI does.
- ❌ **Avoid:** hand-writing the same projection more than once.
