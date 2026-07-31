# tm8 message routing analysis — self-delivery ("loopback") and missing reply context

Date: 2026-07-31
Scope: `packages/cli/src/commands/message.ts`, `packages/server/src/facade/services/w2/messages-handoffs.ts`, `db/migrations/019_w2_messages_handoffs.sql`

## Symptom 1 — "you are sending messages to yourself"

**What actually happens, end to end, for `tm8 message send --to <session-id> "..."`:**

1. CLI (`message.ts:messageSend`) posts `messages.post` with `anchorIds: [<session-id>]`, no `parentMessageId`. `packages/cli/src/commands/message.ts:309-335`
2. Server (`messages-handoffs.ts:post`) resolves `sourceWorkSessionId` — the *server-derived* work session the request was authored from (my own running session) — via `resolveAuthoredFromWorkSessionId`. `packages/server/src/facade/services/w2/messages-handoffs.ts:307-309`
3. It calls the RPC `w2_post_message_batch(anchors, ..., sourceWorkSessionId, ...)`.
4. Inside the RPC (`db/migrations/019_w2_messages_handoffs.sql:461-465`):
   ```sql
   if anchor.kind='work_session' then
     delivery_intents:=delivery_intents||jsonb_build_array(jsonb_build_object(
       'messageId',message_id,'targetWorkSessionId',anchor.id,
       'content',p_body,'mode','send'));
   end if;
   ```
   **This loop builds a delivery intent for every anchor whose `kind='work_session'`, with no check against `p_source_work_session_id`.** If the anchor you addressed is the same session you're running in, a delivery intent targeting *yourself* is built unconditionally.
5. Back in the facade, for each intent the server calls `messageDelivery.reserve(intent)` to actually claim a live PTY delivery. `messages-handoffs.ts:348-372`
6. `reserve_session_message_delivery` (same migration, line ~711) **does** have a guard:
   ```sql
   if source_session=p_target_work_session_id then
     raise exception 'self-contact is forbidden' using errcode='42501',
       detail='session_contact_forbidden';
   end if;
   ```
7. But the facade call site swallows this:
   ```ts
   try {
     const reservation = await this.options.messageDelivery.reserve({ ...intent, requestId: ctx.requestId });
     if (!reservation) continue;
     void this.options.messageDelivery.adapter.dispatch(...)...
   } catch {
     // reserve() itself failing is the one case still caught synchronously here
   }
   ```
   `messages-handoffs.ts:350-371`

**Net effect:** the message is always durably stored (this part is correct — it's why the human's chat panel, which reads via `messages.list` on the anchor, shows it). The *live-delivery* attempt to your own session is built, then silently rejected server-side and swallowed client-side — no error surfaces to the CLI caller either way. Nothing actually gets pasted back into your own PTY; the "self-contact is forbidden" guard does its job.

**So why did it *feel* like messages were "coming back to yourself"?** Because addressing `--to <this-session-id>` posts into the *same anchor thread this terminal's own transcript is part of*. There is exactly one thread for that anchor. Every message you send there — whether it originated from the human's chat UI or from your own CLI call — lands in the same durable thread and is then rendered by whatever surface (chat panel or terminal) is watching that anchor. There is no actual network loopback and no bug in *identity* (sender vs. recipient are recorded correctly, `authored_from` edge at line 468-471), but the storage-first design means **the anchor itself does not distinguish "the human's inbound turn" from "my own outbound reply"** — both are just messages on the same anchor, so a surface subscribed to that anchor will show both, which reads as "talking to myself" from the terminal side.

**Root cause, precisely stated:** `w2_post_message_batch` builds a `work_session`-targeted delivery intent for *any* work-session anchor, including the sender's own session, instead of skipping `anchor.id = p_source_work_session_id` up front (mirroring the guard that already exists one layer down in `reserve_session_message_delivery`). The redundant guard means no PTY-level self-paste occurs, but it does mean every self-addressed send pays for a reserve→reject round trip that is pure waste, and its silent `catch {}` makes the rejection invisible to the operator — indistinguishable from a successful delivery unless you inspect `tm8 message delivery <message-id>`.

