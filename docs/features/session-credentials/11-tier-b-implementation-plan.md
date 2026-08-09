# 11 — Tier B: full implementation plan

> Design document, exported from the tm8 graph at entity `019fdc8d-5dd4-729f-985e-2148300c8364` v13.
> The graph entity is the source of truth; this file is the reviewable copy.

# 11 — Tier B: full implementation plan

*Sub-document of “Design: per-member credential management in sessions”. Written against
`/opt/tm8/staging` @ `5f01cc4` (the deployed line), which is the only tree that has
`079_account_git_credentials`. Read sub-doc 0 first.*

**What Tier B is:** the user completes a vendor's own login flow in a real terminal rendered in
their browser, with `HOME` and the config-dir vars already pointed at their own credential
directory. It is the only mechanism that can capture a **Claude subscription or ChatGPT login**,
because those credentials are files carrying a refresh token, not strings.

---

## A. Design decisions, and why

### A1. A credential session IS a `work_sessions` row, with `mode = 'credential'`

Not a parallel PTY registry. The staging line's attach authorization is real —
`pty-ws-server.ts` carries a `PtyAttachAuthorizer` seam whose own comment says *"Bearing a
session id is NOT authorization: before this seam existed, any caller who…"* — and it is built on
work-session ids. A second registry would have to re-implement attach authz, terminate, liveness,
ghost reconciliation and the UI's session plumbing, and would diverge from the security half first.

Schema-legal today, verified: `public.work_sessions` has **no `team_member_id` column** (the
persona is a `participates_in` edge), and `agent_tool`, `model`, `mode`, `project_id` are all
nullable. A personaless, projectless row needs no column changes.

### A2. It gets none of the *agent* capabilities

No `TM8_AGENT_TOKEN`, no manifest, no persona, no project cwd, no task edges.

> **CORRECTED BY REVIEW (sub-doc 14, D8):** an interaction-profile pin is **not** avoidable.
> `work_sessions_w1_after_insert` → `internal.after_work_session_insert_w1` →
> `internal.ensure_core_interaction_pin(new.entity_id)` fires unconditionally on **every** insert
> into `work_sessions`. A pin will exist; it is inert for a login terminal. The claim is about
> *agent capabilities*, not about every row artefact.
>
> Good news from the same audit: the persona-requiring paths fail **closed** with typed errors
> rather than misbehaving — `issue_agent_auth_session` raises 42501 without a `participates_in`
> edge, `issue_work_session_agent_session` raises P0002. A login terminal is not an agent, and every one of those is a capability it has no
use for.

### A3. The env is built by a **separate function**, not a flag on `composeEnv`

`composeCredentialEnv()` lives beside `composeEnv` and shares nothing but the PATH helpers. A
boolean parameter on `composeEnv` is one wrong branch away from handing a login terminal an agent
token — and that branch would be invisible in review. Two functions cannot make that mistake.

```ts
// packages/execution/src/credentials/credential-env.ts
export function composeCredentialEnv(input: {
  provider: 'anthropic' | 'openai' | 'github';
  homeDir: string;        // <dataDir>/credentials/<identityId>
  configDir: string;      // …/claude | …/codex | …/gh
  parentEnv: NodeJS.ProcessEnv;
}): Record<string, string> {
  const env: Record<string, string> = {
    HOME: input.homeDir,
    PATH: withAgentBinDirs(basePath(input.parentEnv), input.parentEnv),  // server's HOME for discovery
    TERM: 'xterm-256color',
    LANG: input.parentEnv.LANG ?? 'C.UTF-8',
    SHELL: '/bin/bash',
    ...(input.provider === 'anthropic' ? { CLAUDE_CONFIG_DIR: input.configDir } : {}),
    ...(input.provider === 'openai'    ? { CODEX_HOME:        input.configDir } : {}),
    ...(input.provider === 'github'    ? { GH_CONFIG_DIR:     input.configDir } : {}),
  };
  return env;   // NOTHING else. No TM8_*, no GH_TOKEN, no ANTHROPIC_API_KEY.
}
```

**`GH_TOKEN` must be absent, and this is measured, not defensive:** `gh` refuses to log in while
it is set — *"The value of the GH_TOKEN environment variable is being used for authentication.
To have GitHub CLI store credentials instead, first clear the value from the environment."*
The shipped `applyGitCredential` always sets it, so a GitHub login run through the ordinary spawn
env would silently no-op.

### A4. The command comes from a fixed server-side table

```ts
const CREDENTIAL_LOGIN_COMMANDS = {
  anthropic: 'claude setup-token',
  openai:    'codex login --device-auth',      // NEVER bare `codex login` — see sub-doc 7
  github:    'gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key',
} as const;
```
No client input reaches argv. This is a PTY running as the tm8 OS user, triggered from a settings
form; a client-supplied command there is remote code execution with a nice UI.

> **CONFIRMED BY MEASUREMENT (sub-doc 15).** The `anthropic` row was a guess between two verbs;
> it is now the measured choice, and for a reason worth keeping: `claude setup-token` requests
> **`user:inference` only**, while `claude auth login` requests six scopes including
> **`org:create_api_key`**. On a T0 node with no cross-user isolation, storing a credential that
> can mint further credentials is a materially worse failure. Keep `setup-token`.
>
> **Its cost is structural, not incidental:** `setup-token`'s scopes exclude `user:profile`, so a
> `setup-token`-authenticated directory can *never* populate `email`/`orgId`. The Claude card
> cannot say "Connected as <email>" — only "Connected — inference access". That is a product
> decision (least privilege vs. a named identity on the card), and it belongs to whoever owns the
> Connections copy.
>
> Also measured, and both are finish-step bugs waiting to happen:
> **(1)** Claude uses `redirect_uri=https://platform.claude.com/oauth/code/callback` — a **remote**
> callback, never `localhost` — so Claude needs no device flow and no vendor registration on this
> topology; the loop is "stream a URL out, take one line back".
> **(2)** Both verbs write `.claude.json` + a `backups/` entry into `CLAUDE_CONFIG_DIR`
> **before any authentication happens**, so a non-empty config dir is NOT a success signal —
> key on `.credentials.json` (mode 0600) or on `claude auth status`, whose `loggedIn` field is the
> only reliable indicator (it exits 0 either way).

### A5. Storage stays split by credential **shape** (sub-doc 0)

| shape | mechanism |
|---|---|
| string | `account_git_credentials`, AES-256-GCM in Postgres — **already shipped**, keep it |
| file + refresh token | `<dataDir>/credentials/<identityId>/<provider>/`, 0700 |

Tier B *writes* the second kind and *can also* produce the first (a `gh` login writes
`hosts.yml`; the finish step may additionally extract the token and call
`set_account_git_credential`, so GitHub ends up in the shipped path either way).

### A6. Separate concurrency cap

`TM8_CREDENTIAL_SESSION_CAP`, default 2. A credential session must not be starved by a full agent
cap (you could never connect an account on a busy node) and must not starve agents. One live
session per `(account, provider)`.

---

## B. Database

