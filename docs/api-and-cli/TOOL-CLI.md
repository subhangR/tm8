# Tool CLI surface

Tools are versioned bash or python scripts with declared inputs, configuration,
secret bindings, and recorded terminal runs. `tm8 help tool --format json`
describes the command surface; `tm8 tool help <name|id>` describes an individual
tool. Names resolve exactly within the current Space, while IDs work directly.

| CLI command | Catalog operation |
| --- | --- |
| `tool create <name> --runtime bash\|python --source @file [--spec @file] [--description <text>]` | `tools.create` |
| `tool create [<name>] --from-starter <starter> [overrides]` | `tools.create`, `entities.header.set` |
| `tool starters list` | `tools.list` |
| `tool starters install [--only <name>...]` | `tools.list`, `tools.create`, `entities.header.set` |
| `tool edit <name\|id> [--source @file] [--spec @file] [--runtime bash\|python] [--description <text>] --expect-version <n>` | `tools.update` |
| `tool show <name\|id> [--source]` | `tools.get` |
| `tool list [--words <text>] [--limit <count>] [--cursor <cursor>]` | `tools.list` |
| `tool help <name\|id>` | `tools.help` |
| `tool versions <name\|id> [--all] [--limit <count>] [--cursor <cursor>]` | `entities.versions` |
| `tool diff <name\|id> [--from <version>] [--to <version>]` | `entities.versions` |
| `tool config set <name\|id> <input> <value>` | `tools.config.set` |
| `tool config unset <name\|id> <input>` | `tools.config.unset` |
| `tool secret set <name\|id> <input> [--value-stdin \| --credential-id <id>] [--label <text>]` | `tools.secrets.bind` |
| `tool secret unset <name\|id> <input>` | `tools.secrets.unbind` |
| `tool run [run options] <name\|id> [tool arguments]` | `tools.run` |
| `tool runs <name\|id> [--limit <count>] [--cursor <cursor>]` | `tools.runs.list` |
| `tool run-show <session-id> [--output]` | `tools.runs.get` |

The spec JSON contains `inputs`, `help`, `tm8Access`, and `timeoutSeconds`.
Omitted fields default to an empty input list/help, `tm8Access: "none"`, and
900 seconds. Edits preserve fields omitted from the spec. Source and spec
are file references, with `@` preceding the path. Creation also accepts
`--when-to-use`, `--summary`, and repeatable `--keyword`; these set the universal
selection header after creation through `entities.header.set`.

Mutations accept `--mutation-id`. Editing requires `--expect-version`.
Config and secret mutations accept an explicit `--expect-version`, or use the
version just loaded. A run always sends that loaded version and refuses a
concurrent change. A notice on stderr identifies the author and time when the
source changed since this caller's last run.

Every command renders from the same DTO that `--format json` prints. In human
format, `tool list` is a table (name, runtime, version, access, last run) and
`tool runs` is a table (id, status, exit, duration, invoker, started); neither
prints a tool's source. A further page ends with a `more:` line holding the
cursor to pass. `--format json` prints the complete records.

## Starters

The CLI ships the same four starter tools the UI offers (`url-check`,
`gh-pr-status`, `space-digest`, `slack-notify`). They are data in
`@tm8/contract` (`TOOL_STARTERS`, generated from `examples/tools/*`; a test
fails when the two drift), so nothing is read from a repository path at run
time and no catalog operation exists for them.

```bash
tm8 tool starters list
tm8 tool starters install
tm8 tool starters install --only url-check --only space-digest
tm8 tool create --from-starter url-check
tm8 tool create my-check --from-starter url-check --source @./my-check.sh --description 'Mine'
```

