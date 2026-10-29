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
| `loop create <title> --schedule <expr> (--teammate <id\|name> \| --dispatch \| --tool <name\|id> [--teammate <persona>]) [create flags]` | `loops.create` |
| `loop list [--enabled \| --disabled] [--action spawn\|dispatch\|tool] [--words <text>] [--limit <count>] [--cursor <cursor>]` | `loops.list` |
| `loop show <id\|title>` | `loops.get` |
| `loop edit <id\|title> --expect-version <n> [--title <text>] [create flags] [--clear-tool] [--clear-inputs]` | `loops.update` |
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
| `--tool <name\|id>` (+ `--teammate <persona>`), `--input <name>=<value>`… | `action: tool`, `toolId`, `teamMemberId` (the persona the tool runs as), `toolInputs` |
| `--subject <entity-id\|none>` | `subjectId` (`none` clears it) |
| `--prompt <text\|@file\|->` | `prompt` |
| `--model`, `--agent-tool`, `--reasoning-effort`, `--access-mode`, `--mode`, `--launch-project`, `--workdir project\|worktree\|scratch` (+ `--base-ref` for a worktree), `--memory <id>`…, `--credential-source member\|space\|node`, `--interaction-profile <id>` | `config` (spawn and dispatch loops only; on `edit` each takes `none` to unset it) |
| `--concurrency skip\|queue`, `--max-runtime <seconds\|none>` (60–86400) | `concurrency`, `maxRuntimeSeconds` (`none` is no limit) |
| `--retry <n>` (0–5), `--retry-delay <seconds>` (30–3600) | `retry.attempts`, `retry.delaySeconds` (either alone is a partial policy) |

Names resolve exactly within the loop's Space (the current Space for
`create`), and IDs work directly: `--teammate` matches a team member's name
case-insensitively and `--tool` a tool's definition name. A loop reference
matches the exact title (surrounding spaces ignored, as the server stores titles
trimmed), and two loops with that title are a usage error that lists both IDs.

`--input <name>=<value>` is typed by the tool's declared input, with the same
parse `tm8 tool run` uses: `limit=5` is a number for an `int` input and `ref=1234`
stays a string for a `string` one. An undeclared name or a value of the wrong
type is a usage error. A secret input is refused: a loop's definition is
readable by every member of the Space, so a secret reaches a loop's runs only
through the tool's own binding (`tm8 tool secret set <tool> <input>`); a required
secret with no binding is a warning. Every required input needs a value unless
the tool's config or the input's default covers it.

A tool loop runs as a persona. With `--tool`, `--teammate` names that persona.
One is required when the tool reaches tm8 (`tm8Access` read or write); the CLI
refuses the write without it, as the server does. On `edit` of a tool loop,
`--teammate` alone changes the persona and keeps the action. `--teammate` with
`--clear-tool` turns the loop into a spawn loop (`--clear-tool` alone is
refused). `--dispatch` takes neither flag. It clears the loop's teammate and
tool, because the Dispatcher picks the runner and the server refuses a dispatch
loop that names one.

Changing what runs clears what belonged to the old runner. A loop that stops
being a tool loop loses its inputs. A loop that becomes one loses its launch
config and runs as the persona `--teammate` names (or none), never the spawn
teammate it had. A new tool starts from no inputs.

`edit` sends only the fields its flags name, and the server keeps the rest. Two
fields are whole objects the server replaces on update, so `edit` overlays the
flags on the stored object and sends the result: a launch flag changes its one
setting in `config` (`none` unsets it), and `--input` changes its one input
while the tool stays (`--clear-inputs` starts from none). `--base-ref` alone
retimes a stored worktree; a `--workdir` change keeps the stored base ref only
while the loop stays on a worktree. Header flags (`--when-to-use`, `--summary`, repeatable `--keyword`) are
accepted by `create` only and checked before anything is written. They set the
universal selection header after the create through `entities.header.set`,
exactly like `tm8 tool create`. If that step fails, the error names the loop
the create made: set the header with `tm8 entity header set <id>`, or re-run the
create with the same `--mutation-id` (a fresh create makes a second loop).
Change a header later with `tm8 entity header set`.

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
| 2 | usage error caught locally (missing `--schedule`, `--expect-version`, conflicting runner flags, bad enum, a value outside the contract's range, a mistyped or secret `--input`), or `preview` of an invalid schedule (the problem is printed) |
| 5 | the named loop, teammate or tool was not found |
| server codes | `invalid_input` (field path in details), `version_conflict` (exit 6), `conflict` (a run-now refused because a run is still live: reason `loop_run_overlap`; `--force` fires anyway), `forbidden`, `not_implemented` map through the CLI's usual error table |

Mutations accept `--mutation-id`. Re-run a timed-out write with the same id,
because it was usually stored. `edit`, `enable`, `disable`, `pause` and
`resume` require `--expect-version` (read the version with `tm8 loop show`).
A loop's version also moves each time it fires, so a `version_conflict` on a
busy loop usually means it just fired: read it again and retry. `run-now` and
`stop` act on a run, not on the definition, and take no version.

`pause --until` takes an ISO instant with its offset (`2026-11-02T09:00:00Z` or
`…+01:00`) or `+<n>{m|h|d}`. An instant without an offset, or a date that does
not exist, is refused rather than guessed; the server bounds the result to
after now and within 365 days. A pause that has run out reads as `enabled`.

## Example

```sh
tm8 loop preview --schedule '0 2 * * *' --timezone Europe/London
tm8 loop create 'Nightly triage' --schedule '0 2 * * *' --timezone Europe/London \
  --teammate 'Opus 5.5 1M Teammate' --prompt @triage.md --workdir worktree
tm8 loop pause 'Nightly triage' --until +2d --expect-version 1
tm8 loop runs 'Nightly triage' --status failed
```
