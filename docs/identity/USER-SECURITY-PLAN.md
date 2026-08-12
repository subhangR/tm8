# tm8 — User Security: end-to-end access control plan

**Task:** `019ff232-2524-78bd-a605-f2d093b76934` (User Security, high) · **Branch:** `plan/user-security` off `origin/main` @ `77f2887`
**Author:** Opus 5 Teammate · **Date:** 2026-08-11
**Status:** findings stand; **phase structure superseded** by [`USER-SECURITY-CONTROL-PLANE.md`](./USER-SECURITY-CONTROL-PLANE.md)

> **Supersession note (2026-08-11).** §1–§4 (the measured findings) and §10 (the evidence
> index) remain the authority for *what is wrong*. §5's phases 0–5 and §6's target model were
> written before the architecture was settled, and are replaced: the user chose **cross-space
> delegation** (one space per user; reaching another user's session is a scoped grant, not a
> membership) and **per-user OS accounts**. Two findings not in this document were discovered
> during that design — the `074`-reverted-`072` agent-bearer liveness gate, and the fact that
> every space member can already drive any agent's PTY via `075`'s `can_act_as` widening. Both
> are in the successor.

---

## 0. What this is, and what I actually read

The request: *"improve the security for the complete tm8 architecture … user based access
control and cross user based access control … once they login it has to load respective
space and its projects, space is nothing but user space"*, with the title naming the four
things to isolate: **Space · Projects · Agents · Files**.

I read the shipped model rather than the design docs, because the docs describe intent and
the question is about what holds. Sources: `db/migrations/001,002,007,008,016,021,022`,
`packages/server/src/{identity,http,files}`, `packages/execution/src/spawn`,
`packages/tm8-ui/src/{auth,views}`, and the **live prod database and process table** — the
findings below are measured on the running node, not inferred.

### 0.1 The Vesta reference is not available to me — flagged, not guessed

The task says *"go through the vesta architecture in user management and domain management
for project management. I need similar kind of security."*

**There is no Vesta code, doc, or reference anywhere on this box.** I searched the whole
workspace and the filesystem; the only `vesta` string hits are the substring inside
"har**vesta**ble" in unrelated docs. So I cannot mirror a design I cannot read.

What I have done instead: built the plan around the *shape* that phrase implies — a
**domain (tenant) → user → project → resource** hierarchy where role bindings are declared
at a level and inherit downward, and cross-tenant access is an explicit, auditable, revocable
grant rather than shared membership. That is §6's target model, and it is the part of this
plan most likely to need correction once I can see Vesta. **§9 Q1 is the ask.** Everything in
Phases 0–4 is derived from tm8's own measured gaps and stands regardless of what Vesta says.

---

## 1. What the architecture is today — the honest read

This is a **well-built** authorization core, and the plan below is not a rewrite. The
foundations are unusually good for a product at this stage, and the fixes are targeted.

**What is genuinely strong:**

| Property | Where | Why it matters |
|---|---|---|
| One claim has authority (`tm8.identity_id`); everything else is a fast path | `001:130-145`, `002:207-215` | No client-assertable identity path exists |
| RLS on **every** table, fail-closed on unset claim | `008:43-59` | A request that forgot to bind identity gets zero rows |
| `tm8_app` holds **no** INSERT/UPDATE/DELETE anywhere | `008:227` | The write surface is enumerable: `\df public.*` is the whole list |
| Credential tables have RLS with **zero** policies | `008:204-206` | A read bug cannot leak a token hash |
| Tokens stored as SHA-256 only | `002:167-180` | A stolen DB yields no usable credential |
| Constant-work login, identical error for unknown user / bad password / disabled | `pg-auth.ts:217-239` | No account enumeration |
| Blob store is space-partitioned, symlink- and traversal-checked | `w2-blob-store.ts:296-333` | No cross-space blob path is constructible |
| Per-identity vendor credential homes, with the competing node key **deleted** from agent env | `manifest.ts:948-964` | A member's agent authenticates as the member, not the node |
| Transport: loopback bind refusal, Host allowlist, exact-Origin, no ACAO ever, CSRF header | `http/security.ts` | DNS-rebinding and cross-site mutation are closed |

