# Bridges — a provider conversation as a tm8 entity

**Status:** FINAL (v4) · 2026-10-29 · the implementation design: approved by Subhang, with his review decisions of 2026-10-29 written in as D23–D30 (§8) · tasks `01a182ac-746a-75f2-beef-9690a26f21b3` ("Bridge as an entity", v1, 2026-10-28) and `01a188e7-cacc-7cac-b70c-cbe4a95e6672` (final)
**Companion:** [`BRIDGES-V2-DESIGN.md`](./BRIDGES-V2-DESIGN.md) (v2, 2026-10-29): UI gaps, memories and loops on a bridge, the WhatsApp command set. Where v2 changes something here, this document now says so in place and points to the v2 section; v2 holds the detail. Section numbers here are unchanged, so v2's "v1 §n" references still resolve.
**Basis:** `origin/main` @ `fcc49604b`; the Phase-1 WhatsApp bridge (`integrations/whatsapp-bridge`, its `OPERATIONS.md`, and the Phase-1 design of 2026-10-19); the kind precedents `space_link`/`server` (migrations 250, 261), `mcp_server` (296, ADR 0297), channel members (080), `agent_runtime` sessions (105); *The Capability Model*; `docs/identity/IDENTITY-DESIGN.md`; `docs/architecture/01-LAWS.md`.
**Scope:** the entity model, the contract, the runtime seam, security, the UI, the provider matrix, the migration from Phase 1 and the build order. No code is written here. Subagents and multi-agent workflows beyond independent workers are **out of scope** for now (§7.4). v1's open questions are settled (§8 D14–D19); D20 (one connection per group, 2026-10-29) left two new ones, Q7 failover and Q8 hand-over, settled on 2026-10-30 as D56 and D55 (§8, §9); D21 (2026-10-29) lets workers read and post on the bridge freely (§2.7); D22 (2026-10-29) puts an inherited `authored_from → bridge` provenance edge on everything a bridge causes (§2.8). **v4** (2026-10-29, Subhang's review of v3) adds D23–D30: space-wide worker access, with a handle as only an address (D23); the fix notice (D24); one chat per bridge, with the teammate as the shared part (D25); loops as scheduled teammates that post to many groups (D26); labels (D27); connected groups only (D28); agile work without new commands (D29); and cross-group provenance (D30). **§7.2 is the one build order** for v1 and v2.

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

**The seven decisions that shape everything else** (the full list with alternatives is §8; v2's are in its §6):

1. **A bridge is one conversation to one target**, not one account and not one provider. Accounts are connections; providers are code. (D1)
2. **The target is any of chat, work_session, channel**, and the kind decides the default behaviour: a chat *answers*, a session is *delivered to*, a channel is *mirrored*. (D2)
3. **The conversation lives in the graph.** Every provider message is a tm8 `message` on the bridge's *log anchor* (the channel when the target is a channel, otherwise the bridge itself). The Phase-1 SQLite log and `/history`, `/search` HTTP API are retired; agents use `tm8 message list` and `tm8 search`. (D3)
4. **People are attributed, never invented.** A linked participant's message is authored *as that member* (with `via: {bridgeId}`); an unlinked participant's message is authored by the **bridge** as a guest, with the participant's name on it. No member rows are created for strangers. (D4)
5. **Links are proofs.** A code-verified link belongs to the *identity* and works in every space; an admin-asserted link belongs to *one space*. (D5)
6. **Agents speak through tm8, not through the bridge.** `tm8 message reply` on a bridged message crosses to the provider; speaker tokens, briefings with token files and the loopback HTTP API disappear. (D8) Any worker in the space reads the whole conversation of any bridge and may post to it at any time; `@handle` directs a message to one, it is not the only way in (D21, D23, §2.7).
7. **Approvals never cross a bridge.** A sensitive action a provider message asked for is an attention request, resolved in the tm8 UI by a human session — now enforceable rather than a briefing rule. (D9)
8. **Only connected groups are ever touched.** A number touches only the conversations its owner connected one by one. Everything else is never read, forwarded, stored, logged, marked read or sent to. The server and the WhatsApp runtime both enforce this. (D28)

**What this changes for the people using the Phase-1 bridge today.** Nothing in their WhatsApp groups. In tm8: each connected group (seven today, all on one number) becomes a `bridge` entity you can open, read live, reply in and manage; trusting a sender becomes a link instead of a config edit and a restart; adding a group becomes a wizard; a second number becomes a second connection, not a second container deploy.

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
- **Link it** — to its target (`bridged_to`), to the credential it rides on, to the sessions it has named, to everything that came out of it: tasks, docs, sessions, memories and the rest each carry a server-written `authored_from → bridge` edge naming the message that started it, inherited through workers at any depth (D22, §2.8).
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
    handles: number;                                // space handles that have appeared on this bridge (§2.4, D23)
    retentionDays: number | null;                   // null = keep (D15)
    /** D25: the teammate this bridge runs as: its reply signature, and the default teammate for its chat, loops and workers. Many bridges may share one. */
    teammateId: EntityId | null;
    /** D25: one line on what the group is for; `tm8 bridge list` shows it so agents can pick targets without bridge ids. */
    purpose: string | null;
    /** D26: hold unprompted posts in this window, in the bridge's own `timezone` (v2 §5). Replies are never held. */
    quietHours: { start: string; end: string } | null;   // 'HH:MM'
    /** D23: workers may post here. A hard check in bridge_outbox, on by default. */
    workerPosting: boolean;
    // v2 §5 adds: pausedUntil, timezone, commands, workers, history
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

**One group, one bridge, one chat (D25).** A chat is the target of at most one bridge. `bridges.create` and `bridges.retarget` refuse a chat that already has one (`target_has_bridge`), so a reply on that chat always goes back to the group it came from. What groups share is the **teammate** (`teammateId`): one persona can run any number of bridges and chats. Group-specific facts are **bridge memories** (v2 §2.1); general know-how and shared doc conventions are **teammate memories**. Knowledge crosses groups freely: the teammate may use in group B what it learned in group A. A reply still goes only to its source group. With external groups that is a disclosure risk the space accepts for now; a later per-bridge `external` flag could wall such a group off and is not needed yet. Communities and announcement channels are out of scope (D28): a bridge is one group.

### 2.2 The target: chat, session or channel

One bridge, one target, three kinds — and the kind decides what "bridging" means. This is the axis the user added, and it is the whole behavioural model:

| | target = **chat** | target = **work_session** | target = **channel** |
|---|---|---|---|
| **An inbound message becomes** | a message on the chat → **a turn**; the chat's teammate answers | a message anchored on the session → the stored-first **PTY delivery** with the `tm8.incoming-message` envelope (`CHAT-SYSTEM-DESIGN.md` §A) | a message anchored on the channel: **a mirror**, authored as the linked member or as a guest |
| **Who answers** | the teammate, for every un-directed routed message; a directed one (`@handle`, a reply to a worker) is answered by that worker. Workers read the whole log and may also post unprompted (D21, §2.7) | the session, by `tm8 message reply` | nobody unless mentioned; a mentioned teammate who is a channel member gets it in their inbox (`SESSION-COMMUNICATION-MODEL.md` §1.6) |
| **What crosses back** | the turn's final answer (the Phase-1 relay rule, now the rule) + any reply on a bridged message + anything sent `--to <bridge>` | replies on bridged messages + anything sent `--to <bridge>` | every message posted on the channel (`outbound: all`), unless `direction: in` |
| **Log anchor** (where the full conversation is stored) | the bridge | the bridge | **the channel itself** |
| **Default policy** | `trigger: mention` (`every` for a DM), `direction: both`, `outbound: replies`, `whoMayTrigger: linked` (`anyone` for a DM, D16) | same as chat | `trigger: none`, `direction: both`, `outbound: all`, `whoMayTrigger: linked` |
| **Handles** | sessions the chat launches get handles: addressable, and able to read the bridge's log and post to it (§2.4, §2.7) | the session itself has the handle | none |
| **Phase-1 equivalent** | a channel's **main chat** | a **named session** | — (the Slack-import design's "sync") |
| **Typical use** | "@tm8 in the Infra group" | steer one long job from Slack; escalations land where the work is | Slack `#deploys` ↔ tm8 `#deploys`; a WhatsApp group humans in tm8 want to read and answer |

Two rules hold across kinds, and one for channel targets:

- **The log anchor rule.** `logAnchor = target.kind === 'channel' ? target : bridge`. Every inbound message is stored **once**, on the log anchor. A routed message to a chat or session is a **batch copy** — the existing multi-anchor `messages.post` with `anchorIds: [logAnchor, target]` and one `messageBatchId` — so the bridge copy and the chat copy are the same message by correlation, and a reply to either resolves to the same provider message.
- **The target is retargetable but single.** `bridges.retarget` moves the `bridged_to` edge (the Phase-1 "epoch rollover" with a new main chat becomes "retarget to a new chat", or simply nothing, since chat continuity exists since migration 332). The bridge's memories and loops move with it (v2 V1, §2.3). A conversation is connected **once per space** (D20): whichever member's number or account connects it, that one bridge is the group's only bridge in the space, so the group feeds exactly one main chat (or channel). Workers launched from the group keep their `@handles` (§2.4) and read and post on the bridge freely (D21, §2.7); that is unchanged by D20. Enforced in SQL by `unique (space_id, provider, external_conversation_id)`.
- **A channel target's roster follows its links** (D18). A linked participant who is an active member of the space is added to the channel as a `has_member`; guests never are.

### 2.3 Messages: one store, two directions

**Inbound.** The connector runtime hands the server one `inbound` per provider message, **from a connected conversation only** (D28). The server pushes each connection's allowlist (its live, unpaused bridges' conversation ids) to the runtime on `hello` and on every change. The runtime drops everything else before forwarding: nothing outside the list is read, stored, logged, marked read or forwarded, and a dropped message leaves at most a counter. The server checks the allowlist again on receipt and treats anything outside it as a runtime fault. The server:

1. resolves the bridge from `(connectionId, conversationId)`, then dedupes on `(bridgeId, externalMessageId)`: a message whose provider message id is already stored for that bridge is dropped, **whichever number delivered it** (D20) — at-least-once from the runtime, exactly-once in the graph, per bridge and not per connection;
2. resolves the **author** (§2.4): linked → the member; unlinked → the bridge as guest;
   - checks for a **command** (`/work`, `/stop`, … — v2 §4.1): a command is stored like any message but marked `command: true`, run server-side as the linked member, answered by a bridge notice, and **never** routed (step 5 is skipped);
3. stores **every** message on the log anchor, routed or not (D14), with media as `file` entities attached and a voice transcript as a message part;
4. records `message_origins` (external ids, reply chain, sender display, direction `in`);
5. applies `trigger`/`whoMayTrigger`: if the message routes, posts the batch copy to the target. A copy to a chat starts a turn; a copy to a session is delivered. Imported history (D17) is stored with `routed: false` and never reaches this step.

**Outbound.** A message is queued to the provider when any of these is true and `direction` allows it:

