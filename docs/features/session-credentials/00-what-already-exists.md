# 0 — What already exists on the deployed line (correction)

> Design document, exported from the tm8 graph at entity `019fdc8d-50ac-71f1-b821-62e46bc2b730` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 0 — What already exists on the deployed line (correction)

*Sub-document of “Design: per-member credential management in sessions”. Measured 2026-08-07
against `/opt/tm8/staging` @ `5f01cc4` and the staging DB (`tm8_staging`, 127.0.0.1:5443).*

> ## ⚠ This corrects sub-docs 3, 7, 9 and 10.
>
> The rest of this design was researched against `origin/main` @ `7631e08`. **The deployed
> staging line already ships a working per-account GitHub credential feature**, and it made the
> opposite storage choice to the one sub-doc 3 recommends. `origin/main` cannot see it: main's
> `077` is a different file (`077_notify_anchor_watchers`), while staging's ledger runs to
> `079_account_git_credentials`. This is exactly the deployed-line-vs-main trap.

> ### ⛔ CORRECTED BY REVIEW (sub-doc 14, D9) — SHIPPED IN CODE, NOT IN OPERATION
>
> `tm8-staging`'s MainPID started **Aug 4 17:06**; **164 dist files post-date it**; and
> `GET /v2/identity/git-credentials` answers `no operation bound`. The running process predates
> its own build, so the router never loaded these operations. `account_git_credentials` being
> empty is consistent with an **unreachable endpoint**, not merely a missing UI.
>
> **Nobody has ever exercised 079 against a running server.** Everything below is therefore a
> *code reading*, not observed behaviour — including the `applyGitCredential` description.
> Restart the staging node onto `5f01cc4` and prove the three `gitCredentials.*` ops answer
> before treating this as shipped.

## What is shipped

**`db/migrations/079_account_git_credentials.sql`** — applied to the staging DB.

```sql
create table public.account_git_credentials (
  id uuid primary key, account_id uuid not null references public.accounts(id) on delete cascade,
  provider text not null check (provider in ('github')),
  login text,                    -- display only: "connected as octocat"
  token_ciphertext bytea not null check (octet_length(token_ciphertext) between 17 and 4096),
  token_nonce      bytea not null check (octet_length(token_nonce) = 12),
  created_at timestamptz, updated_at timestamptz,
  unique (account_id, provider)
);
```

Five controls, and they are stronger than sub-doc 3's `credential_refs` sketch:

1. **AES-256-GCM.** Key is a 32-byte file at `<dataDir>/.git-credential.key`, 0600,
   `O_CREAT|O_EXCL` — same construction as the blob-store grant key. **AAD is
   `<account_id>|<provider>`**, so a ciphertext lifted from one row will not authenticate in
   another account's row.
2. **`tm8_app` cannot select the secret columns.** The grant is COLUMN-LEVEL and omits
   `token_ciphertext`/`token_nonce`. `select *` as the app role raises 42501. Not a policy that
   a future `using (true)` could widen — the privilege does not exist.
3. **RLS pins every row to its owner** — `account_id = internal.current_account_id()`, resolved
   from the transaction identity, never from a client claim. **Deliberately no node-admin
   bypass:** *"an operator administering the node has no business reading a member's GitHub
   identity."*
4. **No insert/update/delete grant at all.** Every mutation goes through SECURITY DEFINER RPCs
   (`set_account_git_credential`, `delete_account_git_credential`) that re-derive the account and
   accept no account parameter.
5. **One narrow decrypt door.** `public.read_account_git_credential` is the only path returning
   ciphertext, returns the caller's own row only, and its single caller is the spawn path.

**Facade** — three v1 operations on `/v2/identity/git-credentials`:
`gitCredentials.set` (POST, upsert, 200 not 201), `.status` (GET), `.delete` (DELETE).
`services/w2/git-credentials.ts` answers HTTP and never has plaintext in scope;
`git-credentials-port.ts` is a **separate file** that is the only decryptor — so *"does any
request handler touch plaintext?"* is answerable by reading imports.

