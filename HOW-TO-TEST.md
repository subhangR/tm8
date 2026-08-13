# How to test tm8

Hand-test the basic loop: **create a space, project and task → spawn an agent
session on a real server PTY → prompt it → watch progress land in the task
thread → complete the task.**

Every command below was run verbatim by the coordinator against a live
database. If one does not behave as documented, that is a bug in tm8 or in this
file — not in your setup.

> **Scope.** This is the G1A loop only. Most of the 80-operation catalog still
> answers an honest `501 not_implemented`, and that is correct rather than
> broken: a node that has not built an operation says so instead of faking a
> result. `/health` tells you how many are real.

---

## 0. Prerequisites

**Node, never bun, for anything touching a PTY.** node-pty's `onData` never
fires under bun. Using `bun run <script>` as a task runner is fine; using bun as
the *runtime* for the server or execution packages is not.

```bash
node --version        # v22+; verified on v25.6.1
```

**A database must exist and be migrated.** One command does all of it:

```bash
./install.sh                 # cluster, roles, database, migrations, build
./install.sh --status        # confirm: migrations N/N, delivery role can authenticate
```

tm8 standardises on **Postgres 16** and the cluster is the *system* Postgres — the
`dev` slot uses `tm8_dev` on port 5442. Nothing in this repo starts a postmaster:
`packages/server/src/sidecar/` looks like it does and is dead code. See
[`docs/ops/INSTALL.md`](docs/ops/INSTALL.md).

If something is off, ask the doctor rather than guessing:

```bash
bun run doctor               # ports, build, AND the database + migration state
```

A tm8 with no database still boots, still listens and still answers `/health` —
while logging `graph: NOT CONFIGURED` and returning `501` to every operation. That
state used to pass every check this file described.

**node-pty is repaired automatically now — you no longer run anything.** bun
extracts npm tarballs without the executable bit, so `spawn-helper` lands at
0644 and **every PTY spawn dies with `posix_spawnp failed`** — which surfaces
as "spawning is broken", or in production as a bare 503 on
`/v2/execution/spawn`, rather than as an install problem. The prebuilt binaries
survive; only the mode bit is lost.

This used to be a manual step documented here, which meant it was skipped
exactly when it mattered — a fresh worktree, installed and deployed by someone
who had not read this file. The root `postinstall` runs
`scripts/repair-node-pty.sh` after every `bun install`, and `deploy/prod/deploy.sh`
asserts the bit before it rotates a snapshot, so a broken helper can no longer
reach a running server.

```bash
cd /path/to/your/tm8/clone
bun install                                  # → postinstall repairs node-pty
cd packages/execution && bun run harness     # → 5/5 checks passed / HARNESS GREEN
```

Run the harness whenever spawning misbehaves — it isolates the PTY layer from
everything else in about two seconds.

---

## 1. The fastest way to see it work

One command. It resets the database, starts the server, drives all 17 calls of
the loop, and prints what it did at every step. It uses a fake **echo agent**
instead of a real model, so it costs nothing and needs no API key.

```bash
cd ~/Desktop/Projects/tm8 && bun run build && \
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_dev \
  node db/migrate.mjs reset --force && \
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_dev \
TM8_PORT=4610 TM8_AGENT_CMD=echo-agent \
  node packages/server/dist/index.js & \
sleep 3 && TM8_BASE_URL=http://127.0.0.1:4610 node scripts/smoke-loop.mjs
```

It ends with:

```
  ✓ THE LOOP CLOSED
     space   019f98a0-…
     project 019f98a0-…
     task    019f98a0-…
     session 019f98a0-…

  17 calls, all through the real router.
```

> **Why one command?** The server is backgrounded. If you start it in one shell
> invocation and run the driver in another, some shells reap the background
> process group in between and you get `ECONNREFUSED`. Keep them together, or
> run the server in its own terminal window and drop the `&`.

---

## 2. The same thing, step by step

Do this when you want to watch it rather than trust it.

### 2.1 Reset the database

```bash
cd /path/to/your/tm8/clone
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_dev \
  node db/migrate.mjs reset --force
```

