# tm8 New Chat UI — Production Implementation Plan

**Status:** implementation authority for the production Chat surface  
**Parent audit:** `task_1785374417266_qjkcvqhpz`  
**Canonical design:** `TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` and `TM8-CHAT-SYSTEM-DESIGN.md`

## 1. Outcome

Ship the designed Chat UI as the second Content surface inside a work-session panel and prove the complete member-to-agent-to-member loop for both Claude Code and Codex.

The product model is deliberately split into two independent selections:

1. **Agent runtime selection:** the launch workflow chooses teammate, provider, agent tool, and model (for example Claude Code + a Claude model or Codex + a GPT model).
2. **Content surface selection:** once the work session exists, its panel always offers Terminal and offers Chat only when the immutable Interaction Profile pin has a compatible safe browser projection.

The Interaction Profile connects these selections without conflating them. It is resolved at spawn, pinned immutably, and projected separately to the agent bootstrap and browser. The Chat UI is provider-neutral. A member's stored Chat message is delivered to the selected agent's native PTY; an agent creates canonical Chat bubbles only through the tm8 message operations. Raw Claude/Codex terminal output remains in Terminal and is never inferred into Chat.

## 2. Current implementation baseline

The implementation worker must verify these observations against the current tree before changing code:

- `packages/tm8-ui/src/channel-screen/ChannelScreen.tsx` and its component tests implement much of the inner visual composition, but no production owner mounts it or calls `seam.feed()`.
- The production work-session registry currently declares only the Terminal content surface.
- Terminal/Chat nested navigation, viewer/session preference, Interaction Profile browser projection, and the production feed/composer adapter are not mounted end to end.
- Server foundations already exist for `messages.post`, `entities.feed` with `session_chat_v1`, delivery summaries, message/activity events, cursor windows, and delivery settlement. Reuse these operations; do not create a parallel Chat API.
- The inner UI still lacks or incompletely renders redaction, edited state, hydrated replies, attachments, mentions, artifact cards, full delivery reasons, persistent drafts, scroll anchoring, responsiveness, and virtualization.
- Existing server redaction semantics and the UI's `deletedAt` check disagree. Fix the contract/presentation boundary so redacted content is an explicit, safe tombstone; do not guess from an empty string in the renderer.
- The worktree contains unrelated in-progress changes. Preserve them. In particular, changes already exist in contract launch schemas, execution spawn files, server execution/config files, and UI launch/data files. Make surgical edits, never reset files, and never run destructive cleanup.

## 3. Non-negotiable architecture

- Chat lives under **work session → Content**, not as a channel-level destination and not beside Terminal in a split view.
- Terminal is always available and cannot be renamed, reordered behind a privileged action, or hidden by a profile.
- Chat availability comes from the immutable work-session Interaction Profile pin and its safe browser projection.
- Profile resolution order is explicit authorized spawn override → teammate default → Space default → core profile.
- A profile's initial surface is only the first-open default. Runtime selection order is explicit valid deep-link surface → viewer/session saved preference → pinned profile initial surface → Terminal.
- Switching surfaces updates the current panel state/history entry; it does not push a new entity-stack entry.
- Surface switching must preserve the same TerminalPool entry/lease, output offset, and PTY process. It must also preserve Chat draft, reply target, pages, focus target, and scroll anchor.
- Chat is stored-first. Persist the graph message before live delivery and keep mutation, storage, and delivery status as separate states.
- One `clientMutationId` represents one logical submission. Uncertain outcomes are reconciled using that identity before another submission is offered.
- **Send again** creates a new message identity. It never retries/reinjects an uncertain transport write.
- Feed truth comes from `entities.feed(scope=session_chat_v1)`. WebSocket/poll events are invalidation hints, not a second truth store.
- No provider stdout parsing, JSON stream capture, terminal-text classification, or fake assistant bubbles.
- Browser projection must never receive hidden prompt/tool policy, provider secrets, session credentials, or raw profile policy.

## 4. Implementation milestones

### M0 — Preflight, ownership, and failing tests

1. Read the two canonical Chat documents, the backend briefing, current contract catalog/schemas, work-session detail path, TerminalPool lifecycle, panel navigation store, and existing ChannelScreen tests.
2. Reconcile the older gap register with current code. Mark each dependency as already shipped, incomplete, or truly absent; do not reimplement shipped W0–W5 work.
3. Record the exact pre-existing modified files before editing without reverting them. If a required dirty file contains overlapping work, preserve it and make the smallest compatible patch.
4. Add or tighten failing tests before each behavior change.

