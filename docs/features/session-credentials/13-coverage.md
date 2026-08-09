# 13 — Coverage: what Tier B solves, and what it does not

> Design document, exported from the tm8 graph at entity `019fdc8d-600b-75b0-9957-70e4e1d20735` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 13 — Coverage: what Tier B solves, and what it does not

*Measured 2026-08-07. Answers “does this solve everything for Claude, git and Codex — login,
storage, reuse, tracking?” Read sub-docs 0 and 11 first.*

---

## A. Two decisions taken (2026-08-07)

### A1. The discriminator is `credential_provider`, and it is orthogonal to `mode`

`mode` (`worker` / `coordinator` / `coordinated-*`) **is untouched**. It keeps its meaning, its
CHECK, its resolution chain and its defaults, and it applies everywhere exactly as it does today.
The new column is a **separate axis** layered on top — no special-casing, no widening, no edit to
any `asAgentMode()` call site.

```sql
alter table public.work_sessions
  add column credential_provider text
    check (credential_provider is null
           or credential_provider in ('anthropic','openai','github'));
```

- **NULL = an ordinary agent session.** Every existing row and every existing insert path is
  unchanged, and there is no value to backfill — a nullable column is even less invasive than a
  defaulted one. **This part of the claim was verified by review and holds.**

> ## ⛔ CORRECTED BY REVIEW (sub-doc 14). “No impact on current implementation” was FALSE.
>
> The **column** is fine and `mode` is genuinely untouched. But the claim is about the **row**, and
> a credential row is structurally a `work_sessions` row. Only three predicates ever narrow the
> session set anywhere in the tree — `status`, `node_id`, `deleted_at`. So a credential row touches
> four existing things:
>
> 1. **D3 — it burns a spawn slot.** `internal.live_work_session_count` has no other predicate and
>    callers pass `null`, so the cap is **node-wide across all spaces**. Fixing it means editing a
>    function that gates every spawn on the box. (This also inverts §11 A6: a separate credential
>    cap stops agents starving logins, not the reverse.)
> 2. **D4 — there is no read model to put the filter in.** `grep -c work_session 003_read_model.sql`
>    → **0**; `select … from information_schema.views where table_schema='public'` → **empty**.
>    Session listing is TypeScript `collections.query`. The filter must be added in ≥7 places:
>    `registry.ts` `SESSION_TIERS`, `useGateData.ts` boot hydration, the **legacy `packages/ui`
>    screens (no status filter at all)**, `space_kind_counts` (rail badge **and** unseen badge),
>    `projector.ts` (fans out to every subscriber), `liveness.ts`. And `057`'s `to_jsonb(ws)`
>    **auto-publishes the new column** through `entities.get` with no code change.
> 3. **D5 — `reconcileNodeGhosts` force-exits it** if it carries a `node_id`. Leave `node_id` NULL
>    by construction; note the cap counter does *not* filter on `node_id`, so that does not fix D3.
> 4. **D8 — an interaction-profile pin is unavoidable** (`ensure_core_interaction_pin` fires on
>    every insert).
>
> **The honest statement is: “no backfill and no insert-path edit” — which is true — and NOT “no
> impact on current implementation”, which is not.**
- **Non-NULL = a login terminal for that provider.** One column carries both the discriminator
  and the provider, so no side table is needed to say which provider a session is for.
- Session listings need `where credential_provider is null`. ~~Set it in the read model, not per
  surface.~~ **There is no read model** (D4) — it must be added at each of the ≥7 sites listed
  above, and PR4 carries that scope explicitly.

**Why not `agent_provider`.** `work_sessions.agent_tool` already exists and already means the
provider of the *agent* (`claude-code` / `codex`). A column called `agent_provider` sitting beside
it would be read as a refinement of that, which is the opposite of what it is. `credential_provider`
says what it is: the provider this session exists to authenticate against.

### A2. Per-identity `HOME` on one OS user is accepted for now

Confirmed as the shipping posture. Decision 3 in sub-doc 10 is **closed**: T0 ships, with the
honesty copy in the UI (another member's agent can read these files; an agent can write its own
`.bashrc`). T1 remains the seam, not the milestone.

---

## B. Coverage matrix