**The boundary that model draws is: `space membership`.** One boundary, one grain. Everything
below is a consequence of there being only one — and of one capability (`node_admin`) that
crosses it.

**Current state, measured on prod (`tm8_prod`, 2026-08-11):**

```
accounts 8 · spaces 4 · members 10 · projects 3 · space_projects 3 · team_members 65
```

---

## 2. Findings, severity-ranked

Each finding is evidence-first. Severity is *impact on the multi-user posture the task asks for*.

---

### F1 · CRITICAL · Any agent can read any other agent's live bearer token

Every spawned agent runs as OS user `tm8` (confirmed: `ps` shows `/opt/tm8/prod/...` and all
agent PTYs under `tm8`). The agent's credential is delivered in its process environment
(`manifest.ts:924` — `env.TM8_AGENT_TOKEN = agentToken`).

**Proven, not theorised.** From this session I read another running agent's environment:

```
$ tr '\0' '\n' < /proc/44875/environ | grep -c '^TM8_AGENT_TOKEN='
1          # 85-character live token, another teammate's session
```

No exploit. No privilege escalation. Just a read, because it is the same uid.

Compounding it, that token is not narrow (F3) and lives **7 days**
(`pg-auth.ts:43` — `agent: 7 * DAY`).

**Consequence:** agent isolation does not exist at the process layer. One prompt-injected
agent — and the system prompt itself concedes that task, message, and repo content is
untrusted — harvests every concurrently running agent's token and acts as every one of
those humans, for a week.

**The uncomfortable corollary:** while all agents share a uid, *no* secret handed to an agent
can be withheld from another agent. Not env, not a 0600 file, not a fd. Scoping and TTL
reduce the blast radius; only uid separation closes it.

---

### F2 · CRITICAL · The same uid reads every user's credentials, blobs, and signing keys

```
/home/tm8/prod-data/          drwx------ tm8 tm8
├── .file-upload-grant.key    -rw------- tm8 tm8    # upload-grant HMAC key
├── .git-credential.key       -rw------- tm8 tm8    # git credential encryption key
├── blobs/spaces/<spaceId>/   drwx------ tm8 tm8    # every space's file bytes
└── credentials/id_<identity>/ drwx------ tm8 tm8   # 3 identities' vendor OAuth creds
```

`0700` protects these from *other OS users*. There are none. Every agent, for every human,
is `tm8`, so `0700` is `0777` to the population that matters.

An agent spawned by the single non-admin account (`ganesh`) can read another member's
Anthropic OAuth credential out of `credentials/id_*/`, and both node signing keys.

The DB-side space partitioning of blobs (`w2-blob-store.ts`) is correct and well tested. The
filesystem underneath it is flat.

---

### F3 · CRITICAL · An agent token carries the full graph reach of the human who spawned it

`issue_agent_auth_session` sets `acting_as_team_member_id`, which narrows **attribution**
only — which persona the writes are signed by. It does not narrow reach.

`resolveBearerIdentity` (`pg-auth.ts:192`) returns the spawning account's `identityId`;
every RLS predicate resolves membership from that identity. So an agent spawned onto **one
task** holds read+write across **every space its owner belongs to**.

Nothing binds the session to its task, its space, or its project. `auth_sessions` has no
scope column.

For `subhang`, `tarkesh`, `raghav` (2 spaces each) that is already cross-space. Combined with
F1 it is cross-*user*.

---

### F4 · CRITICAL · 7 of 8 prod accounts are node admins, and node admin is total

```
 username   | is_node_admin | is_owner | spaces
------------+---------------+----------+--------
 owner      | t             | t        |   1
 subhang    | t             | f        |   2
 breakglass | t             | f        |   1
 tarkesh    | t             | f        |   2
 bhargav    | t             | f        |   1
 raghav     | t             | f        |   2
 ramu       | t             | f        |   0      <-- admin of everything, member of nothing
 ganesh     | f             | f        |   1
```

