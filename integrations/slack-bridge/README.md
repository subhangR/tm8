# slack-bridge: the Slack connector runtime

The process that connects Slack app installs to tm8. It speaks the bridge runtime protocol v4
(`src/runtime/protocol.ts`, a byte-identical copy of `packages/contract/src/bridge-runtime-protocol.ts`) to
tm8-server as provider `slack`, the same way `integrations/whatsapp-bridge` does for WhatsApp. The design is in the
tm8 doc *Slack bridge: plugging an enterprise Slack into tm8* and `docs/features/bridges/BRIDGE-ENTITY-DESIGN.md` §2.5.

Setting up a Slack app and pasting its tokens into tm8 is covered in `SETUP.md`. This file covers development.

## What it does

- **One Socket Mode socket per connection** (`src/runtime/socket-mode.ts`). It calls `apps.connections.open` with the
  app-level token (`xapp-…`) and acks every envelope with its `envelope_id` before doing any work. When Slack sends
  `disconnect`, it opens a new socket and closes the old one only after the new one says `hello`. It gives up on a
  socket that never says hello, and reopens with backoff when a socket drops or stops answering pings. There is no
  public URL and no inbound port. One Slack app runs on one connection only: Socket Mode spreads an app's events
  over all of its sockets, so a second connection on the same app is refused with `logged_out`
  `app_already_connected`.
- **Tokens.** A `connect` with `credential: {kind: 'slack_tokens', botToken, appToken}` is checked with `auth.test`.
  The `x-oauth-scopes` header gives the scopes. On success the tokens are sealed with AES-256-GCM under the
  connection's `stateKey` in `<TM8_SLACK_STATE_DIR>/bridges/<connectionId>/tokens.seal` (directory 0700, file 0600),
  and the runtime sends `state linked` with the `account`. Bad tokens produce `state logged_out` whose detail is
  Slack's error code (`app_token: <code>` for the xapp token). No token appears in any frame, log line or error.
  Only a dead token (`invalid_auth`, `not_authed`, `account_inactive`, `token_revoked`, `token_expired`,
  `app_uninstalled`) logs the connection out and deletes the seal. Any other refusal fails only that request.
  A `connect` with no credential, or a `hello` reply, unseals the stored tokens. If nothing is stored, the runtime
  sends `no_credential`. `disconnect {logout: true}` deletes the sealed tokens.
- **The allowlist guard (D28)** (`src/runtime/allowlist.ts`). An event from a channel that is not connected is acked,
  counted in the heartbeat's drop counters and dropped. Only its channel id is read. Outbound frames to such a
  channel are refused without calling Slack. DM ids are never accepted.
- **Inbound.** The runtime turns these Slack events into `inbound` frames:
  - messages, with mentions shown as readable names and the user ids kept in `mentions`;
  - thread replies (`thread` and `replyTo` name the root);
  - files, as `MediaRef`s whose `handle` is the Slack file id;
  - reactions;
  - edits (`message_changed` with `edited` set) and deletes;
  - messages from other bots, marked `bot`; the runtime's own messages are skipped;
  - `/tm8 <cmd> <args>`, sent with `body` `/<cmd> <args>` and `externalMessageId` `cmd:<trigger_id>`.

  `message` and `app_mention` events for the same message become one frame, and so do redelivered envelopes. Sender
  name, email and avatar come from `users.info` and are cached for an hour. Renames, archives and the bot leaving or
  joining a channel become `conversation-state` frames.
- **Outbound.**
  - `send`: tm8 markdown is converted to Slack mrkdwn and split at about 3,500 characters. Each part goes out with
    `chat.postMessage`, using `thread_ts`, plus `username`/`icon_url` when the frame has a `voice`. Without the
    `chat:write.customize` scope, the message is signed `*Name:* ` instead. Only `http(s)` and `mailto` link
    targets become Slack links. Any other target stays plain text, because Slack would read it as a control token
    such as `<!channel>`.
  - Files: the bytes stream from the server's authenticated `outbound-media` route, then go through
    `files.getUploadURLExternal`, the upload, and `files.completeUploadExternal`. A file is always posted as the app.
    With a voice, the caption follows as a separate voiced message.
  - `react`: `reactions.add`. The emoji is converted from unicode to Slack's name, and the reaction the runtime put
    on that message earlier is removed.
  - `media.fetch`: `files.info`, then `url_private` with the bot token, limited to `maxBytes`, and only for a file
    shared in that channel. The token goes only to `https://files.slack.com`, and every redirect is checked before
    it is followed.
  - `conversation.list`: `users.conversations`. On an org-wide Enterprise Grid install, the runtime calls it once
    per workspace from `auth.teams.list`, passing `team_id`. A shared channel is listed once, and a name used in two
    workspaces gets its workspace in brackets, e.g. `general (Acme EU)`. A workspace that fails is skipped and
    logged, and the 10,000-channel cap applies per workspace.
  - A 429 is reported as `failed {retryable: true, retryAfterSec}`.
  - `typing` and `read` are ignored. `group.*` frames are answered with an error.

