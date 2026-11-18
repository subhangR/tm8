# Connecting Slack to tm8

This guide connects your company's Slack (a single workspace or an Enterprise Grid org) to a tm8 node.
It is written for an admin who has not done this before. It takes about 15 minutes.

When you are done:

- `@tm8` in a connected Slack channel gets an answer from tm8, in a thread, from a tm8 session with its own name and icon.
- `/tm8 …` works as a Slack slash command.
- Every message in a connected channel is also visible in tm8, on the bridge.

There are two halves. **Part A** happens in Slack, at api.slack.com. **Part B** happens on the machine that runs tm8
and in the tm8 web app. Part C connects a channel.

Design background (not needed to follow this guide): `docs/features/bridges/` and the tm8 doc
*Slack bridge: plugging an enterprise Slack into tm8*.

---

## Before you start

You need:

| What | Why |
|---|---|
| A Slack account that may **create apps** in your workspace, or an **Org Owner / Org Admin** on Enterprise Grid (or one who will approve the app for you) | Slack only lets these people install apps |
| A tm8 node you are the **owner** of (you claimed it) and a **space admin** role in the space you will bridge into | Only the node owner's server can start the Slack runtime; only a space admin can add a bridge |
| On the tm8 machine: **node 22**, **npm** (comes with node), **bun**, **git**, and the tm8 checkout | The Slack runtime is a small Node program the tm8 server starts |
| Outbound internet from the tm8 machine to `slack.com` and `*.slack.com` on port 443 (HTTPS and WSS) | The runtime connects **out** to Slack. Nothing connects in |

You do **not** need a public URL, a domain, a webhook or an open inbound port. The bridge uses Slack's
**Socket Mode**: the tm8 machine opens a WebSocket to Slack and everything arrives over it.

---

## Part A: create the Slack app (in Slack)

### A1. Create the app from tm8's manifest

1. Open **https://api.slack.com/apps** and sign in to your company's Slack if asked.
2. Click **Create New App** (top right).
3. In the dialog, choose **From a manifest**.
4. **Pick a workspace to develop your app in**:
   - Single workspace: choose your workspace.
   - **Enterprise Grid**: choose your **organization** (the org name, not one of its workspaces) if Slack offers it.
     That makes the app installable once for the whole org. If only workspaces are listed, pick the workspace you
     will use first; an Org Admin can still install it org-wide later (step A3).
   - Click **Next**.
5. Choose the **YAML** tab. Delete the sample text. Open
   [`slack-app-manifest.yaml`](slack-app-manifest.yaml) from this folder, copy **all** of it and paste it in.
   Click **Next**.
6. Slack shows a summary: bot user **tm8**, Socket Mode on, the `/tm8` command, the scopes and events below.
   Click **Create**.

The app now exists but is not installed yet. You land on its **Basic Information** page.

What the manifest asks for, and why:

| Bot scope | Why tm8 needs it |
|---|---|
| `app_mentions:read` | See `@tm8` mentions |
| `channels:history`, `channels:read` | Read public channels tm8 is invited to, and list them in the channel picker |
| `groups:history`, `groups:read` | The same for private channels tm8 is invited to |
| `chat:write` | Post replies |
| `chat:write.customize` | Post each reply under the tm8 session's own name and icon |
| `reactions:read`, `reactions:write` | See reactions; show 📨 👀 ✅ progress on the message tm8 is answering |
| `files:read`, `files:write` | Pass files from Slack to tm8, and upload files tm8 makes |
| `users:read`, `users:read.email` | Show who wrote a message; link a Slack user to the tm8 member with the same verified email |
| `commands` | The `/tm8` slash command |

Events: `message.channels`, `message.groups`, `app_mention`, `reaction_added`, `member_joined_channel`,
`channel_left`, `channel_archive`, `channel_rename`.

tm8 can only see a channel **after it has been invited to it**, and the tm8 runtime drops anything from a
channel that is not connected as a bridge before it reaches the tm8 server.

> **Optional: direct messages.** The manifest leaves out `im:history`, `im:read` and `im:write`, so people
> cannot DM the bot. If you want DMs, add those three to `oauth_config.scopes.bot` and `message.im` to
> `settings.event_subscriptions.bot_events` (App Manifest page in Slack, or edit the file before pasting),
> then reinstall the app (A3). Leave them out unless you need them.

### A2. Enterprise Grid only: org-ready app and approval

