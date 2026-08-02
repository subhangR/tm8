# tm8 — REMOTE: verified deep report

**Date:** 2026-07-31 · **Tree:** `/Users/subhang/Desktop/Projects/tm8`, branch `main`, HEAD `765115c`, working tree DIRTY.
**Method:** direct file reads, call-graph trace from `packages/server/src/main.ts`, mechanical enumeration of `OPERATIONS`, column-by-column diff of `identity/pg-store.ts` against `db/migrations/002`+`007`+`008`, and empirical probing of the proxy's path regex under Node's `URL`. Every claim carries a `file:line`. `STATE.md` was not consulted.

**Labels used throughout:** **EXISTS** = running code, reachable from `main()`. **DESIGNED** = doc only. **ABSENT** = grep-verified not present.

---

## 0. The honest one-paragraph answer

tm8's remote story is **larger in code and smaller in security than the brief says**. There are **four** real remote paths, not one — a CLI name-registry redirect, an HTTP/WS forwarding proxy, a fully-mounted UI Server switcher that routes the *entire* browser app through that proxy, and a UI PTY transport that carries terminals over it. All four are **completely unauthenticated**, and the proxy specifically is dispatched **before** identity resolution, forwards `Authorization` and `Cookie` verbatim to the upstream Server, and strips `Origin`/`Referer` — defeating any origin check the upstream might later grow. Meanwhile the *control plane* is exactly as absent as the brief says: **zero** `auth.*`, `gateway.*`, `server.*`, or `connection.*` operations exist in the 110-row catalog, and there is no gateway package and no bridge package. The design docs are genuinely good and genuinely aspirational. The single most important correction for planning: **R0's `PgIdentityRepository` pre-work is not a rename pass** — it is a rewrite plus a new migration plus edits to two files the design doc believes are insulated.

---

## 1. Corrections to `TM8-AUTH-AND-IDENTITY-BRIEF.md`

The brief is a good map. Five load-bearing claims did not survive verification.

| # | Brief claim | Verdict | Evidence |
|---|---|---|---|
| 1 | "Migrations — `packages/server/db/migrations/…`" (§6) | **WRONG PATH** | That directory does not exist. Migrations are at repo root: `db/migrations/044_local_server_connections.sql`. Matters because anyone following the brief to verify will find nothing and may conclude ABSENT. |
| 2 | "**Server A's bearer token is deliberately NOT forwarded to B**" (§4.1), stated about `remote-proxy.ts` | **CONFLATES TWO PATHS** | True of the **CLI** path only: `packages/cli/src/server-target.ts:30-32` explicitly sets `token: undefined`. **False of the proxy**: `http/remote-proxy.ts:38-47` does `{...headers}` and deletes only `host`, `origin`, `referer`, `content-length`. `authorization` and `cookie` are forwarded verbatim. |
| 3 | "No Connection store in the UI" (§4.2) | **FALSE** | `packages/tm8-ui/src/servers/server-registry.ts` (185 lines) is a complete Connection store — list, add, persist-active, health-probe. And it is **mounted**: `App.tsx:35` → `GateApp.tsx:80,366,377,395,425`. |
| 4 | "`PgIdentityRepository` … wrong column names and RPC argument order" (§5.4) | **TRUE BUT A LARGE UNDERCOUNT** | 24 defects in 5 classes; only 7 are renames. Two whole classes missing from the brief. See §7. |
| 5 | "Remote is 100% design, 0% runtime — with one exception" (§0) | **UNDERSTATED** | There are four runtime remote surfaces (§3), one of which carries the whole browser UI. |

