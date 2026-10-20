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

A second number runs as a second container (instance `9494`: +91 …9494, the tm8 and lvlup groups, port 8788), see
"Another WhatsApp number (instances)". The main container now holds only the self chat.

**Only one process may hold a WhatsApp connection (per number).** Never run `npm start` on the host while the
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
  "watchdogMinutes": 10,         // 👀 → ⚠️ after this long without a reply (reaction only; nothing is posted)
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
      "style": "casual & short",                     // optional, one line ≤300 chars: how agents talk here; on every envelope as [style: …] and in briefings; default: short and readable
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
| A channel's main chat, operator tokens, and the bridge's own notices (command replies, expiry, "link not configured") | `tm8: <text>` |
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

Every envelope gets one more line right under the header, `[style: …]`, so the agent sees the tone rule on each message,
not only in its briefing (main chat and session briefings also get a "## Keep it short" section). It is guidance only:
the bridge doesn't cap length (beyond WhatsApp-safe 4000 characters). The style is the channel's `style`, else the built-in default (`DEFAULT_STYLE` in src/config.ts:
"short and readable: lead with the answer, keep it to a few short lines, plain everyday words, no ids …"). Why: a group member said
on 20 Oct the messages were getting too hard to read; bot messages then ran 570 characters median, up to 3700.

```
[whatsapp "Gaming" · from "Rahul" +91…9999 (UNTRUSTED group member) · to: gaming-main · wa_msg_id 3EB0…]
[style: casual & short]
---
@tm8 who's up for a match
```

Changing `style` needs a redeploy (`./scripts/deploy.sh [<inst>]`); envelopes apply at
once, briefings only for chats and sessions briefed after that. For ones briefed before:
`docker exec wa-bridge node --import tsx src/admin.ts rebrief-style <name>` prints the update; post it to that chat/session.

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

## Test hook: inject a message

`POST /admin/inject {text, channel?, quoted_wa_msg_id?}` feeds a synthetic owner message (id `TEST-…`) through the
normal inbound path (log, loop guard, routing) as if the owner had typed it. Nothing appears on WhatsApp except the
agents' replies, and the bridge doesn't react to `TEST-` ids. The admin token is in `data/admin-token` (0600, created at first start):

```bash
ADMIN=$(cat data/admin-token)
curl -s -X POST 127.0.0.1:8787/admin/inject -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"text": "@tm8 hello from a test"}'      # → {"wa_msg_id": "TEST-…", "routes": [{"target": "self-main", "status": "posted"}]}
```

## Add a group

