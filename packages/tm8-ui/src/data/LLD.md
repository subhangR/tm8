# tm8-ui Data Layer — Low-Level Design (Phase 0)

Owner: bridge-coordinator. Consensus reviewers: fe-coordinator (the seam serves the UI),
server-owner (the transport matches server reality). Status: **DRAFT v1 — awaiting dual consensus.**

Binding law: `packages/contract` (81-op catalog, `WorkspaceEvent` union, `WorkspaceControlFrame`,
`CommandResult`, `CollabError`). Rulings R2 (WS-first), R3 (minimal server deltas), R4 (additive-only
contract), R9 (PTY byte stream is NOT this layer), R-UI-5 (liveness honesty). Design instruction from
the user: **simple, core use cases only, no overcomplication.**

---

## 1. Scope

Everything between the server's HTTP/WS surface and the UI's stores:

- catalog-derived **API client** (`{data, requestId}` unwrap, `CollabError` mapping)
- **WS-first event client** (subscribe / resume-by-seq, `events.poll` fallback, connection honesty states)
- **projection library + optimistic journal** (6 row families + passthrough table, `clientMutationId` reconcile)
- **notifications + delivery facets**, **session liveness** (Delta 2), and
- the **Facade seam** (`seam.ts`, co-owned with FE) with a **fixture implementation** so the real one is a drop-in.

Explicitly out: PTY terminal byte stream (R9 — FE transplants the transport verbatim; it shares
`/v2/ws?sessionId=` but is a separate client), server internals, UI components, presence/NEEDS-YOU
detection (R8: dormant).

## 2. Decisions already locked by cross-coordinator consensus

| # | Decision | With |
|---|---|---|
| C-1 | **Delta 2 FINAL shape**: new additive op `execution.liveness` — `GET /v2/spaces/:spaceId/execution/liveness` → `{ liveEntityIds: string[], nodeBootId: string, checkedAt: IsoTimestamp }`. `liveEntityIds` = work_session entity ids with a live PTY in this node process for that space; `nodeBootId` stable per process. Read-on-demand only; **no** liveness-change event (R3). `recordedStatus` comes from the entity cache, not this read. | server-owner |
| C-2 | Seam file at `packages/tm8-ui/src/data/seam.ts`, co-owned, dual-consensus change control. | fe-coordinator |
| C-3 | Seam is **transport-shaped**: plain typed promises + one event stream + connection-state signal. All reads return contract DTOs verbatim so fixture and real impls are type-indistinguishable. | fe-coordinator |
| C-4 | `menu(spaceId)` makes op-unavailable (501) and missing-row (404) **indistinguishable**: both resolve `null`; FE substitutes the shipped versioned default (TM8-UI-SPEC-FINAL §4.10). Never rejects for those two codes. | fe-coordinator |
| C-5 | **One fixture dataset**: FE's A0 worker authors contract-typed raw fixture rows in `src/fixtures/` (FE-owned); my fixture seam impl in `src/data/fixtures/` consumes that dataset. Required states: stale session (running + no live PTY), NEEDS-YOU, delivery facets, tombstone, UUID-length titles, empty collections. | fe-coordinator |

## 3. Module map (`packages/tm8-ui/src/data/`)

```
seam.ts              THE co-owned interface (types only; re-exports contract view types)
index.ts             createRealSeam(opts) / createFixtureSeam()
real/
  http.ts            fetch transport: bindPath()-derived URLs, envelope unwrap, CollabError
  ops.ts             typed wrappers for exactly the ops the seam exposes — nothing speculative
  socket.ts          raw WS: open /v2/ws, send control frames, parse frames, heartbeat awareness
  connection.ts      the state machine: live / polling / offline, backoff, catch-up, resync signal
  liveness.ts        sessions.liveness cadence + snapshot
  seam-real.ts       assembles the above into Seam
project/
  reducers.ts        pure per-family event reducers (framework-free; mirror packages/ui graph.ts)
  journal.ts         optimistic journal keyed by clientMutationId (pure)
  domain-store.ts    OPTIONAL ready-made zustand/vanilla domain store wiring stream+reducers+journal
fixtures/
  seam-fixture.ts    Seam impl backed by ../..​/fixtures dataset (FE-authored, C-5)
```

