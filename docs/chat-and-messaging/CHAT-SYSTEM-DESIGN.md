# tm8 Chat — End-to-End System Design (Mechanics)

**Status:** System design under the closed visual design (`~/Desktop/tm8-ui-design/10-CHAT-SURFACE.md`) and the canonical `CHAT-UI-AND-LAYOUT-DESIGN.md`. This document designs the **mechanics**: how a typed message reaches the agent, how the agent's tools are built and discovered, how tool use makes messages and entities appear in Chat, and how Chat reads it all back. It does not redo the visual design.

**Date:** 2026-07-27 · **Author:** Orion (execution lead)

**Grounding:** the working tree (uncommitted W2 additions included), not STATE.md. Everything cited as `file:line` was read from the tree on this date.

---

## 0. Already decided — cited, not relitigated

| Decision | Authority |
|---|---|
| CLI-first; no provider JSON/hooks/SDK streams/terminal-text classification in Phase 1 | Chat doc §1.4 |
| Capture is explicit-only; a bubble exists only when a participant explicitly creates a graph message through tm8 | Chat doc §1.3 |
| Message-first public surface; **no public `prompt` command**; §5.7's governed at-most-once PTY queue survives verbatim as the internal delivery adapter | WORKSPACE v2.11 RULING M, T-D23 |
| Public verbs: `tm8 message send --to <ws>` · `tm8 message reply <id>` · `tm8 message delivery <id>` · `tm8 entity feed --scope session_chat_v1`; browser/CLI/agent are separate clients of the same catalog ops | Chat doc §10.7 |
| Spawn compiles provider prompt + provider-native tool subset from the profile pin; policy may narrow native registration but **never removes the CLI contract** | Chat doc §15 step 5; harness doc §4.1 |
| Server derives actor and work-session from the session-scoped credential; request bodies cannot claim another session | Chat doc §15 step 4 |
| Exactly-once delivery REJECTED — no atomic commit spans Postgres and `proc.write()`; `unknown` is a real terminal outcome | SCM §8.2; WORKSPACE R6-1 |

**Headline finding from the tree:** far more of this loop is already implemented than the design docs assume. `entities.feed` with `session_chat_v1` (all five membership terms), the 8-state delivery ledger, the governed one-write PTY handshake, and the §14 injection templates all exist. The historical wake budget was removed by migrations `120`/`135`. The loop fails today at exactly three seams: **agents have no session-scoped credential** (they act as the loopback Owner), **`authored_from` provenance is an unwired resolver** (always null), and **the PTY delivery writes the raw body instead of the §14.4 envelope**. Close those three and the core round trip works.

---

## 1. The system at a glance

Three planes, deliberately separate:

```text
GRAPH TRUTH (Postgres)          DELIVERY TRANSPORT (execution ledger)      PTY RUNTIME (node-pty)
messages · edges · activity     session_message_deliveries (8 states)      provider process bytes
entities.feed projections       reserve → claim → one write → settle       FIFO prompt queue
                                                                            terminal scrollback
```

```text
 user types in Chat composer
   │ messages.post (stored-first, atomic)
   ▼
 message row + message.created event ──────────────► Chat bubble (via entities.feed)
   │ deliveryIntent per work-session anchor (post-commit)
   ▼
 delivery ledger: pending → dispatching → delivered/…      ◄─ delivery badge
   │ one governed PTY write (internal principal only)
   ▼
 agent's terminal: §14.4 incoming-message envelope
   │ agent acts through the tm8 CLI (its only tm8 tool surface)
   ▼
 tm8 message send/reply → new message row (+authored_from edge)
 tm8 entity/task mutations → activity rows (work_session_id)
   │
   ▼
 entities.feed scope=session_chat_v1 ──► bubbles + artifact cards + activity rows
```

PTY bytes never enter the graph; graph messages never depend on PTY success. Every arrow crossing a plane is one of exactly three contracts: `messages.post`, the internal delivery adapter, or `entities.feed`.

---

## 2. Section A — Inbound: user types → stored message → governed PTY delivery

### A.1 Store first

