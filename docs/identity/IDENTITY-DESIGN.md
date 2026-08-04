# tm8 — Identity Design: who is doing what, everywhere

**Date:** 2026-07-31 · **Tree:** `/Users/subhang/Desktop/Projects/tm8`, branch `main`, HEAD `765115c`, working tree DIRTY.
**Scope:** identity ONLY. This document designs what identities exist, how they compose, how they travel on every request, and how entities record where they came from. It does **not** design authorization, permissions, RLS policy, or threat models — the user was explicit ("for now I am not concerned about who can access what"). Where a decision touches future authorization, it is marked in one line and dropped.
**Method:** every claim about current behaviour was verified directly against the tree with `file:line`; the four briefing documents (`IDENTITY-DESIGN-BRIEF.md`, `TM8-AUTH-AND-IDENTITY-BRIEF.md` rev 3, both remote deep reports) were read in full but not trusted for any load-bearing citation without re-checking.
**Status:** DESIGN. No implementation code is in this document and none was written.

---

## 0. The design in one page

**The user asked for:** server, server-user, session, teammate on every request; origin server on every entity; simple, clean, works across remote; identity only.

**The answer, compressed:**

1. **tm8 already owns every noun it needs except one.** `identity_id` (the human), `member` (that human in one space), `team_member` (an agent persona), `work_session` (an execution session), `account` (login on one server) are all real, keyed, and correctly shaped. The one missing noun is **`serverId`** — a stable identity for the server itself. Nothing else new is invented.

2. **Identity travels in exactly two places, and nowhere else.**
   - **The credential** — `Authorization: Bearer` on HTTP, `?token=` on WebSocket upgrades — proves *who* (identity) and, for agent tokens, *pins* the teammate and the work session. Today the credential is the loopback itself (auto-owner); the bearer path is the same seam with a second resolver.
   - **The command envelope** — the existing body fields `{actorId?, clientMutationId?}` (`facade/context.ts:32-35`), extended with one optional field, `workSessionId` — *requests* an actor and *declares* a session. Requests are validated by the database (`internal.resolve_actor` → `internal.can_act_as`, `002_identity.sql:277-291`, `:254-272`); declarations are overridden by the credential when the credential pins one.
   - Everything else (`identityId`, `serverId`, `requestId`) is **derived server-side**, never client-asserted. This is T-L11 kept intact.

3. **The one identity path stays one path.** All of this lands as: a second `IdentityResolver` implementation behind the existing seam (`http/server.ts:90`, `main.ts:288-293`), a wider input to the single `claimsFor` in `facade/context.ts`, and up to two additional claim bindings in the single binder `db/client.ts` — one of which (`tm8.acting_as`) **already exists as a SQL slot** (`001_core_graph.sql:171-173`) that nothing in TypeScript has ever bound. No new path, no fork; §2.5 states the compliance mechanically.

4. **The spawn gap closes in two independent stages.** Stage 1 (no auth infrastructure at all): `composeEnv` additionally exports `TM8_ACTOR_ID` — the CLI already reads it (`cli/src/context.ts:83`) and already puts it in every mutation body (e.g. `commands/session.ts:169`). Agent writes immediately land as the teammate, authorized by the existing `can_act_as`. Stage 2 (bearer): spawn mints a per-session `agent` token that pins persona + work session, making the identity unforgeable rather than merely requested.

5. **Origin server = the server the entity lives on.** Under T-L5 (single-homed spaces) that is a tautology worth exploiting: entities need **no new column**. The server gets an id and a `server.describe`; anything that *leaves* the server (a projection, an export, a pulled copy) carries `{originServerId, originEntityId, pinnedVersion}` in the edge props, extending the exact shape `pulled`/`tracks` edges already carry (`018_w2_edges_placements.sql:32-38`).

6. **Firebase: not now — and if ever, only as a login method that binds to a locally-owned account row.** The full argument is §6. The one-line version: the identity model in this document is *identical* under password login, portable `user@server` identity, and an external IdP — which means the Firebase decision does not block identity stabilization and should not be paid for (a law amendment, two armed CI gates, an offline story, a vendor) before a second server with real users exists. The seam that keeps the option open (credential *kinds* on the account) costs one sentence in this design and nothing in law.

---

## 1. The model — nouns, meanings, composition

### 1.1 The nouns

