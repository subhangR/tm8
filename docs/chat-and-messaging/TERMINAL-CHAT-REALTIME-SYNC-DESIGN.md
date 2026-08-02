# Design — Real-time agreement between the Terminal and the Chat surface (tm8)

**Task:** `019fbf6d-e126-7f5f-9e69-df7375a93636` — *Sync Terminal and Chat UI real time*
**Revision 5** (2026-08-05) — rewritten for clarity, and re-rated against measured agent behaviour.
**Scope:** tm8 only (`/home/tm8/prod-workspace/tm8`), per Space-owner directive `019fc1f9-bcc5-7e6e-a65c-09ecfd81c9ff`.
**Code citations:** stable files (execution, server, contract, migrations) carry `file:line`, verified
at `origin/main` @ `302778a`. **Volatile `tm8-ui` files are cited by symbol, not line** — that table
of line numbers has been re-derived three times in three days and drifted again within one day of the
last correction. Symbols do not drift; line numbers in the active tm8-ui lane always will.

---

## 0. Which document is this, and which are not

There have been three documents in play. This confusion is real and it is worth one table to end it.

| Document | Status | What to do with it |
|---|---|---|
| **`019fc3ad-96e9-7a03-9b0e-732501cdc678`** — *this one* | **AUTHORITATIVE.** Revision 5. | The only design for this task. Read this. |
| `019fbf7c-0380-7815-a74a-8f8fde498eb2` | **VOID.** Written against `/opt/maestro/agent-maestro`. | Do not read. No file path, package or PR number in it transfers to tm8. |
| `docs/chat-and-messaging/TERMINAL-CHAT-REALTIME-SYNC-DESIGN.md` | **Mirror of this entity.** Currently only on the PR #10 branch, not on `main`. | Kept byte-identical to this entity. It becomes real when PR #10 lands. |

Revisions 1–4 of this document accumulated an audit trail — citation-drift tables, "revision 3 said X,
revision 4 corrects it" — until the design itself was hard to find inside its own changelog. Revision 5
states the design. The history is compressed into Appendix A.

---

## 1. The problem, in one page

A tm8 session has two surfaces onto one run: the **terminal** (a live PTY) and the **chat** surface.
A non-developer is expected to live in chat. The task asks for three things:

1. **Agreement** — chat and terminal never disagree about what the session is doing.
2. **Interactivity** — a permission prompt or question reaches chat, and can be *answered* from chat.
3. **Readability** — chat reads as natural language, not as a log dump; tool noise collapsed, summary surfaced.

And one constraint that cuts across all three, stated by the Space owner and governing every choice
below (§4.2): **all of it must be provider-agnostic.** Not claude-code plus a codex special case —
one mechanism that holds for codex, gemini, kimi, open-source models and agent tools not yet added,
including **coordinator sessions where one agent spawns another** (§4.4).

**The single most important fact about this task**, and the one most likely to be got wrong:

> These three are not three sizes of the same job. (1) is a *status* problem and is mostly solved.
> (2) is a **missing-signal** problem — tm8 has no channel on which a permission prompt could travel,
> so no amount of work on the chat renderer can close it. (3) is a **missing-capture** problem — tm8
> never ingests the agent's output into chat at all, so there is no tool-call noise to collapse yet.

Anyone who treats (2) or (3) as UI work will produce something that cannot work.

---

## 2. What tm8 actually has today

Verified against `origin/main` @ `302778a`. This section is the ground truth the design rests on.

### 2.1 The session status spine — good, and reusable
- `work_session` status vocabulary is `spawning | running | idle | exited | failed`, established by
  migration `043_spawn_replay_and_status_events.sql` (accepts `idle` at `:92-108`; the guarded
  transition RPC writes it at `:111-130`, and permits `running → idle → running`).
- The **only** production TypeScript caller of that transition RPC is `SpawnService`
  (`:578`, `:876` → `running`; `:1102` → `exited`; `:897-918` → `failed`). Single-writer discipline holds.
  (SQL also writes status directly at insert and on resume — `043:65-70`, `062_session_resume.sql:112-129` —
  neither produces `idle`.)

