# 15 — Measured: the Claude login verbs under a real PTY

> Design document, exported from the tm8 graph at entity `019fdc8d-624d-7362-8164-d5e53adb78eb` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 15 — Measured: the Claude login verbs under a real PTY

*Measured 2026-08-07 on this node, `claude` 2.1.220 (`/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`,
a bun-compiled single file). Method: `pty.fork()` harness driving each verb on a real TTY with
`CLAUDE_CONFIG_DIR` pointed at a fresh empty directory, raw output captured, directory snapshotted
before and after, process killed at 25s. **No login was completed and no credential was captured** —
every flow was abandoned at the paste-code prompt. Closes sub-doc 13 §C1 gap 1 and largely closes
gap 3.*

---

## A. The headline: Claude does NOT use a loopback callback. Both verbs are paste-back.

Sub-doc 13 §C1 gap 1 was open because "both are full-screen TUIs that render nothing without live
stdin". With a real PTY they render fine. What they render changes the design:

```
redirect_uri = https://platform.claude.com/oauth/code/callback
```

**A remote HTTPS callback, not `localhost`.** The user opens the URL on their laptop, authorizes,
the Anthropic-hosted callback page shows a code, and the CLI waits at:

```
Paste code here if prompted >
```

Confirmed as a first-class code path, not a fallback — the bundle carries
`startOAuthFlow` / `waitForAuthorizationCode` / `handleManualAuthCodeInput` as named functions.

### What this means for the plan

The parent doc's **finding 2** says *"only device-code and stdin flows are buildable"*. The
**conclusion is right and the enumeration was incomplete**: there is a third buildable shape —
**remote-callback paste-back** — and Claude uses it for both verbs. So:

- **Claude Tier B needs no device flow and no vendor registration.** It works on the
  Tailscale/nginx topology exactly as shipped, because nothing ever binds or redirects to
  `localhost`. Contrast Codex, which *does* start a `127.0.0.1:1455` listener and must be forced
  onto `--device-auth`.
- The Tier B loop for Claude is: stream the URL out, take one line of text back. That is the
  cheapest possible shape and it needs nothing from Anthropic.

---

## B. `setup-token` vs `auth login` — the discriminator is SCOPE

