# Workspace load performance — measurement and plan

**Date:** 2026-07-30 · **Scope:** cold workspace load (app mount → interactive)

---

## 0. The headline, because it changes what to build

**The database is not the bottleneck, and indexing will not help.**

Measured against the live dev node (`postgres://tm8@127.0.0.1:5442/tm8_dev`):

| table | live rows |
|---|---|
| `workspace_events` | 1 221 |
| `edges` | 228 |
| `entities` | 152 |
| `work_sessions` | 85 |

152 entities. Postgres scans that in microseconds. The hot tables are also
**already well indexed** — `entities_space_kind_activity_idx`,
`edges_type_src_lookup_idx`, `activity_space_created_idx`,
`workspace_events_space_seq_idx` and 20+ others exist and cover the boot
queries' sort and predicate shapes.

Every endpoint on the boot path, timed against the running node on :4610:

| endpoint | time | bytes |
|---|---|---|
| `spaces.list` | 4.8 ms | 219 |
| `spaces.get` | 6.4 ms | 217 |
| `spaces.navigation` | 20 ms | 998 |
| `spaces.settings` | 16 ms | 1 512 |
| `spaces.menu.get` | 21 ms | 809 |
| `graph.query` | 26 ms | 169 |
| `execution.liveness` | 18 ms | 172 |
| `projects.list` | 4.5 ms | 172 |
| `spaces.home` | 76 ms | 62 560 |

Nothing here is slow. So caching query *results* and adding indexes — the two
things the brief proposed — would be optimising the part that already costs
~130 ms in total. The cost is somewhere else, and it is in three places:
**how the bundle is delivered**, **how many serial round trips boot takes**,
and **how much work each round trip repeats**.

> **Honest limit on this measurement.** No browser was connected to this
> session, so the *perceived* load time was never reproduced directly — these
> are server-side and asset-level numbers. Item 1 and item 6 below are the two
> that would dominate a real browser load, and §5 gives the one-liner to
> confirm which. Everything else in §1–§3 is measured fact.

---

## 1. Assets: 1.2 MB, uncompressed, uncacheable — **fix first**

The built bundle on :4610:

| asset | served | gzip -9 | saving |
|---|---|---|---|
| `index-E7S0YPfk.js` | 1 010 630 B | 278 554 B | **−72 %** |
| `index-DYx09Vh-.css` | 188 246 B | 28 368 B | **−85 %** |
| **total** | **1 198 876 B** | **306 922 B** | **−74 %** |

Full response headers for the JS bundle, requested with
`Accept-Encoding: gzip, deflate, br`:

```
HTTP/1.1 200 OK
x-content-type-options: nosniff
content-type: text/javascript; charset=utf-8
Date: ...
Transfer-Encoding: chunked
```

Three things are missing and all three are one edit:

1. **No `content-encoding`.** The client asked for gzip and got 1 MB of plain
   text. `packages/server/src/http/static.ts:83-86` writes only the security
   headers and a content-type.
2. **No `cache-control`, no `etag`, no `last-modified`.** Every reload
   re-downloads the full 1.2 MB — there is no 304 path at all. The filenames
   are already **content-hashed** (`index-E7S0YPfk.js`), which is precisely the
   case where `cache-control: public, max-age=31536000, immutable` is correct
   and safe.
3. **No `content-length`** (chunked), so the browser cannot show progress and
   cannot size the transfer.

**The fix** — `packages/server/src/http/static.ts`:

- gzip (or brotli) for `.js`/`.css`/`.svg`/`.json` above ~1 KB, negotiated on
  `accept-encoding`. Precompressing at build time and serving `.js.gz` avoids
  paying compression per request.
- `cache-control: public, max-age=31536000, immutable` for anything under
  `/assets/` (hashed names), and `cache-control: no-cache` for `index.html`
  (which must always revalidate, or a deploy never reaches the browser).
- `etag` + `if-none-match` → `304` for the unhashed files.

