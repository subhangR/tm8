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

**Postgres 18 must be running on port 5442.** It is not on your PATH by default:

```bash
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH pg_isready -h 127.0.0.1 -p 5442
# → 127.0.0.1:5442 - accepting connections
```

If it is not running, start it:

```bash
PATH=/opt/homebrew/opt/postgresql@18/bin:$PATH \
  pg_ctl -D ~/.tm8-dev/pg -l ~/.tm8-dev/pg.log \
  -o "-p 5442 -c listen_addresses=127.0.0.1" start
```

**On a fresh clone, and after any `bun install` or `bun add`, repair node-pty.**
This is not optional and it is the first thing a new machine trips over: bun
extracts npm tarballs without the executable bit, so `spawn-helper` lands at
0644 and **every PTY spawn dies with `posix_spawnp failed`** — which surfaces
as "spawning is broken" rather than as an install problem. The prebuilt
binaries survive; only the mode bit is lost.

```bash
cd ~/Desktop/Projects/tm8
bun install
bash scripts/repair-node-pty.sh
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
cd ~/Desktop/Projects/tm8
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

## 4. Running the test suites

```bash
cd ~/Desktop/Projects/tm8

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
| `posix_spawnp failed` on spawn | A `bun install` stripped node-pty's exec bit. Run `bash scripts/repair-node-pty.sh`. |
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
