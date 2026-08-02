# Design — Real-time agreement between the Terminal and the Chat surface (tm8)

**Task:** `019fbf6d-e126-7f5f-9e69-df7375a93636` — *Sync Terminal and Chat UI real time*
**Status:** draft, for review. No implementation may start before sign-off (task rule).
**Scope:** tm8 only — `/home/tm8/prod-workspace/tm8`, per Space-owner directive
`019fc1f9-bcc5-7e6e-a65c-09ecfd81c9ff`.

**Tree read for this document:** branch `spawn/sandbox-probe-and-skills`, tip
`91cee8b58209f83eef3514105dffeb4d66f12e9c` (2026-08-02 13:40 +0000, *"feat(execution): probe the
sandbox, tell the truth about it, and resolve skills"*). Three files were dirty in
`packages/execution/src/spawn/` from another session; nothing in this document depends on their
uncommitted state.

**Revision 2 — citation audit (2026-08-02).** Every file:line claim in this document was re-read
against the tree. All of §1.2 (`'idle'` has no writer), §1.5, §1.6, §1.7, §1.8 and §2 verified
exactly as written. Three claims were wrong and are corrected in place: §1.1's "no JSONL tail
anywhere" (there is one; it feeds the *debug* surface, not chat), §1.1's description of `via`, and
**§3.3's list of what lights up for free** — the material one, which had over-counted by three
surfaces and contradicted §5.3. §3.3 is now a table with the corrections stated. No conclusion of
this design changed; Phase 1's client-side scope grew by one prop wire at two hosts.

**Concurrent implementation notice.** As of this revision, `packages/execution/src/pty/types.ts` and
`PtyHostService.ts` carry **uncommitted** work implementing §3's block detector (`onActivityChange`,
`idleAfterMs`, `everSpoke`, byte-driven busy transition) from another session. It matches this design
closely, including the §3.4 honesty mitigations. It predates sign-off; see §8 — that is the review
item, not a defect in the code.

**Supersedes:** design doc `019fbf7c-0380-7815-a74a-8f8fde498eb2`, which was written against
`/opt/maestro/agent-maestro` and is VOID. It is cited below only where a *safety argument* it made
is re-derived from tm8 evidence. No Maestro file path, package name or PR number appears in this
design, and none of its conclusions are inherited.

---

## 0. The headline, before the detail

**The problem statement this task was groomed with does not describe tm8.**

The task says chat "is rendered by streaming the session's JSON logs", lags the terminal by a poll
interval, and reads as a log dump. In tm8, **none of that is true**. There is no log tail, no
digest poll, no truncation constant. `SessionChatSurface` reads the same durable message/activity
feed every other surface reads, refreshed on the event stream with a 300 ms debounce.

The real tm8 defect is the **opposite shape**, and it is worse:

> The chat surface is not *behind* the terminal. It is **blind to most of what the terminal knows**,
> and the gap is unbounded in time, not measured in milliseconds. Chat shows only what an agent
> chose to durably post. Everything else — its reasoning, its tool calls, its final answer, and
> critically *the fact that it is stuck waiting for you* — exists only as pixels in a PTY.

So this is not a latency fix. Latency is already fine. It is a **coverage and interactivity** fix,
and the single highest-value increment is the one the codebase has already designed and deliberately
left unbuilt: a detector for *"this session needs you"*.

---

## 1. What is actually true in tm8 today

Every claim below was read from the tree at the tip named above. Paths are repo-relative.

### 1.1 The chat surface is a durable feed, not a log renderer

| Fact | Evidence |
|---|---|
| Chat reads the graph feed, scope `session_chat_v1` | `packages/tm8-ui/src/channel-screen/SessionChatSurface.tsx:74-84` |
| Feed refresh is **event-driven**, 300 ms debounce / 1.5 s max wait | `channel-screen/chat-store.ts:358-359`, `:369-377` |
| Refresh triggers: any event touching the session, WS reconnect, space resync | `chat-store.ts:379-399` |
| Items are messages **and** typed activity, carrying server-owned `via` provenance predicates that drive the direction label (`authored`/`subject`/`anchored`/`caused`) | `channel-screen/feed-model.ts:62-71` |
| Tool-noise collapsing already exists — by `logicalOperationId`, never by timestamp, never over a message | `feed-model.ts:291-319` |

