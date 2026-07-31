# Voice Channels for tm8 — Implementation Plan

**Date:** 2026-07-31 · **Author:** planning session (sess_1785455261160_uxhvc5x4h) · **Status:** ready for implementation

## 0. Requirement

Discord-style voice channels. A user opens a space ("server"), sees a voice channel in the rail alongside text channels, clicks join, another user joins the same channel, and they talk to each other in real time — including across networks (remote, behind NAT), not just localhost. Self-hosted, open-source stack only.

**v1 scope:** audio only (no video, no screenshare), join/leave, self-mute, participant roster visible from the rail, active-speaker highlight inside the room. Everything else is out of scope.

## 1. Stack selection: LiveKit

Candidates evaluated: LiveKit, mediasoup, Janus, Jitsi Videobridge.

| | LiveKit | mediasoup | Janus | Jitsi |
|---|---|---|---|---|
| Deploy | Go, **single binary** or Docker | C++/Node lib — you build the server app | C, plugins | JVM, part of Jitsi Meet |
| Signalling | **Built in** (rooms, participants, reconnect) | None — you write it | Partial | Tied to Jitsi Meet UX |
| Client SDK | `livekit-client` (TS), React hooks | Raw WebRTC | Thin shim | Jitsi UI |
| NAT traversal | **Embedded TURN** | BYO coturn | BYO | Bundled, conference-shaped |
| Auth | JWT minted by your server | DIY | DIY | Awkward standalone |
| License | Apache 2.0 | ISC | GPLv3 | Apache 2.0 |
| Scale (4vCPU/16GB) | ~200+ participants | best per-CPU | good | ~75–100 |

**Decision: LiveKit.** Rooms map 1:1 to voice channels — join/leave, roster, mute, and active-speaker are SDK primitives. mediasoup/Janus would make us hand-write a signalling protocol, reconnection, and TURN for zero product benefit; Jitsi is a competing product, not an embeddable engine. LiveKit is Apache-2.0, one binary with embedded TURN (covers "works remote"), and its JWT model keeps tm8-server as the sole authority on who joins which channel. It's the highest-momentum OSS SFU in 2026.

