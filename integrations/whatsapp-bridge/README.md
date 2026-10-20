# wa-bridge

WhatsApp ↔ tm8 bridge, Phase 1. A Baileys linked device: mentions in configured chats route to tm8 main chats and named
sessions, and agents speak back, read and search history through a speaker-token HTTP API on 127.0.0.1:8787.

- `src/main.ts` wiring · `src/core.ts` routing, names/poller, outbox, watchdog, API logic · `src/http.ts` HTTP API
- `src/wa.ts` Baileys adapter · `src/tm8.ts` tm8 CLI client · `src/store.ts` SQLite schema · `src/briefing.ts` envelope + briefings
- `src/text.ts` mention/command parsing, escaping, names, tokens, rate limits · `src/admin.ts` operator CLI
- `src/media.ts` media kinds, placeholders, mime sniffing, safe names, `data/media/` storage
- `test/` node:test suites (`npm test`)

In WhatsApp the main chat and the bridge speak as `tm8: <text>` and sessions as `<title> (<handle>): <text>`;
see OPERATIONS.md › What messages look like. Every routed message is labelled UNTRUSTED unless the sender is in the
config's `trustedSenders` (then TRUSTED, a label for agents only); see OPERATIONS.md › Trusted senders. Images and documents travel both ways (inbound: downloaded and attached to
the tm8 message; outbound: `POST /say-media`); see OPERATIONS.md › Media.

Run it with Docker: `./scripts/deploy.sh`. Everything operational (config, logs, re-link, tokens, groups, backup) is in
[OPERATIONS.md](OPERATIONS.md).

## In the tm8 repo

This directory is a standalone package, deliberately outside the bun workspace (`packages/*`, `apps/*`, `tools/*`): it
keeps its own `package-lock.json` because the Docker build runs `npm ci` against it, and its native and Baileys
dependencies stay out of the monorepo install. Work on it from this directory:

```bash
npm ci
npm run typecheck
npm test
```

CI maps `integrations/**` to typecheck only (`tools/ci/affected.sh`); the bridge's own suites are not part of the
monorepo gate. Imported from the standalone repo at `5febafc` without history (the history carried a real phone
number; the copies here are replaced with placeholders).
