# The unified feed hook — one reader for every anchor

Status: DESIGN, not yet built. Owner: chat-unification lane.
Companion to `UNIFIED-MESSAGES-VIEW-DESIGN.md` (which rules on what a feed item
*is*) and `SESSION-COMMUNICATION-MODEL.md` (which rules that Chat and Discussion
are two projections of one anchored store).

---

## 1. What is actually being replaced

The inherited brief says "one hook replacing four". That count is generous to
itself, and building against it would mean promising deletions that cannot
happen. The measured version:

| Today | Lines | What the union actually takes |
|---|---|---|
| `channel-screen/useChannelFeed.ts` | 451 | **All of it.** It is a feed reader end to end. |
| `channel-screen/chat-store.ts` | 548 | **The controller's read path** (`createChatSessionController`, ~190 lines). The store, drafts and journal survive *underneath* the union as its persistence layer — they are the best-earned code in the three and are not duplicated anywhere. |
| `messages/useMessagesData.ts` | 529 | **The feed slice only** (~120 lines: the open-thread effect `:388-416`, `loadEarlier` `:418-439`, `post` `:474-493`, the `feedEpoch` bump `:468`). The conversation *list* — space query, previews, page chaining, the flat reading — is the Messages screen's own concern and stays. |
| `chat-home/real-port.ts` | 254 | **The branch read inside `readThread`** (~30 lines). The rest is thread *configuration* (`listThreads`/`startThread`/`configure`/`postTurn`), which is a different noun and folds into the composer at a later step, not this one. |

So: **one hook absorbs one whole reader, one controller, one slice and one
call** — roughly 790 lines of read logic collapsing to an estimated 450, with
`useMessagesData` and `real-port.ts` surviving thinner rather than dying.

Stating it this way matters because two of the four have non-feed
responsibilities that a "delete all four" plan would either drop on the floor or
drag into a hook that has no business owning them.

---

## 2. The one rule everything else follows from

**The requested scope is frozen for the life of a key, and it is `undefined`
unless a caller has a reason it can defend.**

`feed-context.ts:176 defaultScopeFor` already maps every anchor kind to its
right reading — `work_session` → `session_chat_v1`, `channel` →
`channel_threads_v1`, `task` → `task_discussion_v1`, `message` → `thread_v1`,
everything else → `direct_v1`. `useMessagesData.ts:399` is the only one of the
three call sites that trusts it. `useChannelFeed.ts:63` and `chat-store.ts:249`
hardcode, and that is precisely what makes them unmountable on a task or a doc.

Two consequences that are easy to get wrong:

**(a) Never echo the *resolved* scope back on page two.** `EntityFeedPage`
carries `resolvedScope`, and the obvious-looking optimisation is to send it on
subsequent reads "now that we know". That breaks paging. `useChannelFeed.ts:56-61`
already documents why in its own words: a keyset cursor is fingerprinted over
its scope, so two spellings of the same scope mean the second page rejects the
first page's cursor. Sending `undefined` then `channel_threads_v1` is two
spellings. The requested scope goes out byte-identically on every read for a
given key — first page, older, newer, around, refresh, all of it.

**(b) The state key is keyed on the *requested* scope, not the resolved one.**
`ChatStateKeyParts.scope` is mandatory today and feeds both `chatStateKey` and
`draftStorageKey` — i.e. it is in the **localStorage draft key**. The resolved
scope is only known after the first read completes, so keying on it would change
the key mid-flight and orphan the viewer's half-written message. The requested
scope is known before the first byte moves. Key on that; spell `undefined` as
the literal `'default'` in the key string.

`resolvedScope` is therefore a **debug and assertion** field, never an input.

---

## 3. Three live defects the union fixes by construction

These are in `useChannelFeed` today and ship. They are not new work — they are
the reason the union is worth building rather than a nice-to-have.

**D1 — `reload()` has no generation guard, and races are the normal case.**
`chat-store` brackets every read with `begin()`/`accepts(token)`
(`:239-243`) so a slow response for a superseded read is discarded. `reload()`
has nothing: it awaits `seam.feed(...)` and calls `setPage` unconditionally at
`:253`. That would be a rare edge — except `:297-302` fires `void reload()` on
*every* matching event with no debounce, so overlapping reloads are the ordinary
behaviour of a busy channel, and whichever HTTP response happens to land last
wins. **A channel can render an older page than the one it already had.**
Correctness, not performance.

**D2 — every incoming message flips the whole feed to `loading`.**
`reload()` opens with an unconditional `setLoading(true)` at `:246`. `chat-store`
deliberately does not: `patch({ phase: current().page ? current().phase : 'loading' })`
(`:247`) — the loading state means "there is nothing to show yet", never "a
refresh is in flight". So today a busy channel strobes its own feed.

