# tm8 Chat UI and Workspace Layout Design

**Status:** Canonical feature design; cross-layer UI closure GO; design-only; no implementation is authorized by this document

**Date:** 2026-07-26

**Scope:** Phase 1 CLI-first Chat for Claude and Codex work sessions

**Owners:** Workspace UI, Server/API, CLI, and agent harness

This document defines the canonical tm8 Chat experience for a work session. It consumes, rather than replaces, the Workspace, entity graph, message, delivery, CLI, and harness contracts.

The governing product decision is simple:

> Terminal and Chat are two peer surfaces inside a work session's Content region. Terminal remains the complete native interactive PTY. Chat is an optional graph-backed surface populated only by explicit tm8 messages and activity. A switch shows one surface at a time; there is no split view.

If another document calls Terminal a Runtime view, a log view, a fallback, or a surface replaced by Chat, this document supersedes that wording for this feature.

---

## 1. Binding decisions

The following decisions are closed for Phase 1.

1. **Terminal remains first-class.** Claude and Codex continue to run as normal native interactive PTY processes. Terminal input, output, warnings, progress, provider prose, tool calls, and control sequences remain visible there.
2. **Chat is a peer, not a replacement.** A work session may expose Terminal and Chat behind a local switch in its Content region. Only one is visible at a time. Terminal can never be removed, permissioned away by an Interaction Profile, or described as a fallback.
3. **Capture is explicit-only.** A Chat message exists only when a participant explicitly creates a graph message through tm8. PTY bytes, provider logs, inferred turns, and assistant-looking terminal text never become Chat bubbles.
4. **The integration is CLI-first.** Phase 1 does not depend on provider JSON, provider hooks, SDK event streams, app-server events, or terminal-text classification.
5. **Questions and structured interactions are deferred.** Phase 1 has ordinary messages, replies, files, activity cards, and delivery state. It does not introduce a question entity or question lifecycle.
6. **Templates are static registry entries.** There is no `ui_template` entity, UI-template API family, UI-template CLI noun, agent-authored renderer, or dynamic code execution.
7. **Interaction Profiles are pinned.** A reusable `interaction_profile` selects a static template key/version and the relevant harness, feed, capture, and composer policy. The immutable `work_session_interaction_pins` row is runtime authority.
8. **Graph state is canonical Chat state.** Messages and activity are read through `entities.feed`; delivery is a facet of a stored message. Chat has no second message table, session inbox, reporting channel, or client-side reconstruction from raw event rows.
9. **Delivery never decides feed membership.** A failed or unknown delivery remains visible. The UI must not present a stored message as received merely because a bubble exists.
10. **Authorization is independent of presentation.** Profiles and static templates may narrow or order visible actions. They never grant an action. Every invocation is authorized again by the Server for the viewing actor.
11. **Workspace RULING D stands.** Terminal remains the `work_session` Content renderer. This design is an additive two-mode amendment inside that renderer: Terminal is the existing mode and Chat is the peer mode.

---

## 2. Contract status and authority

This is a forward design spanning contracts that are not all implemented today. UI work must preserve these status boundaries.

| Area | Phase-1 authority | Current status relevant to this design |
|---|---|---|
| Workspace shell, panel stack, pinned panels, entity tabs, TerminalPool | `WORKSPACE-LAYOUT-AND-TERMINOLOGY.md` | Contracted/final design |
| Universal entity graph and relation laws | `DOMAIN-ARCHITECTURE-DECISIONS.md` | Contracted design |
| Session messages, delivery, notifications, provenance | `SESSION-COMMUNICATION-MODEL.md` | Design revision; not fully shipped |
| Noun-first CLI and delivery facade | `CLI-GRAMMAR-REDESIGN.md` | Design revision; shipping CLI is still the small legacy surface |
| Spawn, command discovery, credentials, provider launch | `AGENT-HARNESS-AND-COMMAND-DISCOVERY.md` | Design revision; implementation varies by part |
| Audited backend reality and Chat amendments | `BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md` | Implementation-audited briefing plus recommendations |

This document is canonical for the UI composition and interaction rules. It does not silently promote proposed API, CLI, or database work to “implemented.” Section 21 records the resolved rulings and remaining implementation dependencies.

---

## 3. Mental model

The three layers must remain separate:

| Layer | Purpose | Canonical data |
|---|---|---|
| Terminal | Native interactive provider session | PTY byte stream and terminal transport state |
| Chat | Human-readable session-associated conversation and meaningful graph activity | `entities.feed` plus message delivery facets |
| Entity detail | Canonical state and direct history of one graph entity | Entity Content, Discussion, Connections, and Activity tabs |

Terminal output is not a less structured version of Chat. Chat is not a cleaned transcript of Terminal. They may describe overlapping work, but only an explicit graph mutation connects work to Chat.

The practical Phase-1 consequence is intentional:

- If an agent answers only in Claude or Codex, the answer appears in Terminal only.
- If the agent runs `tm8 message send` or `tm8 message reply`, the stored graph message appears in Chat.
- If the agent creates or changes a meaningful entity through tm8, the resulting attributable activity may appear as a Chat card.
- Streaming or reopening session logs may restore Terminal output, but never manufactures graph messages.

---

## 4. Workspace integration

### 4.1 Existing Workspace structure remains intact