**Spawn injection** — `manifest.ts`, `applyGitCredential`:
```ts
env.GH_TOKEN = env.GITHUB_TOKEN = credential.token;
env.GIT_TERMINAL_PROMPT = '0';
env.GIT_CONFIG_COUNT = '2';
env.GIT_CONFIG_KEY_0 = 'credential.https://github.com.helper'; env.GIT_CONFIG_VALUE_0 = '';   // RESET
env.GIT_CONFIG_KEY_1 = 'credential.https://github.com.helper'; env.GIT_CONFIG_VALUE_1 = HELPER;
env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = credential.login;
env.GIT_AUTHOR_EMAIL = `${credential.login}@users.noreply.github.com`;
```
The helper is a shell function that reads `$GH_TOKEN` **at the moment git asks**, so the config
value itself carries no secret and is safe in `ps`, `git config --list` and `envVarNames`. It
answers only `get` — never `store`/`erase` — so nothing is ever written to disk. The empty
`VALUE_0` is load-bearing: it **resets** git's helper list so a machine-wide helper in
`~/.gitconfig` cannot answer first with somebody else's login.

**Principal** — `forSpawner(auth)` resolves from the **spawning human's claims**, and the port
header gives the same reasoning sub-doc 3 arrives at independently: *"A teammate persona is a
shared object … a credential attached to a persona would be a credential shared by whoever
happened to use it."* Fail-soft: returns `null` on absent/undecryptable/error, so a launch never
dies because someone has not connected GitHub.

## What this settles, and what it does not

| | status |
|---|---|
| Storage A-vs-B (sub-doc 3, decision 1) | **decided — A, encrypted in Postgres.** Already shipped. Sub-doc 3's recommendation of B is superseded for GitHub. |
| Principal = spawning human | **decided and implemented**, same reasoning |
| `GIT_AUTHOR_*` attribution (P6) | **done for GitHub** — closes `IDENTITY-OPEN-THREADS.md` §2 |
| GitHub credential, server + DB | **done** |
| **Any UI** | **NONE.** `grep -rn 'gitCredential' packages/tm8-ui/` → zero hits. The feature is unreachable from the product. |
| Live usage | `account_git_credentials` is **empty** — nobody has connected one |
| Claude / Codex credentials | **not addressed at all** — see below |
| Per-user `HOME` / config dirs | not built |
| Isolation | still one OS uid; 079's own header says so |

## Why the shipped approach does not generalise

It is **env-var injection**, which is the right answer for git and `gh` and the wrong answer for
the other two providers:

- **Claude's credential is a file with a refresh token** (`.credentials.json`: `accessToken`,
  `refreshToken`, `expiresAt`), rewritten in place by the CLI. There is no env var that expresses
  it. A subscription login cannot be reduced to a string tm8 stores.
- **Codex is the same shape** (`auth.json` under `CODEX_HOME`).
- So sub-doc 4's per-identity config dirs are still required — **for Claude and Codex only.**
  GitHub does not need them and should keep the shipped env-var path.

**The conclusion is a split, not a replacement:** encrypted-in-Postgres for
string-shaped secrets (GitHub PATs, API keys), per-identity directories for
file-shaped ones (Claude/Codex OAuth). Two mechanisms, chosen by the shape of the credential,
not by preference.

## One collision to design around

Measured: **`gh` refuses to log in while `GH_TOKEN` is set** —
*"The value of the GH_TOKEN environment variable is being used for authentication. To have GitHub
CLI store credentials instead, first clear the value from the environment."*

The shipped `applyGitCredential` **always** sets `GH_TOKEN`. So a Tier-B credential session that
runs `gh auth login` inside a normal spawn env would silently no-op. A credential session must be
spawned with injection **suppressed**, which is one more reason it cannot be an ordinary
`execution.spawn`.
