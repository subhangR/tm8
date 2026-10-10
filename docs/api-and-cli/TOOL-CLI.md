# Tool CLI surface

Tools are versioned bash or python scripts with declared inputs, configuration,
secret bindings, and recorded terminal runs. `tm8 help tool --format json`
describes the command surface; `tm8 tool help <name|id>` describes an individual
tool. Names resolve exactly within the current Space, while IDs work directly.

| CLI command | Catalog operation |
| --- | --- |
| `tool create <name> --runtime bash\|python --source @file [--spec @file] [--description <text>]` | `tools.create` |
| `tool edit <name\|id> [--source @file] [--spec @file] [--runtime bash\|python] [--description <text>] --expect-version <n>` | `tools.update` |
| `tool show <name\|id> [--source]` | `tools.get` |
| `tool list [--words <text>] [--limit <count>] [--cursor <cursor>]` | `tools.list` |
| `tool help <name\|id>` | `tools.help` |
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

## Running and help

Run options go **before the tool name**: `--detach`, `--keep-open`, `--close`,
`--cwd <dir>`, `--mutation-id`, and global options such as `--format`, `--space`,
and `--timeout <seconds>` (the HTTP request timeout).
Every token after the name belongs to the tool, even a flag named `--format`
or `--timeout`. Its declared inputs determine types, enum choices, long flags,
and single-letter short flags. Bool inputs use `--draft` or `--no-draft`.
Inputs use explicit CLI values, configured values, then declared defaults.
Missing required inputs are refused. JSON inputs accept JSON text.

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
and its output with `--output`. Close an open shell through `session terminate`.

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

```bash
tm8 tool secret set gh-pr-status github_token --value-stdin < /secure/token
tm8 tool run gh-pr-status --github-token-from-env GITHUB_TOKEN --repo owner/repo
```
