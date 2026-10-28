# Using tools

Tools store reusable bash or Python source, typed inputs and help in your space. Every run has an inspectable session and exit code. Programs run on the node, so dependencies such as `curl`, `gh` and `python3` must be installed there.

## Install the starter set

From the repository root, with a CLI authenticated to your node:

```sh
bash examples/tools/install.sh --space <space-id>
tm8 tool list --limit 100
tm8 tool help gh-pr-status
```

The installer creates four new entities and supplies selection headers. It stops on errors, including a duplicate name. To install just one:

```sh
tm8 tool create url-check --runtime bash \
  --source @examples/tools/url-check/tool.sh \
  --spec @examples/tools/url-check/spec.json \
  --when-to-use 'Open when checking HTTP endpoint availability' \
  --summary 'Checks URL responses and exits nonzero on a failure'
```

The spec accepts `inputs`, `help`, `tm8Access` and `timeoutSeconds`; name, runtime, description and source are CLI arguments. Change a definition with `tm8 tool edit <name> --source @file --spec @spec.json --expect-version <version>` after inspecting `tm8 tool show <name>`.

Every definition edit is stored as its own version, even edits seconds apart by the same author; `tm8 entity versions <tool-id>` lists them. A run pins the tool's **execution version**, the stored version at which the source, runtime, inputs, access or timeout last changed, together with the sha256 of the source that ran. That is the `v<N>` in the run header and in run history, and `executionVersion` in `tm8 tool show`. Setting configuration or a secret, or editing only the name, description or help, stores a version but never moves the number runs pin. A stored version is a **definition version** when its execution version equals its own number; a **metadata edit** when its definition differs from the previous version but the execution version is unchanged (name, description or help); otherwise a **configuration write** (config set or unset, secret set or unset), whose definition is identical to the previous version. Version lists and diffs show definition versions by default, labelled `v<execution version>`, and the other rows behind an "all writes" toggle in the UI or `--all` in the CLI. Versions written before 2026-10-28 (migration 381) may have been folded by the former five-minute debounce, so an older run can name a version with no stored source; readers show "source unavailable" with the run's sha256, which still identifies what ran.

## Configure inputs and secrets

```sh
tm8 tool config set gh-pr-status repo owner/repository
tm8 tool config set gh-pr-status limit 20
tm8 tool config unset gh-pr-status limit
tm8 tool secret set gh-pr-status github_token
tm8 tool secret set slack-notify slack_webhook_url
```

Secret commands prompt without echo when stdin is a terminal. Run them as a human authenticated to the node; agents can use an allowed credential but cannot bind or write it. The UI configuration panel has a **Set secret** action and shows a hint instead of the value. You can also pipe a value to `secret set`. To supply a secret for one run, use `--github-token-from-env MY_GITHUB_TOKEN` or `--slack-webhook-url-from-env MY_SLACK_WEBHOOK`. The environment variable must already contain the value. Literal secret arguments are refused. Do not paste secrets into source, configuration for a public input, or shell history.

Run arguments override configured values, which override defaults. Required missing inputs refuse the run. A source edit preserves bindings; inspect the change notice before running a changed tool.

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

Attached runs print the session id and stream output; the CLI exits with the tool's code. `--detach` returns immediately. `--keep-open` leaves the terminal available for `tm8 session attach <session-id>` after completion. Close it with `exit` or `tm8 session terminate <session-id>`. Open tool shells count toward the eight-session cap.

| Starter | Dependencies | Inputs and behavior |
|---|---|---|
| `url-check` | bash, curl | `urls`: whitespace-separated HTTP(S) URLs; `timeout`: seconds per URL. Exit 0 for all 2xx/3xx final responses, 1 for any failure, 2 for no URLs. |
| `gh-pr-status` | bash, gh | `repo`, `state` (open/closed/merged/all), `limit` (1–200), secret `github_token`. Emits PR/CI JSON. |
| `space-digest` | python3 | `since`: exclusive event sequence, `format`: markdown/json. Reads the space event feed with its run token; reports event counts, task updates and merged PR events. |
| `slack-notify` | bash, curl, python3 | `text`, optional `channel`, secret `slack_webhook_url`. Sends JSON to the webhook. Slack may ignore channel overrides. |

`space-digest` runs from agent sessions and from human CLI/UI sessions alike; a human run gets a read token acting as the human, revoked on exit. Its event walk follows examined cursors (including skipped/filtered rows), stops when caught up, and is capped at 1000 pages. It summarises the retained feed; task entries show hydrated current status rather than a full historical transition log. The `through` sequence in JSON can be passed as the next `since`.

An agent can run the digest, inspect its output and pass the summary as `slack-notify --text`. The run wrapper adds terminal headers and footers, so extract the digest body before composing the notification.

## Run in the UI

Open a tool entity. Its page shows source, inputs, configuration and run history. Edit and save the definition or configure values, then choose **Run**. The dialog is generated from the inputs and prefilled from configured values; secrets are masked. Submitting opens the ordinary session terminal with a tool status chip. The terminal remains usable after exit with no idle auto-close. Close it when finished.

Live terminal output can include a secret printed by a program. The stored tail is redacted. The remaining shell has declared secret variables and tm8 agent identity removed. This environment cleanup is not an OS sandbox: tools run as the node user.

## Verify locally

Build the repository, then run the integration suite against a **test** Postgres cluster:

```sh
bun run build
cd packages/server
TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres \
  ./node_modules/.bin/vitest run --no-file-parallelism test/tools/tools-e2e.pg.test.ts
```

It creates and drops its own database, boots the production server, creates the starters via the CLI and exercises real PTYs. GitHub and Slack endpoints and credentials are synthetic; no external API is contacted.