| Noun | Exists? | What it means | Key facts (verified) |
|---|---|---|---|
| **`serverId`** | ❌ NEW | This server, as a stable, opaque identity. Minted once at first boot, never changed. | Grep for `serverId` in `packages/server/src` + `packages/contract/src` (non-test): **zero hits**. It exists only in the remote design draft. This is the single new noun in this design; justification: the user named "server" and "origin server" as required, and nothing in the tree can answer "which server is this?" — `/health` reports only `contractVersion` and counts. |
| **`identity_id`** | ✅ | The permanent, opaque, immutable id of a human *on one server*. | `identity/types.ts:17-22` — explicitly documented so `user@server` addresses can layer on later "without rekeying". Not shared across servers, ever (§5.1). |
| **`account`** | ✅ | That identity's login on this server: username, credentials, node-role. | `identity/types.ts:77-95`. `username` is "mutable … never a key" (`:81`). One `is_owner` row per node. |
| **`member`** | ✅ | The identity's presence in exactly **one** space. The human-shaped **actor**. | `identity/types.ts:129-135`; a member row belongs to one space — this is why the actor claim must never be bound globally (`facade/context.ts:6-24`). |
| **`team_member`** | ✅ | An agent persona, owned by a member. The agent-shaped **actor** — the user's "teammate". | `can_act_as` authorizes it through its owner's identity (`002_identity.sql:263-270`). 8 rows live. |
| **`work_session`** | ✅ | One execution session of an agent — the user's "session". | An entity kind; `Tm8Manifest.sessionId` names it (`execution/src/spawn/types.ts:226`) and `TM8_SESSION_ID` carries it into the agent env (`manifest.ts:492`). |
| **`auth_session`** | ✅ (schema) / ❌ (runtime) | Proof-of-identity with a lifetime: `browser` / `cli` / `agent`; agent sessions pin a persona. | `identity/types.ts:113-127`; `acting_as_team_member_id` at `002_identity.sql:173`. Zero rows ever issued (measured 2026-07-31). |

**Deliberately not nouns:** "user" (ambiguous between identity and account — this design always says which), "principal" (reserved for the delivery-adapter machinery that already owns the word, `identity/types.ts:37-69`), and "origin" as a standalone id (origin *is* a `serverId`; see §3).

### 1.2 How they compose

```
 ONE SERVER ──────────────────────────────────────────────────────────────┐
 │  serverId  (NEW — minted once, opaque, immutable)                      │
 │                                                                        │
 │  human ──► identity_id ──► account (username, credentials, node role)  │
 │               │                                                        │
 │               │  per space (T-L5: each space single-homed here)        │
 │               ├──► member ─────────────┐                               │
 │               │      │ owns            │  "actors": the only two kinds │
 │               │      └──► team_member ─┘  that appear as created_by /  │
 │               │                           actor_id in the graph        │
 │               │                           (001:338, 003:34)            │
 │  proof:       └──► auth_session (browser|cli|agent)                    │
 │                      agent sessions pin: team_member + work_session    │
 │                                                                        │
 │  execution:  work_session (entity) — what an agent runs inside         │
 └────────────────────────────────────────────────────────────────────────┘
```

### 1.3 The composition rule — four verbs

The whole design reduces to four verbs, one per identity dimension. This is the sentence to test any future change against:

> **Identity is *proven*. The actor is *requested*. The session is *pinned* (or declared). The server is *ambient*.**