**Nothing feeds chat from a log.** There *is* a per-session JSONL journal —
`<dataDir>/journals/<sessionId>.jsonl` (`packages/execution/src/spawn/SpawnService.ts:273`), served
to the browser by `packages/server/src/facade/execution-handlers.ts:1036`, `:1164` — but it is the
**debug** surface's source (`packages/tm8-ui/src/views/debugSurface.tsx`), and that surface is the
one §1.8 shows unmounting precisely so its poll stops. It never reaches the chat feed: nothing under
`channel-screen/` reads it. There is no digest service and no `maxLength` truncation of assistant
prose. **Test case 6 ("collapse tool-call logs, surface the final summary")
is close to vacuous in tm8**: there are no tool-call logs in the feed to collapse, because tool calls
never enter the feed. The grooming inherited that test from a codebase where chat rendered a log.

### 1.2 `needs-you` is built end-to-end — except for the one thing that would fire it

This is the most important finding in the document.

| Layer | State | Evidence |
|---|---|---|
| Presentation verdict `'needs-you'`, outranking `streaming` | **exists** | `packages/tm8-ui/src/terminal/session-presentation.ts:32`, `:65` |
| Pill style (word + tone + pulse) | **exists** | `session-presentation.ts:102` |
| Full-width interrupt banner with `detail` slot | **exists** | `packages/tm8-ui/src/terminal/NeedsYouBanner.tsx` |
| Home-screen "needs you" group | **exists** | `packages/tm8-ui/src/home/home-model.ts:291-334` |
| Registry predicate `live && status === 'idle'` | **exists** | `packages/tm8-ui/src/domain/registry.ts:231-232` |
| `'idle'` in the `WorkSessionStatus` union | **exists** | `packages/contract/src/contract.ts:1305` |
| **Anything that ever writes `'idle'`** | **does not exist** | single writer is `SpawnService`, which writes only `'running'` (`packages/execution/src/spawn/SpawnService.ts:572`, `:865`) and `'exited'`/`'failed'` (`:1076`) |

The tree says so itself, twice, in its own voice:

> *"'NEEDS YOU' grouping — designed-but-dormant per R8. The predicate is real and the group renders
> whenever it fires; no server detection exists in this program, so on real data it stays quiet."*
> — `registry.ts:226-230`

> *"DORMANT BY RULING (R8) … Building the state now is deliberate … and it means the day detection
> lands, no design work is owed."* — `NeedsYouBanner.tsx:10-14`

**The day detection lands, no design work is owed.** That sentence is the brief for this task.

### 1.3 tm8 currently assumes nobody is watching

The default permission posture is `auto`, and the reason is recorded verbatim:

> *"Every tm8 session is UNATTENDED — there is no human at the PTY to answer a prompt — and
> `acceptEdits` frees only file edits: a spawned agent still stopped dead at its first `Bash`
> approval."* — `packages/execution/src/spawn/manifest.ts:42-53`

The same reasoning drives the Codex mapping (`manifest.ts:561-568`: `on-request` is refused because
*"there is nobody at this PTY to answer"*). `'interactive'` is a real posture in the union
(`packages/execution/src/spawn/types.ts:34`) and maps to Claude's `default` and Codex's `untrusted`
(`manifest.ts:610-611`, `:569-571`) — it is reachable but, today, a trap: choosing it produces an
agent that will hang where no one can see it.

**This task's true purpose is to retire that assumption.** That is an architectural change, not a UI
change, and it is the thing review must actually sign off.

### 1.4 tm8 has no agent-hook integration at all

`grep -rl "PreToolUse\|PermissionRequest\|hooks.json\|settings.json" packages/*/src` returns
**nothing**. There is no hook config emitted by the spawn manifest and no dispatch endpoint. Any
design that routes structured interaction through Claude Code hooks is proposing **new
infrastructure**, not a change to existing wiring — and it is per-agent-tool: Codex has no
equivalent, so a hooks-only design leaves every `gpt-*` teammate exactly as blind as today.

### 1.5 The inbound answer channel exists, and it is closed-loop

