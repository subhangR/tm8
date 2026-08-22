# The activity signal: how tm8 learns an agent is working, idle, or stuck

**Status:** design proposal. No implementation authority. Nothing here is built.
**Date:** 2026-08-22
**Base commit:** `3edf470f` (`origin/main`, verified identical, 0 commits behind at time of writing)
**Prior art read at:** `github.com/Untrivial-ai/agent-orchestrator` @ `d4ae9b3` (verified: repo HEAD is exactly `d4ae9b318`)

**Siblings.** `AO-VS-TM8-COMPONENT-ANALYSIS.md` and `HARNESS-REGISTRY-DESIGN.md` are owned by another worker and are referenced, not restated. Where this document needs a field on the harness capability record, it names the field and its meaning and leaves the record's own shape to the registry design.

---

## 0. The one-paragraph version

tm8 should **not** port AO's activity model. It should keep AO's *state split* (which is load-bearing and hard-won), throw away AO's *evidence model* (one enum, no provenance), and replace it with a **three-tier signal with the tier attached to every reading**: `reported` (agent hooks), `derived` (the agent's own transcript, which tm8 already parses — AO does not), `guessed` (stream silence, what ships today). The tier is the product feature. A harness that cannot report activity says so on its capability record, and its sessions render the *measurement* ("no output for 4m") instead of a *verdict* ("idle"). tm8 already owns the honest UI state for this — it is spelled `unknown` and renders as **"unverified"** — so the vocabulary does not need a fifteenth word, it needs a route into the one that already exists.

The hook transport needs **no new network surface and no new token**. The hook is an ordinary `tm8` CLI invocation that inherits `TM8_AGENT_TOKEN` and `TM8_SESSION_ID` from the spawn environment, exactly as every other `tm8` command an agent runs already does.

---

## 1. What reproduced against the tree, and what did not

The brief asked for corrections where its claims do not hold. Four corrections, one of which changes the recommendation.

### 1.1 Verified exactly

| Claim | Verified |
|---|---|
| `hooksjson` 465 LOC | `backend/internal/adapters/agent/hooksjson/hooksjson.go` — **465** |
| `hookutil` 116 LOC | `backend/internal/adapters/agent/hookutil/hookutil.go` — **116** |
| `terminalui` 347 LOC | `backend/internal/adapters/agent/terminalui/composer.go` — **347** |
| five-value `activity_state` | `backend/internal/domain/activity.go` — `active`, `idle`, `waiting_input`, `blocked`, `exited` |
| fourteen display statuses | `packages/cloud-client/src/schema.ts:1118` — `working, needs_input, pr_open, draft, review_pending, ci_failed, changes_requested, approved, mergeable, merged, exited, idle, terminated, no_signal` = 14 |
| `no_signal` is an honest state, not a fallback | `backend/internal/service/session/status.go`: *"past it, a silent session is indistinguishable from one with a broken hook pipeline, and the dashboard must not claim a confident 'idle'"* — gated by `noSignalGrace = 90 * time.Second` |
| tm8 declares idle on stream silence | `PtyHostService.ts:96` — `const DEFAULT_IDLE_AFTER_MS = 10_000` |
| the empirical gate comments exist and warn against tidying | `PtyHostService.ts:158-163` — *"submitted 3/3 on claude-code and 2/2 on codex. Do not 'tidy' these numbers without re-running that test."* |

### 1.2 Correction 1 — tm8 has a *third* mechanism the brief does not mention, and it is the good one

The brief says tm8 has neither of AO's two mechanisms. True for hooks and TUI parsing. But tm8 has something AO explicitly rejected:

> `packages/execution/src/transcript/read-transcript.ts` — 937 LOC, transplanted from maestro's `LogDigestService`. It reads the agent's **own** JSONL transcript, in both the claude-code and codex dialects, with a byte-offset paging cursor, dialect sniffing, noise filtering, per-turn prose extraction, tool-call counting, provider token usage, file-change attribution — **and a stuck heuristic**.

AO's `domain/activity.go` says, in its first sentence:

> *"ActivityState is how busy the agent is, reported via the agent's CLI hook callbacks, **not inferred from transcript/JSONL**"*

AO made a deliberate choice not to use transcripts. tm8 has already built the thing AO declined to build. That is why §6 refuses TUI interpretation rather than merely deferring it: tm8's hookless fallback is not "guess from the screen", it is "read what the agent wrote".

### 1.3 Correction 2 — the empirical constants govern a *different loop* than the brief implies

The brief presents `3/3 on claude-code, 2/2 on codex` as the tuning behind idle detection, and therefore as the thing this design risks regressing. It is not.

Those constants (`PROMPT_IDLE_MS`, `PROMPT_COLD_IDLE_MS`, `PROMPT_COLD_READY_TIMEOUT_MS`, `PROMPT_WARM_READY_TIMEOUT_MS`, `PROMPT_PRE_SUBMIT_MIN_MS`, `PROMPT_SUBMIT_ATTEMPTS`, `PROMPT_SUBMIT_BACKOFF_MS`) drive the **prompt-injection closed loop** — gate on quiescence, write the body, pause, press Enter, verify the text left the cursor, retry Enter. That is a *write* path.

Idle detection is `DEFAULT_IDLE_AFTER_MS = 10_000`, a *read* path, and its own docstring disowns it:

> *"It is a DEFAULT, not a measurement. The delivery constants above were derived by running against real agents and carry a warning against tidying them; this one has not had that treatment yet and should get it before it is treated as settled."*

The two loops share exactly one piece of state: `entry.lastOutputAt`, which the activity timer reads and never writes. **This lowers the migration risk substantially** and it changes what the regression oracle is (§7). It also means `DEFAULT_IDLE_AFTER_MS` is the one constant here that *may* move — it is the only one whose own comment asks for it.

### 1.4 Correction 3 — `idle` already reaches the graph in production

The brief reads as though tm8's idle signal might be inert. It is wired end to end:

