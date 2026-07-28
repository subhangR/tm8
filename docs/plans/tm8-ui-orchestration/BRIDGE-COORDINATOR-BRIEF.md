# Bridge Coordinator Brief (bridge-coordinator)

You own the data layer of the new UI: `packages/tm8-ui/src/data/**` and (jointly with fe-coordinator) the Facade seam. Read `CHARTER.md` first — R2, R3, R4, R6 bind you. Your product: everything between the server's HTTP/WS surface and the UI's stores — designed simple, supporting the core use cases, no overcomplication (user's explicit instruction).

## Read first

1. `CHARTER.md`
2. `packages/contract/src/contract.ts`, `schemas.ts` (WorkspaceEvent union :609, control channel :751, CommandResult/patches), `catalog.ts` (81 ops; `events.subscribe` WS `/v2/ws`, `events.poll` GET)
3. The proven old-client patterns (pattern reference, not copy-paste law): `packages/ui/src/real/events.ts` (EventPoller cursor discipline), `packages/ui/src/collab-v2/stores/graph.ts` (applyEvent dedupe, optimistic journal keyed by `clientMutationId`, CommandResult.patches), `packages/ui/src/real/TmClient.ts` (`{data,requestId}` unwrap, error mapping)
4. `uploads/tm8-ui-design/08-SPECS/TM8-CHAT-UI-AND-LAYOUT-DESIGN.md` §16 (client cache/optimistic rules) — in `/Users/subhang/Desktop/Projects/tm8/T0-1 workspace structure review (1)/`

## Phase 0 — Data-layer LLD (consensus-gated)

One LLD doc (`packages/tm8-ui/src/data/LLD.md`), reviewed to consensus by BOTH other coordinators (fe: the seam serves the UI; server-owner: the transport matches server reality). Orchestrate up to three Fable-5 sub-workers (API client · WS/events · notifications) if useful (R12), but the LLD is ONE coherent design. Components:

- **WS event client** (R2: WS-first): `events.subscribe` control channel — subscribe/unsubscribe, `resume {spaceId, since}` on reconnect, seq as the only dedupe/order key (gaps legal, order authoritative), `events.poll` as catch-up fallback and degraded mode. Connection state machine feeds the DESIGNED honesty states (T4: offline / reconnecting / stale) — the UI never fakes liveness.
- **API client**: thin, catalog-derived, contract-typed; `{data, requestId}` unwrap; typed error mapping (401/403/404/409/501 → seam-level results the UI renders as designed states, incl. disabled-with-reason for 501 capability probes).
- **Projector + optimistic journal**: apply events to stores by family; optimistic apply on command → reconcile on `clientMutationId` echo (event or CommandResult) → rollback on failure. The 6 row families generically; **passthrough events** (menu.updated, delivery settles, etc. — server-owner's Delta 1) via a small type→slice invalidation table. Do not build generic magic beyond that.
- **Notifications**: `inbox.list`/`inbox.markRead` + the recipient-private event feed (`notification.created/read`) driving badge counts and toasts; delivery-facet updates (`messages.delivery.get` + `message.delivery_settled` passthrough) for the two-facet badges (delivered/refused/unknown × recorded — never collapsed, `unknown` never styled success).
- **Liveness**: consume server-owner's new liveness read (Delta 2 — co-design the shape with them, additive-only); expose ONE predicate to the UI per R-UI-5 (status=running + no live PTY ⇒ stale, never live).
- **The Facade seam** (with fe-coordinator): the typed interface the UI consumes; you also ship the **fixture implementation** FE builds against, so the real implementation is a drop-in. Seam changes after consensus require re-consensus.

Out of scope for you: the PTY terminal byte stream (R9 — FE lifts the transport verbatim; it shares `/v2/ws` via `?sessionId=` but is not your client), server internals, UI components.

## Phase 1 — Implementation (can start once LLD consensus lands)

Build against the REAL server (:4610, dev data dir) with integration tests; the shared seq spine (WS and poll agree) is your acceptance. Coordinate with server-owner's e2e harness (Delta 3) — your client and their tests should exercise the same paths.

## Phase 2 — Integration (post-GATE, layer-by-layer)

After the user approves the gate screen (R5), swap fixtures → real seam per collection/screen with fe-coordinator, smallest lego first (one list panel live, then panels, then events, then notifications, then terminal attach). Every swap verified in the browser against the running server — never by tests alone.

Report LLD milestones, consensus, and each integration layer to your maestro task.
