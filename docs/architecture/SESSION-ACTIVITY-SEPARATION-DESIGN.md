# Session Activity — separating "is it alive" from "is it busy"

Status: **PROPOSED**. Supersedes the recording half of PR #10
(`feat/session-block-detection-clean`), keeps its detection and presentation halves.
Author: review of PR #10 + Agent Orchestrator comparison, 2026-08-05.

---

## 1. The problem, in one sentence

When an agent stops and waits for a human — a permission dialog, a question — that
fact exists **only as pixels in a PTY**, so a blocked agent is indistinguishable from
a working one on every durable surface tm8 has.

Chat shows only what an agent durably posted. The session list shows a recorded
status that nothing updates between spawn and exit. An agent can sit blocked
forever and the product will keep drawing it as `running`.

Note what this is *not*. The original grooming for this work described chat lagging
behind a streamed log tail on a poll interval. tm8 has no such thing — chat is a
durable message/activity feed refreshed off the event stream with a 300 ms debounce,
and its latency is already fine. **Chat is not behind the terminal; it is blind to
it.** Fixing latency would have been work against a defect that does not exist.

## 2. What already exists (and what is actually missing)

tm8 designed the whole answer to this and deliberately left one piece out.

| Layer | State |
|---|---|
| `needs-you` presentation verdict, outranking `streaming` | exists — `terminal/session-presentation.ts` |
| Pill, `NeedsYouBanner`, home-screen NEEDS YOU group | exists |
| Registry predicate `live && status === 'idle'` | exists — `domain/registry.ts:336` |
| `'idle'` accepted as a `work_session` status | exists — migration `043:107`, `001:704` |
| Every DB live-set predicate accepts `idle` | exists — `001:720`, `019:1154`, `072`, `065`, `066` |
| **Anything that measures and records the fact** | **missing** |

The code says so out loud: *"no server detection exists in this program, so on real
data it stays quiet"* (`domain/registry.ts`), and *"the day detection lands, no design
work is owed"* (`terminal/NeedsYouBanner.tsx`).

So this is a **producer** problem, not a UI problem. Almost no new UI vocabulary is
owed.

## 3. Why PR #10's recording half cannot work

PR #10 supplies exactly that missing producer, and its detection and presentation
halves are sound. Its **recording** half writes the measurement into
`work_sessions.status` as the value `'idle'`. That specific choice is fatal, and it
was proven, not argued:

`packages/tm8-ui/src/data/real/liveness.ts:172` — THE liveness predicate, R-UI-5's
single source of truth for the entire UI:

```ts
statusOf(session): SessionLiveness {
  if ((session.workStatus as string | null) !== 'running') return 'not-running';
```

Anything that is not the literal `'running'` is dead. That predicate was written under
the silent assumption that `'idle'` never occurs — which was true, because **nothing
had ever written it**. PR #10 is the first writer, and it detonates the assumption.

The chain:

1. PTY quiet 10s → `SpawnService.handlePtyActivity` writes `status='idle'`
2. `entity.upsert` → `useGateData.livenessOf` reads `state.status = 'idle'` (`:952`)
3. `seam.liveness.statusOf({workStatus:'idle'})` → `'not-running'`
4. `sessionNeedsAttention = live === 'live' && row.status === 'idle'` → **false, always**

The predicate is **unsatisfiable**: `status === 'idle'` can only be true in the same
instant that the same field forces `live` false.

And the damage exceeds the dead feature. The `'not-running'` branch of
`sessionLiveTreatment` renders `label: 'not running'`, `attachable: false`, *"there is
no terminal to attach to."* So a **live** agent, ten seconds after going quiet, reads
as dead and loses its terminal-attach affordance — in exactly the case the feature
exists for, because an agent blocked on a permission dialog is silent by definition.

### 3.1 Why the one-line widening is not the fix

`statusOf` could widen to `!== 'running' && !== 'idle'`. That is safe — the task
vocabulary `WorkStatus` (`contract.ts:45`) has no `idle` member, so it cannot collide
with the other vocabulary `statusOf` accepts (`seam.ts:456`).

It is still the wrong fix, because it treats the symptom. The root cause is that
**one column is answering two different questions**:

- *is this session's process alive?* — lifecycle
- *is the agent currently doing anything?* — activity