`PtyHostService.deliverPrompt` (`packages/execution/src/pty/PtyHostService.ts:678`) is the governed
path from a posted message to bytes in the agent's composer. It gates on **output quiescence**,
verifies the submit, and reports a two-signal outcome of `'delivered' | 'unknown'`
(`:96`, `:325-326`). Its public entry point is `messages.post`; `execution.prompt` is server-internal
and explicitly refuses public callers
(`packages/server/src/facade/services/w2/execution.ts:89-90`). The eight delivery statuses are
already rendered as chat badges, with `unknown` deliberately typed as a warning rather than a success
(`feed-model.ts:105-157`).

**But it must not be reused to answer a permission dialog.** The service's own comments record why:
an earlier open-loop cut *"released mid-boot and submitted 0/4 — indistinguishable from no fix at
all"* (`PtyHostService.ts:138-141`), and the whole quiescence apparatus exists because a TUI
*"drains buffered input the instant"* it becomes ready (`:66`). A permission dialog opens with an
option pre-highlighted. A blind `\r` into it is a blind **approval**, and the delivery layer's
honest `'unknown'` outcome means we would not even know whether we had granted it.

> **Design law A.** Nothing in this feature may answer a permission dialog by writing bytes to a PTY.
> An answer is either structured and out-of-band, or the user is sent to the terminal.

### 1.6 Ordering and reconnect are already solved

The Maestro-era design proposed *adding* a monotonic sequence and drop-on-stale rule. tm8 has had
both from the start:

> *"if (event.seq <= lastApplied[spaceId]) drop; else advance and dispatch"*
> — `packages/tm8-ui/src/data/real/connection.ts:8`, implemented at `:240-241`

Every durable event carries a finite `seq` or is rejected as malformed
(`data/real/socket.ts:112-113`, `:148-149`); reconnect resumes with `resume(spaceId, since)` and
falls back to `events.poll(spaceId, since)` on the same spine (`connection.ts:290-293`, `:332-334`),
with the seq law providing dedupe so *"no consumer above it needs a `seenEventIds` set"* (`:11-12`).

**Test cases 3 and 5 therefore need regression tests against the existing spine, not new mechanism.**
Any new event type introduced by this design inherits the guarantee for free — provided it is a
durable, seq-carrying event and not a side-channel. That is a constraint on §4, and it is why §4
does not invent a socket.

### 1.7 Liveness is read-on-demand, by ruling

`statusOf` resolves `'not-running'` immediately when `workStatus !== 'running'`
(`data/real/liveness.ts:172`), and returns `'unknown'` rather than guessing when no snapshot is fresh
within 90 s (`:171-180`). Cadence is: space open · `work_session` upsert · WS reconnect · a 30 s
interval **while a session surface is visible** (`:17-20`, `:194-198`, `:204-213`). There is
deliberately **no liveness-change event (R3)**.

Consequence for test case 1: when a session exits, `SpawnService` writes `'exited'`, which is an
entity change, which is an `entity.upsert` event, which both flips `statusOf` to `'not-running'` on
the next render and nudges a re-read. **The "stuck finishing-up" case is already prompt in tm8.** The
30 s interval only governs transitions that are *not* backed by an entity write — which is precisely
the class this design is about to create, and therefore §3's detector must write to the graph rather
than rely on the interval.

### 1.8 The toggle already preserves everything

`packages/tm8-ui/src/panels/bodies/WorkSessionContent.tsx:205-241`: the terminal is mounted
unconditionally (`:214` — no `surface === 'terminal'` guard); chat is mounted on first selection and
then kept (`chatMounted`, `:226`); only the debug surface unmounts, and its comment says that is
deliberate so its poll stops (`:238-240`). Switching surfaces toggles `aria-hidden`/`data-active`
only.

**Test case 4's scrollback half is structurally satisfied today.** What remains to prove is the
pending-prompt half, which does not exist yet.

---

## 2. The state model

The root confusion this design removes: **"session state" is three facts with three authorities and
three latencies.** tm8 already separates two of them cleanly and is missing the third.