Expect `dropped database` / `created database` / 14 migrations `ok` /
`migrations applied`.

### 2.2 Build and start the server

```bash
cd ~/Desktop/Projects/tm8 && bun run build

TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_dev \
TM8_PORT=4610 TM8_AGENT_CMD=echo-agent \
  node packages/server/dist/index.js
```

```
tm8-server listening on http://127.0.0.1:4610
  catalog: 80 HTTP operations mounted · 28 implemented · the rest answer 501 not_implemented (DEV-13)
  graph: connected
  ws: /v2/ws  ·  health: http://127.0.0.1:4610/health
```

Two lines are worth reading:

- **`28 implemented`** — how many operations are real. If it says `0`, you
  started without `TM8_DATABASE_URL` and everything below will 501.
- **`graph: connected`** — the pool reached Postgres.

> `node packages/server/dist/main.js` is **not** the entry point. It defines
> `main()` without calling it and exits 0 silently — which looks like success.
> Always use `dist/index.js`.

The server binds loopback only and **refuses to start** on any other interface.
That refusal is the security posture, not a misconfiguration.

### 2.3 Drive the loop by hand

Each block is one step. Copy the ids forward as you go.

`jq` is **not** required — this repo does not assume it is installed. Define this
tiny reader once per shell and every command below works with stock Python:

```bash
j() { python3 -c "
import sys, json
d = json.load(sys.stdin)
for k in sys.argv[1].split('.'):
    d = d[int(k)] if k.lstrip('-').isdigit() else d[k]
print(d if isinstance(d, str) else json.dumps(d, indent=2))
" "$1"; }
```

(If you do have `jq` installed, `| j data.space.id` and `| jq -r .data.space.id`
are interchangeable throughout.)

```bash
B=http://127.0.0.1:4610

# who am I — proves claims and identity reach the database
curl -s $B/v2/identity | j data.username

# a space
curl -s -X POST $B/v2/spaces -H 'content-type: application/json' \
  -d '{"name":"My Space"}' | j data.space.id

# a project — trust MATTERS, see the note below
mkdir -p /tmp/tm8-demo
curl -s -X POST $B/v2/projects -H 'content-type: application/json' \
  -d '{"name":"Demo","workingDir":"/tmp/tm8-demo","trust":"trusted"}' | j data.id

# link the project into the space
curl -s -X POST $B/v2/spaces/<SPACE_ID>/projects -H 'content-type: application/json' \
  -d '{"projectId":"<PROJECT_ID>"}' | j data

# a task
curl -s -X POST $B/v2/entities -H 'content-type: application/json' \
  -d '{"spaceId":"<SPACE_ID>","kind":"task","title":"Try tm8"}' | j data.entity.id

# see it in the space's task list
curl -s -X POST $B/v2/collections/query -H 'content-type: application/json' \
  -d '{"spaceId":"<SPACE_ID>","kinds":["task"],"limit":10}' | j data.page.items.0.title

# a team member — the persona the session runs as
curl -s -X POST $B/v2/entities -H 'content-type: application/json' \
  -d '{"spaceId":"<SPACE_ID>","kind":"team_member","title":"My Agent"}' | j data.entity.id

# SPAWN — this starts a real PTY process
curl -s -X POST $B/v2/execution/spawn -H 'content-type: application/json' \
  -d '{"spaceId":"<SPACE_ID>","projectId":"<PROJECT_ID>","teamMemberId":"<MEMBER_ID>",
       "taskIds":["<TASK_ID>"],"workdir":{"mode":"project"},"mode":"worker"}' \
  | j data.entity.id

# PROMPT it — the bytes go into the live terminal
curl -s -X POST $B/v2/entities/<SESSION_ID>/commands/prompt \
  -H 'content-type: application/json' -d '{"message":"hello agent"}' \
  | j data.entity.state.status      # → "running"

# progress into the task thread
curl -s -X POST $B/v2/messages -H 'content-type: application/json' \
  -d '{"anchorId":"<TASK_ID>","body":"Making progress."}' | j data.entity.title

# read the thread back
curl -s $B/v2/entities/<TASK_ID>/messages | j data.items.0.title

# the event log — what a reconnecting client replays
curl -s "$B/v2/spaces/<SPACE_ID>/events?since=0" | j data.items.0.type

# complete the task (expectedVersion and completerIds are both REQUIRED)
curl -s $B/v2/entities/<TASK_ID> | j data.version
curl -s -X POST $B/v2/entities/<TASK_ID>/commands/complete \
  -H 'content-type: application/json' \
  -d '{"expectedVersion":<VERSION>,"completerIds":["<MEMBER_ID>"]}' | j data.entity.state.workStatus

# stop the session
curl -s -X POST $B/v2/entities/<SESSION_ID>/commands/terminate \
  -H 'content-type: application/json' -d '{}' | j data.entity.state.status
```