These are orthogonal. A session can be alive-and-busy, alive-and-waiting,
dead-having-been-busy. Overloading one column means every write of one answer
destroys the other, and every reader has to know which question the current value is
answering. Widening the predicate buys one round; the next activity value
(`waiting_input`, `blocked`) re-opens it.

## 4. Prior art: Agent Orchestrator

AO (`github.com/Untrivial-ai/agent-orchestrator`) solves this exact problem and is
ahead of tm8 in five places that matter here.

1. **Two fields, not one.** `domain/session.go:60` `Activity Activity` and `:67`
   `IsTerminated bool` are independent columns. Lifecycle and activity never share
   storage. This is the root-cause fix.
2. **Ask the agent, don't watch the pixels.** At spawn AO writes hook config into the
   worktree (`.claude/settings.local.json`, `.codex/hooks.json`,
   `.opencode/plugins/*`), each invoking `ao hooks <agent> <event>`, which POSTs to
   `/api/v1/sessions/{id}/activity` (`cli/hooks.go:113-131`). Mapping
   (`activitystate.go:24-37`): `session-start`/`user-prompt-submit` → active,
   **`stop` → idle**, `permission-request` → waiting_input. `stop` is a real
   turn-ended signal; silence is only a proxy for it.
3. **Four states, and "quiet" ≠ "waiting".** `active | idle | waiting_input | blocked
   | exited` (`domain/activity.go:7-26`). `blocked` specifically means a pending
   decision where a stray keystroke could **answer** it — automated senders must never
   inject. Two user-facing strings, not one: `"Input Needed"` vs `"Awaiting Decision"`
   (`en.json:2-7`).
4. **Per-adapter capability declaration.** `ports/agent.go:120-152`:
   `EmitsSubmitActivity()` / `EmitsBlockedActivity()`. Codex declares blocked=false —
   *"it installs no post-tool-use hook, so a blocked state could never be cleared
   mid-turn. confirmActive must not nudge it (an Enter could answer a pending decision
   it cannot report as blocked)"* (`codex.go:49`). Honesty enforced structurally
   rather than in prose.
5. **Conservative fallbacks.** Where AO scrapes, it matches real markers, not silence:
   Codex's detector looks for the composer `›` plus the ` · ` footer and explicitly
   **rejects** `esc to interrupt` (`codex/terminal_activity.go:10-36`). Its
   reconciliation poller only acts after **2 minutes** and only for a session that has
   already produced a hook signal (`observe/activity/observer.go:14-18,103-137`). Its
   no-signal grace is **90s**, and past it the answer is `StatusNoSignal` — "we have
   lost the pipeline" — **not** a confident `Idle` (`service/session/status.go:9-16`).

## 5. Design

### D1 — Activity is a separate column. (Root-cause fix.)

Add `work_sessions.activity` and `work_sessions.activity_at`. `status` keeps its
current meaning — lifecycle only — and its current vocabulary
`spawning|running|idle|exited|failed` is **left untouched**.

Consequences, all good:

- `statusOf` needs **no change**. A busy/quiet agent stays `status='running'`, so it
  stays `'live'`, keeps its terminal-attach affordance, and keeps its live-set
  membership in the concurrency cap and the delivery guards.
- The needs-you predicate becomes `live && activity === 'waiting'`, which is
  structurally incapable of defeating itself: two fields, two questions.
- The legal-but-unwritten `status='idle'` value stays unwritten. It is a documented
  trap; leave it disarmed rather than arming it. (Consider a follow-up that removes it
  from the vocabulary entirely, once nothing references it.)

**Ruling: do not write activity into `status`.** This is the single most important
decision in this document.

### D2 — Activity vocabulary

```
busy | quiet | waiting_input | blocked
```

- `busy` — the agent is working. Positive evidence.
- `quiet` — **measured silence only.** "This PTY produced output and has now produced
  none for N." It is NOT a claim that a human is needed. This is the honest name for
  what PR #10 called `idle`, and renaming it is deliberate: `idle` reads like a
  verdict, `quiet` reads like a measurement.
- `waiting_input` — the agent reported it is at a prompt awaiting instruction. Safe to
  message, safe to nudge.
- `blocked` — the agent reported a **pending decision**. A stray keystroke could
  answer it. Automated injection is FORBIDDEN in this state.

The last two require a structured signal and are unreachable until Phase 2. Define
them now anyway, because the whole point of D4 is that a producer must be able to say
which of these it can honestly emit.