Same `client_id` (`9d1c250a-e61b-44d9-88ed-5944d1962f5e`, Claude Code's own public client), same
PKCE `S256`, same remote callback. They differ in exactly one thing that matters:

| | `claude setup-token` | `claude auth login` |
|---|---|---|
| scope | `user:inference` **only** | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` |
| output shape | full-screen TUI, spinner, OSC 8 hyperlinks | plain lines, no alt-screen |
| raw bytes to first prompt | 3186 | 1018 |
| files written before auth | `.claude.json` + `backups/.claude.json.backup.<ms>` | identical |

**Recommendation for the fixed command table (sub-doc 11 §A4): `claude setup-token`.** It requests
least privilege — inference only — which is exactly and only what a tm8 agent session needs. A
tm8-stored credential that also carries `org:create_api_key` is a credential that can mint more
credentials, and storing that on a node with no cross-user isolation (T0) is a materially worse
failure if the store is read by another member's agent.

### The cost of that choice, and it is not optional

`setup-token`'s scope set **excludes `user:profile`**. Review already observed that an isolated
`CLAUDE_CONFIG_DIR` reports `email: null, orgId: null`; this is *why*, and it is **structural, not
a bug to tolerate**: a `setup-token`-authenticated directory can never populate those fields, so
the Connections card can never say "Connected as alice@example.com" for Claude. It can say
"Connected — inference access" and show the connect time.

**This is a real product decision, not an implementation detail:** least privilege *or* a named
identity on the card. Choosing `auth login` to get the name means storing a token that can create
API keys. Recommend least privilege and honest copy.

---

## C. Two traps for the verification probe

### C1. A populated `CLAUDE_CONFIG_DIR` is NOT a success signal

Both verbs write `.claude.json` (389 bytes) **and** a `backups/.claude.json.backup.<ms>` within
seconds of launch, **before any authentication happens** — the directory below was produced by a
run that authenticated nothing:

```
.claude.json                          389
backups/.claude.json.backup.1786107213248
```

It contains `firstStartTime`, `machineID`, `userID`, migration flags — CLI bookkeeping, no
credential. The real credential lands in a **different file**, `.credentials.json`, mode `0600`
(509 bytes in the live `~/.claude`). So the finish step must key success on `.credentials.json`
existing, or on `claude auth status` — **never on "the directory has files in it"**, and never on
a clean PTY exit. This compounds the already-noted risk that a user closing the terminal mid-flow
exits 0 with nothing captured.

### C2. `auth status` is JSON by default, and exit code 0 means nothing

Measured against an unauthenticated isolated dir:

```json
{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty" }
```

Exit code **0**. `--json` is accepted but redundant. Probe on the `loggedIn` field; the exit code
carries no information.

### C3. Parse the OSC 8 target, not the visible text

`setup-token` emits the authorize URL as an **OSC 8 hyperlink whose visible label is hard-wrapped
across five 80-column fragments** (`…client_id=9d1c250a-e61b-44d9-88` / `ed-5944d1962f5e&…`). Each
fragment repeats the *full* URL in its OSC 8 target. A naive regex over rendered text captures a
**truncated URL**; concatenating the fragments correctly is exactly the thing xterm reflow makes
fragile. Extract the `ESC ] 8 ; id=… ; <URL> BEL` target. `auth login` has no such problem — it
prints one plain unwrapped line — which is a second, weaker argument for `auth login` and does not
outweigh scope.

---

## D. Gap 3 (concurrent refresh) — largely closed, statically

Sub-doc 13 re-scoped this to "plan a day". It is cheaper than that. The bundle contains a
dedicated OAuth refresh lock:

```js
{ lockfilePath: path.join(e, ".oauth_refresh.lock"),
  realpath: false, stale: 60000, update: 5000,
  onCompromised: (r) => { log(`OAuth refresh lock compromised: ${r.message}`, {level:"error"}) } }
```

acquired around the refresh path (a `proper-lockfile`-shaped config: 60s staleness, 5s heartbeat,
compromise handler). **So the CLI already serialises concurrent refreshes itself**, per config
directory, across processes on one filesystem — which is precisely the tm8 single-node case. Two
sessions of one identity sharing a per-identity `CLAUDE_CONFIG_DIR` is therefore the *supported*
case, not an unhandled race, and two *different* identities never contend at all because their
directories are disjoint.

**Residual risk, narrowed:** `stale: 60000` means a session stalled mid-refresh for over 60s can
have its lock broken by a peer — the `onCompromised` handler exists because the vendor knows this
happens. Keep the retry-on-corrupt-read mitigation as belt-and-braces; drop the day of work.

> **Evidentiary class.** §D is a **static read of a compiled bundle**, not a runtime observation —
> the same class as sub-doc 0's description of `applyGitCredential`, and it should not be promoted
> above that. §§A–C are direct runtime measurements.

---

## E. Smaller notes

- Both verbs print `Opening browser to sign in…` and attempt a browser launch before falling back
  to printing the URL. Harmless on a headless node, but a credential session should set `BROWSER`
  to a no-op and leave `DISPLAY` unset so the attempt cannot block or spawn anything.
- `CLAUDE_CONFIG_DIR` isolation held throughout: the live `~/.claude/.credentials.json` was never
  read or written by any probe run.

---

## F. What is still open for Claude

Nothing in gap 1. Gap 3 is narrowed to the 60s-stale window. Still open and unchanged: the Codex
positive control (needs a node with a Codex login — an ops dependency, not a measurement), and
Tier A's GitHub OAuth App registration.

---

## G. AMENDMENT 2026-08-09 — §B's recommendation is REVERSED (R4 amended)

Every measurement above abandoned the flow at the paste-code prompt (stated in the preamble), so
this doc never observed what each verb does **on completion**. Measured on Utho prod
(claude 2.1.220, four completed member attempts plus binary-string evidence):

- **`setup-token`'s product is a PRINTED token, not a persisted login.** The flow ends by printing
  an `sk-ant-oat01-…` token the user is meant to carry as `CLAUDE_CODE_OAUTH_TOKEN` — the binary's
  own strings say *"Mint a fresh token with `claude setup-token` and restart the session with
  it"*. It writes **no `.credentials.json`** into `CLAUDE_CONFIG_DIR`.
- Consequence 1: the finish probe (`claude auth status`, §C2) reads `loggedIn: false` after a
  **perfectly completed** flow, so the Connect card can structurally never end "signed in". Four
  completed attempts on Utho left `.claude.json` + `backups/` (§C1's pre-auth writes) and nothing
  else.
- Consequence 2: the member is left holding a raw token on screen. One was pasted into a task
  description and tripped the S15 manifest guard on every launch of that task — the exact
  credential-leak class the store exists to prevent.

§B's scope analysis stands as measured. But a verb whose success the probe cannot see is not a
narrower credential — it is **no stored credential plus a leaked secret**. The fixed command table
now runs **`claude auth login`**; its wider grant (including `org:create_api_key`) is the accepted
price, and `user:profile` in that grant means `account_agent_credentials.login` is now populated
for anthropic ("Connected as <address>"). Rows minted before the amendment keep `login: null` and
the "Connected — inference access" copy. §C1/§C2/§C3 are unchanged and remain the reasons the
probe keys on `loggedIn`, never on directory contents or exit codes.
