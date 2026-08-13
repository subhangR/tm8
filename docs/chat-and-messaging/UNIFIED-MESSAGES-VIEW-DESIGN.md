# Messages — a unified, cross-entity message browser

Design record for the `messages` rail row and the Inbox mount.
Branch: `feat/messages-and-inbox`. Status: **implemented**; this doc is the
design it was built to, with the places reality diverged marked ⚠.

---

## 0. What was asked

> A menu item "Messages" giving a UI to view all the messages in an intuitive
> way. There can be messages in channels, tasks, sessions and discussions
> everywhere, but this UI should let the user browse them seamlessly across all
> those entities. Nothing changes in the backend.

The frontend-only framing was **95% right**. The 5% that was wrong is the rail
row itself (§6), and it is the part that silently breaks on reload rather than
failing loudly — which is why it gets its own section.

---

## 1. Messages is not Inbox and not Feed

Three questions, three surfaces. Conflating them is the main way this goes wrong.

| Surface | Question | State |
|---|---|---|
| **Inbox** | "What wants *me*?" — mentions, assignments, reviews | `inbox.list` is `v1`; `src/inbox/` was **finished and mounted nowhere**. Now mounted. |
| **Feed** | "What happened?" | `entities.feed` per anchor; no space-wide feed view. Unchanged. |
| **Messages** | "Every conversation in this space" | **New — this document.** |

Messages is the *corpus* view: it must show conversations the viewer was never
mentioned in, because "browse all the messages" is the ask.

---

## 2. Shape: conversation-first, with a firehose mode inside it

Two candidates: **(A)** a flat firehose of every message newest-first, and
**(B)** conversation-first — left pane of conversations, right pane the thread.

**Shipped: B as the spine, A as a mode inside it.** Not an aesthetic
preference — B is cheaper on the reads that already exist, and A alone carries
an N+1 that B does not.

### 2.1 A conversation is any anchor that has messages

The load-bearing definition. Not a blessed list of kinds — a **structural
predicate**:

```
counters.messages > 0
```

So the conversation query asks for **no `kinds` filter at all** and sorts by
`activityAt_desc`. That is exact, not lazy: `internal.maintain_message_counter`
(migration 001) bumps the anchor's `activity_at` and its message counter on
every insert — and deliberately does *not* bump the anchor's `version`, so a
pulled task does not go stale because someone replied. Entities with live
discussions are precisely the ones that sort to the top.

It is also the only form that survives contact with §15.2 (see §5).

⚠ **The cost, named.** Because the filter runs client-side, a 100-entity page
can thin to a handful of rows. `loadMore` chains pages until it has something to
show, bounded by `MAX_CHAINED_PAGES = 3` so one click can never become an
unbounded crawl. When it gives up with the cursor still live, `hasMore` stays
true and the control stays offered.

### 2.2 The thread pane is one existing read and one existing component

`entities.feed` **already works on every anchor kind**
(`server/src/facade/services/w2/feed-context.ts`):

```
FEED_SCOPE_ANCHOR_KINDS.direct_v1 = 'any'
defaultScopeFor:  work_session → session_chat_v1
                  channel      → channel_threads_v1
                  task         → task_discussion_v1
                  message      → thread_v1
                  else         → direct_v1
```

So `seam.feed(anchorId)` **with no `scope`** returns the correct per-kind reading
and the client never branches on kind. **The seamlessness this feature asks for
is already implemented server-side** — the view's job was to stop re-deciding it.

`ChannelScreen` is anchor-agnostic and presentation-only (props-in,
`anchorNoun`/`anchorTitle` supplied by the host). The Messages screen is a
**host**, not a second chat renderer: markdown, avatars, ThreadPane, replies,
attachments, composer and connection honesty all come for free.

### 2.3 Why A alone was rejected

A message `EntitySummary` carries `state.anchorId` but **not the anchor's title
or kind**, and there is no batch entity read — `entities.get` is single-id and
`CollectionQuery` has no `ids` filter. So a message-first list needs an N+1 to
render the one column that makes it browsable. Conversation-first gets titles
from the primary query, and the anchor index it builds is what later makes the
firehose affordable. Previews use the same trick: **one** extra
`kinds:['message']` query per page, folded to one entry per anchor.

