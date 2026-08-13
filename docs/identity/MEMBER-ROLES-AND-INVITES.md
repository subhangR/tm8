# Member roles and invite roles — what landed, and what deliberately did not

**Migration 114 · 2026-08-13.** Branch `feat/members-roles-and-invites`, based on
`c7d43378` (origin/main). Every claim below was measured against the tree or a
live Postgres; nothing here is taken from an older doc, and the older identity
docs in this directory are dated audits that have drifted (see
`IDENTITY-OPEN-THREADS.md` §3.1 for why that keeps happening).

---

## 0. The one-paragraph answer

`public.members.role` has carried `owner | admin | member` since
`002_identity.sql:97`, and every authorization primitive in the schema reads it
— `internal.is_space_admin` is the whole basis of `require_space_admin`. But
**nothing had ever written it after the row was created.** `attach_member`
(`007:515`) takes a role argument and both of its callers passed the literal
`'member'`; there was no RPC, no operation, no CLI verb and no seam method that
changed one afterwards. A space's second human was a `member` forever, and the
only way to make somebody an admin was a hand-written `UPDATE`. 114 adds the
writer, gives invites a role to confer, and adds the one read that can answer
before the caller is anybody on the node.

---

## 1. What is new

### SQL — `db/migrations/118_member_roles_and_invite_roles.sql`

| | |
|---|---|
| `space_invites.role` | `check (role in ('admin','member'))`, default `member`. An invite says what you join AS. |
| `public.create_invite(…, p_role)` | Old 5-arg signature **dropped**, not overloaded — see §4. Keeps 032's strip-at-rest and rehydrate-after-binding verbatim. |
| `public.redeem_invite` | Attaches with `invite.role` instead of the hardcoded `'member'`. |
| `public.set_member_role` | The writer. Four rules, §2. |
| `public.preview_invite` | Claim-free. What a code lets you join, before you are anybody here. |

### Contract — two operations, 159 → 161

| op | method | path | kind |
|---|---|---|---|
| `spaces.members.updateRole` | PATCH | `/v2/spaces/:spaceId/members/:memberId` | command |
| `auth.invite.resolve` | POST | `/v2/auth/invite/resolve` | **read** |

`auth.invite.resolve` is a POST-with-`kind: 'read'` **on purpose**, and it must
stay that way. It writes nothing, but the code has to travel in the body: a join
code is a bearer capability, and a capability in a URL path is a capability in
an access log, in browser history, and in the `Referer` of the first outbound
link the page renders. Precedent for the shape is `collections.query` /
`graph.query`. This shape was reserved by the Contract Steward's
`FIRST-RUN-CLAIM-DESIGN.md`; an earlier draft of this work shipped it as
`spaces.invites.preview`, GET `/v2/invites/:code`, and that draft was wrong.

### CLI

```sh
tm8 space member role <member-id> --role <owner|admin|member> --yes
tm8 space invite create [<space-id>] [--role <admin|member>] [--max-uses n] [--expires-at …]
tm8 space invite resolve <code>          # no space, no credential needed
```

### UI (`packages/tm8-ui`)

Seam **Amendment 11**: `setMemberRole`, `createInvite`, `revokeInvite`,
`redeemInvite` under `commands`, plus `previewInvite` with the reads. The
settings surface's members table draws a **live role select** and the invites
section reads, creates, copies a join link and revokes for real.

---

## 2. The four rules `set_member_role` enforces

They live in SQL, in a `SECURITY DEFINER` function. The UI restates them as
locked controls *before* the click, but that is UX; if the two ever disagree,
SQL wins and the component is wrong.

1. **Only a space admin may change any role** — `require_space_admin`, the same
   guard `create_invite` uses.
2. **Only an OWNER may grant or revoke the owner role.** An admin who could mint
   an owner could mint themselves a superior; an admin who could revoke one
   could evict the person who appointed them. Transfer is therefore explicit and
   two-step — promote the successor, then step down — which is auditable and
   individually recoverable in a way a single atomic `transfer` verb would not
   be.
