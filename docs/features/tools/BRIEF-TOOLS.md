# Using tools

Tools store reusable bash or Python source, typed inputs and help in your space. Every run has an inspectable session and exit code. Programs run on the node, so dependencies such as `curl`, `gh` and `python3` must be installed there.

## Install the starter set

Four starters ship with tm8: `url-check`, `gh-pr-status`, `space-digest` and `slack-notify`. The UI and the CLI offer the same set; it is data in `@tm8/contract`, generated from `examples/tools`.

```sh
tm8 tool starters list
tm8 tool starters install
tm8 tool starters install --only url-check --only space-digest
tm8 tool list
tm8 tool help gh-pr-status
```

`starters install` creates the starters your space does not have yet, sets their selection headers (when to use, summary) and skips every name that already exists; it never overwrites a tool. The result is one `created`, `skipped` or `failed` row per starter. `bash examples/tools/install.sh [--space <id>] [--only <name>]` is a thin wrapper over the same command. To build your own tool on a starter:

```sh
tm8 tool create my-check --from-starter url-check \
  --source @./my-check.sh --description 'Checks our endpoints' \
  --when-to-use 'Open when checking our endpoints' --summary 'URL checks for our services'
```

The name and every option you pass override the starter's values; `--spec` fields replace the starter's one by one. To write one from scratch:

```sh
tm8 tool create url-check --runtime bash \
  --source @examples/tools/url-check/tool.sh \
  --spec @examples/tools/url-check/spec.json \
  --when-to-use 'Open when checking HTTP endpoint availability' \
  --summary 'Checks URL responses and exits nonzero on a failure'
```

The spec accepts `inputs`, `help`, `tm8Access` and `timeoutSeconds`; name, runtime, description and source are CLI arguments. Change a definition with `tm8 tool edit <name> --source @file --spec @spec.json --expect-version <version>` after inspecting `tm8 tool show <name>`.

## Create in the UI

**New tool** is offered in the New tab, in the Tools list header and in the command palette. The form has the fields of the tool page's editor (name, description, runtime, source, inputs, help, tm8 access, timeout) plus **Start from a starter**, which prefills every field from one of the four starters and leaves them editable, and **When to use** and **Summary**, the selection header agents read when they look for a tool. A validation error from the server appears next to the field it names. The Tools list also offers **Install starter tools**, which does what `tm8 tool starters install` does. On success the new tool opens.

## Versions and diffs

Every definition edit is stored as its own version; runs pin the execution version plus the source sha256; configuration, secret and name/description/help writes never move the pinned number. So a tool has an entity version that counts every write (the number `--expect-version` takes) and an execution version, the definition version its runs record as `toolVersion`; `tm8 tool show` prints both, and the `tm8 tool list` and `tm8 tool runs` tables print the execution version.

```sh
tm8 tool versions url-check
tm8 tool versions url-check --all
tm8 tool diff url-check
tm8 tool diff url-check --from 2 --to 4
```

`versions` lists the definition versions newest first: who changed the tool, when, which fields changed since the previous definition version (`source`, `inputs`, `help`, `config`, `secrets`, ...) and the first digits of the source digest that `tm8 tool runs` shows per run. `--all` lists every stored write, including configuration and secret writes, each labelled by what changed and by the definition version it pins. `diff` prints a unified diff of the source, by default between the two newest definition versions; `--from` and `--to` may name any stored write. The tool page's **Versions** section shows the same list, with an "all writes" toggle, and the same diff.

