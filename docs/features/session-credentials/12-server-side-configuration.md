# 12 — Server-side configuration required before collaborative tm8

> Design document, exported from the tm8 graph at entity `019fdc8d-5ef0-76d5-a29c-781b38b052ff` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 12 — Server-side configuration required before collaborative tm8

*Measured 2026-08-07 on tm8-server against `/opt/tm8/staging` @ `5f01cc4`, `/opt/tm8/prod`,
`tm8_staging` (5443) and `tm8_prod` (5442).*

These are things an **operator** must do. None of them is code, and every one of them will
silently break per-user credentials if skipped.

---

## BLOCKING — per-user credentials are wrong or unsafe without these

### 1. Remove the machine-wide `GH_TOKEN` from the shell profiles, and rotate the PAT

**This currently defeats the shipped feature outright.** Measured:

```
/home/tm8/.bashrc:3:export GH_TOKEN='ghp_…'
/home/tm8/.profile:3:export GH_TOKEN='ghp_…'

$ GH_TOKEN='INJECTED-PER-USER-TOKEN' bash -ic 'echo $GH_TOKEN'   → ghp_…   ← profile WINS
$ GH_TOKEN='INJECTED-PER-USER-TOKEN' bash -lc 'echo $GH_TOKEN'   → ghp_…   ← profile WINS
$ GH_TOKEN='INJECTED-PER-USER-TOKEN' bash -c  'echo $GH_TOKEN'   → INJECTED-PER-USER-TOKEN
```

`applyGitCredential` injects the user's token into the PTY env, and the PTY's own
`bash -c` keeps it. But an agent runs `git` and `gh` through its **own tool shells**, which are
interactive or login shells — and those source `.bashrc`/`.profile`, which **overwrite** the
injected value. So every `gh`/`git` call an agent makes uses the machine-wide PAT, attributed to
whoever owns that token, while the graph records the launching human.

This is invisible from the outside: the feature reports success, the session shows the right
`login`, and the push lands under the wrong account.

> **SHARPENED BY REVIEW (sub-doc 14, D7).** The consequence is worse than "the wrong token is
> used". `TM8_GIT_LOGIN` is **not** exported by `.bashrc` but `GH_TOKEN` **is**, so in an
> interactive shell the shipped credential helper answers a **mismatched pair**:
> ```
> $ …GH_TOKEN=TM8-INJECTED TM8_GIT_LOGIN=per-user-login … bash -ic 'git credential fill'
> username=per-user-login
> password=<machine-wide PAT from .bashrc>     ← wrong secret, right name
> $ …same under bash -c:
> password=TM8-INJECTED                        ← correct
> ```
> GitHub ignores the username for token auth, so the push **authenticates as the PAT owner** while
> the username, `GIT_AUTHOR_NAME`, `GIT_COMMITTER_NAME` and the tm8 graph all say the per-user
> identity. The helper **launders** the machine PAT under the connected user's name, with no local
> signal of the mismatch. Removing the two `export` lines is the fix;
the token must also be rotated, since it has been in plaintext on a multi-agent box.

**Add the regression test in sub-doc 11 §F.6 — it fails on this box today.**

### 2. Deploy the credential feature to the node that will run it — **and restart it**

> **ADDED BY REVIEW (sub-doc 14, D9).** Migrated is not deployed. `tm8-staging`'s MainPID started
> **Aug 4 17:06**, **164 dist files post-date it**, and
> `GET /v2/identity/git-credentials` → `no operation bound`. The running process predates its own
> build, so the router never loaded these operations, and **079 has never been exercised against a
> running server**. Restart the staging node onto `5f01cc4` and prove the three `gitCredentials.*`
> ops answer before treating the feature as shipped.


| node | role downgrade (RLS real) | `078_private_projects` / `079_account_git_credentials` |
|---|---|---|
| staging (5443) | ✅ | ✅ applied |
| **prod (5442)** | ✅ | ❌ **ledger tops out at `075_shared_teammate_authority`** |

Prod has the RLS fix but **not** the credential feature. "Collaborative tm8" on prod needs the
deploy first — and the migration-number collision trap applies (`origin/main`'s `077` is a
different file from staging's; `migrate.mjs` hard-fails on duplicate prefixes before applying
anything).

### 3. Provision accounts and memberships

`auth.signup` is node-admin gated **by design** (F1 — never open self-registration), so this is
the operator's act. Without it a second human logs in and sees nothing: RLS is real now, and a
non-member reads zero rows. The working sequence is `docs/identity/PROVISION-SECOND-ACCOUNT.md`:

```sh
tm8 auth signup bob --password '…' --display-name 'Bob Example'   # operator, node admin
tm8 space invite create <space-id> --max-uses 1                    # operator, space admin
tm8 auth login bob --password '…' && tm8 space invite redeem <code>  # AS BOB — binds membership
```

Trap from that doc, and it bites here: **tm8-spawned shells are agents, not humans.** Acting as a
human from one needs `env -u TM8_AGENT_TOKEN -u TM8_SESSION_ID -u TM8_TEAM_MEMBER_ID tm8 …`.

### 4. ~~Decide what loopback auto-owner means once credentials exist~~ → **ADVISORY**