The browser composer calls **`messages.post`** — the same catalog op behind `tm8 message send` (`packages/contract/src/catalog.ts:82`). Input: `clientMutationId` (uuidv7, generated client-side; doubles as `messageBatchId`), `anchorIds:[<work-session-id>]`, `body` (≤10,000 chars), optional `parentMessageId` for a reply, `mentionIds`, `attachmentIds` (`packages/contract/src/schemas.ts:899-931`). The RPC `w2_post_message_batch` validates anchors, inserts one message row per anchor, and commits atomically with the `message.created` event (`packages/server/src/facade/services/w2/messages-handoffs.ts:304-363`, `db/migrations/019_w2_messages_handoffs.sql`). **At this point the bubble exists.** Delivery has not been attempted.

The four send layers in the visual design (draft / mutation-pending / stored / delivered-or-not) map 1:1: draft is client-local; mutation-pending reconciles on `clientMutationId`; stored = the committed row; delivered-or-not = the ledger below.

### A.2 Reserve and dispatch (after commit, never inside it)

The RPC emits one `deliveryIntent` per work-session anchor (`019:462-464`). Post-commit, the facade calls `messageDelivery.reserve(intent)` then `adapter.dispatch(...)` after storage commits, so a PTY outage can never roll back or disguise the stored message. Reservation refuses dead sessions (`failed_permanent/session_not_live`), refuses self-contact, and creates one durable row per `(message,target,attempt)`. Migration `135` removed the wake-budget table and copied pair version: claim/settle concurrency is the delivery row lock and legal transition guard, while the unique logical-attempt key prevents reservation forks.

### A.3 The one governed write

The delivery worker (`W2ExecutionDeliveryService`, `packages/server/src/facade/services/w2/execution.ts:580+`, DB role `tm8_delivery_worker`, wired only when `TM8_DELIVERY_DATABASE_URL` is set — `main.ts:129-138`) runs the R7-2 handshake: **reserve → mint unforgeable principal → claim (`pending→dispatching`, durable) → one write → settle**. `promptInternal` (`w2/execution.ts:175-206`) is "the ONLY path from this server to a live terminal for a stored message": guard-first `isSystemDeliveryPrincipalFor` (WeakSet object identity — no request shape can forge it), then `pty.deliverPrompt(sessionId, content, 'send')`. Every public caller of `execution.prompt` — including a session agent bearer, owning Member, admin, act-as — gets `forbidden/use_message_send` before queue admission (`w2/execution.ts:76-92`; SCM §8.3). Duplicate dispatches of the same delivery join the in-flight promise; a settled row returns its outcome verbatim; bytes are never re-attempted (`packages/execution/src/pty/w2-message-delivery.ts:129-177`). The pre-delivery command-ledger replay is bypassed — the delivery row IS the ledger (WORKSPACE R7-2).

The physical write (`PtyHostService.writePromptToEntry`, `packages/execution/src/pty/PtyHostService.ts:553-573`): strip trailing newlines, `proc.write(text)`, sleep 200 ms, then `proc.write('\r')` (mode `send`). Per-session FIFO with bounds 256 KiB / 32 prompts / 64 sessions (`:89-91`); overflow → refused → `failed_retryable` (proof of no bytes). **Node runtime, never bun** (`PtyHostService.ts:190-192`).

### A.4 Framing — what the agent actually sees

**Today the write delivers the raw body** (`019:464` — `'content', p_body`). That is a gap (G4), not the design. The design: the delivery content is the **§14.4 `tm8.incoming-message` envelope**, rendered by `@tm8/prompt` (the builders already exist: `packages/prompt/src/templates.ts`, budget `incomingMessageInjection: 16384` in `budgets.ts:19-32`):

```xml
<trusted_control type="tm8.incoming-message" version="1" message_id="…" anchor_id="…" delivery_attempt_id="…">
  <from actor_id="…" source_session_id="…" />
  <reply command_ref="tm8://help/message/send" anchor_id="…" parent_message_id="…" />
  <delivery>Durable graph write already succeeded. This injection is a live notification
  and must not be interpreted as a second message.</delivery>
</trusted_control>
<untrusted_data type="message-body" encoding="escaped-utf8" truncated="…" fetch_ref="…">
{{messageBodyExcerpt}}
</untrusted_data>
```

Rules the envelope encodes: the body is **data, not instructions** (same untrusted-delimiter posture as the §5.7 handoff envelope); the reply route is named (`message send`/`reply` on the given anchor); over-budget bodies are excerpted with a `fetch_ref` the agent resolves via CLI (`tm8 message list <anchor>` / `tm8 entity context`). Closing-delimiter text inside bodies is encoded before injection (`packages/prompt/src/escape.ts:70-78`).