### 2.2 Ordering and replay — already correct, do not rebuild
- The durable event connection keeps a per-space high-water cursor and **drops `seq <= lastApplied`**
  (`data/real/connection.ts → the seq high-water dispatch`).
- This already satisfies *"state never moves backward"* and *"reconnect replays without duplicates or
  gaps"*. Proven in `connection.test.ts` at `:161`, `:318`, `:116`, `:177`, `:271`, `:341`, `:384`.
- **Consequence:** two of the task's seven test cases were satisfied before this task started.

### 2.3 The toggle — already correct, do not rebuild
- Terminal stays mounted; chat mounts on first selection and stays mounted; only Debug unmounts
  (`panels/bodies/WorkSessionContent.tsx → the mount-preserving surface switch`). Inactive surfaces are
  `display:none`, not destroyed (`panels/panels.css → the inactive-surface rule`).
- **Consequence:** scrollback and pending state survive toggling for free.

### 2.4 The interactive gap — the actual hole
- The PTY control protocol carries **only** `exit`, `size`, `attached` (`packages/pty-protocol/src/index.ts:15-65`).
  Anything else the agent draws is undifferentiated bytes (`:67-125`).
- `DurableWorkspaceEvent` has variants for entity, edge, message, activity, notification, handoff,
  delivery, profile, presence, voice — and **no** permission, question, approval or prompt variant
  (`packages/contract/src/contract.ts:440-478`).
- The chat feed carries **only** message and activity items (`contract.ts:1850-1852`).
- The browser composer binds `messages.post` and attachments — **no approve/deny or answer operation**
  (`packages/server/src/profiles/browser-projection.ts:24-37, 67-83`).
- **There is no agent-hook integration anywhere.** No `PreToolUse`, `PostToolUse`, `Notification`,
  `UserPromptSubmit`, `SessionStart`, no `hooks.json` or `settings.json` emission. The only provider-config
  writer is workspace *trust* (`packages/execution/src/spawn/workspace-trust.ts:94-131`, `:139-191`),
  which deliberately preserves the user's own hooks. Re-confirmed by grep at `302778a`: zero hits.
- **Therefore:** a permission prompt is, today, pixels in a terminal. There is no object to render and
  nothing to answer. Closing this needs a *new signal*, not a better renderer.

### 2.5 The rendering gap
- tm8 does **not** capture agent output into chat at all. Chat shows tm8 messages and typed activity;
  the channel UI says so explicitly (`ChannelScreen.tsx → the native-output notice`), and Phase 1 capture is
  explicit-only (`packages/cli/src/harness/bootstrap-manifest.ts:80-96`).
- Existing collapsing groups consecutive *activity* rows by `logicalOperationId` and never folds
  messages (`feed-model.ts → the logicalOperationId grouping`). `FeedItem` has no tool-call or final-summary discriminator.
- **Therefore:** "collapse the tool calls, surface the summary" has no subject yet. Capture is a
  prerequisite, and capture is a policy decision (see §7.3), not a rendering tweak.

---

## 3. Measured behaviour of real agents (new in revision 5)

The task's own constraint said this bug class is timing, not logic, and must be exercised against a
real spawned session. That had not been done. It has now. Six runs, real `claude` on a real PTY on
this host, timestamping every output chunk.

| # | Agent | Scenario | Longest silence | What a 10 s threshold does |
|---|---|---|---|---|
| 1 | claude | Idle at its own prompt | **39.4 s** (6 chunks total) | fires — **correct** |
| 2 | claude | Prompt typed, never submitted | **98.6 s** | fires — **correct** (it is genuinely waiting) |
| 3 | claude | Mid-turn, waiting on a 40 s command | **33.0 s** | fires — **FALSE POSITIVE** |
| 4 | claude | Mid-turn, waiting on a 45 s command | **41.3 s** | fires — **FALSE POSITIVE** |
| 5 | claude | Actively working, spinner visible | continuous (172–179 chunks) | does not fire — **correct** |
| 6 | **codex** | Idle at its own prompt | **44.6 s** (4 chunks, 91 bytes) | fires — **correct** |

