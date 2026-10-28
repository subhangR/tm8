# Bridges — a provider conversation as a tm8 entity

**Status:** DESIGN v1 · 2026-10-28 · task `01a182ac-746a-75f2-beef-9690a26f21b3` ("Bridge as an entity")
**Basis:** `origin/main` @ `fcc49604b`; the Phase-1 WhatsApp bridge (`integrations/whatsapp-bridge`, its `OPERATIONS.md`, and the Phase-1 design of 2026-10-19); the kind precedents `space_link`/`server` (migrations 250, 261), `mcp_server` (296, ADR 0297), channel members (080), `agent_runtime` sessions (105); *The Capability Model*; `docs/identity/IDENTITY-DESIGN.md`; `docs/architecture/01-LAWS.md`.
**Scope:** the entity model, the contract, the runtime seam, security, the UI, the provider matrix, the migration from Phase 1 and the build order. No code is written here.

> The ask (Subhang, 28 Oct): *"thinking of making bridge as tm8 entity. A bridge connects a channel from a provider to a tm8 session or chat. Different bridge types: WhatsApp, Facebook, Slack, etc. Space members and bridge-channel members link, so a channel member can act as a member in the tm8 space. A space can have multiple bridges: multiple WA groups, Slack channels, Instagram accounts."* And, during the work: *"see tm8 chat, session and channel — a bridge can be to any one of them."*

---

## 0. The design in one page

**Five nouns, one new kind.**

| Noun | What it is | Stored as | Who makes it |
|---|---|---|---|
| **provider** | A messaging network tm8 can speak: `whatsapp`, `telegram`, `slack`, `discord`, `instagram`, `messenger`, later `email`, `sms`. A **closed, code-defined vocabulary**, exactly as capabilities are. Each has a *driver* and a *capability sheet* (§5). | code | tm8 |
| **connection** | One authenticated account on a provider: a linked WhatsApp number, a Slack app installed in a workspace, a Telegram bot. Holds the secret. | a node-level record owned by the human's **account**, sealed under the node key; **offered to a space as a `credential` entity** (server-only, like `mcp`) | a human, in Settings |
| **bridge** | **The new kind.** One provider conversation (a WhatsApp group, a Slack channel, an Instagram DM thread) bound to **one tm8 target**. | `bridge` entity + `public.bridges` detail row | a space admin, in Settings or from the target's panel |
| **target** | The tm8 side: a **chat**, a **work_session** or a **channel** — existing kinds, untouched. | the `bridged_to` edge, server-written | — |
| **participant** | A person on the provider side as seen on a bridge, optionally **linked** to a tm8 identity. | per-bridge side-table rows (presence) + an identity-level link table (who they are) | the bridge (presence), the person or an admin (the link) |

**The picture.**

```
 PROVIDERS                 CONNECTIONS                BRIDGES (new kind)                 TARGETS (existing)
 ─────────                 ───────────                ──────────────────                 ──────────────────
 WhatsApp group "Infra" ─┐                           ┌─ bridge: Infra ──bridged_to──▶  chat  "Infra main"  ──launches──▶ sessions (handles)
 WhatsApp group "Gaming" ─┼─ +91 …9494 (credential) ─┼─ bridge: Gaming ─bridged_to──▶  chat  "Gaming main"
 WhatsApp self chat ─────── +91 …1999 (credential) ──── bridge: Self ───bridged_to──▶  chat  "Self"
 Slack #deploys ─────────── Slack app @ acme (cred) ─── bridge: #deploys ─bridged_to─▶  channel  #deploys        (mirror, both ways)
 Slack DM with Rahul ────── (same connection) ───────── bridge: Rahul DM ─bridged_to─▶  work_session "Release 1.4"
 Instagram DMs ──────────── IG @brand (credential) ──── bridge: IG inbox ─bridged_to─▶  chat  "Support"

 PEOPLE: a sender on any bridge is a participant. A participant who proves "this number is me" is LINKED to a
 tm8 identity, and from then on their messages are authored AS THAT MEMBER in every space they belong to.
```

**The seven decisions that shape everything else** (the full list with alternatives is §8):

1. **A bridge is one conversation to one target**, not one account and not one provider. Accounts are connections; providers are code. (D1)
2. **The target is any of chat, work_session, channel**, and the kind decides the default behaviour: a chat *answers*, a session is *delivered to*, a channel is *mirrored*. (D2)
3. **The conversation lives in the graph.** Every provider message is a tm8 `message` on the bridge's *log anchor* (the channel when the target is a channel, otherwise the bridge itself). The Phase-1 SQLite log and `/history`, `/search` HTTP API are retired; agents use `tm8 message list` and `tm8 search`. (D3)
4. **People are attributed, never invented.** A linked participant's message is authored *as that member* (with `via: {bridgeId}`); an unlinked participant's message is authored by the **bridge** as a guest, with the participant's name on it. No member rows are created for strangers. (D4)
5. **Links are proofs.** A code-verified link belongs to the *identity* and works in every space; an admin-asserted link belongs to *one space*. (D5)
6. **Agents speak through tm8, not through the bridge.** `tm8 message reply` on a bridged message crosses to the provider; speaker tokens, briefings with token files and the loopback HTTP API disappear. (D8)
7. **Approvals never cross a bridge.** A sensitive action a provider message asked for is an attention request, resolved in the tm8 UI by a human session — now enforceable rather than a briefing rule. (D9)

**What this changes for the people using the Phase-1 bridge today.** Nothing in their WhatsApp groups. In tm8: the four groups and the self chat become five `bridge` entities you can open, read live, reply in and manage; trusting a sender becomes a link instead of a config edit and a restart; adding a group becomes a wizard; a second number becomes a second connection, not a second container deploy.

---

## 1. Why an entity, and which entity

### 1.1 What Phase 1 keeps outside the graph

The Phase-1 bridge works, and everything it knows is invisible to tm8. Read from `integrations/whatsapp-bridge/OPERATIONS.md` and `src/config.ts`:

| Phase-1 state | Where it lives | Cost |
|---|---|---|
| Which groups exist, which space and main chat each maps to | `config.json` `channels[]`, per instance | Adding a group is a config edit and `deploy.sh`; a second number is a second container with its own `instances/<inst>/` |
| Who may trigger agents, who is TRUSTED | `allowedSenders`, `trustedSenders` (JIDs) | "Turning trust on is an access change: the operator confirms it in the tm8 UI first", then edits a file and **restarts** |
| The group's history, searchable | `data/bridge.sqlite` + FTS5 | A second message store, which `SESSION-COMMUNICATION-MODEL.md` §1.7 forbids for chat and which tm8 search cannot see |
| Who is who (names/handles for chats and sessions) | `names` table | Invisible to the space; briefed into transcripts |
| How an agent speaks | speaker token files + `POST /say` on `127.0.0.1:8787` | Tokens in briefings, rotation jobs, "the container and the agent sessions run as the same uid, so file permissions can't hide `data/`" |
| How the bridge writes into another space | a **human** token pinned to that space (`secrets/tm8-token-<id>`), because `chat start` is human-only | A human credential on disk, expiring 2027-01-17, acting as Subhang |
| Form answers from group members | submitted with the channel's token plus a `wa_respondent` question | "tm8 has no submit on behalf of" |
| Media | uploaded as `file` entities, but **not** attached, because the chat runtime fails a turn whose trigger has attachments | A known runtime defect worked around in the bridge |

Every row is the same shape: a relationship or a fact about people and conversations, held in a side store because there was no entity to hang it on. *"Work nobody can see has not happened"* applies to configuration too.

### 1.2 The entity test

T-L3's test is whether the four universal capabilities pay rent. For a bridge they all do:

