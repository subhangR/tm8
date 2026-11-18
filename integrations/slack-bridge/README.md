# slack-bridge: the Slack connector runtime

The process that connects Slack app installs to tm8. It speaks the bridge runtime protocol v4
(`src/runtime/protocol.ts`, a byte-identical copy of `packages/contract/src/bridge-runtime-protocol.ts`) to
tm8-server as provider `slack`, the same way `integrations/whatsapp-bridge` does for WhatsApp. The design is in the
tm8 doc *Slack bridge: plugging an enterprise Slack into tm8* and `docs/features/bridges/BRIDGE-ENTITY-DESIGN.md` §2.5.

Setting up a Slack app and pasting its tokens into tm8 is covered in `SETUP.md`. This file covers development.

## What it does

- **One Socket Mode socket per connection** (`src/runtime/socket-mode.ts`). It calls `apps.connections.open` with the
  app-level token (`xapp-…`), acks every envelope with its `envelope_id` before doing any work, opens a new socket when
  Slack sends `disconnect`, and reopens with backoff when the socket drops or stops answering pings. There is no
  public URL and no inbound port.
- **Tokens.** A `connect` with `credential: {kind: 'slack_tokens', botToken, appToken}` is checked with `auth.test`.
  The `x-oauth-scopes` header gives the scopes. On success the tokens are sealed with AES-256-GCM under the
  connection's `stateKey` in `<TM8_SLACK_STATE_DIR>/bridges/<connectionId>/tokens.seal` (directory 0700, file 0600),
  and the runtime sends `state linked` with the `account`. Bad tokens produce `state logged_out` whose detail is
  Slack's error code (`app_token: <code>` for the xapp token). No token appears in any frame, log line or error.
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
    `chat.postMessage`, using `thread_ts`, plus `username`/`icon_url` when the frame has a `voice`.
  - Files: the bytes stream from the server's authenticated `outbound-media` route, then go through
    `files.getUploadURLExternal`, the upload, and `files.completeUploadExternal`. A file is always posted as the app.
    With a voice, the caption follows as a separate voiced message.
  - `react`: `reactions.add`. The emoji is converted from unicode to Slack's name, and the reaction the runtime put
    on that message earlier is removed.
  - `media.fetch`: `files.info`, then `url_private` with the bot token, limited to `maxBytes`, and only for a file
    shared in that channel.
  - `conversation.list`: `users.conversations`.
  - A 429 is reported as `failed {retryable: true, retryAfterSec}`.
  - `typing` and `read` are ignored. `group.*` frames are answered with an error.

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

In a deployment the server's supervisor starts it with the label `slack-runtime`. The runtime needs outbound HTTPS
and WSS to `slack.com` and `*.slack.com`, and nothing inbound.

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
  - the org-wide Enterprise Grid `auth.test` shape (`team.isEnterpriseInstall = true`).

  An end-to-end test of tm8-server plus this runtime can import it.
- `test/fake-tm8.ts`, a fake tm8-server: the `/v2/bridge-runtime/<route>` POSTs (recorded), `outbound-media`, and
  the push WebSocket.
- `test/harness.ts` wires them together (`rig()`, `seed()`).

| Suite | Covers |
|---|---|
| `connect.test.ts` | linking, sealing, Grid, bad tokens, restart, logout, Socket Mode lifecycle, heartbeat |
| `inbound.test.ts` | the allowlist drop, messages, mentions, threads, files, reactions, edits, deletes, slash commands, channel state |
| `outbound.test.ts` | send (mrkdwn, split, thread, voice), 429 and error mapping, reactions, files out and in, the channel list |
| `units.test.ts` | mrkdwn, splitting, Slack text, emoji, failure mapping, sealing, the allowlist |

CI runs the suites in `.github/workflows/slack-bridge.yml` (until installed, `ci/slack-bridge.workflow.yml`) whenever this directory or the canonical protocol module
changes. `packages/contract/test/bridge-runtime-protocol.test.ts` checks that the protocol mirror matches the
canonical module.