**Finding 1 — the core premise holds, and it holds for both shipped providers.** A waiting TUI emits
*nothing*. It does not animate a cursor or heartbeat a status line. Measured on `claude` (39.4 s) and
independently on `codex` (44.6 s, 91 bytes in 45 s). So silence really is detectable, and Phase 1's
detector really does fire on a genuinely stuck session, for both agent tools in `launch-models.ts`.
This was an assumption; it is now a measurement.

**Finding 2 — and this is the one that matters — the false positive is not a tuning problem.**
The agent is silent when it waits for **you**, and equally silent when it waits for a **subprocess**.
Two independent runs produced 33 s and 41 s of mid-turn silence while the session was working
perfectly well. **No value of `idleAfterMs` separates these**: raising it to 60 s delays every true
detection to 60 s and still mis-fires on any 90 s install or test run. Silence is simply not enough
information. This kills "just tune the threshold" as a fix, and it is why §5's Phase 1 is rated the
way it is below.

**Finding 3 — a cheap discriminator exists, and it works.** Sampling the PTY's process tree during
the silent windows separates the two states perfectly:

```
   t+29.7   silent 10.0s   descendants: ['bash', 'sleep']   <- working
   ...
   t+57.8   silent 38.2s   descendants: ['bash', 'sleep']   <- working
   t+76.2   silent 10.1s   descendants: -- none --          <- genuinely waiting
   ...
   t+128.5  silent 62.4s   descendants: -- none --          <- genuinely waiting
```

8 samples silent-with-descendant, 14 samples silent-with-none, clean separation, no overlap. tm8
already owns the pid; this needs no provider cooperation and no new protocol. See §6.1.

---

## 4. The design

### 4.1 State model — one predicate, one writer, one vocabulary

The authoritative session state stays where it already is: the `work_session` row, written only
through the guarded transition RPC, only by `SpawnService`. **No parallel liveness model is
introduced** — that was the Maestro design's approach and it is explicitly not inherited.

The displayed state is a function of three inputs the UI already has:

```
recorded status (graph, ordered by seq)  +  observed PTY liveness  +  attention signal
        -> presentation verdict (session-presentation.ts:47-81)
```

Ordering safety comes free from §2.2's cursor rule: a late snapshot with `seq <= lastApplied` is
dropped, so the state cannot move backward.

**The single shared predicate.** "Does this session need you?" is computed in exactly one module,
`packages/tm8-ui/src/domain/needs-attention.ts`, consumed by the entity list, the home groups, the
terminal surface and the chat surface. This is deliberate: the bug this task exists to fix is two
surfaces disagreeing, and two copies of the predicate would reproduce it in miniature.

### 4.2 Provider-agnosticism is a constraint, not a goal

**Governing rule: no session capability may depend on which agent tool is running.**

tm8's contract declares `claude-code | codex` today (`launch-models.ts`), but the product intent is
any agent CLI — gemini, kimi, open-source models, whatever is added next. A design that detects a
blocked session by parsing Claude's dialog, or by requiring a Claude hook, produces a platform where
half the fleet silently has no feature and nobody can tell which half. That failure is invisible: the
pill simply never appears, and an absent signal looks identical to a healthy session.

This forces a two-layer design.

**Layer 1 — the universal floor. OS-level signals, zero provider cooperation.**
These work for any process tm8 can spawn, including ones that do not exist yet, because they are
properties of the *process*, not the *protocol*:

| Signal | What it means | Status |
|---|---|---|
| PTY output silence | the agent has stopped drawing | **shipped** (Phase 1); measured on claude + codex |
| live descendant processes | the agent is running a tool, so it is working, not waiting | **validated** (§3 Finding 3), not built |
| process CPU ≈ 0 across the tree | not thinking, not computing | proposed |
| blocked reading the PTY | definitionally waiting for input | proposed |