**Gate:** a short baseline report identifies the production mount seam, read/write operations, state owners, overlapping files, and the first failing tests.

### M1 — Interaction Profile pin and browser projection

1. Complete or verify launch-time profile resolution and immutable pin materialization for both Claude Code and Codex work sessions.
2. Expose only the safe browser projection needed by the panel:
   - pinned template key/version and compatibility state;
   - Chat capability;
   - safe feed/composer configuration;
   - initial content-surface preference;
   - safe diagnostics for an unknown pinned template.
3. Keep provider/model selection in the launch workflow. The Chat/Terminal switch must not mutate provider, model, profile, or the running session.
4. Ensure Claude Code and Codex receive provider-appropriate native interactive PTY launch/bootstrap while sharing the same tm8 message/feed contract.
5. Handle profile/template outcomes explicitly:
   - no Chat-capable pin → Terminal only;
   - valid Chat pin → Terminal + Chat;
   - pinned unknown template → Terminal selected first, Chat visible with warning and core fallback renderer.

**Gate:** contract/server tests prove profile precedence, immutable pinning, safe dual-audience projection, and equivalent Chat capability for Claude/Codex sessions when configured with the same Chat-capable profile.

### M2 — Production Content surface and navigation

1. Add `chat` to the work-session Content surface registry without exposing it for incompatible sessions.
2. Add a nested `contentSurface: 'terminal' | 'chat'` value to per-panel navigation/state and its route mirror.
3. Implement initial-selection precedence and persist the viewer-local, member+session-scoped preference. Use browser history replacement for toggles.
4. Mount an accessible Terminal/Chat segmented tab control in the shared Content toolbar. Provider/model/session status may be displayed as context, not as the switch's source of truth.
5. Mount Chat in the production work-session detail path and connect the existing component through a real host adapter.
6. Retain/protect the TerminalPool entry while Chat is active and restore/reparent/focus the same terminal instance on return.

**Gate:** switching repeatedly between Terminal and Chat does not restart the process, lose terminal output, create stack entries, or lose Chat-local state; two pinned panels remember surfaces independently.

### M3 — Chat host, store, and feed synchronization

1. Implement the production `ChannelScreenSeam`/Chat host adapter instead of placing network logic inside presentation components.
2. Key Chat client state by viewer/member + work session + feed scope/filter. Use narrow Zustand 5 selectors and shallow selection; do not subscribe components to the entire store.
3. Implement:
   - initial newest-page load and chronological presentation;
   - older-page pagination with cursor preservation;
   - `around=<kind>:<id>` focused windows with older/newer cursors;
   - deduplication by typed feed identity;
   - event-driven targeted refetch;
   - poll fallback, reconnect/gap refresh, and invalid-cursor snapshot recovery;
   - stale-response protection when the panel/session changes.
4. Persist drafts locally by member + work session. Preserve distinct new-message and reply drafts where required by the design.
5. Preserve loaded pages, focused item, reply target, and scroll anchor while Chat is inactive.

**Gate:** unit/integration tests cover pagination, around windows, event invalidation, reconnection, cursor invalidation, state isolation between panels/sessions, and durable draft restoration.

### M4 — Composer and stored-first lifecycle

1. Wire Send to `messages.post` with a UUIDv7 `clientMutationId`, the work-session anchor, optional `parentMessageId`, `mentionIds`, and `attachmentIds`.
2. Implement an optimistic journal keyed by `clientMutationId` and reconcile it to the stored feed result without duplicate bubbles.
3. Keep UI states separate: local draft → mutation pending → stored → per-target delivery state.
4. On an uncertain mutation result, query/reconcile the same idempotency identity before enabling another submission.
5. Implement reply selection/cancel, reply preview hydration, Enter-to-send, Shift+Enter newline, an operable visible Send button, and clear input help.
6. Keep Chat readable after session exit. If graph permissions still allow posting, explain that the message can be stored but cannot be delivered live.
7. Implement **Send again** only for proven safe cases by copying content into a new submission with a new identity; never reinject an `unknown` delivery.
8. Complete canonical file attachment and mention flows using existing entity/facade operations. File drop on the composer attaches; general entity drop remains the separate handoff flow.

**Gate:** tests prove success, validation failure, permission failure, unknown mutation recovery, optimistic reconciliation, multi-target delivery facets, reply, attachment, mention, exited-session behavior, and new-identity Send again.

### M5 — Complete feed presentation

