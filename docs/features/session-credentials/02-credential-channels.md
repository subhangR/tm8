# 2 — The credential channels (seven, after review)

> Design document, exported from the tm8 graph at entity `019fdc8d-5326-7eb5-abd9-c8a5ec51399a` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 2 — The four credential channels, and why S15 gives zero user separation

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

## Part 2 — The four credential channels (and why S15 gives zero user separation)

The allowlist is a real control, but it guards a channel that is **not the one the credentials
actually travel on.**

### C1 — Env allowlist (`AUTH_ENV_KEYS`)
Machine-wide values from the server process environment, identical for every member of every
space. Where a node has `ANTHROPIC_API_KEY` set, everyone spends it.
**Per-user-ability: none.** Fixable purely inside `composeEnv`.

### C2 — `HOME` — **the channel that matters**
`HOME=/home/tm8` for every session. Every agent therefore reads:

| path | contents | measured |
|---|---|---|
| `~/.claude/.credentials.json` | `claudeAiOauth`: `accessToken`, `refreshToken`, `expiresAt`, `scopes`, `subscriptionType` | present, 0600, 509 B |
| `~/.claude.json` | Claude config incl. per-project trust | present, 0600, 117 KB |
| `~/.config/gh/hosts.yml` | gh OAuth/PAT for `tharakeshua` | present, 0600 |
| `~/.codex/auth.json` | Codex login | absent on this node |
| `~/.gitconfig`, `~/.ssh` | git identity + keys | shared |

**This is what actually pays for the model and what actually pushes to GitHub.** S15 is
satisfied — no secret is in Postgres — and it buys nothing here, because the secret was never in
env in the first place. It is in a shared home directory.

Note the shape of `.credentials.json`: it holds a **refresh token and an expiry**, and the CLI
rewrites it in place on refresh. Any design that stores this value in a database and injects a
copy will go stale and fight the CLI. **Claude credentials must be a writable per-user
directory, not an injected string.** This is a hard constraint, not a preference.

### C3 — Shell profile — an unaudited bypass of the allowlist
```
/home/tm8/.bashrc:3:export GH_TOKEN='ghp_…'
/home/tm8/.profile:3:export GH_TOKEN='ghp_…'
```
`pty.spawn('/bin/bash', ['-c', cmd])` is non-interactive and non-login, so it does **not** source
these — confirmed: PID 2027909 has no `GH_TOKEN`. But the agent's own tool-use shells do.
Measured inside this session's Bash tool: `GH_TOKEN=ghp_…` is present.

So a credential reaches the agent **one process below the seam that audits it**, and
`session_manifests.env_var_names` never records it. The manifest says the session had no GitHub
credential; the session had one.

> **Operational finding, independent of this design:** a live GitHub PAT is hardcoded in
> `/home/tm8/.profile` and `/home/tm8/.bashrc` in plaintext, readable by every agent on the box and
> now present in this session's transcript. It should be rotated regardless of what is built here.

### C4 — Ambient filesystem
`resolveWorkdir` sends every project session into the same `projects.working_dir`
(`working_dir` is globally UNIQUE, and `public.projects` has no owner column). A repo's
`.git/config` credential helper, `.npmrc`, `.env` etc. are shared by construction.

### C5 — `XDG_CONFIG_HOME`, and it **outranks `HOME`**  *(review, sub-doc 14)*
`SAFE_BASE_ENV_KEYS` copies `XDG_CONFIG_HOME` and `XDG_CACHE_HOME` from the server env
(`manifest.ts:695-708`), and `gh` resolves its config dir as
`GH_CONFIG_DIR` > `$XDG_CONFIG_HOME/gh` > `$HOME/.config/gh`. Measured:
```
$ env -u GH_CONFIG_DIR -u GH_TOKEN XDG_CONFIG_HOME=<empty> gh auth status
You are not logged into any GitHub hosts.
$ env -u GH_CONFIG_DIR -u GH_TOKEN -u XDG_CONFIG_HOME  gh auth status
✓ Logged in to github.com account tharakeshua (/home/tm8/.config/gh/hosts.yml)
```
**A per-identity `HOME` is not sufficient.** Latent today (unset on the prod unit) — one operator
`Environment=` line from silently reverting `gh` isolation with no error anywhere.

### C6 — `~/.git-credentials` + `credential.helper = store`  *(review)*
Live on this box, 0600, holding a token. Neutralised for github.com by the shipped
`GIT_CONFIG_VALUE_0=''` reset, but the reset is **URL-scoped** — so `store` still answers for
gitlab.com, a private host, or an internal mirror.

### C7 — `TM8_AGENT_TOKEN`: the human's **full identity**, not a reduced principal  *(review)*
`issue_agent_auth_session` binds the *spawning human's* account;
`acting_as_team_member_id` constrains `internal.resolve_actor` **only** — `identity_id()`,
`can_act_as`, `is_space_member` and `entity_readable` all key off identity. So once
`credentials.*` exists, an agent holding this token can call it **as its owner**: read status,
delete the stored token, start a login terminal in their name. The distinguisher exists —
`auth_sessions.kind = 'agent'` — and the credential operations must check it.

### Summary
| channel | per-user today | fix cost |
|---|---|---|
| C1 env allowlist | no | low — `composeEnv` |
| C2 `HOME` | no | **medium — the real work** |
| C3 shell profile | no | falls out of C2, once HOME is tm8-owned |
| C5 `XDG_CONFIG_HOME` | no | low — set/clear it in `composeEnv` |
| C6 `.git-credentials` | no | medium — non-GitHub hosts |
| C7 `TM8_AGENT_TOKEN` | n/a | low — check `auth_sessions.kind` |
| C4 project dir | no | high — needs per-user project ownership, out of scope |

---