Dependencies: `@tm8/contract` (types + catalog + zod schemas), `zustand/vanilla` (domain-store only).
No react imports anywhere in `src/data`.

## 4. The seam (`seam.ts`) — contract sketch

Concrete signatures below are the consensus object; naming nits welcome at review, semantics are the point.

```ts
import type {
  SpaceId, EntityId, EntitySummary, EntityDetail, MessageView, ActivityItem,
  NotificationItem, MenuConfig, HandoffView, MessageDeliveryRecord, EdgeView,
  DurableWorkspaceEvent, CommandResult, CollabError, /* input types verbatim */
} from '@tm8/contract';

export type Unsubscribe = () => void;

/** T4 honesty states. 'polling' = WS down but HTTP catch-up succeeding (render as reconnecting/degraded). */
export type ConnectionState =
  | { phase: 'connecting' }
  | { phase: 'live' }
  | { phase: 'polling'; disconnectedSince: string }
  | { phase: 'offline'; disconnectedSince: string };

/** R-UI-5: 'unknown' (no fresh snapshot) renders neutral — NEVER as live. */
export type SessionLiveness = 'live' | 'stale' | 'not-running' | 'unknown';

export interface Seam {
  // -- lifecycle -------------------------------------------------------------
  openSpace(spaceId: SpaceId): Promise<void>;   // subscribe + start liveness cadence
  closeSpace(spaceId: SpaceId): void;
  dispose(): void;

  // -- event stream & connection honesty ------------------------------------
  /** Durable events for open spaces. GUARANTEE: strictly increasing seq per space,
   *  no duplicates. FE stores need no seenEventIds set. */
  onEvent(cb: (e: DurableWorkspaceEvent) => void): Unsubscribe;
  onConnection(cb: (s: ConnectionState) => void): Unsubscribe;
  getConnection(): ConnectionState;
  /** Catch-up integrity lost (past retention, refused resume): re-run hydration reads. */
  onResync(cb: (spaceId: SpaceId) => void): Unsubscribe;

  // -- reads (gate-critical, FE list items 1–8) ------------------------------
  identity(): Promise<IdentityView>;
  spaces(): Promise<SpaceSummary[]>;
  menu(spaceId: SpaceId): Promise<MenuConfig | null>;              // C-4: null ⇒ shipped default
  query(input: CollectionQueryInput): Promise<CollectionPage>;      // both list panels + palette
  entityKinds(spaceId: SpaceId): Promise<EntityKindDescriptor[]>;   // kind-selector metadata
  entity(id: EntityId): Promise<EntityDetail>;
  children(id: EntityId, opts?: PageOpts): Promise<Page<EntitySummary>>;
  connections(id: EntityId): Promise<EdgeView[]>;                   // Connections tab
  activity(id: EntityId, opts?: PageOpts): Promise<Page<ActivityItem>>; // Activity tab
  messages(anchorId: EntityId, opts?: PageOpts): Promise<Page<MessageView>>; // Discussion tab
  handoffs(workSessionId: EntityId): Promise<HandoffView[]>;
  // kept in seam, not gate-critical:
  inbox(opts?: PageOpts): Promise<Page<NotificationItem>>;
  feed(id: EntityId, opts?: FeedOpts): Promise<FeedPage>;           // Chat, Phase 2
  delivery(messageId: EntityId): Promise<MessageDeliveryRecord[]>;

  // -- commands (contract input types VERBATIM; caller supplies clientMutationId
  //    so FE can journal before the promise settles) -------------------------
  commands: {
    createEntity(input: CreateEntityInput): Promise<CommandResult>;
    createTask(input: CreateTaskInput): Promise<CommandResult>;
    patchEntity(id: EntityId, input: PatchEntityInput): Promise<CommandResult>;
    patchTask(id: EntityId, input: PatchTaskInput): Promise<CommandResult>;
    moveEntity(id: EntityId, input: MoveEntityInput): Promise<CommandResult>;
    deleteEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult>;
    restoreEntity(id: EntityId, ctx?: CommandContext): Promise<CommandResult>;
    complete(id: EntityId, input: CompleteInput): Promise<CommandResult>;
    work(id: EntityId, input: WorkInput): Promise<CommandResult>;
    postMessage(input: PostMessageInput): Promise<CommandResult | MessageBatchResult>;
    editMessage(id: EntityId, input: EditMessageInput): Promise<CommandResult>;
    markRead(notificationId: string): Promise<void>;
    upsertReadMark(anchorId: EntityId, input: ReadMarkInput): Promise<void>;
    react(id: EntityId, input: ReactInput): Promise<CommandResult>;
    spawn(input: SpawnInput): Promise<CommandResult>;
    prompt(id: EntityId, input: PromptInput): Promise<CommandResult>;
    terminate(id: EntityId, input: TerminateInput): Promise<CommandResult>;
  };

  // -- liveness (Delta 2, C-1) ----------------------------------------------
  liveness: {
    refresh(spaceId: SpaceId): Promise<LivenessSnapshot>;
    onChange(cb: (snap: LivenessSnapshot) => void): Unsubscribe;
    /** THE predicate. recordedStatus running + not in live set ⇒ 'stale'. */
    statusOf(session: Pick<EntitySummary, 'id' | 'workStatus'>): SessionLiveness;
  };
}
```

