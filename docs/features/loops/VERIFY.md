# Verifying loops locally

How to check, on your own machine or a dev slot, that loops do what [LOOPS.md](LOOPS.md) says and what [DESIGN.md](DESIGN.md) promises. Every command here was run for loops PR6. On the shared tm8 host, wrap each heavy step (a pg suite, a full vitest, a build or a browser run) in `flock /tmp/tm8-heavy.lock …`.

## Prerequisites

- `bun install` at the repo root, then build what the suites import: `./node_modules/.bin/tsc -b packages/server packages/cli`.
- A Postgres you may write to. On the tm8 host that is the staging cluster on port 5443, never 5442, which is prod. The pg suites create and drop their own scratch databases through the admin URL:

```bash
export TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres
export TM8_W4_ADMIN_DATABASE_URL=$TM8_W1_ADMIN_DATABASE_URL TM8_MIGRATION_DATABASE_URL=$TM8_W1_ADMIN_DATABASE_URL
```

## The suites

| What | Command |
|---|---|
| The doors (`create_loop`, `update_loop`, `loop_run_claim`, `loop_run_settle`) | `TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5443/tm8_test_<you> node db/test/run.mjs` (resets that database; `db/test/loop_rpcs.test.mjs` is the loops file) |
| Every `loops.*` operation, runs, the claim, visibility | `cd packages/server && ./node_modules/.bin/vitest run --no-file-parallelism test/loops/loops-ops.pg.test.ts test/loops/loop-runs.pg.test.ts test/db/loops.pg.test.ts test/events/loop-visibility.pg.test.ts test/scheduler/loops-space-visibility.pg.test.ts` |
| The executor, the run projection and the tool-loop guard, with no database | `cd packages/server && ./node_modules/.bin/vitest run test/scheduler/loops-job.test.ts test/loops/runs-projection.test.ts test/loops/tool-loop-guard.test.ts test/facade/loop.test.ts` |
| **End to end on a real node** (below) | `cd packages/server && ./node_modules/.bin/vitest run --no-file-parallelism test/loops/loops-e2e.pg.test.ts` |
| `tm8 loop`, every verb | `cd packages/cli && ./node_modules/.bin/vitest run test/loop.test.ts` |
| The form, the list, the page, the draft tab, the help page | `cd packages/tm8-ui && ./node_modules/.bin/vitest run src/loops src/tab-workspace/adapters/loop-draft.test.tsx src/entity-help` |
| **The UI create flow in a browser** (below) | `cd packages/tm8-ui && ./node_modules/.bin/playwright test -c e2e/loops-create.config.ts` |
| MCP: `loops.*` in `tm8_read` and `tm8_act` | `cd packages/mcp && ./node_modules/.bin/vitest run test/tools.test.ts` |
| The coordinator's `tm8 loop` line and the prompt sizes | `cd packages/prompt && ./node_modules/.bin/vitest run test/prompt-v2.test.ts` |

## End to end on a real node

`packages/server/test/loops/loops-e2e.pg.test.ts` boots the production server and its scheduler on a throwaway database, with real PTYs (the echo agent, so no model or key is needed). It then drives the built CLI as a subprocess, exactly as a terminal would:

1. `tm8 loop preview` in Asia/Kolkata answers weekdays at 03:30 UTC (09:00 IST) and stores nothing, and an invalid expression exits 2.
2. A loop created with `--schedule '* * * * *'` **fires on the node's own 60 s tick**, unprompted. The run has a task and a session, both point back at the loop through `triggered_by`, and the next run is counted from the firing.
3. Run now refuses while that run is live (exit 6, `loop_run_overlap`), fires at once with `--force` and answers the session. `tm8 loop stop` settles it, and stopping it again is answered as it is.
4. A loop is walked through preview, create, enable, run-now, runs, stop, pause, resume, edit, a stale-version edit (exit 6), disable, show and list. Set `LOOPS_E2E_TRANSCRIPT=<file>` and the run writes what each command printed. That file is the transcript in [LOOPS.md](LOOPS.md).

The suite takes about two minutes, because it waits for a real tick.

## The UI create flow in a browser

`packages/tm8-ui/e2e/loops-create.spec.ts` serves `e2e/loops-create-harness.tsx` (the shipped list, form and page, over the fixture loops client) and drives it in Chromium:

1. New loop, then a name, the teammate picker, Weekdays at 09:00 and Europe/London.
2. The preview shows the server's summary and next runs.
3. Create. The row shows the schedule words, the teammate and the Enabled switch.
4. The loop's page opens. Run now shows "Run started", and the run appears in RUNS as running.

It saves two screenshots under its output directory. `src/loops/loop-create-flow.test.tsx` runs the same flow in jsdom through the real `createLoopsClient`, and holds the create body to the contract's strict `LoopCreateInputSchema`.

## By hand, on a dev slot

```bash
./node_modules/.bin/tsc -b packages/server packages/cli
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5443/tm8_dev_<you> node db/migrate.mjs reset --force
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5443/tm8_dev_<you> TM8_PORT=4610 TM8_AGENT_CMD=echo-agent \
  node packages/server/dist/index.js &
export TM8_BASE_URL=http://127.0.0.1:4610 TM8_SPACE_ID=<space-id>
tm8 loop create 'Every minute' --schedule '* * * * *' --teammate Worker --prompt 'say hello'
sleep 130 && tm8 loop runs 'Every minute'     # a run with trigger "schedule" and a session
tm8 loop run-now 'Every minute' --force        # a manual run, beside the live one
tm8 loop stop <run-id>
```

For the UI, point the dev UI at the same node (HOW-TO-TEST.md §3b). Then New loop, the preview, Create, the row's Enabled switch, and Run now and RUNS on the loop's page. Stop the server when you are done.

## What a green run does not prove

Until loops PR3 (#1408) merges, a **tool** loop is accepted but refused at every firing (`TOOL_LOOP_NOT_RUNNABLE`), so there is nothing to verify for that action yet. A spawn also carries only model, agent tool and access mode until then (DESIGN.md, "As shipped").