The rule the UI and the CLI share: a stored version is a definition version when `snapshot.content.execution_version` equals its own `version`; a metadata edit when its `content.definition` differs from the previous row but the execution version is unchanged; otherwise a configuration write, whose definition is identical to the previous row. Every definition edit since migration 381 (2026-10-28) satisfies the first clause. Only for rows older than that migration does a fallback apply: such a row is a definition version when its source, runtime, inputs, tm8 access or timeout differ from the next older stored write, because before 381 the pinned number counted separately. Versions written before migration 381 may also have been folded: several edits by the same author within five minutes stored one snapshot, so that history keeps gaps and a run from that time may pin a version with no stored row. `versions --all` prints a note when a page skips numbers; `diff` refuses a folded version by name and lists the nearest stored ones. Tools PR-F (task `01a183cd-bf62-7272-a1c7-ee1f45cebf55`) is the migration that ended the folding.

## Configure inputs and secrets

```sh
tm8 tool config set gh-pr-status repo owner/repository
tm8 tool config set gh-pr-status limit 20
tm8 tool config unset gh-pr-status limit
tm8 tool secret set gh-pr-status github_token
tm8 tool secret set slack-notify slack_webhook_url
```

Secret commands prompt without echo when stdin is a terminal. Run them as a human authenticated to the node; agents can use an allowed credential but cannot bind or write it. The UI configuration panel has a **Set secret** action and shows a hint instead of the value. You can also pipe a value to `secret set`. To supply a secret for one run, use `--github-token-from-env MY_GITHUB_TOKEN` or `--slack-webhook-url-from-env MY_SLACK_WEBHOOK`. The environment variable must already contain the value. Literal secret arguments are refused. Do not paste secrets into source, configuration for a public input, or shell history.

Run arguments override configured values, which override defaults. Required missing inputs refuse the run, and a value outside a declared range is refused with the range (`limit must be between 1 and 200`). A source edit preserves bindings; inspect the change notice before running a changed tool.

## Run from the CLI

Run/global options go before the tool name; arguments after the name belong to that tool:

```sh
tm8 tool run url-check --urls 'https://example.com https://example.org' --timeout 10
tm8 tool run gh-pr-status --repo owner/repository --state open --limit 20
tm8 tool run space-digest --since 0 --format markdown
tm8 tool run slack-notify --text 'Build complete' --channel '#build'
tm8 tool run --detach url-check --urls 'https://example.com'
tm8 tool run-show <session-id> --output
tm8 tool runs url-check --limit 50
```

Attached runs print the session id and stream output; the CLI exits with the tool's code. `--detach` returns immediately. `--keep-open` leaves the terminal available for `tm8 session attach <session-id>` after completion. Close it with `exit` in that shell or with `tm8 session terminate <session-id> --yes`. Open tool shells count toward the eight-session cap.

`tm8 tool list` and `tm8 tool runs <name>` print tables (name, runtime, version, access, last run; id, status, exit, duration, invoker, started) and never a tool's source. Add `--format json` for the complete records, including source and output tails.

| Starter | Dependencies | Inputs and behavior |
|---|---|---|
| `url-check` | bash, curl | `urls`: whitespace-separated HTTP(S) URLs; `timeout`: seconds per URL. Exit 0 for all 2xx/3xx final responses, 1 for any failure, 2 for no URLs. |
| `gh-pr-status` | bash, gh | `repo`, `state` (open/closed/merged/all), `limit` (1–200), secret `github_token`. Emits PR/CI JSON. |
| `space-digest` | python3 | `since`: exclusive event sequence, `format`: markdown/json. Reads the space event feed with its run token; reports event counts, task updates and merged PR events. |
| `slack-notify` | bash, curl, python3 | `text`, optional `channel`, secret `slack_webhook_url`. Sends JSON to the webhook. Slack may ignore channel overrides. |

`space-digest` runs from agent sessions and from human CLI/UI sessions alike; a human run gets a read token acting as the human, revoked on exit. Its event walk follows examined cursors (including skipped/filtered rows), stops when caught up, and is capped at 1000 pages. It summarises the retained feed; task entries show hydrated current status rather than a full historical transition log. The `through` sequence in JSON can be passed as the next `since`.

An agent can run the digest, inspect its output and pass the summary as `slack-notify --text`. The run wrapper adds terminal headers and footers, so extract the digest body before composing the notification.

