# CodeBrain — an idea-to-ship pipeline that runs on tm8

Eight phases of tm8 `team_member`s, driven by a conductor that reads durable graph state each
tick. Ported from Claude Code's own SDLC plugins (`feature-dev`, `pr-review-toolkit`,
`code-review`, `ralph-loop`).

    TRIAGE -> EXPLORE x3 -> CLARIFY (gate) -> ARCHITECT x3 (gate)
           -> IMPLEMENT -> REVIEW x6 -> GRADE -> SHIP

## Run

    python3 tools/codebrain/conductor.py <task-id> --project <projects.id> --repo <path>

`--repo` runs PREFLIGHT first, which probes the environment and DERIVES the gates: language deps
importable, a disposable database, outbound services declared in manifests/imports, browser,
push rights, CI config, staging, defaulted secrets. A **BLOCKER halts the run** — a phase that
cannot run the tests cannot produce evidence. A **DEGRADED** item proceeds but is restated at
every later gate and must appear in the readiness report.

`--gate-default <x>` pre-authorises a fallback if a human gate times out. Without it an
unresolved gate HALTS rather than guessing.

`members.json` maps member keys to `team_member` entity ids in the space you are running in.

## Depth routing

TRIAGE picks the depth; the conductor thins both the stage list and the fan-out.

    direct     5 agents   typo, config, version bump
    standard   9 agents   a bounded change inside an existing pattern
    full      17 agents   new subsystem, migration, auth, payments, public API

## Rules the design encodes — each was paid for by a failure

- **Wedge detection is IDLE TIME, never tool count.** A session that made one call and stopped is
  wedged; `tool_calls == 0` calls it healthy and burns the full phase timeout.
- **A session that has already POSTED is not wedged** — it went quiet because it finished. Check
  the anchor before the timer.
- **Release a session the moment it reports.** A live session keeps receiving anything posted to
  the task anchor, and its later messages are indistinguishable from the current run's work.
- **Briefs go to the SESSION. The task anchor is for REPORTS ONLY.** The anchor fans out to every
  session on the task; an IMPLEMENT brief broadcast there reached three finished explorers.
- **Only the phase that WRITES CODE needs a worktree.** Read-only phases use `--workdir project`.
- **A gate must FAIL CLOSED.** Never resolve a timeout on the recommending phase's own answer —
  that can only ever agree with it, so it could never catch the case a gate exists for.
- **A human decision is ONE object, referenced by path and hash, never copied into briefs.** And
  the record must be self-consistent: an append-only log is safe to audit and unsafe to follow,
  so annotate superseded lines in place with forward pointers.
- **Record a stage IN-FLIGHT at spawn, not only at completion**, and ADOPT a running session
  rather than spawning a duplicate. Adopting an EXITED one is the opposite bug — the stage then
  waits forever for a report that can never come.
- **Every concurrent phase needs its OWN test database** if the suite resets a schema.

## Honest limits

- Not autonomous. Budget an operator. Its first full run needed ~10 restarts.
- Throughput is poor at `full` depth. Route honestly.
- Fan-out is unreliable on this platform today — see the session-wedge defect: a spawned session
  can lose a `tool_result` and go silent with a live PTY. The conductor detects and retries it;
  it cannot fix it.
