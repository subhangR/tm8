# 8 — UI: surfaces, facade operations and apiKeyHelper

> Design document, exported from the tm8 graph at entity `019fdc8d-5a56-72b0-bcea-bc9a89483342` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 8 — UI — surfaces, facade operations and apiKeyHelper

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

## 6.4 Where it lives in the UI

`SettingsShell` is **mounted and live** — `views/GateApp.tsx:53,543`, behind the `settings` menu
view ref. It owns the section nav; section bodies are separate screens
(`settings-space/` half A, `settings-governance/` half B).

New: **`packages/tm8-ui/src/settings-credentials/`**, a fourth section body, same shape as its
siblings (a `port.ts` seam, a `reasons.ts`, screens that receive plain values and cannot tell a
fixture from a real node).

⚠ `settings-governance/index.ts` says **"MOUNTABLE, NOT MOUNTED"** — three finished screens
sitting unwired because the coordinator holds the wiring seat. **Do not repeat that here.** The
wiring into `SettingsShell` is part of the credentials lane, not a follow-up, or this ships as
another finished-and-invisible surface.

```
Settings
├─ Space            (settings-space)
├─ Menu             (settings-space)
├─ Projects & Trust (settings-governance — built, unmounted)
├─ Interaction Profiles / Custom Kinds (ditto)
└─ ▸ Connections    ← NEW, per-user, always scoped to the signed-in identity
```

**The Connections screen:**
```
┌─ Connections ─────────────────────────── These are YOURS. Nobody else in this space sees them. ─┐
│                                                                                                 │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ⬤ GitHub            Connected as @octocat                                                 │  │
│  │   repo · read:org · gist · added 3 Aug · last used 2h ago         [Reconnect] [Disconnect]│  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ○ Claude Code       Not connected — your sessions use the NODE credential                 │  │
│  │   [ Sign in with Claude ]   [ Use an API key instead ]                                    │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────────────────────────────────────────┐  │
│  │ ○ ChatGPT / Codex   Not connected — your sessions use the NODE credential                 │  │
│  │   [ Sign in with ChatGPT ]  [ Use an API key instead ]                                    │  │
│  └───────────────────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                                 │
│  Sessions run as one OS user on this node. Another member's agent can read these files.         │
│  Connect only accounts you would be willing to share with this node's other members.  ⓘ         │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

That last paragraph is **not optional copy.** Under T0 (§3.5) there is no cross-user isolation,
and a "Connections" screen with a padlock implies one. It is the same voice S12 uses for project
trust: *"v1 does not sandbox — trust is informed consent, and that is stated honestly in the UI
copy."* When T1 (per-identity OS user) lands, this paragraph is what gets deleted, and that
deletion is how a user learns the boundary became real.

**Second surface — the spawn dialog.** Whose credential a session will spend must be visible
*before* it is spent, not discovered afterwards:
```
Launch session
  Persona  [ Opus 5 Teammate ▾ ]
  Project  [ prod-workspace   ▾ ]
  Credentials  ⬤ Yours (@octocat, Claude Max)        ← resolved per provider
               ○ Node default  ⚠ shared by everyone
```
And the same fact on the running session header, since `credentialPolicy` is recorded in the
manifest (§3.6) and the session is therefore self-describing.

## 6.5 New facade operations

All per-identity, all scoped to `claims.identityId`, none returning a secret value:

| operation | notes |
|---|---|
| `credentials.list` | metadata rows for the caller's identity only |
| `credentials.putKey` | Tier C. value goes to disk, never to `credential_refs` |
| `credentials.delete` | drop row + wipe directory |
| `credentials.verify` | live check (`gh api user` etc.) → handle + scopes |
| `credentials.deviceStart` / `credentials.devicePoll` | Tier A. `device_code` stays server-side |
| `credentials.loginSession` | Tier B. spawns a credential session, returns a session id for stream-attach |

`credentials.loginSession` is the dangerous one and needs its own guards: fixed server-side
command table, no persona, no project, no `TM8_AGENT_TOKEN`, hard TTL, one live session per
identity per provider, and it must **never** appear in the generic `execution.spawn` path.

## 6.6 One clean alternative worth prototyping: `apiKeyHelper`

Claude Code supports `--settings <file-or-json>` with an `apiKeyHelper` — a command it runs to
obtain a key. `composeEnv`/`buildAgentCommand` could pass
`--settings '{"apiKeyHelper":"tm8 credential get anthropic"}'`, and the key would be fetched at
use time by an already-authenticated CLI (`TM8_AGENT_TOKEN` is right there in the env) instead of
being copied into the process environment at all.

Benefits: no plaintext in `/proc/<pid>/environ`; rotation takes effect without a respawn;
revocation is immediate. Worth a spike in P3 — but it is **Claude-only**, so it is an
optimisation on one leg, never the architecture.
