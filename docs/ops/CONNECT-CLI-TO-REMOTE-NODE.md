# Connect the CLI to a remote node

For a **member**: someone invited into a Space on a tm8 node that runs on
another machine (a teammate's server, a hosted node). You need the `tm8` CLI
and nothing else: no clone of the monorepo, no Postgres, no agent CLI. Agents
you start run **on the node**, under the node's own `claude`/`codex` login.

This walks you from an invite code to your first agent session.

## 1. Get the client-only CLI

The client-only CLI is one self-contained binary (the bun runtime, the CLI and
its contract: about 60 MB on macOS, 115 MB on Linux). There is no download host yet, so get it one of
two ways:

**From CI.** Every CI run that touches the CLI uploads `tm8-cli-linux-x64` and
`tm8-cli-darwin-arm64` as workflow artifacts (job `cli-binary`, kept 14 days).
Download the one for your machine from the run's Summary page. Each zip holds
the binary and its `.sha256`.

**Build it** on any machine with [bun](https://bun.sh) and a checkout:

```sh
bun install
scripts/build-cli-client.sh                              # this machine -> dist-client/tm8
scripts/build-cli-client.sh --target bun-linux-x64       # cross-build -> dist-client/tm8-linux-x64
scripts/build-cli-client.sh --target bun-darwin-arm64
```

Then install it on the machine you will use. The file is `tm8` for a host
build and `tm8-<target>` (e.g. `tm8-linux-x64`) for a cross-build or a CI
artifact:

```sh
shasum -a 256 -c tm8-linux-x64.sha256      # or: sha256sum -c …
install -m 0755 tm8-linux-x64 ~/.local/bin/tm8
tm8 --version
```

macOS marks a downloaded binary as quarantined. If Gatekeeper refuses to run
it, clear the flag: `xattr -d com.apple.quarantine ~/.local/bin/tm8`.

## 2. Point it at the node

The CLI talks to exactly one node per command. It picks the first of these
that is set (the same list `tm8 --help` prints under "connecting to a node"):

| Order | Where | Example |
|---|---|---|
| 1 | `TM8_BASE_URL` in the environment | `export TM8_BASE_URL=https://tm8.example.com` |
| 2 | `"baseUrl"` in the config file: `~/.config/tm8/config.json` (`$XDG_CONFIG_HOME/tm8/config.json`), or the file `TM8_CONFIG_PATH` names | `{ "baseUrl": "https://tm8.example.com" }` |
| 3 | `~/.config/tm8/desktop-node.json`, written by the tm8 desktop app while it runs | |
| 4 | the implicit local node | `http://127.0.0.1:4610` |

Inside an agent session the node sets `TM8_BASE_URL` itself, so a session
always talks to the node that spawned it.

For a member's laptop, put it in the config file once, so every shell gets it:

```sh
mkdir -p ~/.config/tm8
cat > ~/.config/tm8/config.json <<'JSON'
{ "baseUrl": "https://tm8.example.com" }
JSON
```

The config file can also hold `"space"` (your default Space id, step 4) and
`"format"` (`human`, `json` or `jsonl`). A malformed file is ignored, unless
you named it with `TM8_CONFIG_PATH`, in which case the CLI refuses with the
parse error.

Use **https** for any node that is not on your own machine. Signing up and
logging in send your password in the request body.

Check that the node answers:

```sh
tm8 auth claim status
```

This prints the node's mode and how accounts are created on it. A connection
error here means the URL is wrong or the node is down. (`tm8 doctor` also
reports "tm8 node reachable". Its other checks, such as a git work tree, the
data directory and the agent CLI, are for the machine that RUNS a node, so on
a member's laptop they fail and that is expected.)

## 3. Sign up from your invite

A Space admin on that node creates the invite and sends you the code:

```sh
# the admin, on their side:
tm8 space invite create <space-id> --role member --max-uses 1
```

You first read what the code lets you join, then redeem it. The invite code
authorizes the signup: it creates your account, adds you to the Space and
signs you in, in one step. The operator never learns your password.

```sh
tm8 space invite resolve inv_...
tm8 auth invite signup --code inv_... --username alice --password '<a long password>' \
  --display-name "Alice"
```

The resulting `tm8s_…` session is stored per node origin: in the macOS
keychain, or elsewhere in a `0600` file (`~/.config/tm8/credentials.json`, or
`TM8_CREDENTIALS_PATH`). Every later command against that origin uses it
automatically. Pass `--print-token` to store nothing and print the token once
instead (then `export TM8_AGENT_TOKEN=<token>`).

If the Space has a space password, add `--space-password '<it>'`.

Later sign-ins, from another machine or after `tm8 auth logout`:

```sh
tm8 auth login alice --password '<password>'
tm8 auth session          # who you are on this node, and your session
```

## 4. Pick your Space

```sh
tm8 space list
```

Commands that act in a Space take `--space <space-id>`. To skip the flag, add
your Space to the config file: `{ "baseUrl": "…", "space": "<space-id>" }`.

On a node that runs with `TM8_SPACE_SESSIONS=enforce`, an account session can
only list spaces until it enters one:

```sh
tm8 auth space enter <space-id>     # stores a session pinned to that Space
```

## 5. Start your first agent session

You need a Teammate (the agent persona) and a task for it:

```sh
tm8 teammate list --space <space-id>
tm8 entity create task "Try out tm8" --space <space-id> \
  --criterion "Say hello on the task" --estimate 1
tm8 session spawn --space <space-id> --teammate <teammate-id> --task <task-id>
```

The node starts the session in its own PTY. To work in one of the node's
project checkouts, pass `--launch-project <project-id>` (`tm8 project list`),
and add `--workdir worktree` for an isolated branch. Then follow it:

```sh
tm8 entity context <task-id>                              # status, messages, next steps
tm8 message send --to <work-session-id> "how is it going?"
```

If the session stays at `running` and never answers, the node has no
logged-in agent CLI. That is the node operator's fix (`tm8 doctor` on the node).

## More than one node

`--server <name>` sends one command to another tm8 node that is registered on
your current node (`tm8 server list`, `tm8 server add <name> --url
<https-url>`). Credentials stay per origin: log in to each node once with
`TM8_BASE_URL=<that node> tm8 auth login …`. A node's token is never sent to
another node.

To switch which node a shell uses by default, change `TM8_BASE_URL` (or
`baseUrl`). For a whole-Space link between two nodes, where agents in your
Space act in a Space on another node, see
[`REMOTE-SPACE-LINKS.md`](REMOTE-SPACE-LINKS.md).

## Troubleshooting

| You see | It means |
|---|---|
| `did not answer GET /health` / connection refused | wrong `baseUrl`, the node is down, or a firewall is in the way |
| `403 … Host "…" is not this node` | the node's `TM8_ALLOWED_HOSTNAMES` / `TM8_PUBLIC_ORIGIN` do not include the name you used. The node operator fixes this |
| `unauthenticated` after it worked before | your session expired or was revoked: `tm8 auth login` again |
| `no Space in context` | pass `--space <space-id>` or set `"space"` in the config file |
| commands hit the wrong node | `TM8_BASE_URL` in your shell overrides the config file. Run `env \| grep TM8_` |
