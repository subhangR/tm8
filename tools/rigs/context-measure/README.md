# context-measure — the I10 lane measurement rig

Measures what a lane is sent and what it goes on to read, for the arms of
integrated design 01a0d348 §7 (task I10a 01a0d3b2-4106). Every number comes
from two files each lane already writes: its tm8 manifest and its Claude Code
transcript (`~/.claude/projects/<cwd-slug>/<native-session>.jsonl`).

**Run it only on a separate dev node. Never on the node that hosts your
sessions (7778).** Arms differ by node env (`TM8_HARNESS_SURFACE`,
`TM8_CONTEXT_INDEX`), so the node is restarted between arms.

| File | What it does |
|---|---|
| `fixture-data.mjs` | Fixture content: 7 tasks, each with ONE fact deep in one linked doc (past the derived header's reach), a stress task with 60 links, 10 skills, 8 memories. |
| `fixture.mjs` | Creates the fixture on the dev node (skills in the fixture repo, memories, docs, file, tasks and their edges). `REUSE`/`ONLY` recreate single tasks. |
| `replicate.mjs` | Copies real tasks and the links their launch recorded onto the dev node. Read-only on the source. |
| `headers.mjs` | Writes authored headers on the fixture docs (the "+index authored" pass). |
| `run-lane.mjs` | One lane: reset the task, spawn, wait for idle (or the first response with `--launch-only`), terminate, then measure and judge. Records `uptime` and the lane's own `tm8` binary. |
| `measure.mjs` | Per-lane bytes, first-request tokens, and expand, miss and blind-fetch counts. |
| `success.mjs` | Hidden checks at the committed head, `npm test`, closeout message, criteria ticked. |
| `summarize.mjs` | Per-arm median [min–max] tables. Misses are split into entry-level and header-level. |
| `derived-cut.mjs` | Offline: what a shorter derived header cut would save in the index. |
| `results/` | Raw per-lane rows (JSONL), one file per run. |

## Procedure

```sh
# 1. dev DB + build under test
psql postgres://tm8@127.0.0.1:5442/postgres -c 'create database tm8_i10a'
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_i10a node db/migrate.mjs up
bun install && bun run build

# 2. the dev node (env -i: no lane env may leak in). Use a REAL path, not /tmp:
#    skill paths refuse symlinks, and macOS /tmp is one.
env -i HOME=$HOME PATH=… TM8_ENV=dev TM8_DATA_DIR=/private/tmp/i10a/node TM8_PORT=4620 \
  TM8_BIND=127.0.0.1 TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_i10a TM8_LAUNCH_BOOTSTRAP=1 \
  TM8_HARNESS_SURFACE=minimal|inherit [TM8_CONTEXT_INDEX=on|off] node packages/server/dist/index.js
# claim it: POST /v2/auth/claim {token, username: "owner", password, displayName}

# 3. a CLI wrapper that targets the dev node (TM8_BASE_URL, TM8_AGENT_TOKEN, TM8_SPACE_ID
#    under env -i), then: space, fixture repo (git), project create + link,
TM8_CLI=./t8 PROJECT_ID=… REPO=… node fixture.mjs --out fixture.json

# 4. one lane (loop it per arm; serial or at most 2 at once)
TM8_CLI=./t8 node run-lane.mjs --arm lean --task-key fee --rep 1 --fixture fixture.json \
  --teammate <id> --project <id> --repo <fixture repo> --data-dir <node data dir> --out results.jsonl [--launch-only]

# 5. tables
node summarize.mjs results.jsonl --arms main,lean,index --set fixture|replica
```

## Definitions (§7.2)

- **Expand**: a Bash `tm8 entity context|get <id>`, `tm8 file download <id>`, `tm8 skill show <id>` or a Skill call on an entry of `manifest.context.entries`.
- **Miss**: a read of an id in `manifest.context.dropped`, or of a linked entity the index did not carry. Split:
  - ENTRY-level: the id was not in the prompt at all (`count-cap`, `byte-budget:entry`, not read at spawn).
  - HEADER-level: the entry was listed, but the 8 KiB cap trimmed its header.
- **Blind fetch**: an unpaged read of a collapsed entry over 20 KB.
- **Success**: the hidden checks pass at the lane's committed head, a closeout message was posted, and every criterion is ticked.

## Known limits

- About 12k of the harness tokens that `inherit` adds are not in the transcript (tool schemas). The first-request token count includes them, but the per-attachment chars cannot itemize them.
- The fixture A/B is a small N. It stands in for §7.2's week of live traffic, because the switch may not be flipped on a live node.