- `execution-handlers.ts:1298` wires `onActivityChange` → `spawnService.handlePtyActivity`
- `SpawnService.ts:2112` `handlePtyActivity` calls `graph.transition({ status: activity === 'idle' ? 'idle' : 'running' })`
- `WorkSessionStatus = 'spawning' | 'running' | 'idle' | 'exited' | 'failed'` (`contract.ts:2912`), and migration 043 accepts `running ↔ idle`

So `work_sessions.status = 'idle'` is being written today, from stream silence, for every harness. This is not a gap to fill — it is a **live claim to qualify**. The honesty defect is shipped, not pending. That reorders the migration: Phase 0 is not "add a signal", it is "stop the existing signal from over-claiming".

The source already knows this. `SpawnService.ts:2100`:

> *"HONESTY BOUND. `'idle'` here means 'this PTY has been silent for the host's quiescence threshold', nothing more. It is NOT proof an agent is waiting on a human — a silent `npm install` produces the same evidence — so no caller may render it as a specific question."*

and `pty/types.ts:141`:

> *"Consumers must render what was measured — 'no output for Ns' — and must never upgrade it into a fabricated question."*

Both correct. Neither enforceable, because the wire carries `status: 'idle'` and nothing else. **The provenance is in the comments and not in the data.** That is the whole bug, stated in one line.

### 1.5 Correction 4 — tm8 already has `no_signal`; it is called `unverified`

`packages/tm8-ui/src/terminal/session-presentation.ts` already ships an eight-value presentation vocabulary with the exact state AO calls `no_signal`:

```ts
| 'unknown'   // NO FRESH SNAPSHOT. We do not know. Renders neutral — never live,
              // never exited — because claiming either would be inventing a measurement.
```

with the right styling already authored: `word: 'unverified'`, `dot: 'hollow'`, `pulse: false`, `isLive: false`, and the comment *"Deliberately not 'running' and not 'exited'. The pill states the record's claim and immediately withdraws the guarantee."*

The vocabulary is not the gap. The **routing** is: `presentSession` reaches `unknown` only when the *liveness snapshot* is missing. A session that is provably live but whose activity is unknowable cannot reach it, because the function's only inputs are `liveness`, `recordedStatus`, `streaming`, `needsAttention` — and `needsAttention` is a bare boolean with no provenance.

---

## 2. The two incidents, mechanically

The session that reported this task named two real failures. Both reproduce from the source, and they are different bugs.

### 2.1 "Sat at `running` for 46 minutes, wrote nothing, made 4 tool calls"

An agent producing tool-call output keeps `lastOutputAt` fresh, so `markBusy` reschedules the idle timer on every chunk (`PtyHostService.ts:1521-1544`) and the session never crosses `DEFAULT_IDLE_AFTER_MS`. It stays `running`. Correct by the rule, useless as a signal — output is not progress.

tm8 already has the detector for exactly this and it is not wired to anything:

```ts
// read-transcript.ts:61-62
const STUCK_TOOL_CALL_THRESHOLD = 5;
const STUCK_SILENCE_MS = 30_000;
```

`detectStuck` scans backwards counting tool calls since the last assistant *prose*, and measures silence against `now` rather than against the newest record — its docstring says why: *"a worker that has stopped writing entirely is still detected — that is the case the heuristic exists for, and comparing two record timestamps would score it zero."* It surfaces on `execution.transcript` as `stuck: SessionTranscriptStuck | null`.

At 4 tool calls the threshold (`> 5`) would not have fired. That is a threshold to re-derive, not a broken design. **The gap is that `stuck` reaches exactly one read that nothing polls, and never reaches liveness, status, or any list surface.**

### 2.2 "Died in 2 seconds and showed as a normal exit"

Two independent causes.

**The survival gate is 150ms.** `SpawnService.ts:302` — `this.bootSettlementMs = options.bootSettlementMs ?? 150`. `waitForBootSettlement` watches for an exit inside that window; past it, the session transitions to `running` and nothing watches again. A death at t=2s is post-gate by a factor of thirteen.

**Exit classification is binary and clean-exit-blind.** `PtyHostService.ts:544`:

```ts
const status: PtySessionStatus =
  exitCode === 0 && normalisedSignal === null ? 'completed' : 'failed';
```

An agent that starts, fails to authenticate, prints a message and exits 0 is recorded `completed`. `PtySessionStatus` carries no duration, and the work session row carries no "how long did it run". So a 2-second clean death and a 40-minute finished job are the same three fields.

Note the asymmetry with §2.1: that one is a *missing signal*; this one is a **present signal that is under-described**. The fix for it is not a new detector — the exit evidence is already captured faithfully (`PtyExitInfo` exists precisely because an earlier version discarded `signal` and collapsed `exitCode`; see its docstring). The fix is to carry *elapsed time* alongside it and let the surface say "exited after 2s".

---

## 3. Decision 1 — the state vocabulary

**Recommendation: do not extend `WorkSessionStatus`. Add a separate activity record whose every reading carries its own provenance.**

### 3.1 Why not copy AO's five values

AO's enum mixes two kinds of fact. `active`, `idle`, `waiting_input`, `blocked` describe a *running* agent; `exited` describes a *lifecycle*. tm8 has already separated these deliberately, and the separation is documented as an invariant in `pty/types.ts:25-31`:

> *"Whether a LIVE PTY is currently producing output. Both values describe a running process — this is orthogonal to `PtySessionStatus`, which only ever describes one that ended. An exited PTY has no activity at all and reports neither."*

Copying `exited` into an activity enum would re-merge what tm8 split, and would immediately create a two-writer problem: the exit path (`onSessionStatus`, single-writer per R29) and the activity path (`onActivityChange`) would both be able to write "exited". `handlePtyActivity` already guards against precisely this race (`if (!this.pty.hasSession(sessionId)) return;` — *"A PTY that has already gone means any status this would write is stale"*). Don't reintroduce it as a type.

### 3.2 What to keep from AO

AO's **`waiting_input` / `blocked` split is right and tm8 needs it more than AO does.** AO's own comment:

> *"waiting_input is an agent at an empty prompt awaiting its next INSTRUCTION (safe to message or nudge), while blocked is an agent stopped on a pending DECISION — a tool-permission or approval dialog — where a stray keystroke could answer the dialog on the user's behalf. **Automated senders must never inject input into a blocked session.**"*