1. Find its JID. This needs the connection, so stop that number's container first, then do a one-off listing with the same auth:
   ```bash
   docker stop wa-bridge && ./scripts/link.sh main --list-groups     # instance: docker stop wa-bridge-<inst> && ./scripts/link.sh <inst> --list-groups
   sleep 20; docker rm -f wa-bridge-link; docker start wa-bridge     # → data/groups.json (instances/<inst>/data/groups.json)
   ```
   (Don't list groups in normal runs.) This doesn't send anything.
2. Add a channel to that number's `config.json` (a group lives on one number only, see "Another WhatsApp number"): `id`, `jid` (`…@g.us`), `title`, `allowedSenders` (owner + named members), and optionally
   `teammate`/`model`/`mainChatId`.
3. `./scripts/deploy.sh`. On the next poll the bridge creates "<title> (WhatsApp)" as the main chat (name `<id>-main`) and briefs it.
In groups, `@tm8` also triggers when someone uses WhatsApp's real @mention of our number.

## Add a group in another space

A channel can live in a tm8 space other than the global `tm8.spaceId`: its main chat, its sessions' names and briefings,
`@tm8-<teammate>` matching and media uploads all go to that space. Every tm8 call for the channel passes `--space <spaceId>`.
Names stay unique across the whole bridge. There are two ways to reach the space:

**A. Through a space link, with the global token (no new token).** The tm8 space has a link to the target (`tm8 link list`
shows `→ <space id>: signed_in …`). Set only `tm8.spaceId` (and the teammate). The CLI then runs with the global token,
`TM8_SPACE_ID` = the global space, `--space` = the target. Through a link tm8 refuses some operations
(`/opt/tm8/prod/packages/contract/src/space-links.ts`, `SPACE_LINK_REFUSED`):
- `chat.start` (process_start): the bridge can't create the main chat. Create a chat in the target space in the tm8 UI
  (the channel's teammate, mode orchestrate) and put its id in the channel's `mainChatId`. The bridge adopts it as
  `<id>-main` and posts the briefing into it. Until then `/health` shows `chat start is not allowed through a space link …` for
  the channel, and `@tm8` there gets "the main chat for this group is not ready yet". `/new` needs option B.
- `files.uploadInit` (grant): images, documents and voice notes are routed without a tm8 file: the envelope says
  `not attached (upload to tm8 failed: file upload is not allowed through a space link …)` and the bytes are at `GET /media/<id>`.
- `auth.*`: the expiry check runs `tm8 auth session` without `--space` (it's the global token anyway).
The link session has its own expiry (`tm8 link list`, "signed_in until …"). When it lapses, calls into that space fail and
`/health` shows the error on that channel only. Subhang signs in again in the link settings.

**B. A token pinned to that space (`tm8.tokenFile`).** Everything works there, including `chat start`, uploads and `/new`. The token
belongs to Subhang (a human session: `chat start` is human-only). Make it on the host, in the repo directory:

```bash
read -rs P                                                                       # Subhang's tm8 password, not echoed
GATE=$(tm8 auth login subhang --password "$P" --kind cli --label wa-bridge-lvlup --print-token | grep -o 'tm8s_[A-Za-z0-9_.-]*'); unset P
TM8_AGENT_TOKEN="$GATE" tm8 auth space enter <space id> --label wa-bridge-lvlup --print-token \
  | grep -o 'tm8s_[A-Za-z0-9_.-]*' | install -m 600 /dev/stdin secrets/tm8-token-lvlup
TM8_AGENT_TOKEN="$(cat secrets/tm8-token-lvlup)" tm8 auth session            # session.spaceId = <space id>, note expiresAt
```

Tokens contain a `.`: a pattern without it (`tm8s_[A-Za-z0-9_-]*`) cuts the token and the space enter fails with "invalid token". `auth space enter` mints a session pinned to that space from the unpinned (gate) session. `--print-token` stores nothing and prints it.
The pinned session expires no later than the gate session. A space with a space password needs `--space-password`. Keep or revoke
the gate session afterwards (it isn't used by the bridge). The file is read like `secrets/tm8-token` (first `tm8s_…`, re-read on change, no restart).

**Channel entry.** Then add the channel (`allowedSenders: ["everyone"]` lets any member trigger agents; `/stop` and `/new` stay owner-only):

```json
{
  "id": "lvlup",
  "jid": "120363000000000002@g.us",
  "title": "lvlup + autograde",
  "allowedSenders": ["everyone"],
  "mainChatId": "<chat id created in the lvlup space (option A); omit with option B>",
  "tm8": {
    "spaceId": "019fea87-7f2e-73c6-989f-8fdf9410cbbb",
    "defaultTeammate": "019fea87-7f4e-7836-a3c1-e77ebbb3ef5f",
    "tokenFile": "secrets/tm8-token-lvlup"
  }
}
```

(`tokenFile` only with option B.) Teammate ids are per space, so set `tm8.defaultTeammate` (or `teammate`) to a teammate of
that space (`tm8 --space <space id> teammate list`). The global default isn't there. `./scripts/deploy.sh`, then check
`curl -s 127.0.0.1:8787/health | jq '.channels[] | {id, main_chat_id, tm8}'` and `docker logs wa-bridge | grep -E '\[(tm8|main|poll)\]'`.
A channel whose token file is missing or invalid is log-only (mentions get "tm8: link not configured yet") and doesn't affect the others.

## Commands in a chat (strict, whole message)

`/who` · `/status <name>` · `/help` (any allowed sender) · `/stop <name>` (owner: stops the tm8 session, ends the name)
· `/new` (owner: new main chat = new epoch. The old chat is asked to send a summary to the new one, and `@tm8` goes to the new chat).

## Re-link (device logged out)

Symptoms: `/health` → `wa.state: "logged_out"` (the container stays up and doesn't crash-loop) or `not_linked`.

```bash
docker stop wa-bridge
mv auth auth.dead-$(date +%F)            # keep it until the new link works, then delete it
docker run --rm -it --network host --user 110:114 -v $PWD/auth:/app/auth -v $PWD/data:/app/data \
  -v $PWD/config.json:/app/config.json:ro -v $PWD/secrets:/app/secrets:ro -v /opt/tm8/prod:/opt/tm8/prod:ro \
  wa-bridge node --import tsx src/main.ts --link
# Pairing code is printed (and written to data/pairing-code.txt) when config.pairingPhone is set; otherwise a QR
# (terminal + data/qr.png). On the phone: WhatsApp › Linked devices › Link a device. Wait for "[wa] connected", Ctrl-C.
./scripts/deploy.sh
```

For an instance: `docker stop wa-bridge-<inst>`, move `instances/<inst>/auth` aside, `./scripts/link.sh <inst>`, `./scripts/deploy.sh <inst>`.
Only `--link` mode may pair or reset unlinked keys. The normal container never touches `auth/` except to save updated creds.

## Stop / start

```bash
docker stop wa-bridge      # stays stopped (unless-stopped) across reboots until started
docker start wa-bridge
```

Restarts (`docker restart`, a crash, host reboot) reconnect with the saved device, with no re-link. `/say` calls while
WhatsApp is down return `202 {"queued": true}` and are sent in order on reconnect.

## Backup

`auth/` is the identity, and losing it means re-linking. Each instance has its own `instances/<inst>/auth` and `data/`: back them up the same way (`docker exec wa-bridge-<inst> …`). `data/bridge.sqlite` is the history and name registry.

```bash
ts=$(date +%F-%H%M); mkdir -p ~/backups
docker exec wa-bridge node -e "require('better-sqlite3')('/app/data/bridge.sqlite').backup('/app/data/backup-$ts.sqlite').then(()=>console.log('ok'))"
tar czf ~/backups/wa-bridge-$ts.tgz auth config.json secrets data/backup-$ts.sqlite && chmod 600 ~/backups/wa-bridge-$ts.tgz
rm data/backup-$ts.sqlite
```

Keep backups private: they hold the WhatsApp session keys and the tm8 token.

## Another WhatsApp number (instances)

One container holds one number. A second number runs as a second **instance**: the same repo code and image, its own
state under `instances/<inst>/` (gitignored, not in the image), its own container and port.

| | Main bridge | Instance `9494` |
|---|---|---|
| Number | +91 …1999 (the owner's phone) | +91 …9494, linked 2026-10-19 |
| Channels | `self` (Subhang's self chat) | `tm8` (group "tm8" → tm8 space) · `lvlup` ("lvlup + autograde" → lvlup 019fea87…, Opus 5 1M Teammate) · `gaming` ("🕹️Gaming 🕹️" → kiritivity-hackers 01a1556a…, Coordinator) · `zealots` ("Singularity Zealots" → Hustle 01a025f3…, Opus 5.5 1M Teammate). Each non-tm8 channel has its own pinned token `secrets/tm8-token-<id>` (expire 2027-01-17); allowedSenders "everyone" on all four |
| State | `auth/`, `data/`, `tokens/`, `config.json` in the repo root | `instances/9494/{auth,data,tokens,config.json}` |
| Container / API | `wa-bridge` / `127.0.0.1:8787` | `wa-bridge-9494` / `127.0.0.1:8788` (`http.port` in its config) |
| Deploy | `./scripts/deploy.sh` | `./scripts/deploy.sh 9494` |
| Logs / admin | `docker logs wa-bridge`, `docker exec wa-bridge …` | `docker logs wa-bridge-9494`, `docker exec wa-bridge-9494 …` |

Shared by every instance: `secrets/` (read-only: the global `secrets/tm8-token` and per-channel `secrets/tm8-token-<id>`
files; rotate a token once and every bridge that uses it re-reads it) and the whisper models (`data/models`, mounted read-only).
`deploy.sh` builds the image once from the repo; after a code change, deploy every instance (`./scripts/deploy.sh && ./scripts/deploy.sh 9494`).
Each instance has its own database, names and speaker tokens. Its briefings carry its own URL (`:8788`) and token dir.

Rules:
- **A group is served by exactly one number.** If two bridges have the same group as a channel, every `@tm8` there is routed twice.
  To move a group, remove it from one config and add it to the other, and deploy both back to back.
- An instance without a self chat (the number is not the owner's phone) learns its own JIDs on connect; `ownerJids` stays
  Subhang's personal number (PN + LID), so his messages in the groups count as the owner's. `@tm8` and a real WhatsApp
  @mention of the instance's number both reach the main chat; mentioning Subhang does not.
- Without a self chat there is no place for the token-expiry notice: an instance only logs `[expiry] WARNING …`
  (`docker logs wa-bridge-9494 | grep expiry`). The main bridge's self chat gets the notice for tokens it uses itself.
- A group's existing main chat can move with it: set `mainChatId` to the chat id. The new bridge adopts it as `<id>-main`
  and re-briefs it and the live sessions it launched (new names and token files from the new instance).

**Add a number.**
```bash
mkdir -p instances/<inst> && cp config.json instances/<inst>/config.json
# edit it: pairingPhone = the new number (digits), http.port = a free port (8789, …), channels = its groups (ownerJids unchanged)
docker build -t wa-bridge:latest .
./scripts/link.sh <inst>                       # detached link container; the pairing code is in its logs and data/pairing-code.txt
docker logs -f wa-bridge-<inst>-link            # the phone with THAT number: Linked devices › Link a device › Link with phone number
docker rm -f wa-bridge-<inst>-link              # after "[wa] connected as <number>"
./scripts/link.sh <inst> --list-groups && sleep 20 && docker rm -f wa-bridge-<inst>-link   # instances/<inst>/data/groups.json
./scripts/deploy.sh <inst>
```
Enter the code within about 2 minutes. When the code expires or the phone rejects it, the link container may end up `LOGGED OUT`.
Then `docker rm -f` it, move `instances/<inst>/auth` aside (`auth.failed-<time>`, never delete a working one) and run `link.sh` again for a new code.
The first attempt on 2026-10-19 failed that way ("Invalid buffer" in the companion-registration notification, then 408 and 401); the second code linked fine.

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
