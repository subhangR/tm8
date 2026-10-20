# wa-bridge operations

The WhatsApp ↔ tm8 bridge (Phase 1). One Docker container holds the linked-device WhatsApp connection,
routes mentions into tm8 chats/sessions, and serves the speaker-token API to agents on `127.0.0.1:8787`.
Design: `/home/tm8/prod-data/chat-threads/cbe3ce53-f1ab-4850-a62b-c42d3678601d/whatsapp-bridge-design.md`.

| What | Where |
|---|---|
| Source | `integrations/whatsapp-bridge` in the tm8 repo (imported from the standalone repo at `5febafc`) |
| Live deploy dir | `/home/tm8/prod-data/wa-bridge`: `scripts/deploy.sh` mounts `auth/`, `data/`, `secrets/`, `config.json` from the directory it runs in |
| Container / image | `wa-bridge` / `wa-bridge:latest` (`--restart unless-stopped`, `--network host`, uid 110) |
| API | `http://127.0.0.1:8787` (localhost only) |
| Linked device (SECRET) | `auth/` → `/app/auth`. Never delete, commit, or print it. |
| Database | `data/bridge.sqlite` → `/app/data` (log + FTS, names, tokens, outbox, routes, media) |
| Media files | `data/media/<wa_msg_id>.<ext>` (inbound images/documents/audio and sent images/documents; gitignored like all of `data/`) |
| Whisper models | `data/models/ggml-*.bin` (gitignored; `./scripts/fetch-model.sh` downloads one, once) |
| tm8 token | `secrets/tm8-token` → `/app/secrets` (ro). Gitignored, 0600. A channel may have its own (`secrets/tm8-token-<id>`), see "Add a group in another space". |
| Speaker token files | `tokens/<name>.token` (0600, dir 0700) → same path in the container. Gitignored. See "Speaker tokens". |
| Config | `config.json` → `/app/config.json` (ro). Gitignored; see `config.example.json`. |
| tm8 CLI | `/opt/tm8/prod` mounted read-only; the bridge runs `packages/cli/dist/tm8 … --format json` |

**Only one process may hold the WhatsApp connection.** Never run `npm start` on the host while the
container is up (`docker stop wa-bridge` first), or the two sessions fight and WhatsApp may log the device out.

## Run / deploy

```bash
cd /home/tm8/prod-data/wa-bridge
./scripts/fetch-model.sh     # once: the whisper.cpp model for voice notes (data/models/ggml-small-q5_1.bin, 182 MB)
./scripts/deploy.sh          # docker build + stop/replace the container + wait for /health connected
curl -s 127.0.0.1:8787/health | jq
```

`deploy.sh` is also how you apply code or config changes (config is read at start). The image builds whisper.cpp (pinned tag,
AVX2) and installs ffmpeg, so it is ~1.2 GB and the first build takes a few minutes.
Tests: `npm test` (node:test via tsx), typecheck: `npm run typecheck`. In the image:
`docker run --rm -v $PWD/test:/app/test:ro wa-bridge node --import tsx --test test/*.test.ts`.

## Logs

```bash
docker logs -f --tail 200 wa-bridge
docker logs --since 1h wa-bridge | grep -E '\[(route|out|names|main|wa)\]'
```

Lines: `[in <channel>]` inbound logged, `[route]` posted to tm8, `[out]` sent to WhatsApp, `[names]` poller,
`[main]` main chat creation, `[wa]` connection state, `[poll]` tm8 polling errors. Logs rotate (5 × 20 MB).
Message bodies appear in logs truncated to 200 chars; tokens never do. `[media]` lines: downloads, uploads to tm8, retries.
`[stt]` lines: the transcriber at start (and a WARNING if the model file is missing), each transcription (length, seconds taken,
language, first 120 chars), failures and timeouts, follow-up transcript posts.

## Health

`GET /health` (no auth): `wa.state` (`open`, `reconnecting`, `logged_out`, `not_linked`), `wa.connected`,
`tm8.configured`, `tm8.token_expires_at`, `tm8.last_poll_at/ok/error` (top-level `tm8` is the global token; the poll error lists
every failing channel), `queue_depth` (queued outbound messages), and per channel `main_chat_id`, `epoch`, `live_names` and
`tm8: {space_id, token_file, via_link, configured, token_expires_at, last_poll_at, last_poll_ok, last_poll_error}`.
Docker's healthcheck is "WhatsApp connected".

