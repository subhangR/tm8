# Why a message to a running agent can take ~60s to land

Written 2026-07-31 after a `tm8 message send --to <work-session-id>` took **61
seconds** to reach a busy agent, and read as a lost message.

## The short version

A message to a running session is **typed into the agent's TUI composer**, not
injected into a queue. The PTY layer must first decide the composer can accept
input. That readiness gate is the latency. It is deliberate, it is measured, and
the constants carry a warning not to "tidy" them.

**An idle agent gets your message in about a second. A continuously-working
agent can take ~60s, because it is indistinguishable from one still booting.**

## The gate

`packages/execution/src/pty/PtyHostService.ts` (~lines 136-175):

| Constant | Value | Role |
|---|---|---|
| `PROMPT_IDLE_MS` | 300ms | stream counts as "settled" after this much silence |
| `PROMPT_COLD_IDLE_MS` | 1500ms | COLD: silence that distinguishes a settled composer from a booting TUI's redraw lulls |
| `PROMPT_COLD_READY_TIMEOUT_MS` | **45000ms** | COLD cap — a PTY never yet seen quiet may wait this long |
| `PROMPT_WARM_READY_TIMEOUT_MS` | **1000ms** | WARM cap — once seen quiet, later prompts use the short gate |
| `PROMPT_PRE_SUBMIT_IDLE_TIMEOUT_MS` | 1000ms | let the composer echo the paste before pressing Enter |
| `PROMPT_SUBMIT_ATTEMPTS` | 10 | total Enter presses |
| `PROMPT_SUBMIT_BACKOFF_MS` | 750, 1200, 2000, 3000, 4000, 5000×5 | ≈36s if every attempt is used |

Why the numbers are large, from the source comment: Claude Code's composer is
**not submit-capable until 11-15s after spawn**, and codex **discards** input
written before it is ready. An earlier gate of (300ms idle, 5s cap) released
mid-boot and submitted **0 of 4** prompts — indistinguishable from no fix.
Waiting for genuine quiescence submitted 3/3 on claude-code and 2/2 on codex.
**Do not change these without re-running that test.**

## The pathological case — the one that bit us

A **busy** agent never falls quiet for 1500ms, so the COLD gate never releases
early. It runs to the full 45s cap, then spends Enter/verify backoff on top.

Observed: message sent `15:38:53`, delivered `15:39:54` — **61s**, one delivery
row, `attempt_no 1`. 45s cold cap + ~16s of submit backoff ≈ 61s.

**Measured vs inferred:** the constants, the arithmetic and the 61s wall-clock
are measured. That *this* delivery spent its time in *those* stages is
**inferred** — prod logs at `info` carry no per-stage prompt timing. Raise the
log level and re-run if you need the breakdown proven.

## How to tell a slow message from a lost one

`tm8 message send` returns a message id **immediately**. That means *accepted*,
not *arrived*. The dispatch is asynchronous. Watch the durable row:

```sql
select status, attempt_no, failure_reason, updated_at
from public.session_message_deliveries
where target_work_session_id = '<work-session-id>'
order by updated_at desc;
```

`dispatching` → still in flight, give it a minute. `delivered` → it landed.
A `failure_reason` is the only thing that means lost.

Do not judge by the agent's visible output, and do not resend on a hunch — check
`attempt_no` and the row count first. In our case a suspected double-send was
one message, one delivery, one attempt.

## Related defect: `message.delivery_settled` is captured but never projected

Seen in the prod server log:

```
events.poll skipped an event: no projection for captured event_type
'message.delivery_settled' — a migration added a capture case without a mapper arm
```

A migration added this event to capture **without** the corresponding projector
arm, so it is captured and then dropped. Consequence: the read model never
learns a delivery settled, so the UI gives **no signal at all** while a message
is in flight — the `session_message_deliveries` row is the only place the truth
exists. That is a large part of why the 61s read as a failure rather than a wait.

**Not fixed as of 2026-07-31.** Independent of the latency itself.
