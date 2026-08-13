# tm8 — First-run node claim, node mode, and invite-bound signup

**Status:** design, ratified on the five decisions below · 2026-08-13
**Task:** `019ffbf7-5e58-79d6-9df7-ed8a756242b5` — "Create user on signup"
**Method:** every claim about the current tree carries a `file:line` and was read
directly. Nothing here is taken from `AUTH-AND-IDENTITY-VERIFIED-STATE.md`,
`IDENTITY-OPEN-THREADS.md` or `STATE.md` — all three are dated audits and at
least one load-bearing claim in them is now false (§8.1).

---

## 0. The decisions, and who made them

Five, all put to the user as explicit options and answered. They are the spec;
everything below is derivation.

| # | Decision | Chosen |
|---|---|---|
| D1 | How account #1 is authorized off-loopback | **One-time claim token**, minted at boot while the node is unclaimed, printed to stdout and written to `<dataDir>/setup-token` (0600) |
| D2 | The passwordless bootstrap `owner` row | **Claim it in place** — set username + credential on the existing row, same `identity_id`, so pre-claim history stays correctly attributed |
| D3 | What single-player means | **The credential always exists**; single-player additionally waves through loopback callers so the solo user never sees a gate on their own machine |
| D4 | Where the mode lives | **Server config** (`TM8_NODE_MODE`), restart to convert. Not reachable from the network |
| D5 | Teammate #2 | **Invite-bound self-signup** — the invite is the authorization; the new person picks their own password and the operator never learns it |

D3's rationale is the conversion story: because the credential exists from the
moment of claim, converting single→multiplayer is one env line and a restart,
with nothing to provision and no second ceremony. The rejected alternative
(passwordless single-player) makes conversion require shell access on the box
*and* has an ordering trap that locks the operator out permanently if the mode
flag is flipped before a credential exists.

---

## 1. The defect being fixed

Five links, four of which are working as designed. This is why "just add a
signup button" is the wrong fix.

1. **Account #1 is minted with no password.** `resolveLoopbackOwner`
   (`packages/server/src/identity/loopback.ts:88-113`) calls `ensure_account`
   with `password_algorithm = null, password_hash = null` and username `owner`.
   Deliberate: *"a loopback-only node may have no password (S1+S5)"*.
2. **Nothing can ever give it one.** No password-set operation exists in the
   catalog. `set_account_credential` (`db/migrations/007_rpc_catalog.sql:202`)
   would permit it — an account may set its own credential without node-admin —
   but its only TypeScript caller is `identity/pg-store.ts:306`, the file
   `loopback.ts:9-13` documents as never having executed. The `owner` row holds
   `UNIQUE(is_owner)` and is permanently unloggable.
3. **That bootstrap burns the one unauthenticated signup window.**
   `ensure_account`'s F1 guard (`007_rpc_catalog.sql:158-169`) is claim-free
   *only while the node has zero accounts*. The bootstrap fires on the first
   request that touches `deps.owner()`, so from the node's first minute
   `auth.signup` requires an authenticated node admin.
4. **The only node admin without a password is the loopback arm, and it
   correctly refuses remote callers.** `autoOwnerResolver`
   (`packages/server/src/http/security.ts:262-274`) requires all three of: TCP
   peer is loopback (`isLoopbackPeer`, checked at the socket, not from a
   header), no `Forwarded`/`X-Forwarded-*`/`X-Real-IP` header present, and
   `TM8_DISABLE_AUTO_OWNER` unset. A reverse proxy on the same box also
   connects from `127.0.0.1`, which is exactly why the second condition exists.
5. **So the gate opens on the sign-in card with no credential in existence.**
   `defaultSignedOutFrame` (`packages/tm8-ui/src/auth/AuthGate.tsx:39-46`)
   offers first-run signup only when `canUseLoopbackAutoOwner` is true. Off
   loopback that is the *honest* choice — signup there would be refused — but
   it is a dead end, and the only documented escape is a shell on the box
   (`docs/identity/PROVISION-SECOND-ACCOUNT.md`).

### 1.1 A second, independent defect in the same function

`defaultSignedOutFrame` discriminates on `readKnownAccountsHere().length` — a
**browser-local** list (`packages/tm8-ui/src/auth/pass-store.ts`), not a fact
about the node. Consequences, both reachable today:

- a fresh browser profile against a node that already has accounts opens on
  "create the first account", and the signup 409s;
- a browser holding a stale entry for a re-provisioned node opens on sign-in
  forever, with no way back to first-run.

The gate is asking `localStorage` a question only the server can answer. §4.2
replaces it with an operation.

---

## 2. The model

Two orthogonal facts about a node. Neither is derivable from the other, and
conflating them is what produced the current dead end.

### 2.1 Claimed vs unclaimed — a fact about the database