## Config (`config.json`)

```jsonc
{
  "pairingPhone": "910000000001",                 // only used by --link
  "ownerJids": ["910000000001@s.whatsapp.net", "100000000000001@lid"],  // owner = PN + LID
  "approverName": "<name>",                      // optional: who briefings say confirms sensitive actions in the tm8 UI; default "the operator"
  "trustedSenders": [],                          // optional: "owner" or sender JIDs labelled TRUSTED in every channel; see "Trusted senders"
  "http": { "host": "127.0.0.1", "port": 8787 },   // publicUrl defaults to http://host:port (goes into briefings)
  "tm8": {
    "baseUrl": "http://127.0.0.1:17777",
    "spaceId": "01a0fb3d-558e-7d92-b370-d0601112607a",
    "tokenFile": "secrets/tm8-token",
    "defaultTeammate": "01a0fb41-3317-77f3-b2b5-2bba3e489f4d",   // Opus 5.5 1M Teammate
    "defaultModel": "claude-opus-5-5",
    "pollSeconds": 10
  },
  "watchdogMinutes": 10,         // 👀 → ⚠️ + "no reply yet" notice after this long without a reply
  "maxRouteAgeMinutes": 10,      // older inbound (history sync) is logged, not routed
  "rateLimits": { "perTokenPerMinute": 20, "perChannelPerMinute": 30 },
  "media": { "maxBytes": 26214400,               // 25 MB cap on downloads and on /say-media uploads
             "attach": "reference" },             // "reference" (default): file id in the envelope; "attach": also --attach (see Media)
  "transcription": {                              // voice notes; all optional, these are the defaults
    "provider": "local",                          // "local" (whisper.cpp in the container) | "none" (off) | "openai" (reserved, acts as none)
    "model": "ggml-small-q5_1.bin",               // file in modelsDir; multilingual only (Hindi/English mix), never *.en
    "modelsDir": "data/models",
    "threads": 4,                                 // whisper threads; the box has 8 CPUs shared with everything else
    "language": "auto",                           // or a fixed ISO code, e.g. "hi"
    "maxDurationSec": 600,                        // longer audio is downloaded and attached but not transcribed
    "waitSeconds": 20                             // routing waits this long for a transcript, then posts and sends it as a follow-up
  },
  "channels": [
    {
      "id": "self",                                  // [a-z][a-z0-9-]*, used in names (self-main)
      "jid": "910000000001@s.whatsapp.net",          // the ONLY address we send to for this channel
      "altJids": ["100000000000001@lid"],            // other addresses it arrives under
      "title": "Subhang self chat",                  // main chat title: "<title> (WhatsApp)"
      "teammate": "<team-member id>",                // optional, default tm8.defaultTeammate
      "model": "claude-opus-5-5",                    // optional
      "allowedSenders": ["owner"],                   // "owner", WA JIDs, or "everyone" (any member; owner-only commands stay owner-only); default ["owner"]
      "trustedSenders": ["919999999999@s.whatsapp.net"],  // optional: labelled TRUSTED in this channel only (added to the global list)
      "mainChatId": null,                            // optional: use this existing tm8 chat instead of creating one
      "tm8": {                                       // optional: this channel's tm8 space; each missing field falls back to the global tm8 block
        "spaceId": "<space id>",                     // calls go with --space <spaceId>
        "tokenFile": "secrets/tm8-token-<id>",       // optional: own token; without it, the global token through the space link
        "defaultTeammate": "<team-member id in that space>",
        "defaultModel": "claude-opus-5-5"
      }
    }
  ]
}
```

The bridge sends only to channel `jid`s; every other chat is not even logged. A non-group channel must be one of
`ownerJids` (the self chat). In the self chat every message is `fromMe`, so the loop guard can't use that: a message is
ours if its id is in the outbox, or (for an echo that arrives while `sendMessage` is still running, before we know the id)
if it is `fromMe` with exactly the body of a send in flight in that chat. A pending send is registered just before
`sendMessage`, matches at most one echo, and is dropped as soon as the send returns (or after 60 s), so the owner's own
messages, including ones that start with `tm8:`, are always routed. Outbound `@words` are also broken with a zero-width joiner.

