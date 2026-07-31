# Design brief — tm8 identity system

**For:** the identity design session · **Written:** 2026-07-31
**Scope:** DESIGN ONLY. Do not write implementation code.

---

## 1. What the user asked for, in their words

> "I want the identity to be fixed. That means at least **who is doing what**. These agents belong to a user, a session, probably a teammate. This identity has to be **baked into every request** — from where the server is coming, the origin server, everything has to be baked into the requests. Server, server-user, session, teammate, and for entities the origin server. First this identity system should be properly built.
>
> **Only the identity part.** For now I am not concerned about who can access what, rules and security. First I want to stabilise identity — **who is doing what, the who should be clear, everywhere.** It should be simple, it should be clean, should work across remote.
>
> I am also thinking of having a **global identity, with Firebase Auth**, so things get easier."

### The scope line, stated sharply

**IN scope:** the identity *model* — what identities exist, what each one means, how they compose, how they are carried on every request and stamped on every entity, and how they stay coherent across servers.

**OUT of scope:** authorization, permissions, RLS policy design, "who may do what", threat modelling, rate limits. The user was explicit. Do not drift into it.

**But:** identity is the input authorization will later consume. Design so authorization *can* be layered on cleanly later — just don't design it now. If a decision forecloses a future authz option, say so in one line and move on.

---

## 2. Ground truth — the current state

Read `TM8-AUTH-AND-IDENTITY-BRIEF.md` (same directory, rev 3) in full first. It is verified against the tree with `file:line` evidence. Companions: `TM8-REMOTE-DEEP-REPORT.md` and `TM8-REMOTE-DEEP-REPORT-B.md`.

### Measured live, on the dev database, 2026-07-31

```
accounts        1     ← username 'owner', password_hash NULL, is_owner, is_node_admin
auth_sessions   0     ← no session has EVER been issued
members         1
team_members    8
spaces          1
```

### Four layers. Three exist. One is missing.

| Layer | Meaning | Status |
|---|---|---|
| **Identity** (`identity_id`) | permanent, opaque, immutable id for a human | ✅ real |
| **Member** | that human *inside one space*; a member row belongs to exactly ONE space | ✅ real |
| **Team member** | an agent persona, owned by a member | ✅ real, 8 rows |
| **Authentication** | *proving* you are that identity | ❌ **absent** |

### What every surface actually presents today

| Surface | Sends | Resolves as |
|---|---|---|
| Browser UI | nothing | the node owner |
| CLI | `Authorization: Bearer $TM8_AGENT_TOKEN` | the node owner — **header ignored** |
| Spawned agent | nothing (nothing mints the token) | the node owner |
| Remote server B via proxy | whatever A forwards | **B's own owner** |

`autoOwnerResolver` (`http/security.ts:102`) is the only resolver mounted. `RequestIdentity.kind` declares `'bearer'`; nothing produces it.

### The specific gaps that motivated this work

1. **Agents don't carry their persona.** `composeEnv` (`execution/src/spawn/manifest.ts:485-500`) sets `TM8_TEAM_MEMBER_ID` but **not** `TM8_ACTOR_ID`. The CLI reads the actor from `TM8_ACTOR_ID` (`cli/src/context.ts:83`) or `--as`. So an agent is *told in its prompt* "you are teammate Y", then writes as the owner. **Prompt-level identity, not wire-level.**
2. **Claiming an actor is unforgeable-by-nobody.** `internal.can_act_as` (`002:254-272`) allows acting as a team_member if that member's owner is the caller's identity. One account owns all 8 → any caller can claim any teammate.
3. **No session identity on the wire.** `work_session` exists as an entity, but a request cannot say "this came from session S."
4. **No server identity at all.** No `serverId`, no `server.describe`. Entities carry no origin-server provenance. Migration 044 `server_connections` stores a `username` column that is documented as "future auth metadata" and is **unused**.
5. **Remote identity does not exist.** Connect A→B and you are B's owner, not "you, visiting B."

---

## 3. What must be designed

The user named five things that should be legible on every request and stamped on every entity:

```
server · server-user · session · teammate · (for entities) origin server
```

Work out, precisely:

1. **The identity tuple.** What exactly travels on a request? Name every field, its type, whether it is required or optional, and what it means when absent. Resist inventing new nouns — tm8 already has `identity_id`, `member`, `team_member`, `work_session`, and a planned `serverId`. Prefer composing existing ones. If you add a noun, justify it in one sentence.
2. **Wire representation.** Headers? Envelope fields? Both? tm8's contract is frozen and additive-only, and there is a documented precedent for adding reserved-then-v1 operations and `details.reason` values without widening frozen enums. There is an existing `X-TM8-Client` header convention (`http/config.ts:10-12`) and a proposed `X-TM8-Contract-Version`. **Browsers cannot set headers on a WebSocket upgrade** — whatever you design must work for HTTP, WS, and the PTY socket.
3. **Server identity and entity provenance.** How a server gets a stable id, and how an entity records the server it originated on. Note the hard constraint: **T-L5, spaces are single-homed** — one authority node per space, no multi-master, no sync. Provenance is *not* replication. There is already a `pulled` edge carrying `{workspace/localId, pinnedVersion}` for projections.
4. **How agents inherit identity at spawn.** Close gap #1 above. What does `composeEnv` set, what does the CLI read, what lands on the wire.
5. **Session identity.** How a request says which `work_session` it came from, and what that buys.
6. **The one path rule.** `test/one-identity-path.test.ts` structurally enforces that `claimsFor` lives in exactly one file (`facade/context.ts`) and claim binding in exactly one file (`db/client.ts`) — because the identity-less-resolver bug was independently reintroduced *twice in one day by two different authors*. **Your design must feed this single path, never fork it.** Say explicitly how.
7. **Migration path.** The system runs today with a single auto-owner and real data. How does it get from here to your design without a flag day? What is inert-but-present first, what flips later?