---

## 3. Live updates are free

`message.created | message.updated | message.deleted` are on the **space-wide**
durable stream carrying `anchorId` and the full `MessageView`. No polling, no new
subscription. Messages is the one screen that wants the whole stream instead of
filtering it to one anchor.

⚠ **One implementation reversal worth recording.** The first version of the live
handler *synthesized* a `FeedItem` from the event and appended it. That was
wrong: a feed item is a server-composed DTO carrying fields the event does not
have (delivery summaries above all), and the scope's predicates decide what
belongs in a feed at all — so a client-side append both invents data and bypasses
that decision. It now triggers a re-read of the open conversation only. The
`no-kind-literals` guard is what caught it, incidentally: the fabricated item
needed an `itemKind: 'message'` literal.

---

## 4. What "query these messages" can mean today

`search.query` is **`status: 'reserved'`** — declared, not implemented. So v1
means scope and filter, not full-text:

- **by anchor kind** — chips built from `kindsPresent(rows)`, i.e. from the data.
- **by conversation** — selecting a row.
- ⚠ **`filters.mentionedActorId` is not what it looks like.** It matches *anchors
  that have a message mentioning the actor*, not the messages themselves. Correct
  for a conversation list; wrong if ever applied to the flat reading.

**Full-text is out**, and the control says so: a box that only filtered the
loaded page would look like search and not be it. It ships as a focusable
`DisabledAction` carrying `SEARCH_DISABLED_REASON`.

---

## 5. §15.2 — the lane names no kind

Each lane carries its own no-kind-literals guard, and creating a directory
creates an unguarded region, so `src/messages/no-kind-literals.test.ts` was
written with the lane.

⚠ **This changed the design.** The first draft of `messages-model.ts` had a
`CONVERSATION_KINDS = ['channel','task','work_session','doc',…]` array to send as
the `kinds` filter. That is a kind branch by another name *and* it goes stale the
moment a new kind learns to hold a discussion. Replacing it with the structural
predicate (§2.1) was forced by the guard and is simply better.

Everything else discriminates structurally too:
- `anchorIdOf` — a message is the only state carrying an `anchorId`.
- `unreadOf` — asks whether a state *carries* a count, not whether it is a channel.
- The one legitimate need for the ref (`kinds:[message]` in the query) resolves
  from registry DATA: `allKinds().filter(r => r.strategy === 'anchored')`, which
  throws on ambiguity rather than picking one. `anchored` **is** the routing
  strategy of a thing with no view of its own — the definition, not a loophole.

---

## 6. Unread — the honest state, and the trap

1. **Per-conversation unread exists for channels only.** `loadUnreadCounts`
   (`server/src/facade/entity-read.ts`) is scoped to the one kind whose state
   carries the count. The primitive underneath is general — `public.unread_counts`
   groups over every anchor, and migration 063's own docblock says `read_marks`
   "has simply only ever been CALLED for channels". So this is a facade narrowing,
   not a missing capability.
   **v1 posture: `unread: number | null`, where `null` means NOT COMPUTED.** A row
   with `null` draws its message count and carries the reason on hover. It never
   draws `0`. `unreadOf` being structural means the server widening turns those
   nulls into real numbers with **no client edit at all**.

2. **The space-wide total already exists** — `SpaceNavigation.unreadTotal` is
   `sum(unread_counts(space))` across all anchors, not channel-limited.

3. ⚠ **THE TRAP: never badge Messages from `spaces.counts` kind=`message`.**
   `space_kind_counts` derives `unseen` from read marks *on the entity itself*,
   and read marks are only ever written on **anchors** — so `unseen ≈ total`
   forever: a permanent four-digit badge that cannot be cleared. This is a second,
   independent reason Messages is a **view ref** (which carries no kind badge)
   rather than a kind row.

---

## 7. Where "nothing changes in the backend" was not true