1. Render typed message and activity variants without parsing untyped prose.
2. Message rows show author/persona, session provenance, canonical anchor, timestamp, edited state, explicit redaction tombstone, reply context, attachments, mentions, and delivery facets.
3. Render all delivery states and safe reason details: pending, dispatching, delivered, failed-retryable, failed-permanent, unknown, expired, and cancelled.
4. Render meaningful created/changed entities as artifact cards that open canonical detail; render typed state-change rows and honest generic fallback rows for unknown variants.
5. Group low-level mutation rows only with an explicit logical-operation key. Never group solely by timestamp.
6. Keep message text selectable/copyable and ensure a failed delivery never removes the stored bubble or its replies.

**Gate:** component tests cover every row/facet variant, safe unknown variants, redaction with no content leak, canonical navigation, and delivery/activity deduplication.

### M6 — Accessibility, responsiveness, and performance

1. Use native button/tab semantics, labeled regions, logical focus order, visible focus rings, and status/live regions for dynamic send/connectivity feedback.
2. Support full keyboard operation, Escape/cancel where appropriate, 44×44 touch targets, 200% zoom, narrow panels, high-contrast preferences, and reduced motion.
3. Preserve scroll position when prepending older pages; auto-follow only when already near the newest edge; otherwise show a non-disruptive new-items affordance.
4. Virtualize long feeds after a measured threshold and keep focus/around targets stable across virtualization.
5. Lazy-load the Chat surface or otherwise split its heavy code so the existing oversized production chunk does not regress further.

**Gate:** keyboard-only and automated accessibility checks have no critical/serious findings; responsive and long-feed tests pass; the production build records chunk sizes.

### M7 — End-to-end proof

Build deterministic local browser/API tests first, then run real native-provider smoke tests when credentials and binaries are available.

Required scenarios:

1. Launch Claude Code with a Chat-capable profile, open its work-session Content panel, select Chat, send a message, observe stored bubble and truthful delivery, have the agent reply through `tm8 message reply/send`, and observe the persona-authored reply.
2. Repeat with Codex. The Chat UI and API path remain identical; only launch/bootstrap and native PTY differ.
3. Switch Terminal ↔ Chat during output and verify no restart, detach, output loss, draft loss, or scroll loss.
4. Verify explicit deep-link surface, saved viewer/session preference, profile initial default, and Terminal fallback precedence.
5. Verify no-profile and unknown-template behavior.
6. Verify reply, attachment, mention, artifact card, edited message, redaction, delivery failure/unknown/expired/cancelled, exited session, reconnect, invalid cursor, and notification `around` focus.
7. Prove the negative invariant: provider prose printed only in the PTY appears only in Terminal and never becomes a Chat bubble.

If real provider credentials are unavailable, do not claim the real-provider gate. Leave deterministic harness coverage green and report the exact remaining manual command/scenario as an external E2E blocker.

## 5. Test and verification ladder

Run the narrowest affected test first, then expand:

1. New/changed component and store tests.
2. Contract and server operation tests for any schema/profile/pin changes.
3. Execution spawn/manifest tests for Claude Code and Codex bootstrap changes.
4. `packages/tm8-ui` typecheck and full UI test suite.
5. Production Vite build and bundle-size observation.
6. Browser E2E against a local tm8 server with deterministic fake PTYs.
7. Real Claude Code and Codex smoke tests when available.

No milestone is complete with skipped failing tests, type errors, hidden console errors, or assertions weakened to accommodate a regression.

## 6. Definition of done

- A production work-session panel mounts the designed Chat surface through real feed/message operations.
- Users select Claude Code or Codex at launch and independently select Terminal or Chat in the session panel; the distinction is visible and tested.
- A compatible immutable profile pin correctly controls Chat availability and initial presentation without leaking agent-only policy.
- Terminal/Chat navigation and state preservation satisfy the canonical design.
- Stored-first sending, optimistic/idempotent reconciliation, replies, delivery truth, activity/artifact rendering, redaction, attachments, mentions, pagination, live refresh, and focused navigation work end to end.
- Accessibility, responsive, performance, unit, integration, build, deterministic browser E2E, and available real-provider gates pass.
- The worker reports all changed files, contract effects, test commands/results, remaining risks, and any real-provider test that could not be run.

## 7. Worker operating rules

- Use test-driven development: failing test, smallest correct implementation, scoped verification, then integration verification.
- Read and follow the React/Vite, accessibility, Zustand 5, and Playwright testing skills before the corresponding changes.
- Reuse existing contracts and patterns; do not create a second Chat API, new provider capture path, or duplicate entity store.
- Preserve every unrelated worktree change. Do not reset, clean, stash, commit, push, or otherwise modify source control state.
- Report progress after M0, M2, M4, and M6; report a blocker immediately when it requires user authority, external credentials, or a conflicting ownership decision.