`require_node_admin()` gates **18 RPCs**, in one undifferentiated bundle:

| Group | RPCs |
|---|---|
| Account takeover | `ensure_account` · `set_account_credential` · `set_account_disabled` · `revoke_account_sessions` |
| Session control | `issue_auth_session` · `revoke_auth_session` · `prune_auth_sessions` · `resolve_account_credential` |
| Project registry | `create_project` · `update_project` · `update_project_w2` |
| Node config | `create_server_connection` · `delete_server_connection` · `update_space` · `delete_task_axis` |

Plus read widening: `projects_select` (`008:177-181`) returns **every project on the node**
to a node admin, ignoring space membership entirely.

So each of those seven can reset any other user's password, disable them, mint new accounts,
and enumerate every project. There is no separation between *"may register a working
directory"* and *"may take over any account on this node"*.

**Root cause is the gate, not the grants.** Connecting a local folder and creating a project
are node-admin-gated, so the operational way to let a teammate onboard their own project was
to make them a node admin. A coarse capability manufactured a privilege-inflation policy. The
fix is to split the capability (P1.2), then de-escalate — de-escalating first just breaks
onboarding again.

---

### F5 · HIGH · A new account lands nowhere — the "user space" requirement fails today

`ensure_account` (`007:150-196`) inserts a `user_profiles` row and an `accounts` row, and
stops. It creates **no space and no member row**.

`ramu` is the proof: 0 memberships. On login the UI resolves zero spaces and renders
`"No spaces on this node."` (`GateApp.tsx:896`). The remedy button is gated on
`projectOnboardingPort`, and `spaces.create` is a contract op the UI seam does not expose
(`tm8-ui/src/auth/reasons.ts:59-64` — *"the op EXISTS server-side; the seam does not"*).

This is exactly the line in the task — *"once they login it has to load respective space and
its projects"* — and it is the one requirement that is a straightforward build, not a
redesign.

---

### F6 · HIGH · No access control *within* a space — `restricted` is inert

`008:31` states it plainly: `'restricted' is inert in v1 (01 §S4)`. `021` activated it for
exactly one kind (`project` projections). The `visible_to` edge type is registered and has
**no reader**.

So `visibility='space'` is the only live value, and it means *every member of the space sees
every entity in it*. Inside "Utho Prod" — 7 members — there is no way to say "this document,
these two people", "this task, the assignees only", or "this file, not the contractor".

The one exception proves the shape is understood: `saved_views` has `share_mode` +
`owner_member_id` and a two-arm policy (`008:163-168`). That pattern is the model for the
general case.

The task's *"cross user based access control"* has two readings and both land here:
**(a) isolation** — A must not reach B's things; **(b) controlled sharing** — A grants B
something specific, auditably and revocably. Today the graph offers neither at sub-space
grain: within a space it is all-or-nothing, across spaces it is nothing (except node admin,
which is everything — F4).

---

### F7 · MEDIUM · Two authority checks read the *claim* instead of the table

The design's own invariant (`001:141-145`): *"Authorization NEVER trusts them"* — the CSV/flag
claims are a server fast path; authority resolves from tables via `tm8.identity_id`.

Two functions break it:

- `internal.is_node_admin()` (`001:166`) reads the `tm8.node_admin` **claim**.
- `internal.require_node_admin()` (`002:319`) reads the **accounts table**. ✅

The claim form is used in a **read policy** — `projects_select` (`008:178`) — and, worse, in
three **write gates** in `095_file_upload_slot_sweep.sql:46,83,137`.

Not exploitable from a client today: the server derives the claim from the token-hash-verified
session row. But it converts a claim-construction bug in the server from *"Postgres refuses"*
into *"privilege escalation"*, and it is the one place the schema does not enforce its own
stated rule.

---

### F8 · MEDIUM · Auto-owner is insecure-by-default in code (correct in prod config)

`identity-resolver.ts:79-88`: an unauthenticated loopback request with no forwarding header
resolves as **the node owner**.

`config.ts:347`: `TM8_DISABLE_AUTO_OWNER` defaults to **`false`** — auto-owner **on**.