- **Proven** — `identity_id` comes only from credential resolution (auto-owner today, bearer later). It is never a request field. `claims.ts:87-97` is explicit that the only "no identity" shape is the anonymous binding; there is no client-asserted identity.
- **Requested** — the actor (`member` or `team_member`) is *asked for* via the envelope and *authorized* by the database: `resolve_actor` coalesces `(requested, claim, own-member-row)` and then `can_act_as` checks it (`002:277-291`). The server-side rule "bind `tm8.actor_id` only when explicitly requested" (`facade/context.ts:6-24`) is load-bearing and unchanged: a member row belongs to one space, so a globally-bound actor breaks the space's own owner with `42501`.
- **Pinned / declared** — the work session is pinned by an agent token (unforgeable — the token *is* the session's credential) or declared by the envelope when no token pins one (honest but assertable; adequate for audit, upgraded automatically the day tokens mint). A declaration never overrides a pin.
- **Ambient** — `serverId` is the node's own knowledge of itself. Clients never send it; the server stamps it outward (`server.describe`, event-stream identity, projection provenance).

**One line for future authorization (per brief §1):** these four verbs give authz clean inputs — proven identity for RLS, authorized actor for authorship, pinned session for per-session capability (S13 `command_permissions`), ambient server for cross-server policy — and nothing in this design pre-commits any of those policies.

---

## 2. The request tuple — exact fields, exact wire format

### 2.1 What travels (the only two carriers)

**Carrier 1 — the credential.**

| Surface | Format | Notes |
|---|---|---|
| HTTP | `Authorization: Bearer tm8s_<sessionId>.<secret>` | Token format already implemented, `identity/crypto.ts` (`TOKEN_PREFIX`, first-dot split). Header already sent by the CLI when `TM8_AGENT_TOKEN` is set (`cli/src/client.ts:212` per auth brief §2.8) and ignored by the server today. |
| Events WS (`/v2/ws`) | `?token=tm8s_…` on the upgrade URL | Browsers **cannot set headers on a WebSocket upgrade** — a query parameter is the only browser-compatible carrier. Precedent: the remote design already accepts this for PTY grants with the log-redaction caveat; adopt the same rule here (redact `token` in any access log). Identity is **connection-scoped**: resolved once at upgrade, applied to every subsequent `subscribe`/`resume` control frame. The existing control-frame protocol (`contract.ts` §5 block) is unchanged. |
| PTY WS | `?sessionId=…&token=<attach-grant>` | The contract already has the slot: `StreamAttachGrant.token` is an optional field (`contract.ts:1218`); the RPC already accepts a `tokenHash` (currently passed `null`, `execution-handlers.ts:383`). This design uses the already-designed shape; it adds nothing new. |
| Absent credential | — | Resolves exactly as today: the loopback auto-owner (`main.ts:288-293`), which is a *real* account row, not a bypass (`identity/loopback.ts`). T-L7: local is the degenerate case of the same path. |

**Carrier 2 — the command envelope** (mutations only; JSON body):

```
{
  actorId?:          EntityId   // EXISTS — member or team_member entity id; a REQUEST, authorized by can_act_as
  clientMutationId?: string     // EXISTS — idempotency; not identity, listed for completeness
  workSessionId?:    EntityId   // NEW, optional — "this request came from work_session S"
}
```

- `actorId` and `clientMutationId` are the existing `CommandEnvelope` (`facade/context.ts:32-35`) and `CommandContext` (`contract.ts:666`). Adding one optional field is additive; the contract's frozen surfaces (the 13-code error enum, existing op shapes) are untouched.
- `workSessionId` is a **declaration**. When the request also carries an agent token that pins a session, the pin wins and a conflicting declaration is answered with `invalid_input` (existing error code; no enum widening) — a client that lies about its session with a token that knows better should hear so loudly. UNCERTAIN (minor): silently-prefer-pin is defensible too; refusal is recommended because silent correction is the "dishonest surface" class this codebase removes on sight.
- **Reads (GET) carry no envelope and need none.** Reads are scoped by identity, not actor; session provenance matters for *writes* (what gets recorded in the graph); `x-tm8-request-id` (`http/server.ts:298`) already covers read correlation. This asymmetry is deliberate and keeps GET requests clean.

### 2.2 What is derived (server-side only, never on the wire inbound)

For every request, the server derives one principal record through the single path:

| Field | Source | Bound as claim? |
|---|---|---|
| `serverId` | the node's own persisted identity (§3.1) | no — ambient; stamped outward, not into per-request claims |
| `identityId` | credential resolution (auto-owner \| bearer) | yes — `tm8.identity_id` (exists) |
| `accountId`, `isNodeAdmin` | the resolved account row | `tm8.node_admin` (exists) |
| `authSessionId` | the token, `null` on loopback | no (audit via `work_session` + `request_id` suffices; revisit only if authz later needs it) |
| **teammate** (persona) | agent token's `acting_as_team_member_id` | yes — **`tm8.acting_as`** (SQL slot exists, `001:138`, `:171-173`; nothing in src binds it today — verified by the one-identity-path test's own inventory, `test/one-identity-path.test.ts:73-77`) |
| **actor** (effective author) | envelope `actorId` only | yes — `tm8.actor_id` (exists; binding rule unchanged) |
| **`workSessionId`** | token pin, else envelope declaration | yes — **`tm8.work_session_id`** (NEW claim, audit-only) |
| `requestId` | server-generated | yes — `tm8.request_id` (exists; the audit-only precedent the new claim follows) |

**Why `tm8.acting_as` and not a resolver-supplied `tm8.actor_id`:** the SQL already composes them correctly and in the right precedence — `internal.actor_id()` is `coalesce(claim tm8.actor_id, internal.acting_as())` (`001:179-181`), and `resolve_actor` is `coalesce(requested, actor_id(), current_member_id(space))` followed by `can_act_as` (`002:277-291`). So binding the token's persona into `acting_as` gives, with **zero new SQL**: explicit envelope request > session persona > own member row, every step still authorized. It also cannot reintroduce the globally-bound-actor bug: a `team_member` belongs to one space, and an agent session is single-space by construction (`Tm8Manifest.spaceId`, `manifest.ts:495`), while human sessions have no `acting_as` at all.

**Why `tm8.work_session_id` is a claim and not an RPC argument:** threading a session argument through the ~100-RPC catalog is the opposite of "baked into every request"; a transaction-local claim is bound once in the one binder and is visible to every trigger and ledger insert that wants to record it. `tm8.request_id` is the exact precedent: an audit-only claim, in the trusted surface, used for joinability rather than authorization (`http/types.ts:46-50`).

