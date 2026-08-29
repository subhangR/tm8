# Voice channels — from a fresh checkout to two tabs talking

Discord-style voice channels, on a self-hosted [LiveKit](https://livekit.io) SFU.
Design and rationale: `docs/features/voice/VOICE-CHANNELS-PLAN.md`.

**The one-sentence architecture:** the browser talks WebRTC directly to LiveKit;
tm8-server only signs a token saying who may join which room, and only relays the
participant roster. **No audio byte ever reaches tm8-server or Postgres.**

```
tm8-ui (:4612) ──REST /v2──► tm8-server (:4610) ──signs──► LiveKit JWT
     │                            ▲
     │                            └── POST /v2/voice/webhook ── LiveKit
     └──── WebRTC (ws :7880 + UDP 50000-50100) ────────────► livekit-server
```

---

## 1. Install the SFU

```sh
brew install livekit livekit-cli     # livekit-server 1.13.4, lk 2.18.2 (verified 2026-07-31)
livekit-server --version
```

Docker is the documented alternative if you would rather not install a binary;
everything below is identical apart from how you start it.

## 2. Start LiveKit

```sh
livekit-server --config docs/ops/livekit-dev.yaml
```

That config is checked in. Two things about it are worth knowing before you
substitute your own:

- **Do not use `livekit-server --dev`.** It gives you the same key pair and
  nothing else — critically, it has no way to declare a webhook URL, so the
  participant roster never reaches tm8. The symptom is nasty rather than
  obvious: audio works perfectly and the rail shows an empty channel that
  people are plainly talking in.
- **`devkey` / `secret` — the pair in every LiveKit quickstart and in tm8's own
  voice plan — does not work on 1.13.4.** The server refuses it with
  `secret is too short, should be at least 32 characters for security`, logs a
  stack trace, **and then carries on listening**. So the port answers `200`, the
  startup log looks healthy, and the first token you present fails for reasons
  nothing tells you. The checked-in config uses a 32-character dev secret.

Confirm it is up:

```sh
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7880/    # → 200
```

## 3. Point tm8-server at it

Three variables, **all three or none** — tm8-server refuses to start on a
partial set rather than minting tokens signed with `undefined`:

```sh
export TM8_LIVEKIT_URL=ws://localhost:7880
export TM8_LIVEKIT_API_KEY=devkey
export TM8_LIVEKIT_API_SECRET=tm8devsecret0123456789abcdefghij   # must match livekit-dev.yaml
```

With them unset, voice is simply off: `voice.token.create` answers a clear
"voice is not configured on this node" rather than a 500, and the webhook route
is not mounted at all.

**Which tm8-server?** `:4610` is a launchd-managed *installed snapshot* that lags
the working tree. If you are testing tree code, start your own on another port
(`TM8_PORT=…`), point the Vite proxy at it (`TM8_SERVER_ORIGIN`), and change the
webhook URL in `docs/ops/livekit-dev.yaml` to match — otherwise LiveKit will
faithfully deliver roster events to a server that does not have your code.

## 4. Start the UI

```sh
cd packages/tm8_ui_2.0 && bun run dev          # :4612
```

`packages/ui` (:4611) is the legacy oracle. Voice lives only in `packages/tm8_ui_2.0`.

## 5. Create a voice channel

Through the normal `+ New` authoring flow in a space, or over the API — it is an
ordinary entity create, no bespoke operation:

```sh
curl -sX POST http://127.0.0.1:4610/v2/entities \
  -H 'content-type: application/json' \
  -d '{"spaceId":"<space-uuid>","kind":"voice_channel","title":"general-voice"}'
```

The name follows the same slug grammar as text channels
(`^[a-z0-9][a-z0-9_-]{0,79}$`, lowercased and trimmed server-side), and is unique
per space.

## 6. Two participants

Tab A: open the space at `http://localhost:4612`, click the voice channel, join.

For the second participant, **prefer the CLI over a second tab on the same
machine** — two browser tabs sharing one microphone produce feedback that makes
it impossible to tell working audio from an echo:

**`--publish-demo` is VIDEO ONLY** — `lk room join --help` calls it "Publish demo
video as a loop", and the voice plan's suggestion to use it as an audio source is
wrong. Measured: it publishes a single `video/h264` track and no audio at all, so
tab A hears silence and you conclude voice is broken when it is not. Publish a
real Opus file instead:

```sh
# A 30s 440 Hz tone — unmistakable, and obviously not your microphone.
ffmpeg -f lavfi -i "sine=frequency=440:duration=30" -c:a libopus -b:a 32k tone-440hz.ogg

lk room join \
  --url ws://localhost:7880 \
  --api-key devkey --api-secret tm8devsecret0123456789abcdefghij \
  --identity <member-entity-id> --publish tone-440hz.ogg \
  <voice-channel-entity-id>
```

A second CLI participant needs **`--auto-subscribe`**: it defaults to
`AutoSubscribe: false`, so without the flag it connects, appears in the roster,
and receives no media — which looks exactly like broken audio.

```sh
lk room join --url ws://localhost:7880 \
  --api-key devkey --api-secret tm8devsecret0123456789abcdefghij \
  --identity listener --auto-subscribe <voice-channel-entity-id>
```

You have working two-way audio when the listener logs
`track subscribed {"kind": "audio", "participant": "<the publisher's member id>"}`.

**The room name IS the voice_channel entity id.** There is no mapping table; the
graph and the SFU share one namespace.

---

## Verifying it actually works

```sh
# Token minting + webhook signature verification (pure, fast)
cd packages/server && ./node_modules/.bin/vitest run --no-file-parallelism test/voice/

# DB layer: creation, RLS, content hydration, idempotency
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_voice_scratch node db/test/voice-channels.mjs
```

`test/voice/livekit-webhook.live.test.ts` spawns a **real** `livekit-server`,
drives a **real** participant in with `lk`, and asserts the roster changed. It
skips (loudly) when the LiveKit binaries are absent. It exists because the unit
tests can only prove the verifier agrees with *this repo's belief* about how
LiveKit signs a webhook — if that belief were wrong, they would pass and every
real callback would be silently rejected.

## Things that will waste your afternoon

- **Roster empty, audio fine.** The webhook is not arriving or not verifying.
  Check `webhook.urls` in the LiveKit config points at the server you are
  actually running, and that `api_key`/secret match the tm8 env exactly. The
  server logs `[voice] webhook rejected: <reason>` for every refusal — a silent
  absence means the callback never arrived at all, which is a URL problem, not a
  signature one.
- **Joining fails with no visible reason.** Almost always the token. It is
  minted with a 10-minute TTL and spent at connect time; if your clock is far
  off, `nbf`/`exp` will bite (the token back-dates `nbf` by 60s to absorb normal
  skew, not minutes).
- **Works on localhost, fails between machines.** Set `use_external_ip: true` in
  the LiveKit config so the SFU advertises an address the other host can reach,
  and open the UDP range (50000-50100). LiveKit's embedded TURN covers most
  NAT cases once it knows its own address.
- **`pg_isready` says the database is fine and nothing works.** The dev Postgres
  sidecar is on **:5442** and reports ready while auth is failing. Pass explicit
  host/port; there is more than one cluster on a typical dev machine.

## Deploying beyond localhost

Not automated, deliberately. What changes:

- LiveKit behind TLS: `wss://`, embedded TURN with TLS on 443 (so it survives
  restrictive corporate networks), real generated keys
  (`livekit-server generate-keys`) supplied via the environment.
- `TM8_LIVEKIT_URL` points at the public `wss://` URL — it is handed to browsers
  verbatim.
- The webhook URL must reach tm8-server, which **binds loopback only by design**
  (10-SECURITY S1). Co-locate the SFU with tm8-server, or terminate the webhook
  on something that can.