## Known limits

- **Inbound is lost while tm8-server is down for more than about 31 s.** An envelope is acked to Slack before it is
  forwarded, because Slack requires the ack within 3 s. If the server cannot take the `inbound` POST through the
  link's retries (1+2+4+8+16 s), the message is dropped and logged by route only. whatsapp-bridge behaves the same
  way. Slack's own history still has the message.
- No typing indicator, read receipts, polls or channel creation: Slack bots have none of these
  (`SLACK_CAPABILITIES`).

## Run it by hand

```sh
cd integrations/slack-bridge
npm ci
TM8_BRIDGE_RUNTIME_TOKEN_FILE=/path/to/bridge-runtime-token npm run runtime
```

| Variable | Default | Meaning |
|---|---|---|
| `TM8_SERVER_URL` | `http://127.0.0.1:17777` | tm8-server (loopback) |
| `TM8_BRIDGE_RUNTIME_TOKEN_FILE` | required | the `bridge_runtime` bearer the node minted; re-read on every call |
| `TM8_SLACK_STATE_DIR` | `./data` | where the sealed tokens live |
| `TM8_SLACK_API_URL` | `https://slack.com/api/` | Slack Web API base; point it at a fake Slack to test |
| `TM8_SLACK_RUNTIME_ID` | `slack-<hostname>` | this runtime's stable id |
| `TM8_SLACK_PROXY_URL` | unset | HTTP(S) proxy for all Slack traffic; overrides the standard variables below. `user:password@` is sent as Proxy-Authorization |
| `HTTPS_PROXY` / `https_proxy` | unset | the standard proxy for `https://` and `wss://` (`HTTP_PROXY` for `http://`) |
| `NO_PROXY` / `no_proxy` | unset | hosts reached directly: `*`, `host`, `.domain`, `*.domain`, `host:port` |

In a deployment the server's supervisor starts it with the label `slack-runtime`. The runtime needs outbound HTTPS
and WSS to `slack.com` and `*.slack.com`, and nothing inbound. Behind a mandatory proxy, set `TM8_SLACK_PROXY_URL`
(or `HTTPS_PROXY`). Every Slack connection then opens as an HTTP CONNECT tunnel through it: Web API calls, the Socket
Mode socket, and file uploads and downloads (`src/runtime/egress.ts`, no extra dependency). The link to tm8-server
is loopback and never goes through the proxy.

## Tests

```sh
npm test            # node:test via tsx, about 10 s
npm run typecheck   # tsc -p .
```

The suites run the real runtime (`HttpWsLink`, `Runtime`, `SlackConnection`, the Socket Mode client) between two
fakes. Nothing inside the process is stubbed:

- `test/fake-slack.ts`, **a reusable fake Slack**:
  - the Web API (`auth.test`, `apps.connections.open`, `chat.postMessage`, `reactions.*`, `users.*`,
    `conversations.info`, `files.*`);
  - a Socket Mode WebSocket server that sends `hello`, pushes envelopes (`event()`, `slash()`, `disconnect()`) and
    records acks;
  - upload and `url_private` endpoints;
  - fault injection (`rateLimit(method, times, retryAfter)`, `fail(method, error)`);
  - org-wide Enterprise Grid installs (`team.isEnterpriseInstall = true`, `workspaces`, channels in several
    workspaces): `auth.test` answers with the org, and listing without a `team_id` is refused as Slack does.

  An end-to-end test of tm8-server plus this runtime can import it.
- `test/fake-tm8.ts`, a fake tm8-server: the `/v2/bridge-runtime/<route>` POSTs (recorded), `outbound-media`, and
  the push WebSocket.
- `test/harness.ts` wires them together (`rig()`, `seed()`).

| Suite | Covers |
|---|---|
| `connect.test.ts` | linking, sealing, Grid, bad tokens, restart, logout, Socket Mode lifecycle, heartbeat |
| `inbound.test.ts` | the allowlist drop, messages, mentions, threads, files, reactions, edits, deletes, slash commands, channel state |
| `outbound.test.ts` | send (mrkdwn, split, thread, voice), 429 and error mapping, reactions, files out and in, the channel list |
| `grid.test.ts` | org-wide Enterprise Grid installs (per-workspace listing, W… users, posting, files) and workspace installs on Grid |
| `proxy.test.ts` | proxy configuration and NO_PROXY; every Slack path tunnelling through a CONNECT proxy (`test/connect-proxy.ts`), with auth and refusal |
| `units.test.ts` | mrkdwn, splitting, Slack text, emoji, failure mapping, sealing, the allowlist |

CI runs the suites in `.github/workflows/slack-bridge.yml` (until installed, `ci/slack-bridge.workflow.yml`) whenever this directory or the canonical protocol module
changes. `packages/contract/test/bridge-runtime-protocol.test.ts` checks that the protocol mirror matches the
canonical module.