- **Discuss it** — the bridge's discussion *is* the provider conversation, mirrored. Opening the bridge shows the WhatsApp group, live, in tm8.
- **Link it** — to its target (`bridged_to`), to the credential it rides on, to the sessions it has named, to the tasks that came out of it (`authored_from` already records that a task was made during a chat).
- **React to it**, **follow it**, give it a chip, a card, a panel and a place in the Home rail.
- **Parent it** — no. A bridge is flat (`hierarchical: false`, like `credential` and `space_link`). A Slack thread is a reply chain, not a sub-bridge.

### 1.3 The granularity decision

Three candidates were weighed:

| Candidate | What one entity would be | Why not |
|---|---|---|
| one bridge per **provider** | "the WhatsApp bridge" | A space has four WhatsApp groups with four different targets, teammates and policies. One entity cannot carry four routings without re-inventing `channels[]` inside its content. |
| one bridge per **account** | "+91 …9494" | Same problem one level down. And an account outlives any one group: it is a *credential*, which tm8 already models, seals, shares and revokes. |
| one bridge per **conversation ↔ target** | "Infra → Infra main" | Matches the ask word for word ("connects a channel from a provider to a tm8 session or chat"). One routing, one policy, one people roster, one health. Matrix's bridges call this a *portal*; tm8 calls it what the user calls it. |

**Chosen: one bridge = one provider conversation bound to one tm8 target.** The account becomes a **connection** (§2.5); the provider becomes code.

### 1.4 The name

The kind is `bridge`, because that is the product word and the word the user uses. Two collisions, both resolved rather than avoided:

- `tm8 help bridge` today prints *"Reserved Phase-2 cross-node blob path — no public command"*: one catalogued, never-implemented operation `bridge.fetchBlob`, whose own help says *"use instead: files.download"*. It is retired at the next catalog version and the noun is given to bridges. (D11)
- `01-LAWS.md` T-L1/T-L6 call the node↔node protocol client "the bridge block". That is an internal name; the code already calls it `packages/server/src/remote` (`link-client.ts`, `link-forwarder.ts`). No law changes; a glossary line in `01-LAWS.md` notes that the user-facing kind `bridge` is a different thing from the T-L6 remote link.

---

## 2. The model

### 2.1 A bridge, field by field

The `bridge` content arm (the `EntityDetail` content union in `packages/contract/src/contract.ts`):

```ts
| { kind: 'bridge';
    provider: BridgeProvider;                       // 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'instagram' | 'messenger'
    /** The space credential (shape 'connection') this bridge rides on — like a chat's credentialSelection. */
    connectionCredentialId: EntityId;
    conversation: {
      externalId: string;                           // the provider's id: a JID, a Slack channel id, an IG thread id
      kind: 'group' | 'channel' | 'dm';
      title: string;                                // as the provider names it, refreshed by the runtime
      memberCount: number | null;
    };
    /** The tm8 side. Also the `bridged_to` edge; carried here so a list row needs no second read. */
    target: { kind: 'chat' | 'work_session' | 'channel'; id: EntityId; title: string };
    policy: BridgePolicy;                           // §2.3
    status: 'live' | 'degraded' | 'paused';         // SERVER-OWNED, derived (T-L12); 'ended' is the tombstone
    health: { connection: 'linked' | 'connecting' | 'logged_out' | 'offline';
              lastInboundAt: string | null; lastOutboundAt: string | null;
              queued: number; failed24h: number; detail: string | null };
    people: { participants: number; linked: number; guestsSeen7d: number };
    handles: number;                                // live handles (§2.4)
    retentionDays: number | null;                   // null = keep (Q2)
  }
```

```ts
interface BridgePolicy {
  /** Which inbound messages reach the target as a turn/delivery. Everything is still logged. */
  trigger: 'mention' | 'every' | 'none';
  direction: 'both' | 'in' | 'out';
  /** Which tm8-side messages cross to the provider: replies to bridged messages (+ chat turn answers), or every message on the target. */
  outbound: 'replies' | 'all';
  whoMayTrigger: 'linked' | 'anyone';
  /** How outbound text is signed on providers with one sender identity: "Title (handle): …" / "tm8: …", or bare. */
  voice: 'named' | 'plain';
  /** One line, ≤ 300 chars, rides every inbound envelope. Phase-1 `style`. */
  style: string | null;
}
```

Defaults derive from the target kind and the conversation kind (§2.2). The server validates the shape in SQL exactly as `internal.validate_mcp_definition` validates a connector (296): a definition-time error, never a dead button.

### 2.2 The target: chat, session or channel

One bridge, one target, three kinds — and the kind decides what "bridging" means. This is the axis the user added, and it is the whole behavioural model:

| | target = **chat** | target = **work_session** | target = **channel** |
|---|---|---|---|
| **An inbound message becomes** | a message on the chat → **a turn**; the chat's teammate answers | a message anchored on the session → the stored-first **PTY delivery** with the `tm8.incoming-message` envelope (`CHAT-SYSTEM-DESIGN.md` §A) | a message anchored on the channel: **a mirror**, authored as the linked member or as a guest |
| **Who answers** | the teammate, every turn | the session, by `tm8 message reply` | nobody unless mentioned; a mentioned teammate who is a channel member gets it in their inbox (`SESSION-COMMUNICATION-MODEL.md` §1.6) |
| **What crosses back** | the turn's final answer (the Phase-1 relay rule, now the rule) + any reply on a bridged message + anything sent `--to <bridge>` | replies on bridged messages + anything sent `--to <bridge>` | every message posted on the channel (`outbound: all`), unless `direction: in` |
| **Log anchor** (where the full conversation is stored) | the bridge | the bridge | **the channel itself** |
| **Default policy** | `trigger: mention` (`every` for a DM), `direction: both`, `outbound: replies`, `whoMayTrigger: linked` | same as chat | `trigger: none`, `direction: both`, `outbound: all`, `whoMayTrigger: linked` |
| **Handles** | sessions the chat launches get handles and become addressable (§2.4) | the session itself has the handle | none |
| **Phase-1 equivalent** | a channel's **main chat** | a **named session** | — (the Slack-import design's "sync") |
| **Typical use** | "@tm8 in the Infra group" | steer one long job from Slack; escalations land where the work is | Slack `#deploys` ↔ tm8 `#deploys`; a WhatsApp group humans in tm8 want to read and answer |

Two rules hold across kinds:

- **The log anchor rule.** `logAnchor = target.kind === 'channel' ? target : bridge`. Every inbound message is stored **once**, on the log anchor. A routed message to a chat or session is a **batch copy** — the existing multi-anchor `messages.post` with `anchorIds: [logAnchor, target]` and one `messageBatchId` — so the bridge copy and the chat copy are the same message by correlation, and a reply to either resolves to the same provider message.
- **The target is retargetable but single.** `bridges.retarget` moves the `bridged_to` edge (the Phase-1 "epoch rollover" with a new main chat becomes "retarget to a new chat", or simply nothing, since chat continuity exists since migration 332). Two bridges may not share a conversation (unique per connection, node-wide — the Phase-1 "a group is served by exactly one number" rule, enforced in SQL).

### 2.3 Messages: one store, two directions

**Inbound.** The connector runtime hands the server one `inbound` per provider message (§2.5). The server:

1. dedupes on `(connectionId, externalMessageId)` — at-least-once from the runtime, exactly-once in the graph;
2. resolves the **author** (§2.4): linked → the member; unlinked → the bridge as guest;
3. stores the message on the log anchor, with media as `file` entities attached and a voice transcript as a message part;
4. records `message_origins` (external ids, reply chain, sender display, direction `in`);
5. applies `trigger`/`whoMayTrigger`: if the message routes, posts the batch copy to the target. A copy to a chat starts a turn; a copy to a session is delivered.

