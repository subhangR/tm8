# Workflow: explained attention triage

Version: 1.1 · 2026-11-20 · Status: Approved after integration review.
When to use: changing Needs you ordering, grouped request headlines, counts, or FYI visibility.
Summary: one shared queue ranks outstanding action requests, explains its ordering, and offers a separate FYI view without changing resolution scope.
Task: `01a1fa88-979a-7667-a9de-d4ef6ff744e8`.

## Registry and actors

| Workflow | Trigger / journey | Components | Observable states |
|---|---|---|---|
| Attention triage | Open Needs you in rail, status strip, phone, or page section; choose next human action | `attention-selectors.ts`, `attention-store.tsx`, `AttentionList.tsx`; hosts in `AttentionTopSegment.tsx`, `AttentionSheet.tsx`, `RailStatus.tsx` | LOADING, UNAVAILABLE, READY_ACTIONS, READY_FYI, STALE, EMPTY, SEEN, RESOLVING, RESOLVED, RESTORED |

Actors: the viewing member selects scope and opens/marks/resolves; the attention store projects pending server requests and optimistic command overlays; existing attention commands and event reads persist and reconcile changes. This is one presentation workflow; server request creation and command persistence remain their existing workflows.

## Decision tree and exact policy

1. Read pending requests (`open` plus legacy `acknowledged`), grouped by `rootId ?? entityId`. Resolved/dismissed requests never enter the queue.
2. Select request scope: `actionable` (default, level urgent/high/normal, including missing legacy level as normal), `fyi` (explicit informational view), or internal `all` (complete inventory for detail controls).
3. Select owner filter: Personal includes roots with a request in the selected scope assigned to the viewer; only that viewer's requests determine its priority, headline, seen state and chip in Personal. Team considers all requests in the selected scope. Unassigned requests are never Personal. A root's other requests stay in its complete inventory and resolution scope.
4. Count distinct roots in that scope, never individual requests. `counts()` defaults to actionable; `counts('fyi')` and `counts('all')` are explicit. A root with both types contributes once to each applicable scope. Seen never changes a count.
5. Rank roots by highest eligible level (urgent > high > normal > FYI), then unseen before fully seen, then total eligible points descending, oldest eligible request ascending, and root id ascending. FYI points and seen flags cannot raise an actionable root's rank.
6. Choose a primary request within each root's selected scope and owner filter: level descending, unseen first, individual points descending, oldest ascending, request id ascending. Its reason, action type, requester, age, source and chip accessibility text must describe the same request. Retain `latest` as the newest request for compatibility; it no longer supplies the queue headline.
7. Show explicit level and counts of actionable/FYI requests on the root, plus the ordering explanation and Action needed / FYI choices. Every pending request remains accessible in the corresponding scope and in entity detail. Complete request inventory is retained on each queue row.
8. Open or title click marks the root Seen and opens the primary request's target: system request → pinned entity; other request with a raising session → raising session; otherwise → pinned entity. A system form request names the form as its source, not a session that happens to be recorded on it.
9. Seen dims without removing. Resolve still settles **all** pending requests on the root, including other assignees and FYI; the confirmation states this full scope. Preserve the optional note and existing eight-second Undo. No new request or resource is created by filtering or ordering.

Phone: show the header affordance while any request exists. With FYI only it is muted, names the FYI count, and opens the same list with an explicit FYI choice. Entity attention controls and existing session request details read internal `all` so informational requests remain available. Home action sections and Needs me continue to use actionable roots.

## Observables and failure branches

