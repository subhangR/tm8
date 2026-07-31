# tm8 — Auth & Identity: verified state of the tree

**Date:** 2026-07-31 · **Tree:** `/Users/subhang/Desktop/Projects/tm8`, branch `main`, HEAD `765115c`, working tree DIRTY.
**Method:** direct file reads + call-graph trace from `packages/server/src/main.ts`. Every claim below carries a `file:line`. Nothing here is taken from `STATE.md` (known stale).

> **⚠ Rev 3 headline (§3.2):** the server connects to Postgres as a **superuser with `rolbypassrls`** and never issues `set local role`, so **migration 008's RLS policy set is largely inert on the read path** — contradicting T-L11 and S9, which both require a low-privilege role. Measured, not inferred. Writes are unaffected. This is the single most consequential finding in this document and it was not in rev 1 or rev 2.

**Revision note (rev 2).** Three claims in rev 1 were wrong, all inherited from `TM8-REMOTE-STATUS-2026-07-29.md` rather than verified against the tree — bearer-token forwarding in the proxy, "no Connection store in the UI", and the size of the `PgIdentityRepository` repair. They are corrected in place and flagged where they appeared (§2.7, §4.1, §5). **The lesson generalizes: the remote docs are the least reliable source in this repo — they were accurate when written and the tree has moved under them.** Verify anything load-bearing against code. Companion: `TM8-REMOTE-DEEP-REPORT.md` (same directory), an independent deep pass on remote.

---

## 0. One-paragraph answer

tm8 has a **fully modelled, largely unwired** auth system. The domain types, scrypt credential hashing, bearer-token format, session lifecycle, and the Postgres claim/RLS binding are all real code. But the **only identity resolver mounted in the running server is the loopback auto-owner** — every request in the live process resolves to the single node owner. Bearer tokens are a declared-but-unreached branch, all four transport security checks (Host/Origin/CORS/CSRF) are pass-through no-ops, and the PTY WebSocket authenticates nothing at all. **Remote has no auth surface at all** — zero `auth.*`/`gateway.*`/`server.*` operations in a 110-op catalog — but it is *not* "0% runtime": there are **four live cross-Server paths** (§4.1), and the three remote design docs describe none of them accurately. The named-Server proxy in particular forwards `authorization` and `cookie` to the upstream, is dispatched before identity resolution, and has zero tests.

There is also a **second, less visible half of the auth story** (§3.3): a run of SQL migrations (`031`–`042`) closing authorization defects in the *command-ledger replay* path — wrong-principal replay, a TOCTOU race, cross-Space resource confusion, and an `AND` that let any role-assuming superuser pass a delivery-worker check. Those guards are real, but the principal half of them is **currently vacuous**, because a one-principal node has nobody to distinguish.

---

## 1. The architectural law (why it is shaped this way)

From `docs/tm8-architecture/01-LAWS.md`:

- **T-L7 — "Auth is always on; local is the degenerate case."** Every node runs the full identity/membership/`can_act_as` machinery. A single-user local node auto-authenticates its owner: one account, one member row per space — *the same code path with one row in it*. Forbids "local mode skips auth" and any second auth code path.
- **T-L11 — Identity binds to Postgres per transaction, not via self-minted tokens.** tm8-server runs as a low-privilege PG role and sets claims with `SET LOCAL` inside each transaction; RLS predicates read those claims. **JWTs exist only at real verifying boundaries — the bridge (Phase 2).** No service-role bypass; every write goes through the `SECURITY DEFINER` RPC catalog.
- **T-L8 — The gateway owns routing + relay only**, never graph data and never the primary account store. Its remote-facing auth surface authenticates *against the server block's identity block*.
- **T-D3 (cited in `02-NODE-AND-GATEWAY.md` §4.1): "no Firebase, no Supabase, anywhere in tm8."** (The `maestro collab` Firebase surface is a *different product* — the maestro CLI — not tm8. Do not conflate them.)

---

## 2. LOCAL — the identity block (`packages/server/src/identity/`, 2147 lines)

### 2.1 Domain model — `identity/types.ts`

| Type | Key fields | Note |
|---|---|---|
| `Account` | `id`, `identityId`, `username`, `displayName`, `isNodeAdmin`, `isOwner`, `status: 'active'\|'disabled'` | `username` is a mutable login handle, **never a key** |
| `IdentityId` | opaque, immutable string | R6 re-key compat: display names live elsewhere so `user@server` can layer on later without rekeying (`types.ts:21-26`) |
| `StoredCredential` | `accountId`, `algorithm: 'scrypt'`, `hash` | encoded verifier only, never plaintext |
| `AuthSession` | `id`, `accountId`, `kind: 'browser'\|'cli'\|'agent'`, `actingAsTeamMemberId`, `tokenHash`, `expiresAt`, `revokedAt` | `agent` sessions are scoped to a `team_member` persona (`types.ts:110-127`) |
| `MemberRecord` | `spaceId`, `identityId`, `role: 'owner'\|'admin'\|'member'` | a human's presence in **one** space |
| `TeamMemberRecord` | `spaceId`, `ownerMemberId` | an agent persona; authz resolves through its owner |
| `ClaimSet` | `identityId`, `accountId`, `isNodeAdmin`, `memberIds[]`, `teamMemberIds[]`, `actingAsTeamMemberId`, `actorId`, `canActAs[]` | what the DB layer binds per transaction |
| `AuthContext` | `{account, session, claims}` | `session` is `null` on the loopback path |
| `SystemDeliveryPrincipal` | branded with a non-exported `unique symbol` | W0 B1 — a **closed** claim set for exactly one delivery-adapter write; carries no actor, no membership, no role, no ambient spawner authority (`types.ts:36-72`) |

Two role axes, deliberately never mixed: **node-level** (`isNodeAdmin` — accounts, invites, resource limits) vs **space-level** (owner/admin/member). Node-admin *never* widens `canActAs`.

