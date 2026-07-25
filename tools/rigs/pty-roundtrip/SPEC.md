# `execution.prompt` PTY round-trip — rig specification

**Owner:** Lynx (Quality). **Gates:** G3 (Phase 1 done). **Live at:** M3.
**Normative sources:** `09-IMPLEMENTATION-PLAN.md` §7 (risk table) and §5.3 ·
`04-EXECUTION-TRANSPLANT.md` §6 (R17) and §7 (acceptance) · `packages/contract`
(`ExecutionPromptInput`, `ExecutionSpawnInput`, `StreamAttachGrant`).

---

## 1. Why this rig exists

From 09 §7, verbatim:

> | `execution.prompt` silently undelivered (R17's failure mode) | G3 includes a
> scripted coordinator→worker prompt round-trip asserted **on PTY output, not on
> graph state** |

And from 04 §6:

> Today `maestro session prompt <id> --message` *injects text into the target
> session's PTY* — it makes an agent act. An anchored message is inert unless
> something delivers it. […] **Without this, every coordinator↔worker protocol
> breaks *silently*** — messages land in the graph, agents never see them. This
> is the single most dangerous silent-failure seam in the transplant.

The danger is specific and worth stating plainly, because it determines the
entire shape of this rig:

**A broken `execution.prompt` looks exactly like a working one from the
database's point of view.** The command is accepted, a row is written, an
activity verb is emitted, the UI shows the message in the thread, `200 OK`
comes back. Every graph-level assertion passes. The only thing that did not
happen is the only thing that mattered: the bytes never reached the agent's
terminal, so the agent never acted. Multi-agent orchestration then fails as
*silence* — workers that never respond, coordinators that wait forever — which
is the most expensive failure mode to debug and the hardest to notice in a demo.

Therefore: **the graph is not evidence.** This rig's verdict is derived from the
PTY output byte stream and nothing else. Graph state is checked only to
distinguish *which* failure occurred (§5), never to declare success.

## 2. Scope

| In scope | Out of scope |
|---|---|
| `execution.spawn` → live `work_session` with an attachable stream | Manifest/prompt *content* correctness (that is the SpawnService parity fixture) |
| `execution.prompt` text appearing in the target's PTY output | Whether the agent's *reply* is semantically good |
| Delivery marking, and its ordering relative to the bytes | Terminal rendering/paint (that is the perf rig) |
| Two-agent coordinator→worker orchestration (G3 acceptance) | Old maestro's `session prompt` (the behavioural oracle, not the subject) |

## 3. Definitions

- **Nonce** — a random token embedded in the prompt text, unique per attempt.
  The rig searches the PTY byte stream for the nonce. Nonces avoid the trap of
  matching on prompt text that could plausibly appear in the terminal for
  unrelated reasons (echoed logs, the agent quoting itself, scrollback replay).
- **Delivery window** — the interval from the `execution.prompt` command being
  accepted to the deadline by which the nonce must be observed. Default 10s;
  it is a *ceiling on silence*, not a latency target.
- **Observed** — the nonce's bytes appear in the PTY output stream of the target
  session, on a subscription opened **before** the prompt was sent. Attaching
  after the fact and reading scrollback would let a replayed buffer masquerade
  as live delivery.

## 4. The assertions

### A. Single-hop delivery (the core assertion)

```
GIVEN a live work_session W (status `running`), spawned via execution.spawn
  AND an open PTY subscription to W, established BEFORE the prompt
WHEN  execution.prompt(W, "<nonce> please acknowledge") is accepted
THEN  the nonce appears in W's PTY OUTPUT stream within the delivery window
```

Sub-assertions that make the result trustworthy rather than merely green:

- **A1 — pre-attach.** The subscription is opened first, and the rig records the
  byte offset at prompt time. The nonce must appear *after* that offset. A nonce
  found in replayed scrollback is a FAIL, not a PASS.
- **A2 — the nonce is not self-inflicted.** The rig never writes to the PTY. The
  only path from the rig to those bytes is the server's delivery mechanism.
- **A3 — delivery marking follows the bytes.** R17 says the executor injects
  *and marks delivered*. The rig asserts the mark exists — and asserts it did not
  appear **before** the bytes did. A "delivered" mark that precedes (or occurs
  without) PTY bytes is the exact silent failure this rig hunts; it must fail
  loudly rather than being accepted as an optimistic write.
- **A4 — no double delivery.** The nonce appears exactly once. A retried
  injection that types the prompt twice corrupts an agent's input as surely as
  never delivering it.

### B. Idempotent replay does not double-inject

```
WHEN execution.prompt is replayed with the SAME clientMutationId
THEN the command ledger replays the recorded CommandResult (04 §5.1)
 AND NO additional nonce bytes appear in the PTY
```

This is where the uniform idempotency envelope meets a side effect that is *not*
a database write. A ledger that replays the result but re-runs the injection is
worse than no ledger at all.

### C. Honest failure when the target is not live

```
GIVEN a work_session that has exited
WHEN  execution.prompt targets it
THEN  the command FAILS with a closed-taxonomy error (invariant_violation or
      not_found), and does NOT quietly write a message into the graph
```

The negative control. Without it, "delivery" could be implemented as "write to
the graph and hope", and the suite would still pass A.

### D. Two-agent orchestration (G3 acceptance, 04 §7)

```
GIVEN a coordinator session C spawned via execution.spawn (mode: coordinator)
WHEN  C spawns worker W through execution.spawn
  AND C prompts W through execution.prompt
THEN  W's PTY shows the prompt (assertion A applied to a hop the rig did not make)
 AND  W's report-back appears as messages anchored to its work_session/task
 AND  C's PTY shows evidence it received the report-back
```

D is the full loop: the rig is not in the delivery path at all — it only
observes two terminals. This is the scenario 09 §7 and 04 §7 name as the G3
acceptance bar, and it is the one that would have caught every
coordinator↔worker protocol break in the old system.

## 5. Diagnosing a failure (why graph state is still read)

When the nonce does not arrive, the rig classifies:

| Graph shows the prompt? | Bytes in PTY? | Verdict |
|---|---|---|
| yes | yes | **PASS** |
| yes | no | **The R17 failure.** Command accepted, message durable, agent blind. Highest severity — this is the silent one. |
| no | no | Command rejected or lost. Loud, ordinary failure — check the error code. |
| no | yes | Delivery works but is unrecorded: no audit trail, replay/idempotency unsafe. |

The classification exists so that a red run names *which* seam broke instead of
just "prompt round-trip failed".

## 6. Preconditions (why this is a skeleton until M3)

| Needs | Lands at | Owner |
|---|---|---|
| `execution.spawn` creating a real `work_session` + PTY | M3 §5.2 | Orion (SpawnService, R27) |
| `execution.streams.attach` returning a usable `StreamAttachGrant` | M3 §5.1 | Orion / Draco |
| `execution.prompt` PTY injection + delivery marking | M3 §5.3 | Orion (R17) |
| A space, a `team_member` persona, and a task to spawn against | M1 | Rigel / Altair |

Until all four exist the rig runs and reports RED with the precondition named.
It is committed now — before the code it tests — deliberately: R17 is a
requirement that is easy to declare done and hard to notice missing, so the
assertion should predate the implementation.

## 7. Operational rules

- **Never point this rig at a working session.** It spawns its own throwaway
  sessions (`title: rig-roundtrip-*`) and terminates them in teardown. Prompting
  a real agent injects text into that agent's input.
- **The prompt text is inert.** A nonce plus "please acknowledge" — never a
  command, never anything an agent could execute destructively if it *does* act.
- **Teardown always runs**, including on assertion failure: every spawned session
  is terminated via `execution.terminate`. A rig that leaks live PTYs on failure
  becomes something people stop running.
- **Old maestro is the oracle, not the subject.** If a round-trip fails in tm8,
  the same scenario can be run by hand against old maestro's `session prompt` to
  confirm the behaviour being demanded is the behaviour that already exists.

## 8. Files

| File | Role |
|---|---|
| `SPEC.md` | this document — the assertions, normative |
| `roundtrip.mjs` | executable skeleton: A, B, C above; RED until M3 |
| `two-agent.mjs` | assertion D — the G3 orchestration scenario; RED until M3 |