Measured: prod (`:17777`) and staging (`:8887`) both set `TM8_DISABLE_AUTO_OWNER=1`. **Prod is
not currently exposed by this.** But the entire multi-user posture of an 8-account node rests
on one env var that defaults the unsafe way. A fresh deploy, a dev node, a systemd drop-in
edit, or a container that misses the variable silently makes every unauthenticated loopback
caller the owner.

This should not be an env default. It should be a **boot invariant**: a node with more than
one account refuses to enable auto-owner.

---

### F9 · LOW · Agent session lifetime is 7 days; browser 30; CLI 90

`pg-auth.ts:43`. An agent session should not outlive its work session by more than a grace
window. `revokeAgentSession` exists — the plan is to guarantee it fires and cut the TTL to a
backstop, not a lifetime.

---

## 3. The shape of the problem

Three distinct boundaries are being asked for, and tm8 currently implements **one**:

```
                      TODAY                          TARGET
  ┌───────────────────────────────┐   ┌────────────────────────────────────┐
  │ node                          │   │ node                               │
  │  └─ space  ◄── the ONE gate   │   │  ├─ domain (tenant)      §6.1      │
  │      └─ everything, flat      │   │  │   └─ space (= user space) §6.2  │
  │                               │   │  │       ├─ project  (owned) §6.3  │
  │  node_admin ── crosses it all │   │  │       ├─ entity   (ACL)   §6.4  │
  │                               │   │  │       └─ agent    (scoped)§6.5  │
  │  agents: 1 uid, full identity │   │  └─ capabilities, split    §6.6    │
  └───────────────────────────────┘   └────────────────────────────────────┘
        DB boundary: strong                DB boundary: strong + fine-grained
        OS boundary: NONE                  OS boundary: per-identity uid
```

The DB layer needs **refinement** (a second grain below space, an owner on projects, scoped
sessions). The OS layer needs to **exist**.

---

## 4. Design principles this plan holds to

These are tm8's existing principles; the plan extends them rather than introducing a
competing philosophy.

1. **Authority resolves from tables, never from claims.** Fixes F7; every new predicate obeys it.
2. **Fail closed.** A new table is unreadable until a migration grants it (`008:250-252`). New grants inherit nothing.
3. **The write surface stays enumerable.** No new INSERT/UPDATE/DELETE grant to `tm8_app`; new writes are SECURITY DEFINER RPCs.
4. **Deny is the default; sharing is an explicit, revocable, audited grant.** No implicit widening.
5. **Two enforcement layers, independent.** DB authorization must not be the only thing standing between two users' agents. The OS layer is the second.
6. **Capabilities are narrow and named.** `node_admin` becomes a set; nothing is bundled because it happens to be administrative.
7. **Attribution never widens reach.** `acting_as` narrows who you sign as; it must also be able to narrow what you can touch.

---

## 5. Phased plan

Sequenced so each phase is shippable, verifiable, and does not strand the phase after it.
Effort is engineer-days for one engineer familiar with the codebase.

---

### Phase 0 — Contain (≈3 days, no schema change)

Reduce blast radius before anything is redesigned.

| # | Work | Files | Days |
|---|---|---|---|
| **P0.1** | Cut agent session TTL from 7d to `session lifetime + 1h` backstop | `pg-auth.ts:43` | 0.5 |
| **P0.2** | Guarantee `revokeAgentSession` fires on **every** session exit — including signal deaths, which are currently logged as clean exits. Add a sweeper for sessions whose PTY is gone. | `SpawnService.ts`, `execution/pty` | 1 |
| **P0.3** | Boot invariant for auto-owner: if `count(accounts) > 1` and auto-owner is not disabled, **refuse to start** with a named error. Mirrors the existing `TM8_BIND` refusal (`config.ts`), which is the precedent. | `http/config.ts`, `main.ts` | 0.5 |
| **P0.4** | Move `095_file_upload_slot_sweep` write gates from `is_node_admin()` (claim) to `require_node_admin()` (table) | `db/migrations/1NN_*.sql` | 0.5 |
| **P0.5** | Audit + record: who holds `is_node_admin`, why, and which of the 18 RPCs they actually need. Input to P1.2. | doc | 0.5 |