⚠ **Derive the migration number from the union of `origin/main`, your tree, and
`applied_migrations` on BOTH DBs (5442 prod, 5443 staging).** `db/migrate.mjs` hard-fails on a
duplicate three-digit prefix *before applying anything*, so one collision blocks every migration.
Staging is at `079`; `origin/main` tops out at a different `077`.

```sql
-- Metadata for FILE-shaped credentials. There are no secret columns: the secret
-- is a file on disk, so this table is an index and nothing more.
create table public.account_agent_credentials (
  id                uuid primary key default internal.new_id(),
  account_id        uuid not null references public.accounts(id) on delete cascade,
  provider          text not null check (provider in ('anthropic','openai')),
  login             text,          -- display only: email / handle
  auth_method       text,          -- 'claude.ai' | 'apiKey' | 'chatgpt' …
  connected_at      timestamptz not null default now(),
  last_verified_at  timestamptz,
  status            text not null default 'active' check (status in ('active','stale','revoked')),
  unique (account_id, provider)
);

-- Same shape as 079, deliberately: own row only, resolved from the transaction
-- identity, and NO node-admin bypass — an operator has no business reading a
-- member's Anthropic identity either.
alter table public.account_agent_credentials enable row level security;
create policy account_agent_credentials_self_select on public.account_agent_credentials
  for select using (account_id = internal.current_account_id());
grant select (id, account_id, provider, login, auth_method,
              connected_at, last_verified_at, status)
  on public.account_agent_credentials to tm8_app;
-- No insert/update/delete grant. Writes go through SECURITY DEFINER RPCs that
-- derive the account and take no account parameter.

-- The live login terminal. Rows are short-lived by construction.
create table public.credential_sessions (
  work_session_id uuid primary key references public.work_sessions(entity_id) on delete cascade,
  account_id      uuid not null references public.accounts(id) on delete cascade,
  provider        text not null check (provider in ('anthropic','openai','github')),
  expires_at      timestamptz not null,
  finished_at     timestamptz
);
create unique index credential_sessions_one_live_per_account_provider
  on public.credential_sessions(account_id, provider) where finished_at is null;
```

RPCs: `start_credential_session`, `finish_credential_session`,
`set_account_agent_credential`, `delete_account_agent_credential`. All derive the account from
`internal.current_account_id()`; none accepts an account parameter.

`work_sessions.share_mode` is set to `'none'` for a credential session — the terminal streams a
device code and the user's keystrokes, and nobody else in the space has any business watching it.

---

## C. Server

| file | responsibility |
|---|---|
| `credentials/agent-credential-home.ts` | resolve + ensure `<dataDir>/credentials/<identityId>/<provider>/` at 0700, reusing SpawnService's `ensurePrivateDirectory` repair pattern (`mkdir({mode})` does not fix an existing 0755 dir) |
| `facade/services/w2/credential-sessions.ts` | `start` / `finish`: cap, TTL, one-per-pair, fixed command table, spawn, terminate |
| `facade/services/w2/credential-probe.ts` | the verification probes (below) |
| `facade/handlers/w2/credentials.ts` | thin registration, mirroring `git-credentials.ts` |
| `execution/src/credentials/CredentialSessionLauncher.ts` | `composeCredentialEnv` + `pty.spawnIfAbsent` |

**Verification probes** — run in the *same* env after the PTY exits, or on demand:

| provider | probe | output |
|---|---|---|
| anthropic | `claude auth status` | **JSON**: `{loggedIn, authMethod, email, orgId}` — measured |
| github | `gh auth status` | text: `Logged in to github.com account <login>` + token scopes — measured |
| openai | `codex login status` | to be captured; the finish step must tolerate an unparsable answer and mark `status='stale'` rather than claiming success |

A probe result is what flips the card to *Connected as …*. **Never** infer success from a clean
PTY exit — a user who closes the terminal mid-flow exits 0 with nothing captured.

---

## D. Contract and catalog

⚠ **Adding OPERATIONS rows triggers the catalog pin cascade** — roughly 20 pinned counts and 3
shas across 5 packages. Baseline the failures *before* touching anything, or you cannot tell your
breakage from the pre-existing kind.

| operation | method / path |
|---|---|
| `credentials.status` | `GET /v2/identity/credentials` — merged view over `account_git_credentials` + `account_agent_credentials` |
| `credentials.delete` | `DELETE /v2/identity/credentials/:provider` |
| `credentials.loginSessions.start` | `POST /v2/identity/credentials/login-sessions` |
| `credentials.loginSessions.finish` | `POST /v2/identity/credentials/login-sessions/:id/finish` |

The terminal itself reuses `execution.streams.attach` in `drive` mode.

> ## ⛔ CORRECTED BY REVIEW (sub-doc 14, D1 — CRITICAL). This section asked for a verification.
> ## The verification failed, and worse than expected.
>
> **`grant_stream_attach` is not on the socket path at all.** Two independent paths disagree:
>
> | path | share_mode? | creator? | view vs drive? |
> |---|---|---|---|
> | `execution.streams.attach` → `grant_stream_attach` | yes | yes | yes |
> | `/v2/ws?sessionId=…` → `ptyAuthorize` | **no** | **no** | **no** |
>
> `main.ts:362-384` is the entire socket check — it asks only whether the entity exists and is
> visible. `pty-ws-server.ts:303` then wires input unconditionally
> (`onInput: (data) => pty.write(sessionId, data)`). `grant_stream_attach` writes
> `p_token_hash = null` (`execution-handlers.ts:567-570`) and returns a bare
> `/v2/ws?sessionId=<id>`, so **nothing binds the grant to the socket and skipping the RPC reaches
> the same terminal**. `stream_grants` rows are written and never read for authorization.
>
> Measured on live prod against a `share_mode='none'` session created by another member, using the
> 404 body as the discriminator (401 unauthenticated / `no such session` invisible /
> `no live PTY for session` **authorization passed**).
>
> Prod is already a **6-member space**. Under this path any other member can attach to — and type
> into — a credential terminal while a device code is being pasted.
>
> **This is PR0, not a same-PR fix.** It lives in `packages/server/src/main.ts` and
> `packages/server/src/pty/`, which no PR in the original §G sequence touched. It is a standalone
> security fix worth doing whether or not credentials ship.
>
> **And a second gate (D2):** `internal.can_act_as`'s second disjunct is "I am any member of this
> space and the target is any persona in it" — personas are shared, so that is *everybody*.
> `grant_stream_attach`'s drive gate is exactly that predicate, and `execution_spawn` sets
> `created_by` from `internal.resolve_actor`, which prefers the **client-asserted** actor.
> Measured on prod: **19 sessions already have `created_by` of kind `team_member`** and are
> drivable space-wide today. `start_credential_session` must build its envelope with
> `internal.current_member_id(space)`, **never** `resolve_actor` — write the reason as a comment,
> because it inverts what every other spawn path does and a reviewer will "fix" it back.
>
> Note separately: `internal.entity_readable` ignores `share_mode` entirely, so a credential
> session's **existence, title and timestamps are visible to every space member** regardless.
> "Nobody else sees them" is true of the credential values, not of the sessions.