> **CORRECTED BY REVIEW (sub-doc 14).** This is **already mitigated on the deployed node**.
> `TM8_DISABLE_AUTO_OWNER=1` is in the prod unit environment, confirmed behaviourally:
> `curl http://127.0.0.1:17777/v2/spaces` → **401**, and the unauthenticated WS upgrade → **401**
> on both prod (17777) and staging (8887). The premise below — "any process that can reach loopback
> acts as the node owner" — is **false as deployed**.
>
> **Reduced to:** verify the flag is set on every node, and pin it in the unit file so a future
> unit edit cannot silently drop it.

### 4. (original text, superseded) What loopback auto-owner would mean

v1 auto-authenticates the owner on loopback (T-L7). With per-user credentials in the graph, that
means **any process that can reach loopback acts as the node owner** — and can therefore read the
owner's credential status, replace the owner's stored token, and spawn sessions that spend it.
The blast radius is one account, but on a box that runs many agents as one OS user, "any local
process" includes every agent.

This is a policy decision, not a bug report, and it must be made explicitly before a second human
is invited: either keep auto-owner and accept that the owner's credentials are reachable by
anything local, or require a bearer token on every request path.

### 5. The credential key file is a backup dependency

`<dataDir>/.git-credential.key` — 32 random bytes, 0600, `O_CREAT|O_EXCL`, created on first use.

- **Lose it and every stored credential is unrecoverable.** 079's port logs the undecryptable
  case; users must re-enter tokens.
- **Never put it in the same backup artifact as the DB dump.** That reunites key and ciphertext
  and undoes the entire point of encrypting at rest.
- It must be backed up *somewhere*, separately, or the encryption is a one-way function.

### 6. Data-dir permissions

`<dataDir>` at 0700, and the new `<dataDir>/credentials/` tree likewise. Note `mkdir({mode})`
does **not** repair an existing 0755 directory — SpawnService's `ensurePrivateDirectory` +
`chmod` pattern exists for exactly that, and the credential home must reuse it rather than assume
a fresh install.

---

## IMPORTANT — wrong behaviour, not unsafe behaviour

### 7. Caps

`TM8_SESSION_CAP` — **measured 30 on the deployed prod unit**, not the documented default of 8 (`tr '\0' '\n' < /proc/1483979/environ | grep SESSION_CAP`); the starvation arithmetic is different at 30 — and the new `TM8_CREDENTIAL_SESSION_CAP` (default 2).
Sizing them together matters: a credential session holds a PTY, and if it drew from the agent cap
a busy node could never connect an account.

### 8. Backup policy for the credential directory

`<dataDir>/credentials/` holds Claude and Codex OAuth files in **plaintext** — they are the
vendor CLIs' own files and cannot be encrypted without breaking refresh-in-place. S18 pairs
`pg_dump` with a blob-dir snapshot; this tree must be **excluded**, or "backups are secret-free
by construction" stops being true through a door S15 does not guard.

### 9. Agent binaries must be present and consistent

`claude`, `codex`, `gh` must resolve for every session. On this box all three are global
(`/usr/lib/node_modules/…`, `/usr/bin/codex`, `/home/tm8/.local/bin/gh`) — note the third is
under the **server's** `HOME`, which is why sub-doc 4 requires binary discovery to keep using the
server's `HOME` while the agent's `HOME` moves.

### 10. Clock and TTLs

A credential session's TTL must be **shorter than the provider's device-code lifetime**, so an
abandoned terminal dies before its code does. Device codes are typically 10–15 minutes.

### 11. `TM8_AUTO_TRUST_WORKSPACE`

Workspace-trust writes land in `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. Once those become per-identity,
every user needs their own trust entry for a shared project directory — so the first session each
user runs in a project will seed it. `SpawnService` currently passes `this.env` (the *server's*
env) to `trustClaudeWorkspace`; that must become the composed env or trust rows land in the wrong
home and every session hits the unattended trust dialog (sub-doc 4).

---

## ADVISORY

### 12. Network binding stays as it is

nginx terminates TLS with a Tailscale cert and binds **loopback + `100.112.76.32` only** — the
listen addresses are the security control. The nginx config explicitly warns against adding a
`0.0.0.0` listener or reopening 7777/8888 on the cloud firewall. Nothing in this design changes
that, and nothing in this design should be taken as permission to.

### 13. Decide the per-space `credentialPolicy` default

`own` (fail-closed) / `node-fallback` (today's behaviour) / `space-shared`. Recommend
`node-fallback` so nothing breaks the day it ships, with the resolved policy shown in the spawn
dialog and recorded in the manifest.

---

## The one-line summary

**Post-review the blocking list is: (1) the `GH_TOKEN` profile fix, (2) deploy **and restart** the
node, (3) provision accounts, (5) the credential key backup, (6) permissions — with (4) downgraded
to advisory. Two items were added by review: the staging restart (D9), and explicit XDG handling in
`composeEnv` (C5), since `XDG_CONFIG_HOME` outranks `HOME` for `gh`.**

**Of those, exactly one is an active defect rather than a setup step: the
`GH_TOKEN` export in `/home/tm8/.bashrc` and `/home/tm8/.profile` silently overrides the
per-account token that the already-shipped feature injects.** Fix that first — it is two deleted
lines and a token rotation, and until it is done, no amount of per-user credential work changes
which account an agent actually pushes as.