Also drifted (not the brief's fault — the tree moved): the 2026-07-29 status doc says the catalog has **106 operations, 104 v1** (`REMOTE-STATUS-2026-07-29.md:53-54`). Today it is **110 / 108 / 2** (`catalog.ts:174`, asserted at `packages/cli/test/catalog-exhaustiveness.test.ts:33,39-44`).

What the brief got right and is worth restating: S1 is a real throw; there is exactly one identity path and it is guarded by a test; `claimsFor`/`db/client.ts` genuinely do not need to change for bearer; the PTY WS gates on nothing.

---

## 2. EXISTS — the four real remote paths

The brief describes one. There are four, and they do not share a security model.

### Path A — CLI `--server <name>`: a name registry, not a proxy

`packages/cli/src/server-target.ts:7-34`. The CLI asks **A** for the name via `serverConnections.get` (`:16-18`), then rebuilds its own context pointed straight at **B**'s `baseUrl` (`:29`) and **drops A's token** (`:30-32`, with an explicit comment: *"never leak one node's bearer material to another origin"*).

This is the safest of the four and it never touches `remote-proxy.ts`. A is a phone book. All actual traffic is client→B direct.

Commands: `packages/cli/src/commands/server.ts:129-134` — `server list|add|get|remove`. `add` pre-flights `GET /health` on the target and requires `ok:true`, `server:'tm8-server'`, and an **exact `CONTRACT_VERSION` match** (`:52-65`). That version check is real and is the only capability negotiation that exists anywhere in the tree today.

### Path B — the HTTP/WS forwarding proxy

`packages/server/src/http/remote-proxy.ts`, route `/v2/server-connections/:name/proxy/<upstream>` (`:7`).

What it does, verified:
- Refuses loops via a client-visible hop header (`:69-71`, `x-tm8-server-proxy-hop`).
- Validates the connection name against `^[a-z][a-z0-9-]{0,62}$` (`:28`).
- Restricts upstream paths to `/health`, `/v2`, `/v2/*` (`:32`).
- Rewrites `host`, drops `origin`/`referer`/`content-length`, stamps the hop header (`:38-47`).
- Pipes HTTP (`:90-111`) and WS upgrades (`:113-145`) to the upstream.
- Deletes `access-control-allow-origin` off the upstream's response (`:99`).

### Path C — the UI Server switcher (the brief says this doesn't exist)

`packages/tm8-ui/src/servers/server-registry.ts`:
- `routeBaseUrl(name)` = `` `/v2/server-connections/${encodeURIComponent(name)}/proxy` `` (`:39-41`).
- `useServerRegistry()` lists via `GET /v2/server-connections` (`:128`), adds via `POST` (`:159-168`), persists the active selection in `localStorage` (`:26,64-70`), and health-probes each server through the proxy (`:83-94`).
- `LOCAL_SERVER` has `routeBaseUrl: ''` (`:33`) so "local" is the same code path with an empty prefix — a nice degenerate-case design consistent with T-L7.

Mounted: `packages/tm8-ui/src/App.tsx:35` calls `useServerRegistry()` and keys the whole app on `registry.activeServer.id` (`:38`). `GateApp.tsx:80` sets `serverBaseUrl: activeServer.routeBaseUrl` and threads it to four surfaces (`:366,377,395,425`). `AddServerDialog.tsx` exists.

**So: selecting a remote Server in the UI routes every graph read, every mutation, and every event socket through Path B.** This is the largest live remote surface in the product and it is the one the brief says is absent.

### Path D — remote PTY over the proxy

`packages/tm8-ui/src/terminal/pty/ptyTransport.test.ts` asserts `openSession('s1', '/v2/server-connections/ec2n')` produces `/v2/server-connections/ec2nv2/ws`. The UI's PTY transport accepts a server-connection prefix, so a **terminal on a remote Server** rides Path B's WS upgrade handler.

### The persistence layer for all of it

`db/migrations/044_local_server_connections.sql` — `public.server_connections(id, name, base_url, username, created_at, updated_at)` (`:9-22`), unique on `lower(name)` (`:24-25`), RLS enabled with a **node-admin-only SELECT policy** (`:33-34`), `grant select … to tm8_app` (`:36`). Create/delete are `SECURITY DEFINER` RPCs that `perform internal.require_node_admin()` (`:59`, `:101`) and record to the idempotency ledger (`:74-78`, `:120-124`).

The header comment is honest and correct (`:3-5`): *"They deliberately contain no password: Phase 1 has no remote authentication boundary, and a credential that is stored but never used would only create secret exposure."* The contract DTO matches — `ServerConnection` has no secret field (`packages/contract/src/contract.ts:654-661`).

Catalog rows: `serverConnections.list/create/get/delete`, all `v1` (`catalog.ts:33-36`).

---

## 3. The proxy's actual security properties

This is the part the docs do not describe, and it is the substance of area 4.

### 3.1 It is dispatched *before* identity resolution — EXISTS

`packages/server/src/http/server.ts`:

```
:129   const decision = checkTransport(method, req.headers, config);   // all three checks are no-ops
:132   if (opts.remoteServerProxy?.matches(pathname)) {
:133     await opts.remoteServerProxy.handleHttp(req, res);  ← returns here
:134   }
...
:176   const match = router.match(method, pathname);
:179   const identity = await resolveIdentity(req.headers);   ← never reached for proxy requests
```

The WS upgrade path is worse — `:105-118` calls the proxy at `:107-109` and **never calls `checkTransport` at all**.

So the proxy route has: no identity, no node-admin check, no catalog handler, no input schema, no idempotency ledger. It is the only `/v2/*` path in the server that bypasses the entire facade.

### 3.2 The node-admin gate is satisfied by the server, not the caller — EXISTS

`main.ts:299-312` builds the target resolver:

```ts
const remoteServerProxy = db && owner
  ? createRemoteServerProxy(async (name) => {
      const nodeOwner = await owner();                       // :301
      const rows = await db.query<{ base_url: string }>(
        { identityId: nodeOwner.identityId,
          nodeAdmin: nodeOwner.isNodeAdmin },                // :304-305  ← the OWNER's claims
        `select base_url from public.server_connections where lower(name) = lower($1)`,
        [name],
      );
      return rows[0]?.base_url ?? null;
    })
```

044's node-admin SELECT policy is real, but it is evaluated against the **loopback owner's** claims on every proxy request regardless of who made it. The RLS is satisfied structurally. It gates nothing about the caller.

Note the asymmetry: `serverConnections.list/get` (the catalog ops, Path A and the UI's list call) go through the normal facade and *do* get identity-bound claims. Only the proxy short-circuits.

### 3.3 `Authorization` and `Cookie` ARE forwarded — EXISTS (refutes the brief)

`remote-proxy.ts:38-47`:

```ts
function forwardedHeaders(headers, target) {
  const next = { ...headers };
  delete next.host; delete next.origin; delete next.referer; delete next['content-length'];
  next.host = target.host;
  next[HOP_HEADER] = '1';
  return next;
}
```

`authorization`, `cookie`, `x-tm8-client`, and every other header survive. Today this is inert only because nothing mints a token (§5) — but the moment `auth.login` lands per the design, A's Server-scoped bearer travels to B on every proxied request, which is exactly what `server-target.ts:30-32` and design §3.1.1 ("the client holds a token minted by the hosted Server") both say must not happen.

**This is a latent violation of the design's own central auth property, sitting in shipped code, unreferenced by any of the three remote docs.**

### 3.4 It strips `Origin` and `Referer` — EXISTS, and it cuts the wrong way

`:40-42`. Removing `Origin` before forwarding means that when B eventually implements S3 (WS Origin allowlist), **requests arriving via A's proxy will have no Origin to check** and will sail past it. The proxy is an origin-laundering device for the whole fleet. Neither `PHASE-2-REMOTE-SERVER-INTEGRATION.md` §3.6 nor `REMOTE-END-TO-END-DESIGN.md` §3.6 accounts for this.

### 3.5 Path restriction: probed, and it holds (with one leak)

I probed the regex + Node `URL` behavior empirically. Plain dot-segments **cannot** escape: `new URL(req.url, …)` at `:19` normalizes `/v2/server-connections/b/proxy/v2/../../etc/passwd` to `/v2/server-connections/b/etc/passwd`, which fails `PREFIX` and 404s. Good.

Percent-encoded dot-segments survive to the upstream verbatim: `/v2/%2e%2e%2f%2e%2e%2fadmin` passes `startsWith('/v2/')` at `:32` and is sent to `http://B/v2/%2e%2e%2f%2e%2e%2fadmin`. B's own `new URL()` also won't decode `%2e`, so B routes it as a literal path and 404s. **Not exploitable against a tm8 upstream** — but the restriction is enforced on the un-decoded string, so it would break against any upstream that decodes before routing. Worth a normalize-then-check if this ever fronts something else.

### 3.6 Zero tests

`rg` across the whole tree for `remote-proxy|createRemoteServerProxy|/proxy/` in test files returns **one** hit, and it is client-side (`packages/tm8-ui/src/terminal/pty/ptyTransport.test.ts`). There is **no server-side test of the proxy at all** — not the loop guard, not the path allowlist, not the header handling, not the WS upgrade.

### 3.7 What actually holds this up

S1, and only S1. `packages/server/src/http/config.ts:109-115` is a real `throw new ConfigError(...)`, not a warning; loopback is an exact-string set `{'127.0.0.1','::1','localhost'}` (`:62`); `TM8_BIND` appears nowhere else in `src` and there is no `TM8_INSECURE`-style escape hatch. It propagates through `main.ts:77` → `:379-385` and the process never listens.

One caveat: S1 is enforced in the **config loader**, not at `listen()`. `main.ts:77` is `opts.config ?? loadConfig()`, and `http/server.ts:220` calls `http.listen(config.port, config.host)` with no re-validation — so any in-process caller that constructs a `ServerConfig` directly (the test harnesses do, e.g. `packages/server/test/w3/public-harness.ts:58`) bypasses S1 entirely. The shipped `main()` does not (`main.ts:352`), so this is correctness-of-placement, not a live hole. But S1 belongs at the listen, not at the load.

---

## 4. EXISTS — the WS surfaces, all four, all unauthenticated

Enumerated by grep for every upgrade handler in the tree.

| Surface | file:line | Authenticates |
|---|---|---|
| Upgrade dispatcher | `http/server.ts:105-118` | **Nothing** — and does not call `checkTransport`, so *no* WS surface is covered by S2/S3/S4 even after they're implemented |
| Events (`/v2/ws`) | `events/ws-server.ts:110-142` | **Nothing at handshake.** `main.ts:235-242` passes no `authorize`, so `:138` defaults to `{kind:'auto-owner'}` with **no `identityId`**. Post-handshake `subscribe` does hit a real RLS authorizer (`events/control.ts:90-107`) — but `main.ts:189-192` fills the missing id with the node owner's, so **every socket is authorized as the node owner**. Real RLS, wrong principal. |
| PTY (same path, `?sessionId=`) | `pty/pty-ws-server.ts:215-238` | **Nothing** — see §6 |
| Remote proxy | `http/remote-proxy.ts:113-145` via `http/server.ts:107` | **Nothing** — see §3 |

### The composite that matters

`Origin` is never checked (`http/security.ts:59-61`, `return ALLOWED`), and **WebSockets are exempt from the same-origin policy**. With the server on `127.0.0.1:4610`, any page the user visits can:
- open `ws://127.0.0.1:4610/v2/ws` and be treated as the node owner on the events stream — and unlike `fetch`, a cross-origin WS response body **is** readable;
- open `ws://127.0.0.1:4610/anything?sessionId=<uuid>` and get a bidirectional keyboard on a live agent shell.

`security.ts:33-37` names this adversary (A1) itself and says *"This must not ship to G1A unclosed."* The gap between that comment and the code is bigger than the comment implies: those checks are not merely unimplemented, **their call site does not exist on the WebSocket path at all**. Landing real bodies in `security.ts` would close HTTP and leave every socket untouched.

---

## 5. ABSENT — the catalog, enumerated mechanically

`packages/contract/src/catalog.ts`. Verified two ways (regex over source and importing the module under `bun`); both give **110 rows**.

- `OperationStatus = 'v1' | 'reserved'` — a closed 2-value union, `catalog.ts:18`. No third status exists.
- **108 v1, 2 reserved.** The two reserved: `search.query` (`:103`) and `bridge.fetchBlob` (`:119`). Each is the *sole member* of its namespace — `bridge` and `search` exist in the catalog only as reserved slots.
- 28 namespaces, 0 duplicate names.

**Your hypothesis is confirmed exactly.**

| Namespace / token | Verdict |
|---|---|
| `auth.*` | **ABSENT** — zero ops, zero paths |
| `gateway.*` | **ABSENT** — zero ops, zero paths |
| `connection.*` | **ABSENT** |
| `server.*` | **ABSENT** as a namespace. `serverConnections` is a different namespace (4 ops, `:33-36`) |
| `bridge.*` | 1 op — `bridge.fetchBlob`, `:119`, **`reserved`** |
| `mintToken` | **ABSENT** everywhere in `packages/`. Exists only as a proposal in `REMOTE-END-TO-END-DESIGN.md:125,347,485,729` |
| `login` / `token` | **ABSENT** in every op name and every op path |
| `session` (auth sense) | **ABSENT**. Path hits are *work*-sessions (`handoffs.*`, `:156-157`) |

Also **ABSENT**: no `gateway` package, no `bridge` package (`ls packages/` → cli, contract, execution, prompt, pty-protocol, server, tm8-ui, ui).

### Reserved → 501 is enforced twice on the server, once on the CLI

Worth knowing because it constrains how new remote ops can land:

1. **Boot tripwire:** `facade/registry.ts:43-48` — `register()` **throws** for a reserved name. A reserved op *cannot* be quietly implemented.
2. **Request path:** `http/router.ts:80-84` compiles reserved rows into routes (so they match, not 404) → `http/server.ts:181-182` misses the registry → `notImplemented()` (`http/errors.ts:157-160`) → 501 via `ERROR_STATUS` (`contract.ts:597`). Ordering is load-bearing: input validation runs *after* the registry lookup (`server.ts:188-189`), documented at `facade/input-schemas.ts:9-15` — *"`GET /v2/search` with no `q` must be 501, never 400."*
3. **CLI:** `discovery/availability.ts:217-225` returns `unavailable/reserved` from the contract, consulted *first* at `:236-240`, so no observation can promote it.

**Adding an op is not free.** It breaks the CLI *build* (`discovery/operations.ts:18-21` is `Record<OperationName, Row>`) plus four test files with hardcoded counts: `packages/cli/test/catalog-exhaustiveness.test.ts:33,39-44,117,119`, `packages/contract/test/w1-amendment.test.ts:48-64`, `packages/contract/test/contract.test.ts:121-124`, `packages/server/test/w2/reserved-honesty.test.ts:137-148`. The last of these live-fetches every residual v1 HTTP binding against a real server and requires 501. The design's plan to land 10 new rows as `reserved` first is sound, but it is a 5-file coordinated change per batch, not an append.

---

## 6. EXISTS — the PTY WS, confirmed and worse than described

The brief is right. Three things make it sharper than stated.

**The complete pre-handshake validation** (`pty/pty-ws-server.ts:215-238`): `sessionId` non-empty (`:221-225`), `Upgrade: websocket` (`:226-229`), `Sec-WebSocket-Version: 13` (`:230-233`), `Sec-WebSocket-Key` non-empty (`:234-238`). Then the 101 at `:240-245`. That is all of it.

**ABSENT**: grant lookup, token, Origin, Host, identity, view-vs-drive. No DB reference anywhere in `packages/server/src/pty/`. `PtyWsServerOptions` (`:66-77`) is `{pty, logger?, heartbeatMs?, missedPongLimit?}` — **no seam through which auth could even be injected**, unlike `events/ws-server.ts:44` which at least declares an optional `authorize`.

**Write access confirmed end-to-end**: `pty-ws-server.ts:253` `onInput: (data) => pty.write(sessionId, data)` ← `pty-ws-connection.ts:194-197` (binary frames) ← `PtyHostService.ts:601-606` `entry.proc.write(text)`. Also `resize` (`:254`→`:155`), which broadcasts a `size` frame to every *other* peer (`:159-161`) — an unauthenticated client can perturb other viewers.

### Three things beyond the brief

1. **It is not confined to `/v2/ws`.** `isPtyUpgrade` (`:90-96`) tests **only `searchParams.has('sessionId')` — no pathname check** — and `main.ts:263` tries PTY *first*. So the PTY socket answers at **any path**: `GET /favicon.ico?sessionId=<uuid>` works. The events server's own path guard (`events/ws-server.ts:112-115`) is bypassed for anything carrying `sessionId`.
2. **It is a session-id oracle.** The 101 is written at `:240-245` **before** the session-existence check at `:280`. An unauthenticated caller gets a real framed WebSocket for any string, then a 1011 close if the session doesn't exist — a clean online/offline probe.
3. **View-vs-drive is decorative today.** `execution-handlers.ts:383` passes `null // p_token_hash`, and `:828-830` returns the same tokenless URL `/v2/ws?sessionId=<id>` with `mode` echoed back as advisory data. **A `view` grant and a `drive` grant produce byte-identical URLs, and neither is required to connect.** The string `'view' | 'drive'` appears exactly once in `packages/server/src` — the RPC parameter at `execution-handlers.ts:377`.

The design's §2.6 sizing is correct and should be trusted: this needs a new `grantLookup` dependency backed by `Db`, threaded through `main.ts:259`'s composition. It is an architectural addition, not a flag flip. `PtyHostService.write` is confirmed pure plumbing with no grant concept (`PtyHostService.ts:601-606`), so `pty-ws-server.ts` really is the only place that can gate.

---

## 7. R0 pre-work: `PgIdentityRepository` is a rewrite, not a rename

This is the single most consequential correction in this report, because both the brief (§5.4) and the design doc (§3.5, "scoped, concrete work") and the status audit (line 97-100) all describe it as an alignment pass.

**Confirmed dead:** zero construction sites repo-wide. `new PgIdentityRepository` — **no matches** anywhere including tests. References are only the class declaration (`identity/pg-store.ts:207`), an unused re-export (`identity/index.ts:70`), a comment explaining why it isn't used (`identity/loopback.ts:4-5`), and stale `dist/`. `IdentityServiceImpl` is likewise production-dead (only `test/identity/harness.ts:53`, `test/identity/credentials.test.ts:23`). All **68** identity `it()` blocks run against `InMemoryIdentityRepository`.

**No later migration fixed it.** I grepped all 50 migrations for `alter table … (accounts|auth_sessions|members|team_members)`, `rename column`, `drop column`, `add column`: **zero hits** on these four tables. The ten identity RPCs appear only in `007`.

### 24 defects, 5 classes, 10 of 18 methods

| Class | Count | Fixable by rename? |
|---|---|---|
| Wrong column identifiers (`login`, `node_admin`, `password_algo`, `issued_at`×2, `last_seen_at`, `team_member_id`) | 6 | **Yes** |
| `status` column unknown to the code; derived from `disabled_at` instead | 1 | Yes-ish |
| **Direct reads of tables `tm8_app` may not read** | **6 sites** | **No — needs a new migration** |
| **jsonb return consumed as a record** | **5 sites** | **No — rewrite each query** |
| `ensure_account` arity/order; password never persisted | 3 | No |
| `issue_auth_session` positional swap (args 4↔5) | 1 | No |
| `purge_auth_sessions` — **function does not exist** (real one is `prune_auth_sessions(interval)`) | 1 | No |
| **Token verification structurally impossible on this schema** | **3** | **No — needs `repository.ts` + `service.ts` edits** |
| Client-minted session id silently discarded | 1 | No |

### The two classes nobody has named

**(a) Read grants.** `db/migrations/008_rls_policies.sql:204-206` says it outright: *"accounts, auth_sessions, … get NO policy on purpose. RLS is enabled with zero policies, which means zero rows for tm8_app — the auth RPCs are the only way in."* The grant block (`008:213-224`) omits both tables. So **six** direct-table queries (`pg-store.ts:246, 254, 262, 270, 277, 370`) fail with `42501 permission denied` before a column name is ever parsed. And **there is no RPC in 007 to call instead** — `getAccountById`, `getAccountByIdentityId`, `getAccountByUsername`, `getOwnerAccount`, `countAccounts`, `listAuthSessions` have no server-side equivalent. This is not a pg-store repair; it is a **new-migration** repair.

**(b) The token-verification contract is incompatible with the schema.** `repository.ts:103` declares `getAuthSessionById(id)`; `service.ts:278-284` fetches by id then constant-time-compares `session.tokenHash` in TypeScript. But `resolve_auth_session(p_token_hash)` (`007:110`) matches **on the hash**, and `007:308` explicitly does `to_jsonb(s) - 'token_hash'` — **the hash never leaves the database, by design.** The comparison `service.ts:282` performs cannot be done on this schema. Fixing it requires editing `repository.ts` and `service.ts` — precisely the seam `pg-store.ts:4-5` claims is insulated from schema movement. That claim is false.

Compounding: `service.ts:255` mints the session id client-side and embeds it in the token (`formatToken(id, secret)`, `:271`), but `issue_auth_session` has **no id parameter** (`007:288-290`) — the row's id is `default internal.new_id()` (`002:168`), and `pg-store.ts:328-335` silently drops `input.id`. **Every minted token would carry a session id that does not exist in the table.**

### `ensure_account`, position by position

The 7-vs-8 arity is the least of it. Because args 3-8 all have defaults, the 7-arg call *resolves* — it does not error. It mis-binds:

| $n | pg-store passes (`:228-237`) | Lands in (`007:150-154`) | |
|---|---|---|---|
| $4 | `isNodeAdmin` *(boolean)* | **`p_email text`** | boolean → email column (`002:50`), also written to `user_profiles.email` (`007:184-188`) |
| $6 | `passwordHash` *(text)* | **`p_is_node_admin boolean`** | text → boolean; feeds `p_is_node_admin or p_is_owner` (`007:193`) |
| $8 | *(nothing)* | `p_password_hash` → `null` | **the password is never stored** |

In the loopback shape the corruption is *silent*: null password → null into `p_is_node_admin`, and `null or true` = `true`.

### The salvageable third

8 of 18 methods are correct as written: `setCredential` (`:306`), `touchAuthSession` (`:353`), `revokeAuthSession` (`:357`), `revokeAccountSessions` (`:362`), both `getActorScope` queries (`:391,398`), `getTeamMember` (`:409`), `getMember` (`:420`). All `members`/`team_members` columns match `002` exactly — and notably that is precisely the part reading tables `tm8_app` *is* granted (`008:220`).

### Honest sizing

Expect **~10 method bodies rewritten**, **1-3 new RPCs in a new migration** (account reads by id/identity/username/owner, session listing, and either a hash-comparing verify RPC or a signature change to `resolve_auth_session`), and **edits to `repository.ts` and `service.ts`** for the token path. `loopback.ts:90-112` is the working reference for how these RPCs are actually called correctly. The design doc's alternative — *"write a fresh minimal query set that mirrors `loopback.ts`'s proven calls"* (`REMOTE-END-TO-END-DESIGN.md:355`) — is much better supported by this evidence than *"align it to the RPC signatures."* Take the second option.

---

## 8. DESIGNED — the docs, read in full

### `PHASE-2-REMOTE-SERVER-INTEGRATION.md` (321 lines, 2026-07-26)

Status line is unambiguous: *"deferred design boundary, documentation-only… not part of the local Phase-1 architecture or current implementation."* It explicitly *"does not freeze unreviewed endpoint names or authorize implementation"* (`:30`).

Its §2 eight invariants are genuinely load-bearing and, as far as I can verify, **not violated by anything in the tree** — Spaces are single-homed, no cross-Server edge or FK exists, one catalog, Projects are Server-local. §12's non-goals list (no `hubspace`, no multi-master, no gateway-owned graph data) is clean.

Its §11 fifteen-item checklist gates implementation-readiness. Coverage today, verified against code, not against the design doc's own claim:

| # | Item | Runtime status |
|---|---|---|
| 1 | Stable Server identity + metadata DTO | **ABSENT** — no `serverId` anywhere; `/health` reports `contractVersion` and counts only (`http/server.ts:143-149`) |
| 2 | Connection DTO + secret-storage rules | **PARTIAL** — `ServerConnection` exists (`contract.ts:654-661`), deliberately secretless; no secret-storage rules because no secrets |
| 3-4 | Discovery / gateway enumeration | **ABSENT** |
| 5 | Login/exchange/refresh/revoke/disable | **ABSENT** |
| 6 | Capability discovery + version negotiation | **PARTIAL** — `tm8 server add` does an exact-match `CONTRACT_VERSION` check (`commands/server.ts:59-65`); nothing else |
| 7 | Route grammar + deep links | **ABSENT** server-side; UI has `routeBaseUrl` prefixing (`server-registry.ts:39-41`) but no `/srv/:id` route grammar |
| 8 | WS subscription/control protocol | **EXISTS for single-Server** (`contract.ts:397-453`), untested multi-Server |
| 9 | Reconnect / retention-expiry | **PARTIAL** — retention is ~5min/1000 events (`events/poll.ts:68-77`); no truncated-resume signal |
| 10 | Blob relay | **ABSENT** — `bridge.fetchBlob` reserved, `catalog.ts:119` |
| 11 | Terminal relay + view/drive authz | **ABSENT** — see §6 |
| 12 | Hosted-Server lifecycle | **ABSENT** |
| 13 | Gateway-vs-home error mapping | **ABSENT** |
| 14 | Observability/correlation across relays | **ABSENT** |
| 15 | Direct-vs-gateway conformance suite | **ABSENT** |

Nothing has moved on 1, 3, 4, 5, 10, 11, 12, 13, 14, 15. Ten of fifteen are untouched.

**The tension nobody has resolved:** the boundary doc says remote *"is not implementation-ready until a reviewed specification freezes"* those 15 items (`:275`), and that *"endpoint names and wire shapes belong in that specification, not in implementation pull requests"* (`:293`). Meanwhile `serverConnections.*`, `remote-proxy.ts`, the CLI `server` noun, and a mounted UI Server switcher **all shipped**. Those are endpoint names and wire shapes, landed in implementation, ahead of the freeze this doc requires. That is not necessarily wrong — but it is un-reconciled, and the "Phase 1 has no remote authentication boundary" comment in `044:3-5` is doing all the load-bearing justification for it.

### `REMOTE-END-TO-END-DESIGN.md` (773 lines, 2026-07-27)

Status: **"design draft, for adversarial review."** It has been through one adversarial pass — §12 records 6 findings + 2 coordinator additions, all applied, none rebutted. It closes all 15 §11 items on paper.

It is a good document. The parts I'd call genuinely settled and worth building to:

- **The auth architecture is right.** Gateway mints an HMAC-signed assertion carrying a **subject string** (never a raw `accountId`, §3.1.1a); the hosted Server verifies and mints **its own** `AuthSession` through the identical mechanism `auth.login` uses; **never auto-provisions** on unknown subject (§3.1.1a point 3, correctly reasoning that auto-provisioning would make exchange a silent account-creation path). This is what keeps T-L8/R1 true under exchange, and it is not obvious — it's the kind of thing that gets gotten wrong.
- **Error taxonomy stays closed.** No new `CommandErrorCode`; new `details.reason` values ride `upstream_unavailable` (retryable) and `not_implemented` (not) (§1.5). The C2 fix — moving `contract_version_unsupported` onto `not_implemented` so the *code*, not just the `retryable` flag, tells a naive retry loop to stop — is a genuinely good catch.
- **CSRF is a decision, not a gap** (§3.6): bearer-in-header has no ambient-cookie surface. Correct.
- **One-socket-per-Server** keeps `WorkspaceControlFrame`/`WorkspaceEvent` shape-unchanged (§2.4), with the tradeoff honestly marked UNCERTAIN.
- **§7.1's eight anti-patterns** are the most useful page in the document — a concrete PR-review checklist, each tied to the invariant it would violate.
- **§2.6 sizes the PTY fix honestly** and refuses to call it a parameter flip. Correct, per §6 above.

The two UNCERTAIN blocks, both real:
1. **§1.4** — header-based version negotiation is enforced per-request, *after* the client has committed to a body shape; an old client gets `invalid_input`, which doesn't point back to "your contract is too old." The proactive-check contract a client library should follow is unspecified.
2. **§2.4** — one-socket-per-Server vs. one multiplexed socket with a `serverId` per frame. The bet is that socket count stays small. Flagged as revisitable if a user routinely holds dozens of hosted Servers.

The 12 OPEN items (§9) are all genuinely secondary — TTL numbers, keychain library choice, copy wording, rotation cadence, sandboxing mechanism. None of them blocks a build. The one I'd promote is **OPEN #2** (resume-past-retention), because it becomes materially more likely over a gateway hop — a laptop lid closing across a relay is a much more common event than a local process staying open — and the recommended fix requires **the contract's first success-ack frame** (today's `WorkspaceControlAck` is exclusively a refusal, `contract.ts:445-453`). That is a wire-shape addition disguised as an open item.

**What the design does not cover at all:** the proxy that already exists. `remote-proxy.ts` is never mentioned in any of the three documents. Its header-forwarding behavior (§3.3) directly contradicts §3.1.1's central property, and its `Origin` stripping (§3.4) undermines §3.6's transport rules. Whoever ratifies this design needs to decide whether Path B survives, and if so, under what auth.

### Citation drift in the design doc

The doc's `file:line` citations were accurate on 2026-07-27 and have drifted. Anyone implementing from it will chase wrong lines. Verified drift:

| Design doc says | Actually |
|---|---|
| `main.ts:266-271` (identityResolver), §3.5 & §7 | `main.ts:288-293` |
| `main.ts:237` (`createPtyWsServer`), §2.6 | `main.ts:259` |
| `pty-ws-server.ts:247-249` (`onInput`), §2.6 | `pty-ws-server.ts:253` |
| `execution-handlers.ts:322` (`p_token_hash` null), §2.6/§7 | `execution-handlers.ts:383` |
| `execution-handlers.ts:107` (8-session cap), §2.2/§2.2.2 | **Not a cap** — that line is a `TaskRow` interface. The cap is `TM8_SESSION_CAP`-driven, `execution-handlers.ts:424-434`; there is no literal 8 |
| `catalog.ts:95,111,183-184` (reserved rows), §1.6 | `catalog.ts:103` and `:119`; derived exports at `:191,194` |
| `http/server.ts:119-133` (`/health`), §1.1 | `http/server.ts:137-151` |
| `http/server.ts:109` (`nextRequestId`), §2.3 | `http/server.ts:122` |
| `contract.ts:1073-1081` (`StreamAttachGrant`), §2.6/§7 | `contract.ts:1203` |
| `PtyHostService.ts:420-424` (`write`), §2.6 | `PtyHostService.ts:601-606` |
| `poll.ts:73` (retention), §2.4 | `events/poll.ts:68-77` (the prose is at `:71-73`, the constant at `:77`) |

The *substance* of every one of these citations checked out. Only the line numbers moved. But `execution-handlers.ts:107` is worth flagging specifically — the "existing 8-session cap" the resource-governance section anchors on (§2.2, §2.2.2) is not a literal 8 anywhere; it's operator-configurable via `TM8_SESSION_CAP`, including `unlimited` (`:424-434`).

### `REMOTE-STATUS-2026-07-29.md` — re-verified bullet by bullet

Audited at `HEAD 1a1b70e`; today is `765115c`. Every "Missing/risky/bad" bullet re-checked:

| Status-doc bullet | Today |
|---|---|
| No stable Server identity, no `server.describe` | **STILL TRUE** |
| No Connection DTO/store, no route prefix, no server-grouped rail | **PARTLY MOVED** — `ServerConnection` DTO exists (`contract.ts:654-661`); a UI Connection store exists **and is mounted** (§2 Path C). No `/srv/:id` route prefix, no server-grouped rail |
| Browser constructs one seam for the app lifetime, sends no bearer | **PARTLY MOVED** — `App.tsx:38` keys on `registry.activeServer.id`, so the seam is now **per-Server**, re-created on switch. Still sends no bearer |
| CLI has no authenticated/non-loopback remote transport | **STILL TRUE** |
| Server uses loopback auto-owner; auth ops not mounted | **STILL TRUE** — `main.ts:288-293`, and zero `auth.*` in the catalog |
| Server hard-refuses non-loopback | **STILL TRUE** — `config.ts:109-115` |
| No bridge runtime; `bridge.fetchBlob` reserved | **STILL TRUE** — `catalog.ts:119`; no bridge package |
| No gateway runtime / hosted-Server process manager | **STILL TRUE** — no gateway package |
| Host/Origin/CORS/CSRF wired as no-ops | **STILL TRUE, and worse than stated** — `security.ts:55,60,69` all `return ALLOWED`, and the WS upgrade path never calls `checkTransport` at all (`http/server.ts:105-118`) |
| PTY WS accepts `sessionId`, upgrades, forwards input | **STILL TRUE, and worse** — see §6 (any path; oracle; view/drive decorative) |
| Production resolves every request as local owner | **STILL TRUE** — and also on the events WS, where the missing socket identity is backfilled with the owner's (`main.ts:189-192`) |
| `PgIdentityRepository` auth-session column names differ from `002` | **TRUE BUT SEVERELY UNDERSTATED** — see §7 |
| Remote design is an untracked working-tree draft needing ratification | **STILL TRUE** |
| Working tree heavily dirty | **STILL TRUE** — `git status` is dirty across contract/execution/server/CLI/UI |
| Contract tests red, 40/43 | **NOT RE-RUN** — out of scope for a read-only pass; flagging as unverified |
| Catalog has 106 ops / 104 v1 | **STALE** — now 110 / 108 / 2 (`catalog.ts:174`) |
| No direct-vs-gateway topology conformance suite | **STILL TRUE** |

Two bullets in the *"Implemented and good"* section have gone stale in a way that matters:
- **#7, "Unavailable remote UI is honest"** (*"'Add server' is visible but disabled with an exact Phase-2 reason"*) — **no longer true.** `AddServerDialog` is real and `addServer()` actually POSTs (`server-registry.ts:156-177`). The honest-refusal specimen has been replaced by a working feature, and no doc records that.
- **#2, "The API is already transport-independent"** — still true, but the count is stale.

---

## 9. The five things that actually matter for remote

1. **There are four remote paths in production, not one, and none of them authenticate.** The UI one (Path C) carries the entire browser app through an unauthenticated forwarder that is dispatched before identity resolution. No doc describes it. Any remote ratification has to decide Path B's fate first.

2. **`remote-proxy.ts` forwards `Authorization` and strips `Origin`.** Both are inert today (nothing mints tokens; nothing checks Origin) and both become live violations the moment R0 lands. The header-forwarding one directly contradicts the design's own central auth property. Fix these *with* R0, not after.

3. **S1 is the only thing holding this up, and it is enforced in the wrong place.** `config.ts:109-115` is a real throw with no env escape hatch — good. But it guards `loadConfig`, not `listen`. Move it to the listen before anything else changes about binding.

4. **R0's identity pre-work is 2-3× its planned size.** Not a rename pass: a rewrite of ~10 methods, a new migration for account/session reads (because `008` deliberately grants `tm8_app` nothing on `accounts`/`auth_sessions`), and edits to `repository.ts` + `service.ts` because the id-keyed token-verification contract is impossible against a schema that never returns the hash. Budget accordingly or R0 slips.

5. **Implementing `security.ts` does not close the browser hole.** The WS upgrade path never calls `checkTransport` (`http/server.ts:105-118`). Real bodies in `checkHost`/`checkOrigin`/`checkCsrf` would harden HTTP and leave all four sockets — events, PTY, proxy-HTTP, proxy-WS — exactly as open as today. The call site has to be added, not just the implementations.

---

## 10. File index (verified paths)

**Real remote code** — `packages/server/src/http/remote-proxy.ts` (147) · `packages/cli/src/server-target.ts` (34) · `packages/cli/src/commands/server.ts` (134) · `packages/tm8-ui/src/servers/server-registry.ts` (185) + `AddServerDialog.tsx` + `index.ts` · `packages/server/src/facade/handlers/w2/server-connections.ts` (17) + `services/w2/server-connections.ts` (99) · `db/migrations/044_local_server_connections.sql` (133)

**Wiring** — `packages/server/src/main.ts:259` (PTY WS), `:288-293` (identityResolver), `:299-312` (proxy target resolver), `:314-322` (composition) · `packages/server/src/http/server.ts:90` (resolveIdentity bind), `:105-118` (upgrade dispatch, no transport check), `:129-135` (transport check + proxy, pre-identity), `:176-182` (route → registry → 501)

**Security surface** — `http/config.ts:62,102,109-115` (S1) · `http/security.ts:51-108` (S2-S6 no-ops + `autoOwnerResolver`) · `http/types.ts:22-30` (`RequestIdentity`) · `pty/pty-ws-server.ts:66-77,90-96,215-245,253` · `events/ws-server.ts:44,110-142` · `events/control.ts:90-107` · `facade/execution-handlers.ts:377,383,828-830`

**Identity (R0 target)** — `identity/pg-store.ts` (427, never executed) · `identity/repository.ts:103` · `identity/service.ts:255,271,278-288` · `identity/loopback.ts:90-112` (the working reference) · `identity/in-memory-store.ts:36` (what the 68 tests actually use)

**Migrations** — `db/migrations/002_identity.sql:45-62,93-101,113-130,167-180` · `007_rpc_catalog.sql:110-350` · `008_rls_policies.sql:204-206,213-234` · `044_local_server_connections.sql`

**Contract** — `catalog.ts:18` (`OperationStatus`), `:33-36` (`serverConnections.*`), `:103` (`search.query`), `:119` (`bridge.fetchBlob`), `:174,191,194` · `contract.ts:654-672` (`ServerConnection` DTOs), `:1203` (`StreamAttachGrant`), `:397-453` (WS frames), `:508-521` (13-code enum), `:597` (`ERROR_STATUS`)

**Enforcement tests** — `packages/cli/test/catalog-exhaustiveness.test.ts:33,39-44` · `packages/contract/test/w1-amendment.test.ts:48-64` · `packages/server/test/w2/reserved-honesty.test.ts:137-217` · `packages/server/test/one-identity-path.test.ts`

**Docs** — `docs/remote/PHASE-2-REMOTE-SERVER-INTEGRATION.md` (321, binding boundary) · `docs/remote/REMOTE-END-TO-END-DESIGN.md` (773, draft) · `docs/remote/REMOTE-STATUS-2026-07-29.md` (202, audit)

**Verified ABSENT** — no `packages/gateway`, no `packages/bridge`, no `auth.*`/`gateway.*`/`server.*`/`connection.*` catalog op, no producer of `RequestIdentity.kind === 'bearer'` outside tests, no server-side test of `remote-proxy.ts`, no `ALTER` on `accounts`/`auth_sessions`/`members`/`team_members` after `002`.
