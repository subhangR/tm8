# tm8 desktop app — settings, port, sign-in, remote nodes

The macOS app (`apps/desktop`) is an Electron shell around the unmodified tm8 server: it
starts its own Postgres and `packages/server/dist/index.js`, then opens the web UI in one
window. It is configured by one optional file. There is no settings screen yet.

## The settings file

`~/Library/Application Support/tm8/desktop.json` (the app's `userData` directory, which
also holds its database and node data). Every key is optional; a missing file means the
defaults below.

```json
{
  "port": 4619,
  "env": { "TM8_REMOTE_SPACE_LINKS": "on" },
  "remoteUrl": "https://tm8.example.com"
}
```

| Key | Default | What it does |
|---|---|---|
| `port` | `4619` | The HTTP port the local node asks for. If something already listens there, the app uses a random port for that launch and says so in its log. |
| `env` | `{}` | Extra `TM8_*` settings for the local server (strings only), e.g. `TM8_REMOTE_SPACE_LINKS`, `TM8_NODE_MODE`. See `docs/ops/CONFIG.md` and the Node admin Configuration page for what each one does. |
| `remoteUrl` | none | Open this tm8 node instead of starting the local one (see below). Only the origin is used. |

A malformed file, or a bad key in it, is reported in the log and on the startup status
line, then ignored. It never stops the app from starting. Relaunch the app after you edit
the file. Settings are read once at launch.

### Which `env` keys are allowed

Any key that starts with `TM8_`, except the ones the app sets itself or that belong to
another process:

- set by the app: `TM8_DATA_DIR`, `TM8_REPO_ROOT`, `TM8_UI_DIR`, `TM8_DESKTOP`, `TM8_PORT`
  (use `port`), every `TM8_PG_*`;
- identity of an agent session: `TM8_AGENT_TOKEN`, `TM8_SESSION_ID`, `TM8_MANIFEST_PATH`,
  `TM8_BASE_URL`, `TM8_SPACE_ID`, `TM8_ACTOR_ID`.

The app still ignores every `TM8_*` variable in the environment it was launched from. A
terminal inside a tm8 agent lane carries that lane's token and server, and the app must
not pass those on to its own agents. Use `env` in the settings file instead.

## Stable port, and how the CLI finds the app

With a fixed port the app's address stays the same across launches. When the local node
is ready, the app writes:

```
~/.config/tm8/desktop-node.json      ($XDG_CONFIG_HOME/tm8/ when set; mode 0600)
{ "baseUrl": "http://127.0.0.1:4619", "pid": <server pid>, "appPid": <app pid>, "startedAt": "…" }
```

The app deletes the file when it quits. If the app crashes and leaves the file behind,
the CLI ignores it once `appPid` is no longer running.

The `tm8` CLI picks its server in this order. The first match wins:

1. `TM8_BASE_URL` (set for agent sessions);
2. `baseUrl` in `~/.config/tm8/config.json` (or `$TM8_CONFIG_PATH`);
3. **the desktop app's `desktop-node.json`, while the app is running**;
4. `http://127.0.0.1:4610`.

So with the desktop app open and no other configuration, `tm8 auth login` and every
other command talk to the app's node. To point the CLI somewhere else, set `baseUrl` or
`TM8_BASE_URL`.

## Staying signed in

A browser keeps a sign-in per *origin*, and the origin includes the port. Earlier builds
used a random port on every launch, so every launch started signed out. With the fixed
port, the origin is the same each time. The window uses Electron's default persistent
session, stored under the `userData` directory, so sign-ins survive a relaunch. You start
signed out again only if the app had to fall back to a random port because the fixed one
was busy. The log says when that happens; set a free `port` to fix it.

## Connecting to a remote node

Set `remoteUrl` to the node's address (for example the one your admin gave you). On
launch, the app then:

- does **not** start a local database or server;
- checks `<remoteUrl>/health` (10 s budget) and shows the error on the status page if
  the node does not answer as a tm8 server;
- otherwise opens the node's web UI in the window. You sign in exactly as in a browser.
  The sign-in is kept for the next launch, because the origin does not change.

No discovery file is written in remote mode. To use the CLI against the same node, set
`baseUrl` in `~/.config/tm8/config.json` (see `docs/ops/CONNECT-CLI-TO-REMOTE-NODE.md`
if present, or `tm8 --help`). Remove `remoteUrl` and relaunch to go back to the local
node. Its data is still there.

## Not done yet

- There is no in-app UI for these settings, and no way to switch nodes without a
  relaunch.
- Remote mode shows one node per launch. There is no node picker.
