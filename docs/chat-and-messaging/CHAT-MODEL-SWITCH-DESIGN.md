# Switching a running chat onto another model — and onto another mode

**Status:** design, for review. Implementation exists on branch
`tm8/01a0f370-de77-7c6b-99e1-446abaea6040` (PR #978) and is NOT merged — see
*Provenance* at the bottom for the honest sequencing of this document against that
code.
**Date:** 2026-09-30
**Task:** 01a0f36c-43eb-7060-9abc-4e966840c531
**Scope:** §1-§9 are the MODEL picker (the reported defect). §10 is the MODE picker
(`ask` / `explain` / `plan` / `build` / `orchestrate` / `craft`), added when the task
was extended to the composer's other controls. The two look like one feature and are
not: read §10 before assuming what holds for one holds for the other.
**Migration:** `db/migrations/276_chat_model_switchable.sql` — **executed**, on CI's
ephemeral postgres only. See §9.

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

**§10 is the sequel to this section.** Having measured that the 153/154 carrier works
and has never been used for a follow-up turn, the extended task then USED it — the
mode picker now sends per-turn mode over exactly this path. So the plumbing this
section calls "exercised only by `start_chat`" is, as of §10, exercised properly.

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
   command path. That is the semantics; the COST is not proportional to it, and
   this is the part to budget for. MEASURED on the finished branch: that single
   +1 landed in **59 changed assertion lines across 24 test files**. Three of
   them are not counts and cannot be derived by hand — the generated catalog
   **digest** (a 64-hex hash; take it verbatim from a failing run's Received
   value), sweep's `HANDLER_AUTHORED_400` exact **list**, and the migration chain
   length. And the pins come in FAMILIES that move together: an operation with a
   registered handler moves the catalog totals AND every count of handlers
   (`registry.size`, `registered.size + residual.length`, distinct swept ops),
   which in two files sit on the line immediately after a total I had already
   bumped. Sweep for the ASSERTION, not for one pin's spelling: the same pin is
   written `implemented: N` in most files and `expect(body.implemented).toBe(N)`
   in `public-harness.test.ts`, and a shape-matched grep silently clears the
   second form. Fixing these one CI round per file costs a round per file and
   stops at the first aborting assertion in each test.
7. **Space-link classification** — `chat.setModel` must appear in
   `SPACE_LINK_REFUSED`, not in `PASSES`. That test is not a count pin, it is a
   decision gate, and the edit that would have made it green without leaving
   `test/` was the unsafe one.

## 9. Risks and open questions

- **Migration 276 has been EXECUTED, but on no durable database.** An earlier
  revision of this bullet — and a closing report from the implementation fork —
  said it "has never been executed anywhere, not even trialled". Both were wrong
  and are corrected here. What actually happened: CI's `migrations apply clean` job
  ran the whole sequence including 276 against a fresh postgres and **passed**,
  which means 276's own `do $$` VERIFY block ran and its assertions held — both
  `chat_turns` columns exist, `set_chat_model(uuid,text,text,text)` and
  `claim_next_chat_turn(uuid)` both resolve via `to_regprocedure`, and the
  `revoke … from public` posture is correct (the 156 -> 160 lesson). I also trialled
  the patched function as `begin; create …; rollback;` on `tm8_dev`.
  **What that does NOT prove:** the guard's runtime BEHAVIOUR. Nobody has called
  `set_chat_model` as one identity against another identity's chat and watched it
  raise `P0002`. "It applies and its assertions hold" and "its authorization works"
  are different claims and only the first is made here.
  It remains applied to no persistent database (prod was at 275, dev at 273), and
  landing it there is still a supervised act, not part of a deploy: `db/migrate.mjs
  up` applies *all* pending files, cannot target one, and currently refuses to run
  at all on a checksum drift in 007. The route is `begin; <file> rollback;` first,
  then `psql -1` plus the ledger insert.
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

## 10. Part II — switching MODE mid-conversation

The task was then extended to the composer's other picker: *"many features in the
chat composer ask, plan build orchestrate and all check these as well"*. **The
finding is the mirror image of Part I's, and that is the single most useful thing in
this document.** Part I needed a migration, a new operation, six unlocked layers and
a child restart. Part II needed a `disabled` attribute removed and one field
forwarded. Everything else was already built — and built deliberately for this.

### 10a. The carrier exists end to end, and always did

| Layer | Already present | Evidence |
|---|---|---|
| SQL 153 | `messages.requested_chat_mode`, and the enqueue trigger that first copied it onto `chat_turns.mode` (dropped by 176, below) | `154_*.sql:4-7` |
| SQL 154 | `w2_post_message_batch` takes `p_chat_turn_mode` (defaulted, so every existing 8-arg caller still compiles) and validates against the six modes, raising `22023` on an unknown one | `154_*.sql:31,56-60` |
| SQL 176 | drops 153's trigger; `w2_post_message_batch` now queues every turn itself and stamps `coalesce(turn_mode, chat_anchor.chat_mode)` onto `chat_turns.mode` at queue time | `176_*.sql:456-457,1361` |
| claim | the turn's effective mode resolves `coalesce(turn.mode, chat.chat_mode)` — the same first-wins shape Part I gives the model | 176 claim body |
| contract | `PostMessageInput.mode` / `PostMessageWireInputSchema.mode` — the field was already in the wire type | `contract.ts:3311`, `schemas.ts:2791` |
| server | already forwards it to the RPC | `messages-handoffs.ts:465-485` |

Migration 154's own header states the intent: *"getting the mode a human chose at
send time ONTO the message, so it flows message → chat_turns.mode → the turn
envelope."* **The browser was the only thing in that chain that never sent it.**

**Correction: whose trigger, and whether it still exists.** #978 shipped comments
saying the mode is copied onto `chat_turns.mode` by "154's enqueue trigger"
(ChatHomeScreen.tsx and mode-switch.test.tsx) or "the enqueue trigger"
(real-port.ts, types.ts), and this table's first row read the same way. The
trigger was 153's, and it has not existed since 176, which dropped it
(`176_chat_entity.sql:456-457`) and moved the copy into `w2_post_message_batch`,
which stamps the mode when it queues the turn (`:1361`). The comments were
corrected in the follow-up, and the rows above now give the history. 276's header,
which calls this "the 153/154 message-borne carrier", is left as applied:
`db/migrate.mjs` checksums every applied file, so an edit fails loudly on any
database that has already run it, and nobody can list every such database.

### 10b. Why a mode switch needs no restart and a model switch does

The chat system prompt is **deliberately mode-independent**. `chatSystemPrompt`
embeds a `MODE_GUIDE` describing *all six* modes at once, and `compose.ts:204` says
so outright — *"envelope line selects which one applies. `input.chatMode` is not read
here."* Each turn then carries its own `[mode: x]` line from `chatModeLine`, and
`compose.ts:156` records the reason: *"so a mode switch never rewrites the launched
prompt."*

That is the whole asymmetry:

- the **model** is *argv*. Changing it means a different process, so Part I has
  `ensureRuntime` close the live child and restart it with `--resume` — which is
  also why Part I needed the adapter's `resume_mismatch` carve-out.
- the **mode** is *prompt text inside one turn*. The running child needs no notice;
  the next envelope simply says something different.

### 10c. A mode states INTENT, not PERMISSION — and that is what makes 10b safe

`toolPermission(_mode, _tool, _operation)` in `packages/mcp/src/modes.ts:81`
returns `'allow'` unconditionally, so `exposedToolNames` is the **identity filter**:
every tool is exposed in every mode. Its comment is explicit — *"Every mode carries
the SAME full tool surface … What separates the modes is the system prompt, which
says how to work, not what may be touched."*

**This is load-bearing for the mid-chat switch, and it was not load-bearing before.**
The launch mode has two spawn-time consumers, and a running child keeps both:

1. `TM8_CHAT_MODE` is stamped into the child's env at spawn (`compose.ts:280`) and
   parsed back by the MCP server (`packages/mcp/src/env.ts:38`).
2. the provider's `--allowedTools` list is computed once at spawn from
   `exposedToolNames(launchMode, …)` (`compose.ts:89`).

Both collapse to the identity *while* `toolPermission` returns `allow`, so a per-turn
switch is behaviourally complete with no restart. **Narrow a mode there and the
switch silently half-applies:** the envelope would tell the agent to `build` while
the env var and the argv still carried `ask`'s tool surface — instructed to do one
job while holding another's tools, with no error raised anywhere. This is now written
as a warning at `modes.ts`'s own policy comment, because that is where someone would
break it; whoever re-introduces a narrowing owns either respawning on a mode change
or refusing the mid-chat switch for that mode.

**A third consumer was live, not latent (found after #978 merged).** `tm8_overview`
echoed the router's mode back as `mode` (`packages/mcp/src/tools.ts`). So after a
mid-chat switch the agent was told `[mode: build]` by its turn and `mode: ask` by its
own overview tool, and a human reading the tool result in the thread saw the same
contradiction. The fix is a read fix, not a restart. The overview now says where the
current mode lives (`modeSource`: the turn's `[mode: …]` line) instead of echoing the
launch value; the MCP server has no per-turn channel, and that line is the one copy
that is always current. Respawning on a mode change was considered and rejected. A
mode is per turn, so every switch would become a restart just to keep a stale copy
consistent. The child's close is stdin → SIGTERM → SIGKILL, so whatever it still had
running would die, on top of a cold start.

**The invariant is a test now, not only a comment.** `packages/server/test/chat/
orchestrator.test.ts` › "the spawn surface is mode-independent" runs the real launch
resolver under the real orchestrator for all 36 ordered mode pairs. It requires the
child answering the second turn to hold exactly what a launch in that turn's mode
would hold: argv, the MCP env, and the MCP router rebuilt from the child's own config
file. Negative controls, run when it was written:

- restoring the overview echo fails it on `mode`;
- narrowing Ask's `tm8_act` without a respawn fails it on `tm8_act`;
- the same narrowing *with* a mode respawn passes it, and fails only the pin test
  that says a mode switch keeps the child.

It fails exactly when a mode narrows and nothing restarts.

### 10d. The two pickers resolve differently, on purpose

|   | MODEL (Part I) | MODE (Part II) |
|---|---|---|
| Scope | **sticky** on the chat — "continue this conversation on Opus" | **per-turn** — "answer *this one* as plan" |
| Carrier | `chats.model`, via a new `chat.setModel` operation | `messages.requested_chat_mode` on the turn itself |
| Reverts? | no — it stays until changed again | yes — the next turn is the thread's default again |
| Restart? | yes, close + `--resume` | no |
| New migration | 276 | none |

The asymmetry is intentional and matches what a human means by each word. "Switch to
Opus" is a decision about the conversation; "plan this" is a decision about the
request in front of you. §4a rejected a per-message model override for exactly the
reason §10 embraces a per-turn mode: the mode already had a validated carrier and the
model would have needed a ~255-line RPC reproduced.

### 10e. Change surface (browser only)

| File | Change |
|---|---|
| `chat-home/types.ts` | `ChatPostInput.mode?: ChatMode` — omitted means "the thread's default" |
| `chat-home/real-port.ts` | `postTurn` forwards `mode` when present |
| `ChatHomeScreen.tsx` | `modeOverrides` state beside `modelOverrides`; chip `disabled={modeLocked}` (was `disabled={pinned}`); `/build`-style slash picks route through the same `chooseMode`; the send site attaches the pick |
| `chat-home/mode-switch.test.tsx` | 5 tests, new |

`modeOverrides` is deliberately **never reconciled against a served value**: a
turn's mode belongs to the turn, so a reload correctly shows the thread default
again. No census pin moves — no new operation, no new route.

### 10f. What Part II does not do

- **It does not make the mode sticky.** There is no "set this chat's mode to build
  from now on" — `chat.setMode` does not exist. A pick rides one turn.
- **It is unverified in a browser**, exactly as §9's last bullet says of Part I.
  The tests drive the real component through a fixture port and assert the outgoing
  field; nobody has watched an agent receive a switched mode in a live page.
- **It does not touch the effort dial**, which is still decorative (§7).

### 10g. What each answer ran under

Once both the model (276) and the mode (153/154) can change between turns, the
chat's config describes the NEXT turn, not the ones already on screen. The byline
printed the chat's default mode on every turn and titled it "This answer ran in …
mode", which was false for any turn sent in another mode and for every message a
worker posted into the chat.

**The label is read off the answer's own turn row.** `MessageView.ranUnder`
(`{ model, provider, mode }`) comes from the `chat_turns` row whose
`agent_message_id` is the message: `model`/`provider` stamped at claim (276), `mode`
stamped at queue time (176:1361). It is set on answers only, and absent means "no
record", never "the chat's default". The UI draws `chat-turn-ran-under` from it, and
draws nothing when it is absent. It is on `MessageView` only, not on
`WorkSessionInteractionProfileProjection.browserProjection`, whose field list is
closed on purpose.

**A row from before 276 falls back to its queue-time pricing stamp.**
`pricing_model`/`pricing_provider` are NOT NULL and stamped when the turn was queued.
That value is exact for any turn that predates 276, because nothing could move a
chat's model before 276. A row with no `mode` falls back to `chats.chat_mode`, which
is written only at insert.

**Correction to 276's column comment.** 276 says of `chat_turns.model`/`provider`:
"NULL on a pre-276 row; readers coalesce to chats.model". That is right for the
claim, which reads `chats.model` at the moment it is the value the turn is about to
run on. It is the wrong fallback for `ranUnder` and for any other historical read:
`set_chat_model` moves `chats.model`, and an answer from before the move never ran
on the new value. `chat-storage.pg.test.ts` pins the difference. It moves
`chats.model`, clears the turn's stamps, and asserts that the label reports the
pricing stamp and not the moved value. 276 itself is left as applied, because
`db/migrate.mjs` checksums applied files and a comment is not worth a migration.

**No deploy ordering.** A UI bundle older than the field ignores it, because the UI
does no runtime validation of responses. A server older than the field omits it,
and absent draws no label.

## 11. Provenance

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

**Part II was written in the same wrong order — and it caught something anyway.**
§10 also documents code that already existed. But §10c's finding (the two spawn-time
consumers of the launch mode, and what breaks if `toolPermission` ever narrows again)
was found *while writing the section*, not while writing the code: the act of having
to state why no restart is needed is what exposed the assumption the fix rests on. I
had already shipped the change believing "mode is prompt text" was the whole story.
It is the whole story only because of an invariant three files away. That is the
argument for the sequencing the user asked for in the first place.