**Not in Phase 0:** revoking node admin. That breaks onboarding until P1.2 lands. Sequence matters.

---

### Phase 1 — Identity and tenancy: the "user space" requirement (≈8 days)

**Delivers the task's explicit line:** login → your space → its projects.

#### P1.1 · Personal space auto-provision (3d)

New migration extends `ensure_account` to create, in the same transaction:

```
space         name = "<display_name>'s Space", visibility = 'private',
              created_by_identity = <new identity>
members       (space_id, identity_id, role='owner')
              + the default teammate seed (bootstrap/default-teammates.ts — already
                factored for exactly this second caller)
```

- Idempotent: an account that already has a personal space gets nothing new.
- New column `spaces.personal_for_identity text unique` — marks the one space that *is* the
  user, so boot can find it without guessing, and so it can be protected from deletion.
- **Backfill migration** for the 8 existing accounts; `ramu` (0 spaces) is the live case.

> Design note: this makes "space" carry two meanings — *your* space, and *a shared* space.
> That is what the task asks for (*"space is nothing but user space"*) and the schema already
> supports both; `personal_for_identity` is what distinguishes them. §9 Q2 checks this reading.

#### P1.2 · Split `node_admin` into named capabilities (4d)

New table, resolved from tables (principle 1):

```sql
create table public.account_capabilities (
  account_id  uuid not null references public.accounts(id) on delete cascade,
  capability  text not null check (capability in (
                'accounts.manage',      -- ensure_account, set_credential, set_disabled,
                                        --   revoke_sessions  (ACCOUNT TAKEOVER — owner only)
                'projects.register',    -- create_project / update_project for OWN root
                'projects.register.any',-- ... for any path on the node
                'connections.manage',   -- local server connections
                'node.maintain'         -- prune_auth_sessions, upload-slot sweep
              )),
  granted_by  uuid references public.accounts(id),
  granted_at  timestamptz not null default now(),
  primary key (account_id, capability)
);
```

- `internal.require_capability(text)` — table-resolved, mirrors `require_node_admin`'s shape.
- Each of the 18 RPCs moves to the narrowest capability that fits.
- `is_owner` implies all. `is_node_admin` is **retained and backfilled** to the full set, then
  deprecated in P1.4 — so the migration is not a flag day.
- **Grants are audited**: `granted_by` + `granted_at`, and a grant emits a workspace event.

#### P1.3 · Login → space → projects (1d)

- `spaces.list` orders the caller's `personal_for_identity` space first.
- Boot resolves: personal space → last-place (`views/last-place.ts`) → first space.
- The `"No spaces on this node"` card becomes unreachable for a provisioned account; it stays
  as the honest state for a genuinely empty node.
- Project list for the landed space comes from `space_projects` — already correct.

#### P1.4 · De-escalate (0.5d, gated on P1.2 shipping)

Revoke `is_node_admin` from `subhang`, `breakglass`, `bhargav`, `raghav`, `ramu`, `tarkesh`;
grant each the narrow capabilities P0.5 established they use. `owner` keeps
`accounts.manage`. **This is the finding-F4 fix and it only works after P1.2.**

---

### Phase 2 — Project and workspace isolation (≈6 days)

#### P2.1 · Projects get an owner (2d)

`projects` today has **no owner column** — `working_dir`, `trust`, `defaults`, and nothing
about who it belongs to. Add:

```sql
alter table public.projects
  add column owner_identity_id text references public.user_profiles(identity_id),
  add column workspace_root     text;   -- the containment root, see P2.2
```

Backfill from `space_projects.linked_by` → `members.identity_id`.

#### P2.2 · Workspace-root containment (2d)

Per-identity root: `<dataDir>/workspaces/<identityId>/`.

DB invariant (a check + a trigger, because the containment is relational):

> A project created by an account **without** `projects.register.any` must have
> `working_dir` contained in that identity's workspace root.