`message` cannot be a kind row: its registry row is `strategy: 'anchored'` with
`slug: null`, so `isMenuEligibleKind` refuses it — and the database agrees
independently, `internal.w2_normalize_menu_payload` rejecting a `message` kind
ref outright. **Verified on a live cluster** (§9): the validator accepts
`messages` as a *view* ref and still raises `unknown or non-collection MenuConfig
kind ref` for `message` as a *kind* ref. There is exactly one door.

`MenuViewRef` is a closed union in **four** places that must move together:

| Where | What |
|---|---|
| `contract/src/contract.ts` | the `MenuViewRef` type |
| `contract/src/schemas.ts` | `MenuViewRefSchema` (zod enum) |
| `public.menu_view_registry` | server-owned table + CHECK constraint; `w2_normalize_menu_payload` rejects any view ref without a row |
| `internal.w1_default_menu_payload()` | the persisted default new/untouched spaces get |

Migration **102** (`102_menu_git_view.sql`) was the template, and **096**'s
header documents the failure to avoid:

> "the client shipped-default menu reached revision 8 with a new `files` VIEW row,
> but migration 094 remained the last writer of `w1_default_menu_payload()` …
> On reload the client briefly rendered its fallback, then replaced it with that
> persisted older menu, **making File browser appear and disappear.**"

That is what frontend-only buys here: a row that flickers in and vanishes on
every reload.

⚠ **Two corrections to the pre-implementation plan:**
- **No route-codec change was needed.** The plan listed `NavView` + `routes/codec.ts`.
  The actual precedent (`files`, `git`, `graph`, `dashboard`) does not route through
  the codec at all — `GateApp` holds `activeTarget` in state, persisted via
  `views/last-place.ts`. Messages follows that precedent exactly.
- **The migration is 117 after final rebase.** 116 landed while this PR's CI ran,
  so this branch moved to the next durable slot above main.

---

## 8. Inbox — the cheapest half

`grep -rn "InboxScreen|useInboxData"` outside `src/inbox/` returned **nothing**,
while `GateApp` rendered *"inbox isn't built yet"* over a finished screen, model
and data hook. `inbox.list` is `v1`, `inbox` was already in `MenuViewRef`, and it
already had its `menu_view_registry` row from migration 029.

So mounting it cost **one `GateApp` branch, one wrapper component, one rail row** —
no contract change, no registry change. `views/InboxView.tsx` exists as a
component rather than a ternary arm for one hard reason: `useInboxData` is a hook,
and mounting through a component also means the read only fires when the viewer is
actually on the Inbox.

---

## 9. What was actually verified

- **Migration, on a real cluster.** A throwaway PG 16.14 instance, full chain
  the full chain through `117` applied clean. Then: the registry row exists with
  `implemented = true`; `w1_default_menu_payload()` emits the new Home group; the
  CHECK rejects an unregistered ref; the validator accepts the `messages` *view*
  ref and still rejects the `message` *kind* ref; and a two-row upgrade test where
  an untouched default moved `revision 5 → 6` and gained the rows while a
  hand-authored menu was left **entirely untouched** (`UPDATE 1`).
- **Payload byte-equality**, mechanically: `117`'s `payload_102` baseline parses
  equal to `102`'s emitted default, and `117`'s new payload differs from `102`'s
  in the `home` group and **nowhere else**.
- **Typecheck**: `tsc -b packages/contract` and `tsc -p packages/tm8-ui` both clean.
- **Tests**: see the PR body for the measured state, including which failures are
  pre-existing on `origin/main`.

**Not verified:** no browser has rendered this. Every claim above is at the type,
test or database layer. "The API returns it" and "I saw it render" are different
claims and this document makes only the first.

---

## 10. Open questions the implementation did not settle

1. **Cross-space browsing.** Per-space today (`collections.query` is space-scoped,
   the rail is per-space). Cross-space needs N queries and a space column.
2. **Composer latency to sessions.** The composer works on a session anchor, but
   the message is typed into that agent's PTY and a busy agent can take ~60s to
   see it. `SESSION_DELIVERY_NOTE` exists in the model for this; wiring it to the
   composer is not done.
3. **Widening unread past channels** — small, contained, and the client is already
   shaped for it (§6.1).
4. **Full-text search** — needs a real `search.query`.