tm8 has an automated sender. `PtyHostService.deliverPrompt` writes into the composer and presses Enter with a bounded retry loop, driven from `w2-message-delivery.ts`, unattended. If tm8 ever gains an activity signal without this split, the first thing it will do is auto-answer a permission dialog with the body of a graph message. **The split is a safety property, not a UI nicety.**

AO's `IsSticky` is also right: a paused agent stays paused until a *new signal* says otherwise, never until a *timer* says otherwise. Time-demotion of a `blocked` reading is how you get a green dot on a session that is still holding a modal open.

### 3.3 The proposal

```ts
/** How busy a LIVE agent is. Orthogonal to WorkSessionStatus, like PtyActivity. */
export type SessionActivityState =
  /** Producing turns. */
  | 'working'
  /** At an empty composer, awaiting the next instruction. Safe to send to. */
  | 'awaiting_input'
  /** Stopped on a pending permission/approval decision. NEVER auto-send. */
  | 'awaiting_decision'
  /** Measured absence of activity. NOT a claim about why. */
  | 'quiet';

/** How the reading was earned. Travels with EVERY reading, no default. */
export type ActivityConfidence =
  /** The agent said so, through a hook. */
  | 'reported'
  /** Parsed from the agent's own transcript. */
  | 'derived'
  /** Inferred from PTY stream silence. Says nothing about the agent. */
  | 'guessed';

export interface SessionActivity {
  state: SessionActivityState;
  confidence: ActivityConfidence;
  source: 'hook' | 'transcript' | 'stream-silence';
  /** When the evidence was produced, not when it was read. */
  observedAt: string;
  /** Must not be aged or demoted by time — AO's IsSticky. */
  sticky: boolean;
  /** Short human line for the chat UI. Null when nothing honest can be said. */
  detail: string | null;
}
```

Four states, not five. Renames that matter:

- **`idle` → `quiet`.** Deliberate. AO's `idle` is *reported* (a `Stop` hook fired: the agent finished its turn). tm8's `idle` today is *measured silence*. Using one word for two different evidences is precisely the lie this document exists to end, and `idle` is already burned into `WorkSessionStatus`, so reusing it in the activity vocabulary guarantees the two get conflated in review within a month.
- **`active` → `working`.** Matches AO's own *display* status word (`working`), and avoids collision with the existing `PtyActivity = 'busy' | 'idle'`, which stays exactly as it is — it is the PTY host's private byte-level signal and should not learn about agents.

### 3.4 The invariant that makes it honest

> **A `state` may only be as strong as its `confidence` permits.**
>
> `awaiting_input` and `awaiting_decision` are reachable **only** at `confidence: 'reported'`. No transcript parse and no silence timer may ever produce them.
> `working` is reachable at `reported` and `derived`.
> `quiet` is the only state `guessed` may produce, and it is *not* a synonym for idle — it means "we measured silence and know nothing else".

This is `pty/types.ts`'s "never upgrade it into a fabricated question", moved out of a comment and into the type. A `guessed` reading structurally cannot say "needs you".

### 3.5 The durable projection stays byte-identical

`work_sessions.status` keeps its five values and its existing writer. The projection is:

```
activity.state === 'working' ? 'running' : 'idle'
```

which is exactly what `handlePtyActivity` writes today. Nothing downstream of the graph changes shape, migration 043 is untouched, and the R20 debounce ruling (*"idle-flapping should be debounced at the execution block before it touches the graph"*) continues to apply at the same place.

The **rich** record does not go in the graph. It rides `execution.liveness` (a read) and the durable event that a status transition already emits (an announce). That is T-L10 as written — *"Session state lives in the graph; session output lives on the socket"* — and it is why this design adds no new socket and no new table.

---

## 4. Decision 2 — the hook transport

**Recommendation: no new HTTP endpoint, no new token, no new authn/authz surface. The hook is a `tm8` CLI invocation.**

### 4.1 Reasoning from the `grant-token` precedent

The brief is right that PTY attach is the precedent. The lesson it teaches, though, is the opposite of "copy this apparatus":

`grant-token.ts` mints a `tm8g_` bearer; `attach-authz.ts` (105 lines) consumes it single-use inside `public.consume_stream_attach`, binds a browser cookie identity when present, and collapses *"invalid, expired, replayed, wrong-session, wrong-mode and wrong-identity"* into one 403; `audit-logger.ts` restricts logging to a six-key allowlist (`sessionId, mode, status, reason, gap, offset`) so no token, hash, header or URL can reach a log line.

All of that exists for one reason: **the browser has no other credential.** It cannot present the server's own auth pass to a raw WebSocket, so a capability had to be minted, delivered, consumed and audited.

A hook process has none of that problem. It is a **child of the PTY**, spawned by the agent, inside the environment `composeEnv` built. That environment already carries (`manifest.ts:984-996`):

```ts
TM8_SESSION_ID: manifest.sessionId,
TM8_BASE_URL: baseUrl,
TM8_SPACE_ID, TM8_TEAM_MEMBER_ID, TM8_ACTOR_ID, TM8_AGENT_TOOL, ...
// and, when SpawnService minted one:
TM8_AGENT_TOKEN: agentToken,   // `tm8s_<sessionId>.<secret>`, run-scoped, dies with the session
```

`TM8_AGENT_TOKEN` is issued per spawn by `graph.issueWorkSessionAgentToken` and is described in `cli/src/credentials.ts` as: *"An agent's credential is minted at spawn and injected as `TM8_AGENT_TOKEN`; it dies with the session."*

So the hook command is:

```
tm8 session activity <event>
```

and it authenticates the same way `tm8 message send` already does, from the same env, over the same origin, with the same identity. **Authn: solved, reused. Authz: solved, reused — the token is pinned to one work session, so a hook physically cannot report for another.** Per-member isolation (§5) becomes a non-problem in the same stroke: the token *is* the member scope.

### 4.2 Two concrete hazards this avoids

**Redaction would silently kill a file-borne token.** `secret-redaction.ts:30`:

```
(sk-[…]|gh[pousr]_[…]|github_pat_[…]|xox[abpr]-[…]|tm8[sacr]_[A-Za-z0-9_-]{20,})
```

`TM8_AGENT_TOKEN` is `tm8s_…`, which **matches**. `redactSecretsDeep` scrubs every string in the composed manifest, and `internal.guard_manifest_secrets` (migration 086) is the tripwire behind it. Any design that writes the session token into a hook config file which then travels through the manifest gets `[credential-redacted]` in place of the credential, and hooks fail *quietly* — the worst available failure mode for a liveness feature. Note also `PTY_GRANT_PREFIX = 'tm8g_'`, where `g ∉ [sacr]`, so a new `tm8h_`-style hook token would *evade* the redactor and land in Postgres, violating S15's spirit. Both branches are bad. Not putting a token in a file is the only clean answer.

**A new endpoint on a shared host needs the whole apparatus again.** Endpoint + authn + single-use + replay window + wrong-session refusal + a credential-free audit allowlist + a rate limit + a story for a hook arriving after exit. That is `attach-authz.ts` and `audit-logger.ts` rebuilt for a signal that a CLI already carries. Refuse it.

### 4.3 Idempotency, ordering, replay

The CLI journal already establishes the shape. `SessionJournalRecord` carries a per-process `seq` and a `startedAt`, with the explicit note that *"`seq` is neither unique nor monotonic"* across processes — hence "pair with `startedAt` to order across processes". Hook invocations are exactly that: many short-lived processes.

Rules:

1. Every hook post carries `observedAt` (stamped in the hook process, from the agent's payload timestamp when the harness supplies one) and the native event name.
2. The server applies **last-writer-wins on `observedAt`**, never on arrival order. Two hooks racing to land is the normal case for a parallel-subagent agent; arrival order is meaningless.
3. **Sticky states are never demoted by a stale reading.** An `awaiting_decision` is cleared only by a *newer* reading that names the resolution — AO's design does this by matching `tool_use_id` on the tool-completion hook, and its comment records that the naive mapping without it was reverted in review (*"the daemon-side precedence rule is what makes these signals safe against parallel-subagent traffic (the naive mapping without it was reverted in PR #5's review)"*). Adopt the precedence rule; do not rediscover the revert.
4. Duplicate delivery is a no-op by construction: the reading is a *state*, not an increment.

### 4.4 A hook that arrives for a session that already exited

**Drop it. Record a coarse counter. Never transition out of a terminal status.**

This rule already exists and is enforced at two levels. `handlePtyActivity`: *"A PTY that has already gone means any status this would write is stale, and the RPC would refuse it with a 23514 anyway."* And migration 043's transition rule: *"only transitions OUT of a terminal status and INTO 'spawning' are refused."* The activity write inherits both. The hook path must fail the same way — quietly, with a warning, not `loud` — for the reason `SpawnService` already gives: *"a failed activity transition leaves a session showing the previous one of two non-terminal states, and the next transition corrects it."*

Audit logging follows `audit-logger.ts`: a fixed key allowlist (`sessionId, event, reason`), never the payload. Hook payloads contain prompt text and tool arguments; **the payload must never be logged and must never be stored.** Only the derived state and a bounded `detail` string leave the hook process.

### 4.5 Which hooks to install — start with six, not ten

AO installs ten for claude-code: `SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, Notification, SubagentStop, SessionEnd`.

The tool trio is the expensive half. Each is a process spawn per tool call, and an agent doing bulk edits makes hundreds. AO absorbs that because it runs one session on your laptop; tm8 runs many on a shared host under a concurrency cap.

Install the **state-changing** set only:

| Event | State it produces |
|---|---|
| `SessionStart` | `working` (and the first-signal timestamp — see §6.3) |
| `UserPromptSubmit` | `working` |
| `PermissionRequest` | `awaiting_decision` (sticky) |
| `Notification` | `awaiting_input` or `awaiting_decision`, per payload sub-type |
| `Stop` | `awaiting_input` (sticky) |
| `SessionEnd` | clears activity; lifecycle stays owned by `onSessionStatus` |

The tool-call *rate* — the thing `PreToolUse`/`PostToolUse` would buy — comes free from the transcript reader, which already counts `stats.toolCalls` and runs `detectStuck` over the same records, at zero per-tool-call process cost. Take the free version.

`PermissionRequest` deserves AO's own footnote, verbatim in intent: *"`ao hooks` writes nothing to stdout, so installing it never injects a permission decision."* A tm8 hook command that prints to stdout inside a `PermissionRequest` hook would be answering the dialog. **`tm8 session activity` must be silent on stdout, always.** That is a hard requirement on the CLI command, not a style note.

---

## 5. Decision 3 — per-member isolation

**Recommendation: write the hook config into the session's own worktree, never into the member's agent config dir. And put no session-scoped value in the file at all.**

### 5.1 Why not the member config dir