> **A node is CLAIMED once any account on it has a `password_hash`.**

Not "an owner row exists" (the bootstrap always makes one) and not "more than
one account exists". This definition is deliberately chosen so that nodes
already provisioned through the documented CLI path
(`PROVISION-SECOND-ACCOUNT.md`) read as **claimed** and never see a claim
token — the migration is a no-op for them.

Unclaimed is a strictly bounded state: an unclaimed node is one nobody has ever
logged into, so it contains nothing but the auto-owner's own work.

### 2.2 Node mode — a fact about the configuration

`TM8_NODE_MODE` ∈ `single` (default) | `multi`.

| | `single` | `multi` |
|---|---|---|
| loopback caller, no credential | resolved as owner, **no gate** | anonymous, **gate** |
| remote caller, no credential | anonymous, gate | anonymous, gate |
| credential exists after claim | **yes** | yes |
| `auth.signup` (node-admin) | unchanged | unchanged |
| invite-bound signup | available | available |

`multi` implies `disableAutoOwner`. `TM8_DISABLE_AUTO_OWNER=1` remains an
independent override so a *single*-player node can also be hardened; the
combination "multi + auto-owner enabled" must be impossible, enforced in
`loadConfig`, not by convention.

**Why config and not a graph row (D4):** the mode gates a security arm. A row
would make it writable over the network by any node admin — and *before*
conversion, "node admin" means anyone who reaches loopback, which is precisely
the population the mode exists to constrain. It is also read before any
database call.

---

## 3. The claim ceremony

### 3.1 Minting

At boot, if the node is unclaimed (§2.1) and no live unburned token exists, the
server mints one:

- 32 random bytes, base64url, prefixed `tm8c_` (mirroring `tm8s_`,
  `identity/crypto.ts`);
- **only the `sha256` hash is persisted** — same discipline as
  `auth_sessions.token_hash`. The plaintext exists in exactly two places: the
  boot log and `<dataDir>/setup-token`, mode `0600`;
- printed as a complete URL so the operator can click it:

```
tm8 is unclaimed. Claim it at:
  https://tm8-server.tail28ac62.ts.net:8888/?claim=tm8c_8f3a2c91…
also written to /home/tm8/.tm8/setup-token (0600)
```

The origin in that URL comes from `TM8_PUBLIC_ORIGIN` when set, else the bind
address. Getting it wrong prints an unreachable link, not an insecure one.

**Lifetime: no expiry, single-use, re-issuable.** An expiry punishes the
operator who installs on Friday and claims on Monday, and buys little, because
the token's power is bounded by a state the claim itself ends:

> A leaked claim token on an **unclaimed** node lets a stranger claim an empty
> node. On a **claimed** node it is inert forever.

The residual risk — someone claims your fresh install before you do — is real
and is the same risk class as trust-on-first-use, minus the window in which no
secret at all is required. `tm8 auth claim --reissue` (on-box) rotates it.

### 3.2 Redeeming — `auth.claim`

Claim-free, like `auth.login`. Input `{ token, username, password, displayName?, email? }`.

All of the following happen in **one transaction**, in SQL, so two concurrent
claims cannot both win:

1. lock and re-read the token row by hash; refuse if absent or burned;
2. re-assert the node is still unclaimed (§2.1) — the token alone is not
   sufficient authorization if someone else claimed in between;
3. `update public.accounts set username, display_name, email,
   password_algorithm, password_hash where is_owner` — **the existing row**
   (D2). `identity_id` is untouched, so every `created_by` in the graph stays
   valid and the pre-claim work becomes the claimant's;
4. burn the token (`used_at = now()`).

Returns the same shape as `auth.login` — `{ token, account, session }` — and
sets the session cookie for `kind: 'browser'`. **Claiming signs you in.** A
ceremony that ends at a login card and asks you to re-type what you just chose
is a seam the user has to notice.

Note that `auth.claim` works in `multi` mode too: the token is the
authorization, not loopback. An operator may install directly as multiplayer.

---

## 4. Surface changes

### 4.1 Contract — four new operations

| op | method | path | kind | status |
|---|---|---|---|---|
| `auth.claim` | POST | `/v2/auth/claim` | command | v1 |
| `auth.claim.status` | GET | `/v2/auth/claim` | read | v1 |
| `auth.invite.resolve` | POST | `/v2/auth/invite/resolve` | read | v1 |
| `auth.invite.signup` | POST | `/v2/auth/invite/signup` | command | v1 |

Two method-distinct ops on one path is established (`artifacts.publish` /
`artifacts.revisions.list`, `catalog.ts:225-226`). `POST` with `kind: 'read'`
is established too (`collections.query`, `graph.query`, `catalog.ts:99-100`) —
used here so **an invite code never lands in a URL, an access log, or a
`Referer`**. The `?claim=` token is the deliberate exception: a click-to-claim
link cannot work otherwise, and that token is single-use and burned on arrival.