### 2.2 Crypto — `identity/crypto.ts` (node stdlib only, zero deps)

- **Passwords:** scrypt, `N=16384, r=8, p=1, keylen=64`, 16-byte random salt. Verifier format `scrypt$N$r$p$<salt b64url>$<derived b64url>` — **parameters travel with the hash**, so they can be raised later without a re-hash sweep. Verify is `timingSafeEqual`, returns `false` (never throws) on a malformed verifier. Measured 0.6–1.0s/derivation under load — login-path only.
- **Account-enumeration defense:** `UNMATCHABLE_VERIFIER` (`crypto.ts:88-91`) — a constant that can never match, so an unknown login spends the same work as a known one. Without it "no such account" returns in µs and "wrong password" in ~100ms.
- **Bearer token wire format:** `tm8s_<sessionId>.<secret>` (`TOKEN_PREFIX = 'tm8s_'`). The session id rides along so verification is one indexed lookup rather than a scan; the secret is `sha256`'d into `auth_sessions.token_hash` and the plaintext **never persists**. `parseToken` splits on the *first* dot after the prefix (ids are opaque; last-dot would be wrong).
- `generateSecret()` = 32 random bytes, base64url.

### 2.3 Claims → Postgres — `identity/claims.ts`

**The trusted claim surface is exactly four GUCs** (Vega ruling 2026-07-25, W1b):

```
tm8.identity_id   tm8.actor_id   tm8.node_admin   tm8.request_id
```

Applied as `SELECT set_config($1, $2, true)` — `true` = transaction-local, so claims never leak across pooled connections.

**Membership and `can_act_as` are deliberately NOT claims.** `008`'s RLS policies resolve them from the `members`/`team_members` rows via `internal.is_space_member()`, `internal.is_space_admin()`, `internal.can_act_as()`. Rationale, verbatim from the file: *"a claim-carried membership list is whatever the server believed at claim-assembly time… every path that changes membership then has a window where the claim disagrees with the rows — and the disagreement is invisible, because RLS happily answers from the claim. Authorization truth lives in rows."* `ClaimSet` still carries the id lists, but only as a server-side pre-check / UX input — **they never reach Postgres**.

**Refinement (found during the identity design pass):** "four GUCs" is what the **server binds**. The **SQL layer already knows six** — `001` also defines `internal.account_id()` (`tm8.account_id`) and `internal.acting_as()` (`tm8.acting_as`, `001:171-173`), documented at `001:138` as *"team_member entity id, or '' when acting as self"*. `internal.actor_id()` is `coalesce(claim tm8.actor_id, internal.acting_as())` (`001:179-181`), and `resolve_actor` is `coalesce(requested, actor_id(), current_member_id(space))`. **`tm8.acting_as` is a correctly-shaped, correctly-ordered claim slot that nothing in TypeScript has ever bound** — the natural seam for token-pinned agent personas, at zero new SQL. Full precedence: envelope request → `tm8.actor_id` → `tm8.acting_as` → own member row, with `can_act_as` authorizing whatever comes out.

`anonymousClaimBindings()` binds `identity_id=''` — 002's helpers then return false for every predicate, reads see zero rows, write RPCs raise `28000`. There is no bypass flag and no client-asserted identity.

**Landmine documented in the file** (`claims.ts:42-58`): `boolClaim` must emit the literal `'true'`/`'false'`, because `001_core_graph.sql:166` tests `lower(claim_text('tm8.node_admin')) = 'true'`. It previously emitted `on`/`off`, which silently degraded every node-admin check to "not an admin". Caught by Deneb against a live DB.

### 2.4 The actor rule — `facade/context.ts`

The least obvious thing in the lane: **`tm8.actor_id` is bound ONLY when the caller explicitly asked for one.** `internal.resolve_actor` (002:277) is `coalesce(requested, actor_id(), current_member_id(space))` followed by a `can_act_as` check. A member row belongs to ONE space — so a globally-bound actor from space A used on a request touching space B fails `can_act_as` and raises `42501` for the space's own owner. Identity is global and always bound; the actor is per-space and left to the database unless the command envelope names one.

> **Structural guard:** `packages/server/test/one-identity-path.test.ts` enforces that `claimsFor` is defined in exactly one file (`facade/context.ts`) and that `set_config` claim binding happens in exactly one file (`db/client.ts`) — because *the same bug (identity-less resolver + globally-bound actor) was independently reintroduced twice in one day by two different lane authors*. **Any auth work must feed this single path, never fork it.**

### 2.5 What is ACTUALLY WIRED — the live request path

```
HTTP request
  → http/server.ts:90   resolveIdentity = opts.identityResolver ?? autoOwnerResolver
  → main.ts:288-293     identityResolver = async () => ({ kind: 'auto-owner', identityId: (await owner()).identityId })
  → facade/context.ts   claimsFor(owner: LoopbackOwner, ctx)  ← signature literally takes the loopback owner
  → db/client.ts        set_config('tm8.identity_id', …, true)
  → Postgres RLS
```

`RequestIdentity.kind` is `'auto-owner' | 'bearer' | 'anonymous'` (`http/types.ts:22-30`) — **`'bearer'` is declared and nothing produces it.** `http/security.ts:102` is the entire resolver: `export const autoOwnerResolver = () => ({ kind: 'auto-owner' })`.

The only place a bearer token *is* honored today is the **raw blob-upload route** (`http/w2-file-upload.ts:46-51`), and that is a per-`uploadId` `FileUploadGrant` token — not an account session.

### 2.6 Loopback auto-owner — `identity/loopback.ts`

This is the live identity, and the file is unusually honest about why it exists:

> *"WHY THIS FILE EXISTS RATHER THAN `IdentityServiceImpl` + `PgIdentityRepository`: that pair is written against a schema that did not land. `PgIdentityRepository` selects `login`, `node_admin` and `password_algo` (real columns: `username`, `is_node_admin`, `password_algorithm`), calls jsonb-returning functions as if they returned records, and passes `ensure_account` 7 arguments in the wrong order when 007 declares 8. **Every identity test that passes today runs against the in-memory repository, so none of that has ever executed.** Repairing it is parked (Orion, post-Phase-1)."*

What it does: resolves the single `owner` account via two claim-free RPCs — `public.resolve_account_credential('owner')` (F2, reads) and `public.ensure_account(...)` (F1, creates, **only while the node has zero accounts**; from the second account on it demands a node admin). Both are claim-free for the same reason: a caller who has not authenticated has no identity to bind. The owner is created with `password_algorithm = null, password_hash = null` — *a loopback-only node may have no password*.

`createLoopbackOwnerResolver` memoizes the **in-flight promise** (not just the result) for the process lifetime, so N concurrent first-requests bootstrap once instead of racing N `ensure_account` calls into the `UNIQUE(is_owner) WHERE is_owner` index. Failure clears the cache so the next request retries.

Also honest: *"WHAT 'AUTO-OWNER' IS NOT: a bypass. It bootstraps a real `accounts` row and then every request runs with that row's real identity claim through the same RLS as anything else. It is sound only because the node binds loopback (S1); the moment that changes, this is replaced by the bearer path (S8), and **those are one change, not two**."*

### 2.7 `PgIdentityRepository` is dead code — verified column by column

`loopback.ts` claims the PG repository was written against a schema that never landed. **Confirmed directly**, `packages/server/src/identity/pg-store.ts` vs `db/migrations/002`:

| pg-store.ts selects | migration 002 / RPCs actually declare | Evidence |
|---|---|---|
| `login` | `username` | `pg-store.ts:97,153,202,262` vs `loopback.ts` (`row.username`) |
| `node_admin` | `is_node_admin` | `pg-store.ts:99,155,202` |
| `password_algo` | `password_algorithm` | `pg-store.ts:108,285,294` |
| `team_member_id` | `acting_as_team_member_id` | `pg-store.ts:115,169,205` vs `002:173` |
| `issued_at` | `created_at` | `pg-store.ts:118,172,205,372` vs `002:176` |
| `last_seen_at` | `last_used_at` | `pg-store.ts:120,174,205` vs `002:178` |

Six columns, all wrong, on both `accounts` and `auth_sessions`. `ACCOUNT_COLUMNS` (`:202`) and `SESSION_COLUMNS` (`:205`) are the shared constants, so **every** account and session query in the file would raise `42703 column does not exist` on first contact with a real database. On top of that, `loopback.ts:9-13` reports it calls jsonb-returning functions as if they returned records and passes `ensure_account` 7 arguments in the wrong order when `007` declares 8.

This is not "a few bugs" — the file has never run.

**And the column names are the *shallow* half.** Two further defect classes, found by the remote deep-dive session and **verified here directly**, mean fixing the columns would still leave the file non-functional:

- **The tables are RLS-invisible to `tm8_app` on purpose.** `db/migrations/008_rls_policies.sql:204-206`, verbatim: *"accounts, auth_sessions, command_ledger, notification_outbox, undo_tokens and space_event_seq get NO policy on purpose. RLS is enabled with zero policies, which means zero rows for `tm8_app` — **the auth RPCs are the only way in**."* `PgIdentityRepository` issues **direct queries** against `accounts` and `auth_sessions`. Those queries fail (or return zero rows) *before a column name is ever parsed* — so the six renames above are necessary but nowhere near sufficient. There is no RPC in `007` to call instead for most of these reads, which means **R0 needs a new migration**, not just a TypeScript fix.
- **Token verification is structurally impossible as designed.** `repository.ts:103` + `service.ts:278-284` do an **id-keyed lookup, then compare `tokenHash` in TypeScript**. But `resolve_auth_session` (`007:110`) is keyed **by hash**, and `007:308` **strips `token_hash` from every payload by design**. The TS layer is asking for a value the RPC deliberately refuses to return. Repairing this requires editing `repository.ts` and `service.ts` — the exact seam `pg-store.ts:4-5` claims is insulated. (Also: `service.ts:255` mints the session id client-side, while `issue_auth_session` has no id parameter.)

**Revised R0 sizing:** ~24 defects across 5 classes touching 10 of 18 methods; only ~7 are renames. The honest repair is a rewrite of ~10 methods **plus 1–3 new RPCs plus seam edits** — i.e. take the design doc's *own* stated alternative (`TM8-REMOTE-END-TO-END-DESIGN.md:355`, "write a fresh minimal query set that mirrors `loopback.ts`'s proven calls") over "align it to the RPC signatures." Both the design doc and the 2026-07-29 status audit describe this as a column-alignment job; **it is 2–3× that.**

### 2.8 Client-side identity today

| Client | How it identifies | Reality |
|---|---|---|
| Browser UI | nothing | `packages/ui/src/real/TmClient.ts:177` sends `Authorization: Bearer` **only** for a file-upload grant. No session token anywhere. |
| CLI | `TM8_BASE_URL` + optional `TM8_AGENT_TOKEN` → `client.ts:212` `headers.authorization = 'Bearer ' + token` | The header is sent; **the server ignores it and resolves the local owner anyway.** |
| Spawned agent | `manifest.ts:494` sets `TM8_BASE_URL`; `bootstrap-manifest.ts:39` `BEARER_ENV = 'TM8_AGENT_TOKEN'` | The carrier exists. **Nothing mints the token** — there is no `teamMembers.mintToken` op. `harness/secrets.ts:17` states plainly that the agent falls back to a loopback auto-owner identity. |

Consequence: **an agent persona's `command_permissions` cannot actually be enforced server-side today**, because the agent presents no persona-scoped identity. S13's containment story is prompt-level only until minting lands.