**Outbound.** A message is queued to the provider when any of these is true and `direction` allows it:

- it **replies to a bridged message** (anywhere that message was copied — the batch id makes the chat copy and the log copy one message);
- it is posted **on the log anchor** by a member or an agent (`tm8 message send --to <bridge-id>`; for a channel target, on the channel);
- it is a chat target's **turn answer** to a routed message (the Phase-1 "fallback relay" promoted to the rule, including its credential-shaped-text refusal);
- `outbound: all` and it is on the target.

Queued means a `bridge_outbox` row with idempotency = the message id, dispatched to the runtime, settled with the provider's message id. The states are the delivery ledger's words — `pending → dispatching → sent | failed_retryable | failed_permanent` — and ride the message as a `bridge.delivery` badge: *sent to WhatsApp 10:42*, *queued (WhatsApp reconnecting)*, *failed: too long*.

**Voice.** On a provider with one sender identity (WhatsApp linked device) outbound text is signed `Title (handle): …` for a session, `tm8: …` for a chat, `Name: …` for a human member typing in tm8 — the Phase-1 convention, under `policy.voice`. On a provider with per-message impersonation (Slack `username`/`icon_url`, Discord webhooks) the author appears as themselves and no prefix is added.

**What an agent sees.** The existing `tm8.incoming-message` envelope gains one element and loses nothing:

```xml
<trusted_control type="tm8.incoming-message" version="1" message_id="…" anchor_id="…">
  <from actor_id="…" source_session_id="" />
  <origin kind="bridge" bridge_id="…" provider="whatsapp" conversation="Infra"
          participant="Rahul" trust="linked|asserted|guest" external_message_id="3EB0…" />
  <style>short and readable: lead with the answer…</style>
  <reply command_ref="tm8://help/message/reply" anchor_id="…" parent_message_id="…" />
</trusted_control>
<untrusted_data type="message-body" …>@tm8 is the deploy done?</untrusted_data>
```

The body is data. `trust` tells the agent how far to take the sender at their word, exactly as Phase 1's bracket label did, now from a verified link rather than a config list. No URL, no token, no briefing: to answer, `tm8 message reply <message-id>`; to start a thread, `tm8 message send --to <bridge-id>`; to read the room, `tm8 message list <log-anchor>`; to find something, `tm8 search`; to know who is who, `tm8 bridge people <bridge-id>`.

### 2.4 People: participants, links, trust, handles

**Participants** are presence rows, one per `(bridge, externalId)`: display name, avatar reference, alternate ids (a WhatsApp number and its LID), first/last seen, message count, muted flag. They are not entities — a stranger in a group does not deserve a chip — and they are not members. They appear on the bridge's **People** tab, masked (`+91 …9494`) for members, unmasked for space admins.

**Links** say who a participant *is*:

```
bridge_identity_links(provider, external_id, identity_id,
                      method 'code' | 'invite' | 'admin',
                      space_id null,              -- null = identity-scoped (code, invite); set = space-scoped (admin)
                      asserted_by_member_id, verified_at, revoked_at)
```

| How a link is made | Who proves what | Scope |
|---|---|---|
| **Code** — the member opens Account → *Linked identities* → *Link WhatsApp* and gets `TM8-4F7K` (10 min, one use); they send `/link TM8-4F7K` from their phone, in any bridged conversation or as a DM to the connection's number. | The person at the phone saw the member's tm8 screen. | **identity** — works in every space the identity is a member of |
| **Invite** — an admin picks a guest on the People tab → *Invite to space*; the bridge DMs them a join link minted by `spaces.invites.create` with the participant pinned to it; redeeming the invite completes the link. | The person who joined is the person who got the DM. | **identity** |
| **Admin assertion** — an admin picks a guest → *This is <member>*. Shown everywhere as *asserted*, never as *verified*. | Only that the admin said so. | **space** — an admin of one space cannot make a number count as someone in another space (that would be cross-space impersonation) |

Resolution on every inbound message: `(provider, external_id)` → an unrevoked identity-scoped link, else a space-scoped link for *this* space → that identity's **active** member row in the bridge's space → author as that member, `trust = linked | asserted`. No match → guest. A member who left (`members.status = left/removed`, 232) is a guest again.

**What a link grants, exactly.** Attribution — the message is theirs, in their name, with their avatar; the trust word the agent reads; the right to trigger agents where `whoMayTrigger: linked`; and **form answers submitted as themselves** (`forms.submit` with the member as actor — the Phase-1 `wa_respondent` question goes away). It grants **no permission the member does not already hold**, and it never grants the agent anything: a triggered agent acts with its own persona under its owner's authorization, as always.

**Handles** are the Phase-1 names registry, per bridge: `bridge_handles(bridge_id, handle, entity_id, kind 'chat'|'work_session', title, status, created_at)`. Readable adjective-animal words, unique per bridge, never reused. The server records one when the target chat launches a session (`launched_by`, 330) and when a session asks (`tm8 bridge handle claim`). `@keen-otter …` or a reply to keen-otter's message routes to that session; an ended session's handle routes to the target chat with a note, as Phase 1 does.

### 2.5 Connections and the runtime

**A connection is a credential.** The secret of a linked WhatsApp device is a directory of key material that is *rewritten on every session* (Baileys' multi-file auth state); a Slack installation is a bot token; a Telegram bot is a token. tm8 already has the right place for this: the sealed space-credential store, with ADR 0297 as the precedent for a server-only provider (`mcp`) and `docs/features/session-credentials/03-principal-and-storage.md` §3.2 for the "node-local bytes, DB holds metadata" option that refresh-in-place needs. So:

- `bridge_connections` is a **node-level** table owned by an **account** (the human who scanned the QR or installed the app): `id, provider, owner_account_id, label, external_account_id, status, runtime_id, state_ref, created_at, last_seen_at`. `state_ref` names a sealed blob on the node (`<dataDir>/bridges/<connectionId>/`, 0700, AES-GCM under the node key), never a row in the graph and never in any read route.
- A connection is **offered to a space** by its owner: `bridges.connections.offer` creates a `credential` entity in that space with `provider = 'whatsapp'`, `shape = 'connection'`, metadata `{connectionId}`, visibility private or space, status, readiness — one more server-only provider in the list beside `typesafe | mcp | tool`. The spawn reader refuses it like the others: **a connection is never injected into a session.**
- The owner must be a member of the space they offer to. Revoking the credential pauses every bridge on it in that space; removing the connection logs the device out and ends them all.

This is what replaces Phase 1's per-space human tokens: the bridge never acts as Subhang in the lvlup space; it acts as itself, and the people it relays are attributed by their links.

**The runtime.** The provider protocol runs in a **connector runtime**: one supervised sidecar process per provider per node (the Postgres sidecar and the PTY host are the pattern), holding the provider sockets for every connection of that provider and speaking one small internal protocol to tm8-server over loopback. The existing Baileys container becomes the WhatsApp runtime, refactored to the protocol and shorn of its SQLite, poller, outbox, forms and HTTP API — all of which move to the server.

The runtime authenticates with a **`bridge_runtime` auth session**, minted by the node when it starts the sidecar (the `agent_runtime` precedent, 105): no persona, no work session, no space pin, and an op allow-list of exactly the `bridgeRuntime.*` doors. It cannot call `messages.post`; it calls `bridgeRuntime.inbound`, and *that* door is the only path in tm8 that writes a message authored as a member without the member's own credential — through `internal.bridge_resolve_author(bridge_id, sender_external_id)` and nothing else.

The protocol (JSON over loopback HTTP + one WS for push):

| Direction | Frame | Meaning |
|---|---|---|
| runtime → server | `hello {provider, version, capabilities}` | the capability sheet, once |
| runtime → server | `connection.state {connectionId, status, detail}` | linked / connecting / logged_out / offline |
| runtime → server | `connection.auth {connectionId, qrPng | pairingCode, expiresAt}` | relayed to the **requesting member only** as an ephemeral event; never stored |
| runtime → server | `conversation.list {connectionId, items[]}` | for the wizard's picker (today's `--list-groups`) |
| runtime → server | `inbound {connectionId, conversationId, externalMessageId, sender, body, media[], replyTo, reaction?, ts}` | idempotent on the external id; media as bytes or a fetch handle |
| runtime → server | `sent {outboxId, externalMessageId}` · `send.failed {outboxId, reason, retryable}` | settles the outbox row |
| runtime → server | `link.claim {connectionId, conversationId, senderExternalId, code}` | a `/link` message; never routed as text |
| server → runtime | `connect {connectionId, authFlow}` · `disconnect` | lifecycle |
| server → runtime | `send {outboxId, conversationId, text | media | poll, replyTo, voice}` · `react` · `typing` | the outbox |
| server → runtime | `conversation.list {connectionId}` · `media.fetch {handle}` | reads |
| both | `heartbeat` | every 30 s; three misses mark every bridge on the runtime `degraded` |