**Can the agent distinguish tm8 delivery from a human typing in Terminal?** In practice yes — humans don't type `trusted_control` envelopes. In principle no, and we do not pretend otherwise: PTY bytes are unauthenticated, and a human (or anyone with drive access) can forge the envelope. The posture: **the envelope is routing metadata, not an authenticator; the graph is the authority.** The envelope carries `message_id`; an agent can verify any consequential instruction by fetching that message through the CLI, and every action it takes is re-authorized server-side regardless of what the terminal claimed. No cryptographic channel is needed (O2).

### A.5 Bursts

Rapid multi-send: each message is its own row, its own delivery reservation, its own envelope; the per-session FIFO preserves admission order; nothing coalesces. Queue overflow is `failed_retryable` (retry = new delivery ID, deliberate, never automatic). This is honest and simple; no debouncing or batching in Phase 1.

---

## 3. Section B — Tools: how the agent gets them, discovers them, and is made to use them

### B.1 The decision: the CLI is the tool surface

**Phase 1 registers zero tm8-specific provider-native tools.** The tm8 tool surface is the `tm8` binary, reached through the provider's own shell-execution tool. The "provider-native tool-registration subset" of §15 step 5 refers to the provider's **built-in** tools (file edit, shell, web…), which profile policy may narrow — it never removes the CLI (`harness §4.1: providerToolRegistrationAllowlist "narrows provider-native registration only… the full tm8 CLI remains installed and its complete catalog remains exactly discoverable"`).

Why the CLI wins, concretely:

1. **One contract, three clients.** Browser, CLI, and agent all invoke the same catalog ops (Chat doc §10.7). The CLI is a generated projection of the catalog (`packages/cli/src/client.ts:1-8` — zero hand-written URLs, every path from `bindPath(<operationName>)`). Native registration would be a fourth client: 4 providers × ~80 ops of bespoke schemas that drift.
2. **No authority gain.** Every CLI call is re-authorized server-side per actor/entity/version; a native tool would be too. Native registration adds surface area, not capability.
3. **The discovery, versioning, and error machinery already exists for the CLI** (catalogDigest, help shards, frozen exit codes) and would have to be rebuilt per provider natively.
4. **Provider reality:** only Claude's injection flag is even wired today (B.4). All four providers can run a binary.

Native/MCP-style registration earns a place only when a provider gains a *proven* structured receiver seam (SCM §8.4 matrix — all four currently "unproven") — and that revisit is about **inbound** structure, not tool calls.

### B.2 How the agent learns the tools — the discovery ladder

Anti-bloat is a law (harness §9): no 81-op inventory ever enters the prompt. The layers:

| Layer | Vehicle | Budget | Content |
|---|---|---|---|
| L0 kernel | system prompt via `composePrompt` (`packages/prompt/src/kernel.ts:61-96`) | 6,144 B | identity/launch facts as identifiers; 3 discovery roots; rules ("Discover syntax with `tm8 help --format json`"; "Communicate durably with graph messages") |
| L0.5 manifest | file at `TM8_MANIFEST_PATH` (`packages/cli/src/manifest.ts:84-110`) | 4,096 B | server baseUrl + catalogDigest, credential env **name**, session/identity IDs, task IDs, discovery command arrays. Never: secrets, bodies, op lists, permission assertions (harness §5.1) |
| L1 root help | `tm8 help --format json` | 8 KiB | noun summaries + discovery methods |
| L2 noun shard | `tm8 help message --format json` | 12 KiB | that noun's verbs + op refs |
| L3 command shard | `tm8 help message send --format json` | 16 KiB | exact syntax, input/output schema refs, sideEffect, idempotency, versioning, ≤2 placeholder examples — **this is the "tool description"** |
| Intent | `tm8 help --query "reply to coordinator"` | 16 KiB | ≤5 ranked candidates; exact `--operation` lookup works for every op incl. internal (`execution.prompt` → `exposure:'internal'`, `use_message_send`) |
| Dynamic | `tm8 action list --for <entity>` · `tm8 entity context <id>` | 32 KiB ctx | "what may **this actor** do **here now**" — `allowed:true` only; bounded entity snapshot (`entities.context` is a shipped catalog op, `catalog.ts:155`) |