Server-side path resolution (realpath, symlink refusal) already exists in the blob store —
reuse that discipline, do not write a second path validator.

The three current projects (`/home/tm8/lvlup`, `/home/tm8/raghava-space`,
`/home/tm8/prod-workspace`) are grandfathered with an explicit, dated exemption row rather
than by weakening the rule.

#### P2.3 · `projects_select` stops trusting the claim (1d)

```sql
create policy projects_select on public.projects for select to tm8_app
  using (exists (select 1 from public.space_projects sp
                  where sp.project_id = projects.id
                    and internal.is_space_member(sp.space_id))
         or projects.owner_identity_id = internal.identity_id()
         or internal.has_capability('projects.register.any'));   -- TABLE-resolved
```

Removes the node-admin-sees-all-projects arm (F4) and the claim read (F7) in one change.

#### P2.4 · Per-identity data-dir partitioning (1d)

`credentials/`, `workspaces/`, `worktrees/`, `scratch/` become
`<root>/<identityId>/...`. Ownership follows in Phase 4 — this phase only establishes the
layout so Phase 4 is a `chown`, not a migration.

---

### Phase 3 — Cross-user access control inside a space (≈10 days)

**This is F6, and it is the substance of "cross user based access control."**

#### P3.1 · Generalize `entity_readable` (3d)

The activation note is already written into the schema (`008:35-37`): add the
`visible_to` arm. Extend `internal.entity_readable` to:

```
visibility = 'space'       → any member                       (today)
visibility = 'restricted'  → project-projection arm           (today, 021)
                           + explicit grant arm               (NEW)
visibility = 'private'     → the owner only                   (NEW)
```

#### P3.2 · The grant table (3d)

One mechanism for every kind, so there is never a second convention:

```sql
create table public.entity_grants (
  entity_id   uuid not null references public.entities(id) on delete cascade,
  subject_id  uuid not null,   -- member OR team_member entity id
  capability  text not null check (capability in ('read','comment','write','admin')),
  granted_by  uuid not null references public.members(entity_id),
  granted_at  timestamptz not null default now(),
  expires_at  timestamptz,
  primary key (entity_id, subject_id, capability)
);
```

- Subject may be a **team_member**, which is how an agent is given narrower access than its owner.
- `expires_at` makes time-boxed sharing a first-class thing rather than a cleanup task.
- Grants are events: create/revoke writes to `workspace_events`, so sharing is auditable.
- `saved_views.share_mode` is **left alone** — it works, and migrating it buys nothing.

#### P3.3 · Write-side capability checks (2d)

`require_space_member` (171 call sites) stays as the coarse gate. Entity-scoped writes gain
`require_entity_capability(entity, 'write')`, which resolves: owner → space role → grant.
Rolled out kind by kind, starting with `document` and `file` (the kinds where "not everyone"
is most often meant), not big-bang across 171 sites.

#### P3.4 · Files (2d)

File entities ride P3.2 unchanged — a file is an entity, `files_select` already delegates to
`entity_readable`, so activating the grant arm gives per-file ACLs with no file-specific code.
The blob store needs no change: it is already space-partitioned and traversal-safe.

---

### Phase 4 — Agent isolation (≈12 days) — **the largest gap**

#### P4.1 · Scoped agent sessions (4d) — closes F3

```sql
alter table public.auth_sessions
  add column scope_space_id   uuid references public.spaces(id),
  add column scope_project_id uuid references public.projects(id),
  add column scope_task_ids   uuid[];
```

- `issue_agent_auth_session` **must** set `scope_space_id` — not null for `kind='agent'`.
- `internal.is_space_member(target)` gains a scope intersection: when the bound session has a
  scope, membership is `member AND target = scope_space_id`. One change, and every one of the
  RLS policies and 171 write gates inherits it — which is exactly why the single-predicate
  design in `002` was the right call.
- Claim plumbing: server binds `tm8.scope_space_id` from the **verified session row**, and the
  predicate resolves it from `auth_sessions` (principle 1 — the claim is the fast path, the
  table is the authority).