---

## 3. Security model vs. what is enforced

`docs/tm8-architecture/10-SECURITY-MODEL.md` opens with the framing that matters: *"tm8 v1 is a browser-controlled arbitrary-code-execution system."*

| Rule | Spec | Enforced? |
|---|---|---|
| **S1** loopback-only bind; non-loopback **refuses to start** without token auth | `http/config.ts` | ✅ **YES** — `loadConfig` throws `ConfigError` on non-loopback `TM8_BIND`. A refusal, not a warning. This is the single control holding the whole model up. |
| **S2** Host-header allowlist (DNS rebinding) | `http/security.ts:53-56` | ❌ `checkHost` → `return ALLOWED` |
| **S3** WS Origin check | `http/security.ts:58-61` | ❌ `checkOrigin` → `return ALLOWED` |
| **S4** CORS same-origin | same fn | ❌ no-op |
| **S5** auto-auth owner only for requests passing S1–S4 | — | ⚠️ auto-auth happens; S2–S4 don't run, so the qualifier is vacuous |
| **S6** `X-TM8-Client` on cookie mutations | `http/security.ts:63-69` | ❌ `checkCsrf` → `return ALLOWED` |
| **S8** bearer auth for CLI/agents | — | ❌ declared type, no resolver, no minting op |
| **S9** low-priv PG role + `SET LOCAL`, no service-role bypass | `db/client.ts`, `claims.ts` | ❌ **NO — the claim half yes, the role half NO. See §3.2.** |
| **S10** spawn only through the catalog + command ledger | — | ✅ |
| **S11** server-computed paths | — | ✅ |
| **S14** PTY attach requires an authorized grant | `pty/pty-ws-server.ts` | ❌ **NO — see below** |
| **S15** secrets never enter Postgres (manifests store env var *names*) | `spawn/manifest.ts` | ✅ |

`security.ts` does not pretend otherwise — it is a file of named no-ops with a scope-trim note and the line: *"This must not ship to G1A unclosed."* The residual exposure it names is adversary **A1**: a malicious page in the user's own browser reaching `127.0.0.1:4610`.

### 3.1 The sharpest hole — PTY WebSocket

`packages/server/src/pty/pty-ws-server.ts`. The upgrade handler reads **only** `?sessionId=` (`:221`), checks it is non-empty, checks the `Upgrade: websocket` header (`:226`), and completes the handshake. It then wires:

```ts
onInput: (data) => pty.write(sessionId, data),   // :253
```

No grant lookup, no token, no identity, no Origin check, no view-vs-drive mode. **Knowledge of a `sessionId` is full read *and write* access to a live terminal running as the user.** Today this is bounded only by S1 (loopback) — but any malicious page in the user's browser can open a WebSocket to `127.0.0.1:4610` and, since S3 is a no-op, will not be rejected on Origin.

**It is worse than "unauthenticated".** `isPtyUpgrade` (`pty-ws-server.ts:90-96`) discriminates on the **query param alone, with no pathname check**, and `main.ts:263` tries the PTY handler *first* — so it answers at **any path**, e.g. `GET /favicon.ico?sessionId=<uuid>`. The `101` is written at `:240-245` **before** the session-existence check at `:280`, which makes it a **session-id oracle**. And view-vs-drive is decorative: `execution-handlers.ts:828-830` returns **byte-identical, tokenless URLs for both modes**, so "view-only" is a label with nothing behind it.

The upstream `grant_stream_attach` RPC already accepts a `tokenHash` parameter, **hardcoded to `null`** (`facade/execution-handlers.ts:322`, "bearer tokens for streams are post-G1A"). `StreamAttachGrant.token` already exists as an optional field in the contract (`contract.ts:1073-1081`). So the shape is there; the enforcement is not. Fixing it is a genuine architectural addition, not a flag flip: `PtyWsServerOptions` is `{pty, logger}` today — no DB handle, no identity, no authorize hook — so it needs a new `grantLookup` dependency threaded through `main.ts:237`.

---

### 3.2 ⚠ THE BIGGEST FINDING — the server connects to Postgres as a **superuser with `rolbypassrls`**, so RLS is inert on the read path

T-L11 is explicit: *"tm8-server executes as a dedicated **low-privilege role** (never table-owner/superuser) and sets identity claims with `SET LOCAL` inside each transaction; RLS predicates and `can_act_as` read those claims."* S9 restates it. **The claim half is true. The role half is not.**

Measured against the dev sidecar:

```
$ psql postgres://tm8@127.0.0.1:5442/tm8_dev \
    -tAc "select current_user, session_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user;"
tm8|tm8|t|t
```

`rolsuper = t`, `rolbypassrls = t`. And `PgDb.tx` (`db/client.ts:179-207`) binds the four claims immediately after `BEGIN` — and **never issues `set local role`**. Only three sites in the entire server downgrade the role:

- `events/poll.ts:126` → `set local role tm8_app`
- `events/control.ts:99` → `set local role tm8_app`
- `facade/services/w2/execution.ts:448` → `set local role tm8_delivery_worker`

Meanwhile ~25 files issue direct `from public.*` SELECTs through that same pool. **Every one of them bypasses RLS.** `events/control.ts:96-100` documents this as a *measured production failure* — "this authorizer was allow-all in production" — which is why that one site was fixed; the general case was not.

**Scope, stated precisely.** This is **read-side only**. Every write still goes through a `SECURITY DEFINER` RPC, and those RPCs call `require_space_member`/`require_space_admin`/`require_identity` explicitly — `002:293-296` is emphatic that *"SECURITY DEFINER bypasses RLS, so an RPC that skips these has no protection whatsoever — they are not belt-and-braces, they **ARE** the belt."* So the write guards are unaffected. But **migration 008's entire policy set is largely inert as deployed**, and that is the layer three separate design documents lean on as the authorization backstop.

