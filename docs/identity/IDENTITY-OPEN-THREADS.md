# tm8 — Identity: open threads and unrecorded decisions

**Status:** working notes, 2026-07-31. Captures what came out of the auth/identity investigation and the identity design pass that is **recorded nowhere else** — including one gap in `IDENTITY-DESIGN.md` itself.

**Companions (same directory, read in this order):**
1. `AUTH-AND-IDENTITY-VERIFIED-STATE.md` — what auth/identity actually is in the tree, `file:line`, rev 3
2. `REMOTE-DEEP-REPORT-A.md` / `-B.md` — two independent deep passes on remote
3. `IDENTITY-DESIGN.md` — the proposed identity model (+ `IDENTITY-DESIGN-BRIEF.md`, the brief it answered)

---

## 1. ⚠ The gap in the identity design: *display* identity vs *login* identity

`IDENTITY-DESIGN.md` §6 treats a global identity purely as an **authentication** question — "should Firebase be a login method?" — and correctly recommends deferring it.

**But the user's actual ask was different, and it was not answered.** Verbatim:

> "I want that common identity also, the global identity also should be known. […] whenever we chat and everything, those chat icons, if we want it to come with the Google icon…"

That is not a login requirement. It is an **identification and display** requirement: *when the same human appears on two servers, both should know it is the same human, and show one name and one avatar.*

These are **separable concerns with wildly different costs**, and merging them is what made global identity look expensive:

| | Purpose | Must be unforgeable? | Cost |
|---|---|---|---|
| **Display identity** | "same Alice on both servers" — name, avatar, email | **No** — it is a claim by the hosting server, same as today's cross-node attribution | **Low.** Mostly already built. |
| **Login identity** | prove you are Alice | **Yes** | **High** — see `IDENTITY-DESIGN.md` §6.4 |

**Consequence: a global display identity is achievable without adopting Firebase auth, without amending T-D3, and without a second login path.** The design's own §6.5 argument (the identity model is invariant across login methods) applies here too — and *strengthens* the case for doing the display half now.

### 1.1 What already exists (verified)

`public.user_profiles` (`db/migrations/002_identity.sql:21-28`) is the graph-side profile, keyed by the opaque `identity_id`:

```sql
create table public.user_profiles (
  identity_id  text primary key,
  display_name text,
  avatar       text,     -- ← the slot chat needs
  email        text,
  ...
);
```

It is also the FK target for `spaces.created_by_identity` (`002:33-35`) and has an RLS select policy scoped to co-members (`008:131-137`).

**Measured on the dev database, 2026-07-31:**

```
identity_id                              display_name  avatar  email
id_e6c364a9-108f-40cf-943a-bf8f2fd525e9  Owner         NULL    NULL
```

So: **the table exists, the avatar column exists, and nothing has ever populated it.** The display layer is built and unused.

### 1.2 What is missing

One field — a **global key** on the profile that is stable *across servers*:

```
user_profiles:
  identity_id   id_abc…          ✅ exists — per-server, opaque, immutable
  display_name  Alice            ✅ exists — unpopulated
  avatar        https://…        ✅ exists — unpopulated
  email         …                ✅ exists — unpopulated
  global_id     <issuer:subject> ❌ MISSING — the cross-server link
```

Two servers both recording `global_id = google:12345` know they are describing the same human, with no shared account store and no change to `identity_id`.

**`IDENTITY-DESIGN.md` §6.3 already specifies exactly this pair** — `(issuer, subject)` — but scopes it as a *credential binding* consumed only at login. The correction: **it should also be an identity attribute, readable and displayable, independent of whether that issuer is ever used to log in.**

### 1.3 The git model is the precedent worth copying

```
git config user.email  →  global. stamped on every commit. GitHub renders an avatar from it.
SSH key / PAT          →  per-remote. authentication. entirely separate.
```

Your email appears on commits whether or not you can authenticate anywhere. Display and login are decoupled, and the display half needs no trust infrastructure. **This is the shape the user described**, and it is the same "credential-per-remote, the git-remotes model" tm8 already chose for auth (`02-NODE-AND-GATEWAY.md` §4) — tm8 adopted git's *auth* half and skipped its *identity* half.

### 1.4 The honest limit, which must be stated in any UI

A display identity is **a claim by the server hosting it.** Server B asserting "this member is `google:12345`" is worth exactly what server B is worth. This is not new — `02-NODE-AND-GATEWAY.md` §4 already says cross-node actions are *"attributed but not cryptographically non-repudiable until portable identity (Phase 4)."*

Fine for avatars in chat. **Never** a basis for an authorization decision. Same as `user.email` in git: anyone can set it to yours.

### 1.5 Recommended next step

Feed §1 back into `IDENTITY-DESIGN.md` as a distinct sub-model ("identification" alongside "authentication"), and decide the `global_id` format. Candidates: `issuer:subject` (works with any IdP, incl. Firebase, without adopting it for login), or `user@server` (the Phase-4 portable address, which would make this the first delivered piece of Phase 4 rather than a detour). **The second is likely the cleaner answer** and costs no vendor — but it needs a decision, not an assumption.

---

## 2. Open thread: git commit attribution for agents

Raised, unresolved, recorded nowhere.

**The question:** tm8 spawns agents that write code in real git repos. *Whose name lands on the commit?*