## Where a tool runs

A run's working directory is the invoking session's cwd (an agent, or the CLI inside a session). A human with no invoking session (the UI, or the CLI as the node's loopback owner) gets a per-tool scratch directory, `<dataDir>/tool-workspaces/<identity>/<tool>`. `--cwd` may name only a directory inside the session cwd, that scratch directory, or a path grant; anything else is refused with `Tool path is outside the invoking session cwd and path grants`.

## Run on a schedule

A loop whose action is `tool` runs a tool on its schedule. Choose the tool and its input values when you create the loop, and the persona the run acts as (required when the tool's tm8 access is `read` or `write`). Each firing is an ordinary run in the tool's history, attributed to the loop, with the shell closed on exit. A nonzero exit is a completed run with that code, not a loop failure. A firing the server refuses (stale or renamed inputs, a missing persona, the eight-session cap, an unavailable credential, a failed launch) becomes the loop's last error and the schedule advances. Details are in [SCHEDULED-RUNS.md](SCHEDULED-RUNS.md).

## Python dependencies

Python tools run with the node's `/usr/bin/python3 -I` and its system site-packages. There is no virtualenv and no per-tool package list: a module must be installed on the node for every tool that imports it, and a tool that imports a missing module exits 1 with the traceback in the terminal and in the stored output tail. The starters use only the standard library.

## When a run fails

| What happened | What you see |
|---|---|
| Missing Python module | the traceback in the terminal and in the output tail; the run is `exited 1`; the CLI exits 1 |
| `timeoutSeconds` reached | the process is killed (`timeout --foreground -k 10`); the run is `timed_out`; the CLI exits 124, or 137 when the hard kill was needed |
| Ninth live tool shell | refused before launch with `limit_exceeded`: "Tool session cap of 8 reached; idle keep-open shells count ..."; close one with `tm8 session terminate <id> --yes` and retry |
| Launch failed on the node | HTTP 503 `upstream_unavailable` "Tool launch failed"; the run is recorded as `killed` with its token revoked and stays in the history |
| Literal secret on argv | refused before launch, CLI exit 2: `Secret token cannot be passed on argv; use --token-from-env <VAR> or a TTY prompt` |
| Value outside a declared range | refused before launch, CLI exit 2: `limit must be between 1 and 200` |
| Missing required input | refused before launch, CLI exit 2: `Missing required inputs: ...` |
| Definition changed since you loaded it | `version_conflict`, CLI exit 6; load the tool again and rerun |
| Write under a read token | the API answers 403 `This tool run token permits read operations only`; the tool decides whether that is fatal |

## Run in the UI

Open a tool entity. Its page shows source, inputs, configuration, versions and run history. Edit and save the definition or configure values, then choose **Run**. The dialog is generated from the inputs and prefilled from configured values; secrets are masked, and a refused run shows the server's message (a missing input, the session cap, a launch failure). Submitting opens the ordinary session terminal with a tool status chip. The terminal remains usable after exit with no idle auto-close. Close it when finished. Each row of the run history opens its terminal or its stored output.

The live terminal stream and the stored tail both redact a secret's whole value as `[credential-redacted]`. Matching is by whole value only: a program that prints part of a secret or a transformation of it (`${TOKEN:0:6}`) prints it in the clear. The remaining shell has declared secret variables and tm8 agent identity removed. This environment cleanup is not an OS sandbox: tools run as the node user.

## Verify locally

Build the repository, then run the integration suite against a **test** Postgres cluster:

```sh
bun run build
cd packages/server
TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres \
  ./node_modules/.bin/vitest run --no-file-parallelism test/tools/tools-e2e.pg.test.ts
```

It creates and drops its own database, boots the production server, creates the starters via the CLI and exercises real PTYs. GitHub and Slack endpoints and credentials are synthetic; no external API is contacted.