**About `trust`.** Projects default to `untrusted`, and `execution.spawn`
**refuses** to launch an agent into an untrusted working directory:

```json
{"code":"forbidden","message":"spawning into an untrusted project requires explicit confirmation"}
```

That refusal is a feature. Starting a coding agent in a directory nobody
vouched for is exactly the thing worth an explicit yes, so say yes on purpose
with `"trust":"trusted"` rather than routing around it.

---

## 3. Running a real agent instead of the echo agent

Everything above uses `TM8_AGENT_CMD=echo-agent`, a stub that proves the
plumbing without spending anything. To run a real Claude session, **drop that
variable** — the default is `claude`, with flags derived from the manifest:

```bash
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_dev TM8_PORT=4610 \
  node packages/server/dist/index.js
```

Then spawn as in §2.3. The spawned process:

1. gets `TM8_SESSION_ID`, `TM8_MANIFEST_PATH` and `TM8_BASE_URL` in its
   environment;
2. reads its manifest from `~/.tm8-dev/manifests/<sessionId>.json`;
3. runs `tm8 worker init` to turn that manifest into its system prompt.

You can see exactly what an agent is told, without spawning one:

```bash
tm8_manifest=$(ls -t ~/.tm8-dev/manifests/*.json | head -1)
TM8_SESSION_ID=probe TM8_MANIFEST_PATH="$tm8_manifest" \
TM8_BASE_URL=http://127.0.0.1:4610 \
  node packages/cli/dist/index.js worker init
```

which prints the identity block, the session context (space, server, project,
working dir), the reporting commands, and the assigned tasks.

The agent reports back with:

```bash
tm8 whoami
tm8 task report progress <taskId> "what I just did"
tm8 task report complete <taskId> "what I finished"
tm8 task report blocked  <taskId> "what stopped me"
```

Exit codes are meaningful: `0` ok, `2` usage error (never touches the network),
`3` the server *refused* the command, `4` the server *could not answer* it
(unreachable, 5xx, or not implemented). `3` and `4` are deliberately different
facts — "command rejected" and "handler not built" must not be confused.

---

## 3b. The UI

The Collab V2 workspace is wired to the real server. Start the server as in
§2.2, then in a second terminal:

```bash
cd ~/Desktop/Projects/tm8/packages/ui
bunx vite --port 4611 --strictPort
```

Open **http://127.0.0.1:4611**.

You should see a dark banner reading **REAL SERVER** and a count of operations
this node has not built. That banner is the honesty surface — the panels behind
it are empty *on purpose* rather than filled with placeholder data, and it tells
you how many. If it says MOCK, the UI is running against its seeded fixture and
nothing you do touches Postgres.

What works end to end, driven from the browser:

1. real spaces and tasks render (sidebar counts are live `collections.query`)
2. create a task in the UI
3. **Spawn agent** on that task → a session appears with a real server-assigned id
4. prompt the session
5. progress lands in the task thread
6. complete the task

Verify it independently rather than trusting the screen — the same discipline
§2.3 uses:

```bash
curl -s $B/v2/entities/<TASK_ID> | j data.state.workStatus     # → done
curl -s $B/v2/entities/<TASK_ID> | j data.version              # → 2
```