| | login | storage | reuse | tracking |
|---|---|---|---|---|
| **GitHub** | ✅ | ✅ | ✅ *(after the `.bashrc` fix)* | ✅ commits attributed |
| **Claude** | ⚠ flow unverified | ✅ | ✅ | ⚠ identity only |
| **Codex** | ⚠ flow unverified | ⚠ isolation unverified | ✅ | ⚠ identity only |

**Login, storage and reuse are solved in design for all three.** Tracking is solved for *identity*
and not for *spend*. The ⚠ marks are measurement gaps, not design gaps — each is named in §C.

### GitHub — the most complete leg

`gh auth token` **extracts the token from `hosts.yml`** (measured: returns the token from a
populated `GH_CONFIG_DIR`, and `no oauth token found for github.com` from an empty one). So Tier B's
finish step should run it and call the already-shipped `set_account_git_credential`.

**That resolves an ambiguity that would otherwise be a bug:** with both a `hosts.yml` and an
encrypted row, `applyGitCredential` sets `GH_TOKEN`, and `gh` prefers the env var over the file —
so the two sources would silently disagree. Extracting at finish makes **Postgres the single
source of truth** and the file a byproduct. One credential, one path, one thing to revoke.

### Claude — storage and reuse measured, login flow not

`CLAUDE_CONFIG_DIR` isolation is measured and exact (sub-doc 4): it *replaces* `~/.claude`, and
`CLAUDE_CONFIG_DIR` alone decides — `HOME` does not leak the credential back in.

### Codex — `CODEX_HOME` is read, differential isolation not proven

`codex login status` echoes `codex_home: AbsolutePathBuf(<our dir>)`, so the variable is honoured.
But both the isolated and default dirs report `Not logged in` on this node, so there is **no
positive control** — nobody is logged into Codex here. Prove it on a node that has a Codex login
before relying on it.

**Hard constraint discovered:** `CODEX_HOME` must not be under `/tmp` —
*"Refusing to create helper binaries under temporary dir."* `<dataDir>` is fine; test fixtures
using a temp dir will hit this.

---

## C. What is genuinely still open

### C1. Measurement gaps — **three closed, one is an ops dependency**

> **UPDATE 2026-08-07 (sub-doc 15).** Gap 1 is closed by direct PTY measurement and gap 3 is
> largely closed by a static read of the CLI bundle. Of the original four, only **#4 (Codex
> positive control)** remains, and it is not a measurement — it needs a node where somebody is
> logged into Codex.

Review closed #2 in ~5 minutes: `codex login --device-auth` renders headlessly with no TTY and
prints *"Open this link … https://auth.openai.com/codex/device … Enter this one-time code (expires
in 15 minutes)"*; `codex login status` outputs `Not logged in` / `codex_home: AbsolutePathBuf(<dir>)`.
It also found that an isolated `CLAUDE_CONFIG_DIR` returns `email: null, orgId: null` — those come
from `.claude.json`, a **different file** from `.credentials.json` — so the finish step must
tolerate null identity fields or the card renders "Connected as (null)".

**Re-scoped:** #3 (concurrent refresh) is **not hours** — it needs two live sessions of one
authenticated account racing a real token expiry. Plan a day, or accept the risk with a
retry-on-corrupt-read. #4 (Codex positive control) is **not a measurement at all** — it needs a node
where somebody is logged into Codex. Move it to C2 beside the OAuth App as an ops dependency.

1. ~~**`claude setup-token` vs `claude auth login`**~~ — **CLOSED 2026-08-07, sub-doc 15.** They
   render fine under a real `pty.fork()`; "no live stdin" was a harness limitation, not a CLI one.
   Both write the *same* files and differ in **scope**: `setup-token` = `user:inference` only,
   `auth login` = six scopes including `org:create_api_key`. **`setup-token` is the choice**
   (least privilege), at the structural cost that its scopes exclude `user:profile`, so the Claude
   card can never show an email. The fixed command table is now final for `anthropic`.
   Two traps came with it: a populated `CLAUDE_CONFIG_DIR` is **not** a success signal (both verbs
   write `.claude.json` before authenticating), and `setup-token`'s URL is an OSC 8 hyperlink whose
   visible label is hard-wrapped — parse the link target, not the rendered text.