Errors: reads/commands **reject with contract `CollabError`** — code/message/details/retryable are
already renderable; no second error vocabulary (the old UI's frozen-set mapping problem does not
exist here). `not_implemented` (501, reserved ops) rejects like any other code and FE renders
disabled-with-reason; the single soft-fallback exception is `menu()` (C-4).

## 5. HTTP client (`real/http.ts`, `real/ops.ts`)

Pattern-proven by `packages/ui/src/real/TmClient.ts`, minus the legacy error remapping:

- URLs come from `bindPath(opName, params)` — the catalog is the only route source.
- Success `{data, requestId}` → return `data`. Failure `{error:{code,message,details,requestId,retryable}}`
  → throw `CollabError` with the server's own code (all server codes are already in `CommandErrorCode`).
  Network failure / non-JSON → `upstream_unavailable` + flip connection signal.
- `ops.ts` exposes one typed function per seam-exposed op. No generic op-name dispatcher, no
  speculative coverage of all 81 ops.
- Base URL: relative (`''`) — vite dev server (:4612) proxies `/v2` to :4610. Injectable for tests.

## 6. WS event client (`real/socket.ts`, `real/connection.ts`) — R2 core

### Server facts this design is built on (verified in tree + confirmed by server-owner)

1. One socket `/v2/ws` (`events.subscribe`); client→server frames are `WorkspaceControlFrame`
   (`subscribe {spaceIds}`, `unsubscribe`, `resume {spaceId, since}`, `presence`, `presence.set`),
   parsed `.strict()` — an unknown key makes the whole frame malformed-refused. Server→client frames
   are single JSON `WorkspaceEvent`s plus `control.refused` acks. **No positive acks exist** —
   success is silent, refusal is the only ack.
2. `subscribe` seeds live delivery at the server high-water mark (from NOW) — it never replays.
   **Nuance (server-owner)**: if the mark cannot be established the subscription is left deliberately
   UNSEEDED — no live push at all until a `resume` carries the client's own cursor — and the client
   cannot observe which happened. Therefore `subscribe` is ALWAYS followed by `resume`.
3. `resume` replays `seq > since` (≤500, RLS-filtered) to this connection only, then seeds live
   delivery at the replay end. No replay-complete marker exists.
