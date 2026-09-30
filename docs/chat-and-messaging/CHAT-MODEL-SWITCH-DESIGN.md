# Switching a running chat onto another model

**Status:** design, for review. Implementation exists on branch
`tm8/01a0f370-de77-7c6b-99e1-446abaea6040` and is NOT merged — see *Provenance* at
the bottom for the honest sequencing of this document against that code.
**Date:** 2026-09-30
**Task:** 01a0f36c-43eb-7060-9abc-4e966840c531
**Migration:** `db/migrations/276_chat_model_switchable.sql` (written, **not applied
anywhere**)

---

## 1. The report

> "When im running a chat i can only select model a one model i choose and work on
> the chat by asking questions, after the model answers i can send a message again,
> but this chat doesnt allow me to choose another model meaning once a model
> concluded or completed responding im not getting an option to change model and run
> with a new model of the same conversation."

Reproduced. Start a chat on any model, let it answer, then try to change the model
in the composer: the model control is greyed out and its tooltip reads *"the model
is fixed when a thread starts"*. The only way to reach another model today is to
start a new chat, which abandons the conversation.

## 2. The important part: the tooltip was telling the truth

The tempting fix is to delete `disabled={pinned}` from the model chip. That would
be the worst possible change, because **every layer beneath the chip also refuses
to carry a model change**, and four of them refuse silently. The chip would become
clickable, the label would move, and the next turn would run on the old model
anyway.

Six things all had to be true for the chip to be honest. All six were verified by
reading the code and the live database, not inferred:

| # | Layer | What it does today |
|---|-------|--------------------|
| 1 | `packages/tm8-ui/src/chat-home/ChatHomeScreen.tsx` | model chip is `disabled={pinned}` with the hardcoded `disabledReason="the model is fixed when a thread starts"` |
| 2 | `chat-home` port `postTurn` | sends no model; `ChatPostInput` has no model field to send |
| 3 | `packages/contract` | the chat surface carries a per-turn **`mode`**, but there is no `model` equivalent and no `chat.setModel` operation |
| 4 | `claim_next_chat_turn(uuid)` (migration 176) | returns `chat_row.model` **unconditionally**; `chat_turns` has no model column, so a turn cannot have a model of its own |
| 5 | `ChatOrchestrator.ensureRuntime` | reuses a live child whenever the authorization identity matches; it never compares the model, so even a changed `chats.model` could not dislodge a running child |
| 6 | `ClaudeHeadlessAdapter` | `--model` is **argv**, fixed at spawn — and the `interruptedThreads` tombstone compared `model`, so a post-interrupt resume on a different model threw `resume_mismatch` |

Layer 6 is the sharpest one and deserves naming, because it is the failure the
user would have hit first if only the UI had been unlocked: *Stop the agent, pick
another model, send* threw `resume_mismatch` — an error whose text blames the
conversation identity for what was actually a model change.

## 3. Is this even allowed? (the measurement the design rests on)

Everything above is tm8 policy. Before designing around it I had to know whether
the vendor CLI can do the thing at all: does `claude --resume <session> --model
<different>` keep the conversation, or does it start over?

Measured on this host, not assumed. A session was started on
`claude-haiku-4-5-20251001` and given the codeword **PLUM-7741**. It was then
resumed with `--resume <same-session-id> --model claude-sonnet-5`. The resumed
session **recalled PLUM-7741**, and the transcript recorded two different model
ids across the two turns.

**Conclusion: the conversation survives a model change, and the new model actually
runs.** The restriction is entirely ours. That single fact is what makes a design
possible instead of a rejection.

## 4. Design: the model is a **sticky property of the chat**

> A turn runs on the model the chat is set to **at the moment the turn is claimed**,
> and records what it actually ran on. First claim wins.

One new command:

```
POST /v2/chats/:id/model        body: { model }        -> { chatId, model, provider }
chat.setModel                  human-only             CLI: tm8 chat model <chat-id> <model>
```

Three properties, each chosen against a specific failure:

**Decided at CLAIM time, not at post time.** The user can queue a message and
change the model before the orchestrator gets to it; whichever the chat is set to
when the turn is claimed is what runs. Deciding at post time would make the
outcome depend on a race the user cannot see.

**Recorded after the fact.** `chat_turns` gains `model` and `provider` columns,
stamped inside the claim `UPDATE`, using a self-coalesce:

```sql
model    = coalesce(chat_turns.model, chat_row.model),
provider = coalesce(chat_turns.provider, chat_row.provider),
```

The self-coalesce is the whole point: a turn whose lease expires and is re-claimed
**re-runs on the model it started with** rather than silently adopting a newer one.
Without it, a switch during a retry would split one turn across two models.

**Sticky, not per-message.** Set it once and subsequent turns keep using it. This
is what the report asks for — *"run with a new model of the same conversation"* —
not *"send this one message to a different model"*.

### 4a. Rejected: the per-message carrier

tm8 already has a per-turn override mechanism for **mode** (migrations 153/154):
`messages.requested_chat_mode` → enqueue → `chat_turns.mode` →
`coalesce(turn.mode, chat.chat_mode)`. Copying it for model was the obvious move
and I rejected it for two reasons:

1. It answers a different question. Per-message model is "ask *this* to Sonnet";
   the report is "continue *this conversation* on Sonnet".
2. The cost is real. The message-borne path runs through
   `w2_post_message_batch` (~255 lines), and adding a second carrier means
   reproducing it. A sticky setting needs one small RPC and two columns.

Sticky does not preclude per-message later; it is the narrower change and the
columns it adds (`chat_turns.model`) are exactly what a per-message carrier would
need anyway.

### 4b. The one axis that cannot move: `agentTool`

`LAUNCH_MODEL_CATALOG` maps each model to a `provider` and an `agentTool`
(`claude-code` | `codex`). **`agentTool` is immovable for a chat's life.** Chat
composes exactly one runtime adapter, and the switch works by resuming a *claude
native session*; accepting a codex model would spawn `claude --model gpt-…` against
a session the other tool never wrote.

Refused in three independent places, deliberately not shared:

- the composer already offers only claude-code models (pre-existing);
- the handler, so an API caller gets `invalid_input` with a readable reason;
- `set_chat_model` in SQL (`22023`), so a caller that reaches the RPC another way
  is still refused.

The error names the remedy — *"chat % runs on % and cannot switch to a % model;
start a new chat instead"* — because this is the one case where starting over
genuinely is the answer.

### 4c. A caller names a MODEL and never a PROVIDER

`provider` is derived from the catalog, server-side, and is never accepted from the
client. Provider selects **which API-key backend the child process is handed**, so
an endpoint that took `provider` from a request body would let a browser choose
whose credential to spend. The response *returns* the resolved provider so the UI
can display it; it has no way to influence it.

**And a cross-space link identity cannot call it at all.** This was missed in the
first pass of this design and caught by the classification test that exists to catch
exactly it: `chat.setModel` sits in a watched namespace, so it had to be either
refused or explicitly passed with a reason, and the test fails until someone decides
which. Passing it would have been the wrong call.

`chat.setModel` starts nothing when it is called — but the next claimed turn closes
the live child and re-spawns it on the model the caller named, and that model carries
the provider that decides which of space B's API keys the child is handed.
`chat.start` is already refused for link identities as `process_start`. **An identity
that cannot start a chat on B could otherwise repoint an existing chat on B onto any
catalog model and spend B's credential running it. The asymmetry is the hole.** So it
is refused with the same class as `chat.start`:

```ts
{ prefix: 'chat.setModel', kinds: 'all', reason: 'process_start', exact: true },
```

The general rule this instance illustrates: **an operation that changes what a future
spawn will run is a process-start operation**, even when nothing spawns inside the
call. Two other entries on that list — `containers.pools.set` and the form-response
submit — are there for the same reason.

### 4d. Nothing is torn down when the setting is written

`chat.setModel` stores the setting and returns. The live child keeps running and
finishes whatever turn is in flight on the model it started with. The switch is
picked up by `ensureRuntime` on the **next** claim, which:

1. notices `live.model !== turn.model`,
2. closes the live child,
3. restarts it with `--resume` on the new model — **so the conversation survives.**

Killing the child inside the write would end an in-flight turn in order to apply a
setting that only affects the next one. The orchestrator therefore has to remember
what the *live child was spawned on* (`liveChats[].model`) rather than re-read
`chats.model`, which by then already holds the new value and would report that
nothing had changed.

The composer deliberately does **not** lock the model chip while a turn is running.
You can switch mid-answer; the current answer completes on the old model and the
next one uses the new one. Locking it would be defensible, but it would also mean
the control is disabled exactly when the user is most likely to want it.

## 5. Change surface

| Area | Change |
|------|--------|
| `db/migrations/276_chat_model_switchable.sql` | `chat_turns.model` + `.provider`; new `set_chat_model` RPC (security definer, `revoke all from public` + `grant execute to tm8_app`); `claim_next_chat_turn` replaced with the live 176 body **verbatim** plus the 5 added / 2 changed lines above; a `do $$` VERIFY block |
| `packages/contract` | `SetChatModelInput { model }` (chat is in the *path*), `SetChatModelResult`, zod schema, catalog row, **and the `SPACE_LINK_REFUSED` entry from §4c** |
| `packages/server/src/chat/handlers.ts` | `setChatModel`, registered under `humanOnly` |
| `packages/server/src/chat/scope.ts` | `chat.setModel` added to `CHAT_OPERATIONS_CLOSED_TO_RUNTIME` — an agent cannot change its own model |
| `packages/server/src/chat/orchestrator.ts` | `liveChats` records the spawned model; `ensureRuntime` compares it and restarts with resume |
| `packages/execution/.../ClaudeHeadlessAdapter.ts` | `InterruptedThread` no longer carries `model`; the post-interrupt guard compares only `nativeSessionId` and `cwd` — *which conversation*, not *how to run it* |
| `packages/tm8-ui` seam + chat-home port + `ChatHomeScreen` | `setChatModel` through all four seam layers; optimistic `modelOverrides` so the chip does not snap back; failure clears the override and surfaces the reason |
| `packages/cli` | `tm8 chat model <chat-id> <model>`, plus its discovery row |