Absent — deliberately — is a fifth value for "we have no idea". That is the *absence*
of an activity record, and `NULL` already says it.

### D3 — Producers, in confidence order

1. **Hooks (Phase 2, preferred).** Agent-reported events, per AO. tm8 already writes
   agent config at spawn (`workspace-trust.ts`), so the pipe exists.
2. **Adapter-specific terminal markers (Phase 3, optional).** Only where an agent has
   a reliable idle marker.
3. **Generic silence (Phase 1, the floor).** PR #10's detector, retained essentially
   as-is — it is well built. Emits only `busy`/`quiet`, never the two strong states.

A producer never overwrites a stronger signal with a weaker one within the same turn:
a hook-reported `blocked` is not cleared by the silence detector noticing silence,
because a blocked agent *is* silent. Only the matching `post-tool-use` (or the next
hook event) clears it — AO's `tool_use_id` correlation is the model.

### D4 — Producers declare what they can honestly emit

Per AO's `ActivitySignaler`. Each agent adapter declares:

```ts
interface ActivityCapability {
  emitsTurnBoundary: boolean;   // can report turn end (hook `stop`)
  emitsBlocked: boolean;        // can report AND CLEAR a pending decision
}
```

The rule this buys, which is the real payoff: **a session whose adapter has
`emitsBlocked === false` may never be auto-injected while quiet**, because its
quietness might be an unreported permission dialog and the injected Enter would answer
it. Today that hazard is managed by comments; here it is managed by a flag.

### D5 — Presentation is derived, never stored

`session-presentation.ts` already owns the ladder. Extend it to read the new field;
store no display status. Precedence, following AO's:

```
exited/failed        -> exited | failed
activity = blocked   -> "Awaiting decision"   (needs-you; NEVER auto-inject)
activity = waiting   -> "Input needed"        (needs-you; safe to message)
activity = busy      -> streaming | running
activity = quiet     -> "Quiet for N"         (needs-you, weak tone)
no activity record and past grace -> "No signal"   (NOT idle, NOT running)
```

`No signal` is the honest state PR #10 has no way to express, and it is the one that
tells an operator their hook pipeline is broken rather than that their agent is
resting.

### D6 — Copy states the measurement, never a guess

Retained verbatim from PR #10, which got this right and should be credited for it. A
detector that reports silence must say *"no terminal output for a while — it may be
waiting for you"* and must never invent a question, because a wrong guess is
indistinguishable from a right one at the point of use.

Corollary: `blocked`/`waiting_input` may use confident copy **only** because they come
from the agent. The vocabulary split in D2 is what earns the right to different words.

### D7 — Both content surfaces, one predicate

Retained from PR #10. The terminal and chat surfaces are both mounted and only one is
visible, so a signal drawn only in the terminal is invisible to precisely the reader
this work is for. One shared predicate (`domain/needs-attention.ts`) so the list and
the open session cannot disagree.

### D8 — Delivery guard

Per AO's `sessionguard.Nudge()`: **re-read the session immediately before injecting**
and refuse if state moved; refuse outright for `blocked`, and for `quiet` on an adapter
with `emitsBlocked === false`. A suppressed delivery is **not** stamped delivered, so
it retries. This is independent of the rest and is worth landing on its own.

### D9 — Thresholds are measurements, not guesses

PR #10's `idleAfterMs = 10s` is, by its own admission, its least-defended number, and
AO's comparable numbers are **90s** (no-signal grace) and **120s** (reconciliation).
10s will fire on any agent pausing to think or running a silent build.

Proposal: `quiet` after **45s**, no-signal grace **90s**, both configurable, both
carrying a comment recording how they were derived. They must be **derived against
real agents** before they are treated as settled — the delivery constants beside them
were, and carry a warning against tidying them.

## 6. Data model

Next free migration number is **074+** in this tree (073 is the highest committed).
Verify at implementation time — parallel lanes make "next free" stale within minutes,
and `create or replace` lets a later file silently win.

```sql
alter table public.work_sessions
  add column activity text
    check (activity in ('busy','quiet','waiting_input','blocked')),
  add column activity_at timestamptz;
```

Both nullable: NULL means "no activity record", which is a real and different fact
from any of the four values, and must not be collapsed into one.