Effort: small, one file. Payoff: −74 % bytes on first load, ~0 bytes on repeat.

### 1b. The bundle is one un-split chunk

1 MB in a single `index-*.js` means no route-level code splitting: the graph
screen, the terminal (xterm), the settings surfaces and the authoring lane all
parse before the workspace can paint. `React.lazy` on the heavy screens
(`GraphScreen`, terminal/xterm, `SettingsShell`) is the follow-on once §1 lands.

---

## 2. Fonts: a render-blocking external `@import` inside the CSS

`packages/tm8-ui/src/styles/tokens.css:8`:

```css
@import url('https://fonts.googleapis.com/css2?family=Newsreader:...&family=Hanken+Grotesk:...&family=JetBrains+Mono:...&display=swap');
```

A CSS `@import` cannot start until the importing stylesheet has downloaded and
parsed — so this fires **after** the 188 KB CSS lands, then makes a
cross-origin round trip to `fonts.googleapis.com`, then another to
`fonts.gstatic.com` for the files. `index.html` does `preconnect` to both,
which shows the intent, but the `@import` defeats it by serialising the
discovery.

On a slow, throttled or offline network this alone is seconds of blocked
render, and it is invisible in any localhost API measurement.

**The fix:** self-host the three families (`@fontsource/*` or the woff2 files
under `public/`), drop the `@import`, and keep `font-display: swap`. That
removes two external round trips and the third-party dependency from the
critical path entirely. Self-hosting also means the app renders on an
air-gapped or offline machine, which a local-first node should do anyway.

---

## 3. The boot waterfall: 4 stages deep, strictly serial, all-or-nothing

From `packages/tm8-ui/src/views/useGateData.ts`:

```
spaces.list                                          (:337)
  → openSpace(WS) + [menu ‖ liveness ‖ projects ‖ settings ‖ graph]   (:279-291, :385)
    → [4 × collections.query]                        (:300-313)
      → [N × entities.connections]                   (:317-322)
        → ready = true                               (:387)
          → [~7 more collections.query]              (:659-675)
```

Each arrow is a hard `await`. And `ready` gates the **entire** content area
(`GateApp.tsx:361-515`), so until the last teammate's connections request
returns, the user sees one line of text. It is all-or-nothing: nothing paints
early, and one slow call holds everything.

### 3a. The N+1 — and it is entirely redundant

`useGateData.ts:317-322`:

```ts
const defaults = await Promise.all(teammateRows.map(async (teammate) => {
  const page = await seam.connections(teammate.id, { limit: 200 }).catch(() => undefined);
  const edge = page?.items.find((candidate) =>
    candidate.type === 'defaults_to_profile' && candidate.source.id === teammate.id);
  return [teammate.id, edge?.target.id ?? null] as const;
}));
```

One HTTP request per team member. There are **8** team-member entities, and
`bootstrap/launch-resources.ts:117` seeds 7 from `LAUNCH_MODEL_CATALOG`, so
this is 7–8 requests. Each `entities.connections` costs **12–14 SQL round
trips** server-side (`entities-commands-tracking.ts:1139` → `queryConnections`
runs `liveRow` + edges + `endpointRows` + `loadUniversalSummaries` +
`loadActors`). That is **85–100 SQL round trips** at the deepest, most
blocking point of boot.

To find **one edge per teammate**.

And those `defaults_to_profile` edges are **already in the `graph.query`
result** fetched at `:256`, which returns nodes *and* edges for the space.

**The fix:** delete the loop and read the edges off the graph result already in
hand. This is the single highest-value change in the file — it removes a whole
waterfall stage and ~90 SQL round trips for zero new information.

### 3b. Stage 3 does not depend on stage 2

The four `collections.query` calls (`:300-313`) need only `space`, which is
known before stage 2 starts. They sit behind the `await Promise.all([...])` at
`:279` for no data reason. Hoisting them into that same `Promise.all` removes
another full stage from the critical path.