**On the CLI header.** `packages/cli/src/commands/chat.ts` used to state that
`chat model` was *deliberately* absent because "every element of a chat's
configuration is pinned for its life (D3)". That paragraph is now false and was
rewritten rather than left to mislead the next reader.

## 6. Correction to an earlier claim of mine

Earlier in this task I reported that the per-turn **mode** plumbing from 153/154 is
wired server-side but unreachable from the browser, i.e. that the whole
153/154/#395 investment is dead from the UI. **That was wrong and I am correcting
it here.**

Measured against the live data: **59** messages do carry `requested_chat_mode`.
Every one of them equals its chat's own default, and every one is the chat's
**opening** message — stamped by `start_chat` itself (migration 176, ~748-751). The
322 turns I had counted as "differing" are NULL-mode legacy rows, all dated
≤ 2026-09-03.

Corrected claim: **the plumbing is exercised, but only by `start_chat`. No
follow-up turn has ever carried a per-turn mode, and per-turn switching has never
happened in production.** The mechanism works; nothing has ever used it for what it
was built for. That is a weaker and more accurate statement than "it is dead", and
it is also part of why §4a rejects extending that path rather than trusting it.

## 7. Named non-goals

**The composer's effort dial is decorative, and this change does not fix it.**
`effortByMode` never leaves the browser: there is no `effort` in the chats table, no
effort anywhere in the chat server path, and no `--effort` in the adapter's
`buildArgs`. Moving the dial changes nothing about the run. I found this while
tracing the model path and am recording it rather than fixing it — it is a separate
defect with a separate fix, and folding it in would hide a second behavioural change
inside this one. **It deserves its own task.**

**Per-message model override** — see §4a. Not built.

**Switching `agentTool`** — see §4b. Refused by design.

## 8. Test plan

1. **Adapter** — a post-interrupt resume with a *changed model* is allowed; a
   changed `nativeSessionId` or `cwd` still throws `resume_mismatch`. This is the
   regression test for the carve-out in layer 6.
2. **Orchestrator** — a model difference closes the live child and restarts it with
   resume-after-interrupt, i.e. the native session is reused, not replaced. The
   assertion that matters is *conversation preserved*, not *child restarted*.
3. **SQL** — `claim_next_chat_turn` diffed line-by-line against the live
   `pg_get_functiondef` output; only the 5 added and 2 changed lines moved. A
   dropped guard clause in a `create or replace` is silent and total, so this is
   verified by diff rather than by reading.
4. **First-claim-wins** — a re-claimed turn keeps its original model.
5. **UI** — the chip is enabled on a pinned chat and calls `setModel`; a rejected
   call clears the optimistic override and shows the reason.
6. **Census** — the catalog/discovery pins move by exactly +1 operation and +1
   command path.
7. **Space-link classification** — `chat.setModel` must appear in
   `SPACE_LINK_REFUSED`, not in `PASSES`. That test is not a count pin, it is a
   decision gate, and the edit that would have made it green without leaving
   `test/` was the unsafe one.

## 9. Risks and open questions

- **Migration 276 is unapplied.** `db/migrate.mjs up` applies *all* pending files,
  cannot target one, and currently refuses to run at all on a checksum drift in
  007. Landing 276 means trialling it as `begin; <file> rollback;` first, then
  `psql -1` plus the ledger insert — a deliberate, supervised act, not part of a
  deploy.
- **Cost is now user-switchable mid-conversation.** A chat can be moved onto an
  expensive model and left there. There is no budget guard in this design and I do
  not think there should be one here, but it should be a conscious acceptance.
- **`chat_turns.model` starts NULL for every existing row** and is only populated
  from the first claim after 276 lands. Backfilling it would be inventing history
  for turns whose actual model nobody recorded. Readers must treat NULL as
  *unknown*, not as *the chat's current model*.
- **Un-verified in a browser.** Everything above is proven at the source, contract
  and (for §3) subprocess level. Nobody has clicked the unlocked chip in a real
  page. "The API accepts it" and "I saw it work" are different claims and I am only
  making the first.

## 10. Provenance

Two things about how this document was produced, both of which affect how much to
trust it:

**It was written after the code, not before it.** The task asked for a design
document and a fix; I built the fix first and wrote this second. That ordering is
backwards and the user was right to stop me. The consequence to watch for is
motivated reasoning — a document written after the fact tends to justify the code
rather than examine it. The two places I would push back hardest if reviewing this
cold are §4 (sticky vs per-message) and §4d (not locking the chip during a turn).

**The repository code graph was unavailable in this lane.** `graphify-out/` was
never symlinked here, so the structural findings in §2 come from grep and from
reading the files, not from one `graphify affected` call. CLAUDE.md permits that
fallback only if it is stated, so it is stated. Anyone re-verifying should run
`ln -s <launch-project>/graphify-out graphify-out` first and re-ask the structural
questions properly.