Layer 1 can say *"this session is blocked and needs you."* It can **never** say *what* it is blocked
on. That limit is honest and must be stated in the copy, never guessed around.

**Layer 2 — the per-provider adapter. Optional, additive, never required.**
A provider that can emit a structured prompt event gets a richer experience: the actual question, the
actual options, an answer that flows back. This is a *capability*, declared per provider and degrading
cleanly to Layer 1 when absent:

```
interface AgentSignalSource {          // implemented per agent tool
  structuredPrompts: boolean;          // can it tell us WHAT it is blocked on?
  answerChannel: 'structured' | null;  // can we answer without typing at a TUI?
}
```

Known surfaces, none of them verified deeply enough to build on yet: Claude Code exposes a hook
lifecycle (confirmed on this host via `--include-hook-events` and settings-source filtering); Codex
has a `notify` program, which tm8's trust writer already takes care to preserve
(`workspace-trust.ts:156-191`). **Exact event names and payloads must be confirmed against the pinned
CLI versions before Phase 2 commits to them** — I did not verify them, and the Claude CLI ships as a
compiled binary that cannot be grepped.

**The rule that keeps this honest:** the UI renders what Layer 1 knows for *every* provider, and adds
Layer 2 detail only where a provider supplies it. A provider with no adapter is never worse off than
Phase 1 leaves it, and is never silently featureless.

### 4.3 Answering must never be byte injection

**Chat must not answer a prompt by writing bytes at a TUI dialog.** This is the safety spine of the
design and it is not negotiable. A TUI dialog opens with an option pre-highlighted; a blind `Enter`
is a blind *approval*, and the direction of that mistake is always toward granting permission the user
never gave. `PtyHostService`'s own comments already record this failure class.

**This is also why Layer 2 cannot be faked for providers that lack it.** The tempting shortcut —
"detect the dialog in the byte stream and send the keystroke" — is exactly the unsafe path, and it is
*more* dangerous for an unfamiliar provider, where tm8 has no idea which option is highlighted.
A provider without a structured answer channel gets "switch to the terminal to answer", and that is
the correct answer, not a stopgap.

So the interactive path is three parts:

1. **Capture** — a structured event: *"blocked, on this, with these options."* Layer 2 only.
2. **Carry** — a new `DurableWorkspaceEvent` variant plus a chat `FeedItem` variant, both with stable
   prompt identity, so a prompt has a lifecycle (`pending → answered → expired`) rather than being a
   transient render.
3. **Resolve** — a new bound operation (`prompts.answer`) on the browser projection, authorised like
   any other mutation, handing the answer back through the same claim/settle discipline
   `messages.post` already uses. **Not** a text injection.

### 4.4 Coordinator sessions: an agent that spawns another agent

A tm8 session may be a *coordinator* — a claude-code session that spawns a codex agent, or any
nesting of tools. This breaks a naive reading of every Layer 1 signal, and the design must state the
resolution rather than discover it in the field.

- **Output silence is not compositional.** A coordinator can sit silent while its child agent works
  and streams to a different PTY. Silence at the parent means nothing on its own.
- **The descendant signal resolves it, and does so recursively.** A coordinator with a live agent
  child is *working* — correctly, since something is progressing. The question "does this session
  need a human?" must therefore be evaluated at the **deepest live agent in the tree**: walk the
  process tree, and the session needs a human only when the innermost live agent is itself silent
  *and* childless.
- **Attribution matters for the UI.** When a nested agent is the one blocked, the chat surface must
  say *which* agent is waiting. A prompt attributed to the wrong actor is worse than no prompt,
  because the user answers a question they were never asked.
- **Consequence for Layer 2:** a coordinator's own hook adapter says nothing about its child's state.
  Structured signals must carry the emitting agent's identity and be correlated to the process that
  produced them, not to the session as a whole.

This is unbuilt and unmeasured. It is called out here because the descendant-walk in §6.1 is the
piece that makes it tractable, and building §6.1 without anticipating nesting would bake in a
single-level assumption that is expensive to remove later.

### 4.3 Chat rendering rules