**No terminal yet.** The session panel polls status every 1.5s and says so in
those words. This node exposes no `/pty` route, so there is no terminal output
to show — and an empty black rectangle implying a live-but-quiet stream would be
exactly the kind of confident-looking lie the rest of this document avoids.

**Things that will look broken and are not:** drag-to-reparent refuses
(`entities.move` is 501), and unread counts, `taskDoneCount` and channel auto-tabs
are permanently `0`/empty because the operations behind them are not built. The
UI knows which fields those are and prefers hiding an affordance to rendering a
confident zero, but where it does show one, that is why.

---

## 4. Running the test suites

```bash
cd /path/to/your/tm8/clone

bun run typecheck                                    # whole workspace, exit 0

cd packages/server   && bunx vitest run              # 237 passed
cd packages/execution && bunx vitest run             # 25 passed
cd packages/execution && bun run harness             # 5/5 — real PTY
cd packages/cli      && bunx vitest run              # 35 passed

# the database's own suite: RLS negatives, triggers, seq, ledger
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_cygnus \
  node db/test/run.mjs                               # 76 passed
```

Some server tests need a database; give them one with `TM8_DATABASE_URL`.

**Do not run `tools/ci/check.sh` yet.** It flips the conformance suite from
advisory to blocking whenever anything answers on :4610, which is a guaranteed
red while most of the catalog is still deliberately unbuilt.

---

## 5. When something goes wrong

| What you see | What it means |
|---|---|
| `implemented: 0` in the startup banner | No `TM8_DATABASE_URL`. Every operation will 501. |
| `501 not_implemented` | That operation genuinely is not built. Not an error — check §Scope. |
| `posix_spawnp failed` on spawn | node-pty's exec bit is missing, and `postinstall` did not run — you copied `node_modules` in, or installed with `--ignore-scripts`. Run `bash scripts/repair-node-pty.sh`. |
| `ECONNREFUSED` right after starting the server | The backgrounded server was reaped between shell invocations. Use the single command in §1, or run the server in its own window. |
| Server exits 0 silently, no output | You ran `dist/main.js`. Use `dist/index.js`. |
| `28000 no identity bound to this transaction` | The request reached the database with no identity claim. Should not happen on loopback; report it. |
| `401 account creation requires an authenticated node admin` on the very first call | You are serving from a database that already has accounts but no `owner`. The loopback owner is bootstrapped on the **zero-accounts first run** (guard F1); once other accounts exist, it will not mint itself. Most often this means you pointed the server at the database you just ran `db/test/run.mjs` against — that suite creates its own accounts. Use a separate database for the suite, or `reset --force` before serving. |
| `forbidden: spawning into an untrusted project` | Working as designed. Create the project with `"trust":"trusted"`. |
| `409 duplicate key … projects_working_dir_key` | `working_dir` is globally unique — two projects cannot share a directory, or a spawn's cwd would be ambiguous. |
| `400 request body failed contract validation` | The DTOs are `.strict()`. A misspelled or extra field is rejected rather than ignored. |

---

## 6. What is deliberately not built yet

So you can tell a gap from a bug. All of these answer an honest 501 or a typed
zero rather than pretending:

- `entities.create` covers **task**, **doc** and **team_member**. Every other
  kind answers a named 501 saying which kind, and that this node builds those
  three.
- `entities.{move,delete,restore,react,points.add}`, `edges.*`, `inbox`,
  `savedViews`, `actions.list`, and most of `spaces.*` beyond
  list/create/get/home are unregistered.
- Unread counts are hard `0`; `channel.autoTabs` is `[]`; `member.taskDoneCount`
  is `0`; `team_member.liveWork` is `null`.
- Live WebSocket push is not wired — `events.poll` is the delivery mechanism.
  Clients poll `?since=<seq>`.
- `workdir: {mode: "worktree"}` is **refused** with `not_implemented` rather
  than silently falling back to the project directory, because silently using
  the wrong directory is how an agent writes into the wrong tree.
- Security beyond loopback-only binding is deferred: no token auth, no CSRF,
  no Origin checks. Do not expose this to a network.