**Interaction with §2.7 — read this before sizing R0.** I cited `008:204-206` (zero policies on `accounts`/`auth_sessions`) as a hard blocker for `PgIdentityRepository`. Under the *intended* `tm8_app` role that is exactly right: zero policies means zero rows. Under the role **actually deployed**, RLS is bypassed and those queries would return rows. So that specific blocker is conditional on fixing this first — the column-name defects (§2.7) are unconditional either way. Do not let the two cancel out into "it's fine."

**And the fix is not free.** Turning the role down surfaces latent policy gaps as **silent empty result sets rather than errors** — precisely the failure mode `035:24-49` warns about: a grant-only fix converts "permission denied" into "zero rows", and `PgDurableSeqSource.latest` documents `0` as *"this space has never had an event"*, so a reconnecting client would be told to replay a space it is already caught up on. Sequence this deliberately, with the policy set audited first.

---

### 3.3 The sec1 layer — authorization defects in the *idempotency* path (migrations 031–042)

This is the second half of tm8's auth story and it is easy to miss, because it lives entirely in SQL and it is not about "who are you" — it is about **the command-ledger replay being an authorization bypass**.

**The root defect.** `internal.ledger_replay(cmid, operation_label)` resolves a stored result from those two values *alone*:

```sql
select * into ledger_row from public.command_ledger where client_mutation_id = p_cmid;
```

No identity, actor, Space, or input predicate — the only guard was an operation-label comparison, and the six RPCs that called it returned the stored projection **before running their own authorization**. Two independent failure classes fall out:

| # | Migration | The defect |
|---|---|---|
| **Wrong principal** | `031` | A stored replay could be returned to a principal that did not record it. Fixed by `internal.require_replay_principal`, superseding six RPC definitions across `007`/`016`/`029`. |
| **TOCTOU race** | `033` | `031`'s first revision put the pre-check *ahead of* `ledger_replay` — correct sequentially, **bypassable under concurrency**, because the advisory lock that orders cmid contention is taken *inside* the function it preceded. The pin moved inside, where the lock is already held. Also removed a `23514` existence/operation oracle. Blast radius: `ledger_replay` is called by **114 RPC bodies** across `001`–`031`. |
| **Resource confusion** | `032`, `036`, `038`, `041` | Measured at the public HTTP boundary, not inferred: `POST /v2/entities` naming **Space B**, replaying a cmid recorded against **Space A**, *same principal* → `201`, `errorCode: null`, and the caller receives **Space A's entity** while nothing is created in Space B. The positive control (same Space) still returns byte-identical, so this is resource confusion, not broken idempotency. |
| **Actor leak in a loop** | `034` | `queue_tracking_refresh` reintroduced *per-loop-iteration* exactly the globally-bound-actor hazard `facade/context.ts:1-25` documents and avoids per-request: iteration 1 binds `tm8.actor_id` to Space A's member row, iteration 2 fails `can_act_as` in Space B and raises `42501` — **refusing a Space's own owner**, and aborting iteration 1's queued row with it. Only callers in ≥2 Spaces ever saw it. |
| **Assumed ≠ authenticated** | `039` | `internal.require_delivery_principal` tested `session_user <> X AND current_setting('role') <> X` — an **AND**, so satisfying either limb passes. A superuser may `SET ROLE`, so `set local role tm8_delivery_worker` admitted any principal permitted to assume the role. Fixed to `session_user`, the one value `SET ROLE` cannot change because it is fixed at authentication. |
| **Absent means destroy** | `037`, `042` | `on conflict … do update set props = excluded.props` is a **wholesale replacement** — any field the caller didn't mention is written `null` over the stored value. Measured on `set_work_state`: a handover `note` silently wiped on a status transition, with **no flag to pass** (the field is optional in the schema and unnamed in the frozen CLI grammar). Repaired in `set_work_state`, `w2_edit_message`, `set_pull_state`, plus an unauthenticated write in `reset_session_wake_budget_for_member_reply`. |

#### ⚠ The gap the whole sec1 program missed: `ledger_record` has no principal check at all

Every migration from `031` to `042` hardened **`ledger_replay`** — the *read* side. Nobody guarded the *write* side. `internal.ledger_record` (`046:95-105`), verified directly:

```sql
insert into public.command_ledger(client_mutation_id, identity_id, actor_id, operation, result)
values (p_cmid, internal.identity_id(), internal.actor_id(), p_operation, p_result)
on conflict (client_mutation_id) do update
  set result = coalesce(command_ledger.result, excluded.result)
returning operation, result into stored_operation, stored_result;

if stored_operation <> p_operation then   -- ← the ONLY guard, and it compares LABELS
  raise exception ...
end if;
return coalesce(stored_result, p_result); -- ← returns the FIRST recorder's result
```

**There is no identity comparison anywhere on this path.** A second principal colliding on a `clientMutationId` gets handed the first recorder's stored result, with only an operation-label match standing in the way. That is the same cross-principal disclosure `031` was written to close — reachable through the *other* door, at **~98 call sites**, with **zero** guards and **no test**, because nothing was ever built here to test.

This is the single highest-value sec1 item outstanding.

**Two things make this layer worth reading in full before touching auth:**

1. **`036`'s warning generalizes.** `ledger_replay` resolves on `(cmid, label)` and *cannot tell which function called it* — so **every function sharing an operation label is a door onto the same ledger rows**, and a guard at one door does nothing at any other. `entities.create` has **eleven doors**, all granted to `tm8_app`, measured from `pg_catalog` on the applied chain rather than read off the files. The migration is explicit that binding one door would have been *worse than binding none*: the acceptance test (`test/w3/xg03-same-principal-resource-confusion.test.ts`) drives one door, so binding only that door turns the test green while the defect stays open through the other ten — consuming the only executable proof. Any future guard must be written per-label, not per-function.

