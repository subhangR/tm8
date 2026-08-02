# tm8 REMOTE — Report B: verification of, and extension to, `TM8-REMOTE-DEEP-REPORT.md`

**Date:** 2026-07-31 · **Tree:** `/Users/subhang/Desktop/Projects/tm8`, branch `main`, HEAD `765115c`, working tree DIRTY (198 paths).
**Method:** independent read of the tree from `packages/server/src/main.ts`; then a full read of Report A and a targeted re-derivation of its load-bearing claims. Migrations at repo-root `db/migrations/`. `STATE.md` not consulted.
**Relationship to Report A:** Report A is accurate and well-built. I found **no substantive error** in it. This report **confirms** its contested claims from independent evidence, **corrects three factual details**, and **extends** it into six areas it does not cover — one of which, **§1, invalidates a premise both reports were reasoning under** and must be read first.

> ## ⚠ READ §1 FIRST
> **The server connects to Postgres as a superuser with `rolbypassrls`, and `PgDb.tx` never downgrades the role. Row-level security is therefore inert on virtually the whole read path.** Verified by me directly against the live dev database: `select current_user, session_user, rolsuper, rolbypassrls` → **`tm8|tm8|t|t`**. The codebase documents this as a *measured production failure* at `events/control.ts:94-98`. Every RLS-based reasoning step in Report A, in the brief, and in §2–§7 below is conditional on a role downgrade that has not happened.

**Labels:** **EXISTS** = running code reachable from `main()` · **DESIGNED** = doc only · **ABSENT** = grep-verified not present.

---

## 0. CONFIRM / REFUTE / EXTEND — the whole delta in one table

### 0.1 CONFIRMED independently (I re-derived these before reading Report A)

| Report A claim | My independent evidence | Verdict |
|---|---|---|
| `remote-proxy.ts` forwards `Authorization` **and** `Cookie`; the brief's "token not forwarded" is true only of the CLI path | `http/remote-proxy.ts:38-47` — `{...headers}` then four `delete`s (`host`, `origin`, `referer`, `content-length`). No `authorization`, no `cookie`. Contrast `cli/src/server-target.ts:30-32`, which sets `token: undefined` with an explicit comment. | **CONFIRMED** — reached before reading A |
| The proxy is dispatched before identity resolution; the WS upgrade never calls `checkTransport` | `http/server.ts:132-135` (proxy) vs `:179` (`resolveIdentity`); `:105-110` upgrade dispatch, and `checkTransport` appears only at `:129`, inside `handle()`, which the upgrade path never enters | **CONFIRMED** — reached before reading A |
| The UI Server switcher is real and mounted; the brief's "No Connection store in the UI" is FALSE | `tm8-ui/src/servers/server-registry.ts:106-185`; mounted `App.tsx:34-44`; `GateApp.tsx:77-81` sets `serverBaseUrl: activeServer.routeBaseUrl` and rethreads it at `:366,377,395,425` | **CONFIRMED** — reached before reading A |
| Catalog is 110 / 108 v1 / 2 reserved; zero `auth.*`/`gateway.*`/`server.*`/`connection.*` | `catalog.ts` — 110 `{ name:` rows; `search.query` `:103`, `bridge.fetchBlob` `:119`; `OperationStatus` is a closed 2-value union `:18`; `facade/registry.ts:44-47` throws on registering a reserved op | **CONFIRMED** — reached before reading A |
| PTY WS gates on `sessionId` + protocol headers only; `PtyWsServerOptions` has no auth seam | `pty-ws-server.ts:221-238` (four checks, all protocol), `:240-245` (101), `:253` (`onInput → pty.write`), `:66-77` (options: `{pty, logger?, heartbeatMs?, missedPongLimit?}`) | **CONFIRMED** — reached before reading A |
| `PgIdentityRepository` is dead code and R0 is a rewrite, not a rename; `008` grants nothing on `accounts`/`auth_sessions` and `007` has no substitute RPC | Independent column-by-column pass: zero construction sites repo-wide; `008_rls_policies.sql:204-206` + `:213-225`; six direct-table methods with no RPC equivalent | **CONFIRMED** by a separate derivation |

### 0.2 CORRECTED (three factual details; none changes a conclusion)

| # | Report A says | Correct | Why it matters |
|---|---|---|---|
| C1 | "all **50** migrations" (§7) | **48 `.sql` files**, numbered `001`–`051` with **three gaps: `025`, `026`, `028`** | Both A and my own first pass asserted exhaustive coverage of "50". The count is wrong in both. The *conclusions* drawn from the sweep still hold — I re-ran the `alter table` sweep and confirm zero hits — but a claim of exhaustiveness should rest on a correct denominator. |
| C2 | Path D quote: ``openSession('s1', '/v2/server-connections/ec2n')`` produces ``/v2/server-connections/ec2nv2/ws`` (§2) | The actual test is `ptyTransport.test.ts:96-101`: `openSession('s1', '/v2/server-connections/ec2/proxy')` → pathname `/v2/server-connections/ec2/proxy/v2/ws` | A transcription slip (`/proxy` dropped, strings run together). **The substance is right and the finding stands** — but the quoted strings are not in the file, and anyone verifying A by grepping them will find nothing. |
| C3 | Path D is evidenced by a **test** (§2: "`ptyTransport.test.ts` asserts…") | Path D is **production code**, and I have the full chain (§3.1 below) | This is A's weakest-sourced finding and it is actually its strongest. Upgraded from "a test asserts this shape" to "the shipped browser does this." |

### 0.3 EXTENDED — six areas Report A does not cover

| § | Area | One-line finding |
|---|---|---|
| **1** | **The deployed Postgres role is a superuser with `rolbypassrls`** | **RLS is inert on ~25 read sites. Verified live. Invalidates a premise both reports reasoned under, and changes R0 sequencing and the remote threat model.** |
| **2** | `deploy/tm8-server.service` — the VPS exposure question | **RESOLVED CLEAN.** A real systemd unit for a VPS exists and is tracked, but it is an orphan: nothing references it, and there is no proxy, tunnel, or TLS config anywhere in the repo. S1 fails closed if it were. |
| **3.1** | Path D's production chain | The remote-PTY path is not test-only; `LiveTerminal.tsx:395` drives it from the mounted UI. |
| **3.2** | The view/drive finding, sharpened | `execution-handlers.ts:829-831` echoes `mode` from **`input.mode`**, never from the recorded grant row — the returned mode is the *requested* one, not the *granted* one. |
| **4** | The sec1 replay layer (031–042) + migration `046` | The idempotency defaults disagree exactly as reported — **and production is OFF while every test is ON**, because `db/client.ts:168` defaults an absent flag to `'on'` and only `main.ts:95` passes one. |
| **5** | `packages/tm8-ui/src/auth/` — a mounted localStorage-only sign-in gate | A **fifth** surface, absent from A and from all three design docs, carrying a **third** incompatible auth-operation naming. |
| **6** | Design-vs-code divergence, named | The design docs contain **no name for the thing that shipped**. This is the framing that makes every other gap legible. |

