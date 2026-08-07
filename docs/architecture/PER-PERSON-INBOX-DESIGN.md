# Per-person inbox — what already exists, and the three things that don't

Status: **ACCEPTED, ruled on 2026-08-07.** Scope limited to *message* activity,
per the task ("lets stick to message activity for now, later we will see other
status activities"). Author: codebase audit against `origin/main` @ `7631e08`,
2026-08-07.

**User rulings applied in this revision** (§D5, §D2, §8):

1. **Coalesce threads, but keep every notification a separate row with its own
   immutable `created_at`.** The coalesced thread is a *separate* record carrying
   `updated_at`, and that is what gets bumped. This dissolves the cursor
   trade-off the first draft raised as its main open question — see §D5.
2. **The subscription table ships.** Not deferred, not optional.
3. **Converge with the `feature/Channels` line** (work session
   `019fda6f-434d-77ac-a3da-0e643afe6084`, PR #44). See §8.

---

## 1. The headline

tm8 already has a per-person inbox. It has a table, RLS, keyset indexes, a
ledgered write path, an HTTP read API, an event stream and a UI screen. What it
does **not** have is a way for a person to say *which things they care about* —
and without that, every proposal to widen the inbox is a proposal to make it
noisier.

So this is not a "build an inbox" task. It is a **subscription** task, plus two
plumbing defects.

## 2. The substrate, as measured

Two independent unread mechanisms exist, and they are deliberately different.

| | Tier 1 — **Inbox** | Tier 2 — **Ambient unread** |
|---|---|---|
| Table | `public.notifications` (`003_read_model.sql:70`) | `public.read_marks` (`003:59`) |
| Grain | one row per event per recipient | one cursor per `(member, anchor)` |
| Semantics | "someone needs me" | "there is new stuff here" |
| Read state | per row, `read_at` | per anchor, `last_read_at` |
| Cost of volume | linear row growth | free |
| Powers | Inbox screen | channel badges, space unread total |

`003`'s own header states the admission rule: notifications are **TARGETED, not
broadcast**. That rule is the whole design, and everything below respects it.

### 2.1 Recipient is a discriminated pair, not a member id

`notifications` carries `recipient_member_id` **and** a nullable
`recipient_team_member_id` (`015_w1_foundations.sql:267`), with four keyset
indexes covering the member-personal and teammate arms separately
(`015:270-282`). `023_w2_inbox.sql` then makes member and teammate reads
strictly **disjoint** at the RLS layer, and adds
`inspect_owned_teammate_inbox(...)` so a human can look into a persona's inbox
without the two merging.

**Any new per-person table must mirror this pair**, or agent personas fall out
of the model — and agents posting messages is explicitly in scope for this task.

### 2.2 Producers, and the **two** writers

> ⚠ **CORRECTED after review.** This section previously claimed
> `internal.w2_notify_actor` was *"the single writer … nothing else inserts."*
> **That was false, and it was the most load-bearing wrong premise in the
> document** — it made §D5 unimplementable as first written. There are **two**
> writers, and the one this doc missed writes the majority of kinds.

| `kind` | Producer | Writer | Fires when |
|---|---|---|---|
| `mention` | `messages_fan_out_mentions` (`003:164`, redefined `019:258`) | **both** (W1 arm `notify`, W2 arm `w2_notify_actor`) | actor named in `messages.mentions` |
| `assignment`, `approval_request` | `edges_fan_out_notification` (`003:184`) | `notify` (`003:180`) | `assigned_to` / `approval_requested_from` edge insert |
| `award` | `point_events_fan_out_award` (`004:65`) | `notify` (`004:59`) | `point_events` insert |
| `unblock` | `announce_unblocked` (`003:245`) | `notify` | last hard `depends_on` resolves — **only** to `assigned_to` |
| `join` | `007:652`, rebound `031:551` | `notify` | invite accepted |
| `message_reply` | `w2_post_message_batch` (`019:485`) | `w2_notify_actor` (`019:484`) | message has a `parent_message_id` → parent's author |
| `session_delivery_failed` | `w2_delivery_fallback` (`019:318`) | `w2_notify_actor` | PTY injection into a live agent failed |
| `anchor_message` | `messages_notify_anchor_watchers` (`077`) | `w2_notify_actor` (`077:145`) | message on a non-channel, non-session anchor → anchor creator + assignees |

**The two writers:**

- `internal.notify` (`003:118`) — inserts directly at `003:131`. **Five of the
  eight kinds.**
- `internal.w2_notify_actor` (`019:232`) — mention, `session_delivery_failed`,
  `message_reply`, `anchor_message`.

#### 2.2.1 Only one writer can populate the discriminated pair

`internal.notify` **never references `recipient_team_member_id`** (`003:131`),
and it hard-requires the recipient to be a `member` of the space —
`exists (select 1 from public.members m …)` at `003:129` — collapsing personas
to their owning member via `internal.recipient_member` (`003:110-116`).

So the discriminated pair §2.1 calls load-bearing is populated by exactly **one**
of the two writers. The shipped consequence, today:

> Assign a task to a persona → the `assignment` row lands in the **owner's
> member-personal** inbox. A message on that same anchor → the `anchor_message`
> row lands on the **persona**.

**The two producers already disagree about whether personas have inboxes.** This
is not a question §6 gets to answer freely (see §6 Q1, revised) — it is an
existing inconsistency that the effective-watchers work in §5 step 3 will
surface whether or not it intends to.

### 2.3 Read + surface

- `inbox.list` `GET /v2/inbox`, `inbox.markRead`, `readMarks.upsert`
  (`packages/contract/src/catalog.ts:124-126`). Keyset paged on
  `(created_at desc, id desc)` with a **microsecond** cursor — the service
  header (`facade/services/w2/inbox-read-marks.ts`) documents at length why
  millisecond truncation silently skips rows.
- `readMarks.upsert` also flips matching `notifications.read_at` — reading the
  thing the notification pointed at *is* reading the notification.
- Events `notification.created` / `notification.read` (`contract.ts:503`).
- `packages/tm8-ui/src/inbox/` — five fixed groups (`inbox-model.ts:40-47`);
  an unrecognised `kind` routes to `other` rather than being dropped
  (`groupOf`, `inbox-model.ts:73-80`).
- `notification_outbox` (`003:93`) — a transport-agnostic dispatch queue.
  Table, indexes and policies exist. **No worker consumes it.** Empty by design
  until a transport lands.

### 2.4 What the task's item #1 already gets

> *"when messages are posted against a task / entity the user has created /
> assigned to / related to"*

`077_notify_anchor_watchers.sql` (PR #26, `d81b0ac`, 2026-08-05) landed **two
days ago** and covers *created* and *assigned to*. Its header documents the
defect precisely: an agent's `tm8 message send --to <task-id>` final report
produced `deliveries: []` and zero notification rows, because
`w2_notify_actor`'s only three call sites were mention, delivery-failure and
reply. A top-level message on a task anchor with no `--mention` reached nobody.

**Not yet covered: "related to."** 077 explicitly rejected two wider watcher
sets, and its reasoning holds:

- every `participates_in` actor — that edge is *session* participation, not a
  work-item subscription; on a task anchor it is empty.
- everyone who has posted on the anchor — "unbounded, retroactive, and it turns
  one long thread into an inbox row per participant per message. That is a
  subscription feature with an opt-out, **and it needs a `muted` surface
  first**."

That last sentence is this document's mandate.

## 3. The three gaps

### Gap A — there is no subscription or mute model, anywhere

No `subscriptions` table, no `watch`/`mute` column, and no edge type for either.
Watchers are derived at fan-out time from `created_by` + `assigned_to` and
nothing can alter that set.

> ⚠ **Evidence corrected after review.** This previously cited `001:900-935` as
> "the complete registry". **It is not** — there are **seven** `insert into
> public.edge_types` sites on `origin/main`: `001:900`, `015:34`, `056:202`,
> `057:173`, `064:67`, `065:70`, `066:63`. The conclusion survives (all six
> others were read: `in_project, shared_into, participates_in, authored_from,
> defaults_to_profile, selected_profile, about, based_on, in_worktree,
> derived_from, anchored_to, messaged, created_in` — none is a subscription or a
> channel-membership edge), but the original grep would not have found one if it
> existed. Any future "there is no edge for X" claim must sweep all seven.

Consequence: a person cannot follow a task they neither created nor were
assigned, and cannot stop following one they did. Every widening of the watcher
set is therefore non-opt-out-able noise.

### Gap B — there is no channel membership model

`public.channels` (`001:500`) is `entity_id, space_id, name, topic` and
timestamps. **No join table. No membership edge.** Every space member implicitly
sees every channel; "who is in `#general`" has no answer in the schema.

The closest existing thing is the `pulled` edge (`member|team_member` →
`channel|task|doc|…`, **`001:903`**), described as *"Local projection/adoption"*
— a **layout** meaning ("I put this on my board"), not a subscription meaning.

This is why 077 excluded channel anchors, and the reason given was correct:
notifying a channel's creator on every line would turn one inbox into a
firehose. **Item #2 of the task cannot be built until Gap B is closed** — there
is no principled recipient set to fan out to.

### Gap C — the channel unread badge is a lie

`EntitySummary.state.channel.unreadCount` (`contract.ts:109`) is hardcoded `0`
in both entity read paths — `facade/entity-read.ts:1025` and
`events/projector.ts:777` (which lists it in a known-unfilled set at `:989`).
The only place it is real is the spaces list (**`handlers/spaces.ts:221`/`:233`**,
the `unreadByAnchor` batch off `public.unread_counts`). Note `spaces.ts:60-74` —
cited here in the first draft — is a *different* thing: an inline correlated
subquery producing the space-level `unread_total`, not the per-channel value.
The conclusion is unchanged; the citation was wrong. Historic wording follows:

The only place it is real is the spaces list, which computes it inline
(`handlers/spaces.ts:60-74, 233`) off `public.unread_counts(space_id)`
(`007:1986`, redefined `016:47`).

So Tier 2 — the mechanism that is *supposed* to absorb channel volume — does
not render outside one screen. Fixing this is independent of everything else
and is the cheapest visible win in the task.

## 4. Proposed design

### D1 — Keep the two tiers separate. Do not merge them.

Admission rule, stated once: **an event enters the Inbox only when there is a
named reason tying the recipient to the anchor.** Volume without a reason stays
in `read_marks`. This is `003`'s rule and 077's rule; nothing here changes it.

### D2 — Subscriptions: derived default + explicit override

```sql
create table public.entity_subscriptions (
  id             uuid primary key default internal.new_id(),
  member_id      uuid not null references public.members(entity_id) on delete cascade,
  team_member_id uuid references public.team_members(entity_id) on delete cascade,
  anchor_id      uuid not null references public.entities(id) on delete cascade,
  mode           text not null check (mode in ('watching','muted')),
  source         text not null check (source in ('manual','auto_participated')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ⚠ ADDED AFTER REVIEW. Without this the table admits both ('watching') and
-- ('muted') for the same (subscriber, anchor) simultaneously — the effective-
-- watchers formula would then "resolve" the contradiction silently by
-- subtraction, and D3's `upsert` would have nothing to ON CONFLICT against.
-- The coalesce trick is the same one D5 uses for its own identity index.
create unique index entity_subscriptions_identity_idx
  on public.entity_subscriptions(
       member_id,
       coalesce(team_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
       anchor_id);

alter table public.entity_subscriptions enable row level security;
-- Policy shape copied VERBATIM from notifications_select (023), not paraphrased:
-- member and acting-as-teammate reads must stay disjoint or 023's guarantee is
-- defeated by the table that was supposed to respect it.
```

Effective watchers:

```
DERIVED(anchor)  ∪  explicit 'watching'  −  explicit 'muted'
```

where `DERIVED` starts as 077's set (`created_by` ∪ `assigned_to`) and may later
add `working_on`.

**Why hybrid rather than a pure table.** A pure table needs a backfill for every
entity that already exists, and a six-month-old task with no row would silently
stop notifying its creator. Derived-by-default means zero backfill. **Why not
pure-derived** (today's state): mute is impossible, and mute is the
prerequisite 077 named.

Recipient shape mirrors §2.1 exactly — `member_id` plus nullable
`team_member_id` — with RLS modelled on `notifications_select` (`023`), or
agent personas cannot hold their own subscriptions and 023's disjointness
guarantee breaks.

Writes go through the command ledger like every other mutation
(`subscriptions.set`), so replay and `clientMutationId` binding behave the way
`mark_notification_read` (`023`) already does.

### D3 — "Related to" = auto-watch forward, never retroactive fan-out

Posting a message on an anchor upserts `(you, anchor, watching,
auto_participated)`. You are then notified about messages posted **after**
yours. Nothing is backfilled, and one `subscriptions.set` to `muted` ends it.

This gives the task's "related to" without the unbounded retroactive fan-out 077
rejected — the difference is that the subscription is created going forward and
is opt-out-able.

### D4 — Channels: silent by default, watch-driven into the inbox

Keep 077's channel exclusion. A channel message produces an inbox row **only**
when (a) you were `@mentioned` — already works today — or (b) you hold an
explicit `watching` subscription on the channel entity. All other channel
traffic stays Tier 2.

Use `entity_subscriptions` with `anchor_id` = the channel entity rather than
overloading `pulled`. Overloading `pulled` would mean muting a channel also
removes it from your board — two unrelated user intentions on one row.

This closes Gap B for inbox purposes without inventing a full channel-membership
feature, which is a much larger product decision (private channels, invites,
joins) and is not what this task asks for.

### D5 — Coalesce into a *separate* thread record. Never mutate a notification.

**RULED 2026-08-07.** Today a 50-message thread is 50 rows per watcher, and 077
already ships a known duplicate (a reply whose anchor creator is also the parent
author gets both a `message_reply` and an `anchor_message` row — its header calls
this out and accepts it).

The first draft proposed collapsing rows in place via a partial unique index and
`on conflict do update`, and flagged the resulting cursor race as its single
biggest risk. **That approach is rejected.** The ruling: every notification stays
its own record with its own immutable `created_at`; coalescing happens in a
*second* table whose `updated_at` is what moves.

```sql
create table public.notification_threads (
  id                       uuid primary key default internal.new_id(),
  space_id                 uuid not null references public.spaces(id) on delete cascade,
  recipient_member_id      uuid not null references public.members(entity_id) on delete cascade,
  recipient_team_member_id uuid references public.team_members(entity_id) on delete cascade,
  -- ⚠ NULLABLE + SET NULL, not `not null` + CASCADE. See "FK direction" below:
  -- cascading here would delete inbox history on an entity delete, reversing a
  -- deliberate 003:75 decision.
  anchor_id                uuid references public.entities(id) on delete set null,
  kind                     text not null,
  -- The grouping identity. See below: one uniform rule, no per-kind branch.
  coalesce_key             text not null,
  item_count               integer not null default 0,
  last_notification_id     uuid references public.notifications(id) on delete set null,
  last_actor_id            uuid references public.entities(id) on delete set null,
  -- ⚠ NO `excerpt` COLUMN. Deliberate — see "Why the thread stores no excerpt".
  created_at               timestamptz not null default now(),  -- first event, immutable
  updated_at               timestamptz not null default now(),  -- last event, bumped
  read_at                  timestamptz
);

create unique index notification_threads_identity_idx
  on public.notification_threads(
       recipient_member_id,
       coalesce(recipient_team_member_id, '00000000-0000-0000-0000-000000000000'::uuid),
       kind, coalesce_key);

alter table public.notification_threads enable row level security;
-- Same verbatim-copy rule as entity_subscriptions: this table carries
-- recipient_team_member_id, so an unpoliced version hands out precisely the
-- member/teammate disjointness 023 exists to establish.

alter table public.notifications
  add column thread_id uuid references public.notification_threads(id) on delete set null;
```

#### Why the thread stores no excerpt — and a live defect it exposes

The first draft gave `notification_threads` an `excerpt` column copied from the
notification payload. **Dropped**, on a finding from the Messaging Format line
(task `019fda8b-e624-7c2b-ac2d-572d4811f2cc`) that I verified end to end.

**`notifications.payload.excerpt` is write-only.** Three producers write it —
`003:155`, `019:267`, `077:156`, all `left(body, 280)` — and **nothing reads
it**: zero hits for `payload.excerpt` across `packages/server/src`,
`packages/tm8-ui/src` and `packages/cli/src`. The renderer wants a *different
key*:

- `inbox-model.ts:176` — `preview: item.message?.trim() ? … : null`
- `inbox-read-marks.ts:324,333` — `const rawMessage = row.payload?.message`

**and no notification producer anywhere writes `payload.message`.**

Measured on prod, which makes it concrete:

| kind | rows | has `message` key | has `excerpt` key |
|---|---|---|---|
| `session_delivery_failed` | 34 | **0** | 0 |
| `message_reply` | 11 | **0** | 0 |
| `assignment` | 4 | **0** | 0 |

**`NotificationItem.message` is null for every notification row in the database.
The inbox's `preview` line has never rendered, for any kind, ever.** And when
077 is eventually deployed, its carefully-truncated 280-char excerpt will render
nowhere either — that truncation is dead code today.

**The rule (Messaging Format §3.5.1, adopted here):** never wire
`payload.excerpt` to a renderer. A preview is derived from
`EntitySummary.excerpt` — the single helper at `entity-read.ts:318`, which that
line is making markdown-aware — and the payload copy stays unread.

So the thread stores nothing. **A plpgsql trigger cannot reach a TypeScript
helper**, so an `excerpt` column would necessarily mint a *fourth* cap in SQL,
which is the thing the rule exists to prevent. The thread list derives its
preview at read time from the target's summary via the existing batch loader
`loadEntitySummariesByIds` (`entity-read.ts:1558`) — already the established
pattern in this very service, so no new cost.

#### FK direction — do not cascade

`notifications.target_entity_id` is `on delete set null` (`003:75`), and `003`
contrasts it *in the same table* with `recipient_member_id … on delete cascade`
(`003:73`). Deleting an entity is meant to **blank the pointer and keep the
notification**. The first draft of this section wrote
`threads.anchor_id … cascade` **plus** `notifications.thread_id … cascade`,
producing the chain *delete entity → delete thread → delete every notification
in it* — silently reversing that decision and destroying inbox history. Both are
`set null` above. `anchor_id` is nullable for the same reason: it must be able to
represent a target that was nulled by exactly that rule.

#### ⚠ RLS is not optional and nothing in the repo will catch its absence

`packages/server/test/db/w1-foundations.test.ts:362-371` asserts
`relrowsecurity` only over a **hardcoded `W1_TABLES` list**. A new table ships
unpoliced *and green*. Both new tables must be added to that list — or better,
the test changed to sweep all of `public`, so the next table cannot repeat this.

Plus four keyset indexes on `(…, updated_at desc, id desc)` mirroring the member
-personal / teammate / unread split that `015:270-282` already established for
`notifications`. The thread table is the inbox's list surface; `notifications` is
its detail surface.

#### Where thread maintenance lives: an AFTER INSERT trigger on `public.notifications`

**This is the single most important correction in the revision.** The first
draft said *"the fan-out computes `coalesce_key`"*. That was wrong three ways
and the reviewer's proposed fix repairs all three at once:

1. **It missed 5 of 8 kinds.** Per §2.2 there are *two* writers. Putting the
   logic "in the fan-out" would have given the five `internal.notify` kinds no
   thread row at all — they would vanish from a thread-based list surface.
2. **It was non-additive, violating the rule this document itself cites.** The
   fan-outs are `w2_notify_actor` and `internal.notify`. 077's header names
   `w2_post_message_batch`, `internal.w2_notify_actor` and
   `internal.fan_out_message_mentions` as bodies other lanes carry uncommitted
   arms of, and warns that replacing any *"would silently drop those arms and
   pass every static check."* §5 step 5 would have violated the rule §5 step 3
   correctly quotes.
3. It would have needed the same logic written twice, in two writers that
   already disagree about personas.

**So: `create trigger notifications_maintain_thread after insert on
public.notifications`.** It sits downstream of *both* writers, catches every
kind automatically including any future one, and is purely additive — no shared
body is replaced.

*(Clarifying §5 step 3 while here: rewriting 077's watcher CTE **is** a
`create or replace` of `internal.w2_notify_anchor_watchers()`. That one is safe
— 077 created that function and owns it. The distinction matters because the
same sentence's logic applied to `w2_notify_actor` is exactly what went wrong
above. "Additive only" means *do not replace a body another lane is editing*,
not *never use `create or replace`*.)*

**One uniform grouping rule, no per-kind special case.** Every notification gets
exactly one thread. The trigger computes `coalesce_key` as:

- `anchor_id::text` for the message-volume kinds — `anchor_message`,
  `channel_message`, `message_reply`. These merge.
- `notifications.id::text` for everything else — `mention`, `assignment`,
  `unblock`, `approval_request`, `award`, `session_delivery_failed`. Each is
  individually actionable, so each gets a thread of one and never merges.

That keeps the read path identical for both classes. A thread of one is not a
special case to be branched on; it is the general case with `item_count = 1`.

**Why this is strictly better than in-place coalescing.**

| | In-place (rejected) | Separate thread record (ruled) |
|---|---|---|
| Per-event history | destroyed — 50 events become 1 row | preserved — 50 rows, 1 thread |
| `notifications.created_at` | mutated | **immutable** |
| Existing microsecond keyset cursor | races; can skip rows mid-page | **untouched, still correct** |
| Four W1 keyset indexes (`015:270-282`) | must be rebuilt | **unchanged** |
| "when did this thread start" | lost | `threads.created_at` |
| Expanding a thread | impossible | list its children on the existing cursor |

The in-place-mutation hazard does not arise: nothing mutates the column the old
cursor rides on. New pagination happens on `threads.updated_at`, a brand-new
column with brand-new indexes and no legacy readers.

#### ⚠ But that answered the wrong hazard. The thread list is "the third producer."

The first draft treated the cursor question as closed. It is not.
`facade/services/w2/inbox-read-marks.ts` — the file §2.3 cites — documents that
the microsecond invariant is held **by producers, not by the compiler**:
`Querier.query<R>` (`db/types.ts:45`) takes `R` as an unchecked caller
assertion, so a `SELECT` that omits the microsecond column typechecks clean,
yields `undefined`, and mints a cursor the server's own `decodeListCursor`
(`:173`) then rejects. Its words: *"`queryInbox` shipped exactly that."* It names
exactly two legal producers, `directInboxSql` (`:243`) and `queryInbox` (`:272`),
and then says:

> **"A THIRD ONE IS A DECISION, NOT AN OVERSIGHT — give it `MICROS(...)` or
> give this type a runtime refusal at the mint."**

**D5's thread list is that third producer**, and the first draft did not mention
it. Worse, the risk runs the *opposite* way from what that draft implied:
`created_at` is written once per event, while `updated_at` is bumped repeatedly
on a hot anchor — so intra-millisecond collisions on the DESC keyset are **more**
likely on the new column, not less. Truncation is more reachable here than in
the surface being replaced.

**Requirement:** the thread list query selects `MICROS(updated_at)` and reuses
`encodeCursor`/`decodeCursor`, *or* the row type gets the runtime refusal at the
mint that the header asks for. Pick one explicitly and record which.

**Read semantics.** Marking a thread read sets `threads.read_at` **and** flips
`read_at` on all its unread children — the same "reading the thing the
notification pointed at *is* reading the notification" rule `readMarks.upsert`
already implements (`023`).

#### The trigger needs an UPDATE arm, and it must not close a cycle

Reviewed and independently verified 2026-08-07 against the running nodes.

**INSERT coverage is complete.** Both writers do plain `insert` (`003:131`,
`019:248`) and the server never touches the table directly (no
insert/update/delete over `packages/server/src`). A row trigger sees everything.

**UPDATE arm: needed, but the real surface is two functions, not eight.** Of the
eight `update … read_at` sites in `db/migrations`, five are dead — superseded by
`create or replace` at identical signatures. Checked against `pg_proc` rather
than inferred: only **`mark_read(uuid,text)`** (bulk, `023:123`) and
**`mark_notification_read(uuid,text,uuid,text)`** (`023:210`/`223`) are callable
by `tm8_app`. Note the revoked `mark_notification_read(uuid)` still *exists* and
is `security definer` — **a trigger covers it for free; caller-side maintenance
would not.** That alone settles trigger-vs-caller.

> ⚠ **CYCLE.** D5 already flips children *from* the thread. An UPDATE arm that
> derives the thread *from* its children closes the loop. **Guard on the
> null → non-null transition only.**
>
> That guard is correct **only because `read_at` is monotone write-once.**
> Verified: every `update … read_at` statement in `db/migrations` is
> `coalesce(read_at, …)` — `007:1976`, `007:2007`, `010:49`, `015:1623`,
> `015:1636`, `023:124`, `023:211`, `023:224` — and nothing anywhere sets it
> back to `null`. **Assert this in the migration header**, because the day
> someone ships "mark unread" the trigger stops being correct *silently*.
>
> ⚠ **Do not go hunting for eight call paths — five of those are dead.**
> Superseded by `create or replace` at identical signatures. Checked against
> `pg_proc`, only three functions still exist, and only **two** are callable by
> `tm8_app`: `mark_read(uuid,text)` and
> `mark_notification_read(uuid,text,uuid,text)`. The third,
> `mark_notification_read(uuid)`, is revoked-but-extant and `security definer`
> — which is *why* the trigger is the right home for this (a trigger covers it;
> caller-side maintenance would not). Surveying all eight is the conservative
> reading and the monotonicity conclusion is unaffected; the live surface is two.

**Performance: use a statement-level trigger with transition tables.** Both
nodes are **PostgreSQL 16.14** (verified on 5442 and 5443), so
`referencing old table … new table … for each statement` is available, and N row
firings against one thread row collapse to a single pass.

> ⚠ Statement-level triggers **cannot take a `WHEN` clause**, so the transition
> filter moves into the body — which is why it needs **`OLD TABLE` *and*
> `NEW TABLE` joined on `id`**. With `NEW TABLE` alone, every already-read row
> silently re-counts **and the tests still pass.**

Urgency is lower than it looks — `mark_read`'s bulk update is filtered to one
recipient's member-personal rows on one anchor, and 077 excludes channels, so
channel messages produce no rows at all today. The large-fan-out case arrives
with §D4 at step 6. **But pick the statement-level shape at step 5 anyway**:
retrofitting it at step 6 means replacing a trigger body other lanes may by then
carry arms of — precisely the trap §D5 just escaped.

**No DELETE arm is needed** provided the thread table mirrors the parent's FK
rules. Verified on the **running prod node** (`pg_constraint.confdeltype`), not
just the migration text:

| Column | Live rule |
|---|---|
| `recipient_member_id`, `recipient_team_member_id`, `space_id` | `c` — CASCADE |
| `target_entity_id`, `actor_id`, `activity_id` | `n` — SET NULL |

Mirror those three cascades and a thread dies with its children automatically.
This also **confirms finding 4 against the deployed database**, not merely
against `003`'s source. Treat `item_count` as a cache the badge does not depend
on.

**A bonus the derived approach buys.** Deriving thread read state *from* child
updates makes `023`'s teammate asymmetry — `mark_read` flips only rows where
`recipient_team_member_id is null` — correct **for free**. Writing
`threads.read_at` independently inside `mark_read` would mean re-implementing
that filter in a second place, and it would drift. Unread count for a badge is `count(*) where
threads.read_at is null`, which is a partial-index scan rather than a scan over
every message-derived row.

⚠ **Contract cost — TWO rows, not one.** Marking a thread read cannot reuse
`inbox.markRead`: its path is `PUT /v2/inbox/:notificationId/read`
(`catalog.ts:125`) and a thread is not a notification. D5 needs
**`inbox.threads.list` *and* `inbox.threads.markRead`**. The cascade below is
therefore paid **twice**, which makes the "baseline the suite first" advice more
important, not less. Known pins: `catalog-exhaustiveness.test.ts:43/119/121/154`,
`contract.test.ts:51/58`, `w1-amendment.test.ts:61/62`, and the OPERATIONS sha at
`discovery-operations.test.ts:111`.

**Adding one row to `packages/contract/src/catalog.ts`
turns ~20 tests red across five packages** — build-failing `cli/src/discovery/
operations.ts` first, then three hard-coded sha digests and a long list of count
pins. This is deliberate drift-guard behaviour, not breakage, but it costs hours
if discovered one failing run at a time. Baseline the suite *before* touching the
catalog, or a pin someone else already broke will read as yours.

### D6 — Fix `unreadCount` plumbing (Gap C)

Independent, small, and it is what makes D4's "channel volume stays in Tier 2"
actually true for a user rather than true only in the schema.

## 5. Suggested sequence

0. **Verify 077 on the running server.** ✅ **DONE — and it failed. See §9.**
   077 is deployed **nowhere**, and the migration numbering has a four-way
   collision that will hard-fail `db/migrate.mjs`. Read §9 before writing any
   migration for this design.
1. Gap C — `unreadCount` plumbing. Cheapest visible win, no dependencies.
2. `entity_subscriptions` + RLS + ledgered `subscriptions.set`.
3. Rewrite 077's watcher CTE to read effective-watchers. **Additive only** —
   077's header documents why `create or replace` of a shared body is unsafe
   while other lanes carry uncommitted arms.
4. D3 auto-watch on post.
5. `notification_threads` + the AFTER INSERT trigger + the thread list surface.
   Do the catalog baseline first, and budget **two** catalog rows (D5 warning).

   ⚠ **The backfill is real and this document previously priced it in two
   words.** §D2 rejects a pure subscription table *because* "a pure table needs
   a backfill for every entity that already exists" — and `notification_threads`
   needs exactly that for every existing `notifications` row. The circular FK
   (`threads.last_notification_id` → `notifications.id` while
   `notifications.thread_id` → `threads.id`) forces insert-then-update rather
   than one statement. This is not a reason to drop D5; it is a reason to price
   it before committing to a migration window.
6. D4 channel arm (`channel_message`). **Blocked on `member_of_channel`** —
   see §8.
7. Real UI groups — **bigger than "style `anchor_message`".** The group map is
   out of sync with the producer list and contains a key nothing can ever match:
   `groupOf` tests `kind === 'reply'` (`inbox-model.ts:76`) but **no producer
   emits `'reply'`** — the kind is `message_reply` (`019:485`), which
   `isDeliveryFailureKind`'s regex (`inbox-model.ts:68-70`) does not match
   either. So `replies` is a **dead group**, and `message_reply`, `award`,
   `unblock`, `approval_request` and `join` *all* fall to `other` today. §2.2's
   corrected table is the fix list.

Steps 1–5 have no dependency on the channels line and can start immediately.

## 6. Open questions

Question 1 of the first draft — the coalescing cursor trade-off — is **closed by
the D5 ruling**: no notification column is ever mutated, so no cursor races.

1. **Do agent personas hold their own subscriptions**, or inherit the owner's?
   **⚠ Revised after review — this is no longer a free choice.** Per §2.2.1 the
   two shipped writers *already disagree*: `internal.notify` (5 kinds) cannot
   populate `recipient_team_member_id` at all and collapses personas to their
   owner, while `w2_notify_actor` (3 kinds) routes to the persona. So assigning a
   task to a persona and posting a message on it put rows in **different
   inboxes** today. Whatever is decided here is therefore also a decision to
   **reconcile an existing inconsistency**, and the effective-watchers work
   (§5 step 3) will surface it whether or not it means to. Cost that in.
2. **Channel default** — silent until explicitly watched (recommended), or
   auto-watch a channel the first time you post in it? Note this interacts with
   §8: if `member_of_channel` is a derived watcher source, then *joining* a
   channel already subscribes you, and posting adds nothing.
3. **Is `notification_outbox` in scope?** "Gets informed" often means email or
   push, which is what that queue (`003:93`) was built for and what no worker
   currently drains.

## 7. Note on the stated future scope


> *"later we will see other status activities, for a future scope"*

Nothing here blocks that. `notifications.kind` is `text not null` with **no**
CHECK constraint (`003:79` — "Open by contract"); `NotificationItem.kind` is an
open union; `NotificationItemSchema` validates `z.string()`; and the UI routes
unknown kinds to `other` rather than dropping them. Status activities need **no
schema change** — only new producers and a UI group. The subscription model in
D2 is anchor-scoped, not message-scoped, so it serves those producers unchanged.

The thread model in D5 also carries forward without change: a status-activity
kind either merges on `anchor_id` (e.g. repeated status flips on one task) or
stands alone on its own id, and that choice is one entry in the fan-out's
`coalesce_key` rule rather than a schema change.

---

## 8. Convergence with `feature/Channels`

Work session `019fda6f-434d-77ac-a3da-0e643afe6084` (PR #44, branch
`feat/channels-authoring`) is building channels in parallel. **The two lines meet
at exactly one point, and they agree.**

### The overlap

That session filed subtask **`019fdaaa-4933-7467-8146-b36061d57fe0` — channel
members**, whose finding is identical to this document's Gap B, reached
independently:

> *"There is no membership anywhere on this node — this is not 'the UI does not
> show it yet'. No edge type … no column … no contract projection. Do NOT
> overload `pulled` (member→channel, 'Local projection/adoption', 001:903). It
> already means something else in the UI."*

Their shape: a **`member_of_channel`** edge (src `member|team_member`, dst
`channel`, props `{role, joinedAt}`); add/remove is plain
`edges.create`/`edges.delete`, so no new command. Two amendments they made after
this document's first draft cited the original spec:

- **A1 — the creator's membership is written by `create_channel`
  (`036:206`), not by `CreateEntityInput.connections`.** `create_channel`
  creates no edges today, so a client that forgets ships an empty roster and
  CLI/saga creates would never pass one. The RPC writes it (`role: 'owner'`,
  `ON CONFLICT DO NOTHING`); `connections` remains for adding *other* people at
  create time.
- **A2 — no new unique index.** `public.edges` already carries
  `unique (src_id, dst_id, type)` (`001:772`); idempotency is
  `ON CONFLICT DO NOTHING` at the write sites.

**`props.joinedAt` must be stored, not derived from `edges.created_at`** — and
the reason is this document's own §D3 rule. An *imported* membership (their
Slack subtask) has a row written today and a real join date months earlier.
Derived, every imported member looks like they joined at import time, and
"notify about messages after you joined, not backfilled" would then fire **the
entire imported history at everyone** — the exact failure the rule exists to
prevent, arriving through the mechanism meant to implement it. `joinedAt`
defaults to the edge's creation time when not supplied.

### The agreed division

**`member_of_channel` is the roster. `entity_subscriptions` is the inbox
override. They are different questions and both are needed.**

| Question | Answered by | Owner |
|---|---|---|
| Who is *in* `#design`? | `member_of_channel` edge | channels line |
| Does a message in `#design` reach my inbox? | effective-watchers (§D2) | this line |
| Can I stay in `#design` but silence it? | `entity_subscriptions` `muted` | this line |

**The join — CORRECTED 2026-08-07 after pushback from the channels line.**

This section first said `member_of_channel` becomes a **derived watcher source
for channel anchors**, via:

```
DERIVED(anchor) = created_by ∪ assigned_to ∪ member_of_channel(when kind='channel')   -- ✗ WRONG
```

**That was wrong twice, and it contradicted this document's own §D4.**

**(1) The expression can never evaluate.** `077:111-113` early-returns *before*
the watcher loop:

```sql
-- See the header: channels have read_marks, sessions have delivery.
if anchor_row.kind in ('channel', 'work_session') then
  return new;
end if;
```

So a channel anchor never reaches the watcher set at all. Adding a union arm to
a set that is never computed is a no-op; the real work would be **reversing a
documented exclusion**, which is a much larger claim than "add an arm".

**(2) A roster makes 077's stated objection worse, not better.** 077 declined to
notify *one* person (the creator) per channel line because channel traffic is
*"the highest-volume message class in the system"*. `member_of_channel` would
have it notify **everyone in the room** per line. The membership edge is the
opposite of an answer to that objection.

### The corrected join

**Membership is a Tier 2 input, not a Tier 1 derived watcher.**

| `member_of_channel` gives you | Tier |
|---|---|
| the channel in your sidebar; `read_marks` unread; a real `unreadCount` badge | **2 — ambient** |
| an inbox row per message | **not this** |

A channel message enters the **inbox** only via (a) an `@mention` — already
works — or (b) an **explicit `watching` subscription**. That is exactly what
§D4 said, and it **preserves** 077's exclusion instead of reversing it.

Consequences, all good:

- **§5 step 6 shrinks to "explicit watch only"** and stops being contentious.
- **This line no longer depends on `member_of_channel` at all.** Steps 1–7 are
  now fully independent of the channels line.
- 077's exclusion stands unamended, so no future reader finds its removal and
  reads it as a regression.

Should reversing the exclusion ever be revisited, it must answer 077's volume
objection *on 077's own terms* and cite it. The coalescing model in §D5 is the
only candidate answer this document has — one thread row per channel per person
rather than one per line — and even then it largely duplicates what `read_marks`
already provides, which is why it is **not** proposed here.

This supersedes §D4's suggestion to use `entity_subscriptions` as the channel
*membership* mechanism. That suggestion was written before the channels line's
subtask was read, and it was the weaker option: it would have made muting a
channel and leaving a channel the same operation, which is the same conflation
§D4 objected to in `pulled`. Membership is a roster; muting is a preference; you
must be able to do one without the other.

The channels subtask's own boundary — *"Membership is a roster, not an ACL"* —
extends cleanly: **membership is a roster, not an ACL and not a subscription —
but it is the default subscription.**

### Dependency direction, and what it does not block

This line **depends on** `member_of_channel` for step 6 only (the
`channel_message` arm). Steps 1–5 — `unreadCount` plumbing, subscriptions,
effective-watchers, auto-watch, and the whole `notification_threads` model — are
independent and should not wait.

The channels line does **not** depend on anything here. Nothing in this document
asks it to change its shape.

### Two operational facts inherited from that session

- **The `member_of_channel` half is a server change**, and no agent on this box
  can `systemctl restart tm8-staging.service`. Everything in this document
  except step 7 is likewise server-side. Plan for a human-run deploy.
- **CI red is the default here, not a signal** — `main`'s own run fails (no
  Postgres on the runner, plus a `@types/react` duplication in `packages/ui`).
  Do not read a red PR as evidence against this design.

---

## 9. Step 0 executed: 077 is deployed nowhere, and 076/077 are contested

Measured 2026-08-07 against the live databases. 077's own header demands that
landing evidence be *"a POSITIVE observation of rows appearing, never an absence
of errors."* This section is that observation, and it is negative.

### 9.1 The trigger does not exist on either running node

| Node | DB | Migration high-water mark | `messages_notify_anchor_watchers` |
|---|---|---|---|
| prod (7777) | `tm8_prod` @ 5442 | **075** | **absent** |
| staging (8888) | `tm8_staging` @ 5443 | **079** | **absent** |

`select proname from pg_proc where proname = 'w2_notify_anchor_watchers'` returns
zero rows on both. Only `w2_notify_actor` and `messages_fan_out_mentions` exist.

Staging being at 079 while *lacking* 077's trigger is not a contradiction — see
§9.3. Its 077 is a **different file**.

### 9.2 The defect 077 fixes is still live, and this task's own anchor proves it

```sql
select count(*) from public.messages
 where anchor_id = '019fda97-79f6-7d27-b347-69c54cd9d665';   -- 1
select count(*) from public.notifications
 where target_entity_id = '019fda97-79f6-7d27-b347-69c54cd9d665';  -- 0
```

One message posted to this very task; **zero** notifications. The task's creator
was not told. That is precisely the failure 077 was written for, reproduced on
prod today, on the ticket asking for an inbox.

Corroborating: staging's entire `notifications` table holds only `join` (11) and
`message_reply` (1). No `mention`, no `anchor_message` — the two message-driven
kinds — have **ever** been produced there.

### 9.3 ⚠ Four-way migration number collision — `migrate.mjs` will hard-fail

Three lines have independently claimed 076 and 077:

| № | `origin/main` | working checkout (`feat/local-folder-file-attach`) | staging deployed |
|---|---|---|---|
| 076 | `reply_delivery_targets` | `derived_from_props_schema` | `derived_from_props_schema` |
| 077 | `notify_anchor_watchers` | `collection_membership` | `core_draft_prompt_policy_repair` |
| 078 | — | — | `private_projects` |
| 079 | — | — | `account_git_credentials` |

**076 has two distinct files. 077 has three.**

> **Refined after review.** The reviewer independently checked *remote branches*
> and found none carrying a migration above 077 — **that is correct**. The two
> findings reconcile, and together they are worse than either alone: the
> contesting files are **untracked** in the working checkout
> (`git status` → `?? db/migrations/076_derived_from_props_schema.sql`,
> `?? 077_collection_membership.sql`), and staging's 077–079 were applied from a
> tree that is not any remote branch. **The collision is invisible to every
> git-based check.** `git ls-tree origin/main` shows max 077, so 078 looks free;
> it is taken. Verified by simulating the merge:
>
> ```
> FAIL: duplicate migration number 076: 076_derived_from_props_schema.sql and 076_reply_delivery_targets.sql
> FAIL: duplicate migration number 077: 077_collection_membership.sql and 077_notify_anchor_watchers.sql
> => migrate.mjs aborts BEFORE applying anything.
> ```
>
> **Rule: claim migration numbers at landing time, not design time**, and derive
> the next free number from the union of `origin/main`, the local tree, **and**
> `select filename from public.applied_migrations` on *both* DBs.

This is not a cosmetic clash. `db/migrate.mjs:127-133`:

```js
const files = entries.sort();
const seen = new Map();
for (const file of files) {
  const number = file.slice(0, 3);
  if (seen.has(number)) fail(`duplicate migration number ${number}: ${seen.get(number)} and ${file}`);
  seen.set(number, file);
}
```

The guard runs over the **whole directory before applying anything**, so the
moment any two of these lines land in one tree, `migrate.mjs` refuses to apply
*any* migration at all — including migrations that have nothing to do with the
collision. The next merge blocks every deploy until a human renumbers.

### 9.4 What this changes for this design

1. **Do not assume 077 works.** Everything in §4 that extends 077's watcher set
   must now also account for 077 itself not being live. The effective-watchers
   rewrite (§5 step 3) should be written so it is correct whether or not 077
   landed first — i.e. it must create the trigger if absent, not only replace
   its body.
2. **Do not pick a migration number yet.** 078 and 079 are taken by the staging
   line and invisible from `origin/main`. Any number chosen from `main` alone is
   a coin flip. Reconcile the numbering first, or take a number well clear of
   the contested band and expect to renumber at merge.
3. **The renumbering is not this task's job**, but it *is* this task's blocker,
   and it is a blocker for the `feature/Channels` line too — that line also needs
   a server migration (`member_of_channel`). Worth raising as its own ticket.

   ⚠ **The reconciliation is not `git mv`, and this is the part most likely to
   be missed.** `applied_migrations` keys on **FILENAME** (`003`-era ledger,
   confirmed live: `applied_migrations_pkey PRIMARY KEY, btree (filename)`). So
   renumbering `078_private_projects` → `081_private_projects` is not a rename —
   it is a file staging has **already applied** under the old name, and a naive
   renumber makes `migrate.mjs` apply it a second time. Whoever reconciles needs
   a **ledger-fixup step against a live database**, not just a file move.

   Corroborating detail from the channels line, independently derived: the
   deployed staging *tree* is itself clean (75 files, 75 distinct prefixes), so
   nothing is broken **right now** — each line can still migrate on its own. The
   breakage arrives strictly when two lines meet. Union max today is **079**, so
   080 is the first free number; neither line has claimed it, deliberately, so
   the reconciliation can own numbering rather than two feature tickets racing.
4. **Both running nodes need a human-run deploy** for any of this to take
   effect. No agent on this box can `systemctl restart` either service.

---

## 10. Review record

Adversarially reviewed 2026-08-07 against `origin/main` @ `7631e08` by the
**Inbox Design Reviewer** teammate (`019fdb51-a367-7901-be3c-40d98efe599b`,
session `019fdb51-be63-7ce9-9416-b57fefe1b897`). Verdict: **SOUND WITH FIXES** —
thesis survives, eleven findings, five of which were schema defects that would
have shipped.

All eleven are applied above. The load-bearing ones:

| # | Finding | Where fixed |
|---|---|---|
| 1 | *"Single writer"* was false — `internal.notify` (`003:118`) writes 5 of 8 kinds and cannot populate `recipient_team_member_id` | §2.2, §2.2.1, §6 Q1 |
| 2 | Thread list is the "third cursor producer" `inbox-read-marks.ts` warns about; `updated_at` is *more* collision-prone than `created_at` | §D5 |
| 3 | Maintaining threads "in the fan-out" was non-additive, violating the rule §5 step 3 cites | §D5 — moved to AFTER INSERT trigger |
| 4 | FK cascade chain reversed `003:75`'s deliberate `on delete set null` and deleted inbox history | §D5 |
| 5 | `001:900-935` is not the complete edge registry — there are 7 insert sites | §3 Gap A |
| 6 | Contract cost is **two** catalog rows, not one | §D5 |
| 7 | `notification_threads` had no RLS, and `w1-foundations.test.ts:362-371` would not catch it | §D5 |
| 8 | `entity_subscriptions` had no unique constraint; D3's upsert had nothing to conflict on | §D2 |
| 9 | `replies` is a dead UI group — `groupOf` tests `'reply'`, producers emit `'message_reply'` | §5 step 7 |
| 10 | Gap C cited `spaces.ts:60-74`; the per-channel value is at `:221`/`:233` | §3 Gap C |
| 11 | Citation drift: `award` is `004:59`, `notification_outbox` `003:93`, edges trigger `003:184` | §2.2 |

**The reviewer's single highest-value change** — moving thread maintenance into
an AFTER INSERT trigger on `public.notifications` — fixed three of the top four
findings with one edit, and is adopted.

**Its second point is worth preserving as a lesson, not just a fix:** the
sentence *"there is one writer"* is what made findings 1(a) and 1(b) invisible.
A confident negative claim (*"nothing else inserts"*, *"there is no edge for
X"*) is the most dangerous kind of premise in this codebase, because it closes
the search. Findings 1 and 5 were both of that form, and both were wrong while
their conclusions happened to survive.

**Still open after review:** step 0's deploy gap (§9) is closed as a
*measurement* — 077 is live nowhere, confirmed on both DBs — but the underlying
deploy and the migration renumbering are unresolved and are not this document's
to resolve.