Research sources: [BlogGeek.me SFU survey 2026](https://bloggeek.me/webrtc-tools/media-servers-oss/), [Forasoft SFU comparison](https://www.forasoft.com/learn/video-streaming/articles-streaming/sfu-comparison-mediasoup-janus-livekit-jitsi-pion), [Trembit LiveKit/mediasoup/Janus](https://trembit.com/blog/choosing-the-right-sfu-janus-vs-mediasoup-vs-livekit-for-telemedicine-platforms/), [LiveKit self-hosting docs](https://docs.livekit.io/home/self-hosting/local/).

**Packages:**
- Media/signalling server: `livekit-server` binary (dev: `livekit-server --dev` → ws on `:7880`, key `devkey` / secret `secret`).
- UI: **`livekit-client` only** (no `@livekit/components-react` — tm8-ui is custom Zustand-driven UI; wrap the SDK in a small store instead, matching codebase idiom).
- Server tokens: LiveKit access tokens are plain HS256 JWTs. `@tm8/server` deliberately has only two runtime deps (`pg`, `zod`). **Preferred: mint the JWT with `node:crypto` (~25 lines, claims: `iss`=API key, `sub`=identity, `exp`, `video: {roomJoin, room, canPublish, canSubscribe}`)** to keep the dep budget at zero. Fallback if the hand-rolled token misbehaves: add `livekit-server-sdk`.

## 2. Architecture

```
tm8-ui (:4612) ──REST /v2──► tm8-server (:4610) ──mints──► LiveKit JWT
     │                            │ RLS: is_space_member + voice_channel exists
     │                            ◄──webhook POST /v2/voice/webhook── LiveKit
     └──WebRTC (ws :7880 + UDP)──► livekit-server (SFU, embedded TURN)
Roster fan-out: webhook → ephemeral workspace event → existing /v2/ws → all space members
```

- **Audio never touches tm8-server.** Browser connects directly to LiveKit with the minted token. tm8's `/v2/ws` carries only roster/ephemeral events. No new control frames, no new upgrade branch in `main.ts`.
- **Room name = voice_channel entity id.** Participant identity = the caller's member entity id; display name in token metadata.
- **Token endpoint** authorizes with the exact tuple RLS already gates channels on: `identity_id` + member entity id + `space_id` + target `voice_channel` id. Loopback auto-owner identity resolution (`packages/server/src/identity/loopback.ts`) provides `ctx.identity` today; the token service is written against that seam so bearer auth (S8) slots in later.
- **Roster**: LiveKit webhooks (`participant_joined`/`participant_left`, signed JWT in `Authorization` header, verify with same key/secret) hit tm8-server, which broadcasts an **ephemeral** event modeled on `presence.changed` (channel-local seq, in-memory store, resets on restart — see `InMemoryPresenceStore`). Rail badges and in-room roster both read it. Degradable: if webhooks fight back in dev, v1 fallback is client-published presence frames while connected (existing presence pattern); note which one shipped.

## 3. Work breakdown

### Phase 1 — Contract + DB (the frozen layer)
1. `packages/contract/src/schemas.ts`: add `'voice_channel'` to `CoreEntityKindSchema` (line ~83); add summary DTO arm (`{kind:'voice_channel', name, participantCount?}`) near channel summary (~153) and detail arm (~377). Mirror in `packages/contract/src/contract.ts` (~32).
2. `packages/contract/src/contract.ts` event union (~381–406): add ephemeral `voice.participants.changed` `{voiceChannelId, spaceId, participants: [{memberId, name, muted?}]}` alongside `presence.changed`.
3. `packages/contract/src/catalog.ts`: add `voice.token.create` (POST, params: voice channel entity id) and the webhook op (or register the webhook route outside the catalog if the catalog is client-ops-only — follow whatever `events.subscribe` (line ~136) does for non-entity ops). **The catalog is frozen-with-amendments — follow the amendment pattern that `packages/contract/test/w1-amendment.test.ts` enforces; do not hand-edit past amendments.**
4. New migration: **re-run `ls db/migrations | sort | tail` immediately before claiming a number** (highest on disk was `051`, but numbers race across parallel sessions and create-or-replace lets a later file silently win). Contents, modeled on `channel` in `001_core_graph.sql`: seed `entity_kinds` with `voice_channel`; `public.voice_channels` detail table (`entity_id PK, space_id, name`); `validate_detail_envelope('voice_channel')` trigger; content-hydration `case` (001:~1103 pattern); `internal.create_envelope` support (007:~1067 pattern).
5. Run the exhaustiveness suites (`packages/cli/test/catalog-exhaustiveness.test.ts`, `packages/contract/test/w1-strict-schemas.test.ts`) — they fail loudly until every layer agrees; that's the guardrail, not an obstacle.

### Phase 2 — Server
1. Config: `TM8_LIVEKIT_URL` (client-facing ws URL), `TM8_LIVEKIT_API_KEY`, `TM8_LIVEKIT_API_SECRET`; read in `main.ts` composition root; voice ops return a clear "voice not configured" error when unset.
2. Token service under `packages/server/src/facade/services/` (+ handler wired like `facade/handlers/entities.ts`): verify caller is a space member and target entity is kind `voice_channel` in that space (RLS does most of this — a `SELECT` through the caller's claims that returns the row *is* the authorization), then mint JWT (TTL 10 min — only needed at connect), return `{url, token, roomName, identity}`.
3. Webhook receiver: verify LiveKit's JWT signature, translate `participant_joined/left` → update in-memory voice roster store → emit `voice.participants.changed` through the existing pump/control channel path (mirror how `presence.changed` flows; hydration seam is `events/projector.ts`, but ephemeral events likely bypass it — copy presence's exact path).
4. Projector case for `voice_channel` entity upsert/delete (`packages/server/src/events/projector.ts`) so create/rename/delete reach the UI like any entity.
5. `voice_channel` creation needs no new op — `entities.create` (`POST /v2/entities`) handles new kinds once Phase 1 lands; verify the create path in `facade/services/w2/entities-commands-tracking.ts` doesn't allowlist kinds.

### Phase 3 — Infra / dev loop
1. `brew install livekit` (or Docker); document `livekit-server --dev --bind 0.0.0.0` in `docs/ops/` alongside whatever server-run docs exist. Dev values: url `ws://localhost:7880`, key `devkey`, secret `secret`.
2. Webhook config: LiveKit config yaml `webhook: {urls: ["http://127.0.0.1:4610/v2/voice/webhook"], api_key: devkey}` — dev-mode may need a config file instead of `--dev`; document what actually worked. tm8-server binds loopback, LiveKit runs on the same host, so this reaches it.
3. Remote deployment note (docs only, no automation): LiveKit behind TLS (`wss`), embedded TURN with TLS on 443, real key/secret; tm8 `TM8_LIVEKIT_URL` points at the public wss URL.

### Phase 4 — UI (`packages/tm8-ui`)
1. `bun add livekit-client` in `packages/tm8-ui`.
2. New `src/voice-channel/` mirroring `src/channel-screen/` structure: `VoiceRoomScreen.tsx` (roster tiles, active-speaker ring, mute/leave buttons), `LazyVoiceRoom.tsx`, `voice-store.ts` (Zustand store wrapping `livekit-client` Room: connect with token, track participants, `setMicrophoneEnabled`, ActiveSpeaker events, disconnect on leave/unmount).
3. Routing: add `'voice'` to `ContentSurface` in `src/shell/nav-port.ts`; add a center-surface branch in `src/views/GateApp.tsx` `CatchBoundary "view"` block (~362–500) next to the `ChannelView` branch.
4. Rail: map `data.rowsFor('voice_channel')` into a dynamic group in `GateApp.tsx` (~236) with a speaker icon (channels use `icon:'#'`); show participant count/names under the row from `voice.participants.changed` events (Discord-style). Click = navigate + join.
5. Persistent in-voice bar while navigating elsewhere: model on `src/shell/LiveSessionBar.tsx` (mute/leave from anywhere).
6. Data seam: add `createVoiceToken` + `onVoiceParticipants` to `src/data/seam.ts` and implement in `src/data/real/{http,ops,socket}.ts`, event flow via `useGateData.ts` → `domain-store.ts`. **⚠️ `seam.ts` is dual-consensus governed (bridge+FE co-owned; see tm8-ui build plan §10.7 re-consensus register / D1–D10). Follow the governed change process — do not casually edit. If the process is unclear, do every other UI step first and report blocked on the seam step rather than bypassing it.**
7. `+ New` authoring flow: voice channels are created via the existing `entities.create` authoring lane — add `voice_channel` to whatever kind picker the "+ New" flow exposes.

### Phase 5 — Verification (do not skip; "status=running is not a started agent" applies to media too)
1. Contract/exhaustiveness/integration suites green (run per `docs`/repo test instruments — `bun run test`; test files typecheck separately, and migration landing must be *proven*, not assumed — hash/verify per repo practice).
2. Token authz test: non-member of the space gets a denial, member gets a token whose decoded claims name the right room.
3. **Live two-participant audio proof:** tab A (Chrome, `localhost:4612`) joins; second participant via `lk room join --publish-demo` CLI (avoids dual-mic feedback) or a second browser profile. Assert: both appear in roster (in-room and in the rail), audio audible, mute reflected, leave clears roster. Record what was observed, honestly.
4. Verify against the **tree** server you started, not :4610 — :4610 is a launchd-managed *installed snapshot* that lags the tree independently in server/UI halves. The Vite dev server on :4612 proxies `/v2` to :4610 by default; point the proxy (or env) at your tree server's port for verification.

## 4. Acceptance criteria
- [ ] A voice channel can be created in a space via the normal + New flow and appears in the rail with a speaker icon.
- [ ] Two participants in the same voice channel hear each other (proven live, per Phase 5.3, including one participant not on the same machine loopback — LAN or TURN path exercised at least once).
- [ ] Rail shows who is in the channel without joining; updates within ~2s of join/leave.
- [ ] Self-mute works and is visible to the other participant.
- [ ] Non-members cannot obtain a token (test-proven).
- [ ] All existing suites still green; new kind passes exhaustiveness tests.
- [ ] Dev-loop docs: one page that takes a fresh checkout to "two tabs talking" (livekit install, env vars, webhook config).

## 5. Hazards (learned the hard way — read before starting)
- **Migration number races**: parallel sessions leave untracked migrations; re-check the max right before creating yours; create-or-replace collisions are silent.
- **Dev Postgres**: sidecar on **:5442**; the documented start command fails on a PG18 locale refusal; `pg_isready` reports OK while auth is failing; there are two clusters on this machine and bare `psql` hits the wrong one — always pass explicit host/port.
- **Installed vs tree**: server dist and UI bundle drift *independently*; audit by content, not mtime. A full tree build drags in other sessions' pending migrations — build only what you need.
- **`packages/ui` is the legacy oracle (:4611), not the product.** Build only in `packages/tm8-ui` (:4612). A whole feature was once built in the wrong package.
- **Uncommitted landed work** may sit in the working tree from parallel sessions — don't "clean up" modified files you didn't touch; don't revert or stash anything you don't own.
- **pg pool**: "loading workspace" forever = pool exhausted by idle-in-transaction connections, not a dead node; free the pool without killing PTY sessions.
- **Auth is loopback-only by design** (auto-owner, real RLS underneath) — don't build a login system; bind the token service to `ctx.identity` and it inherits S8 bearer auth later.
- **Evidence durability**: `/tmp` doesn't survive reboots; put proofs/artifacts in the repo or `~/Desktop`, and record path+sha durably.

## 6. Read first (in order)
1. `packages/server/src/main.ts` — composition root: WS upgrade dispatch, pump, control channel, identity resolver.
2. `packages/contract/src/catalog.ts` + `schemas.ts` + `contract.ts` — the frozen contract and how amendments work (`test/w1-amendment.test.ts`).
3. `db/migrations/001_core_graph.sql` — entity graph, `channels` detail-table pattern (~1096), envelope trigger (~358), hydration (~1103).
4. `packages/server/src/events/{pump.ts,control.ts,projector.ts,mapper.ts}` — how `presence.changed` flows; copy it for voice roster.
5. `packages/tm8-ui/src/views/GateApp.tsx` + `src/channel-screen/` + `src/shell/{MenuRail,LiveSessionBar,nav-port}.tsx|ts` — the UI seams named in Phase 4.
6. `packages/tm8-ui/src/data/seam.ts` + `src/data/real/` — governed transport facade.