**The widened trusted surface, stated honestly.** The Vega ruling (2026-07-25, W1b) fixed the trusted claim surface at four (`claims.ts:10-14`). This design widens it to six: `+ tm8.acting_as` (already declared in SQL since 001; the ruling's four are the four *bound from TypeScript*) and `+ tm8.work_session_id` (genuinely new). Both are audit/identity claims, not authorization claims — no RLS predicate should read `work_session_id`, and `acting_as` is only ever consumed through `resolve_actor`'s `can_act_as` gate. This needs a one-paragraph ruling amendment, named in §9. The one-identity-path test is *built* for this: its claim list is enumerated by name precisely so a future binding is noticed, not smuggled (`one-identity-path.test.ts:79-86` already names `acting_as`; `work_session_id` gets added to the same list).

### 2.3 Wire summary by surface

```
HTTP mutation   POST /v2/…            Authorization: Bearer tm8s_…        ← proves identity, pins persona+session (agent)
                body { actorId?, workSessionId?, clientMutationId?, … }   ← requests actor, declares session
HTTP read       GET /v2/…             Authorization: Bearer tm8s_…        ← proves identity; nothing else
Events WS       GET /v2/ws?token=…    upgrade-time resolution; control frames (subscribe/resume/presence) unchanged
PTY WS          GET /v2/ws?sessionId=…&token=<attach-grant>               ← grant token per the already-designed shape
Response        { data, requestId }   + x-tm8-request-id header           ← unchanged (DEV-6)
```

No new headers are introduced. The `X-TM8-Client` convention exists today only as a deferred S6 note (`http/config.ts:10-12`) and stays a transport-security concern, not an identity carrier — identity must never depend on a spoofable client label.

### 2.4 What it means when a field is absent

| Absent | Meaning |
|---|---|
| credential | loopback auto-owner (T-L7 degenerate case) — a real account, same path |
| `actorId` | the database picks the caller's own member row for the target space (`current_member_id`) — the common human case |
| `workSessionId` (and no pin) | "not from any work session" — a human at a browser/CLI. Legitimate, common, and honest as an empty claim (`''`, the same convention as unset `tm8.actor_id`, `db/client.ts:185-190`) |
| `serverId` on anything inbound | always — clients never send it |

### 2.5 The one-path rule — mechanical compliance

`test/one-identity-path.test.ts` enforces: `claimsFor` defined only in `facade/context.ts` (`:47-55`), caller-identity claims bound only from `db/client.ts` (`:157-176`), every binding transaction-local (`:214-225`). This design feeds that path at exactly three points and forks nothing:

1. **Resolution** — a second `IdentityResolver` implementation plugs into the existing seam (`http/server.ts:90`; type at `http/types.ts:109`). `RequestIdentity` (`http/types.ts:22-30`) is extended additively (it already declares the never-produced `'bearer'` kind and `actorId`/`token` slots; it gains the pinned `workSessionId`). The auto-owner resolver remains the fallback — one seam, two resolvers, not two paths.
2. **Assembly** — the single `claimsFor` (`facade/context.ts:53-65`) takes the resolved identity + envelope and emits the claim set, now including `acting_as` and `work_session_id`. Its signature today literally takes `LoopbackOwner`; it widens to take the resolved principal. Still the only definition site.
3. **Binding** — `db/client.ts` (`:179-207`) binds the claims in its one `BIND_CLAIMS_SQL` round-trip, extended by two names. Still the only binder; still `set_config(…, true)`.

The test's claim list gains `work_session_id`. Anyone who tries to bind the new claims from a second file goes red exactly as the guard intends.

---

## 3. Entity provenance — what gets stamped, where

### 3.1 Server identity

- **Minting:** an opaque id (uuid), generated once by migration on every existing and future database, stored in a one-row server-identity table alongside a mutable display name (`serverName`, same "never a key" discipline as `username`, `identity/types.ts:81`) and `createdAt`. Opaque-and-immutable mirrors `identity_id`'s documented forward-compat design (`identity/types.ts:17-21`): a future cryptographic identity (key fingerprint) or public address can layer on without rekeying. UNCERTAIN (deliberate deferral): whether `serverId` should *be* a keypair fingerprint from day one. Recommendation: no — keys belong with the phase that verifies signatures (gateway exchange, portable identity); an opaque id that a keypair later *binds to* preserves every option at zero cost now.
- **Exposure:** `server.describe` → `{ serverId, serverName, contractVersion }`, landing `reserved` → `v1` per the documented precedent (`search.query`, `bridge.fetchBlob`; note the coordinated 5-file cost of a catalog row, measured in remote report A §5). The remote design draft already names this op; this design adopts it as the *identity* surface and takes no position on its other fields.
- **Also fixes, for free:** the UI server registry currently health-probes upstreams and keys everything by connection *name* (`tm8-ui/src/servers/server-registry.ts:39-41`); `server.describe` gives it a stable key that survives renames, and gives `tm8 server add` something better than exact-`CONTRACT_VERSION`-match to recognize a server by.

### 3.2 Entities: the origin rule

> **An entity's origin server is the server it lives on.** No per-entity column, no default to backfill, nothing to rekey.

This is not an evasion — it is T-L5 (spaces single-homed, no multi-master, no sync) cashed in as a design simplification. Every entity row sits in exactly one space; every space has exactly one authority node; therefore `origin(entity) = serverId(here)` for every entity a server can see in its own graph. Stamping a column that can only ever hold one value adds a lie waiting to happen (a copied database would carry the wrong stamp) and buys nothing a one-row lookup doesn't.

What entities **already** carry, verified: `created_by` — an actor entity id, NOT NULL, on every entity (`001_core_graph.sql:338`); per-action actor on activity (`003_read_model.sql:34`) and notifications (`:76`); version history `changed_by` (`001:1125-1172`). The *who* at entity level is already stamped; §4 makes it stamped with the right actor for agents.

### 3.3 Where explicit provenance DOES get stamped: anything that crosses the boundary

Provenance becomes real data exactly when content *leaves* its authority server (Phase-4 pull/projection, R2 report-back). The design:

- A projected/pulled copy records `{ originServerId, originEntityId, pinnedVersion }` in the **props of the projection edge** — extending the exact shape the `pulled` and `tracks` edges already declare: `localId` + `pinnedVersion` (+ `pulledAt`) in `018_w2_edges_placements.sql:32-38`. The extension is one prop (`originServerId`) on an existing pattern.
- `originEntityId` is a **value, not a foreign key, and never an edge target**. Provenance is a historical record of where a copy came from — it is NOT replication, NOT a cross-server graph edge, NOT a sync obligation (T-L5). A dangling origin (the remote entity was deleted, the server is gone) is a fact about history, not an integrity error.
- Events and streams need no per-frame stamp: the event socket is per-server (client-side state is already keyed per-server by the mounted registry, and one-socket-per-Server is the remote design's chosen shape), so `serverId` is connection-scoped context, established once via `server.describe`.

**One line for future authz:** provenance stamps are inert identity data; any future rule about "what may be pulled from where" reads them but is not designed here.

---

## 4. Agent and session identity at spawn — the concrete fix

### 4.1 The measured gap

- `composeEnv` (`execution/src/spawn/manifest.ts:485-500`) exports `TM8_SESSION_ID`, `TM8_SPACE_ID`, `TM8_TEAM_MEMBER_ID` (`:492,495,498`) — but **not `TM8_ACTOR_ID`**.
- The CLI resolves its actor from `--as`, else `TM8_ACTOR_ID` (`cli/src/context.ts:83`, precedence at `:190-195`), and every mutation command copies it into the body: `if (cmd.ctx.actor) body.actorId = cmd.ctx.actor.value` (verified at `commands/session.ts:169`, `commands/project.ts:143`, `commands/message.ts:330`, `commands/edge.ts:151`, and ~15 more sites).
- So an agent is told "you are teammate Y" in its prompt, its env names the persona in a variable nothing reads as an actor, its CLI sends no `actorId`, and `resolve_actor` falls through to the owner's member row (`002:283`). **Every agent write is attributed to the human owner.** Prompt-level identity, not wire-level — exactly as the brief states.

### 4.2 Stage 1 — persona on the wire with zero auth infrastructure

**Change (design-level):** `composeEnv` additionally sets `TM8_ACTOR_ID = manifest.agent.teamMemberId` (the manifest already carries it, `spawn/types.ts:245-246`; keep `TM8_TEAM_MEMBER_ID` for prompt/handoff compatibility). Once the envelope carries `workSessionId` (§2.1), the CLI likewise auto-fills it from its already-injected `TM8_SESSION_ID` (`context.ts:81`) on every mutation.

**Why this is correct and not a trust hole *in identity terms*:** the envelope actor is a *request*, and the existing `can_act_as` (`002:254-272`) authorizes it — a team_member may be acted-as by the identity that owns its owning member row. On today's one-account node that identity is the owner, who genuinely owns all 8 personas; the attribution produced ("teammate Y did this, spawned under the owner's identity") is *true*. What Stage 1 does not give is unforgeability between *distinct* identities — which does not exist on a one-identity node anyway and is Stage 2's job. (The brief's gap #2 — "any caller can claim any teammate" — is a one-account tautology today, and becomes a real authorization topic only when accounts multiply. Not designed here.)

**Observable immediately:** `created_by`, `activity.actor_id`, version history, and notification attribution flip from "owner" to the actual teammate for every agent write. This is most of what the user asked for, and it costs one env var, one optional field, and no migration.

### 4.3 Stage 2 — pinned, unforgeable: the per-spawn agent token

At spawn, the server mints an `agent` `AuthSession` bound to the owning member's account, with `acting_as_team_member_id = the persona` (schema slot exists, `002:173`) and — additive schema change, named not written — a link to the spawned `work_session`. The plaintext token goes into the agent env as `TM8_AGENT_TOKEN`: the carrier the CLI already reads (`context.ts:85`) and already sends as `Authorization: Bearer` (`client.ts:212` region), and that the bootstrap manifest already names as the credential seam (`cli/src/harness/bootstrap-manifest.ts:39` `BEARER_ENV`, `:284`). `harness/secrets.ts:17` documents today's fallback honestly; Stage 2 replaces the fallback, not the seam.

The bearer resolver (the second `IdentityResolver`, §2.5) then yields: `identityId` from the account, persona from the session row → `tm8.acting_as`, session pin → `tm8.work_session_id`. The agent no longer *asserts* who it is on any wire; its credential *is* who it is. Token lifecycle (TTL, revocation on session end) follows the session lifecycle — identity-relevant, mechanically per the remote design's auth section, not re-designed here.

**Minting is spawn-internal, not a public catalog op, in this design.** A `teamMembers.mintToken` operation (named in the remote draft) is a *user-facing credential feature* with its own catalog cost (5-file coordinated change per remote report A §5) and can land later without changing anything here; the spawn path minting directly against the identity service closes the gap with zero contract surface. §9 carries this as a decision point.

**Sequencing note (identity-adjacent, out of scope, one line):** a bearer resolver only *scopes* anything once the Postgres role stops bypassing RLS — bearer, role downgrade, and non-loopback bind are one bundle (report B §1.4); this design is the identity half and is deliberately independent of when that bundle ships.

### 4.4 Human sessions

Humans get the same tuple with the agent-only parts empty: browser/CLI credential (Phase R1 `auth.login`, or today's loopback), no `acting_as`, no session pin; `--as` keeps working as an explicit envelope request; `workSessionId` appears only if the human is operating inside a session context that injected `TM8_SESSION_ID`. No special path.

---

## 5. Remote — the same model across servers

### 5.1 The invariant that makes remote simple

> **An `identity_id` never leaves its server.** Your presence on server B is an account row *on B*, with B's own `identity_id`, B's own member rows, B's own personas. Any cross-server "same person" linkage is an *address or a binding* (a `user@server` string, an external-subject claim) — data ABOUT identities, never a shared key.

This falls straight out of what exists: `identity_id` is opaque, immutable, minted locally (`identity/types.ts:17-22`); spaces are single-homed with no cross-server edges (T-L5); the gateway is never the primary account store (T-L8). It also means the Firebase question (§6) is cleanly severable: nothing in this section changes under any answer to it.

### 5.2 "You visiting B", per surface

- **The tuple works on B unchanged.** B's resolver resolves *your B-account*; your actor is your member/team_member on B; `workSessionId` names sessions whose home is B; `serverId` is B's. Nothing multi-server is added to the request format — remote identity is just identity, at a different server.
- **Today, honestly:** connect A→B and you are B's loopback owner (`main.ts:288-293` on B) — there is no "you visiting B" until B can resolve a bearer. The design's remote story *starts* at Stage 2 + R1 login; before that, remote identity does not exist and this document does not pretend otherwise.
- **Credential-per-server is the model** (the git-remotes shape): the client holds one credential per server it visits. `server_connections.username` — stored, documented as future auth metadata, unused (`044_local_server_connections.sql:13,20-21`) — is exactly the "your account name on B" slot for this. The *friction* of this model is the honest cost the user is reacting to; §6 addresses whether a vendor removes it and at what price. What this design guarantees is that the friction is *only* at login/provisioning — the identity model itself never multiplies.

### 5.3 Identity through the proxy: end-to-end or not at all

The shipped proxy (`http/remote-proxy.ts`) forwards `authorization` and `cookie` verbatim upstream (`:38-47` — verified directly; only `host`/`origin`/`referer`/`content-length` are deleted) and is dispatched before identity resolution (`http/server.ts:132-135` vs `:179`). Under this design that is not a security bug to fix later — it is an **identity rule violation**: A's credential *means* "an identity on A" and must never be presented to B as if it meant something there.

The rule this design imposes on any surviving hop: **identity is end-to-end between the client and the authority server. A hop is a pipe, never an identity boundary.** Concretely: a proxy must strip A-scoped ambient credentials, and a client speaking to B *through* A attaches its B-scoped credential explicitly (an upstream-credential header the hop rewrites to `Authorization`, or the client goes direct per the R1 Direct Connection design — whose `server-target.ts:30-32` already states the correct rule: "never leak one node's bearer material to another origin"). Whether the proxy survives ratification at all is the open decision both remote reports flag; this design works under either outcome and merely constrains the surviving shape. A never impersonates you at B; B never sees A as "the user".

**Server-to-server identity** (bridge, report-back, gateway exchange): a server authenticating *as a server* to another server is a Phase-2+ concern the remote draft already designs (HMAC-signed subject assertions, hosted-server registration). This design reserves the noun it needs — `serverId` — and adds nothing else; when that lands, the ambient `serverId` becomes provable rather than claimed, which is the upgrade path §3.1 left open.

---

## 6. The Firebase / global-identity decision

### 6.1 What binds, verified in the tree

- **T-D3:** "no Firebase, no Supabase, anywhere in tm8" — and it is armed, twice: `tools/ci/migrations-check.sh:78` (`FORBIDDEN='supabase|firebase|auth\.uid\(\)|service_role|SUPABASE_'`, build-failing, scoped to `db/migrations/`) and `packages/ui/src/collab-v2/__tests__/foundation/seam-purity.test.ts:17-19` (same strings, scoped to the collab-v2 module). Note the *enforcement* is narrower than the *law* — the law says anywhere; the greps cover the migrations dir and one UI module. Adopting Firebase means amending the law, not just dodging the greps.
- **T-L11:** clients hold no "database or third-party auth material — single boundary: tm8-server"; JWTs only at real verifying boundaries.
- **T-L8/R1:** the gateway is never the primary account store.
- **T-L5 + offline:** a local node is fully offline-capable.
- **T-L7:** one auth code path; local is the degenerate case, never a special case.

### 6.2 What the user's instinct gets right

Credential-per-server is real friction; portable identity is *already* the acknowledged end state (deferred to Phase 4), and `identity_id` was *built* opaque-and-immutable precisely so a portable address can bind to it later without rekeying (`identity/types.ts:17-21`). The user is asking for the Phase-4 benefit sooner, which is a legitimate thing to want — the question is only whether a vendor is the cheap way to get it.

### 6.3 The only acceptable shape, if adopted

There is exactly one Firebase shape compatible with the architecture, and it is worth writing down so the wrong ones can be refused quickly:

> **The local account row stays authoritative; the external IdP is one *login method* that binds to it.** The account gains an optional external binding `(issuer, subject)` as a *credential kind* alongside the scrypt password. Login: client completes the IdP flow, presents the ID token to **tm8-server's login endpoint** — a real verifying boundary, satisfying T-L11's JWT clause — the server verifies it, resolves the binding to *its own* account row, and mints *its own* `AuthSession`. The IdP token never becomes a tm8 credential; nothing downstream of login changes; every request still carries `tm8s_…`. No auto-provisioning on unknown subject (the same rule the gateway-exchange design already states, for the same reason).

Under this shape: T-L8 holds (accounts stay on servers), the identity model of §1–§5 is untouched (the binding is per-server account data — a *hub* answering "which servers know this subject" is directory metadata, exactly the "accounts on a machine someone runs, not a public IdP" framing of `02-NODE-AND-GATEWAY.md` §4). What still breaks, even in the best shape: **T-D3** (law amendment + re-scoping both armed greps), **T-L11's client clause** (the browser/CLI must run an IdP SDK or flow — that *is* third-party auth material at the client), **offline** (an offline node cannot verify a fresh IdP login → a local method must exist anyway → **two login paths, permanently**, against T-L7's spirit), and **self-hosting** (every deployment needs a Firebase project or falls back to the local path — the second path again), plus vendor coupling in the most identity-critical seam.

### 6.4 The comparison that decides it

| | Credential-per-server (now) | + Firebase login binding | Portable `user@server` (Phase 4, planned) |
|---|---|---|---|
| "One identity everywhere" UX | ✗ (one credential per server) | ✓ (one login, per-server accounts) | ✓ (one address + key, per-server accounts) |
| Third party in the login path | none | **Firebase** (Google) | none |
| Offline / self-host clean | ✓ | ✗ needs local fallback → two paths | ✓ |
| Laws touched | none | **T-D3 amended, T-L11 client clause amended, 2 CI gates re-scoped** | none (it is the planned end state) |
| What it costs to build | already the model | IdP verification + binding + hub directory + second login path | key mgmt, discovery, recovery — genuinely hard, but owned |
| Recovery/multi-device story | per-server password | ✓ vendor-provided (the real Firebase win) | must be designed (the real Phase-4 cost) |
| Changes THIS design | — | §6.3 binding seam only | binds an address to `identity_id` — the slot already documented |

### 6.5 The recommendation

**Do not adopt Firebase now.** Not as law-worship — on the merits:

1. **The friction Firebase solves does not exist yet.** Measured: 1 account, 0 auth sessions ever issued, 0 remote servers with real users, no login surface at all in the catalog. The user would be amending a ratified law and re-scoping two armed CI gates to ease a pain that cannot be felt before R1 lands. When there are two real servers and real logins, the decision will be better-informed and no more expensive than today.
2. **The identity model is invariant across the choice** — that is the load-bearing fact of this section. Everything in §1–§5 (the tuple, the claims, spawn, provenance, remote) is identical under password login, Firebase-bound login, and portable identity, because all three are just ways of *proving* the first verb of §1.3 and *provisioning* account rows. Stabilizing identity first, exactly as the user asked, is the move that makes the global-identity decision safely deferrable — the design does not have to choose a vendor to be finished.
3. **When the decision does come due, portable identity is the simpler and cleaner system** — the user's own criterion. Firebase in its only acceptable shape still ends at two permanent login paths, an amended law, and a vendor inside the most identity-critical seam, in exchange for login convenience and a recovery story. Portable `user@server` gives the same "one identity everywhere" with no third party, no law changes, offline intact — its honest cost is building key recovery, and that cost is *why* it is Phase 4, not a reason to buy a vendor now. If, at R1, the user weighs hosted-grade recovery and OAuth onboarding above self-containment, §6.3 is the only shape to build, and the price must be paid in the open: **amend T-D3, amend T-L11's client clause, re-scope `migrations-check.sh:78` and `seam-purity.test.ts:17-19`, accept the permanent second login path, and put a Firebase project into every deployment's ops story.**
4. **What to do *now* about it, so the instinct is honored rather than shelved:** the account model in this design carries **credential kinds** (§6.3's binding is one sentence: an account may have multiple credentials, `scrypt` today, others later). That single sentence is the entire cost of keeping the Firebase option open, and it is already implicit in `StoredCredential.algorithm` being an enum of one (`identity/types.ts:97-105`). Nothing else in the system needs to know the question exists.

---

## 7. Migration path — from one auto-owner to this, without a flag day

Every step is additive, independently shippable, and inert until the next step consumes it. At no point does an existing client break or existing data rekey. (Explicitly out of scope, adjacent: the role-downgrade/bearer/non-loopback bundle and every sec1 item — those are authorization/deployment sequencing, mapped in the briefs.)

| Step | Lands | Inert-but-present → live when |
|---|---|---|
| **0. serverId** | migration mints the id on every existing DB; `server.describe` lands `reserved` | flips `v1` with the catalog batch; UI/CLI adopt it opportunistically |
| **1. persona at spawn** (§4.2) | `composeEnv` sets `TM8_ACTOR_ID` | live immediately — CLI and `resolve_actor`/`can_act_as` already do the rest; attribution flips to teammates on the next spawn. **This is the highest-value : lowest-cost step and should go first.** |
| **2. session on the envelope** | optional `workSessionId` in `CommandEnvelope` + contract `CommandContext`; `tm8.work_session_id` claim named in the one-path test and bound in `db/client.ts`; CLI auto-fills from `TM8_SESSION_ID` | live immediately for audit (claim bound, ledger/activity may record it); old clients simply don't send it |
| **3. claims amendment** | the one-paragraph ruling update for the six-claim surface (§2.2) | paperwork for step 2, batched with it |
| **4. agent tokens** (§4.3) | spawn-internal minting; `AuthSession`↔`work_session` link (additive migration); bearer resolver behind the existing seam | resolver mounts alongside auto-owner; loopback stays the no-credential fallback (T-L7). Envelope declarations from step 2 are automatically upgraded to pins — no client change |
| **5. remote identity** | R1 login (`auth.login` per the remote draft) + per-server credentials in the client stores; proxy brought under the end-to-end rule of §5.3 or retired at ratification | "you visiting B" becomes real; `server_connections.username` starts meaning something |
| **6. (deferred) global identity** | Phase 4 portable address binding to `identity_id` — or, if consciously chosen at R1, §6.3 with its named price | — |

Existing data needs nothing: the one owner account, 8 team_members, and every `created_by` already stamped are all correct under the new model — Stage-1 history simply reads "the owner did this", which is what actually happened.

---

## 8. What this forecloses — one line each

- **No per-entity `origin_server_id` column** → a database restored onto a different server cannot be detected by entity stamps alone (mitigable later via the server-identity row; accepted for simplicity under T-L5).
- **`tm8.work_session_id` is audit-only by declaration** → future authz may not hang policy on it without a new ruling (deliberate — keeps identity/authz separation clean).
- **Envelope-declared session (pre-token) is assertable** → session audit is honest-by-convention until Stage 2; anyone needing unforgeable session attribution must wait for tokens.
- **One persona per agent token** → a single spawned process cannot speak as two teammates without a re-mint (matches `AuthSession.actingAsTeamMemberId`'s single-slot design; multi-persona agents were never a tm8 concept).
- **Opaque (non-cryptographic) `serverId` now** → a remote peer's claimed `serverId` is unverifiable until the key-binding phase; provenance stamps are therefore honest records, not proofs.
- **`identity_id` never shared across servers** → "the same human on A and B" is only ever answerable through an explicit binding/address layer, never by id equality — cross-server identity joins are structurally impossible (this is a feature, but it forecloses lazy federation).
- **Credential kinds on the account** → forecloses nothing; it exists precisely to avoid foreclosing §6.
- **Reads carry no actor/session** → per-read actor attribution (e.g. "which persona looked at this") is not recordable; only identity-level read auditing is possible without a contract change.

---

## 9. Open questions

Each with a one-line recommendation; none blocks steps 0–2 of §7.

1. **WS credential: upgrade-URL `?token=` vs an `auth` control frame post-upgrade.** Query param leaks into access logs (mitigated by redaction, already the PTY design's stated rule); a first-frame auth is cleaner but adds a contract frame and cannot serve the PTY socket, which has no control channel. *Recommend: query param on both sockets for uniformity, with mandatory redaction; revisit only if a log-hygiene audit demands it.*
2. **Conflict between a token-pinned and envelope-declared `workSessionId`: refuse vs prefer-pin.** *Recommend: refuse with `invalid_input` (§2.1) — silent correction is a dishonest surface.*
3. **Claim-surface amendment process.** The four-GUC surface is a Vega ruling; widening it (§2.2) needs whatever re-consensus that ruling class requires — I could not determine the formal process from the tree. UNCERTAIN. *Recommend: a one-paragraph amendment ratified alongside step 2, mirroring the ruling's own format.*
4. **Spawn-internal minting vs a `teamMembers.mintToken` catalog op.** *Recommend: spawn-internal first (zero contract surface, closes the gap); add the op only when a user-facing "issue a token for my agent elsewhere" story exists.*
5. **Does `auth_session_id` itself ever need to be a claim?** Left out (§2.2) since `work_session_id` + `request_id` cover audit joins. *Recommend: no, until a concrete consumer appears.*
6. **`server_connections.username` semantics.** Unused today (`044:13`). *Recommend: ratify it as "your account name on that server" for the credential-per-server model (§5.2) rather than letting it drift.*
7. **The proxy's fate.** Identity design works under retire-it or keep-it-end-to-end (§5.3); the choice is a ratification decision flagged by both remote reports, not an identity question. *Recommend: decide at remote ratification; until then the proxy must at minimum stop forwarding `authorization`/`cookie` (`remote-proxy.ts:38-47`) — that line is an identity-rule violation independent of which future is chosen.*
8. **Whether `serverName` participates in addressing** (`user@server` strings) or stays display-only. *Recommend: display-only; addresses should bind to `serverId` (opaque) with names resolved through it, for the same reason `username` is never a key.*

---

*End of design. Deliverable for task `task_1785457738056_85pkqpuql`; companion documents in this directory: `IDENTITY-DESIGN-BRIEF.md` (the brief), `TM8-AUTH-AND-IDENTITY-BRIEF.md` rev 3, `TM8-REMOTE-DEEP-REPORT.md`, `REMOTE-DEEP-REPORT-B.md` (verified current state).*