**Suggested fix (not yet applied):** in the `foreach message_id in array anchors loop` in `019_w2_messages_handoffs.sql`, skip building a delivery intent when `anchor.id = p_source_work_session_id`:
```sql
if anchor.kind='work_session' and anchor.id is distinct from p_source_work_session_id then
  ...
end if;
```
This is a migration change (new numbered migration, `create or replace function`), not a hand-edit of 019.

## Symptom 2 — reply context not appearing in the terminal

When the human uses "Reply" in the chat UI on a specific message, the expectation is that the reply's context (which message it's answering) reaches the agent's terminal.

**Finding: there is no `message reply` command wired up in the CLI.** It appears only as documentation:
```
packages/cli/src/discovery/operations.ts:605
  '`message reply <message-id>` projects through this same operation after Server-side anchor derivation',
packages/cli/src/discovery/operations.ts:610
  "tm8 message reply <message-id> '<body>' --mutation-id <uuid>",
```
This is example/help text attached to `messages.post`'s catalog entry — it is **not** a registered `CommandModule`. `packages/cli/src/commands/registry.ts` and `MESSAGE_COMMANDS` in `message.ts:548-562` only register `list | send | update | delete | attachment add/remove | delivery`. There is no `path: ['message', 'reply']` anywhere, and `messageSend` never sets `request.parentMessageId` — the CLI has no flag for it at all (`resolveBody`/`messageSend` only ever populate `anchorIds`, `body`, `mentionIds`, `attachmentIds`, `actorId`).

**Consequence:** whatever pipeline turns a chat-UI "Reply to message X" action into a durable message either (a) has to call `messages.post` directly with a `parentMessageId` at the HTTP layer, bypassing this CLI entirely, or (b) it degrades to a plain `message send` with no `parentMessageId`. Either way, **nothing in the CLI's own send path can carry or surface "you are replying to message X"** — there's no `--parent`/`--root`/`--reply-to` flag on `message send`, and the documented `message reply <message-id>` shorthand doesn't exist as code.

**Where this needs to be chased next (outside what I verified here):** the chat UI's reply action and whatever server/service layer it calls directly (not via this CLI) — to confirm whether it actually sets `parentMessageId` on the wire at all, or whether the context is lost even before reaching `messages.post`. That surface lives outside `packages/cli` and I have not traced it yet.

**Suggested fix (not yet applied):**
1. Register a real `message reply` command in `message.ts` that takes `<message-id>` as the parent, derives its anchor server-side (per the existing doc note), and sets `parentMessageId` — OR add a `--parent <message-id>` flag to `message send`.
2. Once threading is on the wire, decide whether the terminal-facing delivery payload (`content` in `MessageDeliveryIntent`) should be augmented with a quoted/prefixed excerpt of the parent message, since a bare `parentMessageId` alone won't render as visible context in a PTY that just receives `content`.

## Summary

| Symptom | Root cause | Status |
|---|---|---|
| "sent to yourself" | `w2_post_message_batch` builds a self-targeted delivery intent for any `work_session` anchor, source session not excluded; rejected downstream by `reserve_session_message_delivery`'s `self-contact is forbidden` guard, and the rejection is swallowed silently by the facade's `catch {}` | Diagnosed; no self-paste actually occurs, but the round-trip is wasted and invisible. Same-anchor threading (not a bug) is why both directions render in one thread. |
| reply context missing in terminal | `message reply` is documentation-only; no CLI command or flag ever sets `parentMessageId` | Diagnosed; needs the chat UI's actual reply code path traced (outside `packages/cli`) to confirm where the context is dropped before this can be fixed end-to-end |

No code changes were made — this is analysis only, as requested.