---

## E. UI — `packages/tm8-ui/src/settings-credentials/`

`port.ts`, `ConnectionsScreen.tsx`, `LoginTerminalDialog.tsx`, `reasons.ts`,
`credentials.css` — the same shape as `settings-governance/` (plain values in, no seam import
below the port).

⚠ **Wire it into `SettingsShell` in the same PR.** `settings-governance/index.ts` says
*"MOUNTABLE, NOT MOUNTED"* — three finished screens sitting invisible because wiring was somebody
else's seat. Do not add a fourth.

`LoginTerminalDialog` is `LiveTerminal` in `drive` mode plus a countdown, a *Cancel* that
terminates, and a *Done* that calls `finish`. The session's TTL must be **shorter than the
provider's device-code lifetime**, so an abandoned terminal dies before the code does.

---

## F. Tests

Real-DB tests, not FakeDb — FakeDb cannot see plpgsql rules, and every guard here is plpgsql
or RLS.

1. **Env**: a credential session's env contains no `TM8_AGENT_TOKEN`, no `TM8_SESSION_ID`, no
   `GH_TOKEN`, no `ANTHROPIC_API_KEY`. Assert on the exact key set, not on absence of one name.
2. **Command**: argv equals the table entry; no request field reaches it.
3. **RLS**: Bob's `credentials.status` never returns Alice's row; `select *` as `tm8_app` on the
   git table still raises 42501.
4. **Isolation**: two identities' `CLAUDE_CONFIG_DIR`s resolve to different auth states.
5. **Caps/TTL**: second live session for the same pair refuses; expiry terminates the PTY.
6. **Regression for the `.bashrc` defect** (sub-doc 12 §1): assert `bash -lc 'echo $GH_TOKEN'`
   under an injected value returns the injected value. This test fails on this box today.

---

## G. Sequencing

> **SUPERSEDED BY REVIEW (sub-doc 14).** PR2 was sequenced before its real dependency: on the day
> it landed, every credential session would be attachable and drivable by 5 other members (D1/D2),
> would burn an agent spawn slot (D3), would appear in every session list and rail badge (D4), and
> would be force-exited at node boot if it carried a `node_id` (D5). The revised sequence:

| PR | contents | depends on |
|---|---|---|
| **P0** | Delete the two `export GH_TOKEN` lines; rotate the PAT. **Ahead of everything** — live, silent, misattributes pushes. | — |
| **PR0** *(new)* | Socket attach authorization: make `ptyAuthorize` enforce what `grant_stream_attach` decides (or bind the existing `p_token_hash` to the socket), and carry view/drive on the upgrade. Socket-level test: Bob cannot attach **or drive** Alice's `share_mode='none'` session. | — |
| **1′** | migration + RLS + RPCs **+** `and ws.session_kind = 'agent'` in `internal.live_work_session_count` *(RULED — §H below supersedes this row's earlier `credential_provider is null` phrasing)* **+** the `repair_w1_foundations` / `w1_backfill_participant` guard; `node_id` left NULL by construction. Test that a live credential session does not move `execution.spawn`'s cap arithmetic. | PR0 |
| **2′** | credential home, `composeCredentialEnv`, launcher, probes **+** envelope built with `current_member_id` not `resolve_actor` (D2) **+** assert no `GH_TOKEN`/`GITHUB_TOKEN` in the probe env and cross-check `gh api user` against the `hosts.yml` login before storing (D6). | 1′ |
| **3** | contract + catalog ops; baseline the pin cascade first | 2′ |
| **4** | `settings-credentials/` **+ SettingsShell wiring** **+ the D4 list filters**, including the legacy `packages/ui` screens | 3 |
| **5** | spawn-side `CLAUDE_CONFIG_DIR` / `CODEX_HOME` injection **+ explicit XDG set/clear** (C5) | 2′ |

PR5 is what makes a captured credential actually get *used* by an agent session. PRs 1–4 without
it produce a Connections screen that stores logins nothing consumes — the mirror of today's
state, where the consumer exists and the UI does not.

---

# Addendum — session kind, and where the shell profile is controlled

*Measured 2026-08-07, refining §A1.*

## H. Use an additive `session_kind` column, NOT `mode`

**`mode` cannot carry this, and should not.** Measured constraint on the staging DB:

```
work_sessions_mode_check
  CHECK (mode IS NULL OR mode = ANY (ARRAY['worker','coordinator',
                                           'coordinated-worker','coordinated-coordinator']))
```

`mode` is the **agent mode** — an entirely different axis from "is this a login terminal".
Widening that CHECK to admit `'credential'` would put two unrelated concepts in one column, and
every `asAgentMode()` call site (`manifest.ts:136,261`) would have to learn a value that is not
an agent mode at all.

A new **entity kind** is also the wrong price: `work_session` is one of 19 rows in
`public.entity_kinds`, and a new kind drags in the tm8-ui registry (whose guard is build-failing),
the menu, and the kind-literal tests.

**The cheap, non-invasive answer is one additive column:**

```sql
alter table public.work_sessions
  add column session_kind text not null default 'agent'
    check (session_kind in ('agent','credential'));
```

- **`default 'agent'` means zero impact on the current implementation** — every existing row and
  every existing insert path is unchanged and needs no edit. That is the requirement.
- `mode` stays **NULL** for a credential session. The existing CHECK already permits NULL, so
  **no constraint is widened anywhere.**
- The one unavoidable change: session-listing reads must become
  `where session_kind = 'agent'`. Make that the **default in the read model**, not a filter each
  surface remembers — otherwise a future list quietly starts showing people's login terminals.

> ### ⚖ RULED (architect session `019fdced-0437-7642-9433-591788ef10d5`, 2026-08-07) — this section IS the discriminator design
>
> Sub-doc 14's PR1′ row and the build-task body said a nullable `work_sessions.credential_provider`
> with `credential_provider is null` in the cap counter. **That phrasing is superseded; the column
> above (`session_kind`) ships.** Reasons, in order of weight:
>
> 1. **The provider must live in exactly one place.** §B ships `credential_sessions.provider`
>    with its 3-value CHECK, and the one-live-per-pair guarantee is a partial unique index on
>    `credential_sessions(account_id, provider)` — that column cannot move. A second provider
>    copy on `work_sessions` could disagree with it, and a discriminator that can disagree with
>    itself inside a security feature is disqualifying.
> 2. "What kind of session" and "which vendor" are different axes; a future non-agent kind widens
>    one CHECK instead of adding another nullable column.
> 3. `session_kind = 'agent'` is legible at every one of the ≥7 D4 list call sites.
>
> **Consequences, ruled:**
> - Provider is authoritative ONLY on `credential_sessions.provider`. Classifying a
>   `work_sessions` row by provider requires the join; no hot path needs it.
> - Integrity is RPC-enforced: `start_credential_session` (SECURITY DEFINER) inserts the
>   `work_sessions` row with `session_kind='credential'` and the `credential_sessions` row in one
>   transaction, and `tm8_app` has no insert grant on either table — no other writer exists.
>   Real-DB test required. (The declarative variant — `unique(entity_id, session_kind)` plus a
>   composite FK — is permitted, not required.)
> - The cap function to ship (replaces the ONLY definition, `006_execution_side.sql:179-187` on
>   `origin/main`; 043/048/062 only *call* it inside `execution_spawn`, 047 only grants execute —
>   verified `git grep -n live_work_session_count origin/main -- db/migrations`; signature
>   unchanged so 062's `execution_spawn` needs zero edits):
>
> ```sql
> create or replace function internal.live_work_session_count(target_space uuid default null)
> returns integer language sql stable set search_path = public, internal, pg_temp as $$
>   select count(*)::integer
>     from public.work_sessions ws
>     join public.entities e on e.id = ws.entity_id
>    where ws.status in ('spawning','running','idle')
>      and ws.session_kind = 'agent'
>      and e.deleted_at is null
>      and (target_space is null or e.space_id = target_space)
> $$;
> ```
>
> - The credential cap (`TM8_CREDENTIAL_SESSION_CAP`, default 2, §A6) is the mirror count —
>   `session_kind = 'credential'`, same status set — checked inside `start_credential_session`.
> - PR4's filter, two spellings by layer: SQL surfaces (`space_kind_counts`, future views) say
>   `session_kind = 'agent'`; TypeScript surfaces use ONE exported predicate,
>   `isAgentSession(s) { return s.sessionKind !== 'credential' }` — deliberately `!== 'credential'`
>   and NOT `=== 'agent'`, because a row hydrated from an older cached payload lacks the field and
>   hiding real agent sessions is a feature regression, while credential rows are born after the
>   migration and always carry it. Write that reason as a comment on the predicate or a reviewer
>   will "tighten" it back. `057`'s `to_jsonb(ws)` auto-publishes the column, so `sessionKind`
>   reaches read models with no projection change (PR3 adds it to the contract schema).
>
> *Would change this ruling: a measured hot path needing provider-without-join on `work_sessions`,
> or a second non-agent kind whose cap regime makes mirror-counting awkward. Neither exists today.*

## I. Where the shell profile is actually controlled

The PTY's own shell is `bash -c` (`PtyHostService.spawn`), which reads **neither** `.bashrc` nor
`.profile`. The problem is one process further down: the agent's own tool shells are
**interactive or login**, and those do. Measured:

| mechanism | `bash -c` | `bash -ic` | `bash -lc` |
|---|---|---|---|
| `HOME` → controlled `.bashrc` | not read | **✅ sourced** | — |
| `HOME` → controlled `.profile` | not read | — | **✅ sourced** |
| `BASH_ENV=<file>` | ✅ sourced | ❌ **ignored** | ✅ sourced *(review correction — this cell said ❌)* |

```
$ env HOME=<controlled> bash -ic 'echo $MARKER'   → from-controlled-bashrc
$ env HOME=<controlled> bash -lc 'echo $MARKER'   → from-controlled-profile
$ BASH_ENV=<file> bash -ic 'echo $MARKER'         → <unset>
```

**`HOME` is the only lever that reaches the shells an agent actually spawns.** `BASH_ENV` covers
only the bare `bash -c` case, which is already clean. `--rcfile` is unavailable because tm8 does
not invoke those shells.

### This gives the `GH_TOKEN` defect a structural fix

Sub-doc 12 §1 asks the operator to delete two `export` lines. That works and can be undone by
anyone. A per-identity `HOME` fixes it **by construction** — measured:

```
$ env HOME=<controlled> GH_TOKEN=PER-USER bash -ic 'echo $GH_TOKEN'   → PER-USER
```

With `HOME` pointed at a tm8-owned directory whose `.bashrc` exports nothing credential-shaped,
the injected per-account token **survives into the agent's tool shells**. Do both: delete the
lines now, and make the mechanism unable to come back.

Still read machine-wide and outside this boundary: `/etc/profile` (login shells) and
`/etc/bash.bashrc` (interactive). Both are root-owned, so an **operator** can still poison every
session; a space **member** cannot. That is the honest line, and it belongs in the UI copy
alongside the one-OS-uid caveat.

### What tm8 seeds

`<dataDir>/credentials/<identityId>/.bashrc` and `.profile`, written on first use:

```sh
# managed by tm8 — this file is sourced by agent tool shells for this account.
[ -f /etc/bash.bashrc ] && . /etc/bash.bashrc     # keep machine defaults (completion, prompt)
# Deliberately exports NO credentials. Values arrive in the process environment
# at spawn; anything exported here would override them for every nested shell.
```

Posture copied from `workspace-trust.ts`: **write if absent, never clobber**. If a file is
present without the tm8 marker, leave it and log — the same trade that file already makes for
`.claude.json`.

### The caveat this creates, stated rather than discovered later

A per-identity `HOME` is **writable by the agent running under it** — one OS uid means no file
can be made agent-proof. So an agent can append to its own `.bashrc` and affect that identity's
future sessions. This is persistence, not escalation: it is confined to the identity that already
owns the directory, and it is the same blast radius as the credential itself. It becomes a real
boundary only under T1 (per-identity OS user), and should be named in the UI copy next to
"another member's agent can read these files".


---

# Architect rulings 2–5 — 2026-08-07, session `019fdced-0437-7642-9433-591788ef10d5`

*Ruling 1 (the `session_kind` discriminator) is already written into addendum H. These settle the
remaining standing questions. Evidence classes are stated inline; nothing below was measured
against a live database unless it says so — real-DB verification lands with PR1's tests.*

## Ruling 2 — `credentials.*` is human-only, enforced twice

**The facts that shape it** (read from source; files byte-identical to `origin/main` @ `c913a31`,
checked with `git diff origin/main -- <file>`):
- `auth_sessions.kind` exists: `check (kind in ('browser','cli','agent'))` — `002_identity.sql:170`.
- The resolved request principal already carries `kind`, server-derived from `auth_sessions` by
  token hash (`identity/pg-auth.ts`), never client-asserted.
- The trusted transaction claim surface is exactly FOUR GUCs — `tm8.identity_id`, `tm8.actor_id`,
  `tm8.node_admin`, `tm8.request_id` (`identity/claims.ts:37-42`, `db/client.ts:90-95`). **The
  session kind is never bound into the transaction, so today no RPC or RLS policy can distinguish
  an agent's transaction from its owner's.** That is the whole mechanism gap the review named.

**The rule:** all four ops — `credentials.status`, `credentials.delete`,
`credentials.loginSessions.start`, `credentials.loginSessions.finish` — refuse a caller whose auth
session kind is `agent`. Yes, `status` too: least privilege — no agent workflow needs it, and it
leaks login/email metadata. If a real agent need appears ("will my spawn have credentials?"),
expose a separate boolean-per-provider op; do not open `status`.

**Enforcement, two layers:**
1. **Facade (primary, ships first):** one guard, `requireHumanSession(principal)` → typed
   `forbidden` with code `credentials_human_only` when `principal.session.kind === 'agent'`.
   Applied at **registration** in `facade/handlers/w2/credentials.ts` — one wrapper around all four
   registrations, not four inline checks a fifth op could forget. Testable without a real DB.

   > **AMENDED by measurement (PR3, ruled 2026-08-07):** the single mapped wrapper CANNOT ship —
   > `tools/conformance/src/foundations/source-inventory.ts:74` parses the handler file and
   > requires `registry.registerAll` to receive an object LITERAL; a computed record makes the
   > mounted ops invisible to conformance. Accepted mechanism: the guard FUNCTION applied once
   > per row inside the literal, **plus a registration-shape test derived from the catalog** so a
   > fifth `credentials.*` row fails until both registered and guarded — R2's named floor, made
   > structural. The shape test must assert the guard is applied, not merely registration. If the
   > conformance parser ever follows computed records, the single wrapper becomes preferable
   > again as its own cleanup.
2. **Database (defense in depth):** bind a fifth claim, `tm8.auth_kind`, in `BIND_CLAIMS_SQL`,
   and give the four credential RPCs (`start_credential_session`, `finish_credential_session`,
   `set_account_agent_credential`, `delete_account_agent_credential`) a shared
   `internal.require_human_auth_kind()` that raises 42501 unless the claim is `browser` or `cli` —
   **fail closed: a missing or empty claim refuses.** Why widening the Vega four-claim surface is
   legitimate here where claim-carried membership was not: membership goes stale under the claim;
   an auth session's `kind` is immutable for the session's life, so the staleness objection does
   not apply. *Unverified against a real DB until PR1's tests run.*

**Would change my mind:** if the human owner rejects widening the claim surface, the accepted
floor is layer 1 plus a registration-shape test asserting every `credentials.*` op passes through
the guard. The DB layer is belt-and-braces, not the load-bearing wall.

## Ruling 3 — Disconnect DOES terminate live sessions

`credentials.delete` for (account A, provider P) does, in this order:
1. **Revoke first** — delete the credential row / files (or mark `revoked`) before anything else,
   so no new spawn can inject it during the rest of the operation.
2. Terminate any live **credential session** for (A, P).
3. Terminate live **agent sessions spawned by A** that carry P's credential:
   `anthropic` → A's live sessions with agent tool claude; `openai` → codex;
   `github` → **all** of A's live agent sessions (the git credential injects universally).
4. Synchronous, best-effort: the op reports terminated session ids and any kill failures.
   A failed kill never resurrects the credential.

Reason: doc 14 raised Gap 8 — with D1 live, a Disconnect that leaves the capturing terminal
drivable and the secret injected is a lie in the UI. And because a running process keeps the
credential **in memory** regardless of what we delete, the disconnect confirm dialog must say
both truths: "this stops N running sessions" **and** "to fully revoke, rotate the credential at
the vendor" (Anthropic console / GitHub settings). Termination is containment, not revocation.

**Would change my mind:** measured evidence that github-wide termination makes users avoid
disconnecting. The narrowing fix is to record the injected provider set per session at spawn and
terminate only matching sessions — additive, later, not now.

## Ruling 4 — the Claude card copy

Keep `claude setup-token` (measured choice, sub-doc 15). The card ships as:
- Status line: **"Connected — inference access"**.
- Secondary line: "Connected <date> · this token can only run Claude models. It can't read your
  profile or create API keys — that's deliberate on a shared machine."
- `login` stays NULL for anthropic **forever**; the UI must branch on presence — never render
  "Connected as null", and never "fix" the missing email by switching the login verb: the wider
  verb (`claude auth login`) requests `org:create_api_key`, which is materially worse on a node
  with no cross-user isolation. Put that sentence as a comment in `reasons.ts` beside the copy
  string so the next person inherits the why.

## Ruling 5 — the credential session row's remaining externalities (D5/D8)

> **AMENDED by Ruling 10 (below):** the cross-account boot+interval sweep ordered here is
> unimplementable under 082's deliberate self-select-only RLS (measured by PR2). The replacement
> mechanism — in-memory registry sweep + self-scoped reclaim at start + an expiry-based cap
> predicate — is in Ruling 10. D5/D8 dispositions stand.

- **D5 (ghost reaper):** `node_id` NULL by construction stands — `reconcileNodeGhosts`
  (`SpawnService.ts:1134`) lists by `node_id`, so credential rows never enter its candidate set
  (read from source). The reaper is NOT the credential session's lifecycle owner: the
  credential-sessions service owns its own sweep — on boot and on interval, any
  `credential_sessions` row with `finished_at is null` and (`expires_at < now()` **or** no live
  PTY) is finished and its work_session exited. That lives in
  `facade/services/w2/credential-sessions.ts`, not in SpawnService.
- **D8 (interaction-profile pin):** accepted as unavoidable and inert; A2's restatement ("no
  *agent* capabilities") already covers it. Nothing to build.
- D3 (spawn slot) and D4 (list filtering) are settled by Ruling 1 in addendum H.

## Ruling 6 — provider CHECK lists (asked by PR1, 2026-08-07)

- `account_agent_credentials.provider`: **`('anthropic','openai')`** — exactly as §B writes it.
  "File-shaped" means those two today; `github` is string-shaped and stays in
  `account_git_credentials`. **No `gemini`**: a provider is admitted by measuring its login flow
  (sub-doc 15's process — a login verb in the fixed command table, a probe, a storage shape), not
  by widening a CHECK. Would change: a measured gemini flow + probe lands in these docs.
- `credential_sessions.provider`: keeps `('anthropic','openai','github')` — a Tier B terminal can
  also run the `gh` login even though the resulting string lands in the shipped git table.

## Ruling 7 — `finish_credential_session` stamps, it does not exit (asked by PR1, 2026-08-07)

The RPC stamps `credential_sessions.finished_at` **only**. It never writes
`work_sessions.status`. Reason to keep as a comment in the RPC: session lifecycle has ONE writer —
the process-side terminate / PTY-exit path. An RPC that flips a row to `'exited'` while the PTY
may still be live is exactly the false-`'exited'` lie `SpawnService.terminate` refuses to tell
(its EPERM comment, `SpawnService.ts:1064-1075`). The facade service orchestrates the order:
terminate PTY → normal exit reconciliation → stamp `finished_at`. The Ruling-5 sweep uses the
same division.

## Ruling 8 — migration number is **082**, and the union rule is ALL origin refs (2026-08-07)

PR1 measured (all-refs `git ls-tree` scan, quoted on the architect thread,
msg `019fdcf6-6551-74f0-86ff-71e75797c50b`): **080 and 081 are already held** —
`origin/lane-c/channels` has `080_channel_members`, and `origin/feat/per-user-private-workspaces`
deliberately renumbered its run into `078–081` (incl. `081_account_git_credentials`). The earlier
"080 is free" ground truth was a union over `origin/main` + both deployed ledgers only — real but
incomplete. **Rules:**
- "Next free" = max over **every origin ref's** `db/migrations` tree + `applied_migrations` on
  both deployed DBs (5442, 5443) + the local worktree, plus one. Today that is **082**.
  Re-run the all-refs scan immediately before commit and quote it in the PR.
- Never take a number a live lane already holds; joining a known collision taxes other lanes with
  a `migrate.mjs` hard-fail that only surfaces at merge and then blocks every line.
- **Order-independence over sequencing:** 082 depends on `internal.current_account_id()`, which
  main does not have (defined in staging's `078_private_projects`, unreachable from `origin/main`
  — measured by PR1). 082 must not couple its mergeability to another lane's merge schedule:
  copy the function body **byte-exact** from staging's 078 into 082 as `create or replace` with a
  provenance comment — identical bodies make merge order irrelevant.
  **RESOLVED by measurement 2026-08-07** (`ssh utho "grep -n -A20 'current_account_id'
  /opt/tm8/staging/db/migrations/078_private_projects.sql"`): the function is **self-contained**,
  lines 157–164 — a `create or replace … security definer` selecting from `public.accounts` keyed
  on `internal.identity_id()` and `status = 'active'`, followed by `revoke all … from public;
  grant execute … to tm8_app`. The STOP condition does not apply. 082 copies **only** those lines
  plus the revoke/grant pair. **Hard warning:** 078 ALSO create-or-replaces
  `internal.entity_readable` and `internal.entity_row_visible` — shared multi-arm bodies whose
  main-lineage arms live in the 070 line. Copying either into 082 silently clobbers another
  lane's arm; they are out of bounds regardless of how convenient the file is to copy from.
- Dev DB may apply staging's 078+079 uncommitted; committed real-DB tests must gate any assertion
  on tables main's chain does not create (the git-table 42501 check), with a comment naming the
  providing migration.

## Ruling 9 — PR0 mechanism: `ptyAuthorize` calls `public.grant_stream_attach` (2026-08-07)

Option (B) from the PR0 lane, ruled in because it is faithful **by construction**. Measured
constraint that forces it: `internal.can_act_as` / `internal.current_member_id` have **zero**
execute grants to `tm8_app` (every migration revokes all on `internal`; only named exceptions are
granted), so `ptyAuthorize` cannot call the predicates directly — and an inline tm8_app
transcription of a SECURITY DEFINER predicate runs under RLS and can return a **different
answer**, which is worse than the status quo because it looks fixed. `can_act_as` has already been
redefined once (002 → 075); no third copy.
- Probe `drive` first, on 42501 probe `view` in a **fresh transaction** (42501 aborts the tx), on
  42501 refuse. Null `client_mutation_id` is safe (`require_replay_principal` returns early).
- The attach-time `stream_grants` upsert (bounded by `(work_session_id, subject, mode)`) is
  accepted: it turns a write-only table into a real attach ledger.
- The refusal mapping must keep the measured discriminator set (401 / not-found / refused)
  unchanged — the fix must not alter the enumeration surface doc 14 measured D1 with.
- **Resize is gated on `canDrive`.** TIOCSWINSZ + SIGWINCH is a PTY mutation; `view` means zero
  writes to the PTY, not "only harmless ones". A viewer needing different geometry adapts
  client-side. Would change: measured evidence viewers cannot render — remedy would be a virtual
  per-viewer resize in the stream layer, never TIOCSWINSZ.

## Ruling 10 — R5's cross-account sweep is DEAD; replaced by registry sweep + self-reclaim + an expiry-based cap predicate (amends R5)

**PR2's measurement is accepted:** 082's `credential_sessions` RLS is self-select only with a
deliberately absent node-admin bypass, the server's background identity resolves to one account,
and `node_id` is NULL by construction — so the sweep R5 ordered cannot be run by any role the
server actually runs as. I will not widen the RLS posture to save my own ruling's wording: the
no-bypass header ("an operator has no business watching someone else's login terminal") is
correct and outranks R5's mechanism sketch. R5's *intent* — no credential session outlives its
usefulness in a way that costs anyone anything — survives; the mechanism is replaced.

**Adopted, as proposed:**
1. **Interval sweep from the node's in-memory registry.** The launcher sweeps the credential
   sessions IT started; on expiry it terminates the PTY, the normal PTY-exit path writes
   `work_sessions.status` (R7's one lifecycle writer, untouched), then `finish_credential_session`
   under the member's own claims.
2. **Self-scoped reclaim at `start`.** Before `start_credential_session`, the service finishes the
   CALLING member's own open rows that are expired or have no live PTY on this node — RLS-legal,
   and it heals the one person the partial unique index can block: you, against your own stale row.

**Rejected as written: "the stale row blocks nobody."** False at the cap, and the chain is why:
a crashed node's credential `work_sessions` row stays `status='running'` **forever** — the
PTY-exit path died with the process, the reaper excludes it (`node_id` NULL, R5/D5), and
`finish_credential_session` stamps `finished_at` only (R7). `internal.credential_session_count`
(082:217-226) counts by `ws.status in ('spawning','running','idle')` node-wide, and
`start_credential_session` refuses at the cap (default 2, 082:490-495). **Two crash-orphans and
no member on the node can ever open a login again.** Evidence class: read from source (082 as
committed at `a5bd8f7`), inference on the lifecycle chain — each link is a prior ruling or a
measured reaper predicate.

**Therefore, third element — amend 082 in place** (legal: `a5bd8f7` is unpushed and 082 has never
been applied to any deployed ledger; re-init dev/test DBs): `internal.credential_session_count`
counts from the credential table's own lifecycle columns, not `work_sessions.status`:

```sql
select count(*)::integer
  from public.credential_sessions cs
  join public.entities e on e.id = cs.work_session_id
 where cs.finished_at is null
   and cs.expires_at > now()
   and e.deleted_at is null
   and (target_space is null or e.space_id = target_space)
```

With the TTL clamp (60–1800s) a crash-orphan ages out of the cap in ≤30 minutes with no writer at
all. The comment on the function must state why `status` is NOT the predicate: no lifecycle
writer exists for a crashed node's credential row, so `status` can read `running` forever and
must not gate admission. A live-but-expired PTY is undercounted for at most one sweep interval —
element 1 terminates it. Carry the amendment as **one commit on PR2's stacked branch** (it
contains 082), re-running PR1's 22-test suite and fixing any test that pins the status-based
count; coordinator sequences the merge so `feat/credential-env-launcher` supersedes
`feat/credential-schema`.

**Accepted residual:** an absent member's stale row costs one row, blocks only that member (index
is per-(account,provider), healed by reclaim when they return), and reads `running` in raw
`work_sessions` forever. UI and read models must therefore derive connection/terminal state from
`credential_sessions.finished_at`/`expires_at`, never from the credential work_session's `status`.

**Would change my mind:** a measured path where an unexpired, unfinished row's PTY survives its
process (none exists — node-pty children die with the server), or a per-account cap replacing the
node-wide one, which would make crash-orphans self-limiting and the predicate amendment optional.

## Ruling 11 — the `tm8.auth_kind` claim binding lands in PR2

**Owner: PR2.** Exactly: `identity/claims.ts` (fifth name in `CLAIM_NAMES` + type),
`db/types.ts`, the fifth `set_config` in `BIND_CLAIMS_SQL` (`db/client.ts:90`), sourced from the
**server-resolved** `principal.kind` (pg-auth derives it from `auth_sessions` by token hash —
never client-asserted). PR3 must NOT touch these files; its R2 scope is the facade
`requireHumanSession` wrapper and contract/catalog only.

Why PR2 and not PR3:
1. **PR2 is the first lane that cannot prove end-to-end without it.** A green that depends on a
   hand-bound claim in a harness is exactly the false-green this lane's history keeps producing —
   PR2 was right to refuse to ship it silently.
2. The files are DB-layer, adjacent to PR2's service scope; PR3's scope is contract and facade.
3. Lanes stack: PR3 builds on PR2's commit and inherits the binding, so no shared-file double
   edit ever exists.

**Required proof in PR2, through the real `Db` with no hand-binding:** browser-kind principal →
`start_credential_session` succeeds; agent-kind → 42501 `credentials are human-only`; principal
with no kind → refused (fail-closed, no `is null` escape — 082:133-138 already asserts this at
the RPC). The existing suite re-run green shows the fifth GUC perturbs nothing else (no other
object reads it).

R2's ledger is updated: layer 2 was "unverified until PR1's real-DB tests"; PR1 proved the RPC
gate with a hand-bound claim, PR2 proves the binding itself. After PR2, R2 is fully verified.

**Would change my mind:** coordinator re-sequencing PR3 ahead of PR2 — it is not.

## Ruling 12 — PR3 wires the seam in `main.ts`: shape A, with a region constraint (clarifies R11)


**A.** Add `RegisterFacadeHandlersDeps.credentials?: { launcher; dataDir }`, register the four ops
only when present, and add the one property in the `registerFacadeHandlers` literal at
`main.ts:247`, constructing `CredentialSessionLauncher({ pty: execution.pty })` there. Mirrors
`deps.files` exactly, which is the shipped answer to exactly this shape of problem.

**Why A and not B:** your own citation decides it. Acceptance criterion 2 says *registered and
reachable*; under B a booted node answers `501 not_implemented` for all four ops, and this
project already has a name for that failure — sub-doc 11 §E, "MOUNTABLE, NOT MOUNTED", three
finished screens invisible because wiring was somebody else's seat. A lane that knowingly adds a
fourth instance to satisfy the letter of a ruling is optimizing for my words over the system's
truth. I decline the compliment. **C** stays rejected on `facade/index.ts:75-92`'s own stated
grounds — that header is a prior reviewed decision and it is correct.

**R11's prohibition, clarified (this is the ruling's durable part):** R11 froze the six files
against a *concurrent double edit of the auth_kind binding* while PR2 was live. PR2 is committed
and closed (`1ee7cb9`); a descendant commit in a disjoint region is a normal stacked edit, not
the hazard R11 guards. Amended wording: **the auth_kind binding regions are frozen, not the six
files.** PR3 must not modify PR2's authKind resolution hunk in `main.ts` or any binding line in
the other five; the `registerFacadeHandlers` literal ~100 lines away is yours.

**Collision with PR5:** acknowledged and bounded. Declared region: PR3's `main.ts` edit is the
one property in the `registerFacadeHandlers` object literal plus the launcher construction above
it — nothing else. PR5 owns spawn manifest/env/spawn service and per the coordinator's written
split has no claim on that literal; if PR5 turns out to need `main.ts` for its own wiring,
disjoint regions merge cleanly and the coordinator sequences. I am notifying the coordinator —
**but note the agent wake cap: my pair with the coordinator is exhausted (4/4,
`automated_wake_limit`), so my note may be durable-but-uninjected. Carry this ruling's collision
note in your own next report to the coordinator as well.** Your pair with it should still have
budget.

**The two smaller items — both accepted as stated:**
1. Authoring `status` and `delete` service functions in your lane is correct; the brief was wrong
   that they existed (your measurement stands). `delete` implements R3's order exactly: revoke
   first, then the (account,provider) credential session, then the account's live agent sessions
   carrying that provider; best-effort, reports failures, never resurrects. The confirm-dialog
   copy carries both truths (terminates N sessions / vendor rotation is the real revocation).
2. `cmd: null` for all four, with a reason in the shipped vocabulary's shape. Accepted — they are
   settings-screen operations and four CLI implementations do not belong in this change. Record
   in the reason string (or a comment beside it) that R2 deliberately admits `cli`-kind sessions
   through the guard, so making them CLI-invocable later is guard-compatible and needs no
   security change — a later lane inherits that door open, not welded.

**Would change my mind on A:** a measured PR5 need for the same object literal discovered before
merge — then the coordinator sequences one of you behind the other, and the ruling's region
constraint already makes the rebase trivial.

## Ruling 13 — C8: SUPPRESS the node's provider key when injecting a member credential (option a)

**The rule:** when `composeEnv` injects a per-identity credential for provider P, it must REMOVE
the node's forwarded key(s) for that provider from the session env: `anthropic` →
`ANTHROPIC_API_KEY`; `openai` → `OPENAI_API_KEY`. An agent environment never carries two
competing credentials for the same provider.

Why, in order of weight:
1. **Silent misattribution is the defect class this build exists to close.** A node key that
   outranks a connected member's identity is D7's laundering one channel over — work billed and
   attributed to the node's key under the member's name, with nothing red anywhere. The honesty
   copy says "your agent runs as you"; suppression is what makes that sentence true rather than
   aspirational.
2. **Determinism by construction, not by vendor precedence.** You measured `auth status` reports
   both and rightly refused to infer which signs requests. With one channel present there is
   nothing to infer — and CLI precedence order is version-scoped behaviour that can change under
   us silently. Never depend on it.
3. It is C5's exact shape and gets C5's exact remedy: the allowlist copies something with higher
   precedence out of the server env; `composeEnv` must handle it explicitly rather than hope the
   unit file keeps it unset.

**Option (b) rejected:** the operational surprise argument inverts — a node that deliberately
runs on an API key expresses that by members not connecting, and for UNCONNECTED members nothing
changes: the node key forwards exactly as today. The "same node, two behaviours by spawner" is
not a surprise, it is the feature's definition, and it goes in the doc so operators read it as
designed.

**Option (c) rejected on its failure edge:** injection already implies an active credential, so
(c) collapses into (a) on the happy path — but its semantics at the edge are wrong. A stale or
broken member credential must fail VISIBLY, attributed to the member ("reconnect your Anthropic
account"), never silently fall back to the node's key. Fallback is the lie again, produced at the
exact moment the member is least able to notice.

Scope notes: `GEMINI_API_KEY`/`GOOGLE_API_KEY` keep forwarding untouched — no admitted provider
(R6); do not generalise the suppression beyond the admitted set. Your placement of injection
AFTER both allowlist loops is correct — keep it. Required tests, both directions: connected
member → provider key ABSENT from the composed env; unconnected member → key present and
byte-identical to today's behaviour; plus your seeded/empty config-dir control pair.

**Would change my mind:** a real deployment needing "member attribution but node-key billing" —
that is an explicit per-node policy flag as a feature, never a silent default.

## Ruling 14 — the credential home stays keyed on `identityId`; the safety is a named constraint, so it gets a canary

**Measured, both source and live DB:** `public.accounts.identity_id` is `text not null UNIQUE` —
`002_identity.sql:47`, and constraint `accounts_identity_id_key` present on the running
`tm8_stable` (`\d public.accounts`). Identity↔account is **1:1 by constraint**, not by
convention. Your scenario (1) — one account, two identities, one index row, two directories — is
unproducible without dropping a named unique constraint. The two keys are the same fact under
two names.

**The convention: `identityId` stands.** Beyond "it is what the login terminal writes today":
`account_id` is a surrogate that CHANGES across account delete/recreate, while `identity_id` is
the stable external name. An identity-keyed directory is re-adopted correctly by the same human's
re-created account; an account-keyed directory orphans on every recreate. PR2's key is not just
shipped, it is right.

**Two obligations so this stays true:**
1. **A canary test**, because the safety rests on one droppable constraint: one real-PG
   assertion that `accounts_identity_id_key` exists (pg_constraint by name), with a comment
   saying the credential home's identity-keying is UNSAFE without it and must be re-keyed to
   `account_id` in the same change that drops it. Put it in your lane's real-PG suite if you
   have one; otherwise it is PR3's, and say so in your report so it does not fall between seats.
2. Your call-site comment stands — extend it to name the constraint explicitly.

**Accepted residue, noted not fixed:** account deletion cascades `account_agent_credentials`
(the index) but nothing deletes the identity-keyed DIRECTORY — a re-created account briefly has
"disconnected" in the index with a stale secret on disk, unreferenced and overwritten at next
login. Injection is index-driven so nothing injects it. R3's `delete` removes files; account
deletion is admin surgery outside Tier B. If Tier C picks up account lifecycle, the directory
sweep belongs there.

**Would change my mind:** multi-identity accounts arriving as a feature — then the home re-keys
to `account_id` in that same change, and the canary is what makes forgetting impossible.

## Ruling 16 — the client learns `sessionKind` from the wire (option A), and the filter lives in the shared read model, proven on the real mounted surfaces

*Asked by PR4 (msg `019fdd71-6e15-7bf2-8bcb-9bb6b1298485`), 2026-08-07. Settles D4's open
mitigation: credential rows appearing in every session list with no read model to filter them.*

**16a — EXPOSE `sessionKind` on the EntityState work_session arm; clients filter. Option B
rejected.**

The rule: add `sessionKind` to the work_session arm of `EntityState`
(contract `schemas.ts:236-244`) as an **optional** string field mirroring the DB values
(`'agent' | 'credential'`), projected from `row.ws_session_kind` in `entity-read.ts:1132-1141`.
Clients treat **absence as `'agent'`** — a frozen server (the :7778 binary) degrades to today's
behaviour, credential terminal visible in lists. That is safe-visible: D4's cost is clutter and
misreading, not secret exposure, so fail-open-to-visible is the correct degradation direction.

Why A and why B is rejected:
1. **B silently changes an existing read for every caller** with no opt-out — the exact
   colliding-change class this repo has been burned by. A read that returns less than it did
   yesterday, with no schema change announcing it, is a lie of omission on the wire.
2. **The owner must be able to reach the terminal they opened.** PR4 itself hosts the login PTY;
   a server-side hard filter forecloses any surface ever showing it. A is strictly more
   expressive: hide, show, or badge are all client renderings of one honest fact; B forecloses
   two of the three permanently.
3. It is one select column + one optional field — a field, not an operation (PR4's measurement
   accepted: catalog count and `CATALOG_DIGEST` unmoved). The `.strict()` schema makes it a real
   contract change; that cost is paid once and is the price of honesty on the wire.

**Filter placement:** once, at the shared derivation layer where work_session rows become list
rows in tm8-ui — not per-surface — so every present and future surface inherits the exclusion.
But the **proof must be a render test on each mounted surface**, not a unit test on the helper:
this codebase has a measured precedent of `rowsFor` accepting and ignoring its filter argument,
so a green helper test can certify a filter no surface applies. The settings screen does NOT
reach the terminal through session lists: it derives connection/terminal state from
`credential_sessions.finished_at`/`expires_at` per R10's residual — never from the credential
work_session's `status`, which can read `running` forever after a crash.

Legacy `packages/ui`: the same field makes the same filter a one-line change at the
`useSessions` consumer. Recommended, not a merge blocker — legacy is the oracle, not the
product.

**16b — build on the REAL mounted surfaces; LiveSessionBar is untouched.**

PR4's measurement is accepted: `LiveSessionBar.tsx` has zero production call sites — it is
itself a §E instance ("MOUNTABLE, NOT MOUNTED"). Adding the filter there changes nothing any
human sees, which is optimizing the task's letter over the system's truth — the same trade R12
declined. Deliverable 3 targets the surfaces humans actually reach from GateApp: the
EntityListPanel sessions panel (`data-kind="work_session"`) and the empty-centre roster. Because
the filter lives in the shared derivation layer, LiveSessionBar inherits it for free on the day
someone mounts it. Do not delete it in this lane; report the dead surface to the coordinator as
inventory.

**Endorsed in passing:** never build the filter on the `execution.liveness` live-set — PR4
measured it as uncataloged with no server route, so a liveness-based filter fails against every
real node. Filter on the session row's own field.

**Required tests, both directions:** (1) a credential-kind session absent from each mounted
surface, asserted on the rendered surface; (2) agent-kind sessions unchanged; (3) a row with NO
`sessionKind` renders (frozen-server degradation); (4) the fixture seam carries the new field —
the seam has a measured history of silently dropping fields it does not know.

**Addendum (PR4 follow-up, same day, measured):** two facts folded in as binding.
1. **The `to_jsonb(ws)` free-publishing claim circulating in the wave is FALSE at the HTTP
   boundary.** 082's header (082:168) says 057's `to_jsonb(ws)` publishes new columns to the
   read models automatically; that is true of the DB function and false of everything a client
   can reach — `entity-read.ts:80` (state arm) is an explicit column list without
   `ws.session_kind`, and `entity-read.ts:1482-1499` (content arm) is a hand projection the
   jsonb never reaches, behind a `.strict()` DTO (schemas.ts:484-491). Nothing is free; the
   field addition is deliberate wherever it goes. Any lane told "PR3 gets sessionKind on the
   read models for free" is building on a false premise.
2. **The inverse-filter law, mandatory under any option:** TypeScript surfaces filter
   `sessionKind !== 'credential'`, NEVER `=== 'agent'`. A row hydrated from a payload predating
   the column has no field; equality would hide REAL agent sessions for anyone holding an older
   payload while passing every fresh-data test. Required test 3 is upgraded to assert the
   asymmetry directly — a row with the key ABSENT must remain VISIBLE — so the inequality
   cannot be "tidied" into an equality later.

**Would change my mind on 16a:** nothing currently — even the plausible future ("show login
terminals with a badge instead of hiding them") is a rendering change A already supports and B
forecloses, which is itself an argument for A. On 16b: someone mounting LiveSessionBar, at
which point it inherits the filter and needs only its own render test.