| # | Fact | Authority | Latency | Today |
|---|---|---|---|---|
| 1 | **Is the PTY alive?** | seam liveness predicate over a node snapshot | ≤ 90 s freshness, re-read on entity change | `data/real/liveness.ts` — correct, unchanged |
| 2 | **Are bytes moving?** | PTY byte activity, 2 s decay | sub-second | `terminal/activity.ts:80-88` — correct, unchanged |
| 3 | **Is it blocked on a human, and on what?** | *nobody* | *n/a* | **missing** |

`presentSession` already composes 1 and 2 under a strict gate — activity may only *refine* a `live`
verdict into `streaming`, never promote a non-live one (`session-presentation.ts:12-18`). Fact 3 is
already wired into that same function as `needsAttention`, outranking `streaming` because *"an agent
waiting on you is the more actionable fact than an agent producing output"* (`:64-66`).

**This design adds fact 3 and changes nothing about facts 1 and 2.** The composition rule is already
written and already tested; we are filling a declared hole, not re-cutting the model.

### 2.1 The two-level shape of fact 3

Fact 3 splits into a **signal** and a **request**, and conflating them is the mistake to avoid:

- **Signal — "this session is blocked."** Tool-agnostic, derivable from PTY behaviour alone, cheap,
  and *always honest*. Carrier: the existing `WorkSessionStatus = 'idle'`.
- **Request — "…on this specific question, with these options, answerable by id."** Structured,
  agent-tool-specific, requires new plumbing on both the outbound and inbound legs.

They ship in that order, and the signal is useful **without** the request: a user who sees "⚠ needs
you" and clicks through to the terminal is strictly better off than a user staring at a chat pane
that says nothing. That is the whole of Phase 1 (§6).

> **Design law B.** The signal may never be inferred from the absence of the request. A session with
> a detected block and no structured question renders "needs you — answer in the terminal", never a
> fabricated prompt, and never silence.

---

## 3. Fact 3, part one: the block detector (Phase 1)

### 3.1 Where the evidence comes from

Three candidate sources, ranked, with the rejection reasons stated:

**(a) Agent hooks** (`Notification`, `Stop`, `PreToolUse`). Precise and structured. **Not chosen for
Phase 1**: it does not exist in tm8 (§1.4), it is per-agent-tool so every Codex teammate stays blind,
and it makes the cheap half of the feature wait on the expensive half.

**(b) PTY output quiescence.** Tool-agnostic, works for every agent tool including ones not yet
integrated, and **the machinery already exists** — `PtyHostService` computes quiescence today to gate
delivery, with constants derived from measurement against real agents rather than guessed
(`PtyHostService.ts:131-141`, `:162-168`). **Chosen.** It answers "blocked" without claiming to know
"on what", which is exactly what Design law B requires.

**(c) Scraping the TUI screen for dialog shapes.** **Rejected.** It is the "better log parser" trap
the task's own risk register names, it breaks on every upstream CLI redraw, and it would manufacture
a *request* out of pixels — the precise fabrication law B forbids.

### 3.2 The transition

Extend the execution block's transition function — which the contract already names as the single
writer (`contract.ts:1304`) — with two new edges:

```
running --[ quiescent for Q, session has an unanswered turn ]--> idle
idle    --[ any live output byte, or an accepted delivery    ]--> running
```

- `'idle'` is written to the graph, so it is an entity change, so it is an `entity.upsert` event on
  the existing seq spine (§1.6) — pushed, ordered, dedeuplicated, replayed on reconnect, and it
  nudges a liveness re-read (`liveness.ts:194-198`) **for free**. This is why the detector must write
  status rather than emit a side-channel: it inherits every guarantee §1.6 lists.
- `Q` is **not** a new constant to invent. It must be derived the way the delivery constants were —
  by measurement against a live spawned agent — and the existing quiescence detector is the thing to
  measure with. A first cut of ~2× the delivery gate's idle threshold is a starting hypothesis, not a
  decision.
- The reverse edge must be **byte-driven**, not timer-driven, so a session that resumes work leaves
  `idle` within one output frame.

### 3.3 What lights up — and what does not

`live && status === 'idle'` is already the registry predicate (`registry.ts:231-232`), but it is
reached by only *some* of the dormant UI. The split below was audited against the tree and it is
load-bearing for scoping Phase 1: **the status write alone is not sufficient.**

