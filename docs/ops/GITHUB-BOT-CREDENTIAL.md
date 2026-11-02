# Runbook — put this node's sessions on a shared GitHub bot

**Status: not applied anywhere.** This describes what the code in this PR makes
possible. Turning it on is a deliberate operator action (step 3), and nobody
should take it until the bot account in step 1 exists.

## The problem this solves

On a shared server, every session's GitHub access comes from the auto chain in
`packages/execution/src/spawn/credential-resolution.ts`: the launcher's own
default, then their connected personal login, then the space's credential, then
the machine's ambient `gh`. The first two rungs are personal. On a box where
several people launch sessions that means a session pushes, reads and is
rate-limited as *a specific human* — whichever human connected a login — with
nothing in the session's own view saying whose identity it is holding.

Measured on this node at the time of writing: six per-identity GitHub logins
under `<dataDir>/credentials/id_*/github/hosts.yml`, plus a global
`credential.https://github.com.helper = !gh auth git-credential` in
`/home/tm8/.gitconfig` pointing at `~/.config/gh/hosts.yml`.

## What the change does

Setting one variable in the server's environment **is** the posture:

```
TM8_GITHUB_BOT_CREDENTIAL_FILE=/etc/tm8/github-bot.json
```

With it set, every session and every project clone on this node runs GitHub as
that one bot. The personal and space rungs are not reordered — they are
unreachable, and no personal token is even decrypted. With it unset, behaviour
is exactly as it is today.

If the file is missing, misparsed, or readable beyond its owner, **launches
refuse**. They do not fall back to a personal login; that fallback is the bug
the posture exists to remove.

## 1. Subhang creates the bot account and token

1. Create a GitHub account for the bot (e.g. `tm8-bot`) with its own email and
   2FA. It is a real account; it needs an owner.
2. Invite it to the `subhangR/tm8` repository (and any other repo sessions must
   reach) with the **lowest role that still lets a session work** — `Write` is
   enough to push a branch and open a PR. Do **not** grant `Maintain` or
   `Admin`, and do not add it to a team that carries them.
3. As the bot, create a **fine-grained** personal access token:
   - **Resource owner:** `subhangR`
   - **Repository access:** *Only select repositories* → the repos from step 2.
     Never "All repositories".
   - **Repository permissions:** `Contents: Read and write`,
     `Pull requests: Read and write`, `Metadata: Read-only` (forced).
     Everything else **No access** — in particular no `Administration`, no
     `Actions`, no `Workflows`, no `Environments`, no `Secrets`.
   - **Expiration:** 90 days. Put the renewal in the calendar; an expired token
     refuses launches with a clear message, it does not silently degrade.
4. Confirm the bot **cannot** merge or publish releases. Branch protection on
   `main` requiring a review it cannot give is what enforces that, not the
   token scopes — a `Contents: write` token can push to an unprotected branch.
   Check `Settings → Branches` has protection on `main` before relying on this.

## 2. Put it on the server

As root, in one file, owner-only:

```sh
install -m 600 -o root -g root /dev/null /etc/tm8/github-bot.json
cat > /etc/tm8/github-bot.json <<'EOF'
{"login": "tm8-bot", "token": "<the fine-grained token>"}
EOF
chmod 600 /etc/tm8/github-bot.json
```

The login lives in the same file as the token on purpose: two variables can
disagree about who the bot is, one file cannot. `login` is what commits are
attributed to (`GIT_AUTHOR_NAME`, and
`<login>@users.noreply.github.com`), so it must be the bot's real GitHub login.

The server process must be able to read the file. If tm8-server does not run as
root, `chown` it to that user and keep the mode at `600`.

## 3. Turn it on

Add to `/etc/tm8/prod.env`:

```
TM8_GITHUB_BOT_CREDENTIAL_FILE=/etc/tm8/github-bot.json
```

Then restart tm8-server. **Do this at a quiet moment:** a restart interrupts
live sessions, and sessions started before the change keep their old
environment until they are restarted.

Verify on a *new* session, not an existing one:

```sh
# In a freshly spawned session's terminal:
git config --get-regexp '^credential\.'   # the process-local helper, not ~/.gitconfig's
gh api user --jq .login                   # must print the bot login
```

`gh api user` printing a person's login means the posture is not active for
that session — check the variable reached the server process
(`tr '\0' '\n' < /proc/$(pidof tm8-server)/environ | grep BOT`), and that the
session was started after the restart.

**Rotation needs no restart.** The file is re-read on every spawn: write a new
one with `install -m 600` and the next session picks it up.

## 4. Remove the personal logins — only after step 3 is verified

These are the paths holding personal GitHub credentials on this node. **This PR
deletes none of them**; each line is an action for Subhang, after a new session
has been seen authenticating as the bot.

1. **Per-identity logins** (six at the time of writing):
   `<dataDir>/credentials/id_*/github/hosts.yml`
   Delete these through the UI — *Settings → Connections → GitHub → Disconnect*
   for each person — rather than `rm`, so the encrypted DB row that pairs with
   the file goes too. A file deleted without its row leaves the connection
   showing as present and broken.
2. **The encrypted account rows**: removed by the same Disconnect action
   (`delete_account_git_credential`). Verify with
   *Node admin → Credentials*, which must list no GitHub connection.
3. **The node's own machine login**: `~/.config/gh/hosts.yml` and
   `~/.config/gh/config.yml` for the user tm8-server runs as, plus the
   `credential.https://github.com.helper` and
   `credential.https://gist.github.com.helper` entries in `/home/tm8/.gitconfig`
   and the `credential.helper = store` + `~/.git-credentials` pair.
   Sessions cannot reach these once the posture is on (the spawn environment
   overrides the helper per-process), but a human shelling into the box still
   can, so they are worth removing for their own sake.
4. **Any `GH_TOKEN` / `GITHUB_TOKEN` in a shell profile.** Already absent from
   `/home/tm8/.bashrc` and `/home/tm8/.profile` — verified, 0 matches — but
   check again before declaring this done; an `export` there outranks the
   injected value in an interactive shell.

## 5. Everyone revokes their own old token

Each person whose login was on the server revokes it **at GitHub**, which is
the only step that actually invalidates a token that may have been read while
it was on a shared box:

- Fine-grained tokens: <https://github.com/settings/personal-access-tokens>
- Classic tokens: <https://github.com/settings/tokens>
- OAuth grants made by `gh auth login`:
  <https://github.com/settings/applications> → *GitHub CLI* → Revoke.

Deleting the file on the server does not revoke anything. Treat any token that
sat in `credentials/id_*/github/hosts.yml` as exposed and revoke it, even if
nothing is known to have used it.

## What this posture does not cover

- **PR tracking** still uses `TM8_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN`
  from the server's environment (`packages/server/src/tracking/github.ts`).
  That is a server-side API read, not a session, and this PR leaves it alone.
  Point it at the bot token too if you want one identity everywhere.
- **Link-bound spawns** (a caller from a linked space) already have no personal
  rung and run only on the linked space's own GitHub credential. Unchanged
  here on purpose — see the PR body.
- **Token scope** is enforced at GitHub, not by this code. Nothing in tm8 can
  check what a token can reach; step 1 is what makes it least-privilege.