Skip this on a single workspace.

- The manifest sets `org_deploy_enabled: true`, which makes the app **org-ready**: it can be installed once at the
  org level and then added to any of the org's workspaces. If the app's settings show an **Org Level Apps** page
  with an **Opt-In** button, click **Opt-In** (on newer apps the manifest has done this already).
- **Installing at the org level needs an Org Owner or Org Admin.** If that is not you, send them the app's
  **Basic Information** link and ask them to do A3 for you.
- **If your org has app approval turned on** (admins approve apps before they are installed), clicking install
  as a non-admin sends an **app request** instead. The Org Admin approves it in the **Admin dashboard** (Slack →
  your org name → **Tools & settings → Organization settings**, then **Integrations → App requests**; the exact
  menu names change from time to time). Approval is Slack's own control; tm8 adds nothing to it. Once approved,
  carry on with A3.

### A3. Install the app

1. In the app's left sidebar, open **Install App** (under *Settings*), or **OAuth & Permissions**.
2. Click **Install to Workspace**, or on Enterprise Grid **Install to Organization**.
3. Slack shows the permissions (the scopes above). Click **Allow**.
4. **Enterprise Grid:** after an org install, an Org Admin chooses which workspaces get the app: Admin dashboard →
   **Integrations → Installed apps → tm8 → Add to more workspaces** (or **Manage workspaces**). Pick every
   workspace whose channels you want to bridge. One install covers all of them; tm8 needs only one connection.

### A4. Copy the bot token (`xoxb-…`)

1. Left sidebar → **OAuth & Permissions**.
2. Under **OAuth Tokens** (*for Your Workspace* or *for Your Organization*), copy the **Bot User OAuth Token**.
   It starts with `xoxb-`.

Keep it somewhere safe for five minutes (a password manager). Do not paste it into chat or email. You will paste
it into tm8 in step B4, and tm8 never shows it again.

### A5. Make the app-level token (`xapp-…`)

Socket Mode needs a second token, the app-level token.

1. Left sidebar → **Basic Information**.
2. Scroll to **App-Level Tokens**. Click **Generate Token and Scopes**.
3. **Token Name**: `tm8-socket` (any name works).
4. Click **Add Scope** and choose **`connections:write`**. Only that one.
5. Click **Generate**. Copy the token. It starts with `xapp-`. Click **Done**.

You now have two tokens: `xoxb-…` (bot) and `xapp-…` (app-level).

---

## Part B: run the Slack runtime and connect it (on the tm8 machine, then in tm8)

The **Slack runtime** is a small program in this folder (`integrations/slack-bridge`). The tm8 server starts it,
gives it a fresh login every few days, and restarts it if it stops, the same way it runs the WhatsApp runtime.
You switch it on with **one setting**, `TM8_SLACK_RUNTIME=1`.

### B1. Get the code and install the runtime's dependencies

```bash
cd ~/tm8                       # your tm8 checkout
git checkout main && git pull
bun install                    # tm8 itself
(cd integrations/slack-bridge && npm ci)   # the Slack runtime (a separate npm package)
```

If you use `bun run local` (B2, option 2), the deploy runs the `npm ci` for you.

### B2. Turn the Slack runtime on

Pick the line that matches how you run tm8.

**Option 1: you installed tm8 with `./install.sh` and run it with `bun run dev`** (the usual laptop setup).
Add one line to the env file the installer wrote, `.env.dev.local` in the checkout (for another slot it is
`.env.<slot>.local`; `./install.sh --status` prints its path):

```bash
echo 'TM8_SLACK_RUNTIME=1' >> .env.dev.local
```

Then stop tm8 (Ctrl-C) and start it again: `bun run dev`.

**Option 2: you run the stable node with `bun run local`** (7777/7778). Put the setting in
`~/.config/tm8/bridges.env`, which `deploy/prod/env.sh` reads on every start:

```bash
mkdir -p ~/.config/tm8
echo 'TM8_SLACK_RUNTIME=1' >> ~/.config/tm8/bridges.env
bun run local            # rebuilds, installs the runtime's deps, restarts
```

**Option 3: a server installed as a system service** (`/etc/tm8/<slot>.env`): add `TM8_SLACK_RUNTIME=1` to that
file as root, run `cd integrations/slack-bridge && npm ci` in the server's checkout as the service user, and
restart the service.