| Surface | Reached by | Fires on the `'idle'` write alone? |
|---|---|---|
| Home-screen "NEEDS YOU" group | `home-model.ts:271` → `registry.ts:358` → `sessionNeedsAttention` | **yes** |
| List-panel needs-attention group | `EntityListPanel.tsx:895` → the same predicate | **yes** |
| `needs-you` pill (`session-presentation.ts:65`, `:102`) | the `needsAttention` **input** to `presentSession` | **no** — see below |
| Interrupt banner (`NeedsYouBanner.tsx`) | `TerminalBody.tsx:150`, gated on the `needsAttention` **prop** | **no** — see below |
| Graph-relevance seeding (`graph/relevance.ts:191`, `:447`) | `entity.badges.attention` | **never** — different mechanism |

Two corrections this table forces:

1. **The pill and the banner are prop-fed, and no host fills the prop.** `EntityDetailPanel` accepts
   `needsAttention` (`:137`) and forwards it to `TerminalBody` (`:531`), but neither
   `views/WorkspaceView.tsx` nor `views/EntityView.tsx` passes it at their `EntityDetailPanel` call
   sites. (Both files *do* contain a local `needsAttention` — `WorkspaceView.tsx:177`,
   `EntityView.tsx:201` — but it is `summary?.badges.attention != null`, the argument to
   `openEntityAndResolve`, an unrelated attention-**request** concern.) So the §5.3 host wiring is
   **not a cosmetic addition — it is part of Phase 1's critical path.** Without it, Phase 1 ships a
   signal that appears on the home screen and in list groups and is invisible on the session surface
   the user is actually looking at.
2. **Graph-relevance seeding will not fire from `'idle'`, ever.** `relevance.ts:191` is
   `entity.badges.attention !== undefined` — the badge raised by an *attention request*
   (`entity-read.ts:1031`), which the work-session status field never sets. Citing it as a
   beneficiary of this change was an error. If graph relevance should treat a blocked session as a
   seed, that is a separate, deliberate change to `relevance.ts` and it is **not** in Phase 1's
   scope.

The honest headline is therefore narrower than "the dormant UI wakes up for free", and better:
*the status write is the whole of the server-side work, and one host prop wire is the whole of the
client-side work.* Both are small; only one of them was previously counted.

### 3.4 The one honesty risk, and its mitigation

A long-running non-interactive command (a slow build) is also quiescent. Reporting it as "needs you"
would be a false alarm of exactly the kind this codebase's vocabulary exists to prevent (`'unknown'`
is neutral, never live, never exited — `session-presentation.ts:41-45`).

Mitigation, in priority order:
1. Require an **unanswered turn** — the session must have received input it has not yet visibly
   completed — not merely silence.
2. Where a structured signal is available (Phase 2), it **confirms** the quiescence verdict; it never
   independently raises one.
3. The banner detail string stays honest when unconfirmed: *"waiting — no output for N s"*, not a
   fabricated question. `NeedsYouBanner` already takes `detail` as an optional slot precisely so an
   unconfirmed block can render without inventing content (`NeedsYouBanner.tsx:18-19`).

---

## 4. Fact 3, part two: the interaction request (Phase 2)

### 4.1 Shape

A durable, seq-carrying record anchored to the session, projected into the session feed as a typed
activity item:

```
InteractionRequest {
  id            — correlation id, the thing an answer names
  sessionId
  kind          — 'permission' | 'question'
  prompt        — the agent's own text, verbatim, never synthesised
  options[]     — { id, label, isDefault }   (empty ⇒ free-text)
  raisedAt
  state         — 'pending' | 'answered' | 'expired' | 'superseded'
  answer        — { optionId | text, answeredBy, answeredAt } | null
}
```

**It is durable and it goes on the existing event spine.** Not a bespoke socket. That is what buys
test cases 3 and 5 without new work: ordering, dedupe, `seq`-cursored reconnect replay and the
drop-if-stale rule are inherited from `connection.ts:240-241`, and a pending request is re-read in
full on resync via the feed's existing `onResync → loadNewest(true)` path (`chat-store.ts:390-392`)
— never delta'd, because a silently missed prompt is a silently blocked user.