The feature uses the existing layout:

```text
┌──────────────────┬────────────────────────────────────────┬──────────────────┐
│ Left entity list │ Workspace center                       │ Right entity list│
│                  │ stack top + optionally pinned panels   │                  │
└──────────────────┴────────────────────────────────────────┴──────────────────┘
                         live-session bar
```

Opening a work session still pushes an `EntityDetailPanel` onto the center stack. Pinning a panel, opening several session panels side by side, popping with Escape, and restoring a shared route all continue to use the existing Workspace machinery.

### 4.2 Work-session EntityDetail anatomy

The generic entity header and outer tabs stay unchanged:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Work-session entity header                         actions / status │
├──────────────────────────────────────────────────────────────────────┤
│ Content | Discussion | Connections | Activity                       │
├──────────────────────────────────────────────────────────────────────┤
│ Content toolbar:                         [ Terminal | Chat ]         │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                    active peer surface                               │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

The Terminal/Chat switch exists only inside the **Content** tab of a `work_session`. It does not replace the outer entity tabs.

### 4.3 Chat, Discussion, and Activity are not synonyms

| Surface | Membership | Primary use |
|---|---|---|
| Chat | Named session scope `session_chat_v1`: direct session records plus messages authored from the session, their replies, and session-caused activity | Follow the session's conversation and outputs across graph anchors |
| Discussion | Messages directly anchored to this work-session entity | Discuss the work-session entity itself using the universal entity Discussion tab |
| Activity | Activity directly about this work-session entity | Inspect the entity's direct mutation history |

The same physical message or activity may qualify for Chat and one of the generic tabs. This is a projection overlap, not duplicate storage. Chat cards link to the canonical entity anchor, Discussion thread, Activity record, document, file, or task.

### 4.4 No simultaneous split

Within one work-session panel, Terminal and Chat never render side by side. Existing Workspace pinning may still place two different panels side by side, and each pinned session panel independently remembers its selected surface.

### 4.5 Session drop targets and handoffs

Dropping an entity onto a live work-session panel remains the established share/handoff operation. The drop target belongs to the session panel, not to the selected surface, so it works over either Terminal or Chat and over the shared Content toolbar.

Dropping a file specifically onto the Chat composer attaches that file to the draft message. Dropping another graph entity onto the panel starts the handoff flow; it must not be silently converted into a message attachment.

Handoff execution state and message delivery state remain separate axes. A handoff card may link the correlated message and artifact, but it must not collapse their states into one badge.

---

## 5. Terminal/Chat switch

### 5.1 Availability

- **Terminal is always present** for a work session the viewer is authorized to open.
- **Chat is present** when the session's pinned Interaction Profile resolves to a supported safe browser projection.
- When a pin declares Chat but its template key/version cannot be resolved, Chat remains visible with an error indicator so the failure is not hidden. The initial selected surface is Terminal.
- A session with no Chat-capable profile shows Terminal only. This is an unflavored session, not a degraded Chat session.
- A profile cannot hide, disable, rename, or reorder Terminal behind a privileged action.

### 5.2 Initial selection

For a Chat-capable session, selection resolves in this order:

1. An explicit valid surface in a shared/deep link.
2. The viewing member's saved preference for this work session.
3. The pinned profile's initial surface preference.
4. Terminal.

An unavailable or invalid Chat selection resolves to Terminal and exposes the Chat configuration error. A profile sets only the first-open default; it never overrides a later viewer choice.

### 5.3 Route and preference behavior

The outer entity tab remains encoded by the existing per-panel tab state. The Content surface is a nested per-panel value, `terminal` or `chat`, and must round-trip with the panel stack and pin state.

Switching surfaces updates the current panel state without creating a new entity-stack entry. It should replace the current browser history entry rather than making the Back button walk through every Terminal/Chat toggle. Shared links may intentionally encode the active surface.

The persisted preference is viewer-local and session-local. It is not written into the work-session entity, Interaction Profile, or immutable pin.

### 5.4 Inactive-surface behavior

Switching to Chat must not restart, detach, resize to zero irrecoverably, or lose output from the PTY process. The TerminalPool keeps the same terminal instance, transport offset, and logical session lease. Its DOM host may move to the retained parking container through the existing tokened single-host lease mechanism, but the lease/entry remains protected from eviction for the visible session panel. Returning to Terminal reparents the same instance, fits it, restores its output position, and focuses it only when the navigation action expects focus.

Chat state likewise remains mounted logically: draft, scroll anchor, loaded pages, focused item, and reply target survive a switch to Terminal.

### 5.5 Activity indicators

When inactive:

- Terminal may show a neutral **Terminal activity** dot when new PTY bytes arrive. The dot never says “message,” “reply,” or “agent answered.”
- Phase-1 Chat may show only client-local **new since opened** state. It must not show a durable unread badge or derive an authoritative count from anchor-scoped read marks. A future composite read mark must be keyed by viewer, session, and scope version with a monotonic through-key.

---

## 6. Terminal surface

Terminal is the normal provider surface, not a diagnostic view.

It contains:

- the existing terminal chrome and connection state;
- the stable xterm instance owned by TerminalPool;
- direct native keyboard input to Claude or Codex;
- resize, reconnect, exit, attached/detached, and transcript behavior already defined for work sessions.