All four are claim-free. All four refuse `actorId` — authentication has no
authoring persona (the rule `handlers/w2/auth.ts:11-13` already states). None
enter the idempotency ledger, for the same reason the existing four do not.

`auth.claim.status` returns `{ claimed, mode, signupPath }` where `signupPath`
is `'claim' | 'invite' | 'admin'` — what this node will actually accept right
now. It is readable by an anonymous caller **by design**: it tells the person
who just installed the node the one thing they need, and tells an attacker
nothing they could not learn by trying.

### 4.2 UI — the gate stops guessing

`defaultSignedOutFrame` is rewritten against `auth.claim.status` instead of
`readKnownAccountsHere()` (§1.1):

| node says | URL carries | frame |
|---|---|---|
| `claimed: false` | `?claim=…` | `1a`, token prefilled |
| `claimed: false` | — | `1a`, token field empty, copy names `<dataDir>/setup-token` |
| `claimed: true` | `?invite=…` | `1h` (invite redeem — **already built**) |
| `claimed: true` | — | `1d` sign in |

The status call happens before the first paint decision, so it must be part of
the same read the gate already does on mount. An **unreachable** node must not
be rendered as "unclaimed" — that would offer a claim ceremony that cannot
succeed. Unreachable keeps today's behaviour: sign-in card plus the honest
transport error.

### 4.3 CLI

```
tm8 auth claim --token <tok> --username <u> --password <p> [--display-name <n>]
tm8 auth claim --show          # print the current claim URL (on-box, unclaimed only)
tm8 auth claim --reissue       # burn the old token, mint and print a new one
tm8 node mode                  # report single|multi and whether the node is claimed
```

`--show` / `--reissue` read `<dataDir>/setup-token` and require filesystem
access to the data dir — they are on-box operations by construction, not by a
check that can be bypassed. `tm8 node mode` is **read-only**: converting is an
env edit and a restart (D4), and a command that pretended otherwise would be
lying about where the switch is.

Every op needs its row in `packages/cli/src/discovery/operations.ts` or
`catalog-exhaustiveness.test.ts` fails — which is the intended behaviour, not
an obstacle.

### 4.4 SQL — one new migration

- `public.node_claim_tokens(token_hash text primary key, created_at, used_at)`.
  RLS enabled with **zero policies**, following `008:204-206`'s precedent for
  `accounts`/`auth_sessions`: the RPCs are the only way in.
- `public.claim_node(...)` — `SECURITY DEFINER`, claim-free, §3.2's four steps
  under one lock.
- `public.node_is_claimed()` — `SECURITY DEFINER`, claim-free, backs
  `auth.claim.status`.
- `public.signup_via_invite(...)` — `SECURITY DEFINER`, claim-free. Validates
  the invite, creates the account, creates the member row, consumes the invite
  — **atomically**. A half-state (account created, membership failed) would
  leave a person who can log in and see nothing, which is the exact failure
  `PROVISION-SECOND-ACCOUNT.md` opens by warning about.

`signup_via_invite` deliberately bypasses F1's node-admin gate: **the invite is
the authorization**. It hard-codes `is_node_admin = false` and `is_owner =
false`. There is no input that can make it mint an admin.

---

## 5. The journeys

### 5.1 Single-player

1. Operator starts the server. It prints the claim URL.
2. They open it **from anywhere** — laptop over Tailscale, phone, through
   nginx. The token authorizes the write, so no shell is required. They pick a
   username and password. The owner row is claimed; they are signed in.
3. Day to day on the box: `localhost:8888` → loopback → **no gate**, straight
   into the app. They never type the password again on that machine.
4. From the couch, over the tailnet: the sign-in card, and the password from
   step 2 works. **Day one, no extra setup** — this is the whole point of D3.

### 5.2 Converting to multiplayer

```
/etc/tm8/tm8.env :  TM8_NODE_MODE=single  →  multi
systemctl restart tm8-server
```

The auto-owner arm goes away. The owner now signs in on loopback too, with the
credential set at claim time. Nothing to provision, no migration, no second
ceremony, no shell-ordering trap.

### 5.3 Teammate #2

```
tm8 space invite create <space-id> --max-uses 1
```

Hand Bob the code out of band. Bob opens the link, `auth.invite.resolve` shows
him what he is joining, he picks **his own** password, `auth.invite.signup`
creates his account and his membership in one act and signs him in. The
operator never learns his password. Bob's work is attributed to Bob from his
first click.

---

## 6. What this deliberately does not change

- **The auto-owner arm's three conditions** (`security.ts:262-274`) are
  untouched. This design adds a way to get a credential; it does not widen who
  is trusted without one.
- **`auth.signup` stays node-admin gated.** Open self-registration never
  appears. The two new signup paths are each authorized by a distinct
  capability — a claim token, or an invite code.
