# 9 — Phasing

> Design document, exported from the tm8 graph at entity `019fdc8d-5b84-718b-ad1d-2aeb7d8e8551` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 9 — Phasing

*Sub-document of “Design: per-member credential management in sessions”. Basis: `origin/main` @ `7631e08`, 2026-08-07.*

## Part 4 — Phasing

| # | Deliverable | Touches | Size |
|---|---|---|---|
| **P0** | Rotate the `.profile`/`.bashrc` PAT; delete the export. Purely operational. | box | trivial |
| **P1** | `SessionLauncher` port + `DirectPtyLauncher`; thread `CredentialPrincipal` (identityId) from claims into `SpawnRequest`; child inherits parent's principal. No behaviour change. | `SpawnService`, `execution-handlers`, `spawn/types` | S |
| **P2** | Migration: `credential_refs` + RLS + secret guard. Node-local store `<dataDir>/credentials/<identityId>/`, 0700, with `ensurePrivateDataLayout` extended. `UserCredentialPort` in `@tm8/server`. | new migration, server facade | M |
| **P3** | `composeEnv(…, credentials)` with the per-provider **name allowlist**. Manifest records `credentialPolicy` + `envVarNames`. Tests: allowlist rejects `PATH`/`LD_PRELOAD`/`BASH_ENV`; manifest contains no values. | `manifest.ts`, `SpawnService` | S |
| **P4** | Per-identity `HOME` + `CLAUDE_CONFIG_DIR`/`CODEX_HOME`/`GH_CONFIG_DIR`/`GIT_CONFIG_GLOBAL`/`GIT_SSH_COMMAND`. Split agent-`HOME` from binary-discovery-`HOME` (`withAgentBinDirs`). Pass the composed env to `trustClaudeWorkspace`/`trustCodexWorkspace`. Seed `~/.bashrc`. | `manifest.ts`, `SpawnService`, `workspace-trust.ts` | M |
| **P5** | Credential onboarding: a projectless PTY session with the user's `HOME`, for `claude setup-token` / `gh auth login` / `codex login`. Settings screen under `packages/tm8-ui/src/settings-governance/`. | UI + facade | M |
| **P6** | `GIT_AUTHOR_*` / `GIT_COMMITTER_*` — closes IDENTITY-OPEN-THREADS §2. | `manifest.ts` | XS |
| **P7** (later) | T1 `SetuidPtyLauncher`, per-identity OS users, project-dir ACLs. | ops + execution | L |

P1–P4 is the credible first milestone: **real per-user credentials, honestly labelled as not
being an isolation boundary.** P7 is what makes it one.


---

## 6.7 Revised phasing (supersedes P5 in Part 4)

| # | Deliverable | Size |
|---|---|---|
| **P5a** | `credentials.list/putKey/delete/verify` + `settings-credentials/` screen, **Tier C only** (paste a key), **wired into `SettingsShell`**. Works for all three providers on day one with zero vendor registration. | M |
| **P5b** | **Tier B** credential sessions: `credentials.loginSession`, fixed command table, scrubbed env, TTL, reuse of `LiveTerminal` in `drive` mode. Unlocks Claude subscription + ChatGPT login, which Tier C cannot reach. | M |
| **P5c** | **Tier A** native GitHub device flow. **Gated on registering a tm8 GitHub OAuth App** — start that conversation now, it is lead time, not build time. | S + ops |
| **P5d** | Spawn dialog + session header show the resolved credential source. Cheap, and it is what makes the whole feature legible. | S |

P5a is the honest MVP: it is the only rung that needs nothing from any vendor, and it makes the
storage and injection layers (P2–P4) observable from the UI the day they land.