`starters list` prints one row per starter: name, runtime, whether a tool of
that name exists in this Space (`exists v3`, with `(other source)` when its
source differs from the starter's, or `not installed`) and the description.
`--format json` prints every starter in full, including source and spec.

`starters install` creates the starters this Space does not have yet and sets
each one's selection header (when to use, summary). A name that already exists
is skipped, never overwritten, including a name taken between the listing and
the create. `--only` narrows the set; it is repeatable or comma-separated, and
an unknown name is refused before any call. The result is one
`created | skipped | failed` row per starter and a count line; a refused create
does not stop the others, and the exit code is the first refusal's. Creates use
`<mutation-id>:<starter>` and headers `<mutation-id>:<starter>:header`, so a
retry with the same `--mutation-id` never duplicates. A header that could not
be set is a warning on stderr: the tool exists without its when-to-use and
summary. `examples/tools/install.sh` is a thin wrapper that passes its
arguments to this command.

`create --from-starter <starter>` starts from the starter's definition and
header. The name argument, `--runtime`, `--source`, `--description`,
`--when-to-use`, `--summary` and `--keyword` override the starter's values when
given, and `--spec` fields replace the starter's one by one (an omitted spec
field keeps the starter's). Without a name argument the tool takes the
starter's name.

## Versions and diff

Each tool is a versioned entity; the stored snapshots (`entities.versions`)
carry the definition as of that version, so no `tools.*` operation is needed.
Two numbers matter. The **entity version** counts every write (definition,
configuration, secret binding, name/description/help) and is the concurrency
token `--expect-version` and a run send. The **execution version** is the
definition version a run pins as `toolVersion`: every definition edit is stored
as its own version; runs pin the execution version plus the source sha256;
configuration, secret and name/description/help writes never move the pinned
number. `tool show` prints both (`version`, `executionVersion`); the `tool
list` and `tool runs` tables print the execution version.

```bash
tm8 tool versions url-check
tm8 tool versions url-check --all --limit 20
tm8 tool diff url-check
tm8 tool diff url-check --from 3 --to 7
tm8 tool diff url-check --from v3 --format json
```

`versions` lists **definition versions** by default, newest first: the stored
writes a run can pin, labelled by their version (`v7`), with when, who (agents
marked `(agent)`), the fields that differ from the next older definition
version (`name`, `description`, `runtime`, `source`, `inputs`, `help`,
`tm8Access`, `timeoutSeconds`, plus `config` and `secrets`) and the first twelve
hex digits of the source's sha256, the digest every run pins. The rule the UI
and the CLI share: a stored version is a definition version when
`snapshot.content.execution_version` equals its own `version`; a metadata edit
when its `content.definition` differs from the previous row but the execution
version is unchanged; otherwise a configuration write, whose definition is
identical to the previous row. Only for writes older than migration 388
(2026-10-28) does a fallback apply: such a row is a definition version when its
executable fields (source, runtime, inputs, tm8Access, timeoutSeconds) differ
from the next older stored write, because before 388 the pinned number counted
separately. The whole history is read; `--limit` caps the rows shown, a
`hidden:` line counts the configuration and metadata writes left out, and
`--cursor` is refused.

`--all` lists every stored write instead, one Server page at a time with
`--limit` and `--cursor`: configuration, secret and name/description/help
writes appear labelled by what changed and by the definition version they pin
(`definition v4`) in place of the digest. The oldest row of a page is compared
with the first snapshot past the page. `--format json` prints per row
`version`, `executionVersion`, `definition` (whether a run can pin it),
`changed`, `previousVersion`, `configRevision`, the full `sourceSha256`, who and
when, plus the tool's `currentVersion` and `currentExecutionVersion`.

`diff` prints `diff -u` text of `definition.source` between two versions.
`--to` defaults to the newest definition version and `--from` to the definition
version just before it. An explicit `--from` or `--to` may name any stored
write, so a configuration write diffs as no source change. When the source did
not change the output says so and names the other changed fields. `--format
json` carries both version references (version, execution version, definition
flag, who, when, source digest), every changed field and the diff as one
string; it is empty when the sources are identical.

Versions written before migration 388 may have been folded: rapid
edits by one author within five minutes stored one snapshot, and that history
keeps its gaps (a run's `toolVersion` from that time may name no stored row).
`versions --all` prints a note when a page skips numbers; `diff` refuses a
version without a snapshot by name, with the nearest stored versions, and exits
5, as it does for a tool with a single stored definition version. Tools PR-F
(task `01a183cd-bf62-7272-a1c7-ee1f45cebf55`) is the migration that ended the
folding.

## Running and help

Run options go **before the tool name**: `--detach`, `--keep-open`, `--close`,
`--cwd <dir>`, `--mutation-id`, and global options such as `--format`, `--space`,
and `--timeout <seconds>` (the HTTP request timeout).
Every token after the name belongs to the tool, even a flag named `--format`
or `--timeout`. Its declared inputs determine types, enum choices, long flags,
and single-letter short flags. Bool inputs use `--draft` or `--no-draft`.
Inputs use explicit CLI values, configured values, then declared defaults.
Missing required inputs are refused. JSON inputs accept JSON text. A value
outside a declared range is refused with the range (`limit must be between 1
and 200`); the diagnostic never repeats the value given.

```bash
tm8 tool run --cwd /allowed/project gh-pr-status --repo owner/repo -l 10
tm8 tool run gh-pr-status --help
tm8 tool run --detach --format json gh-pr-status --repo owner/repo
```

Per-tool help lists input types, required/default/configured status, enum
choices, secret input methods, descriptions, and the tool's help text.
`tm8 tool run --help` describes the run command itself.

Attached mode uses human format. It prints the session ID first, streams the
terminal, then exits with the tool's recorded process exit code (including
codes outside the CLI error table). Stdin is forwarded to the terminal; raw
mode is used only when both stdin and stdout are TTYs. A fast run that ends
before attachment prints its stored, redacted output tail. `--detach` returns
the session ID immediately, and supports human, JSON, or JSONL format.
Tool exit codes can coincide with CLI error codes (2, 4, 5, 6, and 10); the
session ID printed first and `tool run-show` distinguish those outcomes.

By default the server closes the PTY when the tool exits (`keepOpen=false`).
`--close` explicitly selects that default. `--keep-open` leaves the terminal's
shell open on the server; the CLI still returns when the tool itself finishes.
These two options are mutually exclusive. Inspect a run with `tool run-show`
and its output with `--output`. Close an open shell with
`tm8 session terminate <session-id> --yes`.
`tool runs` lists a tool's runs newest first; `--cursor` continues with older
runs. Each run names its invoker, and a run fired by a loop also names that loop.

`--cwd` must lie inside the invoking session's working directory or a path
grant. A human with no invoking session (the UI, or the CLI as the loopback
owner) can use only the per-tool scratch directory
`<dataDir>/tool-workspaces/<identity>/<tool>` or a path grant; anything else is
refused with `Tool path is outside the invoking session cwd and path grants`.

## Secrets

Binding or unbinding credentials is enforced as human-only by the server.
`tool secret set` reads a value from stdin (optionally with `--value-stdin`),
or from a hidden TTY prompt. `--credential-id` binds an existing credential
instead; it cannot be combined with `--value-stdin`.

At run time use `--<input>-from-env <VAR>` to read the value of the named
environment variable. Required secrets without a binding or env reference
prompt on a TTY; a noninteractive caller must provide an env reference.
Literal secret values, including short flags and `--flag=value`, are refused.
Values travel only in the authenticated request body. The CLI does not print
them, and dynamic run/config/secret arguments are omitted from its command
journal so even a refused literal cannot be recorded there.

The CLI's attached stream and the stored output tail both redact a secret's
whole value (`[credential-redacted]`); the session terminal in the UI shows the
program's raw output while its shell is open. Matching is by whole value only: a program that
prints part of a secret or a transformation of it (`${TOKEN:0:6}`) prints it
unredacted.

```bash
tm8 tool secret set gh-pr-status github_token --value-stdin < /secure/token
tm8 tool run gh-pr-status --github-token-from-env GITHUB_TOKEN --repo owner/repo
```