Prerequisite: capture (§7.3). Once agent output is ingested:
- Tool calls collapse by default into one line per logical operation, reusing the existing
  `logicalOperationId` grouping (`feed-model.ts → the logicalOperationId grouping`) rather than inventing a second mechanism.
- The turn's final natural-language message is the prominent row.
- Collapsed detail stays expandable — never discarded. Chat is a *view*, and a view that destroys
  information is worse than the log dump it replaced.
- Permission prompts and questions render as first-class interactive rows, never as collapsed noise.

---

## 5. Phases and status

| Phase | What | Status |
|---|---|---|
| **0** | Ordering / replay / toggle | **Already satisfied** by existing code (§2.2, §2.3). No work done, none needed. |
| **1** | Blocked-session *signal*: write `idle`, show it in both surfaces | **Built.** PR #10, rebased, mergeable, awaiting review. **See the rating in §6.** |
| **2** | Structured interactive events: capture → carry → resolve | **Not started.** Blocked on §7.1 and §7.2 sign-off. |
| **3** | Capture + natural-language rendering | **Not started.** Blocked on §7.3. |

### 5.1 What Phase 1 actually shipped
`PtyHostService` gained `onActivityChange` + `idleAfterMs`; a live PTY that has produced output and
then falls silent reports `idle`, and the next byte reports `busy` (transitions only — a busy TUI
emits hundreds of chunks/sec and each notification ends in a DB write). `SpawnService.handlePtyActivity`
writes it through the same transition RPC and replayed spawn claims that `handlePtyExit` uses.

No migration was needed (043 already accepted `idle`). No new UI vocabulary was needed — the
`needs-you` treatment has been fully drawn since R8 and its predicate is
`live === 'live' && status === 'idle'` (`registry.ts → sessionNeedsAttention`); nothing had ever written that status,
so the whole chain was unreachable on real data. Phase 1 is the missing writer, plus the shared
predicate module, plus the chat-side strip and the `needsAttention` prop wire at both view hosts.

**Its honesty constraint, enforced in comments at every layer:** the detector knows *bytes stopped*.
It must never claim to know *why*. The copy states the measurement — "no terminal output for a while
— it may be waiting for you" — and never invents a question.

---

## 6. Confidence and gaps — the honest rating

**Confidence that Phase 1's code does what it says:** **high (~90%).** Typecheck clean; tm8-ui 1839
passed / 1 skipped across 119 files; execution 164 passed / 6 skipped; 5 detector tests against real
PTYs with real wall-clock silence (no fake timers — `PtyHostService.ts:138-141` records a fix in this
exact area passing 40/40 under fake timers and 0/4 against a real agent).

**Confidence that Phase 1 is a *good signal in the field*:** **low-to-moderate (~45%), downgraded in
this revision.** §3's Finding 2 is the reason: two of two real long-running turns produced a false
"may be waiting for you" lasting 23 s and 31 s. On a normal working session — any install, any test
run, any build — this pill will fire wrongly and often. Hedged copy limits the damage but does not
make the signal trustworthy, and a signal users learn to ignore is worse than none.

**Confidence that this task's *goal* is met:** **low (~30%).** Phase 1 is a blocked-session
*indicator*. The requester asked for a copilot-style chat that renders and answers prompts. That is
Phases 2–3, and neither is started.

### 6.1 Gap 1 — false "needs you" during legitimate work `[Phase 1, fixable now]`
**Measured**, twice (§3). **Fix, validated in §3 Finding 3:** require *both* silence past the
threshold **and** no live descendant of the PTY process before reporting `idle`. It uses a pid tm8
already holds, is ~40 lines in `PtyHostService`, and is testable by the same real-PTY harness already
in the branch. **Recommendation: do this before Phase 2**, because Phase 2 builds structured
confirmation on top of this signal and inherits its error rate.