### 0.4 REFUTED

**Nothing in Report A.** I attempted to refute its three most load-bearing claims (header forwarding, pre-identity dispatch, the mounted UI switcher) and each survived independent derivation. Its one methodological claim I could **not** verify is flagged honestly in §7.

**One thing of my own, refuted.** An earlier draft of this report posed "does *any* test establish two genuinely distinct `tm8.identity_id` values?" and expected the answer to be no. **It is yes** — four test files do, with explicit anti-vacuity controls (§4.5). I have corrected it in place rather than quietly dropping it, because the shape of the real gap (SQL-layer only, 1 of 11 doors, and `ledger_record` untested because unguarded) is more useful than the alarm I was about to raise.

**One caveat that qualifies a CONFIRMED row above.** The `008`-zero-policies finding in §0.1 is confirmed *as SQL*, but §1 shows it does not currently bite, because the deployed role bypasses RLS. It is a **latent** blocker, not an active one. See §1.3 for the sequencing that follows.

---

## 1. THE FINDING THAT REFRAMES EVERYTHING — RLS is inert on the read path

### 1.1 Verified, three independent ways

**(1) Live database.** I ran the check myself:
```
$ psql postgres://tm8@127.0.0.1:5442/tm8_dev -tAc \
    "select current_user, session_user, rolsuper, rolbypassrls from pg_roles where rolname = current_user"
tm8|tm8|t|t
```
The deployed connection role is a **superuser** with **`rolbypassrls`**.

**(2) The pool never downgrades.** `packages/server/src/db/client.ts:179-207` — `PgDb.tx` issues `begin`, then `BIND_CLAIMS_SQL` (the four GUCs), then the caller's work, then `commit`. **There is no `set local role` anywhere in it.** Repo-wide, `set local role` appears in exactly **three** production sites:

| Site | Role | Scope |
|---|---|---|
| `events/poll.ts:126` | `tm8_app` | the durable event poll |
| `events/control.ts:99` | `tm8_app` | the WS subscribe authorizer |
| `facade/services/w2/execution.ts:448` | `tm8_delivery_worker` | the B2 delivery principal |

**28 files under `packages/server/src` issue direct `from public.*` reads through that pool.** Three downgrade. Twenty-five do not.

**(3) The codebase says so, about a failure that actually happened.** `events/control.ts:94-98`, verbatim:

> *"Drop to `tm8_app` so the RLS derivation above is REAL on the production pool: PgDb binds claims but never sets a role, and **the documented deployment user (`tm8`) is a superuser that BYPASSES row security** — without this line the probe answered the row for every existing space and **this authorizer was allow-all in production**. Same repair as `poll.ts:126` and `services/w2/execution.ts:394`."*

This is not a theoretical gap. It is a **measured production authorization failure**, fixed at one site, with the general case left open.

### 1.2 What it contradicts

- **T-L11** — *"tm8-server runs as a low-privilege PG role"*, *"never table-owner/superuser"*. Violated by the deployed role.
- **S9** — *"low-priv PG role + `SET LOCAL`, no service-role bypass"*. The brief scored S9 **✅ YES**. On this evidence S9 is **NOT enforced**: the `SET LOCAL` half is real, the low-privilege half is not, and `rolbypassrls` is a service-role bypass in all but name.

The claim binding is honest and worth stating precisely: **the claims *are* bound correctly** (`db/client.ts` is the single binder, exactly as the one-identity-path test enforces). It is the **role** that makes those claims unenforced on reads. Write RPCs are unaffected in the same way, because they are `SECURITY DEFINER` and never relied on RLS — `002:293-296` is explicit: *"SECURITY DEFINER bypasses RLS, so an RPC that skips these has no protection whatsoever — they are not belt-and-braces, they ARE the belt."* So **writes are guarded by `require_space_member`/`require_actor`; reads were supposed to be guarded by RLS, and are not.**

### 1.3 Consequence 1 — R0 sequencing: two real findings that bind in different orders

This partly offsets the `PgIdentityRepository` blocker that Report A (§7) and I both found, and it must not be allowed to cancel into "it's fine." Both findings are real; they bind under different roles.

| Defect class | Under `tm8_app` (intended) | Under `tm8` superuser (deployed) |
|---|---|---|
| Wrong column names (`login`, `node_admin`, `password_algo`, `team_member_id`, `issued_at`, `last_seen_at`) | **FAILS** `42703` | **FAILS** `42703` — **unconditional** |
| jsonb-returning RPC read as a record (5 sites) | **FAILS** `42703` | **FAILS** `42703` — **unconditional** |
| `ensure_account` positional scramble + dropped password | **FAILS / silently corrupts** | same — **unconditional** |
| `issue_auth_session` args 4↔5 swapped | **FAILS** `22P02` | same — **unconditional** |
| `purge_auth_sessions` does not exist | **FAILS** `42883` | same — **unconditional** |
| Token verification impossible (id-keyed lookup vs hash-keyed RPC that strips the hash) | **FAILS** | same — **unconditional** |
| **Direct reads of `accounts`/`auth_sessions` (6 methods)** | **FAILS `42501`** — zero policies, no grant (`008:204-206`, `:213-225`); **needs a new migration** | **SUCCEEDS** — `rolbypassrls` bypasses the zero-policy denial and superuser bypasses the missing grant |

**So the correct sequencing statement is:**

1. **Unconditional, fix regardless of role:** every column, argument-order, arity, return-shape, missing-function, and token-verification defect. These are ~18 of the ~24 defects and they fail under both roles. **No sequencing dependency.**
2. **Conditional on the role fix:** the six direct-table reads. They are a **latent** blocker today — the code would *appear to work* on the deployed superuser and would break the day the role is downgraded. **This is the worst possible failure mode:** a repair that tests green now and fails in production later, at exactly the moment someone hardens the database.
3. **Therefore the new migration is still required** — it is just required *before or with* the role downgrade rather than before first execution. Anyone who "fixes" `PgIdentityRepository` on the current superuser and declares it done has shipped a time bomb.