| State / branch | Customer and operator | Database | Logs / recovery |
|---|---|---|---|
| LOADING | Loading text; no all-clear count | Existing rows unchanged | Existing list requests; await current read |
| UNAVAILABLE: initial read rejects (transient, auth, validation) | Attention unavailable; never an empty/all-clear state | Unchanged | Existing error; retry on next event/resync or refresh; no invented zero |
| STALE: refresh rejects after a complete read | Keep last complete rows; list names the failed refresh and offers Retry; closed host badges show `?` and name the last-loaded counts | Unchanged; partial pages never replace the last complete snapshot | Keep the first failure until a complete read succeeds; a requested retry waits for both status readers to settle |
| READY_ACTIONS / READY_FYI | Scope and owner counts, priority, reason, matching source/action, full resolution scope | Unchanged | Local selectors emit no extra logs |
| EMPTY | No actions for selected owner/scope; suggest Team if other owners have entries; FYI choice remains visible | Unchanged; FYI is not resolved or deleted | No side effects |
| SEEN | Root dims; counts stable; lower levels cannot overtake urgent merely because it was seen | Existing mark-seen command updates viewer state | Existing command failure behavior retained |
| RESOLVING → RESOLVED | Existing optimistic removal, eight-second Undo | Existing root-scoped batch resolves full inventory | Existing command/batch logs |
| Resolve fails / partial legacy failure | Restore server-open rows and show existing command error | Server result remains authoritative | Existing command reconciliation/refresh; no new cleanup |
| Undo while resolve is in flight | Existing command waits for resolve, then reopens its batch | Versions/batch remain authoritative | Existing command serialization |
| Unreadable/missing root title | Root id remains visible; request source/reason still available | Unchanged | Existing hydration failure; no request hidden |
| Concurrent request, urgency/reason/assignee update, resolution, or reopen | Recalculate counts, primary and rank from next authoritative read; root/id tie-break makes equal inputs deterministic | Existing command versions/batches decide conflicts | Pending-bearing upserts schedule the existing throttled read even when pending count is unchanged; optimistic overlay reconciliation remains authoritative |

## Handoffs and timing

| Boundary | Payload / success / failure | Timeout and recovery |
|---|---|---|
| Pending read → selectors | Existing typed `AttentionRequest[]` with id, entity/root, status, level, points, seen flag, assignee, reason, action, source, requester and timestamp → queue rows with complete inventory, newest `latest`, selected `primary`, eligible chip and owner/seen state. Invalid requests are rejected at the existing contract boundary. | Synchronous projection; no asynchronous timeout or retry. Deterministic level/legacy defaults above. |
| List → store | `counts(scope?)`, `queue(ownerFilter, scope?)` → distinct root counts / ordered rows; optional `refreshError` marks retained rows stale | Synchronous, no new network call. Scope and filter changes do not mutate persistent state. |
| List → open / commands | Existing `markSeen(rootId)`, `resolve(rootId, note?)`, Undo batch and host `onOpen(targetId, row)` contracts | Existing command promises and error toast. No new retries of writes. |
| Events → pending read | Existing activity/upsert/resync, one attempt in flight, trailing refresh with 2,000 ms quiet delay. Read every cursor for each pending status in pages of 100; expose READY only after all pages succeed. One attempt retains ownership until both status readers settle, even after failure; requests to refresh meanwhile coalesce into one trailing attempt. | Existing list seam has no explicit timeout; a hung read remains a pre-existing limitation, not a successful empty result. The first page failure immediately reports initial error or marks the previous complete snapshot stale. Stop following cursors after either status fails, wait for already-running pages, then permit a trailing attempt. Repeated cursors reject as non-advancing pagination. Drop old-space reads before fetching more pages. |

Ordering assumption: await existing read/command reconciliation, never assume a Seen or Resolve response implies other in-flight requests have finished. Cleanup inventory: local filter choice only; unmount discards it. No server resources to destroy.

## Verification and assumptions

Tests must cover seen urgent versus unseen normal; same-level seen/points/age/id ties; urgent older request versus newer normal/FYI on one root; Personal with only an assigned FYI plus another person's action; own request winning a Personal headline over other assignees; pure FYI noise; mixed roots in both scopes; primary reason/type/requester/source and Open target agreeing for session and system form; full-root Resolve and Undo; initial or later-page read failure and cursor loop; refresh after one status fails while a sibling page remains pending (no overlap, no abandoned next page, one trailing attempt); stale snapshot retained until a successful read and visible Retry clears the marker; urgent action beyond a FYI first page; unmount during pagination; same-count urgency/reason update; FYI-only phone access and session detail inventory.

Assumptions: urgency and points supplied by request authors are trusted for triage; this change adds no deadline or inferred task-state priority. Existing transport timing limitation above is unchanged. This specification describes this checkout, not an independently verified running production build. Integration review must compare this policy with the final implementation before approval.

## Integration reality check (2026-11-20)

Independent Sol review verified the code against this workflow. Upload review
closed interrupted receipts, unknown settlement cleanup, completed-writer races,
and active-writer SQLSTATE handling. Attention review verified priority, personal
headlines, complete paging and failed-sibling read ownership. Access review checked
viewer gates, metadata allowlists, masking and recorded/current distinctions.
Short-title creation seams and prompt preservation pass the focused test suites.
Deployment remains a separate completion requirement recorded on the task.