- it **replies to a bridged message** (anywhere that message was copied — the batch id makes the chat copy and the log copy one message);
- it is posted **on the log anchor** by a member or an agent (`tm8 message send --to <bridge-id>`; for a channel target, on the channel) — including a worker posting unprompted (D21; bounded by §2.7's per-worker limit and refused while paused);
- it is a chat target's **turn answer** to a routed message (the Phase-1 "fallback relay" promoted to the rule, including its credential-shaped-text refusal);
- `outbound: all` and it is on the target.

**Hard checks, the only limits (D23, D28).** `bridge_outbox` accepts a row only when all of these hold: the bridge is live (not removed); it is not paused; `direction` is not `in`; `workerPosting` is on, if the author is a worker (else `worker_posting_off`); and the (teammate, bridge), per-conversation and per-number buckets have room (§6). Access to read and post is otherwise space-wide (§2.7). The runtime checks a second time: it refuses to send anything to a conversation that is not on its allowlist. That covers text, media, reactions, polls, typing indicators and read receipts.

Queued means a `bridge_outbox` row with idempotency = the message id, dispatched to the runtime, settled with the provider's message id. The states are the delivery ledger's words — `pending → dispatching → sent | failed_retryable | failed_permanent` — and ride the message as a `bridge.delivery` badge: *sent to WhatsApp 10:42*, *queued (WhatsApp reconnecting)*, *failed: too long*.

**Voice.** On a provider with one sender identity (WhatsApp linked device) outbound text is signed `Title (handle): …` for a session, `tm8: …` for a chat, `Name: …` for a human member typing in tm8 — the Phase-1 convention, under `policy.voice`. On a provider with per-message impersonation (Slack `username`/`icon_url`, Discord webhooks) the author appears as themselves and no prefix is added.

**What an agent sees.** The existing `tm8.incoming-message` envelope gains one element and loses nothing:

```xml
<trusted_control type="tm8.incoming-message" version="1" message_id="…" anchor_id="…">
  <from actor_id="…" source_session_id="" />
  <origin kind="bridge" bridge_id="…" provider="whatsapp" conversation="Infra"
          participant="Rahul" trust="linked|asserted|guest" external_message_id="3EB0…"
          directed="true|false" unread="7" />   <!-- D21: unread = log messages since the reader's cursor -->
  <style>short and readable: lead with the answer…</style>
  <reply command_ref="tm8://help/message/reply" anchor_id="…" parent_message_id="…" />
</trusted_control>
<untrusted_data type="message-body" …>@tm8 is the deploy done?</untrusted_data>
```

The body is data. `trust` tells the agent how far to take the sender at their word, exactly as Phase 1's bracket label did, now from a verified link rather than a config list. No URL, no token, no briefing: to answer, `tm8 message reply <message-id>`; to start a thread, `tm8 message send --to <bridge-id>`; to read the room, `tm8 bridge log <bridge-id> --unread` (or `tm8 message list <log-anchor>`, §2.7); to find something, `tm8 search`; to know who is who, `tm8 bridge people <bridge-id>`.

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
| **Code** — the member opens Account → *Linked identities* → *Link WhatsApp* and gets `TM8-4F7K` (10 min, one use); they send `/link TM8-4F7K` from their phone in any connected conversation, or in a self chat the owner deliberately connected. A DM to the connection's number is never read (D28). | The person at the phone saw the member's tm8 screen. | **identity** — works in every space the identity is a member of |
| **Invite** — an admin picks a guest on the People tab → *Invite to space*; the admin gets a join link minted by `spaces.invites.create` with the participant pinned to it, and shares it themselves (the bridge never DMs anyone, D28); redeeming the invite completes the link. | The person who joined is the person who got the DM. | **identity** |
| **Admin assertion** — an admin picks a guest → *This is <member>*. Shown everywhere as *asserted*, never as *verified*. | Only that the admin said so. | **space** — an admin of one space cannot make a number count as someone in another space (that would be cross-space impersonation) |

Resolution on every inbound message: `(provider, external_id)` → an unrevoked identity-scoped link, else a space-scoped link for *this* space → that identity's **active** member row in the bridge's space → author as that member, `trust = linked | asserted`. No match → guest. A member who left (`members.status = left/removed`, 232) is a guest again.

**What a link grants, exactly.** Attribution — the message is theirs, in their name, with their avatar; the trust word the agent reads; the right to trigger agents where `whoMayTrigger: linked`; and **form answers submitted as themselves** (`forms.submit` with the member as actor — the Phase-1 `wa_respondent` question goes away). It grants **no permission the member does not already hold**, and it never grants the agent anything: a triggered agent acts with its own persona under its owner's authorization, as always.

**Handles** (D23) are addresses, not access. A handle is unique **per space**. The `bridge_handles(space_id, handle, entity_id, kind 'chat'|'work_session', title, status, created_at)` table carries `unique (space_id, handle)` and `unique (space_id, entity_id)`. The `bridge_handle_appearances(space_id, handle, bridge_id, first_at, last_at)` table lists the bridges a handle has appeared on. Handles are readable adjective-animal words, never reused. A session gets one on its first post to any bridge in the space, when it asks (`tm8 bridge handle claim`), or, for workers started by `/work` or `bridges.work.start`, at request time (v2 §4.3). It keeps that name in every group. `@keen-otter …` or a reply to keen-otter's message, in any group, **directs** a message to that session: the message is delivered as a turn and keen-otter is its answerer. A handle grants nothing (D23); ending a session revokes nothing. An ended session's handle routes to the group's chat with a note, as in Phase 1.

### 2.5 Connections and the runtime

**A connection is a credential.** The secret of a linked WhatsApp device is a directory of key material that is *rewritten on every session* (Baileys' multi-file auth state); a Slack installation is a bot token; a Telegram bot is a token. tm8 already has the right place for this: the sealed space-credential store, with ADR 0297 as the precedent for a server-only provider (`mcp`) and `docs/features/session-credentials/03-principal-and-storage.md` §3.2 for the "node-local bytes, DB holds metadata" option that refresh-in-place needs. So:

- `bridge_connections` is a **node-level** table owned by an **account** (the human who scanned the QR or installed the app): `id, provider, owner_account_id, label, external_account_id, status, runtime_id, state_ref, created_at, last_seen_at`. `state_ref` names a sealed blob on the node (`<dataDir>/bridges/<connectionId>/`, 0700, AES-GCM under the node key), never a row in the graph and never in any read route.
- A connection is **offered to a space** by its owner: `bridges.connections.offer` creates a `credential` entity in that space with `provider = 'whatsapp'`, `shape = 'connection'`, metadata `{connectionId}`, visibility private or space, status, readiness — one more server-only provider in the list beside `typesafe | mcp | tool`. The spawn reader refuses it like the others: **a connection is never injected into a session.**
- The owner must be a member of the space they offer to. Numbers belong to the member who links them; there are no space-owned connections (v2, standing decision). Withdrawing the credential, or the owner leaving the space, pauses every bridge on it in that space (and suspends their loops, v2 §2.3); removing the connection logs the device out and ends them all.

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
| server → runtime | `history.fetch {connectionId, conversationId, sinceTs}` | an explicit history import (D17, v2 §1.1) |
| runtime → server | `history.batch {items[], done}` | the import's pages, idempotent on external ids |
| both | `heartbeat` | every 30 s; three misses mark every bridge on the runtime `degraded` |

**As built (B1a, D35).** The frames live in one module, `integrations/whatsapp-bridge/src/runtime/protocol.ts`, which the server imports. Runtime → server is `POST /v2/bridge-runtime/<route>` (`hello`, `state`, `auth`, `conversations`, `conversation-state`, `inbound`, `sent`, `heartbeat`, `media`); server → runtime is one WebSocket on the node's single upgrade path, discriminated by `?bridgeRuntime=<runtimeId>`. Beyond the table above: `allowlist {connectionId, version, conversationIds[]}` (server → runtime, on `hello` and on every change, §2.3), `conversation-state {connectionId, conversationId, canSend, reason}` (runtime → server: an admins-only group the number can't post in, D28), and `typing` and `read` (server → runtime, guarded like every outbound frame). `link.claim` is not a frame (D37).

Health is **derived once on the server** from heartbeats and connection states and delivered identically to every consumer (T-L12): `bridge.status` and `bridge.health` are never computed in the UI.

### 2.6 Many spaces, many numbers

| Rule | Enforced by |
|---|---|
| A provider conversation is connected **once per space**, whichever member's number or account connects it; a second attempt is refused with *already connected by <name>* (D20) | `unique (space_id, provider, external_conversation_id)` on `public.bridges` |
| That bridge has **one target**: the group feeds exactly one main chat or channel; workers keep `@handles` for directed messages and read and post freely (D21) | the single `bridged_to` edge (§2.2) |
| Inbound is deduped **per bridge**, not per connection | `unique (bridge_id, external_message_id, direction)` on `public.message_origins` |
| **Linking numbers to members is unlimited per group**: any number of participants may send `/link` and be linked; this is not the connection rule above | no limit; links are per identity (§2.4) |
| A connection can serve bridges in **many spaces** | one offered `credential` per (connection, space) |
| A space can have **many connections and many bridges** | nothing to enforce; the Settings page lists them by provider |
| A bridge lives **in its target's space** | `bridges.create` checks it; the `bridged_to` edge is same-space like every edge |
| A **second number** is a second connection on the same runtime | the runtime multiplexes connections; no second container, no second port |

### 2.7 Workers on the bridge: they read the room and speak in it (D21)

A **worker** here is any session in the bridge's space (D23): one launched by a chat, started by `/work` or `bridges.work.start` (v2 §4.3), started by a loop (D26), or started any other way. Access is space-wide, with no seat, grant or `launched_by` check; a handle (§2.4) is only its address. A worker takes part in the conversation; it is not a phone that rings only when its name is called. The Phase-1 briefing rule — *speak in the group ONLY when addressed; the bridge refuses a `/say` without a `reply_to` in a thread addressed to you* — is dropped.

| | Phase 1, and this design before D21 | Now (D21) |
|---|---|---|
| **What a worker reads** | the messages routed to it (`@handle`, a reply to its message) | the **whole conversation** of any bridge in the space, at any time |
| **When a worker speaks** | only a reply in a thread addressed to it | **any time**: a new message (`tm8 message send --to <bridge-id>`) or a reply, shown as `Title (handle): …` (`policy.voice`) |
| **`@handle` / reply to its message** | the only way in and out | a way to **direct** a message: it wakes the worker and makes it the answerer of that message |

**How a worker reads.**

- `tm8 bridge log <bridge-id> [--unread | --since <message-id>] [--thread <message-id>] [--limit <n>]` (`bridges.log.read`): a page of the log anchor, oldest first, each row with the participant, the trust word, where it was routed and who answered it. `--unread` reads from the worker's own cursor and advances it. It is a thin verb over `messages.list` on the log anchor plus a per-session cursor, `bridge_read_cursors(bridge_id, session_id, last_message_id, read_at)`; `tm8 message list <log-anchor>` and `tm8 search` keep working (D3).
- **Access is space-wide (D23).** Any session in the space may read and post on any bridge in the space. There is no seat, grant or lineage check, and ending a session revokes nothing. The only limits are the outbox's hard checks (§2.3): pause, `direction: in`, the bridge's `workerPosting` switch and the rate limits. Approvals never cross (D9). Recent posters are read from `bridge_outbox` (`tm8 bridge show`). The read is the member read of the bridge panel: phone numbers masked, guests by display name.
- Bodies stay `untrusted_data` with `trust` per message (§2.3). Reading the room never turns a message into an instruction.

**How a worker hears about new messages.** Not every message becomes a turn: a group runs to hundreds of messages a day, and waking every worker on each would spend them all on chatter.

| Message | Reaches the worker as | |
|---|---|---|
| `@handle …`, a reply to one of its messages, `/tell <handle>` (v2 §4.4), a message in its `/work` line's thread | a **delivery** — the `tm8.incoming-message` envelope with `origin` and `directed="true"`; it wakes the worker | always |
| anything else in the conversation | **nothing pushed**; it is counted. The next delivery's `origin` carries `unread="<n>"`, and the worker reads with `tm8 bridge log --unread` when it chooses — between steps, before it posts, or on its own poll | default (`wake: directed`) |
| | opt-in: `wake: thread` also wakes it on any message in a thread it has posted in; `wake: all` wakes it on every message (a session that is the group's dedicated watcher; admin-set, shown with its cost) | Routing → *Workers* (v2 §1.7) |

The bridge sets the ceiling (`workers.wake`, default `directed`); a worker may lower its own with `tm8 bridge listen <bridge-id> directed|thread|all`, never above the ceiling.

**Guardrails.**

- **One answerer per message.** Each inbound message has exactly one answerer: the addressed handle when it is directed, otherwise the **target** — the main chat stays the default answerer for un-directed messages (D2). A worker that reads an un-directed message and has something to add waits until the main chat's turn on it has settled, or until the main chat hands it over (its "*Title (handle) is on it*" announcement makes that worker the answerer). The server holds this on replies: a `messages.post` that replies to a bridged message whose answerer is someone else, while that answer is still open, is refused `not_answerer` with *post a new message or wait for <answerer>*. New messages are not blocked by this rule; the rate limit bounds them.
- **Outbound rate limits (D23, D26).** Every session running as one teammate shares a token bucket per **(teammate, bridge)** on the outbox: 20/min overall (the Phase-1 speaker number), of which at most **6 per 10 min un-directed** (anything that is not a reply to a message directed to it). A **per-number cap** also applies across every bridge on one connection: 60/min, so the number never looks like spam to the provider. Over the limit the post is refused `rate_limited` with `retryAfterMs` on the message — never silently queued. The per-conversation 30/min (§6) still caps the sum.
- **Approvals never cross** (D9). A request a worker reads in the log grants nothing; it raises an attention request and says *needs your OK in tm8*. The credential-shaped-text refusal applies to worker posts as to turn answers.
- **Pause and remove stop worker posting.** While the bridge is paused (including *pause for…*, v2 §1.3), its group is **off the runtime's allowlist** (D28): nothing is read from it and nothing is sent to it. While it is `/mute`d (v2 §4.4) or `direction: in`, it stays on the allowlist, so it is still logged and commands still work, but nothing is sent. In all three states a worker's post is stored in tm8 only and refused for the provider with `bridge_paused` (or `direction_in`). After `bridges.remove`, the group leaves the allowlist and nothing crosses; a log kept read-only stays readable.

### 2.8 Provenance: everything from a bridge points back to it (D22)

**The rule.** Every entity created because of a bridge — tasks and subtasks, docs, artifacts, memories (drafts and proposals included), drawings, forms, loops, work sessions, messages, anything — gets an **`authored_from` edge to the bridge**, written by the **server in the same transaction that creates the entity**. It is not left to the agent, the agent cannot opt out of it, and the agent cannot write one: an `authored_from → bridge` edge is server-written only, and `edges.create` / `edges.delete` refuse it from any caller.

**One edge type, with the origin on it.** `authored_from` (entity → bridge) is the one edge; its props say which message started it:

```ts
// props of authored_from → bridge
{ bridgeId: EntityId;
  messageId: EntityId | null;          // the origin message on the log anchor (null for a loop firing)
  providerMessageId: string | null;    // the provider's id, e.g. the WhatsApp wa_msg_id (message_origins.external_message_id)
  sender: { memberId?: EntityId; participant?: string; handle?: string };   // linked member, else guest display name; handle when a worker spoke
  command: string | null;              // '/work', '/task', '/remember', '/remind', … or null for a natural-language turn
  loopId?: EntityId;                   // when a bridge loop fired it (v2 §2.2)
  inherited: boolean;                  // false on the entity the origin first landed on; true on everything created under it
  viaSessionId: EntityId | null;       // the session whose launch context carried it (null when the bridge layer itself created the entity)
  depth: number }                      // 0 = created by the bridge layer or its direct worker; +1 per generation of spawned worker
```

**And to the source message.** Where the origin message is known (`messageId` not null), the recorder writes a second `authored_from` edge, entity → **that message** on the log anchor, with the same props. Same edge type, so *where did this come from* stays one query and lands on the WhatsApp message directly.

The existing `authored_from → chat|session` edge (*made during this chat*) stays as it is; an entity made in a bridged chat carries both. Inbound provider messages themselves get no edge — they *are* the origin, and `message_origins` plus the log anchor already place them.

**Where an origin is born.**

| Origin | Who stamps it | `command` |
|---|---|---|
| a command that creates something (`/work`, `/task`, `/remember`, `/remind`, `/loop`, v2 §4) | the command executor, on every entity the command creates | the verb |
| a routed message that starts a chat-target turn (§2.3) | the turn's context carries the origin; the recorder stamps what the turn creates | null |
| a directed message delivered to a worker (`@handle`, a reply, `/tell`, §2.7) | appended to that worker's launch context on delivery | null or `/tell` |
| a bridge loop firing (v2 §2.2) | the loop executor, on the session and task it derives | `loop` (`loopId` set) |

**Inheritance — the mechanism.** Provenance travels in the **session's launch context**, not in the agent's prompt:

1. When the server starts a session because of a bridge — `/work`, `bridges.work.start`, a chat turn spawning a worker while handling a routed message, a loop — it writes `bridgeOrigins: [{bridgeId, messageId, providerMessageId, sender, command, loopId?}]` into that session's launch context (the same server-held record as `launched_by`, 330). The session itself gets the `authored_from → bridge` edge(s) at creation.
2. The **entity recorder** — the one server path every entity create goes through — reads the creating session's `bridgeOrigins` and writes one `authored_from → bridge` edge per origin on the new entity (`inherited: true`, `viaSessionId`, `depth`), in the create's own transaction. A task, a doc, an artifact, a memory draft, a message the worker posts: all the same path.
3. When the entity being created is itself a **work session** (a worker spawning a worker), the recorder also copies `bridgeOrigins` into the child's launch context with `depth + 1`. Its children inherit the same way: **at any depth**, with no per-agent step.
4. A running session gains an origin when a directed message from a bridge is delivered to it (row 3 above). From then on what it creates carries it too; what it created before does not (provenance is recorded at creation, never rewritten).

Nothing here is something the agent does or can skip (and the group commands depend on it, below): an agent that never mentions the bridge still produces entities that point at it, and an agent cannot remove or forge the edge.

**More than one origin.** A worker may carry several — `/work` from Infra, then `@keen-otter` from Ops; a chat turn answering two routed messages. It **keeps all of them**: `bridgeOrigins` is a list, deduped only on the `(bridgeId, providerMessageId)` pair, and every entity it creates gets one edge per origin. Two messages from the same bridge are two origins (two edges to the same bridge); the same message reaching it twice is one. The edge's key is accordingly `(src, 'authored_from', bridge, providerMessageId)`, not `(src, type, dst)`. Over-attribution is deliberate: the recorder cannot know which origin a doc was "for", and a lost origin is worse than an extra one.

**Two queries.**

```bash
# everything that came out of the Infra bridge (any depth, any kind)
tm8 edge list --target <bridge-id> --type authored_from --direction incoming

# where did this doc come from? → the bridge, the WhatsApp message, the sender, the command
tm8 edge list --source <doc-id> --type authored_from --direction outgoing   # props: bridgeId, messageId, providerMessageId, sender, command
tm8 entity context <messageId>                                               # the original message on the bridge's log, with its quote chain
```

```sql
-- the same, in SQL: all entities from bridge X, newest first, with the message that started each
select e.id, e.kind, e.title, ed.props->>'providerMessageId' as wa_msg_id, ed.props->>'command' as command,
       (ed.props->>'depth')::int as depth
from public.edges ed join public.entities e on e.id = ed.src_id
where ed.type = 'authored_from' and ed.dst_id = :bridge_id
order by e.created_at desc;
```

The bridge panel's Connections tab is this first query, grouped by kind; an entity's own Connections tab shows its *From WhatsApp · Infra · Rahul · 10:41* origin chip, which opens the message.

**The edges power the group commands.** Every group command that lists or opens things (v2 §4.4) — *tasks from this group* (`/tasks`), *docs and artifacts made here* (`/docs`), *what sessions are running for this group* (`/workers`), *memories from this chat* (`/memories`) — is the first query above filtered **by kind** (and status where it applies). There is **no separate per-group index**: the edge is the only source of truth. That has three consequences, all deliberate:

- **The edge must be written whenever the entity is created.** An entity without it does not appear in any group command. So the recorder's write is part of the create: if the edge cannot be written, the create fails, and a test asserts that every create path under a session with `bridgeOrigins` produces it.
- **Results follow group scope** (D20). A group is connected once per space, so *this group* means *this bridge*: commands return entities with an `authored_from` edge to this bridge, in this bridge's space, that the sender may read. Entities from the same group in another space are a different bridge and never appear.
- **Edges stay put.** Moving an entity (`entity move`, a new parent, a new collection), editing it, retargeting the bridge (`bridges.retarget`) or completing a task leaves its provenance edges in place: where something came from does not change. Only deleting the entity removes them; removing the bridge keeps them, read-only, for *where did this come from*.

**Cross-group provenance (D30).** Provenance follows **what prompted the work**, not where a worker posts.

- A worker started from group A that posts in group B gets no B provenance for that post.
- It gains B as an extra origin only when a B message is **directed or routed to it** (an `@handle`, a reply to its post, `/tell`). From that turn on, everything it creates carries both origins, deduped on `(bridgeId, providerMessageId)` as above.
- Loop work gets `authored_from → loop`, plus `→ bridge` for the group whose message prompted it. A scheduled post in a group is not a prompt from that group.
- `story` entities get these edges like every other kind (D29).

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
  teammate_id              uuid references public.entities(id),                     -- D25: signature + default teammate
  purpose                  text,                                                     -- D25: `tm8 bridge list`
  quiet_hours              jsonb,                                                    -- D26: {start,end} in the bridge timezone
  worker_posting           boolean not null default true,                            -- D23: outbox hard check
  ended_at                 timestamptz,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (space_id, provider, external_conversation_id)                            -- connected once per space, by any member's connection (D20); a partial index over live bridges (D33)
);
create unique index bridges_one_per_target on public.bridges (target_id) where ended_at is null;   -- one chat per bridge (D25)

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
create table public.bridge_handles (space_id uuid not null, handle text not null, entity_id uuid not null, kind text, title text,
  status text not null, created_at timestamptz not null default now(),
  primary key (space_id, handle), unique (space_id, entity_id));                    -- space-scoped, same name in every group (D23)
create table public.bridge_handle_appearances (space_id uuid not null, handle text not null, bridge_id uuid not null,
  first_at timestamptz not null, last_at timestamptz not null, primary key (space_id, handle, bridge_id));
create table public.bridge_outbox (id uuid primary key, bridge_id uuid not null, message_id uuid not null unique,
  external_reply_to text, payload jsonb not null, status text not null, attempts integer not null default 0,
  external_message_id text, created_at timestamptz not null default now(), settled_at timestamptz);
create table public.message_origins (message_id uuid primary key references public.messages(id) on delete cascade,
  bridge_id uuid not null, connection_id uuid not null, direction text not null check (direction in ('in','out')),
  external_message_id text not null, external_conversation_id text not null, external_sender_id text,
  external_reply_to_id text, external_ts timestamptz,
  unique (bridge_id, external_message_id, direction));                            -- dedupe per bridge, from any number (D20)
```

Flavours, in T-L3's terms: `bridges` is a kind detail table; `bridge_connections` is **config** (node-level, like `server_connections` of 044); `bridge_participants` and `bridge_identity_links` are **per-member/per-person state** (the `space_link_tokens` precedent: a member's own row on a shared entity); `bridge_outbox` and `message_origins` are **operational**. None of them encodes a relation between entities — the one relation, bridge → target, is the `bridged_to` edge.

RLS: `bridges`, `bridge_participants`, `bridge_handles`, `message_origins` follow 218's shape (`exists over entities_select`). `bridge_identity_links` is readable by the identity it names and by admins of the space it is scoped to; identity-scoped rows surface to a space only through the resolver, never as a list. `bridge_connections` is readable by its owner account and by node admins; a space sees it only through its offered credential.

### 3.3 Edges

| type | direction | written by | meaning |
|---|---|---|---|
| `bridged_to` | bridge → chat \| work_session \| channel | server (`bridges.create`, `bridges.retarget`) | the tm8 side of the bridge |
| `authored_from` | entity → chat/session | server (exists) | unchanged: *made during this chat/session* |
| `authored_from` | **any entity → bridge** | **server only**, in the create's transaction — the command executor, the turn, the loop executor, and the entity recorder for everything created under a session whose launch context carries `bridgeOrigins`; `edges.create`/`delete` refuse it (D22) | provenance: props `{bridgeId, messageId, providerMessageId, sender, command, loopId?, inherited, viaSessionId, depth}`; one edge per origin, keyed `(src, type, bridge, providerMessageId)`; inherited by spawned workers at any depth; the only index the group commands read (§2.8). **D31:** one edge per (entity, bridge) holding `origins[]`; B1b narrows the one-per-source index with its readers |
| `authored_from` | any entity → the origin **message** on the log anchor | server only, beside the bridge edge, where the message is known (D22) | lands *where did this come from* on the WhatsApp message itself |
| `attached_to`, `relates_to` | any → bridge | agent (exist) | `bridge` joins their `dst_kinds` |

No `has_participant` edge: participants are not entities (§2.4).

### 3.4 Operations

Catalog rows in the `spaceLinks.*` / `mcp.servers.*` idiom. **Human-only** is the SQL gate (`internal.require_human_auth_kind`), marked `humanOnly: true` in the catalog so the CLI and UI say so before the call.

| operation | method · path | kind | who |
|---|---|---|---|
| `bridges.list` | GET `/v2/spaces/:spaceId/bridges` | read | member or any session in the space; each row carries name and `purpose` (D25) |
| `bridges.get` | GET `/v2/bridges/:bridgeId` | read | member |
| `bridges.create` | POST `/v2/spaces/:spaceId/bridges` | command | **space admin who owns the connection (the number), human-only** (D28); refuses a target chat that already has a bridge, `target_has_bridge` (D25) |
| `bridges.update` | PATCH `/v2/bridges/:bridgeId` | command | admin (policy, style, retention) |
| `bridges.retarget` | POST `/v2/bridges/:bridgeId/retarget` | command | admin, human-only; refuses a chat that already has a bridge (D25) |
| `bridges.pause` · `bridges.resume` | POST `/v2/bridges/:bridgeId/pause|resume` | command | admin |
| `bridges.remove` | POST `/v2/bridges/:bridgeId/remove` | command | admin, human-only (the generic `entities.delete` is refused, as for `space_link`, so outbox and links never outlive the entity quietly) |
| `bridges.participants.list` | GET `/v2/bridges/:bridgeId/participants` | read | member (masked) / admin (full) |
| `bridges.participants.update` | PATCH `/v2/bridges/:bridgeId/participants/:externalId` | command | admin (mute, assert link, invite) |
| `bridges.links.begin` | POST `/v2/me/bridge-links` | command | **any member, human-only** — mints a code for the caller's own identity |
| `bridges.links.list` · `bridges.links.revoke` | GET · POST `/v2/me/bridge-links[/…/revoke]` | read · command | the identity itself; admins for space-scoped rows |
| `bridges.handles.list` | GET `/v2/bridges/:bridgeId/handles` | read | member |
| `bridges.handles.claim` | POST `/v2/spaces/:spaceId/handles` | command | any session in the space; idempotent, returns its one space handle (D23) |
| `bridges.log.read` | GET `/v2/bridges/:bridgeId/log` | read | member; any session in the space (D21, D23, §2.7). `--unread` advances the caller's cursor |
| `bridges.listen` | POST `/v2/bridges/:bridgeId/listen` | command | any session in the space: sets its own `wake`, capped by the bridge's `workers.wake` (§2.7) |
| `bridges.connections.list` | GET `/v2/me/bridge-connections` | read | the owner; node admins see all |
| `bridges.connections.begin` | POST `/v2/me/bridge-connections` | command | **human-only**: starts a link/install flow; auth frames arrive on the caller's event stream |
| `bridges.connections.offer` · `.withdraw` | POST `/v2/me/bridge-connections/:id/offer` | command | the owner, human-only; creates/revokes the space credential |
| `bridges.connections.remove` | POST `/v2/me/bridge-connections/:id/remove` | command | the owner, human-only; logs out, ends its bridges |
| `bridges.conversations.list` | GET `/v2/me/bridge-connections/:id/conversations` | read | **the connection's owner only** (the wizard's picker): a live call to the runtime, never stored (D28) |
| `bridges.forms.deliver` | POST `/v2/bridges/:bridgeId/forms/:formId` | command | member or agent in the space; the Phase-1 `POST /form` |
| `bridgeRuntime.hello` · `.inbound` · `.state` · `.sent` · `.heartbeat` (+ `auth`, `conversations`, `conversation-state`, `media`; no `linkClaim`, D37) | POST `/v2/bridge-runtime/<route>` | runtime door, **not a catalog row** (D43) | **`bridge_runtime` sessions only**; refused to every other auth kind |

v2 §5 adds `bridges.test`, `bridges.history.import`, `bridges.update --dry-run` (→ `consequences[]`), `bridges.memories.*`, and `bridges.work.start` (the launch queue is dropped, D26), and gives `bridges.pause` an optional `until`.

There is deliberately **no `bridges.say`**: speaking is `messages.post` on the log anchor or a reply, so that a human in the browser, an agent in a session and a chat turn all cross the bridge by the one public communication door (T-D23).

### 3.5 CLI

```text
tm8 bridge list [--provider <p>] [--target <entity-id>]           # name + purpose per group, for agents too (D25)
tm8 bridge show <bridge-id>                                     # settings, health, recent posters (from bridge_outbox)
tm8 bridge get <bridge-id>
tm8 bridge create --connection <credential-id> --conversation <external-id> --to <chat|session|channel id>
                  [--trigger mention|every|none] [--direction both|in|out] [--outbound replies|all]
                  [--who-may-trigger linked|anyone] [--voice named|plain] [--style <one line>]
                  [--teammate <id>] [--purpose <one line>] [--quiet-hours 22:00-08:00] [--worker-posting on|off]
tm8 bridge update <bridge-id> [same flags] --expect-version <n>
tm8 bridge retarget <bridge-id> --to <entity-id> --expect-version <n>
tm8 bridge pause|resume|remove <bridge-id> --expect-version <n>
tm8 bridge people <bridge-id> [--guests|--linked]               # who is who, masked unless admin
tm8 bridge assert <bridge-id> <external-id> --member <member-id> # admin: space-scoped link
tm8 bridge invite <bridge-id> <external-id> [--role member]      # admin: mint a pinned join link to share; link completes on redeem
tm8 bridge handles <bridge-id>
tm8 bridge handle claim <bridge-id> [--title <≤4 words>]         # any session in the space; one name in every group (D23)
tm8 bridge log <bridge-id> [--unread | --since <message-id>] [--thread <message-id>] [--limit <n>]   # a worker reads the room (D21)
tm8 bridge listen <bridge-id> directed|thread|all                # a worker's own wake level, ≤ the bridge's (D21)
tm8 bridge link begin --provider whatsapp                        # me: prints TM8-4F7K, 10 min
tm8 bridge link list | revoke <provider> <external-id>
tm8 bridge connection list | begin --provider <p> | offer <id> --space <space-id> | withdraw | remove
tm8 bridge conversations <connection-id>                         # the picker, from the terminal
tm8 form create … && tm8 bridge deliver-form <bridge-id> <form-id>
```

Speaking needs no new verb: `tm8 message reply <message-id> "<text>"` answers in the provider thread; `tm8 message send --to <bridge-id> "<text>"` opens a new one — a worker may do either at any time (D21). v2 §5 adds `tm8 bridge test|import|work|memory add|remove`, `tm8 bridge update … --dry-run`; labels are §3.8.

### 3.6 Events

`WorkspaceEvent` gains `bridge.updated` (content/status), `bridge.health` (coalesced, at most one per bridge per 10 s), `bridge.delivery {messageId, status, externalMessageId}` and the **member-addressed** ephemeral `bridge.connection.auth {connectionId, qr | pairingCode, expiresAt}` (the `recipient_member_id` mechanism `personal_style.updated` already uses, so a QR never reaches another member's stream).

### 3.7 The one non-additive contract change

`ActorSummary.kind` gains `'bridge'`, and `via` gains optional `bridgeId` and `participant {displayName, avatar?}`:

```ts
kind: 'member' | 'team_member' | 'work_session' | 'bridge';
via?: { sessionId?: EntityId; bridgeId?: EntityId; participant?: { displayName: string; avatar?: string | null } };
```

A linked participant's message is `{kind:'member', …, via:{bridgeId}}` — truthful for a consumer that ignores `via`. A guest's message is `{kind:'bridge', id: <bridge>, displayName: 'Infra (WhatsApp)', isAgent:false, via:{bridgeId, participant:{displayName:'Rahul'}}}` — a consumer that ignores `via` renders the bridge as the author, which is also true. The precedent is the `work_session` value, added 2026-08-05 for the same reason: *"the two-value union forced the resolver to mint them as a false human."* Inventing a member for a stranger would be that defect again.

### 3.8 Labels (D27)

Main has no labels. Bugs need one (D29), so this design adds them as a general facility rather than a bridge field.

- **A `label` kind**, space-level and flat: `name` (unique per space, case-insensitive), `colour`, `description`. Deleting a label archives it: its id stays valid on entities and it is hidden from pickers. Every space is seeded with `bug`, including new ones (the space-create path) and existing ones (the migration).
- **`entities.labels uuid[] not null default '{}'`** on every entity, with a GIN index. It holds ids, not edges. A trigger checks that each id is a `label` entity in the same space, and refuses an unknown or foreign id.
- **Operations and CLI:** `labels.list|create|update|archive`, and `labels` on `entities.patch`, with add/remove semantics under `expectedVersion`. Collection queries take `labels` (all of) and `labelsAny`. CLI: `tm8 label list|create|archive` and `tm8 task create … --label bug`.

---

## 4. UI integration

### 4.1 Where bridges appear

| Surface | What |
|---|---|
| **Home rail → Talk** | *Bridges* beside Channels and Chats: chips with the provider mark, the conversation title, a status dot-and-word |
| **Settings → Bridges** (`/settings/bridges`) | the management home (`KindConfig.settingsHome`), the only place the human-only doors live: connections, the add-bridge wizard, policy, pause, remove |
| **The bridge panel** (Z3/Z4) | Conversation · People · Routing · Memory · Loops · Health, plus the standard Connections tab (Memory and Loops: v2 §2) |
| **Chat, session and channel panels** | a header chip *Bridged from WhatsApp · Infra* (links to the bridge); bridged bubbles carry the provider badge and the participant; the composer says when a message will cross; a *Bridge this…* primary action opens the wizard with the target pre-filled |
| **Account → Linked identities** | my WhatsApp / Slack / Telegram identities, link with a code, revoke |
| **Inbox / Attention** | requests raised from a bridge say *from WhatsApp · Rahul (guest)* and are resolvable only here |
| **Mobile** | the same list, panel and link flow; a number is linked from a phone with WhatsApp's **pairing code**, and the QR moves to a second screen by a member-addressed hand-off link (v2 §1.6, V10) |
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

In v2 the *Connections* header is titled **Accounts & secrets**, reserving a slot for shared secrets (v2 §1.6); the connection rows are unchanged. A row opens the bridge's panel; the status column is colour **and word** (tokens.css: *status is ALWAYS color + word, never color alone*). A connection row's `⋯` offers *Offer to another space*, *Re-link* (QR/pairing code modal fed by `bridge.connection.auth` events), *Remove*. The QR modal says what Phase 1's `link.sh` says in a terminal: which phone, where in WhatsApp to tap, and that the code lasts about two minutes.

### 4.3 The add-bridge wizard

Four steps (v2 §1.2, §1.4); `bridges.create` runs when step 3 is confirmed (nothing is committed before it; cancelling before it leaves nothing — the `EditEntityDialog` rule), and step 4 tests the bridge just created.

1. **Connection** — pick one of the account's offered connections, or *Link a new account* (provider picker → the provider's own flow: QR / pairing code for WhatsApp, OAuth install for Slack, token paste for Telegram/Discord).
2. **Conversation** — a live list from `bridges.conversations.list` with search; groups, channels and DMs grouped. A conversation already connected in this space — by any member's number or account — is shown greyed and not selectable, with *already connected by <name> → <target>* (D20); `bridges.create` refuses it with the same words if two members race. Linking your own number to yourself (`/link`, §4.6) is still open in that group.
3. **Target** — three cards: **Chat** (pick an existing chat, or *New chat* with teammate, model, mode — the chat is created from the browser, human-only as `chat.start` requires), **Session** (a live session in the space), **Channel** (existing, or *New channel* with the conversation's name slugged). Below, the policy derived from the choice, editable: trigger, **what crosses back** (`outbound`, v2 §1.2), direction, who may trigger, voice, style, and *History & retention* (D15, D17; v2 §1.1). The copy under each card is the row of §2.2 in one sentence.
4. **Test it** — connection, read access, an optional test message, and a live `@tm8 ping` round trip (v2 §1.4). *Finish* is allowed after a failure; the bridge is then `degraded` with the reason on Health.

Launching the wizard from a chat, session or channel panel pre-fills the target in step 3; the policy rows remain.

### 4.4 The bridge panel

```
┌ ◍ Infra · WhatsApp ───────────────────────────── ● live · 14 in group · bridged to 💬 Infra main ┐
│ Conversation │ People │ Routing │ Memory │ Loops │ Health │ Connections                            │
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
- **Routing** is the target card with *Retarget*, the policy as labelled controls, the handles table (handle · title · entity chip · queued/live/ended) and the style line; v2 adds its *History & retention*, *Commands* and *Workers* sections (v2 §1.1, §1.7).
- **Memory** and **Loops** are the bridge's linked memories and scheduled posts (v2 §2.1, §2.2).
- The header's status pill is also the *Pause / Resume* control, and its `⋯` menu holds *Move*, *Send a test message* and *Remove* (v2 §1.3).
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

**Linking is not connecting.** Any number of people in a group may link their numbers to themselves; there is no limit per group. What is limited is the *connection*: one member's number or account reads and replies for the group in a space (D20). Linking another number makes its messages count as that member; it does not connect the group a second time.

### 4.7 Registry and plumbing checklist

- `domain/registry.ts`: a `bridge` row — `label 'Bridge'`, `slug 'bridges'`, `strategy 'collection'`, `defaultMode 'list'`, `hiddenModes ['board','gallery','tree']`, `chip {glyph:'⌒', tintBy:'none'}`, `card {fields:['bridgeProvider','bridgeTarget','bridgeStatus','bridgePeople']}`, `settingsHome {section:'bridges', label:'Manage in Bridges'}`, `list quickCreate:false`, `panel {archetype:'generic', blocks:[conversation, managed BRIDGE, people, routing, memory, loops, health, settings-home]}`; `NOT_LAUNCHABLE` gains `bridge`.
- `domain/kind-art.ts`: a drawn mark — two posts and an arc between them, 16×16, stroke 1.4, no silhouette shared with `space_link`'s chain or `channel`'s hash (asserted by `kind-art.test.ts`).
- `domain/kind-nouns.ts`: `bridge: { nouns: ['bridge'], commands: ['message send', 'message reply', 'message list', 'form create'] }`.
- `routes/types.ts`: `SETTINGS_ROUTE_SECTIONS` gains `'bridges'`; `settings-space/` gains `BridgesSection.tsx` on `SectionFrame`, with a `port.ts` like `settings-space-links/port.ts` so fixtures and a real node are indistinguishable.
- `entity-help/kinds/bridge.tsx`: logline *"A conversation from another network, living here as a first-class thing you can read, answer and manage."* Beats: *Why one per conversation* · *How it is born* (a human, in Settings) · *Who is speaking* (linked vs guest) · *How agents answer* (a `TypedTerminal` of `tm8 message reply`) · *What never crosses* (approvals, secrets) · *How it ends*.
- Provider marks: `mcp/connector-logos.tsx` is the precedent for a logo table; bridges reuse it (`whatsapp`, `slack`, `telegram`, `discord`, `instagram`, `messenger`).
- `LIVE_VERBS`: a delimited block for the section, each verb named for the operation that makes it live.

---

## 5. Providers

The vocabulary is closed and each provider declares what it can do; the UI shows only what the sheet allows (a poll button only where polls exist; a thread reply only where threads exist). v2 §1.1 adds `history: 'full' | 'recent' | 'none'` to the sheet for history import (D17).

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
| Spam and provider rate limits | Token buckets on the server outbox: per (teammate, bridge) 20/min, at most 6 per 10 min un-directed (D21, D23, §2.7); per conversation 30/min; **per number** (connection) 60/min across the space (D26). Over a limit, 429-style refusal to the sender with the retry-after on the message's delivery badge. |
| PII (phone numbers, handles) | Masked in every content field and every member-level read; full ids only on admin reads and in the participant row; retention per bridge (D15) runs through the existing retention job. |
| A logged-out device, a dead socket | Heartbeats → `degraded` on every bridge of the runtime within 90 s; an attention request (`fyi`) to the connection's owner; inbound is queued by the provider, outbound by the outbox. Nothing is retried blind. |
| Two bridges on one conversation (double routing) — including two members connecting the same group from different numbers | `unique (space_id, provider, external_conversation_id)` on `bridges`; the wizard shows *already connected by <name>* and `bridges.create` refuses the second (D20). |
| The same provider message arrives twice, from the connected number or another | Dedupe on `(bridge_id, external_message_id)`: stored once per bridge, from any number (D20). |
| A number's other conversations (DMs, groups nobody connected) are read, stored, marked read or sent to | Connected groups only (D28). The server pushes each connection's allowlist to the runtime. The runtime drops everything else before forwarding, and refuses every outbound frame (text, media, reaction, poll, typing, read receipt) to a conversation not on the list. The server checks again both ways. Unbridging or pausing a group takes it off the allowlist at once. Only the number's owner can create a bridge on it, and the group list is fetched live and never stored. History can be imported only for connected groups. |
| What a teammate learned in one group surfaces in another | Accepted (D25): one teammate's knowledge is shared across its groups, and replies go only to the source group. A later per-bridge `external` flag can wall off an external group. |
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
| `names` table, token files, briefings, `rebrief-*` | `bridge_handles`; no tokens; the envelope's `origin` block; the kind help page. The briefing's *speak ONLY when addressed* rule is dropped: workers read and post freely (D21, §2.7) |
| SQLite log + FTS, `/history`, `/search`, `/message` | messages on the log anchor; `tm8 bridge log`, `tm8 message list`, `tm8 search`; an optional one-shot backfill of the SQLite log as messages with `message_origins` |
| `POST /say`, `/say-media`, `/react`, `/form`, `/names`, `/sync` | `tm8 message reply|send`, attachments, reactions, `tm8 bridge deliver-form`, `tm8 bridge handles`; nothing to sync — the server is the registry |
| the fallback relay, the watchdog's 👀/⚠️ reactions, the escalation and delegate rules | the chat-target outbound rule; the watchdog stays, as a **server scheduler job** (D19: a routed message with no answer in N minutes reacts ⚠️ through the outbox and raises `fyi` attention on the bridge); the escalation rule moves into the teammate's skill/persona, where briefing text belongs; the delegate rule (RULE 2) becomes `tm8 bridge work` (v2 §4.7) |
| slash commands `/help`, `/who`, `/status`, `/stop`, `/new` (`text.ts`, `core.ts`) | server-side commands run as the linked member, with a tolerant parser and an answer for every message (v2 §4) |
| `allowedSenders: "everyone"` on a channel | `whoMayTrigger: anyone` on its bridge (D16) |
| `media.attach: "reference"` workaround | fix the runtime defect (`HarnessSessionBase.reserve` refusing `attachmentRefs`) in B2 so bridged media are real attachments |

### 7.2 Build order (final, 2026-10-29)

The first slice serves the live groups, tm8-work and tm8-bugs first, on the existing number. Each step merges and ships on its own: no step needs a later one to be correct. This table is the build order for both documents. v2 §8 points here.

| Step | Delivers | Depends on |
|---|---|---|
| **B0a Bridge schema** | The migration: `bridge` kind row (Talk) and capabilities; `bridges` (with `teammate_id`, `purpose`, `quiet_hours`, `worker_posting`, the D20 unique and the one-chat-per-bridge index); `bridge_connections`, `bridge_participants`, `bridge_identity_links`, `bridge_link_codes`; space-scoped `bridge_handles` and `bridge_handle_appearances`; `bridge_outbox`, `message_origins`, `bridge_read_cursors`. Also the `bridge_runtime` auth kind, the `bridged_to` and server-only `authored_from → bridge` edge rules, `bridge_resolve_author` and the policy validator. Contract: the content arm and the `ActorSummary` change (§3.7). Catalog rows from §3.4 that B1 needs. CLI `tm8 bridge list|show|get|create|update|retarget|pause|resume|remove|handles|handle claim|log|listen`, and fixtures. | — |
| **B0b Labels** | §3.8: the `label` kind; `entities.labels` with its GIN index and same-space trigger; archive instead of delete; `bug` seeded in every space; `labels.*` operations, `--label` on task create, and the collection filter. | — (in parallel with B0a) |
| **B1a WhatsApp runtime** | The Baileys container speaks the connector protocol (§2.5) as a `bridge_runtime` session. It holds the **allowlist** the server pushes, and enforces it before forwarding inbound (messages *and* poll updates) and on every outbound frame: text, media, reactions, typing, polls, read receipts (D28). It serves the live, owner-only group list. It detects admins-only groups the number can't post in, and their bridges fall back to `direction: in`. Both numbers run on one runtime. | B0a |
| **B1b Server runtime** | The `bridgeRuntime.*` doors. Inbound to the graph (§2.3): dedupe, author resolution, log anchor, `message_origins`, routing to the chat target. The outbox with its hard checks: live, unpaused, direction, `workerPosting`, the (teammate, bridge) bucket and the per-number cap. Space-wide read and post (D23) with `bridge log --unread`, `listen` and `not_answerer`. D22 provenance plus D30, `story` included. The server-side command executor (v2 §4): `/work`, `/task`, `/help`, `/whoami`, `/workers`, `/stop`, `/status`, `/tasks`, `/docs`, with `/link` only in connected conversations. The watchdog job (D19). | B0a |
| **B1c Links import and cutover** | The import command. It turns the live `config.json` into one bridge per group, each targeting the existing main chat with `teammateId` set. It imports `trustedSenders` and `ownerJids` as admin-asserted links (CLI only), so `/work` and `/task` keep working for every Phase-1 trusted sender at cutover. Then the deployed bridge switches to the runtime, and the Phase-1 pieces of §7.1 are removed: SQLite log, poller, names, speaker tokens, the `/say` family, per-space human tokens. | B1a, B1b |
| **L Loops** | Extends main's first-class loops (#1413, migrations 384/385) per D26: `targets[]` of bridges; a `post` action for fixed reminders; `concurrency: replace`; `mode: one-shot | interactive` with a 30-minute idle close; a per-group pause skip; quiet hours with newest-only release and admin exemption; the per-(teammate, bridge) limits; reply routing to the live loop session; owner-leaves suspension for loops with bridge targets; grants at arming; approval requests to the owner. | B1c |
| **F Fix notice** | D24: `created_in`-pattern origin edges from a bug task to its bridge and provider message, one per group. Tasks created from group reports get the `pr_merged` gate automatically. When the gate passes, a thread reply goes under each original report, through the outbox. A completion without a PR says what was done. | B0b, B1c (in parallel with L) |
| **S Rolling summary** | A bounded rolling summary per group chat (Subhang, 2026-10-29). It refreshes on a message or token threshold and is loaded into the chat's context in place of the raw tail. | B1c (in parallel with L and F) |

**Deferred** (not in the first slice):

- **B2 UI:** Settings → Bridges, the wizard, the bridge panel, bubbles and ticks, the v2 §1 gaps, the Memory and Loops tabs, and the attachment fix.
- **Code and invite links:** `/link TM8-…` and Account → Linked identities.
- **The People tab.**
- **`/remember` proposals.** The D29 rule stands for when they ship.
- **Q7 failover and Q8 hand-over:** decided (D55, D56); built as their own step after B1a and B1b.

**Dropped:** the launch queue and the worker cap (D26).

**Later, unchanged:** B4 Telegram, B5 Slack and the channel target, B6 the relay and the Meta providers.

### 7.3 Acceptance

**B0 + B1** (B1c is the gate):

1. `tm8 kind list` shows `bridge` under Talk; `tm8 entity create bridge` is refused with *use `tm8 bridge create`*.
2. Importing the live `config.json` yields one bridge per group. Each targets its existing main chat and has `teammateId` set. `tm8 bridge list` shows them all `live`, with name and purpose, within 90 s of the runtime starting. Every Phase-1 trusted sender is an admin-asserted link.
3. A WhatsApp message in the Infra group appears on the Infra bridge within 5 s, authored as the bridge with the participant's name. `@tm8 …` also starts a turn on Infra main. The turn's answer arrives in the group signed with the teammate and shows *sent* on the chat copy.
4. `tm8 message reply <id> "text"` from **any session in the space** lands in the group quoting the right message, signed `Title (handle): text`. The same session posting in Gaming uses the same handle (D23).
5. No speaker token file exists, and `curl 127.0.0.1:8787/say` is gone. The runtime's session can call `bridgeRuntime.inbound`, and `messages.post` refuses it with `forbidden`.
6. Stopping the runtime marks every bridge `degraded` within 90 s and raises one `fyi` attention request to the connection owner. Restarting clears it without duplicates.
7. The same WhatsApp message delivered twice by the runtime stores one message. A second member connecting the Infra group from another number is refused with *already connected by <name>* (D20).
8. No read route returns `state_ref` bytes, a token, a QR or a pairing code.
9. `pg_dump` of the graph contains no provider secret (the existing secret-pattern test, extended to `bridge_connections`).
10. A worker in the space reads messages it was not addressed in with `tm8 bridge log --unread` and posts an unprompted message. An un-directed message does not wake it; an `@handle` does. Its reply to an un-directed message the main chat is still answering is refused `not_answerer`. Its 7th un-directed post in 10 min is refused `rate_limited`. While the bridge is paused, its post stays in tm8 with `bridge_paused`. With `workerPosting` off, its post is refused `worker_posting_off` (D21, D23).
11. **Provenance (D22, D30).**
    - Run `/work` with two lines from WhatsApp. The first worker writes a doc and spawns a worker that opens a PR task.
    - `tm8 edge list --target <bridge> --type authored_from` lists the parent task, both child tasks, both sessions, the doc, the grandchild session and its task, each with the command's `providerMessageId`. The grandchild's edges say `inherited: true, depth: 1`.
    - The worker then posts in Gaming. Its next doc has **no** Gaming edge. After a Gaming member `@`s it, its next doc has two `authored_from → bridge` edges. Redelivering the same message adds none.
    - An agent's `tm8 edge delete` of one is refused. `/tasks` and `/docs` in the group list the child tasks and the doc, and still do after the doc moves under another parent.
12. **Connected groups only (D28).**
    - A message in a WhatsApp group that isn't connected, and a DM to the number, never reach the server. The runtime keeps a dropped counter and no content. Neither is marked read, and no typing indicator or receipt goes out.
    - Pausing Infra stops forwarding within 5 s.
    - An outbox row forged for a JID that isn't connected is refused by the server, and again by the runtime.
    - `/link` in a DM is never seen.
13. **One chat per bridge (D25), owner only (D28).** `bridges.create` targeting a chat that already has a bridge is refused `target_has_bridge`, and so is `bridges.retarget`. A space admin who doesn't own the number is refused. The group list is visible only to the number's owner.
14. **Labels (D27).** `tm8 label list` shows `bug` in every space, including one created after the migration. A foreign or unknown label id is refused by the trigger. Archiving `bug` hides it from pickers and keeps it on the tasks it's on.

**L (D26).**

- A loop armed from the CLI targets Infra and Gaming, with a different instruction per group. It posts in both, signed with the teammate's handle.
- With Gaming paused, the run records `paused` for Gaming and still posts in Infra.
- In interactive mode, a reply to the Infra post reaches the live loop session. After the session closes on 30 minutes idle, a reply goes to Infra's chat.
- A new run ends the previous live one.
- During Infra's quiet hours, two scheduled posts are held and only the newer is sent when the hours end. A reply to a member goes out at once. An exempt loop is never held.
- A loop whose owner leaves is suspended, and admins get an attention request. An admin's takeover re-arms it in their name.
- The loop creates a task and a doc without asking. Its attempt to merge a PR raises an approval to the owner in tm8, and nothing asking for it is posted in the group.

**F (D24).**

- A bug reported in Infra and again in Gaming is one task labelled `bug`. It has two origin edges and the `pr_merged` gate.
- Merging the PR posts a reply under each original report.
- Completing a bug that has no PR posts what was done.

**S.** A group with 2,000 messages keeps its chat context within budget, and the summary still names open asks.

The command layer's acceptance is v2 §8.

### 7.4 Out of scope, for later: subagents and multi-agent workflows

This design covers **independent workers**: a session the target chat launches, or one `/work` starts (v2 §4.3), gets a handle, reads the whole conversation and speaks in it as `Title (handle)` whenever it has something to say (D21, §2.7), and can be addressed, listed and stopped from the conversation. It does **not** cover:

- **Subagents** a session runs inside itself (harness sub-agents). They get no handle, cannot be addressed from the provider, and reach the conversation only through their parent session.
- **Multi-agent workflows**: a worker that launches workers, a coordinator with a tree of sessions, orchestrated workflows, and `x<n>` races (v2 Q5). A session launched by another worker gets a handle on its first post (D23); the conversation does not see the tree, its progress, or a way to stop it as a whole.

Subhang accepted this gap for the first build (2026-10-29). It is deliberately not designed here; it needs its own design once B1's handles and `/work` are in use. Nothing in this document should be read as deciding it.

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
| D14 (was Q1) | A chat-target bridge mirrors **every** provider message onto the log anchor, routed or not; routing is a policy on top | mirror only routed messages | the record and the search are the point; groups run to hundreds of messages a day, which the message table carries easily |
| D15 (was Q2) | Retention is a per-bridge `retentionDays` (null = keep), enforced by the existing retention job; default null for groups the space owns, 90 days for DM bridges | one space-wide retention; keep everything | PII in the graph needs a per-conversation bound; a group's record is the space's, a DM is a person's |
| D16 (was Q3) | Guests do not trigger agents by default in groups (`whoMayTrigger: linked`); they do in DM bridges (`anyone`); Phase-1 groups configured `"everyone"` import as `anyone` | guests may trigger everywhere; never | in a group a stranger would spend the space's agents; in a DM the conversation is the point; the import keeps today's behaviour |
| D17 (was Q4) | History backfill is an explicit choice (*Import the last N days*, in the wizard and later from Routing, v2 §1.1), idempotent on external ids, logged only, never implicit | backfill on create; never | importing is a data decision a human makes; idempotency makes it safe to repeat; imported messages must not start turns |
| D18 (was Q5) | A channel-target bridge adds linked participants who are space members as channel `has_member`s; guests are never channel members | no automatic membership | the channel's roster then reads truthfully; guests are not members (D4) |
| D19 (was Q6) | The watchdog is a server scheduler job (`scheduler/jobs/`) over `message_origins` and turns; it reacts on the provider through the outbox and raises `fyi` attention | keep it in the runtime | the server owns derived truth (T-L12); the runtime holds no routing logic (D7) |
| D20 | **One connection per group, per space.** A provider conversation (WhatsApp group, Slack channel) is connected once per space, whichever member's number or account connects it: `unique (space_id, provider, external_conversation_id)`; a second member sees *already connected by <name>*. That one bridge has one target, so the group feeds exactly one main chat or channel; workers keep their `@handles` and, since D21, read and post on the bridge freely. Inbound dedupes per bridge on the provider message id, from any number. Linking numbers to members (`/link`) stays unlimited per group. Approved by Subhang, 2026-10-29 | the old key `(connection_id, external_conversation_id)`, which only stopped one connection binding a group twice and let two members' numbers make two bridges; one bridge per member's number | two bridges on one group meant two main chats answering the same message and double replies; one bridge keeps "who answers" single (D2); per-bridge dedupe stays correct if another number ever delivers the same message (Q7) |
| D21 | **Workers read and talk on the bridge freely.** *(Access widened by D23: any session in the space; a handle is only an address.)* A worker launched from a bridge (any session with a live handle on it) gets read access to the bridge's whole conversation (`tm8 bridge log`, messages on the log anchor) and may post to it at any time, as `Title (handle)`. `@handle` and a reply to its message stay as the way to **direct** a message to a worker — they wake it and make it the answerer — not as the only way it hears or speaks. Un-directed messages do not wake workers by default (`wake: directed`); a worker reads with `tm8 bridge log --unread`. Guardrails: the main chat stays the default answerer of un-directed messages (one answerer per message, `not_answerer`); a per-worker outbound limit; approvals never cross (D9); pause, `direction: in` and remove stop worker posting. §2.7. Approved by Subhang, 2026-10-29 (from WhatsApp) | by-name-only: a worker hears only `@handle`/replies and speaks only in a thread addressed to it (Phase 1); every message wakes every worker | a worker that cannot see the room repeats what was said, misses corrections and cannot offer what it found; waking on every message spends workers on chatter; one answerer per message keeps D20's "no double replies" |
| D22 | **Bridge provenance edge on everything, inherited.** Every entity created because of a bridge — tasks, subtasks, docs, artifacts, memories (incl. drafts), drawings, forms, loops, work sessions, messages, anything — gets `authored_from → bridge`, written by the server at creation time with props `{bridgeId, messageId, providerMessageId, sender, command, …}`. Inherited: a session started from a bridge holds `bridgeOrigins` in its launch context, and the entity recorder copies them onto every entity created under it, including child sessions, at any depth. Not opt-in, not agent-writable or removable. Several origins are all kept, deduped only on `(bridgeId, providerMessageId)`. Where the origin message is known, a second `authored_from` goes to it. These edges are what group commands query by kind (`/tasks`, `/docs`, `/workers`, `/memories`, v2 §4.4) — no per-group index, so a missing edge means a missing result, results follow D20's group scope, and edges survive moves and edits. §2.8. Approved by Subhang, 2026-10-29 (from WhatsApp) | the agent links what it makes (today's `authored_from → chat`, best effort); a property on the task only; a new `from_bridge` edge type; keep only the first origin | "everything from this bridge" and "where did this come from" become one graph query each, and stay true however deep the workers go; an agent cannot forget or forge provenance; one edge type keeps the query single; keeping every origin never loses where work came from |
| D23 | **Access is space-wide; a handle is only an address.** Any worker in the space can read and post on any bridge in the space. There are no seats, grants or `launched_by` checks. This replaces D21's "access comes with the handle" and the lineage limit on `bridges.handles.claim`. The only limits are hard checks in the outbox: pause, `direction: in`, a per-bridge `workerPosting` switch (on by default) and rate limits. Approvals never cross (D9). A handle is unique per space, on `(space_id, handle)` and `(space_id, entity_id)`, and lists the bridges it has appeared on. A worker gets one on its first post anywhere, or on request, and keeps the name in every group. Ending a session revokes nothing. Recent posters are read from `bridge_outbox`. §2.4, §2.7. Subhang, 2026-10-29; the `workerPosting` switch and the recent-posters list were settled in v4. | per-bridge seats granted by lineage (the v3 review's D23); handle-gated access (D21 as first written) | Every worker in a space is already trusted with its graph. Seats would add a failure mode, a worker that can't post where it was asked to, and protect nothing the outbox checks don't already cover. |
| D24 | **Fix notice: "fixed" means the PR merged.** It is event-driven, not a loop. A bug task created from a group message gets an origin edge to the bridge and the provider message (the `created_in` pattern, migration 066), one for each group it was reported in. Tasks created from group reports get the `pr_merged` completion gate (082; part of →done since 151) automatically. When the gate passes, each origin group's chat replies in the thread under the original report, through the outbox. If a fix has no PR, the teammate says what was done instead. This replaces the rule that a bug stays open, linked to its story. Subhang, 2026-10-29. | a scheduled "what got fixed" loop; a notice when the task is done | The merge is the fact. An event costs nothing when nothing happens. Per-group edges answer each reporter where they asked. |
| D25 | **One group → one bridge → one chat; the teammate is the shared part.** `bridges.create` and `bridges.retarget` refuse a chat that already has a bridge, so replies always go back to the group they came from. `teammateId` on the bridge is the reply signature and the default teammate; many bridges and chats may run as one teammate. General know-how and shared doc conventions are teammate memories; group-specific facts are bridge memories. Cross-group knowledge is free: the teammate may use what it learned in any group, and replies go only to the source group. The risk with external groups is noted; an `external` flag can come later. `tm8 bridge list` shows each group's name and purpose. Each group's chat keeps a rolling summary so its context stays bounded (§7.2 S). §2.1. Subhang, 2026-10-29. | one chat serving several groups; a teammate per group | Replies can never cross to the wrong group. The persona and its know-how scale across groups without copying. |
| D26 | **A loop is a teammate started on a schedule.** It extends main's first-class loops (#1413, 384/385), not a new executor.<br>• **Targets.** Its instructions say what to do and which groups to update, with a different message per group if needed; a bridge subject is optional. `targets[]` are the default posting targets, and their recent log is loaded at start. They are not a permission. For `post` reminders, which start no worker, `targets[]` is the full recipient list.<br>• **Pause** applies per group: a paused bridge is skipped with a `paused` result, and the run and the loop go on.<br>• **Modes.** `one-shot` posts and closes. `interactive` stays alive for the conversation and closes after about 30 minutes with nothing addressed to it.<br>• **Routing.** Posts are signed with the teammate's handle. A reply to a loop post goes to the live loop session, or to the group's chat once it has closed. Everything else goes to the group's chat. A new run ends the previous one (`concurrency: replace`).<br>• **No worker cap:** the launch queue and priority are dropped.<br>• **Quiet hours,** per bridge in its own timezone, hold only unprompted posts. Held posts are released when the window ends, newest only. An admin can exempt a loop.<br>• **Rate limits:** per (teammate, bridge), plus a per-number cap.<br>• **Owner leaves.** For loops with bridge targets, the loop is suspended and admins are notified; any admin may take it over by re-arming it in their name. Loops without bridge targets keep main's fallback to the space owner (`via: 'fallback'`).<br>• **Authority.** It posts as the teammate and acts on the owner's authority. Granted at arming: create and edit stories, docs, tasks and labels, and post to groups. Approval-gated, with the request going to the owner in tm8 and never to a group: delete, merging PRs, deploy, changing members, bridges or permissions, and over-budget spend. The PR tracker reports merges and never asks for them.<br>• **Provenance:** D30.<br>Subhang, 2026-10-29; the scope of owner-leaves suspension was settled in v4. | a new bridge-loop executor; per-run approval; keep the cap and the queue | Main already has the loop engine; a loop is a teammate plus a clock. Per-run approval would make schedules useless. The gated list is what can't be undone. |
| D27 | **Labels.** A flat, space-level `label` entity (name, colour, description). `entities.labels uuid[]` holds the ids, with a GIN index, a trigger that checks each id is a label in the same space, and no edges. Deleting a label archives it. `bug` is seeded in every space. §3.8. Subhang, 2026-10-29. | label edges; free-text tags; a `bug` kind | Ids survive renames, and an array is one indexed filter with no edge fan-out on every entity. |
| D28 | **Only connected groups are ever touched.** A number touches only the groups its owner connected one by one. Every other conversation is never read, forwarded, stored, logged, marked read or sent to, and both tm8 and the runtime enforce this.<br>• **Allowlist.** The server pushes it; the runtime drops everything else before forwarding.<br>• **Outbound** is checked twice. The outbox accepts only live, unpaused bridges. The runtime refuses any conversation off the allowlist, reactions, typing, polls and read receipts included.<br>• **No `/link` by DM:** only in connected groups, or a self chat the owner deliberately connected.<br>• **Owner only.** Only the number's owner creates bridges on it, and the wizard's group list is shown only to the owner, fetched live and never stored.<br>• **Unbridge or pause** takes a group off the allowlist at once. History is importable only for connected groups.<br>• **Communities** are out of scope. The wizard may pick several groups in one pass, each an explicit choice. An admins-only group the number can't post in falls back to `direction: in`.<br>§2.3, §6. Subhang, 2026-10-29. | server-side filtering only (Phase 1, and v3 §2.3 step 1) | The people in a member's other chats never agreed to tm8. Two independent checks mean one bug can't leak them. |
| D29 | **Agile work without new commands.**<br>• **Bugs** are tasks with the `bug` label (D27). There is no `/bug` or `/story`; teammates handle them in natural language.<br>• **Stories** use the existing `story` core kind (migration 283) and get provenance edges like every kind (D22).<br>• **Goals and sprints** are docs kept by the agile, goal and sprint teammates on one shared doc structure. Sprint loops are standing loops, armed once, that read the current sprint doc.<br>• **"Reply YES"** is intent, not approval (v2 §4.6).<br>• **`/remember` proposals,** when they ship, are accepted in tm8 by a linked member of that group, from an inbox item sent to the proposer and the group's linked members. A proposal from an admin-asserted link needs a member with a verified link, or an admin. Unaccepted proposals expire after 14 days. They are never accepted from WhatsApp.<br>Subhang, 2026-10-29; the acceptance rule was settled in v4. | a command per agile noun; new goal and sprint kinds; an admin's weekly batch | Natural language is what teammates are good at, docs already carry structure, and acceptance stays with the people in that group. |
| D30 | **Provenance follows what prompted the work.** A worker started from group A that posts in group B gets no B provenance for that post. It gains B as an extra origin once a B message is directed or routed to it; everything it creates from that turn on carries both, deduped under D22. Loop work gets `authored_from → loop`, plus `→ bridge` for the group whose message prompted it. §2.8. Settled in v4. | B provenance for any post in B; only the first origin | Provenance answers *what asked for this*, not *where it was said*. |
| D31 | **Bridge provenance is one edge per (entity, bridge), and the one-per-source index narrows in B1b.** *(Changes D22's "one edge per origin" in B0a, 2026-10-29; code-driven.)* Two facts on main rule out D22's key `(src, 'authored_from', bridge, providerMessageId)`. First, `public.edges` is `unique (src_id, dst_id, type)` at table level (001), and many writers use it as their `on conflict` target, so an entity cannot hold two `authored_from` edges to one bridge. Second, `edges_authored_from_source_idx` (015, renamed in 052) allows **one `authored_from` per source entity, globally**. The memory, artifact and chat paths depend on it ("the authoring session" is unambiguous), so the second edge D22 needs (beside `→ chat/session`) cannot be written today. So: **one `authored_from → bridge` edge per (entity, bridge)**, with `props.origins[]` (`{messageId, providerMessageId, sender, command, loopId?, inherited, viaSessionId, depth}`) deduped on `providerMessageId`, plus `props.bridgeId`. The `→ message` edges stay one per origin message, because their destinations differ. Queries are unchanged: `edge list --target <bridge> --type authored_from` still lists everything from the bridge. **B0a** registers `bridge` as an `authored_from` destination, keeps the edge recorder-owned (`entity_recorder`, already refused to `edges.create`/`delete` by `guard_w1_edge`), and requires `props.bridgeId = dst`. **B1b**, the first writer, narrows the one-per-source index to exclude bridge and message provenance (`where type = 'authored_from' and not (props ? 'bridgeId')`). In the same change it audits every reader of `authored_from` by source (about 21 SQL functions and 12 TS modules on main) so each filters to `dst kind in (work_session, chat)`. | narrow the index in B0a with no reader audit; drop the table unique; a new edge type (rejected by D22) | B0a stays shippable: no writer exists yet, so no reader can become ambiguous. The index and its readers change together, in the step that writes the edge. |
| D32 | **In B0a a bridge rides its connection directly; `credential_id` is nullable until the offer ships.** `bridges.create` takes the `bridge_connections` id of the caller's own number (`--connection <connection-id>`) and checks that the caller owns it (D28). `bridges.connections.offer`, which mints the `credential` entity (shape `connection`, a new server-only provider, §2.5), is not part of B0a. It means extending `space_credentials`' provider, shape and secret checks and the spawn reader. When the offer ships, create requires the offered credential and the column becomes `not null`. The content arm carries both `connectionId` and `connectionCredentialId: EntityId \| null`. 2026-10-29, B0a. | build the credential offer in B0a | Keeps B0a to the schema and doors B1 needs. The owner-only rule (D28) holds on the connection either way. |
| D33 | **D20's unique and D25's one-chat index hold over live bridges only.** Both are partial indexes, `where ended_at is null`. `bridges.remove` keeps the row as the tombstone (status `ended`, the log readable), so a table-level unique would keep a removed group from ever being connected again in that space. `bridge_identity_links`' unique is likewise over unrevoked rows, so a revoked link can be made again. Concurrent creates or retargets that pass the friendly checks still get `already_connected` / `target_has_bridge` from the unique-violation handler. 2026-10-29, B0a. | table-level unique; delete the row on remove | Remove is a tombstone (§2.1); reconnecting a group is a normal act. |
| D34 | **The bridge's `workers.wake` ceiling is a column in B0a.** `bridges.worker_wake` (`directed` by default) is the ceiling `bridges.listen` caps a worker's own level by (§2.7). Each worker's level is `bridge_read_cursors.wake`, beside its read cursor. Lowering the ceiling with `bridges.update --worker-wake` lowers every worker above it in the same write, so readers never take a minimum. v2 §5's wider `workers` object (`teammateId`, `projectId`, … `postLimit`) is added beside it when B1b needs it. 2026-10-29, B0a. | the full v2 `workers` object now | `listen` needs a ceiling in B0a; nothing else in `workers` does yet. |
| D35 | **The connector protocol's transport and the frames §2.5's table lacked.** Runtime → server frames are `POST /v2/bridge-runtime/<route>` with the `bridge_runtime` bearer. A 5xx or no answer is retried five times over about 30 s; a 4xx is not. Nothing is queued to disk. Server → runtime frames ride one WebSocket on the node's only upgrade path, told apart by `?bridgeRuntime=<runtimeId>` (the PTY's `?sessionId` idiom). Frames apply in order, except `allowlist`, which jumps the queue so a pause is never stuck behind a send (§7.3 item 12). Added frames: `allowlist`, `conversation-state`, `typing`, `read`. The `hello` reply carries the connections to run and each one's allowlist and `stateKey`. An allowlist version below the one held is ignored on every path (push, `hello` reply, `connect`), so a late snapshot never undoes a pause. The server must therefore keep versions growing across its own restarts. An allowlist pushed before its connection's `connect` is held and applied when it connects. The types are one module the server imports. *(B1a, 2026-10-29; code-driven.)* | a frame per catalog door with its own schema now; WS both ways | The server's one-upgrade-path rule (`events/ws-server.ts`); one typed module keeps both sides from drifting. |
| D36 | **The runtime enforces the allowlist twice, and reads nothing first.** (1) Baileys' `shouldIgnoreJid`: a stanza from any JID off the list (another group, any DM, status, newsletters) is answered **without being decrypted**, so no delivery or read receipt goes back for it. Baileys 7.0.0-rc14 NACKs an ignored message stanza (`UnhandledError`), so WhatsApp may redeliver it on reconnect, and it is ignored again: that is traffic, not a leak. The number's own JIDs stay open, because app-state keys ride them. (2) At `messages.upsert`, a message off the list is dropped on its key's JIDs alone, before its content or type is touched, leaving one counter. Poll updates count with messages. A connected self chat matches under the number's PN or LID. Sockets open only after the server's allowlist for that connection is in hand. History sync is not downloaded (`shouldSyncHistoryMessage: false`); import is D17's explicit job. No presence is announced (`markOnlineOnConnect: false`). The runtime sends a read receipt only when the server asks with a `read` frame. Only a group or the number's own self chat can match the list: a DM the server lists by mistake is never honoured. Baileys' own logger is clamped to `warn` or above, because at `info` and below it logs stanza attributes and whole group lists, off-list JIDs included. Residuals: app-state sync, which rides the own JIDs, decrypts contact and chat names for every chat in memory; nothing listens to it or stores it. Device-list notifications from people in no connected group are ignored too, so the device cache refreshes on Baileys' TTL instead. Messages the owner's phone sends to an unconnected DM are decrypted by the protocol (they arrive on the device's own JID) and dropped at (2). *(B1a; code-driven.)* | filter at upsert only | Decryption is reading. The earlier the drop, the less there is to leak. |
| D37 | **No `link.claim` frame and no echoes.** `/link` arrives as an ordinary `inbound` from a connected conversation and the server's command executor parses it. That can only ever come from a connected conversation, which D28 asks. The runtime runs with `emitOwnEvents: false`, so its own sends never come back as inbound. `sent` is the only settle. A `fromMe` inbound is the owner typing on their phone in a connected group. *(B1a; agreed with B1b, 2026-10-29.)* | `link.claim` per §2.5; echo frames matched to the outbox | One parser on the server; no race between an echo and its `sent`. |
| D38 | **The sealed key directory's key comes from the server.** Each connection's Baileys auth state is a directory of AES-256-GCM files (`<dataDir>/bridges/<connectionId>/*.seal`, 0700/0600) under a 32-byte `stateKey` the server sends in `hello` and `connect`. The runtime never writes the key, so the blob alone opens nothing. A QR or pairing code is posted to the server as an `auth` frame and never written to disk, unlike Phase 1's `qr.png` and `pairing-code.txt`. Each file is written to a temp file and renamed into place, so a crash never leaves torn keys. A logged-out or removed number's directory is emptied, even when its socket is down at the time. A stopped connection never restarts itself. *(B1a; code-driven.)* | the node key in the runtime's env; Baileys' plain multi-file state | §2.5 and §6: sealed under a key the server holds, with no secret at rest beside its key. |
| D39 | **Poll votes and media handles are self-contained.** A vote on a poll the runtime still holds in memory (its last 1,000 sends) is opened there. Otherwise it goes to the server `sealed`, and the server opens it with the poll's `sent.message`, which it keeps server-only. A media fetch handle is the message key plus its media keys (base64url). It survives restarts and is honoured only when its own chat is connected and equals the `media.fetch`'s conversation. A handle forged to point at another chat is refused. *(B1a; code-driven.)* | a runtime-side store of polls and media references | The runtime stores no content (D28, §2.5); the server already holds both. |
| D43 | **The bridgeRuntime doors are dedicated loopback routes, not catalog operations.** `POST /v2/bridge-runtime/<route>` (`hello`, `state`, `auth`, `conversations`, `conversation-state`, `inbound`, `sent`, `heartbeat`, `media`) is dispatched before the JSON body reader, like `/v2/voice/webhook`, and the push socket is `/v2/ws?bridgeRuntime=<id>` (D35). The identity resolver admits a `bridge_runtime` session only on these two and refuses it on every other route; the registry default-denies it too, and each SQL door re-checks a live `bridge_runtime` row. The catalog, the CLI and discovery never list them. *(B1b-2, 2026-10-30; code-driven.)* | catalog rows `bridgeRuntime.*` per §3.4 | The catalog is what a tm8 client may ask the node; these are a sidecar's frames on loopback. B1a's route set (D35, D37) does not map onto §3.4's six names. The auth isolation of §2.5 and §6 is unchanged, and it is enforced in one place (the resolver) rather than per catalog row. |
| D55 (was Q8) | **Hand-over: yes.** A bridge can move to another member's connection without being removed and re-created. It keeps its id, history, log anchor, participants and links, handles, memories, loops and provenance edges; only `connectionId` (and `connectionCredentialId`, D32) change. The current connection's owner or a space admin offers it to a member whose number is in the group; that member accepts in tm8, because only a number's owner puts a group on it (D28). The receiving connection's live group list must contain the conversation, or the accept is refused `not_in_group`. On accept, in one write: the old connection's allowlist drops the conversation, the new one's adds it (both versions bumped, D35), and outbox rows still `queued` are re-addressed to the new connection; rows already handed to the old runtime settle there or fail. D20's unique is untouched: it is one bridge before and after. Loops with this bridge as a target keep running; their posts go out on the new number. Never offered or accepted from WhatsApp (D9). Adopted 2026-10-30 as the design's recommended default under Subhang's go-ahead for the build. | remove and re-create; a hand-over the giver alone completes | Removing loses the history, handles and loops people rely on. The receiver's consent keeps D28's owner-only rule. |
| D56 (was Q7) | **Failover: none automatic; recovery is a manual hand-over.** When a connection goes offline or is logged out, its bridges go `degraded` and the watchdog raises its `fyi` attention to the connection owner (D19, §7.3 item 6); the same request now also goes to the space admins and names the hand-over. A space admin recovers a bridge by offering it (D55) to another member whose number is in the group; that member accepts. No second number reads or replies for a bridge on its own, and outbound never switches numbers by itself. A bridge is served by exactly one connection at any time. Adopted 2026-10-30 as the design's recommended default under Subhang's go-ahead for the build. | automatic failover to any member's number in the group; a standby connection per bridge | An automatic switch would post from a number whose owner never chose that group (D28). One serving connection keeps delivery and dedupe simple. |
| D64 | **The tick shows the ledger's states only. No *delivered* or *read*.** *(B2-ticks, 2026-10-30; code-driven.)* A bubble's tick is the outbox ledger as 398 badges it: `pending` (dispatching reads the same) → *queued*, `sent` → *✓ sent to WhatsApp*, `failed_retryable` → *retrying*, `failed_permanent` → *failed: <reason>*, `refused` → *not sent: <reason>* (*rate limited · retry in Ns* when `retryAfterMs` is set). The runtime protocol has no receipt frame, and `bridge_outbox` stops at `sent`, so a tick that claimed *delivered* or *read* would claim more than the server knows. Receipts are a later change: a protocol frame, outbox columns, and two more tick words. Status is colour **and** word, as tokens.css requires. | delivered/read ticks fed from nothing; colour-only ticks | the tick never claims more than the ledger knows; a test holds that no tick word says *delivered* or *read* |
| D65 | **One derivation of the badge; the bubble read wraps it.** *(B2-ticks; code-driven.)* `MessageView.bridge` (`MessageBridgeView`: provider, conversation, direction, participant, trust, delivery) rides every message read: `toMessageViews`, the event mapper's `message.*` arms and `bridges.log.read` (`BridgeLogEntry.delivery`). It is filled by one batched definer read, `internal.bridge_message_badges(ids)` (406). That read takes the delivery from 398's `bridge_message_delivery` rather than deriving it a second time. It reads the origin of the message **or its batch twin**, so a routed message's chat copy and log copy carry the same mark. It is a definer because trust needs `bridge_identity_links`, which the app role cannot list. The trust order is the resolver's: a verified link first, then this space's admin assertion. Live ticks are 398's: its triggers touch `messages.updated_at`, so `message.updated` carries the new tick. | a second badge query in TS; a `message.bridge` event | one place decides what a tick says; the copies of a routed message cannot disagree |
| D66 | **How a bridged bubble looks (§4.5), and the header chip's read.** *(B2-ticks.)* A guest's bubble is named for the participant, not the bridge that authored it (D4). Its avatar is two initials in the idle tone, keyed per (bridge, participant), so two guests never share one colour identity. A linked or asserted member keeps their own name and avatar, with the provider mark overlaid. Every inbound bubble's byline carries *◍ via WhatsApp* plus the trust word (*guest* / *linked ✓* / *asserted*), and that mark opens the bridge. The tick sits under an outbound message, in the body column. The chat header chip *Bridged from WhatsApp · Infra* (with the status word when the bridge isn't live) comes from the chat's incoming `bridged_to` edge. That is one `connections` read when a thread opens, in parallel with the `about` read, never one per listed row. Provider marks are bundled text glyphs (the `connector-logos` rule: no image, no URL). The pieces live in `tm8-ui/src/bridges/bridge-marks.tsx`, for the bridge panel to reuse. | the bridge's own name on a guest's bubble; a member colour for a guest; the chip read from the newest page's messages | a stranger is never drawn as a member; the chip is right on a chat whose newest page has no bridged message |