- `status` semantics: **unchanged**. No existing predicate, guard, index or view moves.
- The partial live index (`001:720`) and every `status in ('spawning','running','idle')`
  guard are untouched.
- A transition RPC arm (or a small sibling RPC) writes activity. It must NOT reuse
  `work_session_transition`'s status arm, or the two questions re-merge at the API
  boundary having just been separated in the schema.
- Backfill: none. NULL is correct for every existing row.

## 7. Phases

| Phase | Content | Blocked on |
|---|---|---|
| **1** | D1 migration; retarget PR #10's detector at `activity`; `busy`/`quiet` only; D5 presentation; D7 both surfaces; D9 thresholds | nothing |
| **2** | Hook integration (D3.1) — config at spawn, one endpoint, `waiting_input`/`blocked` reachable | Phase 1 |
| **3** | D4 capability flags + D8 delivery guard | Phase 2 |
| **4** | Answer a prompt **from chat** | Phase 2 + 3 |

Phase 4 carries a hard constraint inherited from PR #10 and it must survive into
implementation: **it must never be done by writing bytes at a TUI dialog.** A dialog
opens with an option pre-highlighted, so a blind Enter is a blind approval.
`PtyHostService`'s own comments record why.

## 8. What must be proven

The defect in PR #10 survived a green suite of 1770 tests because it lived in the
**gap between two halves that were each tested well**: the execution tests drove real
PTYs and real wall-clock silence but never touched a status value or the UI; all four
new `ChannelScreen` tests passed `needsAttention` as a **raw prop**, proving the strip
renders when told to but never that anything tells it to; and the seam module between
them shipped with no test at all.

So the acceptance bar is a **seam-crossing** test, not more tests on either side:

1. **The one that would have caught it.** A `work_session` whose id IS in a fresh
   liveness snapshot and whose activity is `quiet` must yield `needsAttentionOf ===
   true` **and** `statusOf === 'live'`. Both halves in one assertion — the bug was
   that they were mutually exclusive.
2. A quiet session **retains** `attachable: true` and its live-set membership.
3. Message delivery to a quiet session still succeeds (guards accept it).
4. `activity = blocked` refuses auto-injection; the suppressed delivery is **not**
   stamped delivered.
5. Real-PTY timing tests retained from PR #10 — that half was right. **Fake timers are
   not acceptable here**: a fix in this exact area once passed 40/40 under fake timers
   while submitting 0/4 against a real agent.
6. Fixture and real seam agree. The fixture carries its own copy of the liveness rule
   (`seam-fixture.ts:1619`); any change to one must move the other or they diverge
   silently.

## 9. Alternatives considered

- **Widen `statusOf` to accept `'idle'`.** Safe, one line, and insufficient — §3.1. It
  leaves the two questions sharing a column and re-opens on the next activity value.
- **A bespoke socket for activity.** Rejected for PR #10's reason, which is correct:
  writing to the graph makes this an ordinary entity change, inheriting `seq`
  ordering, client-side drop-if-not-newer, cursor replay on reconnect, and a liveness
  re-read on arrival. A side-channel would have to re-earn all four.
- **Infer activity from `activityAt` recency in the UI.** Forbidden by D6 of the UI
  charter, and rightly — it is a derivation dressed as a fact.
- **Parse the PTY screen for dialogs generically.** Rejected. AO only does this
  per-adapter with specific markers, and even then only as reconciliation. A generic
  screen-parser guessing at dialogs is the "detector that guesses" failure mode.

## 10. Open questions

1. Does `activity` belong on `work_sessions` or in a small append-only activity table?
   A table gives history (useful for deriving the thresholds in D9) at the cost of a
   join on every read. **Recommendation: column now, table later if D9 needs the data.**
2. Should `status='idle'` be removed from the vocabulary once nothing writes it? It is
   a loaded gun sitting in the schema — legal, unwritten, and fatal to the first
   writer. Removing it needs a migration and a contract change.
3. Event volume: every activity transition is an `entity.upsert`, and
   `liveness.noteEvent` nudges a liveness re-read on every `work_session` upsert. With
   a 45s threshold this is bounded, but it should be measured rather than assumed.

## 11. Credit

PR #10's detection half, its choice of the graph over a side-channel, and above all its
honesty discipline — reporting what was measured and refusing to invent a question, at
every layer — are kept intact here. The change is where the answer is *stored*.