**This is the "one mechanism for every provider" answer.** It is an OS-level property, so it works
identically for claude, codex, gemini, kimi, an open-source model, or an agent tool that does not
exist yet — no hook, no config, no per-provider parser, and nothing to keep in sync as providers
change. It is strictly better on that axis than the alternative of teaching tm8 each provider's
dialog format, which would need new work per provider and would silently rot as each one changes its
TUI. Per §4.4 the descendant walk should be **recursive from the start**, so coordinator sessions
(claude spawning codex) are handled by the same code rather than by a second mechanism.
*Residual:* an agent blocked on a *network* call with no child process still reads as waiting. Rarer,
and Phase 2's real signal is what closes it.

### 6.2 Gap 2 — `idleAfterMs = 10 s` is a hypothesis `[Phase 1]`
Never measured against a live agent; the delivery constants beside it were, and carry a warning
against tidying them. §3 now gives real numbers to derive it from. Not a merge blocker — its failure
mode is a mistimed pill, not a wrong action — but it should not stay a guess. **With the §6.1 fix in
place the threshold can safely drop**, because the expensive error it was hedging against is gone.

### 6.3 Gap 3 — permission prompts still cannot reach chat `[Phase 2, the headline ask]`
The task's test case 2. Not addressed at all. Needs §4.2's three parts and §7.1's sign-off. **This is
the gap between "we shipped something" and "we did what was asked."**

### 6.4 Gap 4 — no natural-language rendering `[Phase 3]`
The task's test case 6. tm8 does not capture agent output into chat, so there is nothing to collapse
and no summary to promote. Needs a capture policy (§7.3) before any renderer work.

### 6.5 Gap 5 — provider coverage `[partly closed in this revision]`
**Closed for the two providers tm8 ships.** Codex was measured and goes fully silent at idle
(44.6 s, 91 bytes in 45 s) — so Phase 1's signal is real for both `claude-code` and `codex`, not just
the one it was developed against.

**Still open for everything else**, and this is the structural risk §4.2 exists to manage. Any new
provider (gemini, kimi, an open-source model) is an untested assumption: if its TUI animates at idle
it never goes silent, the detector never fires, and the feature is **silently absent** for that
provider with no error anywhere. **Mitigations, in order of value:**
1. Make §6.1's descendant signal the primary discriminator rather than silence — it does not depend
   on TUI behaviour at all, so it degrades far more gracefully for an unmeasured provider.
2. Add the §3 silence probe to the repo as a **provider conformance check**, run once per provider
   before it is added to `launch-models.ts`. It is ~60 lines and it converts "we assume" into "we
   measured" for every future tool.
3. Have the UI distinguish *"this provider has no blocked-session detection"* from *"this session is
   fine"*. They currently render identically, which is the worst property this gap has.

### 6.8 Gap 8 — coordinator / nested-agent sessions are unhandled `[design stated, unbuilt]`
A session that spawns another agent (claude → codex) breaks the single-level reading of every Layer 1
signal: the parent can be silent while the child works, and a prompt from the child would be
attributed to the wrong actor. §4.4 states the resolution — evaluate at the deepest live agent, and
carry emitting-agent identity on structured signals. Unmeasured and unbuilt. The cost of ignoring it
is not a bug today but a single-level assumption baked into §6.1 that is expensive to remove later,
which is why §6.1 says build the walk recursively from the start.

### 6.6 Gap 6 — the permission-prompt silence case is still unmeasured
Runs 1–5 never reached a permission dialog (the sessions were permissioned such that none appeared).
So "a session blocked on a permission prompt goes silent" remains *inferred* from the idle case, not
measured. It is the exact case Phase 1 is named for. **Cheap to check** — one run with a restrictive
permission mode.

### 6.7 Acceptance-criteria coverage

