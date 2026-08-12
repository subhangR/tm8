# tm8 User Security — control plane, user homes, cross-space delegation

**Task** `019ff232-2524-78bd-a605-f2d093b76934` · **Branch** `plan/user-security` off `origin/main`@`77f2887` · **Status** approved 2026-08-11, not started
Companion: [`USER-SECURITY-PLAN.md`](./USER-SECURITY-PLAN.md) (commit `196b07e`) holds the measured findings F1–F9 and the evidence index. **This document supersedes its phase structure**; read that one for *why*, this one for *what to build*.

---

## Context

tm8 is a multi-user agent workspace whose authorization core is genuinely strong — RLS on every table failing closed, `tm8_app` holding zero write privilege, all writes as SECURITY DEFINER RPCs, only `tm8.identity_id` carrying authority. But it draws exactly **one** boundary (space membership), and one capability (`node_admin`) crosses it.

The ask is a **control plane**: user creation as a first-class operation that provisions each user's own space *and* their own home, with agents running as that user, and with explicit cross-user delegation so Raghav and Subhang can manage each other's sessions without seeing each other's everything.

Four things are measured fact on the live prod node, not inference:

| | Evidence |
|---|---|
| **Any agent reads any other agent's live bearer token.** All agents run as OS user `tm8`; the token ships in `environ`. | Read an 85-char live `TM8_AGENT_TOKEN` from `/proc/44875/environ` from this session. No exploit — same uid. |
| **The same uid reads every identity's vendor OAuth credentials and both node signing keys.** `0700` guards against other UNIX users; there are none. | `ls -la /home/tm8/prod-data` — all `tm8:tm8` |
| **7 of 8 accounts hold `node_admin`,** which bundles account takeover with project registration across 18 RPCs. | `select username, is_node_admin from accounts` |
| **A new account lands nowhere.** `ensure_account` creates a profile + account and stops — no space, no member row. | `ramu`: 0 memberships → UI renders "No spaces on this node" |

Plus two regressions found during design:

- **`074` silently reverted `072`'s agent-bearer liveness gate.** `db/migrations/072_session_io_routes.sql:36-59` scoped `resolve_auth_session` to live work sessions with an explicit rationale; `074_agent_session_credentials.sql:26-41` redefines the function to add `workSessionId` and **omits the clause**. 074 wins. Agent bearers outlive their sessions by up to the full TTL.
- **Restoring it is a DoS until lifecycle is gated.** `work_session_transition` (`043:92`) is `require_space_member` only, so "mark it exited" would become a one-call revocation of anyone's agent credential. Ordering below reflects this.

### Decisions taken (user, this session)

1. **Cross-space delegation.** Each user has one space — their own. Reaching another user's session is a scoped, revocable, audited grant that crosses the space boundary. Subhang is *not* a member of Raghav's space.
2. **Per-user OS accounts.** Real uid + home per user; agents run as their owner.
3. **Homes at `/srv/tm8/homes`** on the current disk (`/dev/vda1`) — relocation is an atomic rename; quota is advisory.
4. **Ship the control plane first.**

> Existing shared spaces are **grandfathered, not dissolved**. "Utho Prod" has 7 members and real work; membership keeps working. Personal spaces + delegation are the model for everything new. Flag if you want Utho Prod re-homed — that is a separate migration.

---

## Target architecture

```
control plane  ── users.create ──▶  account + personal space + home + OS identity
                                          │
   policy      Postgres (SECURITY DEFINER RPCs, capability table)
   orchestration  packages/server/src/control-plane/     runs as tm8
   privilege      tools/privileged/  (2 root binaries)   never in the server

   Raghav's space                    Subhang's space
     ├ sessions   ◀── grant: drive, 1 session, 4h, audited ──┐
     ├ projects  (under /srv/tm8/homes/tm8uR/projects)       │
     └ files                                                 │
   agents run as uid tm8uR                          agents run as uid tm8uS
```

**Invariant that governs every read change below:** a delegation is a *selection within* what the grant explicitly names — never a widening of space membership. A delegate never becomes a member.

---

## The novel piece: cross-space delegation