**Effect:** a stolen agent token (F1) is worth one space instead of an identity.

#### P4.2 · Per-identity OS users (5d) — closes F1 and F2

The only real fix. Everything else is mitigation.

- Provision `tm8-u-<n>` per identity, home = that identity's workspace root (P2.2/P2.4).
- The spawn service launches the PTY as the owner's uid. `SpawnService` already owns process
  creation in one place, which makes this a contained change; a privileged helper or systemd
  transient unit does the uid drop.
- `chown -R` the per-identity `credentials/`, `workspaces/`, `worktrees/`, `scratch/`.
- `blobs/` becomes group-readable per space via a per-space group, or — simpler and stricter —
  stays owned by the server uid and agents reach blobs **only through the API**, never the
  filesystem. Recommend the latter: it keeps one enforcement path.
- Mount `/proc` with `hidepid=2` **after** the uid split. Before it, `hidepid` buys nothing —
  all agents are one user, so nothing is hidden from anyone.

**Sequencing note:** this is where the plan meets real operational cost. Options in
descending isolation: containers per session → per-identity uid (recommended) → per-identity
uid + seccomp. Containers are stronger and considerably more invasive; the uid split closes
both proven findings and is reversible. §9 Q3.

#### P4.3 · Agent capability narrowing (2d)

An agent's `team_member` becomes a first-class ACL subject (P3.2), so a teammate can be given
*less* than its owner — read-only on a space, or a single project. `can_act_as` (`002:254`)
already models ownership; this adds the reach half it deliberately does not cover.

#### P4.4 · Secret delivery hardening (1d)

Once uids are split, move `TM8_AGENT_TOKEN` out of `environ` into a `0600` file owned by the
agent's uid, referenced by path. `environ` is world-readable-to-same-uid and snapshotted at
exec; a file is at least revocable by unlink. Low value before P4.2, real value after.

---

### Phase 5 — Verification (≈5 days, runs alongside 1–4)

**FakeDb unit tests cannot see plpgsql or RLS.** Every authorization claim in this plan needs
a real-Postgres test or it is untested. That is a known trap in this codebase, not a
hypothetical.

| Suite | Asserts |
|---|---|
| **Cross-user matrix** | For each (actor, resource) pair across two accounts × two spaces × every kind: read/write allowed or refused. Table-driven, real DB. The regression net for F6/P3. |
| **Scoped-token** | A `kind='agent'` token scoped to space A returns zero rows for space B, on every RLS-covered table. |
| **Provisioning** | New account → exactly one personal space, owner role, default teammates, lands there on login. |
| **Capability split** | Each of the 18 RPCs refuses without its named capability and succeeds with it — 36 cases. |
| **OS isolation** | Two agents, two identities: agent A cannot `read` B's workspace root, credential home, or `/proc/<B>/environ`. **This test would fail today** — it is the F1/F2 regression gate. |
| **Boot invariant** | Node with 2 accounts + auto-owner enabled refuses to start. |

Also: extend `check.sh`. It currently tests 5 of 8 packages — `prompt`, `pty-protocol`,
`tm8-ui`, and `ui` never run in the gate. Security tests that do not run in the gate are
documentation.

---

## 6. Target model (reference)

### 6.1 Domain (tenant) — *deferred pending §9 Q1*
A grouping above space, owning: the account population, the capability policy, and the project
registry root. Single-domain today; the table lands with Phase 1 and stays a constant until
the Vesta reference confirms the shape. **Not built on speculation.**

### 6.2 Space = user space
Every account owns exactly one personal space (`personal_for_identity`). Shared spaces are
additional and joined by invite — the existing `space_invites` mechanism (`002:192-204`) is
sound and unchanged.

### 6.3 Project
Owned by an identity, rooted in that identity's workspace root, linked M:N to spaces. Linking
grants the target space's members access to the project — that is the sanctioned cross-user
sharing path, and it becomes auditable via P3.2's event.

### 6.4 Entity
`space` (all members) · `restricted` (grants) · `private` (owner). One `entity_grants` table,
one predicate, every kind.

