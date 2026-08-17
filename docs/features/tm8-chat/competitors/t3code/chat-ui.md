# t3code — chat UI

The most directly relevant prior art for tm8's missing turn-item renderers, because it is the only
one of the three that renders structured agent output **inline in the main timeline**.

## Shape: one virtualized flat timeline

`MessagesTimeline.tsx:193`, virtualized with `@legendapp/list` (`LegendList`, `:25`, `:487-520`).
**One flat heterogeneous row array** — kinds: `message`, `work`, `work-toggle`, `turn-fold`,
`proposed-plan`, `working`. Not nested lists. Structural sharing via `useStableRows` (`:1708`) so
unchanged rows skip re-render.

## How each thing renders

| Content | Component | Pattern |
|---|---|---|
| **Thinking / reasoning** | *(none)* | No dedicated component. "Thinking" is one of 4 **tones** on a generic `WorkLogEntry` row (`session-logic.ts:72`), mapped from `task.progress`, shown with a bot icon. **There is no reasoning bubble.** |
| **Tool call + result** | `SimpleWorkEntryRow` (`:1924-2058`) | Collapsed *together* into one compact log row, grouped under "N tool calls" (`WorkGroupSection`). Click expands a plain `<pre>` of command/JSON. **No structured per-arg viewer.** Status = icon only. |
| **Diffs** | `DiffPanel.tsx` | **Not inline.** A turn-level "Changed files" chip opens a docked side panel (unified/split toggle, annotatable). Inline `FileDiff` only for review comments. |
| **Approvals** | `ComposerPendingApprovalPanel` + `…Actions` | **In the composer footer, not the timeline.** Four buttons: Cancel turn / Decline / Always allow this session / Approve once → `respondToThreadApproval` RPC (`ChatView.tsx:4953-4979`). |
| **Agent questions** | `ComposerPendingUserInputPanel` | A separate multi-question wizard. |
| **Errors** | inline red+X per tool; `ThreadErrorBanner.tsx` | Thread-level banner pinned above the timeline. |
| **Usage** | `ContextWindowMeter.tsx` | Ring gauge in the composer footer. **Tokens only — no dollar cost anywhere in the UI**, despite `totalCostUsd` being available. |

## Long-running turns

`WorkingTimelineRow` — three pulsing dots plus a self-ticking `WorkingTimer` that **mutates
`textContent` directly to avoid a React commit per second** (`:1117-1143`). Progressive disclosure
via `WorkGroupToggleTimelineRow` ("+N previous tool calls") and `TurnFoldTimelineRow` (fold an
entire prior turn).

## Composer

`ChatComposer.tsx`, 3238 lines. ⚠️ **contains NUL bytes — `grep` needs `-a`.**

- **Send is BLOCKED while a turn is busy** (`ChatView.tsx:4546-4554`). No auto-queue. The send
  button morphs into a red **Stop** (`ComposerPrimaryActions.tsx:135-149`) calling
  `interruptThreadTurn`. "Queue while busy" is a manual prompt-stash, not auto-delivery.
- Optimistic send via `optimisticUserMessages`, reconciled on server echo.
- Plan/build interaction-mode toggle (+ `/plan`, `/default`), runtime-mode select,
  `ProviderModelPicker` (+ `/model`).
- Three triggers: `/` slash, `$` skill, `@` file-path mention (`composer-logic.ts:225-263`).

## Client state

Effect RPC over a raw **WebSocket** (`client-runtime/src/rpc/session.ts:95-116`), not SSE or
polling. Thread stream = `snapshot | event | synchronized`. State lib is Effect's own
`Atom`/`SubscriptionRef` via `@effect/atom-react` — **not** Zustand/Redux/XState. Monotonic
sequence-gap dedup; persists to local cache only once a thread settles.

## Lessons for tm8

1. **A flat heterogeneous virtualized row list is the right shape.** Don't nest lists per turn;
   emit typed rows into one array and let folding/grouping be row kinds.
2. **Approvals belong near the composer, not in the scrollback.** They are a *blocking prompt*,
   and burying them in a scrolling timeline means users miss them.
3. **Diffs go in a side panel.** Inline diffs wreck timeline virtualization and scroll anchoring.
4. **Render cost, not just tokens.** They have `totalCostUsd` and don't show it; we should, and we
   should store it per turn from day one.
5. **Blocking send during a turn is a defensible default** — but tm8's orchestration story
   (multiple concurrent sessions) may justify queueing instead. Decide deliberately.
6. Copy the direct-DOM ticking timer trick for any per-second UI.