It does **not** contain a second raw-PTY prompt bar that claims to create a durable Chat message. The v2.10 §5.2b deliver-first-then-record Composer clause is formally superseded by this amendment. Phase 1 has two honest input paths:

1. Typing in Terminal writes native PTY input and creates no graph message by implication.
2. Sending in Chat persists a graph message through the message facade and then exposes delivery to the live session.

Terminal uses native PTY input; Chat alone owns the stored-first message composer. A prompt surface that visually resembles Chat but writes PTY first would violate the delivery contract.

When a session exits, Terminal preserves its transcript and becomes non-interactive according to existing terminal rules. Chat remains readable.

---

## 7. Chat surface layout

### 7.1 Anatomy

```text
┌──────────────────────────────────────────────────────────────────────┐
│ [ Terminal | Chat ]             teammate · provider · session state │
├──────────────────────────────────────────────────────────────────────┤
│ context / connectivity / profile notice, only when needed           │
├──────────────────────────────────────────────────────────────────────┤
│ Load earlier                                                        │
│                                                                      │
│  message bubble                       provenance · delivery badge    │
│  artifact card                        canonical anchor              │
│  compact activity group               expand                       │
│  reply bubble                          parent context               │
│                                                                      │
│ new-items marker                                                     │
├──────────────────────────────────────────────────────────────────────┤
│ reply context / attachments                                          │
│ Message the session…                                                 │
│ composer actions                                      Send           │
└──────────────────────────────────────────────────────────────────────┘
```

The Chat header does not duplicate the outer entity header. It may repeat only fast-changing session context useful while composing: teammate, provider, live/exited state, and delivery availability.

### 7.2 Scroll behavior

- The initial page is fetched newest-first so the latest conversation is immediately available, then rendered in chronological order.
- Older pages prepend above the current viewport while preserving the visible scroll anchor.
- New items append at the bottom. If the viewer is near the bottom, the view follows them. Otherwise a “New items” control appears without moving the viewport.
- Exhaustion is determined only by `nextCursor: null`; pages may contain fewer than the requested limit because authorization filtering happens inside the query.
- The list is virtualized, but focusable items must not disappear while they own keyboard or screen-reader focus.

### 7.3 Chat has no terminal transcript mode

There is no “show terminal messages in Chat,” “best-effort assistant bubble,” or byte-pattern inference toggle. The empty state may explain that native provider output remains in Terminal, but Chat never offers to import it.

---

## 8. Feed contract and membership

### 8.1 Read operation

Chat reads the universal entity feed for the work-session entity using the versioned named scope `session_chat_v1`.

This is a read projection over the same message and activity stores used by Discussion and Activity. It is not a second feed table, client-owned read authority, or session transcript store.

The required request semantics are:

| Input | Phase-1 Chat value |
|---|---|
| Entity | Current work-session entity ID |
| Scope | `session_chat_v1` |
| Initial order | Newest first for tail loading |
| Cursor | Opaque and bound to entity, resolved predicates, order, and filters |
| Focus | Optional `around=message:{id}|activity:{id}` for one authorized bounded centered window; mutually exclusive with cursor |

The named scope resolves to the closed membership terms below. Adding or changing a predicate requires a new scope version; clients must not silently reinterpret an existing name.

### 8.2 `session_chat_v1` terms

| Term | Meaning |
|---|---|
| `subject` | Activity whose subject entity is this work session |
| `anchored` | Message directly anchored to this work session |
| `authored` | Message durably attributed as authored from this work session |
| `replies` | Transitive descendant closure over the immutable message parent graph, seeded by anchored/authored messages; one-hop semantics require a different scope name |
| `caused` | Activity whose trusted `work_session_id` is this work session |

Delivery is deliberately absent from this list. A reply or outbound message does not vanish merely because delivery failed, expired, was cancelled, or is unknown.

### 8.3 Ordering, deduplication, and provenance

- Server ordering is the total key `(createdAt, uuidv7Id)` across message and activity records.
- Server deduplication happens before pagination using the physical identity `(itemKind, itemId)`.
- Every item returns its complete, deterministically ordered `via` term set. The UI never re-derives why the item is present.
- Cursors are rejected when reused with another entity, scope, predicate resolution, order, or filter fingerprint.
- Messages remain in the feed as tombstones after redaction so membership and reply structure do not change retroactively.
- Authorization and row visibility are applied per record before the page is formed. No hidden anchor title, count, or total may leak.

### 8.4 Feed item requirements

The UI requires a discriminated message/activity item with enough typed information to render without hard-coded parsing of an untyped summary bag. Activity is a discriminated union over the closed 15-verb activity vocabulary, not an open-ended mapping.

Each item needs, as applicable:

- physical kind and ID;
- creation time and stable sort ID;
- complete `via` terms;
- actor and trusted work-session provenance;
- canonical anchor/entity reference the viewer may open;
- a typed message or typed activity payload;
- redaction/tombstone state;
- delivery facets visible to the viewer;
- a stable logical-operation key such as `clientMutationId` when several activity rows came from one operation.

An unknown item variant is rendered as a safe generic event with timestamp, actor, and open-details action. It is never silently dropped because a pinned static template is older than the feed variant.

---

## 9. Presentation model

### 9.1 Message items

Messages are the conversational backbone and always render as message rows or bubbles. Direction is explained with text and provenance, not color or left/right placement alone.