**Errors are discovery too.** Frozen exit codes (`packages/cli/src/exit.ts:24-67`: 0/2/3/4/5/6/7/8/9/10/11/130) and the retirement trap: `whoami`, `task report`, `session report`, `session prompt`, `progress` all fail with exit 2, name their replacement, and point at `tm8 help --query` — before any network call (`packages/cli/src/run.ts:110-136`, pinned in `test/verbs.test.ts:80-103`). A model that guesses a maestro-ism is taught the tm8 verb in one round trip.

### B.3 Credentials and the dual-audience boundary

Env contract at spawn (`packages/execution/src/spawn/manifest.ts:314-359`): mandated `TM8_SESSION_ID`, `TM8_MANIFEST_PATH`, `TM8_BASE_URL`; convenience `TM8_SPACE_ID`/`TM8_MODE`/`TM8_TEAM_MEMBER_ID`/`TM8_TASK_IDS`; provider API keys copied from server env only when set. Only env var **names** are recorded to the graph (`recordManifest`), never values.

**The gap that matters most (G3):** `TM8_AGENT_TOKEN` is a reserved seam — no token is minted today, so the CLI authenticates as the **loopback auto-owner** (`packages/cli/src/client.ts:61-68`; `execution-handlers.ts:402`). Consequence chain: agent messages attribute to the Owner; the server cannot derive the authoring work session; `authored_from` and `caused` provenance are impossible; "request bodies cannot claim another session" is unenforceable for agents. The fix is small because the identity service is already built: `issueSession({kind:'agent', actingAsTeamMemberId})` exists with a 7-day TTL and **requires** the persona scope (`packages/server/src/identity/service.ts:238-272`), and the client already sends `Authorization: Bearer` when the env var is set (`client.ts:212`). Spawn mints the token at step 4 and injects it. One wire-up unlocks persona authorship, provenance, and attribution enforcement simultaneously.

Dual-audience (§14.2) is respected by construction: the **launch manifest** (full resolved profile) stays server/execution-side; the **agent bootstrap manifest** is the bounded projection above; the **browser** gets only the presentation/feed/composer projection. Neither consumer sees the other's policy. Nothing in the agent manifest describes browser layout or viewer authorization, and nothing in the browser projection contains prompt/tool policy.

### B.4 How the tools reach each provider

One composer — `@tm8/prompt`, zero-dependency, imported by both `@tm8/execution` (spawn) and the CLI (`worker init` re-read), so the injected prompt and the re-readable prompt cannot drift (`packages/cli/src/prompt.ts` is a pure re-export). Injection point: `withAgentPrompt(command, systemPrompt, env)` (`packages/execution/src/spawn/manifest.ts:266-275`):

- **claude** (wired): `claude --append-system-prompt '<kernel>'`, then the task is submitted through the PTY closed loop; spawn writes `running` only after that first-turn settlement. Task/file identities ride the spawn assignment envelope, while bytes remain behind authenticated `tm8 file download`.
- **codex / gemini / hermes** (Slice 2, G10): command returned **unchanged** — deliberately un-approximated. Intended mechanisms recorded at `manifest.ts:259-265`: codex `-c developer_instructions=<json>`; gemini has no system-prompt flag so system+task concat into `--prompt`; hermes via env/`--query`.

Fallback for any provider: `tm8 worker init` prints the identical briefing from the manifest with zero network calls (`packages/cli/src/commands/worker-init.ts:30-56`) — but a provider that never received L0 doesn't know to run it, which is why Slice 2 matters for non-Claude.

### B.5 Making the agent actually use them

Four mechanisms, none of which assume compliance (the UI never does — Chat doc §15):

1. **Kernel rules** (frozen §5.2 prose): "Communicate durably with graph messages. Reply on the received anchor. A live delivery failure is not a failed durable send." Completion requires task-state commit + completion reply — "provider prose or process exit alone does not complete a task."
2. **The delivery envelope names the reply route** (`<reply command_ref="tm8://help/message/send" anchor_id parent_message_id>`) — every inbound message carries its own answer instructions.
3. **Reply-expectation and completion-check templates** (§14.5/§14.10, built in `templates.ts`) injected at assignment time.
4. **The retirement trap + intent search** convert wrong guesses into correct verbs in one step.

If the agent still answers only in provider prose, that answer is Terminal content — valid, visible, and never a bubble. That is the product working as designed, not a failure.

---

## 4. Section C — Outbound: what the agent runs → what appears in Chat

