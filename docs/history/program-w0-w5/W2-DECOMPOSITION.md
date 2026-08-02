# W2 decomposition (authored by Altair at W2-prep completion, 2026-07-25; Vega-accepted)

Both workers plug into the committed server frame (`packages/server/src/http` + `events`); split is directory-disjoint inside packages/server.

## DENEB — facade + derived truth (`src/facade/`, db-client seam). The heavier half.
- D1. PG client + per-transaction claims (SET LOCAL tm8.identity_id/actor_id/node_admin/request_id; requestId already threaded) + SQLSTATE translation via the existing table in `http/errors.ts`. All writes via Cygnus's SECURITY DEFINER RPCs; zero raw INSERT.
- D2. Read family handlers: identity.get, spaces.* (navigation/home/settings), entities.get/children/hierarchy/connections/versions/activity, edges.list, edgeTypes.list, messages.list, inbox.list, savedViews.list, actions.list, presence.get, projects.*, entityKinds.list.
- D3. DERIVED TRUTH (L3, load-bearing): EntityDetail assembly, EntityCapabilities, EntityBadges, PullState, LiveWork, autoTabs, titles/tombstones, counters. Server-side only.
- D4. Keyset cursors on every paged read via contract cursor.ts {v:2,k:[...]}; Cygnus has the (sort key, id) indexes.
- D5. collections.query + graph.query with REAL grouping/sorting/subtree.
- D6. Command family: entities.create/patch/move/delete/restore/react/points.add, closed /commands/* (complete/work/pull/link-pr/link-commit), edges.*, messages.*, placements.apply, commands.undo, tracking.refresh, savedViews.*, inbox.markRead, readMarks.upsert, spaces.invites.*, spaces.taskAxes.*, files.*. Every one threads clientMutationId to the RPC (ledger is Cygnus's — no second ledger).
- D7. Resolve the 13 ops in UNBOUND_COMMAND_OPERATIONS (facade/input-schemas.ts): bind a schema or declare body-less.
- D8. Workspace-scope query variant for Home/Inbox (R25).

## SIRIUS — events mapper + WS push + policy re-map (`src/events/`).
- S1. Replace InMemorySeqSource with PgSeqSource over the per-space monotonic workspace_events counter (AM-2 §3). One interface, one file.
- S2. WorkspaceEvent mapper: workspace_events rows → contract events, re-projecting {space_id, seq, occurred_at, schema_version, client_mutation_id}; the unconditional WorkspaceEventSchema tripwire in emitter.ts catches off-contract projection server-side.
- S3. events.poll handler over DurableEventLog (since = seq, not timestamp) — turns that deliberate 501 green.
- S4. Client→server WS control protocol — **BLOCKED on the pending contract amendment** (no subscribe/unsubscribe/presence-toggle wire shape exists; Rigel must land it first; do not invent one).
- S5. WS auth: wire opts.authorize to the identity resolver; subscription authorization through the graph (share_mode + membership, T-L10) via the SubscriptionAuthorizer seam.
- S6. Live push (LISTEN/NOTIFY or log-tail) → fan-out.
- S7. Bridge-policy re-map.
- S8. Presence-channel seq: currently shares the durable SeqSource (burns durable numbers — harmless now, gaps allowed) but MUST get its own counter before PgSeqSource lands or the two disagree about next().

SEQUENCING: Deneb starts immediately after Cygnus's 007/008 slice (D1/D2/D3 need only migrations + the frame). Sirius starts S1/S2/S3 as soon as workspace_events exists; parks S4 behind the amendment. Neither needs the other.

## G1A note (Vega): for the loop, prioritize the D2/D5/D6 subset the slice needs (spaces.home, task collection query, entity get/create/patch for task+doc, messages, work commands, projects.*) + S1/S2/S3 + execution.spawn wiring — full family completeness is post-loop.