Useful labels include:

- **To this session** for a message anchored/delivered to the session;
- **From this session** for a message carrying trusted `authored_from` provenance;
- **Reply in _Task name_** when the canonical anchor is another entity;
- **Also related through…** when `via` contains multiple terms.

The row shows author, teammate/session provenance where applicable, creation time, edited/redacted state, reply context, attachments, canonical anchor, and delivery facets. Message content remains selectable and copyable.

### 9.2 Artifact cards

Meaningful created or materially changed artifacts render as compact cards rather than fake chat prose. A card includes:

- artifact kind, icon, title, and safe summary;
- creating actor and producing work session;
- canonical anchor or parent context;
- timestamp;
- actions returned by the authorized action-discovery contract.

Opening a card pushes or focuses the canonical entity detail panel. Chat does not embed a parallel document editor or file authority.

### 9.3 State-change rows

Task state, session state, and other meaningful lifecycle transitions render as compact timeline rows. The before/after values must come from a typed activity summary. UI copy must not be synthesized by parsing arbitrary property bags.

### 9.4 Low-level mutation groups

Relationship edits, counter changes, metadata touches, and other low-value rows are collapsed when they share a stable logical-operation key. The collapsed row says what changed and how many attributable records it contains, with an accessible expand control.

Grouping must never be based solely on timestamps. If the feed does not expose a logical-operation key, the UI renders separate honest rows until the contract is added.

### 9.5 Delivery is a facet, not a feed row

Delivery state belongs on the related stored message. It is not another Chat message and does not determine whether the message is present. A delivery activity may appear in generic audit surfaces, but Chat must deduplicate it from the message's status presentation.

### 9.6 Static template behavior

A template may choose approved layout blocks, density, labels, icon tokens, activity grouping, and composer widgets. It may not:

- execute code, raw HTML, arbitrary CSS, expressions, URLs, or network requests;
- hide evidence solely because it does not recognize a feed variant;
- invent new feed predicates or message semantics;
- grant an operation;
- alter Terminal behavior;
- turn PTY output into Chat content.

---

## 10. Composer and message lifecycle

### 10.1 Composer modes

Phase 1 has two modes:

1. **New message to session.** The current work session is the default anchor/delivery target.
2. **Reply.** The composer displays the selected parent message and uses the message reply facade. Cancel returns to new-message mode without losing unrelated draft text.

Structured questions, answer forms, expirations, and interaction entities are explicitly out of scope.

### 10.2 Supported content

- Plain or supported rich message text.
- Mentions permitted by message policy.
- File attachments represented by canonical file entities/relations.
- A visible Send button.

General graph entities are shared through the handoff flow, linked in text, or opened canonically; they are not mislabeled as file attachments.

### 10.3 Drafts

Drafts are viewer-local and keyed by member plus work session. They survive surface switches, outer-tab changes, panel pinning, and transient reconnects. A draft is not a graph entity and is not visible to the teammate until Send succeeds at the storage boundary.

### 10.4 Send states must remain separate

The UI distinguishes four layers:

| Layer | Meaning | UI treatment |
|---|---|---|
| Draft | Local unsent text/files | Editable composer state |
| Mutation pending | The client does not yet know whether graph storage committed | Optimistic row marked “Saving…” and reconciled by `clientMutationId` |
| Stored | The graph message exists durably | Normal message row; delivery may still be pending |
| Delivered or not | The persisted message's live delivery outcome | Delivery badge/facet on the stored row |

An unknown mutation result is checked using the same idempotency identity before the UI offers another submission. A failed live delivery never turns a stored bubble back into a failed optimistic draft.

### 10.5 Keyboard and focus

The default composer behavior matches the existing Chat convention: Enter sends, Shift+Enter inserts a newline, and the visible Send button remains fully operable. A platform command shortcut may also send. Static profile policy may choose a safer newline-first mode, but the current behavior must be announced in the input help text.

After a successful send, focus remains in the composer. Validation errors focus or describe the first invalid field. A reply cancellation returns focus to the composer. Attachments have keyboard-removable chips with descriptive labels.

### 10.6 Session exit behavior

When a work session has exited, Chat remains readable. If graph permissions still allow messaging, the composer may remain enabled with a clear notice that the message will be stored but cannot be delivered live to the exited PTY. The UI never promises wake or delivery merely because Send is available.

### 10.7 CLI/API operation mapping

The browser uses the catalog operation behind each CLI command; the CLI names below define the same semantics for agents and humans.

| UI intent | Canonical operation/CLI surface |
|---|---|
| Load Chat | Universal `entities.feed` / `tm8 entity feed` with `session_chat_v1` |
| Send a new message | Message send facade / `tm8 message send --to <work-session>` |
| Reply | Message reply facade / `tm8 message reply <message-id>` |
| Refresh or expand delivery | Message delivery facade / `tm8 message delivery <message-id>` |

The browser does not shell out and scrape CLI text. Browser, CLI, and agent tools are separate clients of the same catalog operations and validation rules.

---

## 11. Delivery presentation

### 11.1 Source of truth

The UI reads the message delivery facade or delivery facet returned with the feed. It never infers delivery from:

- a Chat bubble existing;
- CLI process exit code;
- terminal output;
- session liveness alone;
- a notification being emitted.

