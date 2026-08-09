# 3 — Design: principal and storage

> Design document, exported from the tm8 graph at entity `019fdc8d-544c-78d5-96d9-ee87fba95847` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 3 — Design — principal and storage

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

### 3.0 Principle

> The injection seam already exists and is one function. The design problem is **not** injection.
> It is (a) whose credentials, (b) where they live given S15, (c) `HOME`, and (d) being honest
> about what isolation a single OS uid can and cannot provide.

### 3.1 Layer 0 — Whose credentials? (`CredentialPrincipal`)

The spawning **human account/identity**, not the persona.

- `claims.identityId` is already the requester (`facade/context.ts:82`), correct under both
  loopback auto-auth and Identity v2 bearer.
- Personas (`team_members`) are shared authoring identities owned by a member
  (`002_identity.sql:113`, `owner_member_id`) — several humans can drive one persona, so a
  persona-keyed credential would be a shared credential wearing a per-user label.

`GraphAuth` is `unknown` in `@tm8/execution` (`spawn/types.ts:67`) — deliberately opaque. So the
principal must be threaded **explicitly** as a new `SpawnRequest` field or a new
`CredentialPort` argument, resolved server-side from claims. Never read out of `auth` by casting.

**Delegated spawns.** A session that spawns a child (`parentSessionId`) has no human at its PTY.
Rule: **a child inherits its parent's credential principal, and may never name another.** Same
argument as posture inheritance (`manifest.ts:226` — inheritance hands the child only what the
parent already holds), and `parentSessionId` is client-asserted, so it must be a
default-selection mechanism and never an authorization one.

### 3.2 Layer 1 — Storage

**S15 must be confronted directly, not worked around.** Two candidates:

| | A — encrypted in Postgres | B — node-local store, DB holds metadata |
|---|---|---|
| S15 | amended: "no *plaintext* secret in PG" | preserved verbatim |
| pg_dump | ciphertext, useless without keyfile | secret-free by construction |
| refresh-in-place (Claude OAuth) | impossible without a write-back path | natural — it is a directory |
| multi-node / hosted | works | needs a per-node story |
| precedent in tree | none | **044** (creds deliberately removed from `server_connections`), **074** (only hashes in `auth_sessions`) |

**Recommend B.** It matches two existing decisions rather than reversing one, and it is the only
option that survives the Claude OAuth refresh constraint (§C2).

```
<dataDir>/credentials/<identityId>/          0700
  claude/          → becomes CLAUDE_CONFIG_DIR   (.claude.json, .claude/.credentials.json)
  codex/           → becomes CODEX_HOME          (auth.json, config.toml)
  gh/              → becomes GH_CONFIG_DIR       (hosts.yml)
  git/config       → becomes GIT_CONFIG_GLOBAL
  ssh/id_*         → GIT_SSH_COMMAND -i …
  env.json         0600 — {name: value} for pure env-var credentials
```

Postgres gets an **index only**, no values:

```sql
create table public.credential_refs (
  id                 uuid primary key default internal.new_id(),
  owner_identity_id  text not null references public.user_profiles(identity_id),
  space_id           uuid references public.spaces(id) on delete cascade,  -- null = all spaces
  provider           text not null,      -- 'anthropic' | 'github' | 'openai' | …
  label              text not null,
  env_var_names      text[] not null default '{}',
  fingerprint        text,               -- sha256 prefix, for "is this the key I think it is"
  status             text not null default 'active',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_used_at       timestamptz
);
```
RLS: an identity selects only its own rows. **The facade is write-and-list only — there is no
read-value operation, at any privilege.** The value's only exit from disk is `composeEnv`.
Extend `internal.guard_manifest_secrets`'s pattern set to cover this table as defence in depth.