Rendering: a new `ActivityPresentation` variant in `feed-model.ts:217-221` (the map is a total
`Record`, so a new kind is a compile error until it is drawn — `:96-104` documents that as the
intent). It must be excluded from `groupByOperation` collapsing: a pending question is never
noise, and rule 2 of that function's contract — *"Never a message. A message is a thing a person or
agent SAID"* (`feed-model.ts:281-284`) — extends to a thing an agent **asked**.

### 4.2 The outbound leg — getting the question out of the agent

Claude Code first, via a hooks config emitted by the spawn manifest and an authenticated dispatch
endpoint on the node. This is new infrastructure (§1.4); it is scoped to Phase 2 for that reason.
Codex follows only if and when an equivalent structured signal exists — until then Codex sessions get
Phase 1's honest signal and the terminal, which is Design law B working as intended.

**Performance constraint, carried over from the prior analysis because it re-derives from tm8's own
structure:** any per-tool-call gate is on the hot path of every tool call. It must be a synchronous
in-memory check that allocates nothing when the answer is "no prompt needed", and it must be
load-checked in `bypassPermissions` mode before merge — that posture is the one where the gate does
the most work for the least benefit.

### 4.3 The inbound leg — the answer

Per **Design law A**, the answer returns through the same structured channel it arrived on: the hook
call is what blocks, and its return value is the decision. It is *never* keystrokes.

This dissolves a race for free, and the reason is worth stating because it is what makes the design
safe rather than merely careful: **while the hook is blocked, the TUI dialog has not been drawn**, so
chat is unambiguously authoritative; once the request expires and control returns to the agent, the
terminal is. The two are never simultaneously live, so there is no split-brain to reconcile. A design
that mirrored an already-open dialog would have had to solve that, and could not have solved it
safely.

### 4.4 Expiry

An unanswered request expires (a bounded window, sign-off item §8.2). On expiry the hook returns no
decision, the agent falls back to its own TUI dialog — **today's exact behaviour, no regression** —
and chat replaces the answer controls with *"Answer in the terminal →"*, wired to the
`onSwitchToTerminal` callback the surface already threads through
(`SessionChatSurface.tsx:49`, `:212`).

---

## 5. Chat presentation

Test case 6 asks for tool-call noise to be collapsed and the final summary surfaced. §1.1 shows tm8's
feed has the opposite problem. The honest re-scope:

1. **Keep `groupByOperation` exactly as it is.** It already collapses only keyed activity runs, never
   messages, never groups of one, never by timestamp (`feed-model.ts:279-290`). It is the right rule
   and it is already tested.
2. **Draw the new interaction item prominently** (§4.1) and exclude it from collapsing.
3. **Make the block state visible in chat, not only in the terminal chrome.** Today `needsAttention`
   is threaded to `TerminalBody` (`EntityDetailPanel.tsx:531`) but there is no chat-side equivalent,
   so a user in the chat surface would not see Phase 1's signal at all. Required addition — and per
   §3.3, **neither** `views/WorkspaceView.tsx` nor `views/EntityView.tsx` passes `needsAttention` to
   `EntityDetailPanel` today, so the prop must be filled at *both* hosts, from
   `live && status === 'idle'` (not from `badges.attention`), before *either* surface can show it.
   This is on Phase 1's critical path, not a follow-up.
4. **Do not build a transcript mirror.** Piping PTY prose into the feed would mean parsing ANSI TUI
   output into messages — the §3.1(c) trap, in a new costume. If richer chat content is wanted, the
   correct lever is the agent narrating itself durably (`tm8 message send`), which is a prompt/harness
   question, not a UI one, and belongs to a different task.

---

## 6. Sequencing

| Phase | Content | Delivers | Depends on |
|---|---|---|---|
| **0** | Regression tests for TC3 and TC5 against the existing seq spine (§1.6) | proves two criteria already hold; catches any regression the later phases cause | nothing |
| **1** | The block detector: `running ⇄ idle` transition from quiescence (§3) + wire `needsAttention` through `WorkspaceView` → detail panel → **both** surfaces (§5.3) | "needs you" becomes real for **every** agent tool; TC1 tightened; the dormant UI wakes | Phase 0 |
| **2** | `InteractionRequest` entity, feed projection, hooks config + dispatch endpoint, answer path (§4) | TC2; chat becomes answerable for claude-code | Phase 1 |
| **3** | TC4 pending-prompt survival across the toggle; TC6 re-scoped per §5 | remaining criteria | Phase 2 |