The corrected CLI exit-code rule—exit 11 only for incomplete `--wait settled`—remains useful to CLI callers, but it is not the browser's delivery model.

### 11.2 States and labels

| Server state | User-facing label | Required treatment |
|---|---|---|
| `pending` | Stored · waiting to send | Neutral; bubble is durable but not delivered |
| `dispatching` | Sending to session | Progress indicator without claiming receipt |
| `delivered` | Delivered to session transport | Success; tooltip explains this means governed PTY write completed, not that the model read or obeyed it |
| `failed_retryable` | Delivery failed · can send again | Error; durable bubble remains; no automatic retry |
| `failed_permanent` | Delivery failed | Error with details/support action where authorized |
| `unknown` | Delivery unknown | Warning; never styled as success |
| `expired` | Delivery expired | Muted terminal state; durable message remains |
| `cancelled` | Delivery cancelled | Muted terminal state; durable message remains |

For multi-target messages, the UI shows a summary plus an expandable per-target list. Membership and message content are shared; delivery state is target-specific.

### 11.3 Retry language

The browser must not label a persisted delivery failure as “Retry sending” unless a public idempotent delivery-retry operation exists. Until that contract is defined, the safe action is **Send again**, which creates a deliberate new send with a new identity and explains that the original stored message remains.

No background loop retries a delivery whose state means any bytes may have been written.

---

## 12. Replies and conversation context

- A reply is a message with an immutable parent reference; it is not a second interaction kind.
- The bubble shows a compact parent preview and canonical anchor. Selecting it focuses the parent when the parent is already loaded or uses the feed-focus contract when it is not.
- Reply notification preference such as inbox versus live wake is a default choice, not permission. The Server decides whether a wake is permitted.
- Failed delivery does not remove either a parent or reply from Chat.
- Redacted parents remain tombstones so replies retain understandable structure.
- Chat may visually indent one level for context, but it should not render an unbounded tree in a narrow panel. Deeper structure is conveyed by parent previews and a focused thread view.

The `session_chat_v1.replies` predicate is the Server-computed transitive descendant closure seeded by anchored/authored messages. An implementation may use indexed shared `root_message_id` as a candidate pre-filter, but root matching is broader and never replaces the exact immutable parent-chain check. A one-hop or root-wide interpretation requires another named scope. The UI never repairs or extends membership by recursively merging message pages client-side. Rendering remains visually bounded to parent previews/one-level indentation even though membership is transitive.

---

## 13. Inbox integration

Chat consumes the existing notification system; it does not create a session-specific inbox.

### 13.1 Audience separation

- A member's personal inbox shows notifications owned by that member.
- A teammate inbox has independent recipient and read state.
- Teammate rows do not silently appear in the personal inbox. An owner/admin inspection mode must be explicit and authorized.

### 13.2 Relevant notification types

- `message_reply`
- `session_delivery_failed`

Notifications reference the canonical message, anchor, session, or delivery. They do not copy message bodies into a parallel store.

### 13.3 Open behavior

- A session delivery failure opens the owning work-session panel, selects Content → Chat, and requests an authorized bounded window using `around=<itemKind>:<itemId>`, with cursors in both directions. It then focuses the message and exposes delivery details.
- A reply opens the relevant session Chat when session membership is known and `entities.feed --around` can return the authorized bounded window; otherwise it opens the canonical anchor Discussion context.
- If the targeted record is no longer visible, the notification opens a non-leaking unavailable state rather than searching unrelated records.

Mark-all, per-row read state, personal/teammate audience context, loading, empty, and failure behavior stay within the universal inbox contract.

---

## 14. Interaction Profiles and static templates

### 14.1 Resolution and authority

Profile resolution at spawn is:

1. Explicit spawn override from an authorized human principal.
2. Teammate `defaults_to_profile` relation.
3. Space default.
4. Core profile.

The Server validates and pins the full resolved snapshot. The immutable `work_session_interaction_pins` row is sole runtime authority. A Server-materialized immutable `selected_profile` edge supports discovery and provenance; disagreement is repaired from the pin row.

Later edits to a profile never change a running or historical session.

### 14.2 Dual-audience projection

The resolved profile contains policies for different trust audiences. They must be projected separately.

| Consumer | Receives | Must not receive |
|---|---|---|
| Agent launch manifest | Prompt policy, tool-discovery preference, provider/harness policy, trusted session context | Browser layout internals and viewer authorization results |
| Browser | Static template key/version, safe feed configuration, safe composer configuration, initial surface preference | System prompt, hidden tool policy, provider secrets, harness credentials |

Tool preference is strictly intersective: effective tools equal independently authorized tools intersected with profile preference. Profile fields never enter authorization truth or `actions.list` computation.

### 14.3 Static registry failure

A binary or Server upgrade can lose a pinned static template version. The UI must:

1. Preserve and display the failed pinned key/version in safe diagnostics.
2. Select Terminal on first open.
3. Offer Chat through the built-in core renderer when the feed contract remains compatible.
4. Show a visible fallback notice.
5. Never overwrite the immutable pin merely to remove the notice.

Unknown feed variants still receive the core safe card; they are not dropped.

### 14.4 Action bindings