### 6.5 Agent
Runs as its owner's uid, in its owner's workspace root, holding a token scoped to one space
and optionally one project — never wider than the `team_member`'s own grants.

### 6.6 Capabilities
Named, table-resolved, individually granted, audited. `is_owner` implies all;
`is_node_admin` is deprecated after P1.4.

---

## 7. Sequencing and effort

```
Phase 0  Contain              3d   ──┐ no schema change, ship immediately
Phase 1  Identity + tenancy   8d   ──┤ delivers the stated login→space→projects requirement
Phase 2  Project isolation    6d   ──┤ depends on P1.2 capabilities
Phase 3  Entity ACL          10d   ──┤ independent of 2 and 4; can run in parallel
Phase 4  Agent isolation     12d   ──┘ P4.1 independent; P4.2 needs P2.4's layout
Phase 5  Verification         5d     alongside, not after
                            ─────
                             44d  ≈ 9 working weeks, one engineer
```

**If only one phase ships:** Phase 4. F1 and F2 are proven, live, and require no exploit.
**If only one week ships:** Phase 0 plus P1.1 — contain the tokens, give users their space.

Parallelisable across three engineers to roughly four weeks: {0,1,2} · {3} · {4}.

---

## 8. What this plan deliberately does not do

- **Not a rewrite.** The claim model, RLS posture, RPC-only write surface, and token handling
  are correct and are extended, not replaced.
- **No OIDC/SSO.** Not asked for. The capability split is the prerequisite either way.
- **No change to `space_invites`.** It works.
- **No migration of `saved_views.share_mode`.** It works, and it is the design precedent for P3.2.
- **No speculative Vesta mirroring.** §6.1 is a named placeholder, not an invented design.

---

## 9. Open questions — answers change the plan

**Q1 · Vesta.** There is no Vesta reference on this box. Can you point me at the repo, docs, or
a description of its user-management and domain-management model? Specifically: does a *domain*
own users, or do users belong to many domains? Are project roles declared at domain level and
inherited, or bound per project? This determines §6.1 and whether Phase 1 needs a domain table
from the start rather than after.

**Q2 · "Space is nothing but user space."** I read this as: *every user gets exactly one
personal space on account creation, and login lands there.* Shared spaces (like the 7-member
"Utho Prod") continue to exist alongside. If you instead mean **every space is personal and
sharing happens only by grant** — i.e. "Utho Prod" should be dissolved into per-user spaces
with cross-grants — that is a materially different Phase 1 and I should re-plan it.

**Q3 · Agent isolation appetite.** P4.2 (per-identity uid) is the recommendation: it closes
both proven findings and is reversible. Containers per session are stronger and considerably
more invasive. Which?

**Q4 · The 7 node admins.** P1.4 revokes and re-grants narrowly. Confirm that is wanted, and
whether `owner` alone should retain `accounts.manage` (the password-reset / account-disable
capability), or `subhang` too.

---

## 10. Evidence index

| Claim | Source |
|---|---|
| Agent token readable cross-agent | `/proc/44875/environ`, measured 2026-08-11 |
| One uid for all agents | `ps aux` — prod, staging, all PTYs under `tm8` |
| Data-dir permissions | `ls -la /home/tm8/prod-data` |
| 7 of 8 node admins | `select username, is_node_admin from accounts` (tm8_prod) |
| `ramu` has no space | `select count(*) from members where identity_id=…` |
| 18 node-admin RPCs | `grep -B60 'require_node_admin()' db/migrations/*.sql` |
| `restricted` inert | `db/migrations/008_rls_policies.sql:31-37` |
| Agent token = full identity | `pg-auth.ts:140-160`, `auth_sessions` has no scope column |
| Auto-owner default `false` | `http/config.ts:347`; prod/staging env both set `=1` |
| Claim-vs-table node admin | `001:166` vs `002:319`; used at `008:178`, `095:46,83,137` |
| No `spaces.create` in UI seam | `tm8-ui/src/auth/reasons.ts:59-64` |
| No Vesta anywhere | full-workspace `grep -ril vesta` → only "harvestable" |