- **`ensure_account`'s F1 guard** is untouched. `claim_node` does not create an
  account; it credentials the one that already exists.
- **One identity path.** No new resolver, no second `claimsFor`. The structural
  guard `packages/server/test/one-identity-path.test.ts` must stay green, and
  it exists because this exact class of bug was reintroduced twice in one day
  by two different authors.

---

## 7. Security properties, stated plainly

1. **The claim token's authority is bounded by the node being empty.** Leaked
   before claim: a stranger claims a node with nothing in it. Leaked after:
   inert.
2. **Claiming cannot escalate.** It sets a credential on the existing owner
   row. It cannot create an account, cannot mint an admin, cannot alter
   membership.
3. **Invite signup cannot escalate.** `is_node_admin = false`,
   `is_owner = false`, hard-coded, with no input that reaches them.
4. **The mode switch is not network-reachable** (D4).
5. **TLS remains mandatory off localhost.** `auth.claim`, `auth.login` and
   `auth.invite.signup` all carry a plaintext password in the body. The tailnet
   deployment already has a real Let's Encrypt certificate via
   `tailscale cert`; there is no excuse to relax this.

### 7.1 The one that is not solved here

**A tailnet authenticates devices, not people.** Before this change, everyone
who reached the box was the node owner and every row they created carried the
same identity — permanently, with no later migration able to separate it. This
design is what ends that, and the ordering matters: **the second human must not
use the node before it is claimed and converted to `multi`.** Work done by a
second person on an unclaimed single-player node is recorded as the first
person's, irreversibly.

---

## 8. Corrections to existing docs, forced by this pass

### 8.1 The PG role downgrade has LANDED — `AUTH-AND-IDENTITY-VERIFIED-STATE.md` §3.2 is stale

That document's headline finding is that the server connects as a superuser
with `rolbypassrls` and never issues `set local role`, leaving migration 008's
RLS *"largely inert on the read path"*. **That is no longer true.**
`packages/server/src/db/client.ts:115-121` binds the role downgrade in the same
round trip as the claims:

```sql
select set_config('tm8.identity_id', $1, true),
       …
       set_config('role',            $6, true)
```

and `client.ts:241` defaults that role to `tm8_app`. The file documents it as
"Identity v2 Stage 1, trap 3" and is explicit that *"nothing in the transaction
may ever observe superuser reads with caller claims bound — that combination is
the entire defect this line removes."*

This is load-bearing **for this design specifically**: it is the reason a second
authenticated principal is actually contained rather than able to read the whole
graph. Multiplayer would not be safe to ship without it. It should be verified
against the deployed database before the mode is flipped anywhere real — the
code is right; whether every deployment's connection string has been moved off
the superuser is a separate, per-node fact.

### 8.2 `AUTH-AND-IDENTITY-VERIFIED-STATE.md` §4.2 "zero `auth.*` operations"

Stale. Four `auth.*` operations are `v1` in the catalog
(`packages/contract/src/catalog.ts:241-244`) and the tm8-ui gate calls all four.

---

## 9. Acceptance

The gates this must pass, named so they are not discovered late:

- `packages/cli/test/catalog-exhaustiveness.test.ts` — every new op has a
  discovery row.
- `packages/cli/test/discovery-honesty.test.ts` — nothing reads as available
  and then refuses.
- `catalogDigest` in `tm8 help --format json` moves, and the move is expected.
- `packages/server/test/one-identity-path.test.ts` — still green, unchanged.
- `db/migrate.mjs` checksum discipline — forward-only; do not edit `007`.

The end-to-end proof, which is the only one that answers the original report:

> On a machine that is **not** the server, with an empty database and no shell
> access to the box, open the printed claim URL, create an account, and land in
> the app. Then flip `TM8_NODE_MODE=multi`, restart, and sign in again with the
> same password.

`scripts/two-users-acceptance.mjs` and
`packages/tm8-ui/e2e/two-accounts-browser.mjs` already exist and cover the
downstream half.

---

## 10. Open, deliberately not decided here

1. **The first-run wizard's steps 2 and 3.** `FirstRunFrames.tsx` draws
   `1a`/`1b`/`1c` (claim → name the server → first space) but the handover
   records that steps 2 and 3 had no operation behind them, so the flow
   completes at step 1 of 3. `spaces.create` is `v1` and would light up `1c`.
   Whether to complete the wizard now is a scope call, not a design one.
2. **Claim-token delivery on a headless install** where the operator never sees
   stdout and cannot read the data dir. Out of scope; `--reissue` covers the
   case where they can get a shell.
3. **Password rotation.** There is still no password-change operation anywhere
   in the catalog. Not required by this design — but the day a human forgets
   their password, the only recovery is `psql`. Should be its own task.