`agent-config-dirs.ts` and `agent-credentials.ts` define the per-member layout: `<dataDir>/credentials/<identityId>/<provider>/`, delivered by `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. It is the right place for credentials and the wrong place for this, for three reasons that each hold independently:

1. **It is per-identity, not per-session.** One member running five concurrent sessions has one such directory. Any session-scoped value written there is wrong for the other four the instant it lands.
2. **It does not exist for most members.** `AgentCredentialHomePort.resolve` returns `null` when the identity has not connected the provider, and the docstring is explicit that *"`null` means 'this identity has not connected this provider' and is the ordinary answer, not an error"*. For those sessions the agent reads the node's `~/.claude` — which `knownAgentConfigDirs` confirms is the fallback (`nodeDir`). **Installing a hook there is the cross-member leak, by construction**: one file, shared by every unconnected member on the node. This is the single most important isolation finding in this section.
3. **It is credential-adjacent.** The vendor CLI's `.credentials.json` lives in that directory. Machine-written config does not belong next to a secret, and the module header is emphatic that *"Nothing here builds a path"* precisely to keep one owner for that layout. A second writer into it would be a second convention.

### 5.2 Where it goes instead

AO already solved this and its solution transfers cleanly, because AO's "workspace" and tm8's worktree are the same object. `claudecode/hooks.go`:

```go
func claudeSettingsPath(workspacePath string) string {
    return filepath.Join(workspacePath, ".claude", "settings.local.json")
}
```

tm8 worktrees are provisioned per session (`spawn/worktree-provisioning.ts`), so **worktree-local is session-local for free**, with no new lifecycle to manage: the file is created when the worktree is, and it goes when the worktree goes.

### 5.3 The invariant that makes it safe

> **The hook config file contains no session id, no member id, no token, and no path outside the worktree. It contains a command string and nothing else.**

Because the hook resolves its identity from `TM8_SESSION_ID` and `TM8_AGENT_TOKEN` in the inherited environment (§4.1), the file's bytes are **identical for every session of every member on the node**. That dissolves three problems at once:

- No cross-member leak is possible, because there is nothing member-specific in it to leak.
- No staleness on worktree reuse (`SpawnService` has a `reused` path): a file written by a previous session is already correct for this one.
- Nothing for `secret-redaction.ts` to redact, and nothing for `guard_manifest_secrets` to trip on.

### 5.4 Four hazards to resolve before building

These are named as work, not waved at.

**(a) Untracked files block worktree teardown.** `git worktree remove` without `--force` refuses on *any* untracked file. AO hit this and its fix is `hookutil.EnsureWorkspaceGitignore`, which writes a self-ignoring `.gitignore` carrying a sentinel:

```
# managed by agent-orchestrator: AO hook files stay out of git status
```

and — the part worth copying exactly — *"A `.gitignore` at the same path that lacks the sentinel is left untouched and the install proceeds: the worktree then simply stays dirty and teardown preserves it, which is the safe degradation."* tm8's `worktree-reconcile.ts` must be taught the same, with a tm8 sentinel. **Open question for the registry design:** whether a hook file counts as "dirt" for tm8's own reconcile rules, which are stricter than git's.

**(b) `workspace-trust.ts` may gate project-local settings.** A project-scoped settings file is exactly the kind of thing a trust gate exists to control. This must be checked before building — if trust blocks the file, the hook tier is unavailable for untrusted roots and the harness record must say so (§6), which is a *feature* of this design rather than a blocker.

**(c) Interaction with `CLAUDE_CONFIG_DIR`.** tm8 redirects claude-code's config dir per member. Whether a redirected config dir still causes project-local `.claude/settings.local.json` to be read is **an assumption, not a verified fact**, and it is the assumption the whole hook tier rests on. It must be verified the way `agent-credentials.ts` verified its own claim — by running the CLI, in both directions, with a positive control — before any code is written. If it does not hold, the hook tier for claude-code needs a different file location and this section needs revising.

**(d) Atomic writes.** A truncated settings file silently disables hooks (and possibly user settings). AO's `AtomicWriteFile` does temp-in-same-dir + `chmod` + `sync` + rename for exactly this reason. Same requirement here, and the install must preserve user-authored hooks and unrelated keys — AO's `hooksjson` round-trips unknown fields specifically so that *"reconciling AO hooks never clobbers unrelated settings"*.

---

## 6. Decision 4 — the degraded mode (the part that matters most)

The requirement: **a harness whose liveness is guessed must be visibly distinguishable from one whose liveness is known.** Three pieces — the declaration, the wire, the words.

### 6.1 The declaration, on the harness capability record

Owned by `HARNESS-REGISTRY-DESIGN.md`; named here with its meaning.

```ts
interface HarnessActivitySignal {
  /** The BEST tier this harness supports. Never aspirational. */
  tier: 'hooks' | 'transcript' | 'stream-silence' | 'none';
  /** Which states this harness can actually produce. `quiet` alone is a
   *  complete and honest answer. */
  states: SessionActivityState[];
  /** Native event names installed, when tier === 'hooks'. */
  events?: string[];
  /** How the claim was earned. NULL is a legal, common value and means
   *  "declared but never demonstrated" — it must render differently from
   *  a verified claim. */
  verified: { at: string; method: string } | null;
}
```

Three rules:

1. **The default for a new harness is `{ tier: 'none', states: [], verified: null }`.** Absent means not permitted, matching the contract's existing posture on capabilities (*"refuses whenever capabilities are absent ('absent ⇒ not permitted')"*). Adding the 3rd through 26th harness therefore cannot produce a green lie: a harness nobody has characterised declares that it has not been characterised.
2. **`verified: null` is not the same as `tier: 'none'`.** "We think it can report and nobody has checked" and "it cannot report" are different facts and must render differently. This is the field that stops the registry filling with optimistic copy-paste.
3. **The declaration is a ceiling, not a promise.** A harness declaring `tier: 'hooks'` whose hooks never fire still produces `no-signal` at runtime (§6.3). Declaration constrains what a reading *may* claim; it never substitutes for a reading.

### 6.2 The wire

`execution.liveness` is the right carrier and needs no new operation. It is already *"the ONE authority on 'is there a live PTY'"*, already point-in-time (*"liveness is a point-in-time observation, never a promise"*), already scoped to a space the caller can read, and already carries the pattern for riding extra facts on an existing round trip — `eventHwm`'s own docstring argues the case: *"a client opening a space needs the mark and `nodeBootId` together … so carrying it here costs ZERO extra round trips."*

Add one field, same cardinality as `liveEntityIds`:

```ts
interface ExecutionLiveness {
  liveEntityIds: EntityId[];
  nodeBootId: string;
  checkedAt: string;
  capacity: { used: number; total: number };
  eventHwm: number | null;
  /** One entry per live session. Absent entry ⇒ no reading, which is a fact. */
  activity: Array<{
    sessionId: EntityId;
    reading: SessionActivity | null;   // null = no signal, see below
    declared: HarnessActivitySignal;   // the harness's ceiling, for the UI
    /** ms since `reading.observedAt`. Computed server-side so the client
     *  never does clock arithmetic against a foreign node's clock. */
    staleFor: number | null;
  }>;
}
```

`ExecutionLivenessSchema` is `.strict()`; adding a key is an ordinary server-side contract change and older clients ignore what they do not read. `reading: null` is deliberately nullable-never-optional, following the precedent `eventHwm` set: *"Nullable, never optional: 'the mark cannot be established' is an ANSWER this read has to be able to give, and an absent field is the shape a consumer reads as zero."*

**No new socket.** The announce path is the one that already exists: a status transition emits a durable event, and `contract.ts:1093` records that the *"session-liveness cadence keys on `work_session`"*. An event arrival nudges a liveness re-read. T-L10 satisfied; nothing new in the streaming hot path.

### 6.3 `no-signal`: when a live session has no reading

Borrow AO's grace-window shape, not its constant. AO:

```go
const noSignalGrace = 90 * time.Second
```

> *"It covers the agent's TUI boot plus the gap to the first activity-bearing hook callback … past it, a silent session is indistinguishable from one with a broken hook pipeline, and the dashboard must not claim a confident 'idle'."*

For tm8, a live session yields `reading: null` when **either**:

- the harness declares `tier: 'hooks'` (or `'transcript'`) and no reading has been produced since spawn, and the grace window has passed; **or**
- the harness declares `tier: 'none'`.

The grace value must come from the harness record, not a global constant — claude-code's composer is measured at *"11–15s after spawn"* before it is even submit-capable, and codex differs. Until measured, **90s is a defensible starting point and must be commented as unmeasured**, in the same terms `DEFAULT_IDLE_AFTER_MS` uses about itself. It is not a number to copy silently from another codebase.

### 6.4 The words — what the UI may honestly say

The presentation vocabulary does not grow. The **routing into it** changes, in two places.

**`needsAttention` gets a provenance gate.** Today it is a bare boolean and `presentSession` promotes it above everything: *"Attention outranks streaming: an agent waiting on you is the more actionable fact."* Correct — *if it is true*. The gate:

> `needsAttention` may be set **only** from a reading with `confidence: 'reported'` and `state ∈ {awaiting_input, awaiting_decision}`.

`needs-you` pulses. A pulsing "needs you" driven by a silence timer is the exact fabricated question `pty/types.ts` forbids, and it is currently one `live && status === 'idle'` predicate away from shipping. This gate is the smallest change in the document and probably the most valuable.

**A live session with `reading: null` renders `unknown` / "unverified".** `presentSession` gains one clause: a `live` verdict with no activity reading past its grace window presents as `unknown` rather than `running`. Its existing comment already authorises this reading — *"NO FRESH SNAPSHOT. We do not know. Renders neutral — never live, never exited — because claiming either would be inventing a measurement"* — and its styling (`hollow` dot, no pulse, `isLive: false`) is already correct for it.

This is AO's `no_signal`, reached through tm8's own vocabulary, with no fifteenth word.

**Then the line beneath the pill states the evidence, and its wording is fixed by tier:**

| `confidence` | Pill | Activity line | Never |
|---|---|---|---|
| `reported` | `running` / `needs-you` | *"waiting on a permission decision"*, *"finished its turn"* | — |
| `derived` | `running` | *"12 tool calls since it last spoke · 4m"* | *"idle"*, *"needs you"* |
| `guessed` | `running` | *"no output for 4m"* | any verb about the agent |
| none / `null` | `unverified` | *"this harness cannot report activity"* | *"idle"*, *"running"* |

Rendering carries a `data-signal="reported\|derived\|guessed\|none"` attribute so the distinction is testable, not merely intended — and so a regression is a failing assertion rather than a screenshot argument.

**Two honesty rules that must be tested, not assumed:**

1. No `guessed` reading may produce a sentence containing a verb whose subject is the agent. "No output for 4m" describes the stream. "Idle" describes the agent. The first is a measurement; the second is a claim tm8 cannot support.
2. `declared.verified === null` must be visible somewhere the operator can see it — a registry surface, not the session pill. An unverified capability claim that is invisible is the mechanism by which 24 harnesses quietly acquire green dots.

---

## 7. Decision 5 — TUI interpretation: refuse

**Recommendation: do not build it. Not now, not later. tm8's hookless tier is the transcript.**

Four reasons, in decreasing order of how hard they are to argue against.

**1. tm8 already has something strictly better for the same job.** `read-transcript.ts` gives, today, in both dialects: per-turn assistant prose, tool names, tool-call counts, timestamps, provider token usage, file-change attribution, `lastActivityAt`, and `detectStuck`. It has a byte-offset paging cursor with a proven no-overlap/no-gap property, and an `available` / `unavailableReason` / `searchedPaths` honesty contract that is *already* the shape §6 needs. A TUI parser would be a second, worse source for a subset of the same facts. AO reads the screen because AO chose not to read transcripts; that choice is not binding on a codebase that already parses them.

**2. The architecture points the other way.** The PTY ring is *"ANSI frames, capped at 1 MiB, and dies with the process"* (`read-transcript.ts` header) and it *"answers 'what is on the screen'"*. Parsing it server-side means a VT cell model per live session, on a shared host, with a 16ms coalescing window on the hot path that is a documented parity scar (*"SCAR: this default MUST stay 16ms (commit 07d504d)"*). AO needs a cell model only on Windows, where ConPTY forces it; tm8 would need one always, because tm8 *is* the server rather than the viewer.

**3. T-L10 grain.** *"Forbids: the database in any streaming hot path."* Deriving durable graph state by parsing frames is not literally forbidden — the derivation could sit off the hot path — but it points the frame surface at the state path, and the frame surface is the one thing the laws carve out as exempt from the entity contract precisely because it is *not* state.

**4. It does not scale to 26 harnesses.** `terminalui/composer.go` is 347 lines for the composer alone, coupled to specific rendering. A TUI redesign upstream is a silent breakage with no compile error and no test failure — the parser keeps returning a confident wrong answer. Whereas `hooksjson`'s own header notes that *"claude-code, goose, qwen, agy, droid, kimchi"* share the hooks file shape **byte-for-byte**, differing only in path, command prefix, timeout and event list. Hooks amortise across a harness family; screen-scraping does not amortise at all.

### 7.1 What the hookless tier is instead

```
hooks (reported)  >  transcript (derived)  >  stream-silence (guessed)  >  none
```

Three usable tiers where AO has two, and the middle one exists already.

Constraints on the transcript tier, so it does not become its own lie:

- **It is `derived`, permanently.** It may produce `working` and `quiet`. It may never produce `awaiting_input` or `awaiting_decision` — a transcript records what the agent wrote, not that a modal is open. §3.4 enforces this in the type.
- **Bounded reads only.** Tail the last window from the byte cursor; never re-read the file. `TAIL_BYTES = 256 * 1024`, doubling to `MAX_TAIL_BYTES` only when a window parses to nothing.
- **Cadence is unmeasured and must be measured.** A plausible starting shape: poll sessions a client is actually watching at one cadence, and sweep all live sessions at a much slower one for staleness. Both numbers must be derived, not chosen, and must be labelled as defaults until they are.
- **`unavailableReason` is a first-class answer.** `no_native_session_id`, `unsupported_agent_tool`, `no_transcript_file`, `unreadable` each mean "this session drops to the `guessed` tier", and the UI says which — the reader already returns `searchedPaths` so the answer is checkable rather than a shrug.

---

## 8. Decision 6 — the migration path

The regression oracle is not what the brief assumed (§1.3): the tuned constants govern prompt *delivery*, and this design touches the *read* path. That makes the sequencing genuinely low-risk, on one condition, stated as a hard invariant:

> **No phase of this work may modify `PROMPT_IDLE_MS`, `PROMPT_COLD_IDLE_MS`, `PROMPT_COLD_READY_TIMEOUT_MS`, `PROMPT_WARM_READY_TIMEOUT_MS`, `PROMPT_PRE_SUBMIT_IDLE_TIMEOUT_MS`, `PROMPT_PRE_SUBMIT_MIN_MS`, `PROMPT_SUBMIT_ATTEMPTS`, `PROMPT_SUBMIT_BACKOFF_MS`, `PROMPT_VERIFY_MS`, or `PROMPT_WRITE_CHUNK_BYTES`.** They belong to a different loop. Any PR that touches `PtyHostService.ts` must state in its body whether it changed the delivery path, and if so must re-run the measurement that produced `3/3 on claude-code, 2/2 on codex`.

`DEFAULT_IDLE_AFTER_MS = 10_000` is the exception and may move — its own docstring asks for the measurement it never got.

### Phase 0 — provenance, no behaviour change *(this is the honesty fix, and it ships alone)*

Attach `confidence: 'guessed'` / `source: 'stream-silence'` to every reading tm8 produces today, plumb it to the client, and apply §6.4's two routing rules. Every existing session keeps its exact status; what changes is that the UI stops being *able* to say "idle" or "needs you" on silence evidence, and starts saying "no output for 4m".

Regression bar: `work_sessions.status` writes are byte-identical before and after. Nothing in `handlePtyActivity` changes except what rides alongside.

### Phase 1 — the transcript tier for claude-code and codex

Both readers exist. Wire `detectStuck` and `lastActivityAt` into the activity reading; upgrade those two harnesses to `tier: 'transcript'`, `confidence: 'derived'`. Re-derive `STUCK_TOOL_CALL_THRESHOLD = 5` against the 46-minute incident (§2.1), which would not have fired at 4 tool calls, and record the derivation the way the delivery constants are recorded.

Regression bar: a session with no readable transcript must land on Phase 0 behaviour exactly, with `unavailableReason` explaining why.

### Phase 2 — hooks for claude-code, behind the capability flag

Six events (§4.5), worktree-local file (§5.2), CLI transport (§4.1), silent on stdout. Gated by the harness record so it can be turned off per harness without a deploy. Prerequisite: verify hazard **(c)** — that a redirected `CLAUDE_CONFIG_DIR` still reads project-local settings — before any code.

Regression bar: with the flag off, byte-identical to Phase 1. With the flag on and hooks failing to fire, the session degrades to Phase 1's reading, not to a wrong one.

### Phase 3 — the registry carries the declaration; harnesses 3..26 arrive

New harnesses default to `{ tier: 'none', verified: null }` and render `unverified`. **This is the phase the whole document exists to make safe**: the brief's stated fear is that 24 more harnesses make `execution.liveness` lie in 24 new ways with a green UI. Under this design a new harness cannot produce a green dot it has not earned, because the default declaration is "cannot report" and the routing rule for that declaration is `unverified`.

### What is explicitly out of scope

- Changing exit-code classification (§2.2). Recommended *minimum*: carry elapsed run time to the surface so a session can render "exited after 2s". Reclassifying a fast clean exit as `failed` is a behaviour change with its own blast radius and needs its own decision — flagged, not decided here.
- Windows / ConPTY. tm8 has no cell model and this design does not add one.
- Any change to `work_sessions` schema or migration 043's transition rules.

---

## 9. The three fields the chat UI is waiting on

Task `01a02901-a771-798e-8639-318c8e482133` ("Agent activity in chat — Crew Card + Live Dock") has fixture-driven components blocked on three fields. Direct answers.

### `activity` — yes, and it is honest at all three tiers

The string is tier-dependent and never tier-agnostic. The component should render `{ text, signal }` and style on `signal`, not concatenate a bare string.

| Tier | Available | Example |
|---|---|---|
| `reported` (Phase 2) | now-ish | *"waiting on a permission decision"* · *"finished its turn"* |
| `derived` (Phase 1) | **the best line, and buildable today** | *"12 tool calls since it last spoke"* · last assistant prose, truncated |
| `guessed` (Phase 0) | today | *"no output for 4m"* |
| none | today | *"this harness cannot report activity"* |

The `derived` line is the strongest of the four and depends on no new mechanism — `read-transcript.ts` already returns the prose, the tool count and the timestamps. If the chat UI needs one tier to un-fixture against, it should be this one.

### `progress` / `estimate` — **no. There is no honest source, and there will not be one.**

Stating it plainly, as asked. Three candidate sources, all unusable:

- **The agent's own estimate.** Agents do not know how many turns remain. A self-reported percentage is a generated number with a percent sign on it.
- **Token counts.** `SessionTranscriptStats` carries `inputTokens`/`outputTokens` when the transcript has them, and the journal's own contract already carries the warning verbatim for its estimates: *"BYTE-DERIVED ESTIMATES … They exclude the system prompt and the conversation, so they can NEVER be presented as the session's token spend."* Even exact token counts are a denominator-free numerator.
- **Tool-call counts.** `stats.toolCalls` measures work *done*, not work *remaining*. A session at 200 tool calls may be one edit from done or hopelessly lost — §2.1 is literally a session where the count went up and the progress did not.

**Recommended substitute: facts, not a fraction.** Elapsed time and turn count, which tm8 has exactly:

> *"12 tool calls · 3m since last message · running 47m"*

If the design needs a bar, the honest bar is a *time* bar against nothing — i.e. not a bar. Recommend dropping the field rather than filling it, and recommend against a spinner that implies measured progress. This is a case where the fixture should be deleted, not un-fixtured.

### staleness — **four distinct facts, currently collapsed into one green pill**

This is the actionable one, and three of the four are answerable with code that already exists.

| # | Fact | Answered by | Status today |
|---|---|---|---|
| 1 | No PTY at all; the record says `running` | `execution.liveness` → `liveEntityIds` → presentation `stale` | **Exists, correct, and unpolled.** The whole `stale` path is built; the gap is cadence. |
| 2 | Live PTY, no output for N | `DEFAULT_IDLE_AFTER_MS` → `status: 'idle'` | Ships today. Must be relabelled `guessed` (Phase 0), never rendered as a verdict. |
| 3 | Live PTY, output moving, agent has produced no prose across many tool calls | `detectStuck` in `read-transcript.ts` | **Built and wired to nothing that anyone polls.** This is the 46-minute incident. Phase 1. |
| 4 | Died seconds after boot, recorded as a normal exit | `bootSettlementMs = 150`; `exitCode === 0 → 'completed'` | **Not answered.** Minimum fix: surface elapsed run time (§8, out-of-scope note). |

Fact 1 deserves emphasis for the chat UI specifically: the node restart case is already fully modelled. `nodeBootId` *"is stable for the life of the server process and rotates on restart: a client comparing it across reads can tell 'same node, session genuinely gone' from 'node restarted — recorded statuses are stale until reconciliation'."* A Crew Card that reads `nodeBootId` across polls gets correct staleness for free, before any of this design lands.

---

## 10. Open questions, and what must be measured before anything is built

Nothing below is a nice-to-have; each is a number or a fact this design currently assumes.

1. **Does a redirected `CLAUDE_CONFIG_DIR` still read project-local `.claude/settings.local.json`?** The hook tier for claude-code rests entirely on this. Verify by running the CLI, both directions, with a positive control — the standard `agent-credentials.ts` set. If false, §5.2 needs a different file location.
2. **`DEFAULT_IDLE_AFTER_MS = 10_000`** — the one constant whose own docstring asks for the measurement it never received. Derive it.
3. **`STUCK_TOOL_CALL_THRESHOLD = 5` / `STUCK_SILENCE_MS = 30_000`** — inherited from maestro, never re-derived for tm8, and demonstrably would not have fired on the 46-minute incident at 4 tool calls.
4. **The no-signal grace window.** AO's 90s covers *its* agents' boot plus first hook. tm8 measured claude-code's composer at 11–15s to submit-capable and codex differs. Per-harness, derived, not a copied constant.
5. **Transcript poll cadence**, for watched sessions and for the background staleness sweep. Both currently unproposed as numbers, deliberately.
6. **Hook process cost.** Six hooks per session is an assumption about acceptable process churn under the concurrency cap. Measure before adding the tool trio, and treat "we should add `PreToolUse`" as requiring that measurement.
7. **Does `workspace-trust.ts` gate project-local settings files?** If yes, untrusted roots lose the hook tier — which this design handles correctly (they declare a lower tier) but which must be known rather than discovered.
8. **Does `worktree-reconcile.ts` treat a hook file as dirt?** AO's gitignore-sentinel fix addresses git; tm8's reconcile rules are its own.
9. **Reclassifying fast clean exits** (§2.2) — flagged as needing its own decision, not taken here.

---

## 11. Summary of decisions

| # | Question | Decision |
|---|---|---|
| 1 | State vocabulary | **Not AO's five.** Four states (`working`, `awaiting_input`, `awaiting_decision`, `quiet`) on a record that carries `confidence` and `source` with every reading. `exited` stays a lifecycle fact. `WorkSessionStatus` is untouched; the durable projection is byte-identical to today. |
| 2 | Hook transport | **No new endpoint, no new token.** `tm8 session activity <event>` over the CLI, authenticating with the spawn-injected `TM8_AGENT_TOKEN`. Silent on stdout. Late hooks for exited sessions are dropped, never resurrecting. Six events, not ten. |
| 3 | Per-member isolation | **Worktree-local, not config-dir.** The member config dir is per-identity, absent for unconnected members (→ node-wide leak), and credential-adjacent. The hook file carries **no session-scoped value at all**, so identical bytes are correct for every session. |
| 4 | Degraded mode | `HarnessActivitySignal` on the capability record, defaulting to `tier: 'none'`. Rides `execution.liveness`. `needsAttention` gated to `confidence: 'reported'`. A live session with no reading renders tm8's existing `unknown` / **"unverified"** — AO's `no_signal`, without a new word. |
| 5 | TUI interpretation | **Refused.** tm8's hookless tier is `read-transcript.ts`, which AO deliberately does not use and tm8 already has. Three tiers where AO has two. |
| 6 | Migration | Four phases, Phase 0 being provenance-only with byte-identical status writes. The prompt-delivery constants are declared off-limits; `DEFAULT_IDLE_AFTER_MS` is the one that may move. New harnesses default to "cannot report" and therefore cannot show a green dot they have not earned. |

**The single sentence this design is built around:** tm8's source already says, in three separate places, that stream silence must never be rendered as a verdict — and the wire carries no field capable of enforcing it. Everything above is downstream of putting that field on the wire.