---

## 9. Open questions

None. Q7 and Q8, both from D20, were settled on 2026-10-30 with the design's recommendations: **Q7 → D56** (no automatic failover; a manual hand-over by a space admin) and **Q8 → D55** (hand-over keeps the bridge, its history, handles, memories and loops).

The six questions v1 left open (Q1–Q6) were settled on 2026-10-29 by adopting each recommendation, and are decisions D14–D19 in §8. The old numbers map as follows, so references to them (including in v2) still resolve: **Q1 → D14** (mirror every message), **Q2 → D15** (retention), **Q3 → D16** (guests triggering), **Q4 → D17** (backfill), **Q5 → D18** (channel members), **Q6 → D19** (watchdog). v2's own open questions are in its §7.

---

## 10. The design, read back against the laws

- **T-L2** — every surface here is an entity component (the bridge chip/card/panel), a collection view (the Bridges list, the People roster as rows of per-person state on one entity) or the two axes (the `bridged_to` edge; no hierarchy). The QR modal is stream UI inside a settings dialog, like the terminal canvas, and stores nothing.
- **T-L3** — one relation, one edge; every side table is config, per-person state or operational.
- **T-L4** — a bridge is a core kind with a typed detail table; providers are closed vocabulary, not `if (provider === …)` scattered through the UI: the capability sheet is data the registry reads.
- **T-L7** — the runtime has an identity (`bridge_runtime`) and authorship resolves through verified links; local is the degenerate case with one owner and one number.
- **T-L8 / T-L10** — relay for webhooks sits in the gateway; live bytes (QR frames) flow over the event socket and never through storage.
- **T-L11 / T-L12** — one contract, three transports; the server owns status, health and delivery truth; every mutation is idempotent on a client mutation id or an external message id.
- **T-D23** — all public communication is `messages.*`; the runtime's inbound door is an audited internal principal, like the delivery adapter's.
