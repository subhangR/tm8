# Server Owner Brief (server-owner)

You own `packages/server` (+ `db/migrations`, additive `packages/contract`, the `packages/execution` liveness seam, `tools/conformance`) for the tm8-ui program. Read `CHARTER.md` first — R3, R4, R6 bind you. APIs are W4-complete and mostly tested; your scope is the three deltas below plus whatever they uncover. Never break an existing API; conformance stays green.

## Delta 1 — Generic mapper passthrough arm

The contract declares ~20 event families (`packages/contract/src/schemas.ts:609-727`) but the mapper (`packages/server/src/events/mapper.ts`) projects only 6 (entity/edge/message/counter/activity/notification) and its default case THROWS (`mapper.ts:534-543`), so RPC-authored events are written to `workspace_events` yet silently skipped on both poll and WS: `menu.updated`, `space.default_channel.updated`, `handoff.*`, `message.delivery_reserved/settled`, `message.attachments.updated`, `interaction_profile.*`, `project.association.corrected`, `work_session.profile_*`.

These are inserted contract-shaped at write time (verified: migration `029_w2_menu_default_channel.sql:494-506` builds `{'type':'menu.updated', 'menu':…, 'clientMutationId':…}`). So: **one passthrough arm**, not 14 bespoke arms — membership set of RPC-authored types → validate payload against the strict schema (the `assertWorkspaceEvent` tripwire at `events/emitter.ts:145` already guards both paths) → emit as-is. Per-type check the payload is leak-safe for a space-wide feed (recipient-targeted rows already use `recipient_member_id`). Entity-backed changes already flow via the trigger's `entity.upsert`/`edge.upsert` — do NOT duplicate them.

## Delta 2 — Session liveness read (additive contract amendment)

Today "is there actually a live PTY?" is unanswerable by API: liveness truth is the in-process PTY map; recorded status is `work_sessions.status`; ghost reconciliation runs only at boot (`execution-handlers.ts:409-430`); between boots a dead-without-exit-event session looks live until an attach fails. The new UI's honesty states (R-UI-5: "a status=running row with no live PTY presents 'stale — node restarted', never live") need a read.

Design it WITH bridge-coordinator (consensus on shape), per R4 additive-only: a new op (e.g. `sessions.liveness` — batch: given a spaceId or session ids, return recorded status + actually-live + node identity) or an additive field on existing session reads — your call jointly. Full amendment discipline: contract types + zod + catalog entry + handler + conformance coverage. Existing ops untouched.

## Delta 3 — Real WS/events end-to-end tests (the gap that gates WS-first)

Component tests exist (`test/events.test.ts` real-socket-no-DB, `test/w2/events-durable.test.ts` in-memory fakes, `test/events/poll.pg.test.ts`) but **no test boots the real composition (DB → trigger → pump → WebSocket)** and the real `DbSubscriptionAuthorizer` is only ever constructed in `main.ts`. The new UI rides this path for the first time. Build:

- A bootstrap-with-DB integration suite: real mutation → trigger capture → `DurableEventPump` (per-connection claims) → socket frame; subscribe seeds high-water, `resume {spaceId, since}` replays, cursor advance past skipped rows.
- Two-socket fan-out: space-wide events reach both; a `recipient_member_id` notification reaches ONLY its member (the leak case invisible with one client).
- Reconnect/gap: drop socket, mutate, resume-by-seq → no loss, no duplicates; `events.poll` agreement with the WS stream (same seq spine).
- Passthrough events (Delta 1) asserted end-to-end (a menu update reaches a subscribed socket).
- `/v2/ws` coexistence: events WS and PTY WS (`?sessionId=`) dispatch correctly (`main.ts` upgrade split).
- Real `DbSubscriptionAuthorizer` under test (member sees space, non-member refused, fail-closed).

Fix what these uncover if scoped to the events path; report to master first if architectural. Use `HOW-TO-TEST.md` instruments exactly (PG at :5442, `db/migrate.mjs`, per-package suites, node runtime — never bun for server/execution).

## Also

- Answer capability questions from bridge-coordinator promptly (you are the API authority).
- Sequence: Delta 3's harness first (it derisks everything), Delta 1 through it, Delta 2 with bridge consensus.
- Report each delta's landing to your maestro task with test counts.