2. **The principal pin is currently vacuous, and `036` says so.** *"033's pin is PRINCIPAL-only and PASSES here, because Phase-1 runs a single loopback [owner]."* With one principal on the node, principal-binding cannot distinguish anyone. **The sec1 principal work only starts paying rent the moment bearer auth lands** — which means R0 must not treat "031/033 already shipped" as coverage.

**Mitigating fact, precisely stated.** Migration `046` adds a kill switch, but the two defaults disagree and the direction matters: the **database** default is *strictly enabled* ("including for direct psql use and every pre-existing deployment"), while the **server** supplies `off` by default (`http/config.ts`, `envBoolean(TM8_IDEMPOTENCY_ENABLED, …, false)` → per-connection `tm8.idempotency_enabled=off`). So through a default-configured tm8-server the replay path is dormant and this whole class is unreachable — (NB: `046:6-8`'s own header — "strictly enabled including every pre-existing deployment" — is true of the SQL default and **false of the server**, which never leaves the setting absent.) It is live for direct `psql`, for anything that sets `TM8_IDEMPOTENCY_ENABLED=true` (which the retry/idempotency tests do), and for any deployment predating `046`.

> Migration discipline worth knowing before you edit any of these: `db/migrate.mjs` **checksums every applied migration and hard-fails on drift**. Fixes are forward-only — the vulnerable text is deliberately left byte-identical in `007`/`016`/`029`, so *reading those files gives you the vulnerable version*. Always check whether a later migration supersedes the definition you're looking at.

---

## 4. REMOTE — what exists

### 4.1 What is REAL

**One thing, and it is deliberately unauthenticated: named local Server connections.**

- **Migration `044_local_server_connections.sql`** creates `public.server_connections (id, name, base_url, username, …)`. The comment is explicit: *"These rows are routing configuration, not graph entities. They deliberately contain **no password**: Phase 1 has no remote authentication boundary, and a credential that is stored but never used would only create secret exposure."* `username` is stored as future auth metadata only. RLS: node-admin select only. Create/delete go through `SECURITY DEFINER` RPCs that `require_node_admin()` and record to the idempotency ledger.
- **`packages/server/src/http/remote-proxy.ts`** implements `/v2/server-connections/:name/proxy/<upstream>`. It resolves the name to a `base_url`, strips `host`/`origin`/`referer`, stamps an `x-tm8-server-proxy-hop: 1` header to refuse loops, restricts upstream paths to `/health` and `/v2*`, and pipes both HTTP and WS upgrades. **Server A's bearer token is deliberately NOT forwarded to B.**
- CLI: `tm8 server add|get|list|remove` and `tm8 --server <name> …`. `add` checks the target's `/health` first.

> ### ⚠ CORRECTIONS — two claims in earlier revisions of this brief were WRONG
>
> **(a) "Server A's bearer token is deliberately NOT forwarded to B" is FALSE for the proxy path.** That sentence came from the 2026-07-29 status doc, which was describing the *CLI* path only. `remote-proxy.ts:38-47` does `const next = {...headers}` and deletes **only** `host`, `origin`, `referer`, `content-length` — so **`authorization` and `cookie` are forwarded verbatim to the upstream Server.** It also strips `Origin`, which would launder away any S3 Origin check the upstream later grows. This is a shipped violation of the design's own central auth property, and **none of the three remote docs mention it.**
>
> The contrast is the point: **the codebase states the rule in one path and breaks it in another.** `packages/cli/src/server-target.ts` explicitly sets `token: undefined` with the comment *"Server A's token belongs to A. Authentication for B is a later slice; never leak one node's bearer material to another origin."* `remote-proxy.ts` forwards it. Same repo, same release, opposite behavior — so this reads as an oversight in the proxy, not a considered trade.
>
> **(b) "No Connection store in the UI" is FALSE.** `packages/tm8-ui/src/servers/server-registry.ts` (185 lines) is real and **mounted**: `App.tsx:35` → `GateApp.tsx:80,366,377,395,425` route the whole browser app through `activeServer.routeBaseUrl`. `AddServerDialog` genuinely `POST`s to `/v2/server-connections` (`server-registry.ts:156-177`). The status doc's *"Add server is visible but disabled with an exact Phase-2 reason"* and *"Unavailable remote UI is honest"* are **no longer true** — an honest-refusal specimen became a working feature and no doc records the change.
>
> **Also structural:** the proxy is dispatched **before identity resolution** — `http/server.ts:132-135` (HTTP) and `:107-109` (WS upgrade) return before `resolveIdentity` at `:179`; the WS upgrade path never calls `checkTransport` at all. And the node-admin RLS on `server_connections` is satisfied by **the server's own owner claims** (`main.ts:299-312`), not the caller's. There are **zero server-side tests** for `remote-proxy.ts`.
>
> So there are **four** live remote paths, not one: the CLI `--server` name-registry redirect (`server-target.ts:30-32`, which does drop the token), the HTTP/WS proxy, the mounted UI server switcher, and UI PTY traffic riding the proxy.

Proven working (per `docs/plans/TM8-REMOTE-STATUS-2026-07-29.md`): two real Servers on `127.0.0.1:4710` and `:4720` with separate databases; through A's `remote-b` connection the CLI created a Space, Teammate and ProjectResource on B, linked the project, and spawned a work session that ran on B.

Both ends are still loopback-only, so this is **multi-process on one machine**, not multi-machine.

### 4.2 What is ABSENT

- No `auth.login` / `auth.refresh` / `auth.revoke` / `auth.sessions.list` / `auth.exchangeGatewayToken` — **no `auth.*` operation exists in the catalog at all.**
- No `teamMembers.mintToken` — nothing mints an agent bearer token.
- No `server.describe`, no stable persisted Server identity.
- No `gateway.*` ops; **no gateway package, no bridge package, no relay, no hosted-Server process manager.**
- No bearer identity resolver. No `--server` auth. No cross-Server pull/projection (`bridge.fetchBlob` is contract-**reserved** and forced to 501). (A Connection store **does** exist in the UI — see the correction box in §4.1.)
- Catalog measured directly: **110 operations, 108 `v1`, 2 reserved** (`search.query` `catalog.ts:103`, `bridge.fetchBlob` `:119`). Zero `auth.*`, `gateway.*`, `server.*`, `connection.*`, `mintToken`, `login`, or `token` operations. The status doc's "106 operations" is stale.
- **No Firebase and no Supabase**, correctly — T-D3 forbids them in tm8. (`docs/crib-supabase/` is reference material, not a dependency.)
- A second machine is unreachable **by design**: `loadConfig` refuses non-loopback binds.

**Firebase/Supabase — confirmed absent, and actively policed.** The only occurrence of either string anywhere in `packages/`, `db/`, `deploy/`, `scripts/`, or `tools/` is in `packages/ui/src/collab-v2/__tests__/foundation/seam-purity.test.ts:18-19`, where they are **forbidden patterns** the test greps for. T-D3 is enforced by a test, not just asserted in a doc.

**A VPS deployment exists but cannot be remote.** `deploy/tm8-server.service` is a real systemd unit (`User=ubuntu`, `WorkingDirectory=/home/ubuntu/tm8-workspace`, `EnvironmentFile=/etc/tm8/tm8.env`, `UMask=0077`), and `deploy/runtime-package.json` pins the runtime deps. But S1 still applies: that process **refuses to start** on a non-loopback `TM8_BIND`. So a tm8 server on a VPS today is reachable only via an SSH tunnel or a same-box reverse proxy — and if you put a proxy in front of it, every request still resolves as the loopback auto-owner, i.e. **anyone who reaches the proxy is the node owner**. `docs/ops/CONFIG.md` documents no TLS, domain, or proxy story. Do not expose this unit until R0 lands.

### 4.3 What is DESIGNED (implementation-ready, unratified)

`docs/plans/TM8-REMOTE-END-TO-END-DESIGN.md` (773 lines, 2026-07-27, status: **design draft, for adversarial review**) closes the 15 wire-spec items in `docs/plans/PHASE-2-REMOTE-SERVER-INTEGRATION.md` §11. Highlights:

- **New ops**, landing as `status: 'reserved'` first (precedent: `search.query`, `bridge.fetchBlob`): `server.describe` (GET `/v2/server`), `gateway.listServers`, `gateway.resolveServer`, `auth.login`, `auth.exchangeGatewayToken`, `auth.refresh`, `auth.revoke`, `auth.sessions.list`, `teamMembers.mintToken`.
- **Direct login:** `auth.login {username,password}` → verify `StoredCredential` (scrypt) → mint `AuthSession(kind='browser'|'cli')` → return plaintext token once → client sends `Authorization: Bearer`.
- **Gateway exchange:** the gateway mints a short-lived **HMAC-signed assertion** `{subject, serverId, exp}` using a gateway↔Server verification key established at hosted-Server registration (a one-time admin bootstrap). The **hosted Server verifies the signature and mints its own `AuthSession`** through the identical mechanism `auth.login` uses. The gateway never issues, stores, or validates the Server-scoped token — this is what keeps T-L8/R1 ("gateway is never the primary account store") true under exchange. The claim is the **subject string** recorded at registration, never a raw `accountId` shared across namespaces. On unknown subject → `forbidden`; the hosted Server **never auto-provisions** an Account (that would make exchange a silent account-creation path).
- **The wiring, not greenfield:** `identityResolver` (`main.ts:288`) gains a *second* implementation — `createBearerIdentityResolver(db)` — that hashes the incoming `Authorization` header, looks up `AuthSession` by `tokenHash`, checks expiry/revocation, and returns `{kind:'bearer', identityId, actorId, actingAsTeamMemberId?}`. **`claimsFor` and `db/client.ts` do not change at all.** The WS authorize seam calls the same resolver.
- **Named pre-work, not a design question:** `PgIdentityRepository` must be fixed or replaced (its auth-session column names differ from migration `002`: `team_member_id`/`issued_at`/`last_seen_at` vs `acting_as_team_member_id`/`created_at`/`last_used_at`).
- **Errors:** the 13-code enum stays closed. New `details.reason` values ride `upstream_unavailable` (503, retryable — `gateway_unreachable`, `server_unreachable`, `server_not_hosted`, `server_starting`, `token_exchange_failed`) and `not_implemented` (501, **not** retryable — `contract_version_unsupported`). New optional `ErrorDetails.origin: 'gateway'|'home_server'` tags the failing hop.
- **CSRF:** bearer-in-header has no ambient-cookie surface, so no CSRF token scheme is introduced — stated as a decision, not a gap.
- **Token storage:** CLI → OS keychain else `0600` file; browser → in-memory + encrypted per-Connection store (httpOnly cookies are impossible: different origin per Connection). Short access token (~1h) + long refresh (~30d).
- **Revocation:** effective on the next request (the resolver checks every time); live WS sockets need a periodic re-check (~60s poll) or they survive revocation.
- **PTY grant token must ride the WS upgrade URL as a query param** — browsers cannot set headers on an upgrade. This is the first live bearer-equivalent secret tm8 puts in a URL, so **access logs must redact the `token` query param** (15-min TTL < typical log retention).

### 4.4 Delivery order (from the 2026-07-29 status doc)

- **R0 — stabilize/harden local:** green contract suite + frozen checkpoint; fix `PgIdentityRepository` against `002`; implement bearer resolution through the single identity seam; enforce Host/Origin/CORS/CSRF; **require an attach grant on PTY upgrade and enforce view-vs-drive.**
  *Exit: a bearer-authenticated non-loopback Server can be enabled, and a hostile browser cannot attach to or drive a PTY.*
- **R1 — direct Connection MVP (before any gateway):** stable Server identity + `server.describe`; freeze `ConnectionRecord` + auth DTOs in `@tm8/contract`; auth login/refresh/revoke; CLI `server`/`connection` + `--server`; Connection store with opaque secret refs; per-Server seam in the UI, `/s/:serverId/...` prefix; event state keyed `(serverId, spaceId)`, one WS per Server; execution + terminal sockets targeted at the session's home Server.
- **R2 — cross-Server pull/report-back** (bridge as a catalog client, not a second API).
- **R3 — gateway + hosted Servers.**

Two delivery risks the same doc flags: the remote design is an **untracked working-tree draft needing explicit ratification**, and the **working tree is heavily dirty** across contract/execution/server/CLI/UI — remote work should start from a named stabilized checkpoint.

---

## 5. The nine things that actually matter

1. **⚠ The server talks to Postgres as a superuser with `rolbypassrls`, so RLS is inert on the read path** (§3.2). Measured: `tm8|tm8|t|t`. `PgDb.tx` never issues `set local role`; only 3 sites do, against ~25 files doing direct `from public.*` SELECTs. T-L11 and S9 both require a low-privilege role. **Migration 008's policy set — the authorization backstop three design docs lean on — is largely not enforced as deployed.** Writes are unaffected (SECURITY DEFINER RPCs carry their own explicit guards). Fixing it will surface latent policy gaps as *silent empty result sets*, not errors, so sequence it with the policy set audited first.
2. **There is exactly one identity path, and it is guarded by a test.** `claimsFor` in `facade/context.ts`, claim binding in `db/client.ts`. Adding bearer auth means adding a *resolver*, not a path.
3. **S1 is load-bearing for everything else.** Non-loopback refusal is the only reason S2/S3/S4/S6/S8/S14 being unimplemented is survivable. Remove it before the others land and the whole model inverts.
4. **The PTY WebSocket is the sharpest hole** — `sessionId` alone grants terminal read+write; it answers at *any* path (the handler discriminates on the query param only); the `101` precedes the existence check, making it a session-id oracle; and view-vs-drive returns byte-identical tokenless URLs. S3 (Origin) is a no-op, so a malicious page in the user's own browser is in scope today.
5. **The named-Server proxy forwards `authorization` and `cookie` upstream** (`remote-proxy.ts:38-47`) while stripping `Origin`, is dispatched **before** identity resolution, never runs `checkTransport` on the WS path, and has **zero tests**. Shipped code contradicting the design's own central auth property, unmentioned in any doc. Earlier revisions of this brief asserted the opposite — see the correction box in §4.1.
6. **`PgIdentityRepository` has never executed, and it is not a rename job.** Beyond six wrong column names, `008:204-206` gives `accounts`/`auth_sessions` **zero RLS policies on purpose** ("the auth RPCs are the only way in") while the repository queries them directly, and token verification is structurally impossible because the RPC is hash-keyed and strips `token_hash` by design. **R0 needs a new migration plus seam edits — 2–3× the planned size.** See §2.7.
7. **`ledger_record` was never guarded — the sec1 program hardened only the read side.** `046:95-105` has **no identity comparison at all**; a cmid collision returns the first recorder's result behind an operation-label check. ~98 sites, zero guards, no tests. **If you act on one sec1 item, make it this** (§3.3). Related: `require_node_admin` is vacuous today, and it is the guard `044`'s `server_connections` RLS *and* both write RPCs depend on — so the node-admin gate on remote-connection management is a check that has never refused anyone, over a role that bypasses the policy anyway.
8. **The sec1 principal pin is vacuous until bearer auth lands** (§3.3). Principal-binding cannot distinguish anyone on a one-principal node, so "031/033 shipped" is not coverage — those guards start being tested for the first time on the day R0 lands. And any new replay guard must be written **per operation label, not per function**: `entities.create` alone has eleven doors onto the same ledger rows.

9. **Agent persona isolation is currently prompt-deep.** `TM8_AGENT_TOKEN` is a carrier with no minter, so a spawned agent resolves as the node owner. S13's server-side `command_permissions` enforcement cannot bind until `teamMembers.mintToken` exists.

---

## 6. File index

**Identity block** — `packages/server/src/identity/`: `types.ts` (191) `service.ts` (467) `pg-store.ts` (427, unexercised) `in-memory-store.ts` (249) `crypto.ts` (126) `loopback.ts` (138, **the live path**) `system-delivery-principal.ts` (137) `repository.ts` (117) `index.ts` (102) `claims.ts` (97) `ids.ts` (70) `errors.ts` (26)

**Frame/auth** — `http/config.ts` (S1) · `http/security.ts` (S2–S6 no-ops + `autoOwnerResolver`) · `http/types.ts` (`RequestIdentity`) · `http/server.ts:90` · `http/w2-file-upload.ts` (only real bearer use) · `http/remote-proxy.ts` · `main.ts:288-311` · `facade/context.ts` (`claimsFor`) · `facade/handlers/identity.ts` · `pty/pty-ws-server.ts` (**ungated**)

**Migrations** — all under `db/migrations/` at the **repo root**, not `packages/server/` — `001` (`internal.is_node_admin`) · `002` (accounts/auth_sessions/`resolve_actor`) · `007` (`ensure_account`) · `008` (RLS policies) · `031`–`042` (sec1 principal/resource binding, replay pinning) · `039` (delivery principal session-user-only) · `044` (server_connections)

**Docs** — `docs/tm8-architecture/`: `01-LAWS.md` `02-NODE-AND-GATEWAY.md` `10-SECURITY-MODEL.md` · `docs/plans/`: `PHASE-2-REMOTE-SERVER-INTEGRATION.md` (binding boundary) `TM8-REMOTE-END-TO-END-DESIGN.md` (773-line draft) `TM8-REMOTE-STATUS-2026-07-29.md` (audit)