**Verified answer today:** nothing in production sets a git author. The only `user.email` / `user.name` in the tree is in test fixtures (`packages/execution/src/worktree/worktree-manager.test.ts:52,322`). So **an agent commits under the machine's ambient global git config — i.e. as the human who owns the laptop.**

This is the exact same defect class as the in-graph one closed by §4.2 of the identity design (`composeEnv` not exporting `TM8_ACTOR_ID`): the agent *has* a persona, and the artifact it produces does not carry it.

**Why it matters more than it looks:** graph attribution is internal to tm8, but a git commit is **externally visible and permanent** — it lands in a shared repo, in blame, in a PR. If "who is doing what" is the goal, this is the most public place it currently fails.

**Shape of a fix** (not designed — flagging only): the spawn env already carries `TM8_TEAM_MEMBER_ID` (`execution/src/spawn/manifest.ts:498`), and a `team_member` has a `display_name`. Setting `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` (with the human as `GIT_COMMITTER_*`, which is exactly git's own author-vs-committer distinction) would make agent commits self-describing without losing the human's accountability. Interacts with the worktree work (migration 057, `WorktreeManager`).

**Open:** whether agent commits *should* be distinguishable is a product call, not just a technical one. Some teams want it; some want commits to look like the human's. Decide before building.

---

## 3. Corrections this investigation forced on existing docs

Recorded here because the source docs are dated audits that should **not** be rewritten — their bodies were accurate when written. Supersession banners have been added to point here.

| Claim, and where it lives | Status |
|---|---|
| "Server A's bearer token is deliberately NOT forwarded to B" (`REMOTE-STATUS-2026-07-29.md`) | **FALSE for the proxy path.** True of the CLI only. `http/remote-proxy.ts:38-47` forwards `authorization` *and* `cookie`, and strips `Origin`. `cli/src/server-target.ts` explicitly refuses to, with a comment saying why — the repo states the rule in one path and breaks it in another. |
| "Add server is visible but disabled" / "Unavailable remote UI is honest" (same) | **FALSE.** `packages/tm8-ui/src/servers/server-registry.ts` is real and mounted; `AddServerDialog` really POSTs (`:156-177`). An honest-refusal specimen became a working feature and no doc recorded it. |
| "The catalog currently has 106 operations" (same) | **STALE.** Measured 110 / 108 `v1` / 2 reserved. |
| "S9 — low-priv PG role, no service-role bypass" (`10-SECURITY-MODEL.md`) | **NOT SATISFIED.** The server connects as a **superuser with `rolbypassrls`** (`tm8\|tm8\|t\|t`) and `PgDb.tx` never issues `set local role`. Migration 008's RLS is largely inert on the read path. Writes unaffected. See `AUTH-AND-IDENTITY-VERIFIED-STATE.md` §3.2. |
| `PgIdentityRepository` "needs column alignment" (`REMOTE-END-TO-END-DESIGN.md:355`, status doc) | **UNDERSTATED 2–3×.** ~24 defects, 5 classes, 10 of 18 methods. Plus two classes all three docs missed: `008:204-206` gives `accounts`/`auth_sessions` zero RLS policies by design while the repo queries them directly (**needs a new migration**), and token verification is structurally impossible (RPC is hash-keyed and strips `token_hash`). |
| `046:6-8` "strictly enabled including every pre-existing deployment" | **True of the SQL default, false of the server**, which never leaves the setting absent (`http/config.ts` defaults it off). |
| `036:88` implying the `entities.patch` doors are open | **SUPERSEDED** by `038`, which closed all eleven with a different subject expression. |
| Migration count "50" | **48 files**, gaps at 025/026/028. Both prior passes asserted exhaustive coverage of a wrong denominator. |

### 3.1 The meta-lesson, which is the most reusable thing here

**The design docs are the least reliable source in this repo.** They were accurate when written and the tree moved under them. Three separate claims were published as verified during this investigation purely by trusting `REMOTE-STATUS-2026-07-29.md` instead of reading code; all three were wrong.

**Verify anything load-bearing against the tree.** `STATE.md` is separately known-stale. Trace from `packages/server/src/main.ts` rather than grepping for handler names.

---

## 4. Unrecorded findings that belong to authorization, not identity

Parked here so they are not lost; **out of scope** for the identity work, which the user explicitly scoped to "who is doing what," not "who may do what."

- **`internal.ledger_record` has no principal check at all** (`046:95-105`). The entire sec1 program (031–042) hardened `ledger_replay`, the *read* side. The write side's on-conflict path returns the first recorder's result behind an operation-**label** check with no identity comparison, across ~98 call sites, with no tests. **Highest-value outstanding sec1 item.**
- **The sec1 principal guards are vacuous today** — one principal cannot be distinguished from itself. They get their first real test the day bearer auth lands. "031/033 shipped" is not coverage.
- **`require_node_admin` has never refused anyone**, and it is the guard `044`'s `server_connections` RLS *and* both write RPCs depend on.
- **The PTY WebSocket gates on nothing but `?sessionId=`**, answers at any path (query-param discrimination, no pathname check), writes the `101` before the existence check (session-id oracle), and returns byte-identical tokenless URLs for view vs drive.
- **Bearer auth and the PG role downgrade are one change, not two.** A second authenticated principal over a `rolbypassrls` connection reads the whole graph. The full bundle is three things: non-loopback bind, bearer resolution, role downgrade.