A template binding is an action request, never a permission. Before every state-changing action, the Server rechecks identity, Space membership, actor representation, capability, operation input, entity version, idempotency, and required confirmation. Buttons are derived from the viewing human's action-discovery result and then optionally narrowed by the profile.

---

## 15. Spawn and harness integration

Chat flavor setup belongs in the work-session spawn transaction, before the provider process is launched.

The required sequence is:

1. Resolve the requested teammate, provider, model, mode, and active accessible Interaction Profile using the standard launch precedence. Phase-1 profile override is available only to an authenticated human with the override capability; teammate/coordinator spawns follow defaults.
2. Validate the profile and static template key/version.
3. Materialize the immutable interaction pin and selected-profile projection.
4. Mint trusted session-scoped credentials/context. The Server derives actor and work-session attribution from the credential; request bodies cannot claim another session.
5. Compile the provider-specific Claude or Codex system prompt and provider-native tool-registration subset from the Server/execution-owned resolved profile pin. Profile policy may narrow provider-native registration but never removes the CLI contract.
6. Inject the trusted scoped tm8 session environment plus the bounded model-facing bootstrap: pin identity/hash, `explicit-only` capture mode, compiled artifact references, and discovery roots. The complete tm8 CLI remains installed and deterministically discoverable. The bootstrap does not receive the raw resolved profile payload, browser projection, credential values, or hidden authorization results.
7. Spawn the provider's normal native interactive PTY.
8. Open the work-session panel. Terminal is immediately usable; Chat loads independently if configured.

The prompt instructs the agent to use tm8 messages for canonical communication, but the UI never assumes perfect compliance. Native provider prose remains valid Terminal content.

Claude launches as top-level interactive `claude`, not print/stream JSON mode. Codex launches as top-level interactive `codex`, not `codex exec --json` or app-server mode. Both receive a real PTY, connected input/output, the Server-computed working directory, provider-appropriate prompt/tool policy, and the full tm8 executable.

Phase 1 fixes `providerCaptureMode` to `explicit-only` and adds no provider semantic event stream. Provider-specific launch adapters are allowed only to correctly start and configure the native CLI; they are not a hidden Chat capture path.

---

## 16. State ownership and synchronization

| State | Owner/key | Persistence |
|---|---|---|
| Terminal process/output/offset | TerminalPool + session transport | Existing terminal lifecycle |
| Selected Terminal/Chat surface | Viewing member + work session; route mirror | Viewer preference |
| Chat pages/cursors | Work session + feed scope/filter | Client cache; canonical data on Server |
| Chat draft | Viewing member + work session | Local durable draft storage |
| Optimistic mutation | `clientMutationId` | Temporary client journal reconciled with command ledger/result |
| Delivery | Message ID + target | Server delivery facade |
| Interaction Profile runtime snapshot | Work session | Immutable pin row |
| Inbox read state | Recipient identity + notification | Server |

PTY bytes never enter the Chat cache, graph store, feed cursor, notification body, or read-state model.

### 16.1 Live update strategy

The UI consumes a feed-update abstraction that can be backed by polling now and a complete ordered subscription later. Phase 1 must not assume the current WebSocket path is complete.

- Initial and recovery truth comes from `entities.feed`.
- Durable event notifications trigger a targeted feed refresh or safe append only when order and membership can be proven.
- Presence and typing, if shown, are ephemeral and never advance the durable feed cursor.
- A sequence gap, reconnect, or invalid cursor causes a snapshot refresh; it does not prompt the client to merge the messages and activity endpoints independently.

### 16.2 Delivery hydration

Visible message rows need delivery facets without an N+1 request pattern. The preferred contract embeds authorized delivery summaries in message feed items, with a batch/read-detail path for expansion. Client-side exit-code interpretation is forbidden.

---

## 17. Loading, empty, offline, and error states

Every state preserves Terminal independence. A Chat failure must not block the PTY surface.

| Condition | Chat behavior |
|---|---|
| Profile still resolving | Terminal opens; Chat control shows bounded loading without blocking Terminal |
| No Chat-capable profile | Terminal only; no error copy |
| Declared Chat template unsupported/missing | Terminal selected; Chat has warning badge and core-renderer fallback or explicit unavailable panel |
| Initial feed loading | Stable message/card skeletons; composer may wait for permissions, not for all history |
| Empty feed | “No explicit tm8 messages or activity yet.” Explain that native provider output remains in Terminal; offer Switch to Terminal |
| Loading older page | Inline progress above list; preserve scroll anchor |
| Sparse authorized page | Render returned items; continue only through `nextCursor`; never invent a total |
| Invalid/expired cursor | Refresh from newest, preserve draft, announce that history was refreshed |
| Network offline/reconnecting | Keep cached items and draft; show reconnect banner; disable Send unless an offline queue is explicitly contracted |
| Viewer loses Chat permission | Replace content with non-leaking permission state; Terminal availability is evaluated separately |
| Session not found/deleted | Entity unavailable/tombstone state; do not expose former title through cached cross-anchor data |
| Message redacted | Tombstone bubble with author/time as allowed; retain reply position |
| Unknown activity variant | Core generic event card; never drop the row |
| Mutation validation fails | Preserve editable draft and attachments; describe the rejected fields |
| Mutation outcome unknown | Show “Checking whether message was saved”; reconcile same idempotency key before another send |
| Stored, delivery pending | Normal durable bubble plus pending badge |
| Delivery failed/unknown | Keep bubble; show exact delivery state and safe action |
| File upload fails before send | Keep draft; per-file retry/remove; do not submit a broken attachment reference |
| Work session exits | Chat stays readable; composer explains stored-only/no-live-delivery behavior |

