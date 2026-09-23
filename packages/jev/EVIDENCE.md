# Jev phase 1 — what was actually measured

> **Historical record, 2026-09-22.** The measurements below were taken with the
> phase-1 spawn-time advisor. The Jev Launch Advisor program (design 01a0cb80)
> removed spawn-time routing: `JevRoutingAdvisor`, `TM8_ROUTING_POLICY`, the
> savings projection and the ledger no longer exist, and Jev now runs only when
> a person presses Ask Jev. The weights, floors, ladder and the eight questions
> that produced these numbers are unchanged in `src/model.ts`, and
> `scripts/fleet-run.mjs` re-derives the "What it chose" table through
> `adviseModel`. The per-attempt timeout is now 2 s (5 s total, one retry).

Everything below came from calls to `https://api.typesafe.ai/v1/systemone` on
**2026-09-22**, model **jev-1.13.0**, using this package's own `JevClient` and
`JevRoutingAdvisor` — not a hand-rolled fetch and not a mock. The tasks are 57
real tm8 tasks read out of the prod graph with `tm8 entity query --kind task`,
with their real titles, descriptions, priorities, statuses, acceptance-criteria
counts and parent titles.

This file exists because until that date **no line of this package had ever
reached the network.** All 112 tests injected a `fetchImpl` returning a response
this repository invented, and the invented response was wrong in a way that
mattered (see "The bug only a live call could find").

## Reproducing it

```
bun run build:jev
TYPESAFE_API_KEY=<key> node packages/jev/scripts/fleet-run.mjs --limit 57
```

The key is read from the server's environment and never leaves it — it is not
placed on a manifest, composed into a prompt, passed to an agent process or
returned by any RPC.

## The bug only a live call could find

The wire names a choice's probability mass **`probabilities`**. Every type,
fixture and test in this package called it `distribution`.

`topTwoMass()` read `a.distribution`, found `undefined` on every real answer,
and fell back to `a.confidence`. Those two numbers are not interchangeable:

| | median | range |
|---|---|---|
| argmax `confidence` | 0.77 | 0.13 – 1.00 |
| true top-2 mass | 0.99 | 0.75 – 1.00 |

The harness gate is `> 0.6`. On **40 of 114** live answers the confidence sat at
or below that gate while the top-2 mass sat above it — so the fallback did not
make the gate stricter, it made it wrong.

**Consequence, measured:** of the 19 tasks that route to Codex, **8 would have
been lost** — 42% of all cross-provider routing silently dead, on the exact
feature the work was asked for. Pinned by `test/live-wire.test.ts`, which reads
a verbatim recorded response (`test/fixtures/live-routing-response.ts`) rather
than one written by the same hand as the code.

## Two passes over 57 real tasks

| | pass 1 | pass 2 |
|---|---|---|
| answered | 57/57 | 57/57 |
| failures | 0 | 0 |
| median latency | 350 ms | 331 ms |
| input tokens | 103,774 | 103,774 |
| cost | $0.0044 | $0.0044 |

Combined: median 341 ms, p90 412 ms, max 1629 ms — inside the 1.5 s budget,
which is the number that justified it.

**Run-to-run agreement:** 95% same final model, 96% same tier, 98% same harness.
Three tasks moved; two by one rung inside the same provider, one across the
harness boundary (claude-sonnet-5 → gpt-5.6-terra). That flip is the honest
ceiling on stability: a task sitting on a boundary lands on whichever side the
distribution tips that minute.

## What it chose

Baseline is `claude-opus-5` for all 57 — what an unrouted spawn falls back to.

| model | n | | tier | n |
|---|---|---|---|---|
| claude-sonnet-5 | 19 | | standard | 31 |
| claude-opus-5 | 17 | | premium | 22 |
| gpt-5.6-terra | 12 | | economy | 2 |
| gpt-6-astra | 5 | | frontier | 2 |
| gpt-5.6-luna | 2 | | | |
| claude-opus-5[1m] | 2 | | | |

**Cross-provider: 19 of 57 to Codex, 38 to Claude Code.** Changed the launch on
40 of 57.

Work kinds Jev read off the tasks: 20 implement, 13 design, 9 unclear, 8
investigate, 6 review, 1 operate.

## Cost

Counterfactual over the 57 tasks, opus-5 baseline: **$495.50 → $234.86, saved
$260.64 (52.6%)** against $0.0044 of Jev.

**This is a projection, not a measurement**, and the code says so on every row
(`savings.measured: false`). It assumes the chosen model burns the same token
profile the baseline would have. A cheaper model that needs more turns erodes or
reverses it. The ledger settles projected rows against real session tokens; only
settled rows are evidence of saving.

## A broken Jev cannot block a spawn

Five real failure modes, real network, through the real advisor:

| failure | result |
|---|---|
| endpoint refused (127.0.0.1:9) | `null`, 46 ms |
| DNS failure | `null`, 453 ms |
| bad API key (401) | `null`, 797 ms |
| 1 ms timeout budget | `null`, 4 ms |
| non-Jev JSON body | `null`, 128 ms |

None threw. `null` means "no opinion" and the spawn resolves through the
precedence chain tm8 has always had. `test/spawn-routing.test.ts` proves the
stronger claim: with an advisor that returns `null`, the launch is
**indistinguishable** from the unrouted one — same model, same null routing
block on the manifest. The old logic is not bypassed when Jev is silent; it is
the fallback, and it still decides.

The activation switch is equally fail-closed: policy `off`, no key, or nothing
set at all each yield `undefined` from `routingAdvisorFromEnv` — no object, no
HTTP client, no log line. A fleet that sets nothing behaves exactly as it did
before this package existed.

## What is NOT evidence yet

- **No routed session has run.** Every number above is Jev's decision, not the
  outcome of acting on it. The ledger has no settled rows.
- **The weights are not calibrated.** They are a considered starting point that
  produced a defensible spread on real work. Revising them needs settled rows.
- **Nothing is deployed.** The live server carries no Jev; prod has no
  `TM8_ROUTING_POLICY` and no key.
