# 7 — UI: login flows and the three integration tiers

> Design document, exported from the tm8 graph at entity `019fdc8d-593a-7d15-9c5a-a76d7e2d06dc` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 7 — UI — login flows and the three integration tiers

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

## 6.1 The constraint that decides the whole design

Every provider offers two kinds of OAuth flow, and **only one of them works when the agent runs
on a server and the browser is somewhere else.**

**Loopback-callback flow — BROKEN here.** Measured, `codex login` with no flags:
```
Starting local login server on http://localhost:1455.
If your browser did not open, navigate to this URL to authenticate:
https://auth.openai.com/oauth/authorize?…&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&…
On a remote or headless machine? Use `codex login --device-auth` instead.
```
The redirect targets `localhost:1455` **on the machine running codex**. tm8's UI is reached over
Tailscale/nginx from a laptop, where `localhost` is the laptop. The callback lands nowhere. The
CLI says so itself, in its own last line.

**Device / paste-back flow — WORKS.** The user gets a short code, opens the provider's URL on
*their own* machine, and the server polls for the result. No inbound callback, no port, no
tunnel. This is the only flow tm8 can build on, for every provider.

> **Design rule:** tm8 never uses a loopback-callback flow. `codex login` must always carry
> `--device-auth`. This is not a preference — the default flow cannot complete on this topology.

## 6.2 What each provider actually supports (measured)

| | Native tm8 device flow | PTY-driven CLI login | Paste a key (fully programmatic) |
|---|---|---|---|
| **GitHub** | ✅ — GitHub's device flow is public and documented. **Needs a registered tm8 OAuth App `client_id`, which does not exist today.** | ✅ `gh auth login --web` (interactive TUI) | ✅ `gh auth login --with-token` reads **stdin** |
| **Anthropic / Claude Code** | ❌ — no public device-flow client; the Claude Code OAuth client is Anthropic's own | ✅ `claude setup-token` (long-lived, needs a subscription); `claude auth login` / `logout` / `status` | ✅ `ANTHROPIC_API_KEY`, or `apiKeyHelper` via `--settings` |
| **OpenAI / Codex** | ❌ — same reason | ✅ `codex login --device-auth` | ✅ `codex login --with-api-key` reads **stdin**; also `--with-access-token` |

Two more measured facts that constrain the build:

- **`gh` refuses to log in while `GH_TOKEN` is set.** Verbatim:
  *"The value of the GH_TOKEN environment variable is being used for authentication. To have
  GitHub CLI store credentials instead, first clear the value from the environment."*
  → **A credential-onboarding session must be spawned with a scrubbed environment.** Env-var
  injection and file-based login are mutually exclusive for gh; the design must pick one *per
  provider per user* and record which, or onboarding silently no-ops.
- **`claude --bare` sets `CLAUDE_CODE_SIMPLE=1`, where auth is strictly `ANTHROPIC_API_KEY` or
  `apiKeyHelper` — "OAuth and keychain are never read."** That is a documented, supported
  injection point that needs no files in the agent's home at all (see §6.6).

*Not measured:* the exact on-screen text of `codex login --device-auth` and `claude setup-token`.
Both are full-screen TUIs that render nothing without a live stdin, and I did not drive them
interactively. Their existence and purpose are confirmed from the CLIs' own help/output; the
screen copy needs one manual pass before P5 ships.

## 6.3 The three integration tiers

Ship all three. They are not alternatives — they are a fallback chain, and each provider enters
at a different rung.

### Tier A — Native device flow (best UX; GitHub only, today)
tm8's server runs the device flow itself. No terminal, no CLI.

```
UI: [Connect GitHub]
  → POST /v2/credentials/github/deviceStart
      server → POST https://github.com/login/device/code {client_id, scope}
      ← {device_code, user_code, verification_uri, interval, expires_in}
  → UI renders:  ┌──────────────────────────────┐
                 │  Code:  ABCD-1234    [Copy]  │
                 │  [ Open github.com/login/device ]  │
                 │  Waiting…  (expires in 14:32)      │
                 └──────────────────────────────┘
  → server polls POST https://github.com/login/oauth/access_token
      grant_type=urn:ietf:params:oauth:grant-type:device_code
      (honours `interval`, `authorization_pending`, `slow_down`, `expired_token`)
  ← access_token
  → write <dataDir>/credentials/<identityId>/gh/hosts.yml (0600)
     + insert credential_refs row (metadata only — no value)
  → UI flips to: ✓ Connected as @octocat · repo, read:org, gist · [Disconnect]
```
`device_code` is a secret and **never reaches the browser** — only `user_code` and
`verification_uri` do. Poll state lives server-side, keyed by identity, with a hard expiry.

**Prerequisite, and it is a real blocker:** somebody must register a GitHub OAuth App (or GitHub
App) and give tm8 its `client_id`. Device flow must be explicitly enabled on it. Until that
exists, GitHub falls back to Tier B/C.

### Tier B — Guided PTY login (works for all three, today, no registration)
Reuses machinery that is **already built**: `packages/tm8-ui/src/terminal/LiveTerminal.tsx` is a
full xterm with bidirectional input (`term.onData` at :342 forwards keystrokes), attached over
`/v2/ws?sessionId=…` via `execution.streams.attach` with `mode: 'view' | 'drive'`
(`execution-handlers.ts:563`).

```
UI: [Connect Claude]  →  a CREDENTIAL SESSION
  - projectless, scratch cwd, short TTL (10 min), terminated on close
  - HOME / CLAUDE_CONFIG_DIR / CODEX_HOME / GH_CONFIG_DIR = the user's OWN credential dir
  - env SCRUBBED: no GH_TOKEN, no ANTHROPIC_API_KEY, no TM8_AGENT_TOKEN, no node credentials
  - command is a FIXED, server-chosen string — never client-supplied:
        claude setup-token | codex login --device-auth | gh auth login --web …
  - attached in `drive` mode so the user types the code / answers the TUI
  - on exit: scan the credential dir, upsert credential_refs, show what was captured
```
This is the honest general answer: **the vendor's own login flow, in a real terminal, with the
user's own HOME.** It works for every provider without tm8 registering anything, and it stays
correct when a vendor changes its flow.

The hard requirement: **a credential session is not a normal work session.** It has no persona,
no task, no `TM8_AGENT_TOKEN`, no project cwd, and its command comes from a server-side table of
exactly three entries. A client-supplied command here would be remote code execution as the tm8
user, reached from a settings form.

### Tier C — Paste a key (always available, lowest friction, no browser dance)
A masked input + [Save]. Fully programmatic on the server side, all three:
```
gh    :  printf '%s' "$tok" | gh auth login --with-token --hostname github.com
codex :  printf '%s' "$key" | codex login --with-api-key
claude:  write ANTHROPIC_API_KEY into <credDir>/env.json  (or apiKeyHelper, §6.6)
```
Validate before storing — `gh api user`, a 1-token Anthropic/OpenAI ping — so the UI can say
*"Connected as @octocat"* rather than *"Saved"*, and a typo fails at paste time instead of at
3am inside somebody's spawn.

**Never echo a stored value back to the browser.** Show provider, account handle, scopes,
fingerprint (`sk-ant-…a91f`), added-at, last-used-at. §3.2's rule stands: there is no read-value
operation at any privilege.