Error copy must distinguish **Chat configuration failed**, **message was not stored**, and **stored message was not delivered**. These are different operator decisions.

---

## 18. Accessibility and keyboard contract

### 18.1 Nested surface switch

The Terminal/Chat control is an accessible tab list labeled “Work session surface.” It has two tabs only when Chat is available or visibly failed. Each tab owns a labeled panel and exposes selected, disabled, and error state without color alone.

Arrow Left/Right, Home, and End move/activate the surface tabs according to the selected tab behavior. Tab leaves the switch for the active surface. A disabled Chat tab remains discoverable with a textual reason but is not activatable.

### 18.2 Terminal focus law

When Terminal owns focus, it receives all keystrokes except the established physical **Ctrl+Backquote** escape. The escape parks terminal focus and moves focus to the owning panel's outer **Content** tab header, preserving the existing exact focus destination across reparent/park transitions. A visible “Exit terminal (Ctrl+`)” hint remains associated through `aria-describedby`; the surface switch is the next local navigation control inside Content.

Global navigation, Chat shortcuts, and surface-switch arrows do not steal keys from a focused terminal.

### 18.3 Chat semantics

- The feed is a labeled chronological list of message/event articles; it does not claim ARIA chat semantics that the virtualization layer cannot maintain.
- Loading uses `aria-busy`; new-item and delivery changes use a concise polite live region.
- A user-triggered storage failure may use an assertive announcement. Background activity does not repeatedly interrupt screen readers.
- Author, direction, provenance, delivery, redaction, and state are available as text, not only position, icon, or color.
- Timestamps have full accessible date/time labels.
- Expand/collapse controls expose state and the controlled region.
- Virtualization retains a focused row and provides a non-virtual fallback for assistive-technology modes if required by testing.

### 18.4 Composer

The text input has a persistent label, shortcut help, validation description, and current reply context. Attachment chips identify filename and remove action. Send state and delivery state are not announced as the same event.

### 18.5 Global Workspace priority

Existing keyboard priority remains:

1. Browser/OS.
2. Modal, dropdown, or command palette.
3. Focused Terminal.
4. Text-entry control.
5. Panel/list navigation.
6. Global chrome.

Escape continues to pop the panel only when no higher-priority control consumes it. Reduced motion, high contrast, zoom to 200%, and keyboard-only operation are release requirements.

---

## 19. Responsive layout and performance

- The Chat surface fills the same Content bounds as Terminal: feed flexes, composer remains at the bottom, and no second vertical page scroll is introduced inside the panel shell.
- At narrow panel widths, metadata wraps beneath the author line, actions move into an overflow menu, and attachment cards become single-column. The Terminal/Chat labels remain textual unless an accessible compact label is still visible.
- Pinned panels keep independent surface, feed, draft, and scroll state.
- Feed rows are virtualized and previews load lazily.
- One server feed cursor drives pagination; the browser never over-fetches and merges independent message/activity cursors.
- Delivery summaries are included or batch-hydrated to avoid per-row requests.
- Template rendering is bounded to registered components and token sets.
- Chat polling backs off while hidden but refreshes on reactivation. Terminal transport behavior is unaffected by Chat visibility.

---

## 20. Navigation and discoverability

- Selecting a session from Sessions or the live-session bar opens its work-session panel using explicit route state, then viewer preference, then profile default.
- Command palette actions may expose “Open Terminal for …” and “Open Chat for …” when Chat is configured.
- Opening an artifact card uses the normal entity stack push; Back returns to the same Chat scroll position.
- Message permalinks carry the work session, Chat surface, and focused feed item. They use the authorized bounded `around=<itemKind>:<itemId>` feed contract and do not encode message content.
- A Chat item anchored elsewhere provides “Open in Discussion” or “Open entity” rather than building a second nested editor.
- Notifications use the focus behavior in Section 13.

The Chat switch is local panel state, not a global application mode. Switching one pinned session to Chat does not switch the others.

---

## 21. Resolved contract rulings and dependencies

The UI, CLI/API, harness and domain owners agree on all nine items. They are closed design rulings; entries marked dossier/spec work remain implementation dependencies rather than open product choices.