**Net effect on the estimate:** R0 does not get smaller. It gains a dependency — **the role downgrade and the identity repair are coupled**, and the identity repair must be validated under `tm8_app`, not under the deployed role. Add "run the identity tests as `tm8_app`" to R0's exit criteria or the new-migration work will look optional and be skipped.

### 1.4 Consequence 2 — the remote threat model

Every remote path in both reports routes through this same pool. That has a direct consequence for the bearer work:

> **If a bearer resolver lands while the connection is still superuser, authenticating a second principal buys much less than it looks like.** The resolver would correctly bind a different `tm8.identity_id` — and RLS still would not scope that principal's reads, because the role bypasses it. A second authenticated user would read the whole graph.

**Bearer auth and the role downgrade are one change, not two** — precisely the same shape as `loopback.ts:14-18`'s existing claim that loopback-to-bearer and S1 are "one change, not two." There are now **three** things in that bundle: non-loopback bind, bearer resolution, and the role downgrade. Shipping any one without the others produces a system that looks authenticated and is not scoped.

This also sharpens §4 below: the sec1 principal guards are `SECURITY DEFINER` write-path guards and are *unaffected* by the role — so the write path retains its protection while the read path has none. The asymmetry is important and easy to get backwards.

### 1.5 Consequence 3 — fixing it is hazardous in a documented way

The role downgrade **must not be done first**. `db/migrations/035_w2_space_event_seq_member_read.sql:24-49` documents the exact failure mode, and it is worth quoting because it generalizes to every table:

> *"RLS-enabled-with-no-policy denies every row REGARDLESS of the grant. So a grant-only fix does not make the read work. It converts* ***a loud, immediate, unambiguous "permission denied"*** *into* ***a silent zero rows***. *… and `PgDurableSeqSource.latest` documents 0 as 'this space has never had an event' (`seq.ts:130`). The caller cannot tell the two apart. A reconnecting client told the log is at 0 replays a space it is already caught up on. That is a plausible wrong answer where there used to be an honest failure — the dishonest-surface class this codebase removes on sight."*

`035` is a worked precedent for exactly this repair on exactly one table, and its conclusion — *"the grant is therefore necessary and NOT sufficient, and the policy below is the half that makes the grant safe to add"* — is the rule for all of them.

**Required order:**

1. **Audit the policy set first.** For every table read through the pool by the 25 non-downgrading files, confirm a policy exists that admits the intended rows under `tm8_app`. `008:204-206` names six tables deliberately left with zero policies (`accounts`, `auth_sessions`, `command_ledger`, `notification_outbox`, `undo_tokens`, `space_event_seq` — the last already repaired by `035`); the rest must be checked, not assumed.
2. **Add missing policies and grants together**, per `035`'s rule.
3. **Only then downgrade the role** — either by `set local role tm8_app` in `PgDb.tx` (the smallest change, and consistent with the three existing sites) or by deploying as a genuinely low-privilege user.
4. **Prove it.** A test asserting `rolsuper = false and rolbypassrls = false` for the connection role belongs in the harness. Nothing catches this today, which is why it survived.

Doing (3) before (1) converts a live authorization gap into a fleet of silent empty result sets — strictly worse, because the first is loud and the second is a plausible wrong answer.

### 1.6 What still holds — S1

Everything above is survivable only because the socket is unreachable, so this remains the load-bearing control.

**S1 is real.** `http/config.ts:109-115` is `throw new ConfigError(...)`, not a warning. Loopback is an exact-string set `{'127.0.0.1','::1','localhost'}` (`:62,64-66`). `TM8_BIND` appears in `packages/*/src` **only** at `config.ts:102` and in the refusal message `:113`; every other occurrence repo-wide is a doc or a test — and the tests assert the refusal (`packages/server/test/frame.test.ts:86-87`: `'0.0.0.0'` and `'192.168.1.10'` both throw, the second matching `/requires token auth/`). **`.env.example` never mentions `TM8_BIND` at all** — non-loopback binding is not a documented knob.

I **confirm Report A's placement critique** (§3.7): S1 guards `loadConfig`, not `listen()`. `main.ts:77` is `opts.config ?? loadConfig()` and `http/server.ts:220` calls `http.listen(config.port, config.host)` with no re-check, so any in-process caller supplying its own `ServerConfig` bypasses it. A correctly notes the shipped `main()` does not do this. I would add one nuance A does not: `bootstrap()` is **exported** (`main.ts:76`, re-exported at `index.ts:19`), so `bootstrap({config})` is a public API of the package, not merely a test affordance. The fix is one line at the listen, and it should be taken.

**Everything else in both reports is survivable only because S1 holds.** That is why §2 mattered so much.

---

## 2. EXTEND — `deploy/tm8-server.service`: chased hard, closes safely

This was flagged as the one place "remote is absent by design" could be **false in practice**. It is not — but the reason is contingent, not structural, and it deserves to be written down.

### 2.1 The unit is real, tracked, and brand new

`deploy/tm8-server.service` (21 lines), tracked, landed in **HEAD `765115c`** (`git log -- deploy/` returns exactly one commit). Alongside it: `deploy/runtime-package.json` (12 lines, 5 runtime deps).

```
[Service]
User=ubuntu · Group=ubuntu                                  :9-10
WorkingDirectory=/home/ubuntu/tm8-workspace                 :11
EnvironmentFile=/etc/tm8/tm8.env                            :12
ExecStart=/usr/bin/node /opt/tm8/current/packages/server/dist/index.js   :13
Restart=on-failure · RestartSec=3                           :14-15
UMask=0077                                                  :18
WantedBy=multi-user.target                                  :21
```

This is unambiguously a **Linux VPS** unit (`User=ubuntu`, `/opt`, `multi-user.target`, `Requires=postgresql.service` at `:5` — a *system* Postgres, not the R15 sidecar).

### 2.2 It is an orphan — verified five ways