Phase 1 is the whole value-per-unit-risk of this task. If review only approves one thing, approve
Phase 1.

**Conflict warning:** Phase 1 edits the execution transition function and Phase 2 edits the spawn
manifest — the same surfaces as task `019fbec1-bc7d-7845-81fa-42969537d5cf` (agent spawning).
Sequence them; do not run both at once.

---

## 7. Test-case mapping

| TC | Task's claim | tm8 reality | Work required |
|---|---|---|---|
| 1 | no stuck "finishing up" within 1 s | exit already writes `'exited'` → entity event → immediate (§1.7) | **verify**, then tighten via Phase 1 for the blocked-not-exited case |
| 2 | permission prompt reaches chat, answerable there | nothing exists | **Phase 2** — the real work |
| 3 | state never moves backward | `seq <= lastApplied ⇒ drop` already (`connection.ts:240-241`) | **regression test only** |
| 4 | toggle preserves state | scrollback structurally safe (§1.8); pending prompt N/A until Phase 2 | **Phase 3** |
| 5 | reconnect replay, no dupes/gaps | resume + poll on one seq spine, dedupe by law (`connection.ts:8-12`, `:290-293`) | **regression test only** |
| 6 | collapse tool logs, surface summary | premise does not hold — no tool logs in the tm8 feed | **re-scope per §5** |
| 7 | design doc precedes code | this document, in-repo at `docs/plans/`, plus a linked doc entity | **satisfied on merge** |

**Acceptance criterion 8** (the "what did the prior fix already solve vs what is still broken"
comparison) was written against a Maestro PR that has no tm8 equivalent, and the Groomer already
recorded it as unsatisfiable. §1 of this document is its tm8-scoped replacement: a
what-already-exists / what-is-missing comparison derived entirely from the tm8 tree. **Criterion 8
needs rewriting to point here**; that is a grooming action, not an implementation one. The two
human-authored criteria (`ac_1`, `ac_2`) are untouched.

---

## 8. What review must decide

These are decisions, not details. Each changes the shape of the build.

**8.1 — Retiring the unattended assumption.** `manifest.ts:42-53` states as a design fact that no
human is at the PTY, and the default posture is chosen *because of it*. This feature makes some
sessions attended. Does `'interactive'` become a first-class, selectable posture once chat can answer
— and does the default change? **Recommendation: no default change.** Unattended stays the default;
`'interactive'` becomes *safe to choose* rather than becoming the norm.

**8.2 — The expiry window (§4.4).** After it, an unanswered prompt becomes terminal-only. TC2 then
holds *within* the window, not unconditionally. Given Design law A this is the correct trade, but it
is a deliberate acceptance and should be signed off now rather than discovered later.

**8.3 — The 1 s bound in TC1 measures the *indicator*, not agent prose.** The indicator is
event-driven and sub-second. Chat *content* is bounded by the agent's willingness to post durably,
which no transport can fix (§5.4). Open question 3 is answered "yes, with that distinction" — and the
distinction must survive review, or the bound will be misread as a promise about prose.

**8.4 — Phase 1 shipping without Phase 2.** Confirm that "needs you — answer in the terminal" is an
acceptable intermediate state for Codex teammates, permanently if no Codex hook equivalent appears.
This design says yes; Design law B is that position written down.

---

## 9. Open questions

1. **`Q`, the quiescence threshold** (§3.2). Must be measured against a live spawned agent, not
   chosen. The existing delivery constants were derived that way and their comments record a fake-timer
   fix that passed 40/40 in tests and 0/4 in reality (`PtyHostService.ts:138-141`). **This bug class
   cannot be falsified by unit tests** — TC1 and TC2 must run against a real session.
2. **Does `idle` need a reason code?** The status is a single enum value; distinguishing "quiescent,
   unconfirmed" from "confirmed permission prompt" may want a sibling field so the banner detail is
   never guessed. Leaning yes; deferrable to Phase 2.
3. **Where does the doc live?** Answered: both — this file in-repo, mirrored to a `doc` entity linked
   to the task. TC7 accepts either; doing both costs nothing.