This is the part no existing tm8 mechanism covers, and the part the design must get exactly right.

### 1. `work_sessions.owner_member_id` — the keystone

`entities.created_by` cannot be the authorization anchor, because its **kind varies**: a human launch resolves to a `members` row, an agent launch to a `team_members` row (`facade/context.ts:79-82` puts `acting_as_team_member_id` into `tm8.actor_id`). Since `075_shared_teammate_authority.sql:22-46` widened `can_act_as` so any member may act as any teammate in the space, `can_act_as(created_by)` is true for **everyone** in the agent case. That is why every space member can already drive any agent's PTY today — an accident, not a decision.

```sql
alter table public.work_sessions
  add column owner_member_id uuid references public.members(entity_id) on delete restrict;
```

Derived by `internal.derive_session_owner(space, created_by, parent_id)`, in order: created_by if it is a member row → nearest `work_session` ancestor's owner (walking `entities.parent_id`) → `current_member_id(space)` → space owner. A **`before insert` trigger** fills it, which is the compat shim: the three existing insert sites (`043:66`, the 036/007 lineage, `083:540`) need no change.

Ownership inheriting down the spawn tree means "my coordinator may drive my workers" falls out with zero extra clauses.

### 2. The verb ladder — a level, not a set

`watch` < `converse` < `drive` < `manage`. They nest strictly, so store one `text` level and compare with `internal.session_level_rank(text)`; a set would make `{drive}` without `{watch}` representable and meaningless.

| Level | Grants | Enforced at |
|---|---|---|
| `watch` | attach `mode=view` | `grant_stream_attach` |
| `converse` | + deliver a message into the session, answer a session modal | `w2_record_session_message_routes`, `record_execution_command('execution.prompt')` |
| `drive` | + PTY stdin and resize | `grant_stream_attach` `mode=drive`; re-checked `pty-ws-server.ts:385,200` |
| `manage` | + terminate, resume, rename, transition to `exited`/`failed` | `record_execution_command`, `execution_resume`, `rename_work_session`, `work_session_transition` |