3. **The last owner cannot be demoted.** A space with zero owners is
   unrecoverable through this operation, because rule 2 says only an owner may
   grant the owner role and there is nobody left to be one. Enforced under a row
   lock over the space's owner rows, so two concurrent demotions cannot both
   read "there are two of us".
4. **An invite cannot mint an owner.** A code travels out of band and is worth
   what the channel it was sent over is worth.

Rule 4 is *not* the same as the signup lane's constraint that
`signup_via_invite` must hard-code `is_node_admin = false`. Node admin and space
owner are different axes, enforced in different places. Both are needed.

---

## 3. What deliberately did NOT land: removing a member

The settings UI still refuses it, and the reason changed from a judgement call
to a measured fact.

`entities.created_by` references `entities(id)` with **no on-delete clause**
(`001_core_graph.sql:338`), so Postgres already refuses to delete the member row
of anyone who has authored a single entity — and refuses with a bare `23503`,
which is not an answer a person can act on. A member row is the attribution
target of everything that human ever wrote.

The correct shape is a **soft removal** (`members.removed_at`) that keeps
attribution and revokes access. That is its own change with its own gate:
**57 `from public.members` predicates across 23 migrations** currently mean "is
a member" by the row's mere existence, and six of them are RLS policies. Landing
half of it leaves a removed member still reading the space, which is strictly
worse than not having the button. `MEMBER_REMOVE_UNAVAILABLE` in
`settings-space/reasons.ts` names this file.

**Interim answer for an operator:** demote them to the least-privileged role.

---

## 4. Two traps this work hit, recorded so the next lane does not

**`create or replace` with an extra parameter does not replace — it overloads.**
`create_invite` gained `p_role`, and a 5-argument call then matches both the old
exact signature and the new one's defaulted tail. Postgres does not choose; it
raises `42725 function is not unique`, which would have taken out every invite
creation on the node the moment the migration applied. The migration drops the
old signature first, and then has to re-`grant` because a dropped function takes
its grants with it. `008:251-253` leaves default privileges untouched on
purpose, so **every function created after 008 is unreachable until a migration
grants it explicitly**.

**`p_role` is the LAST parameter, after `p_client_mutation_id`.** That reads
wrong and is correct: the facade calls this positionally as `[spaceId, maxUses,
expiresAt, actorId, clientMutationId]`, so putting the new parameter in its
natural place beside `p_max_uses` would silently reinterpret the cmid as a role.

---

## 5. How to verify

```sh
# SQL — 18 assertions, run AS tm8_app with claims bound the way the server binds them.
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_roles_check node db/migrate.mjs reset --force
TM8_DATABASE_URL=postgres://tm8@127.0.0.1:5442/tm8_roles_check TM8_TEST_DB=tm8_roles_check \
  node --test db/test/member_roles.test.mjs

# UI
cd packages/tm8-ui && npx vitest run src/settings-space src/data
```

The DB suite needs `tm8_app` to be able to log in. On a cluster where it has no
password that means `alter role tm8_app password '…'` plus `PGPASSWORD`; the
suite proves nothing run as the superuser, because the superuser bypasses the
RLS and the definer guards that are the entire subject.

---

## 6. Open, and owned by nobody yet

- **`auth.invite.signup`** — invite-bound account creation, so a person holding a
  link can join a node they have no account on. Sliced as a follow-up task by
  the user. Two handles from writing 114: `redeem_invite` already does member-row
  + `use_count` + notify in one transaction, so `signup_via_invite` must fold
  account creation *into* that shape rather than call redeem as a second
  statement; and `internal.attach_member` is role-aware now, so an invite's role
  flows through with no further SQL.
- **`/join/<code>`** — the landing that consumes `auth.invite.resolve`. The card
  is built (`settings-space/InviteFrames.tsx`, `RedeemLanding`) and carries
  `INVITE_REDEEM_LANDING_UNWIRED`; no route mounts it.
- **Soft member removal** — §3.
- **A node-level account dashboard** — listing accounts, disabling one, granting
  node admin. No operation exists for any of it; `auth.signup` is the only
  account-creating op and it is node-admin gated by design (F1).