### 3c. Paint before `ready`

Even after 3a and 3b, boot is one gate. The rail, tab bar and panel *chrome*
don't depend on the reads — `PanelStates.tsx` already has geometry-true
skeletons for exactly this. Letting the shell mount and each surface resolve
independently turns a 4-stage blocking wait into progressive paint, which is
the difference the user actually feels.

### 3d. Boot fires twice in dev

`main.tsx:15-19` wraps in `React.StrictMode`, so every effect mounts →
unmounts → remounts. The seam is `useRef`-guarded, but the fetch-issuing
effects are not — so **every request above runs twice** in development. That is
production-correct behaviour and should not be "fixed" by removing StrictMode;
it does mean dev-observed load time is roughly double, and it makes 3a's
fan-out 14–16 requests instead of 7–8.

### 3e. Pool starvation

`db/client.ts:162-177` sets `max: 8`. Boot fires 7–8 concurrent
`entities.connections` (14–16 under StrictMode), each holding a pooled
connection for 12–14 statements, while the event pump also wants one. The pool
is saturated at exactly the moment boot is deepest, so those requests serialise
on connection checkout — invisible in a single-endpoint `curl`, which is why
per-endpoint timings look fine.

There is also **no `statement_timeout` / `query_timeout` /
`idle_in_transaction_session_timeout` anywhere** in `packages/server/src`.
`connectionTimeoutMillis: 5000` is the *checkout* timeout only, so a slow query
has no ceiling at all.

---

## 4. Server-side work amplification

These matter less at 152 entities than §1–§3, but they are why the round-trip
count is 170–195 for 18–19 HTTP requests, and they are what will bite as data
grows.

1. **Every single-statement query costs 4 round trips.** `db/client.ts:179-207`
   wraps each `Db.query`/`Db.rpc` in `begin` + `BIND_CLAIMS_SQL` (4 ×
   `set_config`) + `commit`. A one-line `select` is 4 network hops. Batching
   the claim binding, or reusing one transaction across a handler's reads,
   removes most of it.
2. **`execution.liveness` uses three separate transactions** for one response
   (`execution-handlers.ts:705`, `:718`, `:723`) = 12 round trips — and the
   client re-runs it every 30 s while any session surface is visible. One
   transaction, or one query, is the fix.
3. **`spaces.list` is an unbounded scan with a correlated 5-way join per row.**
   `handlers/spaces.ts:54-72` computes `unread_total` per space via a subquery
   joining the whole `messages` table, with no `WHERE` and no `LIMIT` on the
   outer select (`:86`). Fine at 1 space; it degrades with spaces × messages.
   The same `SPACE_COLUMNS` is reused by `spaces.get`, `spaces.create` and
   `spaces.settings`.
4. **`internal.is_resolved` is an in-database N+1.** It is `plpgsql`
   (`db/migrations/003_read_model.sql:191-210`) doing two sub-selects per call,
   and `graph-undo.ts:105` invokes it **per edge row, up to 1 000 per
   `graph.query`** — including for edge types where the result is discarded
   (`:167`). Inlining it as a join, or computing it only for the edge types
   that use it, removes up to 2 000 in-DB sub-selects per graph load.
5. **`graph.query` ignores the caller's `limit`.** The client asks for 150;
   discovery always fetches `MAX_LIMIT = 200` (`graph-undo.ts:68-77`) and then
   assembles full summaries — a 13-way `LEFT JOIN` — for all 201 rows.
6. **The event projector runs its 18-way join up to 3× per page**, and the
   third (`projector.ts:438`, via `mapper.ts:244,248`) is an exact duplicate of
   the first (`:377`) over the same ids.
7. **Unbounded queries** worth a `LIMIT` before the data grows:
   `entity-read.ts:419-422` (edge fan-out, no limit and no space scoping —
   `contains` edges are materialised in full only to be *counted* at `:434-437`),
   `projector.ts:331-336`, and `loadMembers`/`loadInvites`/`loadTaskAxes`
   (`identity-spaces.ts:220,236,247`).