4. **The pump is a per-connection log reader** (1s tick, 200/batch): once seeded, it walks the durable
   log forward under the caller's claims. Therefore **one `resume` per space is sufficient** — the
   pump itself delivers any backlog at ~200 events/s; there is no gap between replay end and live.
   The client MAY loop `resume` from its advancing cursor to accelerate a large catch-up
   (server-owner-endorsed pattern); seq dedupe makes interleaved live frames harmless.
5. `events.poll` returns `{items, nextCursor: string|null}`; `nextCursor` is a decimal-string seq
   reusable verbatim as `?since=`, page cap 500. **Retention is 7 days by default**
   (`internal.prune_workspace_events`, 003_read_model.sql:403) and nothing schedules pruning — so
   resume/poll recovery is honest for any realistic gap; the snapshot-refetch fallback remains for
   beyond-retention gaps and refused resumes.
6. Per-member notification rows ride the same per-space seq spine (RLS-filtered per connection), so
   one cursor covers space events AND my notifications.

### Client algorithm

Per-space cursor `lastApplied: Map<SpaceId, number>` (in-memory; a fresh page load hydrates via
reads and subscribes from NOW — no cross-reload persistence in v1).

- **Connect**: open WS → send `subscribe {spaceIds: [...open]}` → **always** send
  `resume {spaceId, since: lastApplied ?? 0}` per space (fact 2: subscribe may be silently unseeded;
  resume is the only self-owned seed) → phase `live`. First-ever open of a space has no cursor, so
  `since: 0` replays the retained log through the pump — idempotent upserts + seq dedupe make this
  harmless, and dev-scale volume makes it cheap. (Open item: if 7-day retained logs grow hot enough
  to make from-0 bootstrap slow, ask server-owner for a cheap high-water read — additive, deferred
  until proven needed.)