Not built, deliberately: **`interrupt`** (it is `0x03` on a byte stream — enforcing it separately requires parsing terminal semantics out of binary frames, which is unsound and produces a capability that only *looks* narrower); **`message` below `watch`** (reply routes return the agent's output to the caller anyway, `099:435-445`, so it has identical real reach); **`delete`** (destroys the audit anchor — owner and space admin only, never delegable).

### 3. The grant table — cross-space

```sql
create table public.session_delegations (
  id                     uuid primary key default internal.new_id(),
  grantor_space_id       uuid not null references public.spaces(id) on delete cascade,
  grantor_member_id      uuid not null references public.members(entity_id) on delete cascade,
  subject_identity_id    text not null references public.user_profiles(identity_id),  -- CROSS-SPACE
  subject_team_member_id uuid references public.team_members(entity_id) on delete cascade,
  scope                  text not null check (scope in ('session','project','space')),
  work_session_id        uuid references public.work_sessions(entity_id) on delete cascade,
  project_id             uuid references public.projects(id) on delete cascade,
  level                  text not null check (level in ('watch','converse','drive','manage')),
  note                   text check (note is null or char_length(note) <= 280),
  granted_by             uuid not null references public.members(entity_id),
  granted_at             timestamptz not null default now(),
  expires_at             timestamptz,
  revoked_at             timestamptz,
  revoked_by             uuid references public.members(entity_id)
  -- + scope-shape check; + subject_identity <> grantor's identity
);
```

**Subject is an `identity_id`, not a member row** — that is the whole cross-space change. `scope='space'` means "all my sessions, including ones that do not exist yet", which is the standing Raghav↔Subhang pairing and the single most important requirement.

### 4. The delegate member row — how a non-member gets an actor

Subhang has no member row in Raghav's space, but writes need attribution and `resolve_actor` requires `can_act_as(actor, space)`. Reify the grant:

```sql
alter table public.members
  add column membership_kind text not null default 'full'
      check (membership_kind in ('full','delegate'));
```

Granting mints a `membership_kind='delegate'` row for the subject in the grantor's space; revoking the last delegation removes it. Then:

```sql
-- internal.is_space_member gains ONE conjunct. Every existing row is 'full',
-- so behaviour is identical for all existing data.
and m.membership_kind = 'full'
```

This is a **narrowing** of the schema's most load-bearing predicate (171 call sites inherit it), and it is what keeps a delegate out of everything the grant does not name. Attribution, `can_act_as`, audit rows and revocation all then work through existing machinery instead of new parallel machinery.

### 5. The read arm — bounded, and cheap when unused

`entities_select` (`008:73`) and `internal.entity_readable` (`008:26`, extended by `021`/`070`) gain a delegation arm reaching **exactly**: the named `work_session` entity, its transcript doc, and messages anchored on it. Not the space's other entities, not the project's other sessions.

Hot-path cost is the real risk — this predicate runs per row on every read in the product. Guard it with a short-circuit:

```sql
-- Claim is a FAST PATH that can only DENY (fails closed if unset or stale);
-- the table remains the authority. Consistent with 001:141-145.
(internal.claim_holds_delegations() and internal.has_delegated_reach(id))
```

Most users hold zero delegations, so the arm costs one boolean in the common case.

### 6. `internal.session_capability(uuid) → text`

One function, one place the rule lives. Highest level or `null`:

```
0. not a live work_session                                        → null
1. ws.owner_member_id = current_member_id(space)                  → manage
2. is_space_admin(space)                                          → manage   (via='space_admin')
3. live delegation, subject_identity = mine, scope matches         → its level
4. live delegation, subject = a teammate I am bound to             → its level
5. ws.share_mode = 'space'                                         → watch   (floor)
6. caller is an agent bearer → intersect with its own spawn tree
```

`internal.require_session_capability(session, level)` raises `42501` with an identical message for every refusal — matching `consume_stream_attach`'s non-disclosure discipline (`087:100-108`).

**Agent scoping (arm 6)** binds a new claim `tm8.auth_session_id` from the token-hash-verified row; `kind` and `work_session_id` come from the table, never the claim. An agent gets full reach inside its own spawn tree and `null` outside it. Binding the row id rather than the work-session id keeps `kind` verifiable, so an agent cannot widen itself by unsetting a claim.

### 7. Leave `can_act_as` alone

`075` answered two questions with one function. Do not narrow it — 30-odd call sites depend on the widening for *authoring, attribution and launch*, all of which are correct. Only **two** sites use it as a *control* predicate, and both move to `require_session_capability`: `087:64-70` (`grant_stream_attach`, both arms) and `074:123` (`revoke_agent_auth_session`). One comment amendment, two call-site replacements, zero risk to the launch path.

### 8. `share_mode` — remove `'explicit'`

It is a footgun: the only guard tests `= 'none'` (`087:64`), so the first writer to set `'explicit'` silently opens the session to the whole space. Zero rows hold it. Narrow the DB constraint to `('none','space')`, leave the TS union alone (a wire type permitting a value the DB never emits is fine; `projector.ts:894` already degrades unknown values). `share_mode` becomes the *broadcast* axis only; delegation is the orthogonal *who-specifically* axis.

**Do not merge with the `entity_grants` sketch** in `USER-SECURITY-PLAN.md` §P3.2. Wrong key (`(entity_id, subject, capability)` cannot express "my future sessions"), disjoint ladders, different enforcement class (RLS read predicate that must never raise vs. write gate that must), different revocation obligation (a live PTY socket must be closed). Share the *conventions* — `granted_by/granted_at/expires_at/revoked_at`, event emission, `require_*` helper style.

---

## Control plane

### Trust boundary — three layers

| Layer | Runs as | Holds |
|---|---|---|
| Policy | `tm8_graph_owner` (SECURITY DEFINER) | who may provision, the capability graph |
| Orchestration | `tm8` (the server) | the saga, idempotency, repair |
| Privilege | `root`, per request | `useradd`, `chown`, `setuid` |

Two small root binaries, installed separately from product deploys:

- **`tm8-provisiond`** — systemd **socket-activated** (`Accept=yes`), one NL-delimited JSON request in, one out, exit. No long-lived root process. Verbs: `describe`, `ensure_user`, `ensure_home`, `lock_user`, `unlock_user`, `kill_session`, `purge_credential_dir`, `archive_user`. **There is no verb that takes a command** — the helper cannot be made to run anything. It *computes* `home` from `homesRoot + osUser`; a caller-supplied path is validated against the computed one and otherwise ignored.
- **`tm8-spawn-as`** — ~150-line setuid shim, exec'd *by* node-pty as the PTY's first process, so `OutputBuffer`/`TerminalStateMirror`/resize/subscribers stay untouched. Four checks or it is `sudo`: caller uid == compiled-in service uid; target resolved via root-owned `/etc/tm8/users.map` (never a numeric uid from argv); uid within `[60000, 64999]`; `setgroups`/`setgid`/`setuid` then **`getresuid`/`getresgid` verify the drop stuck**, plus `closefrom(3)`, reset signal dispositions, `umask(0077)`, `execv` (no shell).

Rejected: server-as-root (puts root in the process that parses HTTP and holds the DB URL); `sudo` with argument matching (famously bypassable); `DynamicUser=yes` (unstable uid makes a home it owns meaningless).

### `users.create` — a durable state machine, not a transaction

It spans Postgres, the filesystem and `/etc/passwd`; only one of those rolls back.

```
Phase A  ONE transaction: public.provision_user
  guard    require_capability('users.provision')
           …preserving ensure_account's F1 hole verbatim (007:158-168):
             claim-free ONLY while the node has zero accounts
  replay   user_homes.request_key unique  →  return the recorded result
  account  internal.ensure_account_row   (ensure_account's body, extracted)
  identity serial → os_username 'tm8u<n>', os_uid 60000+n, home /srv/tm8/homes/tm8u<n>
           (NOT identity_id: 'id_<uuid>' is 39 chars, useradd caps at 32)
  space    internal.create_space_for(new_identity, "<name>'s Space", 'private')
  mark     spaces.personal_for_identity  (unique)
  home     insert user_homes(... state='db_ready')
  caps     grant 'projects.register'  ← the de-escalation lever

Phase B  helper, idempotent, outside the transaction
  ensure_user{handle, osUser, uid} → set_user_home_state('ready' | 'failed')

Phase C  best-effort, repairable, never fatal
  ensureDefaultTeammates(q, spaceId)   ← reuse packages/server/src/bootstrap/default-teammates.ts
```

After Phase A the user can log in and see their space; they cannot spawn. `user_homes.state` (`db_ready → fs_ready → ready | failed`) **is** the repair mechanism — `users.repair` drives forward from wherever it stopped.

**Two things not to do.** Do **not** use `command_ledger` as the idempotency key — `internal.prune_command_ledger` (`004:152`) drops rows after 24h, so a day-two retry double-provisions. Use durable `user_homes.request_key`. Do **not** auto-rollback a failed Phase B — that means building an account-deletion primitive reachable from a failure path, which turns "disk full" into "account gone".

**The one significant SQL refactor:** `create_space` (`007:428`) mints the *caller's* member row via `require_identity()`. Extract its body into **`internal.create_space_for(p_identity, …)`** — schema `internal`, **no grant to `tm8_app`** — and make `public.create_space` a one-line caller. `spaces.create` stays bit-identical. Do *not* solve this by binding someone else's `identityId` claim in TypeScript; that puts an impersonation primitive one refactor away from every handler.

### Capability split — the de-escalation lever

`public.account_capabilities` + table-resolved `internal.has_capability` / `require_capability`:

```
users.provision · users.credentials · users.suspend · users.delete
projects.register       ← granted to EVERY user at provision time
projects.register.any · connections.manage · node.maintain · capabilities.grant
```

F4's root cause is that registering a project requires the same capability that can reset another user's password, so granting node admin became the onboarding path. Once `projects.register` (own home only) is a default grant, nobody needs node admin to onboard.

Guards: `is_owner` may grant anything; `capabilities.grant` may grant anything except itself and `users.credentials`; **never self-grant**; refuse a revoke leaving zero holders of `users.credentials` (same spirit as `accounts_single_owner_idx`, `002:63`). Every grant/revoke writes an audit row and a `workspace_event`. `is_node_admin` is backfilled to the full set, kept one release, then dropped.

Same phase, kill the claim reads (F7): `projects_select` (`008:177-181`) and `095_file_upload_slot_sweep.sql:46,83,137` move from `internal.is_node_admin()` (claim) to `internal.has_capability(...)` (table).

### Home layout

`/srv/tm8/homes` is **`root:tm8 0751`** — not server-owned, so a compromised server cannot rename a home out from under its owner.

```
/srv/tm8/homes/tm8u4/              0750 tm8u4:tm8     server may traverse+read
├── credentials/<provider>/        0700 tm8u4:tm8u4   ← server CANNOT read
├── projects/<slug>/               0750 tm8u4:tm8     projects.working_dir lives here
├── worktrees/<projectId>/<wtId>/  0750 tm8u4:tm8
├── scratch/<sessionId>/           0700 tm8u4:tm8u4
├── .config/  .cache/  tmp/        0700 tm8u4:tm8u4
└── .tm8/manifests|journals/       0640 tm8:tm8u4     server WRITES, user READS
```

The group split is the trick: group `tm8` where the server must read, group `tm8u4` where it must not. No `tm8u*` user is in group `tm8`, so peers are excluded by `0750` alone.

**Blobs stay out of homes**, at `<dataDir>/blobs/spaces/<spaceId>` — agents reach them only through the API. Blobs are space-partitioned, not user-partitioned; their safety is a TypeScript control (`w2-blob-store.ts:296-335` regex + realpath + containment) that filesystem access bypasses entirely, and per-file grants are expressible in the DB and not in POSIX modes. `tm8` is already on the agent's PATH, so `tm8 file get <id> -o ./x` is an explicit, audited copy — strictly better than ambient read.

**Projects.** Keep `working_dir` absolute and `unique` (`001:258`) — under per-user homes the constraint becomes free. Add `owner_identity_id` + `scope text check (scope in ('node','user'))`. `scope='user'` requires a **trigger** (`internal.guard_project_containment`) proving `working_dir` is a segment-wise descendant of the owner's `home/projects` — in SQL, not only TS, for the same reason `resolveWorkdir` re-asserts its shape check. `TM8_PROJECT_ROOTS` (`project-directories.ts:10-41`) stops being node-wide and defaults to the caller's home.

### Honest degradation

`TM8_ISOLATION` ∈ `os-users` | `shared-uid` (today's posture, named) | `container` (reserved, refuses at boot). Resolved by probing the helper socket; absent → `shared-uid`.

**Boot invariant** (precedent: the existing `TM8_BIND` refusal in `http/config.ts`):

> `count(accounts) > 1` **and** effective isolation is `shared-uid` **and** `TM8_ACCEPT_SHARED_UID` unset → **refuse to start**, naming the accounts and the remedy.

Fold `TM8_DISABLE_AUTO_OWNER`'s unsafe default (F8) into the same check. `user_homes.isolation` records what was **achieved**, not requested; a session for a user whose home is not `ready` **refuses with a named reason**, never silently falls back to `/home/tm8`.

---

## Phases

Ordered so each is independently shippable. The delegation **write** surface lands before any enforcement, so nobody is ever refused with no way to be granted.

| # | Phase | Days | Key files |
|---|---|---|---|
| **0** | **Contain.** Agent TTL 7d → session+1h (`pg-auth.ts:43`); guarantee revoke-on-exit incl. signal deaths; boot invariant; `095` + `projects_select` claim→table | 3 | `identity/pg-auth.ts`, `execution/spawn/SpawnService.ts`, `http/config.ts`, `main.ts`, `db/migrations/100_claim_to_table_admin.sql` |
| **1** | **Control plane in the DB.** ← ships first, per decision. `account_capabilities`, `has_capability`, `user_home_serial`, `user_homes`, `spaces.personal_for_identity`, `internal.create_space_for`, `internal.ensure_account_row`, `provision_user`. Contract family `users.*` + `node.provisioning.get`. `auth.signup` becomes an alias; delete `signupAccount` | 7 | `db/migrations/101_control_plane.sql`, new `server/src/control-plane/{provisioner,home-layout,isolation,repair}.ts`, `facade/handlers/w2/users.ts`, `contract/src/catalog.ts`, `cli/src/commands/admin.ts`, `facade/handlers/w2/auth.ts:55-69` |
| **2** | **Homes on disk, still shared-uid.** Credential home, scratch, worktrees, manifests relocate under `user_homes.home_path`; project ownership + containment trigger | 5 | `credentials/agent-credential-home.ts`, `execution/spawn/manifest.ts:353-392`, `SpawnService.ts:672,723`, `worktree/WorktreeManager.ts`, `db/migrations/102_projects_ownership.sql`, `services/w2/project-directories.ts:10-41` |
| **3** | **Capability split + de-escalate.** All 18 `require_node_admin()` sites → narrowest capability; live-node backfill; revoke the 5 | 4 | `db/migrations/103_backfill_and_capabilities.sql`, `104_node_admin_retirement.sql` |
| **4** | **`owner_member_id`** — nullable, derive function, `before insert` trigger, backfill, `set not null`. Nothing reads it yet | 1 | `db/migrations/105_work_session_owner.sql` |
| **5** | **Delegation table + predicate, inert.** `session_delegations`, `members.membership_kind`, `session_level_rank`, `session_capability`, `require_session_capability`, `caller_auth_session` (arm 6 dormant), RLS mirroring `notifications_select` (`023:14-34`) | 3 | `db/migrations/106_session_delegations.sql` |
| **6** | **Delegation write surface** + the cross-space read arm. `grant_/revoke_/list_session_delegation`, delegate member-row minting, `entities_select` delegation arm with the claim short-circuit | 4 | `db/migrations/107_delegation_rpcs.sql`, `108_cross_space_read_arm.sql`, `contract/src/catalog.ts`, `cli/src/commands/session.ts` |
| **7** | **Honesty before enforcement.** `sessionAccess: {level, via}` on the work_session summary; `LiveTerminal.readOnly` follows level not liveness; terminate gate reads `manage` | 2 | `facade/entity-read.ts:1181`, `events/projector.ts:894`, `tm8-ui/src/terminal/LiveTerminal.tsx:137`, `tm8-ui/src/domain/actions.ts:316` |
| **8** | **Enforce byte paths.** `grant_stream_attach` → `require_session_capability`; fix `granted_by`; drop `'explicit'`; **revoke `select` on `stream_grants` from `tm8_app`** (it has no TS reader) | 1.5 | `db/migrations/109_stream_attach_capability.sql` |
| **9** | **Enforce message + lifecycle.** Route gating with the **reply carve-out**; `reserve_session_message_delivery` requires an authorized route; terminate/resume/rename → `manage`; transition split | 4 | `db/migrations/110_message_capability.sql`, `111_lifecycle_capability.sql`, `facade/execution-handlers.ts` |
| **10** | **Agent bearer scope.** Restore `072`'s liveness clause (safe only now); bind `tm8.auth_session_id`; activate arm 6 | 2 | `db/migrations/112_agent_session_scope.sql`, `identity/pg-auth.ts`, `facade/context.ts:83-95` |
| **11** | **OS identities.** The two root binaries; `runAs` through the PTY; `kill` becomes hang-up-then-escalate; git as the user; live migration; `TM8_AGENT_TOKEN` out of `environ` | 10 | `tools/privileged/*.c`, `deploy/systemd/*`, `deploy/privileged/install.sh`, `execution/pty/PtyHostService.ts:437-446`, `worktree/WorktreeManager.ts`, `spawn/manifest.ts:924` |

**≈47 engineer-days.** Parallelisable across three engineers to ~4 weeks: {0,1,2,3} · {4,5,6,7} · {8,9,10} → {11}.

### Three carve-outs that must not be missed

- **The reply carve-out (Phase 9).** A reply route targets the session that authored the message being answered (`099:435-445`). Gating it on `converse` would 403 anyone replying in a channel thread to anything an agent said — a catastrophic break on the most-used surface. Rule: **capability is required for caller-initiated delivery, not conversational reciprocity.** The `authored_from` edge is the durable evidence of consent.
- **`work_session_transition` must be split, not blanket-gated (Phase 9).** `reconcileNodeGhosts` (`execution-handlers.ts:1158-1179`) runs under the *node owner's* identity by design. A blanket `manage` gate strands ghost reconciliation and pins the concurrency cap forever. Transitions to `running`/`idle` stay `require_space_member` (activity reports; cannot read or inject bytes); `exited`/`failed` require `manage`; and `reconcileNodeGhosts` resolves each ghost's `owner_member_id` and issues under *that* identity.
- **`LiveTerminal.readOnly` before enforcement (Phase 7).** Today it derives from liveness alone (`:137`). Ship Phase 8 first and a non-owner gets a locally-writable terminal whose keystrokes are silently dropped at `pty-ws-server.ts:385`. "I type and nothing happens" is the one genuinely bad UX outcome in this plan, and Phase 7 is what prevents it.

### Live-node migration (8 accounts, 4 spaces, 3 projects)

Three of four spaces are already personal in practice — adopt them with a predicate conservative enough that it cannot match the 7-member space: *exactly one member, whose identity equals `created_by_identity`.*

| Account | Today | Action |
|---|---|---|
| `raghav` / `subhang` / `tarkesh` | 1-member space each | adopt as personal; relocate `TA` and `lvlup` projects into homes |
| `owner` | Utho Prod (7 members) | stays shared; `prod-workspace` grandfathered `scope='node'` |
| `breakglass`,`bhargav`,`ganesh` | member only | new personal space each |
| `ramu` | account, **0 memberships** | new personal space — the live F5 proof case |

Project relocation is **manual, one at a time, never in a migration** (`tm8 admin projects relocate`): refuse if live sessions, `mv` (same `/dev/vda1` → atomic rename), `git worktree repair`, `update_project`, verify a spawn. Credential homes migrate by **copy, not symlink** — `ensureCredentialHome`'s `lstat` symlink-refusal (`agent-credential-home.ts:142-148`) exists precisely to stop that; do not fight your own control. `hidepid=2` on `/proc` goes **last**, after the uid split — before it, one uid hides nothing from itself.

---

## Verification

**FakeDb sees neither plpgsql nor RLS.** Every authorization claim here needs a real-Postgres test or it is untested. Follow `packages/server/test/db/agent-auth-session.pg.test.ts`: `createW1ScratchDatabase` + `migrationFiles()` + `asApp(identityId, fn)`; `vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 })` is mandatory.

Shared fixture, built once: identities A (owner of space 1), B (owner of space 2, **not a member of space 1**), C, D (space-1 admin); teammates `T_A`, `T_B`; sessions `S_A_human`, `S_A_agent` (created_by = `T_A` — the 075 case), `S_A_child` (parent = `S_A_agent`), `S_B_human`.

| Suite | Asserts |
|---|---|
| `provisioning.pg.test.ts` | Crash-inject between Phase A and B → `users.repair` converges. A replayed `request_key` at **T+48h** returns the recorded result and creates nothing (the `command_ledger` trap). `internal.create_space_for` is **not callable** as `tm8_app`. |
| `work-session-owner.pg.test.ts` | `S_A_agent` → owner **A**, not "everyone". `S_A_child` → A by inheritance. Trigger fills without touching `execution_spawn`. |
| `session-capability.pg.test.ts` | 4 levels × 5 sources × {live, expired, revoked, wrong scope, wrong space}. Both halves — every allow **and** every deny. Scope precedence `session` > `project` > `space`. |
| `cross-space-delegation.pg.test.ts` | **The core new claim.** B holds `drive` on `S_A_human`. B *can* attach-drive it. B **cannot** read any other entity in space 1 — assert zero rows for tasks, docs, channels, other sessions, members. `is_space_member(space1)` is **false** for B. Revoke → B loses everything, and the delegate member row is gone. |
| `session-attach-authority.pg.test.ts` | **The 075 regression gate**, RED against the current chain — commit the red output as `session-attach-pre-109-red.txt` (precedent: `w2-execution-pre-019-pair-shape-red.txt`). Plus: `select token_hash from stream_grants` as `tm8_app` → **permission denied**; `share_mode='explicit'` → constraint violation; `granted_by` = the caller, not `created_by`. |
| `session-message-authority.pg.test.ts` | Anchored post and @-mention by a non-delegate → `42501`; **reply to a message the session authored → ALLOWED**, `authorized_via='reply'`; `reserve_session_message_delivery` with no route row → `42501`. |
| `session-lifecycle-authority.pg.test.ts` | Terminate/resume/rename matrix. Transition to `idle` by a member → ok; to `exited` → `42501`; by owner → ok. `reconcileNodeGhosts` still reconciles. |
| `agent-session-scope.pg.test.ts` | Agent bearer on `S_A_agent`: `manage` on `S_A_child` ok, on `S_B_human` refused. `resolve_auth_session` returns nothing once exited (the `072` restoration). |
| `capability-matrix.pg.test.ts` | Each of the 18 RPCs refuses without / succeeds with its capability — 36 cases. Cannot self-grant. Cannot revoke the last `users.credentials` holder. |
| `os-isolation.test.ts` | Two agents, two identities: A cannot read B's home, B's `credentials/`, `<dataDir>/blobs`, or `/proc/<B>/environ`. **Fails today** — the F1/F2 regression gate. |
| `boot-invariant.test.ts` | 2 accounts + shared-uid + no acceptance → refuses to start. |

**Read-path performance** must be measured, not assumed: `EXPLAIN (ANALYZE, BUFFERS)` on `collections.query` before and after the delegation arm, for a user with zero delegations and a user with many. The claim short-circuit is the thing being verified.

**Gate:** these live in `packages/server`, which is in `check.sh` — but `check.sh` runs only 5 of 8 packages (`prompt`, `pty-protocol`, `tm8-ui`, `ui` never run). Extend it; a security test that does not run in the gate is documentation. Also confirm `tools/ci/migrations-check.sh` survives a cold apply and `w2-migration-order.pg.test.ts` still passes (it asserts `015` sits at index 14 — appending at 100+ does not disturb it).

---

## Deliberately accepted

1. **A compromised tm8-server is still total loss.** `tm8-spawn-as` runs anything as any provisioned user for anyone holding uid `tm8`. This reduces the *agent* blast radius, not the *server's*.
2. **Reply reciprocity** — anyone who can make your agent speak in a channel can reply into it without a grant. Bounded by the wake budget (`019:747`) and the interaction pin (`099:513-527`).
3. **Space admin holds `manage` on every session in their space.** Audited via `via='space_admin'`. Still a massive narrowing from today, where every *member* can terminate.
4. **Half-provisioned users persist until repaired.** No auto-rollback, on purpose.
5. **Session kill becomes hang-up-then-escalate.** A process ignoring SIGHUP lingers for the grace window.
6. **Revocation is next-grant-effective** until live sockets are closed on revoke — bounded by the ≤60s stream-grant TTL (`087:40-43`).
7. **Agents lose filesystem access to blobs.** Recovered via `tm8 file get`.
8. **Worktrees on shared node-scope projects are unavailable in `os-users` mode** until per-project POSIX groups land — a named refusal, not a silent fallback.
9. **Quota is advisory** (`du`-based job) — `/dev/vda1` has no `usrquota`.
10. **uids are never reused;** 60000–64999 = 5000 users, then provisioning refuses. Loudly.

## Open items

- **Utho Prod (7 members) is grandfathered.** Say if it should be re-homed into personal spaces + grants — separate migration, not in this plan.
- **The Vesta reference still is not available** — no code, doc, or string anywhere on this box (the only `vesta` hits are the substring in "har**vesta**ble"). The domain/tenant layer above space is deliberately **not** designed on speculation. If Vesta groups users under a domain with inherited project roles, that is an additive table above `spaces` and it changes Phase 1's shape.
- **Who may call `users.create`** — assumed operator-only (owner + break-glass), matching `ensure_account`'s existing "no open self-registration" posture. Self-service signup would need a rate limit and an invite gate.