| Check | Result |
|---|---|
| Any script, doc, or workflow referencing `deploy/`, `/opt/tm8`, `/etc/tm8/tm8.env`, `tm8-workspace`, `systemctl`, or `tm8-server.service` | **ZERO** hits in `*.md`, `*.mjs`, `*.sh`, `*.json`, `*.ts`, `*.yml` outside `node_modules`. (The only textual matches are an unrelated UI-design doc using "tm8-workspace" to name a *UI view*.) |
| Deployment automation in CI | **ABSENT.** `.github/workflows/` contains one file, `ci.yml`; grep for `deploy\|ssh\|scp\|rsync\|ec2\|vps\|systemctl\|production` → **zero** hits. |
| An install/provision script | **ABSENT.** `scripts/` is `dev.mjs`, `doctor.mjs`, `start.mjs`, `repair-node-pty.sh`, `smoke-loop.mjs`, `lib/`. `scripts/start.mjs` is a **local** prod launcher — it prints `open http://localhost:${env.TM8_PORT}` (`:106`) and never touches `TM8_BIND`. |
| `docs/ops/CONFIG.md`'s Ops-owned file map (§7, `:207-231`) | **Does not list `deploy/` at all.** The map enumerates 11 paths; `deploy/` is not among them. `grep -rn "deploy" docs/ops/ .env.example` → **zero** hits. |
| The `ExecStart` target in-repo | `packages/server/dist/index.js` exists **locally** but `git ls-files packages/server/dist` is **empty** — `dist/` is not committed. The unit's target must be built on the box. |

**Conclusion: nobody is running it from anything in this repo.** It is a build artifact of the HEAD commit ("addititons"), not a live deployment. Whether a VPS exists outside the repo is **unknowable from here** and I will not guess.

### 2.3 Why S1 makes this fail closed — and the exact residual

The exposure question has three branches, and all three are safe *or* out-of-repo:

1. **`/etc/tm8/tm8.env` sets `TM8_BIND` non-loopback.** → `loadConfig` throws (`config.ts:109-115`) → `main()` catches, logs, sets `process.exitCode = 1` (`main.ts:379-385`) → process exits → `Restart=on-failure` (`:14`) → **crash loop**. Loud, and the socket never opens. **Fails closed.**
2. **`TM8_BIND` unset.** → binds `127.0.0.1:4610` on the VPS. Not reachable from the internet. Safe *at the bind*.
3. **A same-box reverse proxy or an SSH tunnel in front of it.** → **this is the live risk, and the analysis is exactly right:** every request arrives on loopback and resolves through `main.ts:288-293` to the node owner. There is no Host check (`security.ts:53-56`), no Origin check (`:58-61`), no CSRF check (`:63-70`), and no bearer path. **Anyone who reaches that proxy *is* the node owner** — and, compounding, gets the four remote paths, the SSRF primitive, and terminal read+write on the box.

**But branch 3 is not built.** Grep across `*.md`, `*.sh`, `*.conf`, `*.service`, `*.yml`, `*.yaml`, `*.mjs`, `*.ts` for `nginx|caddy|traefik|certbot|letsencrypt|reverse.?proxy|ssh -L|ssh tunnel|autossh|cloudflared|tailscale|ngrok|proxy_pass|listen 443` returns **no tm8 configuration**. The only hits are in `docs/history/collab-v2/ENTITY-GRAPH-DESIGN.md:100` and `docs/history/collab-v2/api-design/04-COMMUNICATION-MODEL.md:128` — **maestro/collab-v2 material for a different product**, discussing Supabase and Tailscale. Not tm8.

### 2.4 The honest finding, stated at its true severity

> **`deploy/tm8-server.service` is a loaded gun with no trigger built and no documentation telling anyone where the trigger would go.** The unit exists and is tracked. The exposure path (a reverse proxy or tunnel in front of a loopback-bound tm8) is *not in the repo*, *not in CI*, and *not in `docs/ops/`*. S1 makes the direct branch fail closed and loud. So this is **not currently a shipped vulnerability** — it is a **latent one, one nginx `proxy_pass` away**, with nothing in the repo that would warn the operator who writes it.
>
> The specific, actionable gap: **`docs/ops/CONFIG.md` does not mention `deploy/` at all**, so the one document an operator would read before standing this up says nothing about the fact that a proxy in front of tm8 hands every visitor node-owner authority. That warning should exist before the unit does.

**Downgraded from "highest-severity finding" to "highest-severity *latent* finding."** I want to be precise rather than dramatic: the mechanism is real, the consequence would be total, and the trigger is absent.

**Independently corroborated.** A separate inventory of `deploy/`, `scripts/`, `tools/`, `.github/`, and `docs/ops/` plus a wide keyword sweep reached the same conclusion: no reverse proxy, no nginx/caddy/traefik, no TLS, no tunnel/ngrok/cloudflared, no runbook, no service account, no key material, and no script anywhere setting `TM8_BIND`. It additionally found that `tools/ci/migrations-check.sh:79-86` is an **armed T-D3 grep** that fails the build on `supabase|firebase|service_role` under `db/migrations/`. **Thread closed.**

One thing §1 changes about this section: the third branch (a reverse proxy in front of a loopback bind) is **worse than I wrote above**. It is not only that every visitor becomes the node owner — it is that the node owner's reads are not RLS-scoped either, because of the role. The two findings compound.

### 2.5 Two stale statements in `docs/ops/CONFIG.md` found on the way

- `:191` — *"`.github/workflows/ci.yml` is written and ready for the day tm8 gains a remote."* **A git remote exists**: `origin → https://github.com/subhangR/tm8.git`. Whether CI has ever run is not verifiable from the tree.
- `:227-228` — *"`db/migrations/` is empty until W1, so today the script announces itself as a passing placeholder."* There are **48 migrations**. The Ops doc predates the entire database.

---

## 3. EXTEND / SHARPEN — two corrections to Report A's own findings, in its favour

### 3.1 Path D is production, not a test — the full chain

Report A evidences remote-PTY only from `ptyTransport.test.ts` and garbles the strings (§0.2 C2). The production chain is complete and I traced it end to end:

```
tm8-ui/src/App.tsx:35            const registry = useServerRegistry()
  → App.tsx:38-39                <GateApp key={registry.activeServer.id} activeServer={registry.activeServer}>
  → GateApp.tsx:77               const activeServer = props.activeServer ?? LOCAL_SERVER
  → GateApp.tsx:80               useGateData({ serverBaseUrl: activeServer.routeBaseUrl })
  → GateApp.tsx:366,377,395,425  serverBaseUrl={activeServer.routeBaseUrl}
  → LiveTerminal.tsx:101,120     prop  serverBaseUrl?: string  (default '')
  → LiveTerminal.tsx:395         ptyTransport.openSession(sessionId, serverBaseUrl)
  → ptyTransport.ts:443          _serverBaseUrls.set(id, serverBaseUrl.replace(/\/$/, ''))
  → ptyTransport.ts:192-193      `${proto}//${window.location.host}${serverBaseUrl}/v2/ws?sessionId=${…}&offset=${offset}`