2. **`codex login --device-auth` screen copy** — same, and `codex login status` output shape for
   the verification probe.
3. **Concurrent refresh — LARGELY CLOSED 2026-08-07, sub-doc 15 §D.** The CLI bundle carries a
   dedicated OAuth refresh lock (`.oauth_refresh.lock`, `stale: 60000`, `update: 5000`, with an
   `onCompromised` handler) acquired around the refresh path, so the CLI **already serialises
   concurrent refreshes per config directory**, across processes on one filesystem — the tm8
   single-node case exactly. Two sessions of one identity sharing a per-identity
   `CLAUDE_CONFIG_DIR` is the supported case; two different identities never contend. Residual
   risk is only the 60s stale window (a session stalled mid-refresh can have its lock broken).
   Keep retry-on-corrupt-read as belt-and-braces; **drop the planned day of work.**
   *Evidentiary class: static read of a compiled bundle, not a runtime observation.*
4. **Codex isolation** — needs a positive control (§B).

### C2. Design gaps — real, out of the current plan
5. **git over SSH, and non-GitHub hosts. [SEVERITY RAISED by review]** Not merely "gets nothing":
   `~/.git-credentials` + an unscoped `credential.helper = store` is live on this box, and the
   shipped helper reset is **URL-scoped to github.com** — so other hosts silently get the
   machine-wide credential. `applyGitCredential`'s helper is scoped to
   `https://github.com`, and the provider CHECK admits only `'github'`. An agent cloning
   `git@github.com:…`, or anything on GitLab/Bitbucket/a private host, gets nothing. Per-identity
   SSH keys (`GIT_SSH_COMMAND -i …`) are sketched in sub-doc 4 and not planned.
6. **Spend and quota tracking.** Nothing records which account a session *consumed*, only which
   identity it acted as. There is no per-user usage view, no rate-limit surface, and no way to
   answer "why did my Claude limit run out". The manifest records `credentialPolicy`; it does not
   record spend.
7. **Model access vs subscription tier.** A persona can request Opus while the launching human's
   plan does not include it. Nothing checks this, and the failure appears as an opaque agent
   error at boot.
8. **Revocation does not stop running sessions. [SEVERITY RAISED by review]** Combined with D1, a
   Disconnect button leaves the secret live in a process env **and** leaves the terminal that
   captured it drivable by other members. Review would make Disconnect terminate that identity's
   live sessions rather than defer it. Deleting a credential stops the next spawn; a
   live session already holds the secret in its process environment. Unavoidable at T0, and it
   must be said in the UI rather than implied away by a Disconnect button.
9. **Sub-agent inheritance** — a child session inheriting its parent's credential principal is
   designed (sub-doc 3) and not built.
10. **Tier A** still needs a registered tm8 GitHub OAuth App. Lead time, not build time.

### C3. Explicitly out of scope
MCP server credentials; npm/pip/cargo registry tokens; Docker registry logins; cloud provider
credentials (AWS/GCP). Each is a real per-user secret an agent may need, and each is a separate
provider entry once the registry in sub-doc 11 exists. Naming them here so their absence is a
decision rather than an oversight.

---

## C4. Added by review — not gaps, but design additions

- **C7: an agent holding `TM8_AGENT_TOKEN` can call `credentials.*` as its owner.** Decision 8
  ("human-initiated only") has no mechanism today. `auth_sessions.kind = 'agent'` is the
  distinguisher and the credential operations must check it.
- **C5: `XDG_CONFIG_HOME` outranks `HOME`** for `gh`, so `composeEnv` must set or clear it.

---

## D. The honest one-paragraph answer

**Yes for login, storage and reuse, on all three providers — that is what the plan delivers, and
the mechanisms are measured rather than assumed.** Tracking is solved only for *identity*: commits
and graph actions carry the right human, but nothing tracks spend, quota, or which plan a session
burned. Four measurement gaps (§C1) must close before the command table can be finalised, and they
are hours of work, not days. Two gaps would surprise people if left unsaid: **git over SSH and
non-GitHub hosts are not covered at all**, and **revoking a credential does not stop a session
already running on it**.