### B3. Check that the runtime started

In the tm8 server's log (the terminal running `bun run dev`, or `~/.local/share/tm8-prod-logs/server.log` for
`bun run local`) you should see:

```
[bridges] slack-runtime started; sealed state in /home/you/.tm8-dev/data/bridges/slack-runtime
```

and, from the runtime, a line saying it connected to tm8. `bun run doctor` also reports the runtime and where
its state lives. If you see `slack-runtime not started: …` instead, the line says what to fix (usually: run
`npm ci` in `integrations/slack-bridge`).

### B4. Paste the tokens into tm8

1. Open tm8 in your browser and sign in as the node owner.
2. **Settings → Bridges → Connections → Add → Slack.**
3. Paste the **bot token** (`xoxb-…`) and the **app-level token** (`xapp-…`) into their fields. Click **Connect**.
4. tm8 checks them with Slack and shows **Connected to *Your Company* (*yourcompany.slack.com* or
   *yourcompany.enterprise.slack.com*) as @tm8**.

If it shows an error instead, see [Troubleshooting](#troubleshooting). The code it shows (`invalid_auth`, …) is
Slack's own.

---

## Part C: connect a channel

1. **In Slack**, in the channel you want, type `/invite @tm8` and send it. Public and private channels both work.
   tm8 cannot see or list a channel until it has been invited.
2. **In tm8**: open the space → **Bridges → Add bridge → Slack (*Your Company*)**.
3. **Pick the channel.** The list shows the channels the bot is in. Invited a moment ago and it is not there?
   Close and reopen the picker.
4. **Pick the target**: the tm8 chat, work session or channel that answers this Slack channel.
5. **Thread mode**:
   - **Mention** (default): every top-level message that mentions `@tm8` starts its own tm8 session, which lives
     in that Slack thread. Replies in the thread go to that session. A thread session goes idle after about two
     hours without replies and wakes up, with its history, on the next reply. Thread sessions are grouped under
     the target session in tm8.
   - **Every message**: every top-level message starts a session. Only for a quiet intake channel.
   - **Off**: the channel behaves like one conversation; `@tm8` gets an answer from the target.
6. Click **Add**.

---

## Verification checklist

Do these in order; each one proves the step before it.

- [ ] The tm8 server log shows `slack-runtime started` (B3).
- [ ] **Settings → Bridges → Connections** shows the Slack connection as **Connected to … as @tm8** (B4).
- [ ] The channel picker lists the channel you invited tm8 to (C3).
- [ ] In that Slack channel, post `@tm8 hello`. Within a few seconds the message gets 📨, then 👀, and a reply
      appears **in the thread** from a session with its own name and icon (Mention mode).
- [ ] Reply in that thread. The same session answers.
- [ ] The messages appear in tm8 on the bridge, with the Slack sender's name.
- [ ] `/tm8 status` in the channel answers.
- [ ] A message in a channel that is **not** connected gets no reply and does not appear in tm8.

---

## Where the tokens live, and keeping them

tm8 keeps the two Slack tokens **only** in the Slack runtime's **sealed state directory**, encrypted with a key
that the tm8 server holds (in its database) and hands to the runtime when it connects. The server never stores the
token bytes, and no screen, API or agent can read them back. Neither half is useful alone: the files cannot be
decrypted without the tm8 database, and the database does not contain the tokens.

**Where it is by default:** `<tm8 data dir>/bridges/slack-runtime/`, one sub-folder per connection. That is:

| How you run tm8 | Default state dir |
|---|---|
| `./install.sh` + `bun run dev` (dev slot) | `~/.tm8-dev/data/bridges/slack-runtime/` |
| `bun run dev` without the installer | `~/.tm8-dev/bridges/slack-runtime/` |
| `bun run local` | `~/.local/share/tm8/data/bridges/slack-runtime/` |
| System service (`/etc/tm8/<slot>.env`) | `<TM8_DATA_DIR from that file>/bridges/slack-runtime/` |
| Docker (below) | the volume mounted at `/app/state` |

The server prints the exact path at start (B3), and `bun run doctor` prints it too. It sits under the tm8 data
directory, not in the checkout, so pulling, rebuilding or redeploying tm8 does not touch it.

**To put it somewhere else**, set `TM8_SLACK_STATE_DIR=/path/you/want` in the same place you set
`TM8_SLACK_RUNTIME=1`, and restart tm8. Move the old folder there first, or paste the tokens again.

**Back it up, or keep it on persistent storage.** It must survive restarts for the bridge to keep working:
- On a laptop, include the tm8 data directory in your backups (it also holds the rest of tm8's files).
- In Docker, mount a named volume or a host folder at `/app/state`. A container without one loses the tokens
  every time it is recreated.

**If it is lost or wiped**, nothing in Slack breaks and no messages are lost from tm8, but the Slack connection
shows as disconnected and the bridge stops. Fix: **Settings → Bridges → Connections → the Slack connection →
Relink**, and paste both tokens again (A4 and A5 tell you where to find them; you can generate a new
app-level token rather than look for the old one).

### Rotating the tokens

Do this when someone who saw a token leaves, or on your security team's schedule.

1. **App-level token:** Slack app → **Basic Information → App-Level Tokens → Generate Token and Scopes**, scope
   `connections:write`. Copy the new `xapp-…`.
2. **Bot token** (only if it may have leaked): Slack app → **OAuth & Permissions → Revoke tokens** (bottom of the
   page), then **Reinstall to Workspace / Organization** and copy the new `xoxb-…`. Revoking stops the bridge
   until step 3.
3. In tm8: **Settings → Bridges → Connections → the Slack connection → Relink**, paste both tokens, Connect.
   tm8 checks them and replaces the sealed copy.
4. Back in Slack, **revoke the old app-level token**: Basic Information → App-Level Tokens → click the old token
   → **Revoke**.

The bridges, their channels and their history in tm8 stay as they were.

### Disconnecting

- **In tm8:** Settings → Bridges → Connections → the Slack connection → **Disconnect**. The runtime closes the
  Slack socket and deletes the sealed tokens. The bridges stop; their history stays in tm8.
- **In Slack** (to remove access completely): the app → **OAuth & Permissions → Revoke tokens**, or uninstall
  the app (workspace **Settings & administration → Manage apps**, or for Grid the Admin dashboard →
  **Integrations → Installed apps → tm8 → Uninstall**). Remove `TM8_SLACK_RUNTIME=1` to stop running the runtime.

---

## Data and retention

Tell your compliance team:

- **What is copied:** every message, edit and file in a **connected** channel is copied into tm8's database (the
  bridge log), with its Slack sender. Messages from channels that are not connected are dropped by the runtime and
  never reach tm8 (only a count is kept). Channels tm8 is not invited to are invisible to it.
- **Deletes and edits are mirrored:** a message deleted in Slack is deleted (tombstoned) in tm8; an edit updates
  tm8's copy.
- **Retention follows tm8, not Slack.** Slack's retention policies do not reach into tm8. Messages stay in tm8
  until tm8's own retention removes them.
- **Network:** outbound only, HTTPS and WSS to Slack. No public URL, webhook or inbound firewall rule.
- **People:** a Slack user whose Slack profile email matches a tm8 member's **verified** email is linked to that
  member automatically. Everyone else is a guest until they run `/tm8 link`.
- **Who can do what:** only a tm8 space admin can add a bridge; only the connection's owner can change its tokens.

---

## Troubleshooting

| What you see | What it means | Fix |
|---|---|---|
| `invalid_auth` / `not_authed` when you click Connect | The bot token is wrong, cut short, or from another app | Copy the **Bot User OAuth Token** again (A4). It starts with `xoxb-`. Check you did not paste the xapp token into the bot field |
| `not_allowed_token_type` | A token is in the wrong field, or a user token (`xoxp-`) was used | Bot field: `xoxb-…`; app-level field: `xapp-…` |
| `token_revoked` / `account_inactive` | The token was revoked, or the app was uninstalled | Reinstall the app (A3), copy the new token, **Relink** |
| `missing_scope` | The app was created from an older or edited manifest | Slack app → **App Manifest**, paste this folder's manifest again, **Save**, then **Reinstall** (A3) and **Relink** |
| Connected, but the channel is not in the picker | The bot is not in the channel | `/invite @tm8` in the channel, reopen the picker |
| `not_in_channel` or `channel_not_found` when tm8 replies | The bot was removed from the channel, or it is a private channel it was never invited to | `/invite @tm8` again |
| Nothing happens on `@tm8`, connection shows disconnected | The runtime is not running or cannot reach Slack | Check the server log for `slack-runtime` lines (B3); run `bun run doctor` |
| `slack-runtime not started: … npm ci` in the log | The runtime's dependencies are not installed | `(cd integrations/slack-bridge && npm ci)`, restart tm8 |
| Socket never connects; Web API errors like `ECONNREFUSED`, `ETIMEDOUT`, `getaddrinfo` | A firewall or proxy blocks Slack | Allow **outbound** TCP 443 from the tm8 machine to `slack.com`, `*.slack.com` (Web API, `files.slack.com`) and `wss-*.slack.com` (Socket Mode). The runtime connects directly; it does not use an HTTP proxy (`HTTPS_PROXY` is not read), so these hosts must be reachable without one. TLS interception (a corporate MITM certificate) also breaks it: exempt these hosts |
| Replies arrive slowly in a busy channel; log shows `ratelimited` / 429 | Slack allows about one message per second per channel | Nothing to do: tm8 queues and retries after Slack's `Retry-After`. Use **Mention** rather than **Every message** in busy channels |
| `/tm8` says the app did not respond | The runtime is down, or the command reached a workspace where the app is not installed | Check B3; on Grid, add the app to that workspace (A3 step 4) |
| After a restart the connection asks for tokens again | The sealed state directory was lost or moved | See [Where the tokens live](#where-the-tokens-live-and-keeping-them); paste the tokens again and keep the directory on persistent storage |

---

## Running the runtime yourself (advanced)

The server can mint the runtime's login without starting it, for when you run the runtime in a container or under
your own process manager:

- On the tm8 server set **`TM8_SLACK_RUNTIME_TOKEN_FILE=/path/slack-runtime.token`** and leave
  `TM8_SLACK_RUNTIME` unset. The server writes a fresh login to that file (mode 0600) and keeps it fresh.
- Run the runtime with `TM8_SERVER_URL`, `TM8_BRIDGE_RUNTIME_TOKEN_FILE` (that file) and `TM8_SLACK_STATE_DIR`.

By hand, from this folder:

```bash
TM8_SERVER_URL=http://127.0.0.1:4610 \
TM8_BRIDGE_RUNTIME_TOKEN_FILE=~/.tm8-dev/data/bridges/slack-runtime.token \
TM8_SLACK_STATE_DIR=~/.tm8-dev/data/bridges/slack-runtime \
npm run runtime
```

With Docker (see the [`Dockerfile`](Dockerfile) header):

```bash
docker build -t tm8-slack-runtime integrations/slack-bridge
docker run -d --name slack-runtime --restart unless-stopped --user "$(id -u):$(id -g)" \
  -e TM8_SERVER_URL=http://host.docker.internal:7778 --add-host host.docker.internal:host-gateway \
  -v /path/slack-runtime.token:/app/secrets/runtime.token:ro \
  -v tm8-slack-state:/app/state \
  tm8-slack-runtime
```

The `--user` must be the user that owns the token file (the tm8 server's user). `tm8-slack-state` is the volume
that holds the sealed tokens: keep it, and back it up.

### All settings

Set these where you set `TM8_SLACK_RUNTIME` (B2). Only the first is needed on a laptop.

| Variable | Default | What it does |
|---|---|---|
| `TM8_SLACK_RUNTIME` | unset (off) | `1`: the tm8 server starts and supervises the Slack runtime from `integrations/slack-bridge` |
| `TM8_SLACK_STATE_DIR` | `<TM8_DATA_DIR>/bridges/slack-runtime` | Where the sealed tokens live (see above) |
| `TM8_SLACK_RUNTIME_TOKEN_FILE` | `<TM8_DATA_DIR>/bridges/slack-runtime.token` | Where the server writes the runtime's login. Set alone: the server mints, you run the runtime |
| `TM8_SLACK_RUNTIME_COMMAND` | unset | JSON argv to run instead of the default, e.g. `["docker","start","-a","slack-runtime"]` |
| `TM8_SLACK_RUNTIME_CWD` | `<checkout>/integrations/slack-bridge` | Folder the runtime starts in |
| `TM8_SLACK_RUNTIME_ID` | `slack-<hostname>` | The runtime's name in tm8 |
| `TM8_SLACK_API_URL` | `https://slack.com/api/` | Slack Web API base. Only for tests against a fake Slack |

The WhatsApp runtime's `TM8_BRIDGE_RUNTIME_*` settings are separate; the two runtimes can run side by side.