**D3 — the channel feed never sees delivery updates.**
`useChannelFeed`'s event filter is `'anchorId' in event && event.anchorId === channelId`.
`chat-store`'s `eventTouchesSession` (`:496-508`) additionally handles
`activity.created`, `message.attachments.updated`, `message.delivery_reserved`
and `message.delivery_settled`. The 8-state per-message delivery chips are one
of the surface's headline features, and on a channel **they do not refresh
live** — you only see a settled delivery if something else happens to trigger a
reload. The union takes the broader predicate, generalised from "touches this
session" to "touches this anchor".

Plus the one already named in the brief: `post()` awaits a full `reload()`
(`:368`), the slowest possible echo, on the surface that is about to go on every
entity in the product.

---

## 4. Shape

```ts
export interface UnifiedFeedKey {
  viewerMemberId: string;
  anchorId: EntityId;
  /** ABSENT unless the caller can defend it. Frozen for the key's life. */
  scope?: FeedScope;
  /** Stable projection identity; `chronological` is the default. */
  filter: string;
}

export interface UnifiedFeedOptions {
  seam: UnifiedFeedSeam;       // feed, onEvent, onConnection, onResync, messages, commands
  key: UnifiedFeedKey;
  spaceId: SpaceId | string;
  limit?: number;              // 50
  /** Branch reads + thread pane. Registry data decides, never a kind literal. */
  threads?: boolean;
  focusAround?: `message:${string}` | `activity:${string}` | null;
  store?: StoreApi<ChatStoreState>;
}
```

Returned surface is the union of the three, with no capability lost:

- **read** — `page` (journal-projected), `phase`, `error`, `refusal`,
  `refreshedFromNewest`
- **paging** — `loadOlder`, `loadNewer`, `loadAround`, `loadingEarlier`,
  `loadingNewer` *(bidirectional + `around` exist only in `chat-store` today;
  the channel and Messages surfaces gain them)*
- **write** — `post` via the mutation journal, so the echo is optimistic and
  `post` no longer awaits a read *(the channel surface gains this)*
- **drafts** — persisted, keyed viewer+anchor+scope+filter *(the channel and
  Messages surfaces gain this)*
- **reply target** — `replyTo`, `setReplyTarget`
- **branch** — `thread`, `openThread`, `closeThread`, `loadMoreReplies`
  *(the session surface gains the capability; whether it is *offered* stays
  registry config — `registry.ts:894-901` rules that session chat keeps its
  flat, replies-inline read)*
- **live** — coalesced refresh (300ms trailing / 1500ms max wait), reconnect
  reload, `onResync` *(the channel and Messages surfaces gain all three)*

`turnGraphs`, `@tag` dispatch and the mention/skill/attachment option reads are
**not** in the hook. They are surface concerns with different lifetimes, they
already live in composable helpers (`channel-tags.ts`, `rich-input`,
`chat-attachments.ts`), and folding them in is how a feed hook becomes a god
object. They stay where they are and are passed through.

---

## 5. What this design refuses

- **No client-side FeedItem synthesis.** `UNIFIED-MESSAGES-VIEW-DESIGN.md §3`
  ruled on this after it was built and reverted: a feed item is a
  server-composed DTO carrying fields the event does not have — delivery
  summaries above all — and the scope's predicates decide what belongs in the
  feed at all. A live arrival triggers a *coalesced re-read*. The optimistic
  echo is the mutation journal projecting a **pending** row that is visibly
  pending, which is a different claim from a fabricated settled one.
- **No second transcript renderer.** Compose once, mount twice —
  `views/graphSurface.tsx:14-17` gives the reason in its own words.
- **No hardcoded scope.** See §2.
- **No kind literals.** The hook is anchor-agnostic; per-kind behaviour is
  registry data, as it already is for `panel.composition` and `panel.threads`.

---

## 6. Order of work

1. **Land the union hook behind the existing signatures.** `useChannelFeed` and
   `createChatSessionController` become thin adapters over it. Nothing moves in
   the UI, D1–D3 are fixed, and every existing test keeps passing or fails
   loudly.
2. **Repoint `ChannelChatSurface` and `ChannelView`** at the hook directly;
   delete `useChannelFeed`.
3. **Repoint `SessionChatSurface`**; delete the controller's read path.
4. **Repoint `MessagesScreen`'s thread pane**; `useMessagesData` keeps its list.
5. Parts rendering, `onChatTurn`, composer thread-config — separate steps, on
   top of a hook that already exists.

Step 1 is the whole risk. Steps 2–4 are mechanical once it holds.