Health is **derived once on the server** from heartbeats and connection states and delivered identically to every consumer (T-L12): `bridge.status` and `bridge.health` are never computed in the UI.

### 2.6 Many spaces, many numbers

| Rule | Enforced by |
|---|---|
| A provider conversation is served by **one bridge, node-wide** | `unique (connection_id, external_conversation_id)` on `public.bridges` |
| A connection can serve bridges in **many spaces** | one offered `credential` per (connection, space) |
| A space can have **many connections and many bridges** | nothing to enforce; the Settings page lists them by provider |
| A bridge lives **in its target's space** | `bridges.create` checks it; the `bridged_to` edge is same-space like every edge |
| A **second number** is a second connection on the same runtime | the runtime multiplexes connections; no second container, no second port |

---

## 3. Contract and data

### 3.1 The kind row and its capabilities

```sql
insert into public.entity_kinds(kind, origin, space_id, icon) values ('bridge', 'core', null, 'bridge')
on conflict (kind) where space_id is null do nothing;
```

Capabilities, in the tri-state the capability model gives core rows (explicit, measured): `discussable: true` (the conversation), `linkable: true`, `reactable: true`, `hierarchical: false`, `assignable: false`, `workflowed: false` (status is derived, not a workflow), `spawnable: false` (a bridge is added to the UI's `NOT_LAUNCHABLE` denylist — you do not *run* a bridge). Kind group **Talk**, between `channel` and `chat` in `CORE_KIND_INFO`:

```ts
bridge: { group: 'talk', summary: 'a conversation on another network (WhatsApp, Slack, …) bound to a chat, a session or a channel here', createWith: ['bridge create'] },
```

### 3.2 Tables

```sql
-- the entity's detail row (space-level)
create table public.bridges (
  entity_id                uuid primary key references public.entities(id) on delete cascade,
  space_id                 uuid not null references public.spaces(id),
  provider                 text not null,
  connection_id            uuid not null references public.bridge_connections(id) on delete restrict,
  credential_id            uuid not null references public.entities(id),            -- the offered credential in this space
  external_conversation_id text not null,
  conversation             jsonb not null,            -- {kind, title, memberCount}
  target_kind              text not null check (target_kind in ('chat','work_session','channel')),
  target_id                uuid not null references public.entities(id),
  policy                   jsonb not null,            -- validated by internal.validate_bridge_policy
  paused_at                timestamptz,
  retention_days           integer,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (connection_id, external_conversation_id)                                 -- one bridge per conversation, node-wide
);

-- node-level, account-owned; holds NO secret bytes, only where the sealed blob is
create table public.bridge_connections (
  id uuid primary key, provider text not null, owner_account_id uuid not null,
  label text not null, external_account_id text,                                    -- masked on every read
  status text not null check (status in ('connecting','linked','logged_out','offline','removed')),
  runtime_id text, state_ref text, created_at timestamptz not null default now(), last_seen_at timestamptz
);

-- presence, per bridge
create table public.bridge_participants (
  bridge_id uuid references public.bridges(entity_id) on delete cascade,
  external_id text not null, alt_external_ids text[] not null default '{}',
  display_name text, avatar_ref text, muted boolean not null default false,
  first_seen_at timestamptz not null, last_seen_at timestamptz not null, message_count integer not null default 0,
  primary key (bridge_id, external_id)
);

-- who a provider identity IS (§2.4)
create table public.bridge_identity_links (
  provider text not null, external_id text not null, identity_id text not null,
  method text not null check (method in ('code','invite','admin')),
  space_id uuid references public.spaces(id) on delete cascade,                     -- null = identity-scoped
  asserted_by_member_id uuid, verified_at timestamptz not null, revoked_at timestamptz,
  unique (provider, external_id, coalesce(space_id, '00000000-0000-0000-0000-000000000000'::uuid))
);
create table public.bridge_link_codes (code text primary key, identity_id text not null, provider text not null,
  expires_at timestamptz not null, used_at timestamptz);

-- handles (§2.4), outbox (§2.3), provenance (§2.3)
create table public.bridge_handles (bridge_id uuid, handle text, entity_id uuid, kind text, title text,
  status text not null, created_at timestamptz not null default now(), primary key (bridge_id, handle), unique (bridge_id, entity_id));
create table public.bridge_outbox (id uuid primary key, bridge_id uuid not null, message_id uuid not null unique,
  external_reply_to text, payload jsonb not null, status text not null, attempts integer not null default 0,
  external_message_id text, created_at timestamptz not null default now(), settled_at timestamptz);
create table public.message_origins (message_id uuid primary key references public.messages(id) on delete cascade,
  bridge_id uuid not null, connection_id uuid not null, direction text not null check (direction in ('in','out')),
  external_message_id text not null, external_conversation_id text not null, external_sender_id text,
  external_reply_to_id text, external_ts timestamptz,
  unique (connection_id, external_message_id, direction));
```

Flavours, in T-L3's terms: `bridges` is a kind detail table; `bridge_connections` is **config** (node-level, like `server_connections` of 044); `bridge_participants` and `bridge_identity_links` are **per-member/per-person state** (the `space_link_tokens` precedent: a member's own row on a shared entity); `bridge_outbox` and `message_origins` are **operational**. None of them encodes a relation between entities — the one relation, bridge → target, is the `bridged_to` edge.

RLS: `bridges`, `bridge_participants`, `bridge_handles`, `message_origins` follow 218's shape (`exists over entities_select`). `bridge_identity_links` is readable by the identity it names and by admins of the space it is scoped to; identity-scoped rows surface to a space only through the resolver, never as a list. `bridge_connections` is readable by its owner account and by node admins; a space sees it only through its offered credential.

### 3.3 Edges

| type | direction | written by | meaning |
|---|---|---|---|
| `bridged_to` | bridge → chat \| work_session \| channel | server (`bridges.create`, `bridges.retarget`) | the tm8 side of the bridge |
| `authored_from` | entity → chat/session | server (exists) | unchanged; a task made in a bridged chat already records it |
| `attached_to`, `relates_to` | any → bridge | agent (exist) | `bridge` joins their `dst_kinds` |

No `has_participant` edge: participants are not entities (§2.4).

### 3.4 Operations