| # | Test case | Status |
|---|---|---|
| 1 | No stuck "finishing up"; chat agrees within 1 s | **Partial.** tm8 has no "finishing up" (that was Maestro). Status agreement rests on §2.2; the 1 s bound is untested. |
| 2 | Permission prompt renders and is answerable in chat | **Not done** — Phase 2. |
| 3 | State never moves backward | **Satisfied** pre-existing (§2.2), proven in `connection.test.ts`. |
| 4 | Toggle preserves state and scrollback | **Satisfied** pre-existing (§2.3). Not re-tested manually. |
| 5 | Reconnect replay, no dupes or gaps | **Satisfied** pre-existing (§2.2). |
| 6 | Tool calls collapsed, summary prominent | **Not done** — Phase 3. |
| 7 | Design doc precedes first implementation commit | **Done** — this document ships in the same commit as PR #10. |
| 8 | *(original)* what PR #176 fixed vs still broken | **Void** — Maestro-scoped and unsatisfiable in tm8. §2 is its tm8 replacement: the ground truth, derived from source. |

**Net: 3 satisfied by pre-existing architecture, 1 done, 1 partial, 2 not started.**

---

## 7. Decisions that need a human

These are unsigned. Phase 1 was safe to ship without them because **it decides none of them** — it
adds an honest signal and answers nothing. **Phase 2 is not safe on that footing.**

**7.1 — Retire the "every tm8 session is UNATTENDED" assumption.** Still stated verbatim at
`packages/execution/src/spawn/manifest.ts:42-53`. Phase 2 makes chat answer a permission, which means
a session *is* attended, by a human who may not be a developer. This assumption is load-bearing for
spawn behaviour and cannot be quietly contradicted by a new feature. **Blocks Phase 2.**

**7.2 — The expiry window.** A pending prompt needs a lifetime. Too short and a user who steps away
loses work; too long and a stale prompt sits answerable after the session is gone. Needs a number and
a stated failure direction. **Blocks Phase 2.**

**7.3 — Capture policy.** Rendering agent output in chat means *storing* agent output. That is a
confidentiality decision (`fix(execution): make the session data root a real confidentiality boundary`
is already on `main`), not a UI one. What is captured, where it lives, who can read it. **Blocks Phase 3.**

**7.4 — Does chat expose every question, or only permission prompts?** The request says "just like a
copilot", which implies both. Assumed both; cheap to narrow, expensive to widen later.

---

## Appendix A — revision history (compressed)

- **R1** (2026-08-02) — first tm8-scoped design, written against local branch `spawn/sandbox-probe-and-skills` @ `91cee8b`.
- **R2** — citation audit. Three claims corrected; the material one was §3.3 over-counting what writing
  `idle` lights up, which grew Phase 1's scope by the `needsAttention` prop wire at both view hosts.
- **R3** (2026-08-04) — re-audit against `origin/main` @ `302778a` after 63 commits landed. **No claim
  falsified, no conclusion changed**; 17 citations had drifted and were corrected. Identified PR #10 as
  `CONFLICTING`.
- **R4** (2026-08-04) — the rebase R3 specified, executed. Both conflicts resolved with no semantic
  decision. The `EntityListPanel.tsx` conflict turned out smaller than predicted (git applied the
  `toRowFacts` deletion across `main`'s move by itself, leaving only two import lines). This document
  moved from the defunct `docs/plans/` to `docs/chat-and-messaging/` — git proposed the *history
  archive*, which was overridden.
- **R5** (2026-08-05) — **this revision.** Rewritten for clarity: the design is stated up front and the
  audit trail compressed to this appendix. Four substantive changes, not just presentation:
  - **§3 is new** — real `claude` and `codex` sessions measured on real PTYs, replacing the assumption
    that a blocked agent goes silent with a measurement that it does.
  - **§4.2/§4.4 rewritten around provider-agnosticism**, per the Space owner: a universal OS-level
    floor that needs no provider cooperation, plus an optional per-provider adapter that may never be
    required — and an explicit resolution for coordinator sessions where one agent spawns another.
  - **§6 is new** — an honest confidence rating. **Phase 1's field-confidence downgraded** on a
    measured, reproducible false-positive class, with a fix validated in §3 Finding 3.
  - **Citations for volatile tm8-ui files moved from line numbers to symbols**, because that table
    drifted again within a day of its last correction.
  - PR #10 scope reduced: `EntityListPanel.tsx` dropped (a refactor, not the feature, and the source
    of every conflict this PR has had).