8. **`entities.get` has an unbounded paging loop.**
   `entities-commands-tracking.ts:622-633` re-runs the entire 9–11-query
   `queryConnections` body per page with no ceiling — an entity with 1 000
   edges costs ~50 queries in one request.
9. **The pump costs 5 SQL round trips/second/connection** even when idle
   (`pump.ts:110`, each `since()` a full `begin`/`set_config`/`select`/`commit`).
   Deliberate per `pump.ts:18-32`, but it is a constant floor.

### Re-entrancy: the waterfall runs more often than at boot

- `useGateData.ts:581-587` — **`postMessage` calls `hydrate()`**, so sending a
  chat message re-runs stages 2–4 *including the N+1*.
- `:434-445` — `onResync` re-runs the whole hydrate after a >10 min gap.
- `App.tsx:39` — `GateApp` is keyed on `activeServer.id`, so switching servers
  remounts and replays the entire boot.

Fixing 3a therefore pays out on every message sent, not only at boot.

---

## 5. What to do, in order

Ordered by payoff ÷ effort. The first three are hours, not days.

| # | Change | Where | Effect |
|---|---|---|---|
| 1 | gzip/brotli + `cache-control: immutable` + `etag` on static assets | `http/static.ts:83-86` | −74 % first-load bytes; ~0 on repeat |
| 2 | Delete the teammate N+1; read the edges off `graph.query` | `useGateData.ts:317-322` | −1 waterfall stage, −85–100 SQL round trips, also per message sent |
| 3 | Self-host fonts; drop the CSS `@import` | `styles/tokens.css:8` | −2 external round trips off the critical path; works offline |
| 4 | Hoist the 4 `collections.query` into stage 2's `Promise.all` | `useGateData.ts:279-313` | −1 waterfall stage |
| 5 | Paint the shell before `ready`; per-surface skeletons | `GateApp.tsx:361-515` | perceived load ≈ first paint, not last byte |
| 6 | Route-level `React.lazy` for graph / terminal / settings | `views/`, `vite.config.ts` | smaller critical bundle |
| 7 | One transaction for `execution.liveness` | `execution-handlers.ts:705-723` | 12 → 4 round trips, every 30 s |
| 8 | `statement_timeout` + raise pool `max` | `db/client.ts:162-177` | no unbounded query; no boot starvation |
| 9 | `is_resolved` as a join; honour `graph.query`'s `limit` | `graph-undo.ts:68-77,105` | −up to 2 000 in-DB sub-selects |
| 10 | `LIMIT`s on the unbounded reads in §4.7 | `entity-read.ts`, `projector.ts`, `identity-spaces.ts` | keeps §0 true as data grows |

**Deliberately not on this list:** new indexes (the hot paths are covered, and
152 rows would not use them), and a query-result cache (it would cache
responses that already return in 4–76 ms, and add invalidation risk to a live
event-sourced surface). Revisit both only after §4.3 and §4.7 make the queries
volume-sensitive rather than round-trip-sensitive.

### Measure the browser side before starting

The one number this analysis is missing. In DevTools console on the workspace:

```js
const t = performance.getEntriesByType('navigation')[0];
console.log({ ttfb: t.responseStart - t.requestStart, domInteractive: t.domInteractive,
  loadEnd: t.loadEventEnd, transferred: performance.getEntriesByType('resource')
    .reduce((n, r) => n + r.transferSize, 0) });
```

Also note **which port**: :4610 serves the built bundle (§1 applies), :4612 is
the Vite dev server, which serves 267 unbundled source modules as separate
requests *and* double-fires every boot request under StrictMode (§3d). If the
slowness is on :4612, §1's asset numbers are not what you are feeling — the
module graph is, and `optimizeDeps` / fewer barrel re-exports is the lever.
Confirm the port before spending the effort.