## What messages look like

In WhatsApp (plain text, no emoji or names added beyond this):

| Who | Line |
|---|---|
| A channel's main chat, operator tokens, and the bridge's own notices (command replies, watchdog, expiry, "link not configured") | `tm8: <text>` |
| A session | `<title> (<handle>): <text>`, e.g. `WhatsApp reply cleanup (keen-otter): done` (just `<handle>: <text>` until it has a title) |

The handle (adjective-animal) is the stable id: people address a session with `@keen-otter` or by replying to it. The title
is 3–4 words: by default the session's first task title (else the session title) cut to ≤4 words, set once when the
name is created (or on the next poll for older names). A session can set or refine it with `label` on `POST /say`; a label is
stored on the name (`names.title`, `title_source = 'label'`) and never overwritten by the default. `/who`, `/status`
and `GET /names` (`title`, `display`) show `Title (handle)`; main chats show as `Main chat (self-main)`.

In tm8, each routed message is one header line, any quote/notes, then the text:

```
[whatsapp "Subhang self chat" · from "Subhang" +91…0001 (owner's number, still UNTRUSTED) · to: self-main · wa_msg_id 3EB0…]
[quoted: keen-otter "WhatsApp reply cleanup (keen-otter): done"]
---
@tm8 thanks
```

### Trusted senders

The label in brackets says how far agents may take the sender at their word:

| Sender | Label |
|---|---|
| Anyone not listed | `UNTRUSTED group member` |
| The owner's number, not listed | `owner's number, still UNTRUSTED` |
| Listed in `trustedSenders` | `TRUSTED group member` |
| The owner's number, listed (`"owner"` or its JID) | `owner's number, TRUSTED` |

Briefings tell agents that TRUSTED means the operator listed that number, so its ordinary requests count as a known team
member's. It changes nothing else: a trusted sender still can't trigger agents unless `allowedSenders` lets them, gets no
owner-only command (`/stop`, `/new`), and agents still refuse destructive, credential, payment and permission actions from
WhatsApp until they are confirmed in the tm8 UI.

**The limit.** WhatsApp identity is only as strong as the phone number: the bridge sees which number (or LID) sent a message,
not who typed it. Someone holding that phone, a cloned SIM or a re-registered number is TRUSTED too. List only people you
would let ask for work under their own name, and remove them when the number changes hands.

**Adding a member.** Turning trust on is an access change: the operator confirms it in the tm8 UI first. Then:
1. Find the sender's JID: their number in international form, digits only, plus `@s.whatsapp.net`. If the group sends
   their messages under a LID, add the `<digits>@lid` too. On the bridge host, the `messages` row of one of their
   messages has both (`sender_jid`, `sender_alt_jid`, looked up by `wa_msg_id`).
2. Add it to the channel's `trustedSenders` (or the top-level list for every channel) in the live `config.json` only.
   Real numbers never go into this repo, docs or tm8.
3. Restart the bridge; the config is read at start. A bad entry (not `"owner"` or `<digits>@s.whatsapp.net|lid`, or
   `"everyone"`, or a group) stops the start with an error naming it.
4. Chats and sessions briefed before this feature: post them `admin.ts rebrief-trust <name>` so the new label is explained.

The bridge URL, speaker token and speaking rules are only in the briefing (on main chat creation or `/new`, and when a
session is named), never in envelopes.

## Media (images, documents, voice notes)