---

## 4. The Firebase question — the user's idea, and the conflict it creates

The user wants **global identity via Firebase Auth**, so "things get easier" — one identity across servers instead of an account per server.

**Do not dismiss this and do not rubber-stamp it.** Work it honestly. Here is what binds:

**What forbids it today:**
- **T-D3**, cited in `02-NODE-AND-GATEWAY.md` §4.1: *"Identity binds to Postgres per-transaction (T-L11/R2); **no Firebase, no Supabase, anywhere in tm8**."*
- It is **enforced, not aspirational**: `tools/ci/migrations-check.sh:79-86` is an armed grep (`supabase|firebase|auth\.uid\(\)|service_role|SUPABASE_`) that **fails the build**, and `packages/ui/src/collab-v2/__tests__/foundation/seam-purity.test.ts:18-19` greps for the same strings.
- **T-L11** also says clients must hold no *"database or third-party auth material — single boundary: tm8-server."*
- **T-L8/R1**: the gateway is *"never the primary account store."* An external IdP is a stronger version of the thing that law rejects.
- **T-L5 + offline**: a local node is *"fully offline-capable."* An external IdP in the identity path breaks that unless carefully bounded.

**What genuinely argues for it:**
- The current plan is *credential-per-remote, the git-remotes model* — an account on every server you touch. That is real friction and the user has correctly identified it.
- Portable identity (`user@server`, key-based) is already the acknowledged end state, **deferred to Phase 4**. The user is asking for the Phase-4 benefit sooner.
- `identity_id` is *already* documented as opaque and immutable specifically so a portable address can layer on later without rekeying (`identity/types.ts:21-26`). The forward-compat slot exists.

**What to actually produce.** Not a yes/no. Give the user a decision they can make:
- Is there a shape where the **local node still owns the account row** and an external IdP is merely *one login method that binds to it* — preserving T-L11's single boundary and offline operation, while getting the "one identity everywhere" UX?
- How does that compare to **portable identity (`user@server`)**, which the corpus already plans and which needs no third party?
- What breaks in each: offline, self-hosting, the CI gate, vendor lock-in, and the "a hub is accounts on a machine someone runs, not a public IdP" framing in `02-NODE-AND-GATEWAY.md` §4.
- If you recommend Firebase, say plainly that it **requires amending T-D3** and name what else must change (the CI gate, the purity test, T-L11's client-material clause).

**Be direct about the recommendation.** The user asked for simple and clean. Say which option is simpler and cleaner, and why. Don't hedge into a menu.

---

## 5. Constraints that are not negotiable in this pass

- **The contract is frozen and additive-only.** New operations land `reserved` → `v1`. The 13-code error enum stays closed; extend via typed `details.reason`.
- **Spaces are single-homed (T-L5).** No multi-master, no sync, no cross-server graph edges.
- **One identity path (§3.6).** Enforced by a test that exists because the bug recurred.
- **`identity_id` is opaque and immutable.** Do not design anything that requires rekeying it.
- **Don't design authorization.** Again: the user was explicit.

---

## 6. Deliverable

Write to `/Users/subhang/Desktop/tm8-auth-brief/TM8-IDENTITY-DESIGN.md`.

Structure it as:
1. **The model** — every identity noun, what it means, how they compose. A diagram in text is welcome.
2. **The request tuple** — exact fields, exact wire format, for HTTP + WS + PTY.
3. **Entity provenance** — what gets stamped, where.
4. **Agent/session identity at spawn** — the concrete fix.
5. **Remote** — how the same model works across servers.
6. **The Firebase / global-identity decision** — options, trade-offs, a clear recommendation.
7. **Migration path** — from one auto-owner to this, without a flag day.
8. **What this forecloses** — one line each; honesty over completeness.
9. **Open questions** — things you could not resolve, with a one-line recommendation each.

**Rules:**
- Cite `file:line` for every claim about current behaviour. Verify against the tree; do not trust the design docs — three of them are stale and I published three wrong claims by trusting them.
- Prefer composing existing nouns over inventing new ones. Simple and clean is the explicit ask.
- Where you are uncertain, say UNCERTAIN and explain the uncertainty. Do not paper over it.
- **Design only. Do not implement.**