```

with `routeBaseUrl(name)` = `` `/v2/server-connections/${encodeURIComponent(name)}/proxy` `` (`server-registry.ts:39-41`).

**So the shipped browser, on selecting a remote Server, opens a bidirectional terminal socket to that Server through an unauthenticated proxy, using a `sessionId` as the only credential.** `ptyTransport.test.ts:96-101` and `:104-110` pin this shape (including across reconnect). This is the single most consequential *runtime* fact in either report, and it deserves to be sourced from production code rather than a test.

### 3.2 View-vs-drive is not just decorative — the returned mode is the *requested* one

Report A says the two modes "produce byte-identical URLs." True, and there is a sharper point one line further down.

`facade/execution-handlers.ts:825-831`:
```ts
const grant = (granted.grant ?? {}) as { expires_at?: string; mode?: string };
return json({
  workSessionId: sessionId,
  url: `/v2/ws?sessionId=${encodeURIComponent(sessionId)}`,   // :828 — no token
  protocol: 'ws',
  mode: input.mode,                                           // :830 — from the INPUT
  ...(grant.expires_at ? { expiresAt: … } : {}),              // :831 — from the ROW
});
```

`grant.mode` is **destructured and then never read**. The response's `mode` is echoed straight back from `input.mode` — the mode the caller *asked for*, not the mode the database *recorded*. `expiresAt` is correctly taken from the row; `mode` is not. So even a client that faithfully honours the returned `mode` is honouring its own request. Combined with `p_token_hash = null` (`:383`) and the tokenless URL (`:828`), **view-vs-drive has no representation anywhere between the RPC parameter and the socket.**

This strengthens Report A's §6.3 and the design's §2.6 MUST-FIX sizing: the fix must thread the *recorded* grant (mode **and** token) from the row to both the response and the upgrade handler, not merely add a token.

---

## 4. EXTEND — the sec1 replay layer (031–042) and migration `046`

Absent from Report A entirely. This is the second half of tm8's authorization story: it is not about *who you are*, it is about **the command-ledger replay short-circuiting authorization**.

### 4.1 The `046` default disagreement — CONFIRMED, with a twist neither pass caught

`db/migrations/046_idempotency_test_mode.sql` replaces `ledger_replay`, `ledger_record`, `require_replay_principal`, and `require_replay_subject` wholesale — so **046 is the current text, not 031/033.** (This is why the forward-only discipline matters: `db/migrate.mjs` checksums applied migrations and hard-fails on drift, so the vulnerable original text is deliberately left byte-identical in `007`/`016`/`029`. Reading those files gives you the *vulnerable* version.)

**The database default is strictly enabled.** `046:17-26`:
```sql
select case lower(coalesce(nullif(current_setting('tm8.idempotency_enabled', true), ''), 'on'))
  when '0' then false  when 'false' then false  when 'off' then false  else true end
```
An unset GUC coalesces to `'on'`. The header comment says so explicitly (`046:7-8`): *"The default is strictly enabled, including for direct psql use and every pre-existing deployment."*

**The server default is off.** `http/config.ts:143` → `envBoolean(env.TM8_IDEMPOTENCY_ENABLED, 'TM8_IDEMPOTENCY_ENABLED', false)`.

**CONFIRMED: the two defaults disagree, in the direction reported.**

**The twist — production is OFF and every test is ON.** The pool sets the GUC at `db/client.ts:168`:
```ts
options: `-c tm8.idempotency_enabled=${options.idempotencyEnabled === false ? 'off' : 'on'}`
```
Note `=== false`, strictly. So an **absent** option yields `'on'`. And `createDb` has exactly **one production caller** — `main.ts:95`, which passes an explicit `config.idempotencyEnabled === true` (always a boolean, so always `off` by default). **Every other `createDb` call in the repo is a test that passes no options at all**: `test/facade/contract-shapes.test.ts:54`, `test/facade/loop.test.ts:33`, `test/db/claims.test.ts:24,72,93`, `test/db/loopback.test.ts:19`.

> **So the replay path is dormant in production and live in the test suite.** That is the inverse of the usual arrangement, and it has a specific consequence: **the tests exercising these RPCs run in the mode production does not use.** It is good that the class is covered at all — but "the tests pass" is evidence about the enabled mode, and "production is safe" is a claim about the disabled one. They are not the same claim.

**Precise verdict on the class:** through a default-configured `tm8-server` the replay path is **dormant** — `ledger_replay` returns `null` before touching the ledger (`046:45-48`), and `require_replay_principal` / `require_replay_subject` return early too (`046:114-118`, `:140-142`). It is **live** for direct `psql`, for anything setting `TM8_IDEMPOTENCY_ENABLED=true`, for any `createDb` call that omits the option, and for any deployment predating `046`. **"Dormant class," not "shipped vulnerability" — confirmed, with the caveats named.**

### 4.2 Why this changes R0's risk picture, not just its size

Two structural facts about this layer bear directly on the bearer-auth work:

**(a) The principal pin is vacuous today — and structurally incapable besides.** **VERIFIED**, quoted verbatim from `036_w2_sec1_stage2_entities_create_resource_binding.sql:38-44`:

> *"Both existing guards behave exactly as designed. `entities.create` is not one of 032's seven sites, so it has no resource binding at all. **033's pin is PRINCIPAL-only and PASSES here, because Phase-1 runs a single loopback identity so attacker and victim are the same account BY CONSTRUCTION** — and 033 structurally cannot supply the resource half, because `ledger_replay` never sees the addressed resource."*

Two distinct limitations, and the second is the more serious. The pin is **vacuous** (one principal, so `ledger_row.identity_id <> caller_identity` at `046:65-67` compares an identity to itself and the failing branch has never executed) **and** it is **structurally incapable of ever supplying the resource half**, because `ledger_replay` is not passed the addressed resource at all. Bearer auth fixes the first. **It does not fix the second** — resource confusion is a separate defect class that fails for a *single* principal too, which is exactly why `032`/`036`/`038`/`041` had to bind resources at each call site rather than inside `ledger_replay`.

**The R0 consequence: "031/033 already shipped" is not coverage.** The principal half gets its first real exercise on the day a second principal exists; the resource half is only as complete as the set of call sites explicitly bound so far.

**(b) Any replay guard must be written per-label, not per-function.** **VERIFIED**, `036:10-22`:

> *"…every function sharing an operation label is a DOOR onto the same ledger rows, and a guard written at one door does nothing at any other. … `'entities.create'` has ELEVEN doors, and all eleven are granted to `tm8_app`. … **BINDING ONE DOOR WOULD HAVE BEEN WORSE THAN BINDING NONE.** The acceptance test … drives one door. Bind that door alone and XG03 GOES GREEN [while the defect stays open through the other ten]. … That is why all eleven are here."*

All eleven are named at `036:49-60`: `create_task`, `create_document`, `create_channel`, `create_collection`, `create_team_member` (superseding `007_rpc_catalog.sql:907, 990, 1051, 1104, 1198`), plus `create_file_entity`, `create_spell_entity`, `create_skill_entity`, `create_pull_request_entity`, `create_commit_entity`, `create_custom_entity` (superseding `017_w2_entities_commands_tracking.sql:62, 85, 107, 129, 156, 184`).

**A fact not in the brief:** `036:88` records that **`entities.patch` is also ELEVEN doors, all granted** — so the door-multiplication is not unique to `create`. Any future guard written against a label must enumerate that label's doors from the applied chain first.

### 4.3 Per-guard classification, after the systematic pass

The sweep over 031–046 is now done. Every function below was checked for later supersession across the whole chain.

**(a) VACUOUS TODAY at the HTTP boundary** — cannot fail with one principal:
- The in-`ledger_replay` principal pin (`046:64-71`).
- `internal.require_replay_principal` (`046:127`) — and **doubly** so. `038:38-45` says it itself: *"The two `internal.require_replay_principal` calls per door are REDUNDANT on this chain and are here deliberately… The per-site calls therefore add no protection today."* (Kept as a fallback if 046's in-lock pin is ever weakened — both statements are true.)
- `internal.require_node_admin` (`002:319`) — the loopback auto-owner has `is_owner = true`, so the refusal branch never fires. **This is the guard `044`'s `server_connections` RLS and RPCs rest on.**
- `internal.can_act_as` (`002:254`) — vacuous on its *identity* limb only.

**(b) LIVE TODAY** — fails for a single principal:
- **`internal.require_replay_subject` (`046:143`)** — the resource binding. The only guard in the family with real single-principal failing-branch coverage. Bound at **42 sites**: 031 (6), 032 (7), 036 (13), 037 (1), 038 (11), 041 (1), 050 (3).
- The operation-label check (`046:73-77`).
- `internal.require_delivery_principal` (`039:70`) — discriminates on `session_user`, so it is independent of principal count **and not gated by `idempotency_enabled`**.
- `can_act_as`'s *space* limb — `034`'s defect refused a Space's own owner, single-principal.

**(c) STRUCTURALLY INCOMPLETE:**
- `require_replay_subject` at every site, by necessity — `ledger_replay` cannot see the addressed resource (§4.2a), so binding is per-call-site. `041:15-19` puts the population at **98 live `ledger_replay` callers across 63 operation labels with 16 label collisions**, and notes the enumeration doc is itself short by one site (`record_execution_command`, whose label is a *parameter*, not a literal). **42 of 98 are bound.**

### 4.4 The finding nobody has bound: `ledger_record`'s conflict path

**`internal.ledger_record` (`046:82-107`) has no principal comparison at all.**

```sql
insert into public.command_ledger(client_mutation_id, identity_id, actor_id, operation, result)
values (p_cmid, internal.identity_id(), internal.actor_id(), p_operation, p_result)
on conflict (client_mutation_id) do update
  set result = coalesce(command_ledger.result, excluded.result)     -- 046:97-98