Catalog rows in the `spaceLinks.*` / `mcp.servers.*` idiom. **Human-only** is the SQL gate (`internal.require_human_auth_kind`), marked `humanOnly: true` in the catalog so the CLI and UI say so before the call.

| operation | method · path | kind | who |
|---|---|---|---|
| `bridges.list` | GET `/v2/spaces/:spaceId/bridges` | read | member |
| `bridges.get` | GET `/v2/bridges/:bridgeId` | read | member |
| `bridges.create` | POST `/v2/spaces/:spaceId/bridges` | command | **space admin, human-only** |
| `bridges.update` | PATCH `/v2/bridges/:bridgeId` | command | admin (policy, style, retention) |
| `bridges.retarget` | POST `/v2/bridges/:bridgeId/retarget` | command | admin, human-only |
| `bridges.pause` · `bridges.resume` | POST `/v2/bridges/:bridgeId/pause|resume` | command | admin |
| `bridges.remove` | POST `/v2/bridges/:bridgeId/remove` | command | admin, human-only (the generic `entities.delete` is refused, as for `space_link`, so outbox and links never outlive the entity quietly) |
| `bridges.participants.list` | GET `/v2/bridges/:bridgeId/participants` | read | member (masked) / admin (full) |
| `bridges.participants.update` | PATCH `/v2/bridges/:bridgeId/participants/:externalId` | command | admin (mute, assert link, invite) |
| `bridges.links.begin` | POST `/v2/me/bridge-links` | command | **any member, human-only** — mints a code for the caller's own identity |
| `bridges.links.list` · `bridges.links.revoke` | GET · POST `/v2/me/bridge-links[/…/revoke]` | read · command | the identity itself; admins for space-scoped rows |
| `bridges.handles.list` | GET `/v2/bridges/:bridgeId/handles` | read | member |
| `bridges.handles.claim` | POST `/v2/bridges/:bridgeId/handles` | command | a session launched from the target (server checks `launched_by` lineage) |
| `bridges.connections.list` | GET `/v2/me/bridge-connections` | read | the owner; node admins see all |
| `bridges.connections.begin` | POST `/v2/me/bridge-connections` | command | **human-only**: starts a link/install flow; auth frames arrive on the caller's event stream |
| `bridges.connections.offer` · `.withdraw` | POST `/v2/me/bridge-connections/:id/offer` | command | the owner, human-only; creates/revokes the space credential |
| `bridges.connections.remove` | POST `/v2/me/bridge-connections/:id/remove` | command | the owner, human-only; logs out, ends its bridges |
| `bridges.conversations.list` | GET `/v2/me/bridge-connections/:id/conversations` | read | the owner (the wizard's picker; a live call to the runtime) |
| `bridges.forms.deliver` | POST `/v2/bridges/:bridgeId/forms/:formId` | command | member or agent in the space; the Phase-1 `POST /form` |
| `bridgeRuntime.hello` · `.inbound` · `.state` · `.sent` · `.linkClaim` · `.heartbeat` | POST `/v2/bridge-runtime/…` | command | **`bridge_runtime` sessions only**; refused to every other auth kind |

There is deliberately **no `bridges.say`**: speaking is `messages.post` on the log anchor or a reply, so that a human in the browser, an agent in a session and a chat turn all cross the bridge by the one public communication door (T-D23).

### 3.5 CLI

```text
tm8 bridge list [--provider <p>] [--target <entity-id>]
tm8 bridge get <bridge-id>
tm8 bridge create --connection <credential-id> --conversation <external-id> --to <chat|session|channel id>
                  [--trigger mention|every|none] [--direction both|in|out] [--outbound replies|all]
                  [--who-may-trigger linked|anyone] [--voice named|plain] [--style <one line>]
tm8 bridge update <bridge-id> [same flags] --expect-version <n>
tm8 bridge retarget <bridge-id> --to <entity-id> --expect-version <n>
tm8 bridge pause|resume|remove <bridge-id> --expect-version <n>
tm8 bridge people <bridge-id> [--guests|--linked]               # who is who, masked unless admin
tm8 bridge assert <bridge-id> <external-id> --member <member-id> # admin: space-scoped link
tm8 bridge invite <bridge-id> <external-id> [--role member]      # admin: DM a join link; link completes on redeem
tm8 bridge handles <bridge-id>
tm8 bridge handle claim <bridge-id> [--title <≤4 words>]         # from a session launched off the target
tm8 bridge link begin --provider whatsapp                        # me: prints TM8-4F7K, 10 min
tm8 bridge link list | revoke <provider> <external-id>
tm8 bridge connection list | begin --provider <p> | offer <id> --space <space-id> | withdraw | remove
tm8 bridge conversations <connection-id>                         # the picker, from the terminal
tm8 form create … && tm8 bridge deliver-form <bridge-id> <form-id>
```

Speaking needs no new verb: `tm8 message reply <message-id> "<text>"` answers in the provider thread; `tm8 message send --to <bridge-id> "<text>"` opens a new one.

### 3.6 Events

`WorkspaceEvent` gains `bridge.updated` (content/status), `bridge.health` (coalesced, at most one per bridge per 10 s), `bridge.delivery {messageId, status, externalMessageId}` and the **member-addressed** ephemeral `bridge.connection.auth {connectionId, qr | pairingCode, expiresAt}` (the `recipient_member_id` mechanism `personal_style.updated` already uses, so a QR never reaches another member's stream).

### 3.7 The one non-additive contract change

`ActorSummary.kind` gains `'bridge'`, and `via` gains optional `bridgeId` and `participant {displayName, avatar?}`:

```ts
kind: 'member' | 'team_member' | 'work_session' | 'bridge';
via?: { sessionId?: EntityId; bridgeId?: EntityId; participant?: { displayName: string; avatar?: string | null } };
```

A linked participant's message is `{kind:'member', …, via:{bridgeId}}` — truthful for a consumer that ignores `via`. A guest's message is `{kind:'bridge', id: <bridge>, displayName: 'Infra (WhatsApp)', isAgent:false, via:{bridgeId, participant:{displayName:'Rahul'}}}` — a consumer that ignores `via` renders the bridge as the author, which is also true. The precedent is the `work_session` value, added 2026-08-05 for the same reason: *"the two-value union forced the resolver to mint them as a false human."* Inventing a member for a stranger would be that defect again.

---

## 4. UI integration

### 4.1 Where bridges appear

| Surface | What |
|---|---|
| **Home rail → Talk** | *Bridges* beside Channels and Chats: chips with the provider mark, the conversation title, a status dot-and-word |
| **Settings → Bridges** (`/settings/bridges`) | the management home (`KindConfig.settingsHome`), the only place the human-only doors live: connections, the add-bridge wizard, policy, pause, remove |
| **The bridge panel** (Z3/Z4) | Conversation · People · Routing · Health, plus the standard Connections tab |
| **Chat, session and channel panels** | a header chip *Bridged from WhatsApp · Infra* (links to the bridge); bridged bubbles carry the provider badge and the participant; the composer says when a message will cross; a *Bridge this…* primary action opens the wizard with the target pre-filled |
| **Account → Linked identities** | my WhatsApp / Slack / Telegram identities, link with a code, revoke |
| **Inbox / Attention** | requests raised from a bridge say *from WhatsApp · Rahul (guest)* and are resolvable only here |
| **Mobile** | the same list, panel and link flow; the QR flow is desktop-first (the phone is the other device) |
| **Entity Help** | a `bridge` kind page in `entity-help/kinds/` with the story beats in §4.7 |

### 4.2 Settings → Bridges

Built on `SectionFrame` per `settings-space/SECTION-CONTRACT.md`: one scroller, no inline padding, every enabled control on `LIVE_VERBS` with the operation that makes it live.

```
┌ Bridges ─────────────────────────────────────────────────────────────── [+ Add bridge] ┐
│ CONNECTIONS                                                              [+ Link a new account] │
│  ◍ WhatsApp  +91 ···· 9494   linked · seen 12s ago      4 bridges   owner: Subhang   [⋯]        │
│  ◍ WhatsApp  +91 ···· 1999   linked · seen 3s ago       1 bridge    owner: Subhang   [⋯]        │
│  ⌗ Slack     acme.slack.com  needs sign-in              0 bridges   owner: Subhang   [Sign in]  │
│                                                                                                   │
│ BRIDGES                                                                                           │
│  provider   conversation            →  target                      people        status          │
│  WhatsApp   Infra (group, 14)       →  💬 Infra main (Opus)        9 · 3 linked  ● live           │
│  WhatsApp   🕹️ Gaming (group, 31)   →  💬 Gaming main (Coordinator) 22 · 1 linked ● live          │
│  WhatsApp   Subhang self chat (dm)  →  💬 Self                      1 · 1 linked  ● live           │
│  Slack      #deploys (channel)      →  # deploys                    —            ◌ paused         │
│  Slack      DM · Rahul              →  ▶ Release 1.4 (session)      1 · 1 linked  ▲ degraded: Slack socket closed 2m │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

A row opens the bridge's panel; the status column is colour **and word** (tokens.css: *status is ALWAYS color + word, never color alone*). A connection row's `⋯` offers *Offer to another space*, *Re-link* (QR/pairing code modal fed by `bridge.connection.auth` events), *Remove*. The QR modal says what Phase 1's `link.sh` says in a terminal: which phone, where in WhatsApp to tap, and that the code lasts about two minutes.

### 4.3 The add-bridge wizard

Three steps, one `bridges.create` at the end (nothing is committed before step 3; cancelling leaves nothing — the `EditEntityDialog` rule).

1. **Connection** — pick one of the account's offered connections, or *Link a new account* (provider picker → the provider's own flow: QR / pairing code for WhatsApp, OAuth install for Slack, token paste for Telegram/Discord).
2. **Conversation** — a live list from `bridges.conversations.list` with search; groups, channels and DMs grouped; a conversation already bridged anywhere is shown greyed with *bridged in <space> → <target>*.
3. **Target** — three cards: **Chat** (pick an existing chat, or *New chat* with teammate, model, mode — the chat is created from the browser, human-only as `chat.start` requires), **Session** (a live session in the space), **Channel** (existing, or *New channel* with the conversation's name slugged). Below, the policy derived from the choice, editable: trigger, direction, who may trigger, voice, style. The copy under each card is the row of §2.2 in one sentence.

Launching the wizard from a chat, session or channel panel skips step 3.

### 4.4 The bridge panel

```
┌ ◍ Infra · WhatsApp ───────────────────────────── ● live · 14 in group · bridged to 💬 Infra main ┐
│ Conversation │ People │ Routing │ Health │ Connections                                            │
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│  Rahul · guest · 10:41                                                                            │
│  @tm8 is the deploy done?                                                        ↳ routed to Infra main │
│                                                                                                   │
│  tm8 (Infra main) · 10:41                                                            ✓ sent 10:41 │
│  Yes — 1.4.2 is live since 10:30. Nothing failed.                                                 │
│                                                                                                   │
│  Subhang · linked ✓ · 10:42                                                                       │
│  nice, ship the changelog too                                                                    │
│                                                                                                   │
│  Release notes (keen-otter) · 10:44                                                   ✓ sent 10:44 │
│  Changelog is up: …                                                                               │
├───────────────────────────────────────────────────────────────────────────────────────────────────┤
│  Reply in WhatsApp as Subhang…                                   [attach] [poll ▾]        [Send] │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Conversation** is the log anchor's thread (the bridge's own discussion, or the channel's). Inbound bubbles show the participant with a *guest* / *linked ✓* / *asserted* word; outbound bubbles show the delivery state. A *routed to …* trailer on a bubble links to the turn it started. The composer is the normal composer; its placeholder says where the message goes.
- **People** is the participant roster: avatar, name, masked id, last seen, message count, link state; per row *This is me* (member), *This is…* (admin assert), *Invite to space*, *Mute*, *Unlink*. A linked row shows the member chip.
- **Routing** is the target card with *Retarget*, the policy as labelled controls, the handles table (handle · title · entity chip · live/ended) and the style line.
- **Health** is the connection state, last inbound/outbound, queued and failed counts, the runtime's last words, and the last 20 outbox rows — the `managed` block pattern of the `space_link` panel (`reads` with columns), not a new component.

### 4.5 Bridged messages everywhere else

In a chat, session or channel, a bridged bubble carries a small provider mark and *via WhatsApp*; a guest's avatar is initials in the idle tone, a linked member's is their own avatar with the mark overlaid. Replying to a bridged bubble defaults the composer to *Reply in WhatsApp* with a one-tap switch to *Reply here only*. An agent's turn answer in a bridged chat shows the delivery tick under it. The chat header chip *Bridged from WhatsApp · Infra* opens the bridge.

### 4.6 Linking, as the member sees it

Account → Linked identities → *Link WhatsApp*:

```
┌ Link your WhatsApp ──────────────────────────────────────────────┐
│ Send this from your phone, in any bridged group or to +91 ···· 9494:
│
│        /link TM8-4F7K          expires in 9:41
│
│ When it arrives, your messages from that number count as you —
│ here and in every space you are in. You can unlink any time.
└──────────────────────────────────────────────────────────────────┘
```

The row flips to *Linked · +91 ···· 0001 · verified 28 Oct* the moment the runtime's `link.claim` matches. The admin's *This is…* on the People tab is the other door, labelled *asserted* wherever it shows.

### 4.7 Registry and plumbing checklist

- `domain/registry.ts`: a `bridge` row — `label 'Bridge'`, `slug 'bridges'`, `strategy 'collection'`, `defaultMode 'list'`, `hiddenModes ['board','gallery','tree']`, `chip {glyph:'⌒', tintBy:'none'}`, `card {fields:['bridgeProvider','bridgeTarget','bridgeStatus','bridgePeople']}`, `settingsHome {section:'bridges', label:'Manage in Bridges'}`, `list quickCreate:false`, `panel {archetype:'generic', blocks:[conversation, managed BRIDGE, people, routing, health, settings-home]}`; `NOT_LAUNCHABLE` gains `bridge`.
- `domain/kind-art.ts`: a drawn mark — two posts and an arc between them, 16×16, stroke 1.4, no silhouette shared with `space_link`'s chain or `channel`'s hash (asserted by `kind-art.test.ts`).
- `domain/kind-nouns.ts`: `bridge: { nouns: ['bridge'], commands: ['message send', 'message reply', 'message list', 'form create'] }`.
- `routes/types.ts`: `SETTINGS_ROUTE_SECTIONS` gains `'bridges'`; `settings-space/` gains `BridgesSection.tsx` on `SectionFrame`, with a `port.ts` like `settings-space-links/port.ts` so fixtures and a real node are indistinguishable.
- `entity-help/kinds/bridge.tsx`: logline *"A conversation from another network, living here as a first-class thing you can read, answer and manage."* Beats: *Why one per conversation* · *How it is born* (a human, in Settings) · *Who is speaking* (linked vs guest) · *How agents answer* (a `TypedTerminal` of `tm8 message reply`) · *What never crosses* (approvals, secrets) · *How it ends*.
- Provider marks: `mcp/connector-logos.tsx` is the precedent for a logo table; bridges reuse it (`whatsapp`, `slack`, `telegram`, `discord`, `instagram`, `messenger`).
- `LIVE_VERBS`: a delimited block for the section, each verb named for the operation that makes it live.

---

## 5. Providers

The vocabulary is closed and each provider declares what it can do; the UI shows only what the sheet allows (a poll button only where polls exist; a thread reply only where threads exist).

| provider | connection flow | inbound transport | needs a public URL? | threads | reactions | polls | media | per-user voice | DMs | status |
|---|---|---|---|---|---|---|---|---|---|---|
| **WhatsApp** (linked device, Baileys) | QR or pairing code | the device socket | no | quotes | yes | native | yes, voice notes + local transcript | no (one number) | yes | **Phase 1 shipped → runtime refactor (B1)** |
| **Telegram** (bot) | token from BotFather | long polling | no | reply quotes | yes | native | yes | no | yes (user must message the bot first) | B4: the cheapest second driver, a sanctioned API, proves the protocol |
| **Slack** (app) | OAuth install (bot token) + Socket Mode | Socket Mode websocket | no | yes | yes | no (Block Kit buttons) | yes | **yes** (`username`/`icon_url`) | yes | B4/B5: the channel-target showcase; converges `SLACK-IMPORT-DESIGN.md` |
| **Discord** (bot) | token + gateway | gateway websocket | no | threads | yes | no | yes | **yes** (webhooks) | yes | later |
| **Instagram DM**, **Messenger** (Meta Graph) | Meta app review + page token | **webhooks** | **yes** | no | yes | no | yes | no | DM only | needs the relay (below) |
| **WhatsApp Cloud API** (official) | Meta business account | webhooks | yes | quotes | yes | no | yes | no | yes | the sanctioned WhatsApp path when the ban risk of the linked device is unacceptable |
| **Email** | IMAP/SMTP | polling | no | by headers | no | no | yes | from-name | n/a | later |

**Socket providers first.** WhatsApp Web, Telegram long polling, Slack Socket Mode and the Discord gateway are all *outbound* connections, which is what this deployment allows (`SLACK-IMPORT-DESIGN.md`: nginx binds loopback and Tailscale only and must not grow a `0.0.0.0` listener). **Webhook providers** (Meta, Twilio) need a public HTTPS endpoint, and the law already says where that lives: the **gateway** block owns routing and relay and never graph data (T-L8). A hub receives the webhook, verifies the provider signature, and relays the frame to the home node's runtime over the existing node↔hub link. Nothing provider-specific enters the gateway beyond signature verification.

**The ToS note stands.** The linked-device WhatsApp driver is unofficial and the number can be banned (Phase-1 design §1, accepted for a personal account). The provider sheet carries `sanctioned: false` for it and the Settings row says so; the Cloud API driver is the sanctioned alternative on the same bridge model.

---

## 6. Security

| Threat | Control |
|---|---|
| The connection secret (device keys, bot tokens) leaks through the graph, a read route or a session | Sealed node-local bytes, metadata-only rows, no read-value operation at any privilege (ADR 0297; `03-principal-and-storage.md` §3.2). The offered `credential` is server-only: the spawn reader refuses it in SQL and TS like `mcp`/`tool`. `guard_manifest_secrets` patterns cover `bridge_connections.state_ref`. |
| The runtime is compromised and writes as anyone | Its `bridge_runtime` session reaches only `bridgeRuntime.*`; `inbound` authors through `bridge_resolve_author` and can name no actor; it cannot create entities, start chats, spawn, or touch credentials. Revoking the session stops it at the next call. |
| Impersonation: a stranger types as a member | Authorship follows **links**, and a link is a proof (code/invite) or an admin's space-scoped assertion shown as such. Participants are never auto-matched by display name or phone-book name. |
| Cross-space impersonation by an admin | Admin assertions are space-scoped (§2.4). Only the identity's own code proof is identity-scoped. |
| Prompt injection from a provider message | The body is `untrusted_data` in the same envelope every tm8 message already uses; `trust` and `participant` ride the trusted control block; the agent's posture rules are unchanged. |
| A provider message asks for something destructive | Approvals are attention requests resolved by a browser/CLI session only; `bridgeRuntime.*` cannot resolve one, and neither can a `bridge` actor. (D9) |
| Message loops (bridge echoes its own output) | `message_origins` matches the runtime's echo of an outbound message to its outbox row (external id, then content hash as Phase 1 does for media captions); mention text in outbound bodies is escaped per provider. |
| Spam and provider rate limits | Per-bridge and per-connection token buckets on the server outbox (Phase-1 numbers: 20/min per speaker, 30/min per conversation), 429-style refusal to the sender with the retry-after on the message's delivery badge. |
| PII (phone numbers, handles) | Masked in every content field and every member-level read; full ids only on admin reads and in the participant row; retention per bridge (Q2) runs through the existing retention job. |
| A logged-out device, a dead socket | Heartbeats → `degraded` on every bridge of the runtime within 90 s; an attention request (`fyi`) to the connection's owner; inbound is queued by the provider, outbound by the outbox. Nothing is retried blind. |
| Two bridges on one conversation (double routing) | `unique (connection_id, external_conversation_id)`. |
| The agent sessions and the runtime share a uid (Phase-1 "limits of the lockdown") | The runtime owns no secrets a session could use (no speaker tokens exist), its blob is sealed under the node key the server holds, and it runs as its own uid under the supervisor. |

---

## 7. Migration from Phase 1, and the build order

### 7.1 What each Phase-1 piece becomes

| Phase 1 | Phase 2 |
|---|---|
| `config.json` `channels[]` | `bridge` entities (one per channel), created by an import command from the live config, targets = the existing main chats (`mainChatId`) |
| `instances/<inst>/`, two containers, two ports | one WhatsApp runtime, two **connections**, both owned by Subhang's account, offered to the spaces that use them |
| `tm8.tokenFile`, `secrets/tm8-token-<id>` (human tokens pinned to other spaces) | gone; the runtime's `bridge_runtime` session + offered credentials |
| `ownerJids`, `trustedSenders`, `allowedSenders` | links (Subhang's number: code-verified once, identity-scoped; others: admin-asserted per space) + `whoMayTrigger` |
| `names` table, token files, briefings, `rebrief-*` | `bridge_handles`; no tokens; the envelope's `origin` block; the kind help page |
| SQLite log + FTS, `/history`, `/search`, `/message` | messages on the log anchor; `tm8 message list`, `tm8 search`; an optional one-shot backfill of the SQLite log as messages with `message_origins` |
| `POST /say`, `/say-media`, `/react`, `/form`, `/names`, `/sync` | `tm8 message reply|send`, attachments, reactions, `tm8 bridge deliver-form`, `tm8 bridge handles`; nothing to sync — the server is the registry |
| the fallback relay, the watchdog's 👀/⚠️ reactions, the escalation and delegate rules | the chat-target outbound rule; the watchdog stays (a routed message with no answer in N minutes reacts ⚠️ and raises `fyi` attention on the bridge); the rules move into the teammate's skill/persona, where briefing text belongs |
| `media.attach: "reference"` workaround | fix the runtime defect (`HarnessSessionBase.reserve` refusing `attachmentRefs`) in B2 so bridged media are real attachments |

### 7.2 Phases

| phase | delivers | removes from Phase 1 |
|---|---|---|
| **B0 Contract & kind** | migration (kind row, tables, `bridge_runtime` auth kind, `bridged_to`, `bridge_resolve_author`, policy validator), contract types, catalog rows, CLI nouns, `ActorSummary` change, events; fixtures | nothing yet |
| **B1 WhatsApp runtime** | the Baileys container speaks the connector protocol; connections, QR/pairing over events; inbound → graph; outbox → provider; import command for the live config; both numbers on one runtime | SQLite log, poller, names, speaker tokens, `/say` family, per-space human tokens |
| **B2 UI** | Settings → Bridges (connections, wizard), the bridge panel, bridged bubbles and delivery ticks, header chips, Home rail, kind help; the attachment fix in the chat runtime | `rebrief-*` admin commands |
| **B3 People** | links (code, invite, admin), People tab, Account → Linked identities, forms as linked respondents, retention | `trustedSenders`, `allowedSenders`, `wa_respondent` |
| **B4 Second provider** | Telegram driver in the runtime framework (sanctioned API, proves the protocol is provider-neutral); the provider sheet drives the UI | — |
| **B5 Channel target & Slack** | Slack driver with Socket Mode; channel-target mirror both ways with per-user voice; the Slack-import one-shot becomes "bridge, then backfill" | `SLACK-IMPORT-DESIGN.md` deferred items |
| **B6 Relay** | gateway webhook relay; Meta DM providers; WhatsApp Cloud API | — |

B0 and B1 are one lane each and can start together against the protocol document; B2 starts on fixtures the day B0's contract lands.

### 7.3 Acceptance for B0 + B1

1. `tm8 kind list` shows `bridge` under Talk; `tm8 entity create bridge` is refused with *use `tm8 bridge create`*.
2. Importing the live `config.json` yields five bridges whose targets are the existing main chats; `tm8 bridge list` shows them `live` within 90 s of the runtime starting.
3. A WhatsApp message in the Infra group appears on the Infra bridge within 5 s, authored as the bridge with the participant's name; `@tm8 …` additionally starts a turn on Infra main; the turn's answer arrives in the group signed `tm8: …` and shows *sent* on the chat copy.
4. `tm8 message reply <id> "text"` from a session launched off Infra main lands in the group quoting the right message, signed `Title (handle): text`.
5. No speaker token file exists; `curl 127.0.0.1:8787/say` is gone; the runtime's session can call `bridgeRuntime.inbound` and is refused `messages.post` with `forbidden`.
6. Stopping the runtime marks every bridge `degraded` within 90 s and raises one `fyi` attention request to the connection owner; restarting clears it without duplicates.
7. The same WhatsApp message delivered twice by the runtime stores one message.
8. No read route returns `state_ref` bytes, a token, a QR or a pairing code; the QR event reaches only the requesting member's stream.
9. `pg_dump` of the graph contains no provider secret (asserted by the existing secret-pattern test extended to `bridge_connections`).

---

## 8. Decisions

| # | Decision | Alternatives considered | Why this one |
|---|---|---|---|
| D1 | One bridge = one provider conversation ↔ one tm8 target | per provider; per account | §1.3: routing, policy, people and health are per conversation; the ask says "connects a channel" |
| D2 | Target ∈ {chat, work_session, channel}; semantics by kind; one target, retargetable | chat only (Phase 1); a list of targets | the user's addition; one target keeps "who answers" unambiguous; sessions are reached through handles, not extra targets |
| D3 | The conversation is graph messages on a log anchor; no shadow store | keep SQLite + HTTP reads | `SESSION-COMMUNICATION-MODEL.md` §1.7; tm8 search; the bridge panel *is* the room |
| D4 | Linked → authored as the member via the bridge; guest → authored by the bridge | guest `member` rows; a per-bridge persona; a new `participant` kind | no false humans (the `work_session` precedent); participants fail the entity test |
| D5 | Code/invite links are identity-scoped; admin assertions are space-scoped | all identity-scoped; all space-scoped | an admin of one space must not be able to make a number count as someone elsewhere; a verified proof should not be repeated per space |
| D6 | Connections are node-level, account-owned, sealed; offered to spaces as server-only credentials | a `connection` kind; a space-level secret table | ADR 0297 and 044→261: metadata in the graph, bytes on the node; refresh-in-place; reuse of readiness, sharing, revocation and the human-only boundary |
| D7 | Connector runtimes are supervised sidecars with a `bridge_runtime` principal; routing and policy live on the server | drivers in-process; the runtime keeps routing | native deps and provider sockets stay out of the server; the server owns derived truth (T-L12); one protocol for every provider |
| D8 | Agents speak through `messages.*`; speaker tokens and the HTTP API are retired | keep `/say` as a fast path | one public communication door (T-D23); no secrets in briefings; delivery state on the message |
| D9 | Approvals never cross a bridge | trusted senders may approve | identity on a provider is "only as strong as the phone number" (OPERATIONS.md); the UI is the authenticated surface |
| D10 | Socket providers first; webhook providers through the gateway relay | open a public listener on the node | the deployment rule; T-L8 puts relay in the gateway and nowhere else |
| D11 | The kind and CLI noun are `bridge`; `bridge.fetchBlob` is retired | `connector`, `portal`, `channel_bridge` | the product word; the reserved op was never implemented and names its own replacement |
| D12 | Bridges are flat, not assignable, not launchable, discussable | hierarchical bridges for threads | threads are replies; nothing to assign; nothing to run |
| D13 | Bridges live in Talk | Runtime (with `mcp_server`, `space_link`) | a bridge is where conversations come from; its runtime is a health fact, not its nature |

---

## 9. Open questions (with recommendations)

| # | Question | Recommendation |
|---|---|---|
| Q1 | Should a **chat-target** bridge mirror every group message onto the bridge, or only routed ones? | Every message. The record and the search are the point; routing is a policy on top. Groups run to hundreds of messages a day, which the message table carries easily. |
| Q2 | **Retention** of mirrored conversations (PII in the graph). | A per-bridge `retentionDays` (null = keep), enforced by the existing retention job; default null for groups the space owns, 90 days for DM bridges. |
| Q3 | May **guests trigger** agents by default? | No (`whoMayTrigger: linked`) for groups; yes for DM bridges, where the conversation is the point. Phase-1 groups configured `"everyone"` import as `anyone`. |
| Q4 | Should a bridge **backfill** history when created (Slack `conversations.history`, WhatsApp history sync)? | Offer it as an explicit step in the wizard (*Also import the last N days*), idempotent on external ids, never implicit. |
| Q5 | Does a **channel-target** bridge auto-add linked participants as channel `has_member`s? | Yes, when they are members of the space: the roster then reads truthfully. Guests are never channel members. |
| Q6 | Where does the **watchdog** live? | On the server, as a scheduler job (`scheduler/jobs/`) over `message_origins` and turns; it reacts on the provider through the outbox and raises `fyi` attention — no runtime logic. |

---

## 10. The design, read back against the laws

- **T-L2** — every surface here is an entity component (the bridge chip/card/panel), a collection view (the Bridges list, the People roster as rows of per-person state on one entity) or the two axes (the `bridged_to` edge; no hierarchy). The QR modal is stream UI inside a settings dialog, like the terminal canvas, and stores nothing.
- **T-L3** — one relation, one edge; every side table is config, per-person state or operational.
- **T-L4** — a bridge is a core kind with a typed detail table; providers are closed vocabulary, not `if (provider === …)` scattered through the UI: the capability sheet is data the registry reads.
- **T-L7** — the runtime has an identity (`bridge_runtime`) and authorship resolves through verified links; local is the degenerate case with one owner and one number.
- **T-L8 / T-L10** — relay for webhooks sits in the gateway; live bytes (QR frames) flow over the event socket and never through storage.
- **T-L11 / T-L12** — one contract, three transports; the server owns status, health and delivery truth; every mutation is idempotent on a client mutation id or an external message id.
- **T-D23** — all public communication is `messages.*`; the runtime's inbound door is an audited internal principal, like the delivery adapter's.