`session_chat_v1` membership terms mapped to the implemented predicate and the concrete producing action (`packages/server/src/facade/services/w2/feed-context.ts:99-154`):

| Term | Implemented predicate ($1 = ws id) | The action that produces it |
|---|---|---|
| `anchored` | message: `anchor_id=$1 AND root_message_id IS NULL` | anyone runs `tm8 message send --to <ws>` (or the browser composer) — a thread root **to** the session |
| `replies` | message: `anchor_id=$1 AND root_message_id IS NOT NULL` | reply to a message in scope: `messages.post` with `parentMessageId` (CLI verb `message reply` — G8; server derives the parent's single anchor) |
| `authored` | message ⋈ edge `authored_from` where dst=$1 | the agent runs `tm8 message send --to <any anchor>` **from inside the session with a session-scoped credential**; server writes the immutable `authored_from` edge. Currently always absent (G2+G3) — this is the term that makes "the agent's report on a task" show in session Chat |
| `subject` | activity: `entity_id=$1` | lifecycle mutations of the session entity itself (e.g. status transitions recording `work.changed`) |
| `caused` | activity: `work_session_id=$1` | the agent mutates **any** entity through tm8 while holding the session credential — `tm8 entity create/update`, `tm8 task transition/complete`, `tm8 edge create`, … |

Activity is the **closed 15-verb vocabulary**, enforced as a DB CHECK (`db/migrations/003_read_model.sql:35-38`): `created, updated, moved, deleted, restored, linked, unlinked, reacted, awarded, completed, joined, pulled, work.changed, pr.linked, unblocked`. `internal.record_activity()` is the only writer. Two consequences for Chat:

- **`message.created` writes no activity row by design** ("a thread is its own record") — a message appears exactly once, as a message item; delivery events decorate it as a facet, never as a second row (Chat doc §9.5).
- Artifact cards and state-change rows are just these verbs hydrated: `created` on a document → artifact card; `work.changed`/`completed` on a task → state-change row; `linked`/`unlinked` → collapsible mutation group keyed by `logicalOperationId` (messages carry `messageBatchId` as that key; activity rows currently carry null — feed-context.ts:586-591, part of C2/G1).

**Stated plainly, for the agent-facing docs:** *to put a bubble in Chat, run `tm8 message send` or `tm8 message reply`; to put a card in Chat, create or change a real entity through tm8; nothing you print in the terminal ever appears there.*

---

## 5. Section D — Readback: `entities.feed` scope `session_chat_v1`

Fully implemented in `W2FeedContextService` (`feed-context.ts`) — the browser, CLI (`tm8 entity feed <ws> --scope session_chat_v1`, exists: `packages/cli/src/entity.ts:705`), and any agent consume the same op:

- **Scope law:** named versioned scopes only, no caller predicates. `session_chat_v1 → ['anchored','authored','caused','replies']`; anchor kind guard: work_session only, else `invalid_input/feed_scope_not_applicable` (`:114-177`). `default` resolves work_session→session_chat_v1 and echoes the concrete name (C1).
- **Ordering:** total key `(created_at, item_id)` (uuidv7), newest/oldest; timestamps carried as microsecond text verbatim — a ms-truncated cursor would silently skip same-ms batch siblings (`feedPageSql :402`).
- **Dedup:** union-all of predicate branches grouped by `(item_kind, item_id)` with `array_agg(distinct via)` — one row per item, complete ordered `via[]` so the UI never re-derives membership (`feedCandidateSql :378`; Chat doc §8.3).
- **Cursors:** sha256 fingerprint over `{operation, entityId, scope, order, canonicalPredicates}`; reuse under any other fingerprint is rejected (`:200`).
- **`around`:** mutually exclusive with cursor; one bounded centered window with older/newer cursors; distinguishes `not_found` from `feed_item_not_in_scope` (C5; `:610-648`).
- **Hydration without N+1** (§16.2 satisfied): batch `MessageView`s, batch `ActivityItem`s, batch `DeliverySummary[]` embedded per message, batch `authored_from` map, batch anchor summaries. RLS-hidden rows are dropped, never placeholdered.

**Live updates (§16.1):** one WS at `/v2/ws` (`events.subscribe`), pushed by a per-connection 1 s durable poll pump (`packages/server/src/events/pump.ts:69-72` — poll-based by design, no LISTEN/NOTIFY). Relevant variants exist today: `message.created/updated/deleted`, `message.delivery_reserved/delivery_settled`, `message.attachments.updated`, `activity.created`; presence/typing ride a structurally separate ephemeral fan-out (`events/subscriptions.ts`). The Chat client consumes these through the feed-update abstraction: events trigger a targeted `entities.feed` refetch; any gap/reconnect/invalid-cursor → snapshot refresh from the feed. Truth is always the feed read; the WS is a hint. Fallback: `events.poll`.

---

## 6. Section E — Failure and honesty

- **At-most-once, with a real `unknown`.** Ledger transitions (`019:676-853`): `pending → dispatching → delivered | failed_retryable | failed_permanent | unknown`; `pending → expired | cancelled`. `failed_retryable` is the **only** retryable state and means proven zero bytes (queue refusal / no live terminal — `w2/execution.ts:533-545`). A thrown write settles `unknown` (`w2-message-delivery.ts:156-177`). Maintenance resolves stranded rows: `pending` > 15 min → `expired/pending_ttl_expired`; `dispatching` claimed > 15 min → `unknown/restart_during_dispatch`; redacted message / exited session → `cancelled`. Recovery **never reinjects bytes**.
- **Stored ≠ delivered, structurally.** Delivery lives in the execution-side ledger, not graph truth; the dispatch call is wrapped in an empty catch (`messages-handoffs.ts:351` — commented as law: "stored-first"). A failed/unknown/expired delivery leaves the bubble, its feed membership, and its reply structure untouched (Chat doc §8.2: delivery is deliberately absent from membership).
- **Degraded-honest mode:** without `TM8_DELIVERY_DATABASE_URL` no worker runs — messages store, deliveries sit `pending` and expire at TTL. Nothing lies; the badge shows exactly what happened (G7: surface this to operators at startup).
- **Non-delivery fan-out:** any non-delivered terminal settle triggers `w2_delivery_fallback` → deduplicated `session_delivery_failed` notifications to participant Teammates, their owners, the author, and the spawning owner; message bodies are never copied into the notification store (SCM §9.2).
- **Wake budget:** at most 4 consecutive Teammate-authored live reservations per unordered session pair; the 5th is `failed_permanent/automated_wake_limit` + inbox fallback + zero bytes. A Member reply with unambiguous pair provenance resets it. Chat shows the reason string on the failed badge — no new UI state (O6).
- **Compliance honesty:** `delivered` means the governed transport write completed — the tooltip says so; the model may ignore it, and its prose answer stays in Terminal. No retry affordance exists; **Send again** creates a new message with a new identity (C8).

---

## 7. One complete round trip

Cast: Member **M** in the browser; agent session **ws_A** (Claude, live); task **tsk_1**.

1. M types "How far along are the tests?" in ws_A's Chat composer, hits Enter.
2. Browser: `messages.post {clientMutationId: m1, anchorIds:[ws_A], body}`. Optimistic row "Saving…" keyed m1.
3. Server: `w2_post_message_batch` commits message row `msg_1` (anchor ws_A, thread root) + `message.created` event, emits deliveryIntent. **Bubble is durable** — feed membership `via:['anchored']`.
4. Facade post-commit: `reserve` → ledger row `pending` (ws_A live, budget untouched — Member-authored). Event `message.delivery_reserved`. Badge: *Stored · waiting to send*.
5. Delivery worker: mint principal → `claim` (`dispatching`) → `promptInternal` → `pty.deliverPrompt(ws_A, envelope, 'send')` → FIFO → `proc.write(envelope)`, 200 ms, `proc.write('\r')`.
6. `settle('delivered')` → event `message.delivery_settled`. Badge: *Delivered to session transport* (tooltip: transport ≠ read).
7. In ws_A's PTY, Claude sees the §14.4 envelope: trusted control (message_id `msg_1`, from M, reply route, "this is a live notification, not a second message") + the question as escaped untrusted data. The same bytes are visible to any human watching Terminal.
8. Claude runs `tm8 message reply msg_1 --body "12/14 suites green; two flaky timers left."` (until G8 lands: `tm8 message send --to ws_A …`). CLI → `messages.post` with `parentMessageId: msg_1`; server derives the parent's anchor (ws_A), authors as the persona (post-G3), writes `authored_from → ws_A` (post-G2). Self-wake suppression: no delivery back into ws_A.
9. `message.created` event → browser's feed-update abstraction refetches → reply bubble renders: *From this session*, `via:['replies','authored']`, parent preview to msg_1. M's inbox also gets `message_reply`.
10. Claude then runs `tm8 task transition tsk_1 in_review --expect-version 7` → activity `work.changed` with `work_session_id: ws_A` → next refetch shows a state-change row, `via:['caused']`, before/after from the typed summary.
11. Any later reader — browser, `tm8 entity feed ws_A --scope session_chat_v1`, or another agent — reconstructs the identical conversation from the one store, in `(createdAt, uuidv7)` order, with delivery facets embedded.

Failure branches at each seam: step 4 dead session → `failed_permanent/session_not_live` + fallback notifications, bubble stays; step 5 crash after write → maintenance settles `unknown`, badge warns, **no reinjection**; step 8 never happens (agent ignores it) → answer exists only in Terminal, Chat shows the delivered question and nothing else — by design.

---

## 8. Gap register

Everything required by this design that does not exist in the tree today. Severity: ⛔ blocks the core loop · ▲ degrades it · ○ polish.

| # | Layer | Gap | Fact basis | Sev |
|---|---|---|---|---|
| G2 | server | `authored_from` provenance never written on the post path: `resolveAuthoredFromWorkSessionId` is a declared, unwired seam — `sourceWorkSessionId` always null | `messages-handoffs.ts:304-363`; facade/index.ts wires only `messageDelivery` | ⛔ |
| G3 | server+execution | No agent session credential: spawn mints no token, injects no `TM8_AGENT_TOKEN`; agents act as loopback Owner. `issueSession({kind:'agent', actingAsTeamMemberId})` already implemented (7 d TTL, persona-scoped mandatory) | `identity/service.ts:238-272`; `client.ts:61-68,212`; `manifest.ts:314-359` | ⛔ |
| G4 | server+prompt | Delivery content is the raw body, not the §14.4 envelope; templates + 16 KiB budget exist unwired in `@tm8/prompt` | `019:462-464`; `templates.ts`; `budgets.ts:19-32` | ⛔ |
| G6 | server | `record_activity` population of `work_session_id` from agent claims — verify and wire once G3 lands (the `caused` term depends on it) | `003_read_model.sql`; feed `caused` predicate | ⛔ (with G3) |
| G8 | CLI | `tm8 message reply` verb missing — exists only as prose in the ops projection; typed today → exit 2. Contract already accepts `parentMessageId` | `cli/src/message.ts:548-562`; `operations.ts:546-551` | ▲ |
| G5 | server | `session_chat_v1.replies` implemented as same-anchor replies only; C3 requires the transitive descendant closure seeded by anchored **and authored** messages (moot until G2) | `feed-context.ts:132-154` vs Chat doc C3 | ▲ |
| G10 | execution | Non-Claude prompt injection unimplemented — codex/gemini/hermes commands returned unchanged; those agents boot without the kernel | `manifest.ts:259-275` | ▲ (N/A for Claude-only) |
| G9 | CLI | Help shards / intent search (`tm8 help <noun> --format json`, `--query`) referenced by kernel + retired-command hints; grammar projection exists (`discovery/operations.ts`) but the shard/query commands need verification/completion | `run.ts:108`; harness §7.2-7.4 | ▲ |
| G12 | server | `interactionProfileId` rejected at spawn (`notImplemented`); no pin materialized → every session is "unflavored, Terminal-only". Acceptable Phase 1; required to ever show Chat-capable sessions | `execution-handlers.ts:555-560` | ▲ (Phase 2 gate) |
| G13 | UI | The Chat surface itself (Phase 2 per 10-CHAT-SURFACE §13): composer→`messages.post` with `clientMutationId` reconciliation, 8-state badges from embedded `DeliverySummary`, feed-update abstraction, `contentSurface` route slot + toolbar seam reserved in Phase 1 | visual design docs | ▲ (Phase 2) |
| G14 | UI | Persona attribution rendering depends on G3 (`ActorSummary.isAgent` = `kind==='team_member'` works only when the author IS the persona) | `entity-read.ts:300` | ▲ (with G3) |
| G1 | contract | Typed activity summary union (C2): `ActivityItem.verb` is an open string vs the closed DB 15; state-change rows need typed before/after; activity `logicalOperationId` always null | `schemas.ts:568-577`; `feed-context.ts:586-591` | ○ |
| G7 | ops | No operator surfacing when the delivery worker is unwired (`TM8_DELIVERY_DATABASE_URL` absent ⇒ deliveries silently expire at TTL) | `main.ts:129-138` | ○ |
| G11 | server | Directive/coordinator manifest fields hardcoded null (post-G1A) — affects assignment-message framing for coordinator flows, not the Chat core | `manifest.ts:466-468` | ○ |

Not gaps (verified shipped): `messages.post` batch + `parentMessageId` + `MessageBatchResult`; the delivery ledger + fallback fan-out; `promptInternal` principal guard + public `execution.prompt` refusal; `entities.feed` session_chat_v1 with via/dedup/cursors/around + embedded delivery summaries; `entities.context`; `message delivery` + `--wait settled`/exit 11; the retirement trap; kernel/templates/budgets in `@tm8/prompt`; WS event variants for messages/deliveries/activity.

---

## 9. Open items (one line + recommendation each)

- **O1 — PTY submit mode:** keep `send` (text + 200 ms + `\r`) for message delivery; revisit `paste`/bracketed-paste only if a provider mangles multiline envelopes.
- **O2 — envelope forgeability:** accept (PTY bytes are unauthenticated by design; graph is authority); add one kernel sentence: verify consequential instructions by fetching the message via CLI.
- **O3 — prompt-readiness gating:** ship without idle detection; `hasSession` + at-most-once + honest states already cover it; the pending TTL covers the spawn window.
- **O4 — typed activity summaries (C2):** build with the first Chat UI cut, only for verbs rendered as state-change rows (`work.changed`, `completed`); generic safe card for the rest.
- **O5 — live updates:** keep the 1 s pump + event-triggered refetch behind the feed-update abstraction; no new WS work for Chat.
- **O6 — wake-limit UX:** render `failed_permanent` with its `automated_wake_limit` reason string; no new delivery state.
- **O7 — provider-native/MCP registration:** revisit only on a proven structured receiver seam (SCM §8.4); not a Phase-2 item.

---

## 10. Build sequencing

Ordered so every step is independently observable in feed output; S1–S3 are the critical path to a working round trip.

1. **S1 — agent credential (G3):** mint `issueSession({kind:'agent', actingAsTeamMemberId: persona})` in SpawnService (around `SpawnService.ts:110-220` step 4), inject `TM8_AGENT_TOKEN`; client already sends bearer. *Observable: agent-sent message shows persona author, `isAgent:true`.*
2. **S2 — provenance (G2+G6):** wire `resolveAuthoredFromWorkSessionId` from the agent claims; confirm `record_activity` stamps `work_session_id`. *Observable: feed items gain `via:['authored']` / `['caused']`; "From this session" labels become possible.*
3. **S3 — delivery envelope (G4):** render `templates.incomingMessage` into the delivery intent (service-side, at intent composition — keep the RPC body-agnostic), enforce the 16 KiB budget with excerpt + `fetch_ref`. *Observable: agent terminal shows the trusted/untrusted envelope; conformance fixture asserts byte-exact template (the G3-style assertion belongs on PTY output, not graph state).*
4. **S4 — `tm8 message reply` (G8) + help-shard verification (G9).** *Observable: reply threading via CLI; `tm8 help message send --format json` returns the L3 shard.*
5. **S5 — replies closure (G5):** upgrade the predicate to the C3 transitive closure seeded by anchored+authored (root-index prefilter, exact parent-chain verify). Scope name unchanged — C3 defines `session_chat_v1` as the closure; today's predicate is the incomplete implementation, not a different scope.
6. **S6 — Chat UI Phase 2 (G13/G14)** on the then-complete read/write contracts; Phase 1 reserves only the toolbar row and `contentSurface` route slot.
7. **S7 — Slice-2 provider injection (G10)** — independent lane, any time.

---

## 11. Source map

`CHAT-UI-AND-LAYOUT-DESIGN.md` (canonical UI; C1–C9) · `~/Desktop/tm8-ui-design/10-CHAT-SURFACE.md` (visual) · `SESSION-COMMUNICATION-MODEL.md` rev 5 (message/delivery model) · `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` v2.11 (RULING M, §5.7, R6-1/R7-2/R8-4/R8-5) · `AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` (manifest/kernel/discovery/§14 templates) · `CLI-GRAMMAR-REDESIGN.md` (grammar, output, exit codes) · working tree: `packages/{contract,server,execution,prompt,cli}`, `db/migrations/{003,019,030}`.