returning operation, result into stored_operation, stored_result;
```

The recorder's `identity_id` is written **only on first insert**. On conflict, a second principal colliding on a `clientMutationId` receives `coalesce(command_ledger.result, excluded.result)` — **the first recorder's stored result** — with only the operation-label check (`046:101`) in the way, and that check does not compare identities.

**All of 031–042's work went into `ledger_replay`. `ledger_record` was never bound.** That is a cross-principal disclosure path at ~98 sites, and it is the single most important thing in this section for the bearer work.

### 4.5 Test coverage against a second principal — the premise is PARTLY WRONG

I posed this as an open question in an earlier draft and expected the answer to be "no test anywhere." **That was wrong, and the correction matters.**

**Four test files establish genuinely distinct `tm8.identity_id` values and drive cross-principal replay**, by `set_config('tm8.identity_id', …)` on a direct PG connection — which is how they get a second principal on a single-loopback-owner platform:

| File | Identities | Drives |
|---|---|---|
| `server/test/db/w2-sec1b-ledger-replay-principal-pin.pg.test.ts` | `w2-sec1b-owner` :208 / `w2-sec1b-rival` :209 | **`create_task`** (:292-295) — door #1 of eleven — plus a two-connection TOCTOU race polling `pg_locks` to prove the attacker is genuinely parked on the victim's advisory lock (:81-104) |
| `server/test/db/w2-sec1-replay-principal-resource-binding.pg.test.ts` | **five** identities :131-139 | 031's six sites |
| `server/test/db/w2-sec1-032-replay-resource-binding.pg.test.ts` | owner / rival :53-54 | 032's invite/message/project sites |
| `server/test/db/w2-null-principal-ledger.pg.test.ts` | owner / rival :81-82 | null-identity ledger cases |

Three of them carry an explicit **anti-vacuity control** that asserts the two identities really are bound and really are distinct *before* trusting any refusal (`w2-sec1b:437-455`, `032:198-212`, `null-principal:290-305`). The control's own words: *"If the harness bound no identity… a cross-principal negative would pass because the comparison never had operands."* That is exactly the right instinct, and it is implemented. **Credit where due — this is better than I expected and better than the brief implies.**

**The gap, stated precisely.** The principal pin *has* been executed in its failing branch against a real second principal — but only:
- at the **SQL layer**, never through HTTP or a bearer path;
- at **1 of 11** `entities.create` doors (`create_task` only) and **0 of 11** `entities.patch` doors;
- against **`ledger_replay`'s** pin, never against **`ledger_record`'s** conflict path (§4.4), where no guard exists to test.

Notably, `server/test/db/w2-sec1-036-entities-create-resource-binding.pg.test.ts` drives **all eleven** `entities.create` doors — but with **one identity** (`OWNER`, :49). Its control (:203) asserts *"two genuinely distinct **Spaces**"* — Spaces, not principals. Excellent coverage **of the resource half only**.

**So when bearer auth lands, the guards never exercised against a real second principal are:** the pin at ten of eleven `create` doors, all eleven `patch` doors, both `036` repairs, `041`'s `record_execution_command`, `050`'s three sites — and `ledger_record`'s conflict path at every site.

### 4.6 Two corrections and a tooling trap

- **`036:88-94` is superseded.** It says `'entities.patch'` "is also ELEVEN doors… deliberately *NOT* here." **`038` closed that gap**, binding all eleven with a *different* subject expression — `{entity,id}` against each door's own first argument rather than `{entity,space_id}`, because none of those eleven takes a `p_space_id` (`038:20-35`). Anyone reading `036` alone will conclude the patch doors are open. They are not.
- **`046`'s own header is the doc that is wrong.** `046:6-8` claims *"The default is strictly enabled, including for direct psql use and every pre-existing deployment."* That is true of the **SQL** default (`046:20`) and **false of the server**, which never leaves the setting absent — `db/client.ts:168` always sends an explicit `off` or `on`. Also new: when idempotency is disabled the HTTP layer **overwrites the caller's `clientMutationId` with a fresh `randomUUID()`** before validation (`http/server.ts:187` → `http/idempotency.ts:23-33`), so a client's id never reaches the ledger at all.
- **Tooling trap for anyone grepping this chain:** `038` and `040` are the only migration files with **UPPERCASE** SQL definitions (12 occurrences). A case-sensitive keyword sweep silently misses **exactly the eleven `entities.patch` doors**. Use `grep -i`. Both the earlier passes on this chain and my own first sweep were case-sensitive.

### 4.7 What this section changes for R0

1. **`require_replay_subject` is the only guard here with real coverage**, and `046:140-142` **disables it too** when idempotency is off — so the one live guard is off in production alongside the vacuous ones.
2. **`ledger_record` needs a principal guard that nobody has written** (§4.4), per-label across ~98 sites.
3. **Any new guard must be per-label, not per-function** (§4.2b), and the label's doors must be enumerated from the applied chain — `036:14` says its own count was *"Measured from `pg_catalog` on the applied chain, not read off the files."* Mine was derived from the files (and matched at 11); the live-catalog check is the authoritative one.
4. **`require_node_admin` being vacuous is a remote finding, not just a sec1 one** — it is the guard `044`'s `server_connections` RLS and both write RPCs depend on (`044:34, 59, 101`). Combined with §1, the node-admin gate on remote-connection management is enforced by a check that has never refused anyone, over a role that bypasses the policy anyway.

---

## 5. EXTEND — a fifth surface: the mounted localStorage-only auth gate

Absent from Report A and from all three design docs. `packages/tm8-ui/src/auth/` — 23 files — is **mounted**: `App.tsx:28` wraps the entire application in `<AuthGate>`.

**What it is.** A complete browser-local account system. `session.ts` implements `createLocalAccount(name, password)` (`:226-268`), `signInLocal(handle, password)` (`:270-292`), `signOutLocal()` (`:302-311`), storing accounts and sessions in `localStorage` under `tm8ui.auth.accounts` / `tm8ui.auth.session` (`:45-49`).

**It is unusually honest about itself.** `session.ts:5-12`, verbatim: *"THIS IS NOT A SECURITY BOUNDARY, and every consumer of this file should read that sentence before the code… an account created through this gate exists in ONE browser's localStorage and nowhere else, and anyone with access to this browser profile can read and replace it."* And `:14-17`: *"The gate exists anyway, because the alternative the order forbids is worse: a login form that accepts a password and reports success against a server that never saw it."*

**The crypto is real, for a stated reason.** PBKDF2-SHA256, 210 000 iterations (OWASP's 2023 floor, cited as such at `:51-56`), 16-byte random salt (`:239-243`), parameters persisted on the record so a future raise can re-derive (`:53-55`), refusal rather than a quiet downgrade when `crypto.subtle` is absent (`:241,246`). Rationale at `:19-26`: *"people reuse passwords. A plaintext password sitting in localStorage is a hazard to the person's OTHER accounts, which is not ours to create."* It also implements the same account-enumeration defence the server's `UNMATCHABLE_VERIFIER` does — one failure for both limbs, deriving anyway on the miss (`:276-285`).

**Why it belongs in a remote report — three reasons.**

1. **It is a third, incompatible auth-operation naming.** `reasons.ts:42-47` declares `MISSING_AUTH_OPS = ['auth.signup', 'auth.login', 'auth.logout', 'auth.session.get']`. The design doc names `auth.login`, `auth.exchangeGatewayToken`, `auth.refresh`, `auth.revoke`, `auth.sessions.list` (`REMOTE-END-TO-END-DESIGN.md:120-125`). **The two sets overlap on `auth.login` alone.** `auth.signup` / `auth.logout` / `auth.session.get` exist only in the UI's ask; `auth.exchangeGatewayToken` / `refresh` / `revoke` / `sessions.list` exist only in the design. Whoever ratifies the contract amendment must reconcile two independent asks that no document acknowledges are in conflict.

2. **The package contradicts itself about whether remote exists.** `reasons.ts:119-122` (`CONNECT_ENDPOINT`) reads: *"remote servers arrive in Phase 2 (D13); no endpoint-resolve operation exists in the contract catalog."* Its sibling directory, `servers/server-registry.ts:156-177`, adds and selects remote Servers **for real**. Two halves of one package, shipped together, disagreeing on the central fact.

3. **It is a sign-in-shaped surface in front of a server that authenticates nobody**, sitting above a switcher that reaches other machines' terminals. The file says this plainly and the gap ledger is under test (`auth.test.tsx` asserts no reason says "coming soon"). That is the right way to ship a gap — but the gap is now larger than the ledger describes.

---

## 6. EXTEND — the framing: the design has no name for what shipped

Report A's §8 identifies the tension ("endpoint names and wire shapes… landed in implementation, ahead of the freeze this doc requires"). I want to state the structural version, because it explains every other divergence in both reports.

`REMOTE-END-TO-END-DESIGN.md` models exactly two remote topologies (`PHASE-2-…:62-102`, design `:44-52`):

- **Direct Connection** — client → Server. Client-side `ConnectionRecord`, `authRef` into a keychain, bearer from `auth.login`.
- **Gateway Connection** — client → Gateway → hosted Server. Gateway relays only; hosted Servers stay loopback-bound; token exchange via HMAC-signed subject.

**What shipped is neither.** It is a *server-side, same-origin, node-admin-registered reverse proxy*: the client never talks to B; A holds graph data (so A is not a gateway under T-D6/§2.1); there is no Connection record, no `authRef`, no exchange, no bearer. The design's §7.1 anti-pattern list (`:678-688`) — eight concrete tells that a PR has drifted off the boundary — **does not foreclose it, because it did not imagine it.** Greps for `server_connections`, `serverConnections`, `remote-proxy`, and `/proxy` across all three remote docs return **zero** hits.

This is why the header-forwarding and Origin-stripping findings are unmentioned anywhere: **there is no section of any design document that this code belongs to.** Ratification cannot be a yes/no on the design as written; it has to first decide whether the shipped proxy is a third sanctioned topology, a temporary scaffold to be removed, or a defect. Until that is decided, every §11 checklist item is being scored against a design the running code does not implement.

Two consequences worth naming:

- **The proxy bypasses the `reserved` boundary.** `bridge.fetchBlob` is reserved and structurally un-implementable (`catalog.ts:119`; `facade/registry.ts:44-47` throws). But B's real `files.download` is reachable through the proxy's generic `/v2/*` allowlist (`remote-proxy.ts:32`), unauthenticated. The reserved slot guards a door that has been left open next to it.
- **The one negotiation that exists contradicts the one that is designed.** `cli/src/commands/server.ts:59-65` requires `health.contractVersion === CONTRACT_VERSION` **exactly**; the design specifies major-version-only compatibility (`:65`, "Minor/patch differences are always accepted"). Shipped behaviour is stricter than designed behaviour, and neither doc records the shipped rule.

---

## 7. What I did not verify

Stated so nothing here reads as more settled than it is.

- **No tests were run.** The status doc's "contract suite 40/43" is unverified in either direction, by me or by Report A. In particular, the four cross-principal `.pg.test.ts` files in §4.5 were **read, not executed** — I confirm they contain two bound identities and an anti-vacuity control; I did not confirm they currently pass.
- **The disabled-idempotency path is untested.** Every `.pg.test.ts` in §4.5 leaves the GUC unset, so all of them exercise the **enabled** path. The **disabled** path — the one the shipped server runs — is covered only by three `loadConfig` assertions in `server/test/idempotency-mode.test.ts`. No test drives an RPC end-to-end with `tm8.idempotency_enabled=off`. **UNVERIFIED.**
- **§1's blast radius is bounded by inspection, not by execution.** I verified the role is superuser, that `PgDb.tx` never downgrades, and that 25 of 28 direct-read files run without a downgrade. I did **not** enumerate which specific reads would return extra rows under the current role — that requires a live per-table policy audit, which is step 1 of §1.5's sequence.
- **`036:14` claims its eleven-door count was measured from `pg_catalog` on the applied chain.** My count (11) was derived from the migration files and matches, but a file-derived count is the weaker evidence. The live-catalog check is authoritative and was not re-run.
- **No live server was exercised.** All HTTP-layer security properties are read from code. (The one live query I did run is the `pg_roles` check in §1.1.) Specifically, the SSRF and DNS-rebinding consequences that follow from `schemas.ts:816-830` (any http(s) origin accepted, no host allowlist) + `remote-proxy.ts:97-104` (full response piped back) + `security.ts:53-56` (Host check is `return ALLOWED`) are **analytic conclusions, not demonstrated exploits.**
- **Report A's §3.5 empirical URL probing** (dot-segment normalisation, `%2e` survival) I did **not** reproduce. I have no reason to doubt it and no independent evidence for it. Treat it as A's finding, not as jointly confirmed.
- **§4's remaining sec1 question is open, not answered** — the per-guard VACUOUS/LIVE classification across 031–042, and whether any test anywhere exercises two distinct `tm8.identity_id` values. `036` and `046` themselves are quoted directly from the files; the systematic sweep is not done. See §4.3.
- **Whether a VPS is actually running** `deploy/tm8-server.service`, and what `/etc/tm8/tm8.env` contains, are **outside the repo and unknowable from here.** §2 establishes only that nothing in the repo stands it up.
- **The dirty working tree** (198 paths) means committed state may differ; every line reference is against the files on disk at 2026-07-31.
- **`packages/ui`** (the older UI) was not re-traced. All UI findings in this report are against **`packages/tm8-ui`**.
- **Method-count discrepancy:** Report A says `PgIdentityRepository` has 18 methods (10 defective, 8 clean); my independent pass counted 19 (12 defective, 7 clean). The **classification agrees** on every method either pass names, and both reach the same conclusion — a rewrite plus a new migration. I did not adjudicate the off-by-one and it does not affect the sizing.

---

## 8. Recommended reading order for whoever acts on this

1. **§1** — first, and before any other planning. It invalidates a premise both reports were reasoning under, it couples the role downgrade to the bearer work, and its repair has a mandatory ordering (§1.5) that is easy to get backwards and expensive to get wrong.
2. **Report A §7 + this report §0.2 + §1.3** — R0's real size, and which half of it is unconditional versus latent-until-the-role-is-fixed.
3. **§4.4** — `ledger_record`'s conflict path has no principal guard at ~98 sites and nobody has written one. This is the largest unbound thing found in either report.
4. **Report A §3.3–3.4 + this report §3.2** — the three shipped auth properties that become live violations the day R0 lands: header forwarding, Origin stripping, and mode-echoing.
5. **§6** — because the ratification decision blocks the proxy fixes, and it is a decision nobody has been asked to make yet.
6. **§2** — before anyone stands up `deploy/tm8-server.service`, and before `docs/ops/CONFIG.md` is next edited. Closed as clean; keep it closed.

**If only one thing is done:** add a harness assertion that the connection role has `rolsuper = false` and `rolbypassrls = false`. Nothing in the tree catches this today, which is why a measured production authorization failure was fixed at one site and left open at twenty-five.

---

## 9. Two closed threads, recorded so nobody reopens them

- **Firebase / Supabase in tm8: ABSENT and actively policed.** The only repo-wide hits are forbidden-pattern regexes in `packages/ui/src/collab-v2/__tests__/foundation/seam-purity.test.ts:18-19`, plus the armed T-D3 grep at `tools/ci/migrations-check.sh:79-86` that fails the build on `supabase|firebase|service_role` under `db/migrations/`. T-D3 is enforced, not merely asserted.
- **`docs/history/collab-v2/crib-supabase/` — hygiene note, not an incident.** It contains an insecure-bypass SQL file shipping `enabled = true` (anon SELECT on 21 tables, EXECUTE on 27 write RPCs) and names real Firebase/Supabase project identifiers. It is **inert in tm8** — reference material for a different product, never applied, and excluded from the migration chain. The repository is private. Worth removing or redacting on general principle; **not** a finding, and it should not be reported as one.