| ID | Ruling | Disposition |
|---|---|---|
| C1 | `entity feed` accepts the API request `scope=default\|direct_v1\|session_chat_v1` and `order=newest\|oldest`; `default` resolves by kind and the response echoes a concrete versioned name. Profiles and persistent preferences may pin only `direct_v1\|session_chat_v1`, never `default`. Browser clients may request `default` through the same `entities.feed` catalog operation; CLI accepts only the concrete `direct_v1\|session_chat_v1` values. Item-kind filtering is not a separate CLI flag. | API request contract documented; catalog/DTO amendment required, with CLI limited to concrete scopes. |
| C2 | `FeedItem` is a versioned discriminated message/activity union with typed activity summary, complete `via`, canonical anchor, provenance, tombstone state, delivery facets and `clientMutationId` logical-operation key. Unknown variants use the safe core card. | Applied to backend briefing/API guide; schema amendment and exhaustiveness tests required. |
| C3 | `session_chat_v1.replies` is the immutable transitive descendant closure seeded by anchored/authored messages. Root indexing is only a prefilter; the Server verifies the exact parent chain so siblings are not over-included. | Closed; one-hop would require a different scope name. |
| C4 | Phase 1 has client-local **new since opened** only. It shows no authoritative durable Chat unread badge. A future composite read mark must be keyed by viewer/recipient, session and versioned scope with a monotonic through-key. | Closed minimal Phase-1 behavior; composite read state deferred. |
| C5 | `entities.feed` accepts mutually exclusive `around=message:{id}|activity:{id}` and `cursor`; `around` returns one authorized bounded centered window plus older/newer cursors. Clients never page until found. | Applied to CLI/backend briefing; catalog input amendment required. |
| C6 | The old raw Terminal Composer clause is superseded. Terminal uses native PTY input only; Chat uses stored-first message persistence and delivery facets. The separate §5.7 entity-handoff saga remains deliver/record according to its own law. | Applied and Round-12 verified in workspace v2.11 RULING M. |
| C7 | Outer `t=content\|discussion\|connections\|activity` remains unchanged. Nested per-panel `contentSurface=terminal\|chat` round-trips separately and surface toggles use `replaceState`. | Applied and Round-12 verified in workspace v2.11. |
| C8 | No delivery-only Retry affordance exists. **Send again** creates a deliberate new message/identity and explains that the original stored message remains. | Closed UI rule; a future delivery-retry operation would require a new review. |
| C9 | Chat implementation is gated on the catalog/CLI/API/dossier amendments. PTY parsing is never an interim substitute for attribution, feed or delivery contracts. | Standing implementation gate. |

The incomplete current WebSocket publisher is not a product ruling: Phase 1 may use polling behind the same feed-update abstraction. Provider structured events are not a Phase-1 dependency and require no UI decision here.

---

## 22. Acceptance criteria

The design is implemented correctly only when all of the following are true.

### Surface and Terminal

- Terminal remains fully interactive before, during, and after Chat loading or failure.
- Terminal and Chat switch in place; they never split within one work-session panel.
- Switching does not restart the provider, detach transport, lose terminal output, clear Chat draft, or reset Chat scroll.
- No UI copy calls Terminal Runtime, logs, or fallback.
- An agent answer printed only in the provider remains Terminal-only.

### Chat truthfulness

- Every message bubble maps to one stored graph message.
- Every activity card maps to typed attributable graph activity.
- Client pagination uses one server feed cursor and server deduplication.
- Delivery failure, unknown, expiry, and cancellation leave the stored message visible.
- Delivered never claims model read, acknowledgement, or compliance.
- No provider bytes, inferred turns, tool-call parsing, or event heuristics create bubbles.

### Profile and authorization

- Spawn pins one resolved Interaction Profile snapshot and static template key/version.
- Browser and agent receive separate safe profile projections.
- Terminal remains available regardless of profile settings.
- Unsupported pinned template versions use a visible safe fallback without rewriting the pin.
- Template buttons cannot grant operations and every action is authorized server-side.

### Workspace and navigation

- Chat coexists with the generic Discussion and Activity tabs without creating new storage.
- Opening artifacts and message anchors uses the canonical entity stack and restores Chat state on return.
- Pinned work-session panels maintain independent active surfaces.
- Inbox links focus the intended Chat item or safely fall back to canonical Discussion.

### Accessibility and failure handling

- Terminal focus escape, surface-switch keyboard behavior, feed reading order, composer labels, and delivery announcements pass keyboard and screen-reader testing.
- Chat has designed initial loading, pagination, empty, offline, authorization, unsupported-template, invalid-cursor, mutation-unknown, validation, upload, exited-session, and every delivery state.
- Chat failure never blocks or masks Terminal.

---

## 23. Explicit non-goals

Phase 1 does not include:

- provider JSON or semantic event capture;
- hooks that convert Claude/Codex assistant output into graph messages;
- parsing terminal logs into Chat bubbles;
- a question/interaction entity or question state machine;
- dynamic or agent-generated UI templates;
- template entities, template APIs, or template CLI nouns;
- simultaneous Chat/Terminal split view;
- a second session message store or session-specific inbox;
- automatic resend based on a non-zero CLI exit code;
- client-side merging of message and activity history.

---

## 24. Source map

This design should be read with:

- [Workspace layout and terminology](../architecture/WORKSPACE-LAYOUT-AND-TERMINOLOGY.md)
- [Domain architecture decisions](../architecture/DOMAIN-ARCHITECTURE-DECISIONS.md)
- [Session communication model](./SESSION-COMMUNICATION-MODEL.md)
- [CLI grammar redesign](../api-and-cli/CLI-GRAMMAR-REDESIGN.md)
- [Agent harness and command discovery](../harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md)
- [Current backend briefing for Chat templates](./BACKEND-BRIEFING-FOR-CHAT-TEMPLATES.md)

When one of those documents still contains the withdrawn “Chat replaces Terminal,” “Terminal becomes Runtime,” implicit provider-bubble, dynamic-template, `equips`, `pulled`, or `renders_with` proposals, the binding decisions in Section 1 and the latest backend briefing take precedence for this feature.
