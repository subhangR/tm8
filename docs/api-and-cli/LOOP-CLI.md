# Loop CLI surface

A loop is scheduled work: a schedule (`every <n>{m|h|d}` or a 5-field cron read
on the wall clock of an IANA timezone) and an action. The action can spawn a
teammate, dispatch, or run a stored tool. Every `tm8 loop` verb is one `loops.*`
operation. The server owns all schedule state: the next run, the preview and
the identity a firing acts as. The CLI never computes them and never writes loop
fields through `entities.*`. Design of record: doc `01a182d4` §5.
`tm8 help loop --format json` describes the command surface.

| CLI command | Catalog operation |
| --- | --- |
| `loop create <title> --schedule <expr> (--teammate <id\|name> \| --dispatch \| --tool <name\|id>) [create flags]` | `loops.create` |
| `loop list [--enabled \| --disabled] [--action spawn\|dispatch\|tool] [--words <text>] [--limit <count>] [--cursor <cursor>]` | `loops.list` |
| `loop show <id\|title>` | `loops.get` |
| `loop edit <id\|title> --expect-version <n> [--title <text>] [create flags] [--clear-subject] [--clear-tool]` | `loops.update` |
| `loop enable\|disable\|resume <id\|title> --expect-version <n>` | `loops.enable` / `loops.disable` / `loops.resume` |
| `loop pause <id\|title> --until <iso\|+<n>{m\|h\|d}> --expect-version <n>` | `loops.pause` |
| `loop run-now <id\|title> [--force]` | `loops.runNow` |
| `loop runs <id\|title> [--status <status>] [--limit <count>] [--cursor <cursor>]` | `loops.runs.list` |
| `loop run-show <run-id>` | `loops.runs.get` |
| `loop stop <run-id>` | `loops.runs.stop` |
| `loop preview --schedule <expr> [--timezone <iana>] [--count <n>]` | `loops.schedule.preview` |

`tm8 entity delete <id>` deletes a loop. `tm8 entity create loop` keeps working.

## Create and edit flags

| Flag | Definition field |
| --- | --- |
| `--schedule <expr>`, `--timezone <iana>` (default `UTC`) | `schedule`, `timezone` |
| `--teammate <id\|name>` | `action: spawn`, `teamMemberId` |
| `--dispatch` | `action: dispatch` |
| `--tool <name\|id>`, `--input <name>=<value>`… | `action: tool`, `toolId`, `toolInputs` |
| `--subject <entity-id>` / `--clear-subject` | `subjectId` |
| `--prompt <text\|@file\|->` | `prompt` |
| `--model`, `--agent-tool`, `--reasoning-effort`, `--access-mode`, `--mode`, `--launch-project`, `--workdir project\|worktree\|scratch` (+ `--base-ref`), `--memory <id>`…, `--credential-source member\|space\|node`, `--interaction-profile <id>` | `config` (spawn and dispatch loops only) |
| `--concurrency skip\|queue`, `--max-runtime <seconds>` | `concurrency`, `maxRuntimeSeconds` |
| `--retry <n>`, `--retry-delay <seconds>` | `retry.attempts`, `retry.delaySeconds` (either alone is a partial policy) |

Names resolve exactly within the current Space, and IDs work directly:
`--teammate` matches a team member's name case-insensitively and `--tool` a
tool's definition name. A loop reference matches the exact title, and two loops
with that title are a usage error that lists both IDs. Each `--input` value that
parses as JSON keeps its type (`limit=5` is a number), and anything else stays a
string. The server checks inputs against the tool's declared inputs.

`edit` sends only the fields its flags name, and the server keeps the rest.
Header flags (`--when-to-use`, `--summary`, repeatable `--keyword`) are
accepted by `create` only. They set the universal selection header after the
create through `entities.header.set`, exactly like `tm8 tool create`. Change a
header later with `tm8 entity header set`.

`--credential-source` takes one source for every provider. The per-provider
`<provider>=<source>` spelling of `tm8 session spawn` is refused.

## Output and exit codes

Every verb prints human text by default and the operation's DTO with
`--format json`: a `LoopView` for the definition and control verbs, `{ run }` for
`run-now` and `stop`, and a `{ items, nextCursor }` page for `list` and `runs`.
`run-now` and `run-show` print the run's task and session ids and a
`tm8 session transcript <session-id>` hint.

| Exit | Meaning |
| --- | --- |
| 0 | success |
| 2 | usage error caught locally (missing `--schedule`, `--expect-version`, conflicting runner flags, bad enum), or `preview` of an invalid schedule (the problem is printed) |
| 5 | the named loop, teammate or tool was not found |
| server codes | `invalid_input` (field path in details), `version_conflict`, `loop_run_overlap`, `forbidden`, `not_implemented` map through the CLI's usual error table |

Mutations accept `--mutation-id`. Re-run a timed-out write with the same id,
because it was usually stored. `edit`, `enable`, `disable`, `pause` and
`resume` require `--expect-version` (read the version with `tm8 loop show`).
`run-now` and `stop` act on a run, not on the definition, and take no version.

## Example

```sh
tm8 loop preview --schedule '0 2 * * *' --timezone Europe/London
tm8 loop create 'Nightly triage' --schedule '0 2 * * *' --timezone Europe/London \
  --teammate 'Opus 5.5 1M Teammate' --prompt @triage.md --workdir worktree
tm8 loop pause 'Nightly triage' --until +2d --expect-version 2
tm8 loop runs 'Nightly triage' --status failed
```
