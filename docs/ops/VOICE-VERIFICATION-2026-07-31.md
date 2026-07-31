# Voice channels — what was actually verified, 2026-07-31

Session `sess_1785457174459_hdp7vrenm`, task `task_1785455843956_v7p4zpymk`.
Raw artifacts: `~/Desktop/tm8-voice-evidence/` (hashed in `SHA256SUMS.txt`
there; the empty-input control `e3b0c442…` differs from every digest, so the
digests are of real content).

Migration chain identity at time of writing: `5c00e1dc8353c93c`
(`cd db/migrations && shasum -a 256 *.sql | shasum -a 256 | cut -c1-16`).

## Proven

| Claim | How | Result |
|---|---|---|
| Migration 053 applies through the real runner | `db/migrate.mjs reset --force` on a scratch DB, full chain incl. other lanes' 055/056/057 | applied; ledger row written |
| The `voice_channel` content-hydration arm survives all four lanes' `create or replace` of `internal.entity_content` | `pg_get_functiondef` against the live database, not grep | 19 arms present, `voice_channel` among them |
| A low-privilege caller can create a voice channel, and a non-member cannot | `db/test/voice-channels.mjs`, run as `tm8_app` through the real RPCs | 16/16 PASS |
| **A non-member cannot obtain a token** | same file; the authorization SQL is **read out of `facade/services/voice.ts` at test time**, so the test cannot drift from the shipped query | member resolves the row, non-member resolves nothing |
| Token shape is what LiveKit reads | `test/voice/livekit-token.test.ts` decodes the JWT and re-derives the HMAC | 13/13 PASS |
| **The webhook verifier accepts REAL LiveKit callbacks** | `test/voice/livekit-webhook.live.test.ts` spawns a real `livekit-server`, drives a real participant in with `lk`, asserts the roster changed | 2/2 PASS (join and leave) |
| …and that green is not vacuous | re-ran the same test with a deliberately wrong API secret | RED: `[voice] webhook rejected: bad signature` ×3, roster 0 |
| projector ↔ entity-read parity for the new kind | `test/events/projector-entity-read-parity.test.ts`, with `voice_channel` removed from `IN_FLIGHT_KINDS` | 6/6 PASS |
| Two participants exchange real audio over the SFU | two `lk` clients in a room **named by the voice_channel entity id**; publisher sends a 440 Hz Opus track, listener `--auto-subscribe` | listener logged `track subscribed {"kind":"audio","participant":"<publisher's member entity id>"}` |

### Added later the same day, once `build:server` started passing

`bun run build:server` was failing on other lanes' in-flight work for most of
this session, which blocked booting a tree server. It now exits 0, so the
HTTP-level gap below was closed:

| Claim | How | Result |
|---|---|---|
| A tree server boots with voice configured | `TM8_PORT=4699` + the three `TM8_LIVEKIT_*` vars, fresh scratch DB | `/health` → `{"ok":true,…,"db":"ok"}` |
| `entities.create` accepts the new kind **over HTTP** | `POST /v2/entities` with `kind: "voice_channel"` | created, id returned |
| `voice.token.create` works **over the wire** | `POST /v2/entities/:id/commands/voice-token` | grant returned; decoded JWT carries `iss=devkey`, `sub=<member entity id>`, `video.room=<voice_channel entity id>`, `roomJoin/canPublish/canSubscribe` |
| room name really is the entity id | compared the grant's `roomName` to the created entity id | equal |
| **The real SFU accepts a tm8-minted token** | raw WebSocket upgrade to `ws://127.0.0.1:7880/rtc?access_token=<the token tm8-server signed>` | **101 Switching Protocols** |
| …and that is not vacuous | same request with one character of the signature flipped | **401** |

The 101/401 pair is the load-bearing one: LiveKit itself, not a tm8 test,
adjudicates whether the token this server signs is valid for a real signalling
session.

Instruments named, per repo practice: server suites ran as
`cd packages/server && ./node_modules/.bin/vitest run --no-file-parallelism`,
banner `RUN v2.1.9 …/packages/server`.

## NOT proven — read this before believing the feature is done

- **The browser has never joined a room.** The audio proof above is CLI-to-CLI
  through the SFU. It establishes that the SFU, the room-naming contract, the
  token and the roster webhook all work; it does **not** establish that the tm8
  UI can join, because the UI cannot yet — see the seam item below.
- ~~No HTTP-level test of `voice.token.create`.~~ **Closed** — see the table
  above. It was blocked while `build:server` failed on other lanes' work.
- **The rail's participant count is always 0 today.** `projector.stateOf` and
  `entity-read` return `participantCount: 0` with a comment saying why: the
  roster is in server memory and neither assembler can reach it. Wiring the live
  count is follow-up work, not a bug in what landed.
- **`voice.participants.changed` reaches the socket but nothing in the UI
  consumes it.** Worse, it is currently *admissible* where it should not be:
  `packages/tm8-ui/src/data/real/socket.ts` drops `presence.changed` and
  `typing.changed` before dispatch but does **not** drop
  `voice.participants.changed`, which carries `spaceId` and `seq` and so parses
  as a durable event and lands on `reduceEvent`'s no-op default. The contract
  says it must never ride the durable stream. That fix belongs with the seam
  work below.

## Blocked, deliberately

`createVoiceToken` + `onVoiceParticipants` on `packages/tm8-ui/src/data/seam.ts`
require a **dual FE+bridge re-consensus** (LLD §10.2.6 / §10.7). I did not edit
the seam. Following the existing precedent for `handoffs.send`,
`spaces.menu.update` and `spaces.home`, both are now registered in the §10.7
deferred-amendment table with their interim rendering, and the voice room
renders as an honest unbuilt surface rather than a dead join button.

Everything downstream of that stamp — the LiveKit `Room` store, the join
control, the in-voice bar — is genuinely blocked on it, because the token is the
only way into a room and the seam is the only sanctioned path to the token.
