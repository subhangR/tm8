# RUNBOOK — running one slice (coordinator)

You own ONE slice = ONE arm on ONE dev node. Never touch 7778 (no restart, no env, no profile). Never flip a fleet default. Nodes only on 4620–4624 with DBs tm8_eval0..4.

| slice | arm | port | db | datadir |
|---|---|---|---|---|
| c1 | lean | 4621 | tm8_eval1 | /private/tmp/ctxeval/node1 |
| c2 | index-derived | 4622 | tm8_eval2 | /private/tmp/ctxeval/node2 |
| c3 | index-authored | 4623 | tm8_eval3 | /private/tmp/ctxeval/node3 |
| c4 | inherit | 4624 | tm8_eval4 | /private/tmp/ctxeval/node4 |

## 0. Preconditions

```sh
uptime                                   # do not start anything above a 1-min load of 80
cd <checkout of branch ctx-eval/e1 or main>   # git rev-list --count HEAD..origin/main must be 0 on main
RIG=tools/rigs/context-eval
# the build under test (shared by all four nodes; already at /private/tmp/ctxeval/build for the first run)
ls /private/tmp/ctxeval/build/packages/server/dist/index.js /private/tmp/ctxeval/build/packages/cli/dist/index.js
```

## 1. Bring up your node (idempotent; ~30 s)

```sh
ARM=<arm> $RIG/dev-node.sh up <port> <db> <datadir> /private/tmp/ctxeval/build
$RIG/dev-node.sh status <port>            # prints the registry: arm, space, project, teammates
```
It creates the DB, migrates, starts the server under `env -i` (delivery wired), claims the owner, creates the space (that seeds the Sonnet 5 / Haiku 4.5 teammates), the project and the ledger-lite fixture repo, and writes `<datadir>/t8` (owner CLI). Re-running `up` with another ARM restarts under it.

## 2. Build the fixture templates on your node (~1 min, once per node)

```sh
node $RIG/fixture.mjs --node <port>
```
Refuses nothing; skips when already current. On an `index-authored` node it also writes the authored headers.

## 3. Run the slice

```sh
uptime
nohup node $RIG/lanes.mjs --slice <c1..c4> --node <port> --out $RIG/results/$(date +%F)-<build-sha>-<slice>.jsonl > <datadir>/lanes.log 2>&1 &
tail -f <datadir>/lanes.log        # one line per lane start and per lane end
```
Defaults: `--reps 2`, `--models sonnet5,haiku45`, all 10 task keys → 40 lanes, `--concurrency auto`, `--timeout-min 25`.
Useful: `--only fee,stress30` · `--families needle,memory` · `--dry-run` (prints the interleaved plan).

**The load rule (built in, and yours to watch):** `lanes.mjs` reads the 1-min load before every start: 2 lanes concurrent below 40, 1 at 40–80, none above 80 (it waits and logs `waited`). Every row records `uptimeStart`, `uptimeEnd`, `loadAtStart`, `waitedSeconds`. If you see the load climb past ~110, stop starting new work on the Mac (other coordinators share it) and say so on your task.

## 4. Post rows and exclusions on your task

After every ~10 lanes and at the end, post on your coordinator task: the results file path, lanes done / total, `grep -c '"excluded"' <file>`, and the tail of the log. A lane the runner set aside carries `excluded: {reason, by: 'auto'}` (start failure: no transcript within 120 s, spawn error, task-copy error). To set aside a lane yourself (the host slept, a lane you had to kill), never delete the row:
```sh
node $RIG/exclude.mjs $RIG/results/<file>.jsonl --session <work-session-id> --reason "<why>" --by <you>
```
A row that is neither measured nor excluded makes `report.mjs` exit 1 — that is deliberate; fix it or set it aside with a reason.

## 5. On a hang

- `ended: no-transcript` after 120 s = the workspace-trust prompt (task 01a0d79e). The runner already terminated it and set the row aside. Re-run that cell: `--only <key> --models <model> --reps 1` (the rep number will repeat; note it on your task).
- A lane past `--timeout-min`: the row says `ended: timeout` and is measured anyway; it is counted in §5 of the report.
- The runner itself stuck (no log line for 30 min): `pkill -f "lanes.mjs --slice <yours>"` (ONLY your slice's pattern — never a bare `pkill -f claude`), `tm8`-terminate the lane sessions it lists in the log via `<datadir>/t8 session terminate <id> --yes`, then restart the runner with `--only` for the cells that have no row yet.

## 6. Report

```sh
node $RIG/report.mjs $RIG/results/<file>.jsonl                       # your slice
node $RIG/report.mjs $RIG/results/<date>-<sha>-c*.jsonl --out $RIG/results/<date>-<sha>-all   # all four
node $RIG/report.mjs $RIG/results/<new>.jsonl --baseline $RIG/results/<prior>.jsonl            # as a diff
```

## 7. Tear down (only when told)

```sh
$RIG/dev-node.sh stop <port>
```
The DB and datadir stay (rows point at manifests and transcripts there). Do not drop them until the consolidated report is posted.