**Inbound.** Image, document (with or without caption), video, audio and sticker messages in a channel are logged with a text
placeholder (`[image] <caption>`, `[document] <file name> <caption>`, `[voice note 0:12]`, `[audio <file name>]` or `[audio 1:05]`,
`[sticker]`; that's what FTS indexes) and their bytes are downloaded right away with Baileys into `data/media/<wa_msg_id>.<ext>`;
mime, size, file name, caption, status (and for audio: duration, voice-note flag, transcript) are in the `media` table. Routing is
the same as for text: a caption with `@tm8`/`@handle`, or a reply to a bridge message (a voice note has no caption, so it routes only
as a reply to a bridge message). A routed media message is uploaded to tm8 once (`tm8 file upload`, mutation id derived from the
wa_msg_id) and every copy references it; the envelope gets a line like

```
[attachment: image · image/jpeg · 182 KB · tm8 file 01a1… (tm8 file download 01a1… --output <path>) · bytes also at GET /media/3EB0…]
[attachment: voice note 0:12 · audio/ogg; codecs=opus · 9 KB · tm8 file 01a1… (…) · bytes also at GET /media/AC12…]
[transcript (auto, hi): kal subah standup se pehle deploy check kar lena]
```

**Reference, not attach (`media.attach`).** By default (`"reference"`) the file is uploaded and its id is in the envelope, but the tm8
message is sent *without* `--attach`. Reason: tm8's chat runtime fails every chat turn whose triggering message has attachments. The
chat orchestrator passes the file ids to the harness as `attachmentRefs`, and `HarnessSessionBase.reserve` (packages/execution)
refuses any submit with `attachmentRefs.length > 0` ("Only nonempty text input is supported", `unsupported_capability`). The turn then
ends as `delivery_unknown` / `runtime_lost` ("Agent turn failed.") about 100 ms after the post. Seen 2026-10-19 on self-main:
user messages 01a153e5-14df… (turn 01a153e5-14f3…) and 01a153e5-7710… (turn 01a153e5-772a…). The orchestrator already writes an
`[attached N files …]` manifest into the prompt text, so the refs are redundant there. Once tm8 fixes that, `"attach"` gives the files
a chip in the UI again (and the envelope says "attached as tm8 file …").

**Quoted media.** When a routed message quotes an earlier image, document or voice note (e.g. "@tm8 what does this say?" as a reply
to a voice note), that file is uploaded and referenced too, with its own line:

```
[quoted attachment, from the quoted message ACF2…: voice note 0:03 · audio/ogg; codecs=opus · 5 KB · tm8 file 01a1… (…) · bytes also at GET /media/ACF2…]
[transcript of the quoted voice note 0:03 (auto, en): Hello, hello.]
```

A quoted message that is not in the log (sent before the bridge ran) is logged from the copy that WhatsApp includes in the reply
(media keys included) and downloaded then. A quoted file whose download failed is tried again (Baileys asks the phone to re-upload);
if that fails too, the line says `quoted voice note 0:03 could not be downloaded (<error>)` and the message is routed anyway.

**Voice-note transcription.** Every downloaded inbound audio (voice notes, audio files, and documents with an `audio/*` mime) is
transcribed in the background, one at a time, by whisper.cpp inside the container (`whisper-cli`, built in the Dockerfile; ffmpeg
decodes Ogg/Opus to 16 kHz WAV). Audio never leaves the box and no key is needed. The model is `data/models/ggml-small-q5_1.bin`
(multilingual whisper small, 5-bit quantised, 182 MB; `./scripts/fetch-model.sh [base|small|…]` fetches others; `base` was faster
but turned a 3 s English "hello" into Arabic). Without the model file the bridge logs a WARNING at start and envelopes say
`[transcript: failed (model … not found …)]`. Each run is killed after 2× the audio length + 30 s; audio longer than
`transcription.maxDurationSec` (default 10 min) is not transcribed (`[transcript: none, the audio is longer than the 10:00 limit]`).
The log text becomes `[voice note 0:12] transcript: <text>` (so `/search` finds the words). `/history`, `/search` and `/message` add
`duration_sec`, `voice_note` and `transcript: {status, text, lang, provider, error}` to audio media (`status`: `pending`, `done`,
`failed`, `too_long`, `disabled`).

Routing waits up to `transcription.waitSeconds` (20 s) for a running transcript. If it isn't done by then, the message is posted with
`[transcript: still running; it will follow as a separate message]` and, when it finishes, a second tm8 message goes to the same
target: `[whatsapp transcript · to: <name> · for wa_msg_id <id>, routed to you earlier]` + the transcript line (or why it failed).
A transcription cut off by a restart runs again at start (no follow-up then; the transcript lands in the log and the API).
A failed transcription is retried when someone quotes the voice note.

Speed on this host (8 vCPU EPYC, AVX2, 4 threads, image `wa-bridge`): see the numbers in the voice-note task report
(01a153e6-db18); roughly 11 s for a short note on a quiet box (whisper always encodes a 30 s window) and ~6 s per extra 10 s of audio.
Slower when the box is busy. `provider: "none"` turns it off (audio is still downloaded and referenced).

Unrouted media is downloaded but not uploaded. Over `media.maxBytes` (declared size, or the stream once it passes the cap) it is
not kept (`status: too_large`, envelope says so). A failed download (expired CDN link, undecryptable) is logged, never crashes,
is retried by the watchdog tick with backoff (1/2/4/8 min, up to 5 attempts within a day; Baileys asks the phone to re-upload old
media), and again on `GET /media/<id>`. If the tm8 upload fails 3 times the message is routed without the file and the
envelope says "not attached".

**Outbound.** `POST /say-media` (speaker token), same rules as `/say`: channel from the token, `idempotency_key` required,
`reply_to` + the session thread rule, rate limits shared with `/say`, queued (202) while disconnected, outbox id + pending-send
loop guard (the echo is matched on the hash of `[image] <caption line>` / `[document] <name> <caption line>`). Body:

- `multipart/form-data`: `file` (required), `caption`, `reply_to`, `idempotency_key`, optional `kind` (`image`|`document`), `mime`,
  `file_name`, `label`. No server-side paths.
- or `application/json`: `{"tm8_file_id": "…", "caption", "reply_to", "idempotency_key", …}` to forward a tm8 file (the bridge
  downloads it with its own tm8 token).

Mime: explicit `mime`, else sniffed from the bytes (PNG/JPEG/WebP/GIF/PDF), else the part's type, else the file extension. JPEG, PNG
and WebP ≤16 MB go out as images, everything else as a document; `kind=image` on anything else is a 400. Max `media.maxBytes`
(413). The caption gets the usual prefix (`tm8: …` / `Title (handle): …`; with no caption just `tm8:` / `Title (handle):`). Reply:
`{"wa_msg_id", "duplicate", "kind", "mime", "size", "file_name"}`. The sent file is kept as `data/media/<wa_msg_id>.<ext>`.

```bash
curl -s -X POST 127.0.0.1:8787/say-media -H "Authorization: Bearer $TOKEN" \
  -F file=@card.png --form-string caption='hello' -F idempotency_key="$(cat /proc/sys/kernel/random/uuid)"
```

(Use `--form-string` for text fields: `curl -F caption=@x` would read a file named x.)

**Reading.** `GET /media/<wa_msg_id>` (speaker token; only media in the token's channel, else 404) returns the bytes with the
stored mime and `Content-Disposition: attachment`. `/history`, `/search` and `/message` add
`media: {kind, mime, size, file_name, caption, status, tm8_file_id, url}` to media messages.

**Inject a media fixture.** `/admin/inject` takes `"media": {"kind": "image", "mime": "image/png", "file_name": "x.png",
"data_base64": "…"}` (body ≤2 MB); `text` is then the caption. It goes through download (from the fixture), upload and routing.
Audio: `{"kind": "audio", "mime": "audio/ogg; codecs=opus", "duration_sec": 7, "ptt": true, "data_base64": "…"}`. Audio has no
caption, so pass `quoted_wa_msg_id` of a bridge message to route it; it is transcribed like a real one. To test quoted media, inject
`{"text": "@tm8 …", "quoted_wa_msg_id": "<a logged media message>"}`.

Chats and sessions briefed before media existed: `docker exec wa-bridge node --import tsx src/admin.ts rebrief-media <name>`
prints the update to post to that name's tm8 entity; `rebrief-voice <name>` prints the voice-note/quoted-media update.

## The tm8 token, and token rotation

The bridge acts in tm8 as a human (needed for `chat start`). Put a long-lived token in `secrets/tm8-token`;
the file may contain other text, and the bridge extracts the first `tm8s_…` value. It re-reads the file when it
changes, so **no restart is needed** to add or rotate it:

```bash
install -m 600 /dev/stdin secrets/tm8-token <<< 'tm8s_...'   # or edit the file in place
docker logs --tail 5 wa-bridge                                  # "[poll] tm8 token found, starting to poll"
```

Until the file has a token, the bridge logs everything, serves the API, and answers a mention with
"tm8: link not configured yet" (at most once a minute per chat). When the token appears it creates (or adopts)
the main chat on the next poll. To rotate, write the new token and then revoke the old one in tm8.

Every token file is read the same way (a channel's own `tm8.tokenFile` too), and each one separately: a missing or invalid
token only affects the channels that use it (see "Add a group in another space").

**Expiry:** the bridge reads the token's expiry with `tm8 auth session` hourly (and right after the file changes) and shows
it as `tm8.token_expires_at` in `/health` (and per channel under `channels[].tm8`). This is done per token file. From 3 days
before expiry it logs `[expiry] WARNING …` hourly and posts one "tm8: heads-up: the tm8 link token expires …" notice in the
self chat (once per token; for a channel's own token it says "the tm8 token for <channel ids>" and names the file). The current token
(a `cli` session labelled `wa-bridge`) expires 2026-11-13T08:59Z.

## Speaker tokens

**Speaker tokens** (agents → bridge) are per name, 32 random bytes, stored in the database only as hashes, and revoked when
the name's session ends. The token itself is only in the name's **token file**, `tokens/<name>.token` (dir 0700, file 0600;
mounted into the container at the same host path, `/home/tm8/prod-data/wa-bridge/tokens`, so a briefing's path works for
agents too). Briefings and updates name the file (`TOKEN=$(cat …/tokens/<name>.token)`), never the token, and the bridge never
logs or prints one. A token never goes into a tm8 message: tm8 messages are visible to the whole space and every agent.

**Rotation of posted tokens.** Names briefed before token files had their token in a tm8 message. On its first poll the bridge
rotates each live one once: revoke, new token in the file, and a `[whatsapp bridge briefing update]` naming the file (kv
`token-file:<name>` marks a name done). A failed post is retried on the next poll with a fresh token. Log: `[tokens] rotated …`.

**Minting is operator-only.** Agents never mint or revoke tokens (briefings say so, and `issue-token` / `revoke` refuse without
the operator secret). The secret itself is never stored, only its sha256 in `secrets/operator-secret.sha256`. Set it once, on
the host (secrets/ is read-only in the container), from a password manager:

```bash
cd /home/tm8/prod-data/wa-bridge
read -rs S && printf '%s' "$S" | npx tsx src/admin.ts set-operator-secret; unset S   # refuses if one is already set
```

Operator tools (safe while the container runs):

```bash
docker exec wa-bridge node --import tsx src/admin.ts names                       # name, title, kind, status, teammate, tm8 id, parent
read -rs S                                                                        # the operator secret
docker exec -e WA_BRIDGE_OPERATOR_SECRET="$S" wa-bridge node --import tsx src/admin.ts issue-token <name>   # revoke + new token file; prints the path
docker exec -e WA_BRIDGE_OPERATOR_SECRET="$S" wa-bridge node --import tsx src/admin.ts issue-token operator # speaks as "tm8:" (tokens/operator.token)
docker exec -e WA_BRIDGE_OPERATOR_SECRET="$S" wa-bridge node --import tsx src/admin.ts revoke <name>
unset S
```

After `issue-token <name>` for a chat or session, tell it the file path (the path, never the token).

**Limits of the lockdown.** The container and the agent sessions run as the same uid (110, `tm8`), and that user is in the
`docker` group. So file permissions can't hide `data/` or `secrets/` from an agent that tries on purpose (it could write to
`bridge.sqlite`, or `docker exec` into the container). The operator secret stops the admin CLI, and the briefing rule stops
agents that follow their rules. Real isolation needs root: run the bridge as its own uid with `data/`, `secrets/` and `auth/` owned
by it (0700), tokens group-readable by `tm8`, and agents out of the `docker` group.

Keep backups private: they hold the WhatsApp session keys and the tm8 token.

## Agent API (summary)

Briefings carry only the essentials (a main chat's first message must stay under `chat start`'s 10000 characters; a test keeps
`briefMainChat` under 9000). The full reference with every example, media both ways and voice notes is the tm8 doc in
`config.json` `apiDocId` (currently `01a154c0-fe9f-7f51-8a3d-bb35d0ee76f3`, "WhatsApp bridge: API reference for chats and
sessions"); without `apiDocId`, briefings point at this file. After changing the API, refresh the doc from the code:

```bash
npx tsx src/admin.ts api-reference > /tmp/apiref.md     # no token in it
node -e "process.stdout.write(JSON.stringify({kind:'doc',body:require('fs').readFileSync('/tmp/apiref.md','utf8'),format:'markdown'}))" > /tmp/apiref.json
tm8 entity update 01a154c0-fe9f-7f51-8a3d-bb35d0ee76f3 --content @/tmp/apiref.json --expect-version <n>
```

All calls use `Authorization: Bearer <speaker token>`. The token decides the name and the group.
`POST /say {text, reply_to?, idempotency_key, label?, escalate?}` → `{wa_msg_id}` (`label`: ≤4 words, sets the name's title) (202 `{queued:true}` while disconnected; repeat key → same id; sessions must
reply in a thread addressed to them, except `escalate: true` without reply_to: a blocker, decision or question for the humans;
a main chat's `/say` that names a live session as "Title (handle)" with a reply_to grants that session the thread, a `granted` route the watchdog ignores) · `POST /react {wa_msg_id, emoji}` · `GET /history?before=&limit=` (≤200, `next_before` cursor) ·
`GET /search?q=&from=&since=&limit=` · `GET /message/:id` (+ quote chain) · `GET /names` · `POST /sync` · `GET /health` (no auth).
Errors are JSON `{error}`: 400 bad input, 401 token, 403 not addressed, 404, 429 `{retry_after_ms}`.

## Escalation rule (blockers reach WhatsApp)

Briefings tell main chats and sessions: blockers, decisions and questions for the human go to the originating WhatsApp chat via the
bridge, never only into tm8. Sessions use `POST /say` with `"escalate": true` (no reply_to needed). Main chats relay
`ESCALATE:` messages from their sessions and put the escalation route (bridge URL, launching chat id) into every spawn context.
Chats and sessions briefed before this rule: `docker exec wa-bridge node --import tsx src/admin.ts rebrief-escalation <name>` prints
the update; post it to the entity on the first line (`tm8 message send --to <id> --body @file`).

## Reply rule (main chats always answer on WhatsApp)

A main chat's briefing starts with RULE 1: every answer goes to the group via `POST /say`, never only into tm8.

**Fallback relay.** If a main-chat turn that came with `[whatsapp …]` envelopes ends (its reply has a `done` part) and none of
those messages got a `/say`, the bridge posts the turn's final text, the text after its last tool call (the narration before it is
dropped), as "tm8: …" on the last unanswered message's thread, and marks them answered (✅). Only turns for messages routed in the
last 30 min; once per turn (kv `relayed-turn:<turn id>`); nothing for the bare "sent <id>" marker. Text that looks like a credential
(speaker/tm8 tokens, API keys, private keys, JWTs) is never posted: the group gets "answered in tm8, but the answer looks like it
holds a secret". Log: `[relay] …`. The bridge reads the chat's newest 20 messages only when its turn state changes (or once a minute
while a message is open). That covers
WhatsApp messages (reply_to their wa_msg_id), messages typed straight into the tm8 chat (answered in the group too), and relayed session results. In tm8 the chat writes only the marker "sent <wa_msg_id>" (Subhang: no messages in the tm8 chat). Main chats briefed
before this rule: `docker exec wa-bridge node --import tsx src/admin.ts rebrief-reply <main name>` prints the update
(`--token-file <path>` names where the chat keeps its token, e.g. a hand-issued `.wa-token`; the file is not read); post it the same way.

## Delegate rule (main chats stay responsive)

RULE 2 in a main chat's briefing, right after RULE 1: every new piece of work gets a new task entity and a new worker session
(`tm8 session dispatch`; code work with `tm8 session spawn --launch-project <project> --workdir worktree`, so the worker starts in a
checkout), acked in the group via `/say`; follow-ups on an existing task go to that task's worker. Each task gets ONE `--mutation-id`,
reused on every retry, and before a retry the chat looks for a `working_on` work_session on the task (launches time out but still
start: four duplicate workers on 19 Oct). The chat does only
trivial work itself (status, quick lookups, `/say`, steering/stopping workers, relaying results; no repo edits, no multi-step
investigation). Main chats briefed before this rule: `docker exec wa-bridge node --import tsx src/admin.ts rebrief-delegate <main name>`
prints the update; post it the same way.