- **Frame in**: `control.refused` → see below. Event frame → if `e.seq <= lastApplied[e.spaceId]` drop,
  else set cursor and dispatch to `onEvent` subscribers. This single rule is the whole dedupe/order
  discipline (seq authoritative, gaps legal — old EventPoller's proven cursor law).
- **WS lost**: phase `polling`, reconnect with backoff (0.5s → 8s cap, jitter). While down, run an
  `events.poll` loop per open space from `lastApplied` (1.5s cadence, prime immediately), feeding the
  SAME dispatch path — fallback and WS agree on one seq spine by construction. All HTTP failing too →
  phase `offline` (poller keeps retrying from the same cursor).
- **WS regained**: stop pollers, `subscribe` + one `resume` per space from `lastApplied`, phase `live`.
- **Resync rule**: if a `resume` is answered `control.refused`, or the disconnect gap exceeded
  10 minutes (event replay stays honest for 7 days, but hydrated read-model freshness is cheaper to
  re-establish than to replay through), emit `onResync(spaceId)` — FE re-runs its hydration reads;
  events keep flowing from the newly seeded cursor either way, so there is no window.
- `control.refused` on `subscribe` → surface as a seam-level forbidden error for that space (never
  silent — a refused space must not look like a quiet one).

Presence frames: never sent, never expected (R8 dormant). If one arrives it is dropped before dispatch.

## 7. Projection library + optimistic journal (`project/`)

Consensus C-3 makes the seam transport-shaped, and FE stores own state. The projection LOGIC is still
this lane's deliverable, shipped as pure framework-free modules FE wires into its zustand stores:

- **`reducers.ts`** — per-family pure functions mirroring the proven `packages/ui` graph-store switch:
  entity upsert/delete (+ counter fold-in), edge upsert/delete (+ per-entity index), message
  upsert-by-anchor (sorted, capped, tombstones stay), activity prepend (capped), notification upsert.
  Inputs/outputs are plain immutable records — usable inside any `set()`.
- **Passthrough route** (Delta 1 consumers) — one small table, no generic magic. **Delta 1 v1
  scope (server-owner, verified at write sites): only `menu.updated` and
  `space.default_channel.updated` actually flow.** The remaining rows are stored as bare flat
  payloads that cannot pass strict verbatim passthrough and stay OFF the wire until write-side
  reshaping is ruled (escalated to master, timing unknown). Their table rows stay — the contract
  types are real and handling is forward-compatible — but the data layer MUST NOT rely on them for
  correctness. Source of truth for handoff/session state transitions is entity-backed:
  `entity.upsert`/`edge.upsert` from the trigger, which flow today (work_session status changes
  included).

  | event type | handling | Delta 1 v1 |
  |---|---|---|
  | `menu.updated` | apply (full `MenuConfig` in payload) | **flows** |
  | `space.default_channel.updated` | apply to space-settings slice | **flows** |
  | `message.delivery_reserved` / `message.delivery_settled` | apply to `deliveryByMessageId` | dormant |
  | `message.attachments.updated` | apply (full `MessageView`) | dormant |
  | `handoff.prepared/…/withdrawn` | apply to `handoffsByWorkSession` (full `HandoffView`) | dormant |
  | `project.association.corrected` | invalidate `connections(entityId)` — refetch on demand | dormant |
  | `interaction_profile.*` | invalidate profile slice (Phase-2 surface; no eager handling) | dormant + **blocked**: contract-vs-migration event-name drift (027 authors `teammate_default_updated`/`space_default_updated`; contract declares only `default_updated`) — build against neither until master rules |

- **`journal.ts`** — `createJournal()`: `applyOptimistic(cmid, patches)` captures prior summaries,
  `reconcile(cmid)` drops the entry (called on event echo OR CommandResult success — first wins),
  `rollback(cmid)` restores captures. No timers: every command settles with a `CommandResult` or a
  rejection, so every journal entry has a deterministic exit.
- **`domain-store.ts` (recommended adoption)** — a ready-made `zustand/vanilla` store that wires
  seam stream → reducers → journal → passthrough table, exposing the domain families
  (entities/details/edges/messages/activity/notifications/menu/delivery/handoffs) with selectors.
  FE keeps all UI state in its own stores and may adopt this for the domain slice or re-wire the pure
  modules itself — fixture/real parity holds either way because both sit behind the same seam.

Optimistic flow (unchanged from the proven pattern): FE builds contract input with a fresh
`clientMutationId` → `applyOptimistic` → `seam.commands.x()` → success: apply `CommandResult.patches`
(authoritative) + `reconcile` · failure: `rollback` + render `CollabError` → any event echoing the
same `clientMutationId` also reconciles (idempotent; seq-dedupe makes double-apply harmless).

## 8. Notifications & delivery facets

- Hydrate: `inbox()` (`GET /v2/inbox`); live: `notification.created` / `notification.read` events
  (recipient-private rows on the same spine, §6.6). Badge = `readAt == null` count; toast on
  `notification.created` newer than hydration point.
- `markRead` is optimistic (set `readAt` locally, rollback on failure).
- Delivery facets: `delivery(messageId)` **on demand is the correctness path** — the
  `message.delivery_settled` passthrough is Delta-1-dormant (§7), so live push of facet changes
  does not exist in v1. Facets refresh on read: when a message's delivery detail is opened, and on
  a visible-row refetch when its anchor's messages are re-read. When the passthrough later flows,
  it upgrades freshness with zero interface change. `MessageDeliveryRecord` passes through
  UNCOLLAPSED — the two facets (delivered/refused/unknown × recorded) are separate fields
  end-to-end; rendering rule restated for the record: `unknown` is never styled as success.
- Cross-space badge honesty: only open spaces stream; a slow `inbox()` re-read (60s while the window
  is visible) covers the other spaces. No push infrastructure invented for it.

## 9. Liveness (`real/liveness.ts`) — Delta 2, shape C-1

`GET /v2/spaces/:spaceId/execution/liveness` (op `execution.liveness`). Cadence: on `openSpace` · on
`entity.upsert` where the entity is a `work_session` · on WS reconnect · 30s slow interval while any
session surface is visible. One in-flight call max; snapshot carries `nodeBootId` + `checkedAt`.

Predicate (R-UI-5, the ONLY place liveness truth is computed):

```
statusOf(s): workStatus !== 'running'      → 'not-running'
             no snapshot / snapshot > 90s  → 'unknown'   (rendered neutral, never live)
             s.id ∈ live set               → 'live'
             otherwise                     → 'stale'
```

A `nodeBootId` change between snapshots forces an immediate re-read of open-session surfaces (the
node restarted; every previously-live PTY is gone).

## 10. Fixture seam (`fixtures/seam-fixture.ts`)

Implements `Seam` 1:1 over the FE-authored dataset (C-5, `src/fixtures/`): reads resolve from the
dataset (with latency ~0), commands mutate the in-memory dataset and synthesize the same
`CommandResult.patches` + echo events (with monotonically assigned seq) through `onEvent` — so FE's
stores exercise the REAL reconcile path against fixtures. Connection state is scriptable
(`fixtureControls.setConnection(...)`, `fixtureControls.setLiveness(...)`) so the gate screen can
demo the honesty states. Dataset must include the C-5 required states.

## 11. Phase 1 — implementation & tests (post-consensus)

Build order (2 workers max, dependency-sequenced): (1) http+ops with integration tests against a
real node — **NEVER against `tm8_dev`** (server-owner warning: boot runs `reconcileGhosts` and
retires live running sessions); tests use a scratch DB + their own node on a spare port, per
HOW-TO-TEST.md and server-owner's Delta 3 bootstrap helper; (2) socket+connection+catch-up —
acceptance: **WS and poll agree on the seq spine** (drive mutations via HTTP, assert identical event
sequences via WS and via poll from the same cursor; kill the socket mid-stream and assert no loss, no
duplicate through the seam). (3) reducers/journal — pure vitest, no server. (4) liveness against
server-owner's Delta 2 implementation. Shared harness/fixtures with server-owner's Delta 3 e2e tests —
same paths, one truth.

## 12. Known backend defects the seam absorbs as data (W5 forward, measured detail pending)

Master relayed three W5-measured defects that touch this layer. Design stance: each arrives at the
UI as an honest state, never a surprise or a fake.

| Defect | Seam stance |
|---|---|
| `presence.get` returns empty viewers on every node | Already structural: the seam exposes NO presence surface (R8 dormant). This defect is why that exclusion stays hard — an empty-viewers read rendered as "nobody here" would be a lie. |
| `spaces.home` advertises a next-page token no op accepts | `spaces.home` is not in the seam (not gate-critical). If it is ever added, its `nextCursor` must be treated as dead — never rendered as a load-more affordance until the server fixes the round trip. |
| Message provenance permanently null through public writes | `MessageView` DTOs pass through verbatim; FE must render null provenance as its designed unknown-author state. The fixture dataset (C-5) must include null-provenance messages so the gate screen proves that rendering. |

Adjust this table to W5's measured detail when it arrives; if any defect is fixed server-side, the
stance collapses to nothing (DTO passthrough already handles the healthy case).

## 13. Open items

- [ ] server-owner: confirm one-resume sufficiency as written in §6.4 (loop endorsed; single-resume
      relies on the pump walking the backlog) and the `since: 0` first-open bootstrap (§6 algorithm).
- [ ] `execution.liveness` final catalog row + zod schema names once server-owner lands the amendment.
- [ ] Delta 1 final passthrough membership set (server-owner publishing with leak-safety rationale) —
      §7 table adjusts mechanically if membership differs.
- [ ] FE consensus on §4 signatures, §7 domain-store adoption, fixture controls surface (§10).
- [ ] `IdentityView` / capability-flags shape for boot (FE item 1) — align with whatever
      `identity.get` returns today; if capability flags are missing there, FE and I escalate before
      inventing one (R4: additive ask to server-owner).
