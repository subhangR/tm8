# Design: per-member credential management in sessions

> Design document, exported from the tm8 graph at entity `019fdc8d-4fb8-7647-8199-76789465c63a` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# Per-member credential management in tm8 sessions

**Research + design plan.** Basis: `origin/main` @ `7631e08` (2026-08-07), plus runtime
measurement against the live prod server (`tm8-prod.service`, node PID 1483979, port 7777) and
against the agent CLIs installed on this node (`claude` 2.1.220, `/usr/bin/codex`,
`~/.local/bin/gh`).

**Question asked:** can each member of a space configure their own GitHub / Claude / ChatGPT
credentials, so that a session they spawn runs on *their* accounts — with full UI-based
connect flows, per user?

**Answer:** yes, and the injection machinery already exists. The work is not injection. It is
storage, `HOME`, and being honest about what isolation a single OS user can provide.


> ## ⚠ CORRECTION — read sub-doc 0 first
>
> This plan was researched against `origin/main` @ `7631e08`. The **deployed staging line already
> ships a working per-account GitHub credential feature** (`079_account_git_credentials`, applied
> to the staging DB), and it chose the opposite storage option to the one sub-doc 3 recommends:
> **AES-256-GCM ciphertext in Postgres with the key on the node filesystem.** `origin/main` cannot
> see it — main's `077` is a different file. Storage, principal, and `GIT_AUTHOR_*` attribution
> are therefore **already decided and implemented for GitHub**; what is missing is **any UI at
> all** (zero references in `packages/tm8-ui/`), and Claude/Codex credentials, which are
> file-shaped and cannot use the shipped env-var mechanism.

---

## The two findings that shape everything

**1. The env allowlist guards the wrong channel.** `composeEnv` (`manifest.ts:721`) builds a
complete, curated child environment and `PtyHostService` never merges `process.env`. Measured on
a live agent (PID 2027909): no `ANTHROPIC_API_KEY`, no `GH_TOKEN` — it works exactly as designed.
But `HOME=/home/tm8` for every session, so every agent reads `~/.claude/.credentials.json` (the
OAuth token that actually pays for the model), `~/.config/gh/hosts.yml` and `~/.gitconfig`.
**Invariant S15 — "secrets never enter Postgres" — is fully satisfied and buys zero per-user
separation**, because the secret was never in env. It is in a shared home directory.

**2. Loopback-callback OAuth cannot complete on this topology.** Default `codex login` starts a
local server on `http://localhost:1455` and redirects there. tm8's UI is reached over
Tailscale/nginx from a laptop, where `localhost` is the laptop. The CLI diagnoses itself:
*"On a remote or headless machine? Use `codex login --device-auth` instead."*
**No flow that binds or redirects to `localhost` is buildable** — for any provider, at any tier.

> **REFINED 2026-08-07 (sub-doc 15).** The conclusion holds; the original enumeration
> ("only device-code and stdin flows are buildable") was incomplete. There is a **third buildable
> shape — remote-callback paste-back** — and **Claude uses it for both login verbs**:
> `redirect_uri=https://platform.claude.com/oauth/code/callback`, then `Paste code here if
> prompted >`. Nothing binds locally. **So Claude Tier B needs no device flow and no vendor
> registration**, and works on this topology as shipped. Codex remains the constrained one: it
> genuinely starts a `127.0.0.1:1455` listener and must always carry `--device-auth`.

---

## Shape of the design

| layer | answer |
|---|---|
| **Whose credential** | the spawning human identity (`claims.identityId`), never the persona — personas are shared. Children inherit the parent's principal and may never name another. |
| **Storage** | node-local `<dataDir>/credentials/<identityId>/`, 0700. Postgres holds an index only (`credential_refs` + RLS). Preserves S15 verbatim; forced by Claude's OAuth refresh-in-place. |
| **Injection** | one new parameter on `composeEnv`, merged last, under a **server-owned per-provider name allowlist** — arbitrary names would be code execution handed out through a settings form. |
| **`HOME`** | per-identity home + explicit `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GH_CONFIG_DIR` / `GIT_CONFIG_GLOBAL`. Two known traps, both named in sub-doc 4. |
| **Isolation** | **T0 only.** One OS uid, so per-identity homes are a convenience, not a boundary. Ship it behind a `SessionLauncher` port so T1 (per-identity OS user) slots in later. |
| **UI** | three tiers as a fallback chain — native device flow (GitHub, blocked on OAuth App registration) → guided PTY login (all three, machinery already built) → paste a key (all three, day one). |

---

## Sub-documents

| | | |
|---|---|---|
| **0** | [What already exists on the deployed line (correction)](019fdc8d-50ac-71f1-b821-62e46bc2b730) | **read first** — the shipped GitHub feature, its five controls, and what it settles vs leaves open |
| **1** | [Rehearsal — how a session is spawned today](019fdc8d-51f2-7441-a01c-d8ade5845314) | the call chain, both agents' argv, the manifest, the PTY, and what `composeEnv` puts in the child env |
| **2** | [The credential channels](019fdc8d-5326-7eb5-abd9-c8a5ec51399a) | **seven** — env allowlist, `HOME`, shell profile, project dir, plus XDG / .git-credentials / TM8_AGENT_TOKEN from review |
| **3** | [Design — principal and storage](019fdc8d-544c-78d5-96d9-ee87fba95847) | who owns a credential; storage A-vs-B and why B wins; `credential_refs` schema |
| **4** | [Design — injection and HOME](019fdc8d-5574-772a-85ce-e9841a7463c1) | the `composeEnv` change, the name allowlist, per-identity homes, and the two traps in `workspace-trust.ts` and `withAgentBinDirs` |
| **5** | [Sandboxing — what this node can actually do](019fdc8d-56c4-78a3-b853-3d233482892a) | measured tooling and kernel posture; the honest T0/T1/T2 tiering and the `SessionLauncher` seam |
| **6** | [Policy and lifecycle](019fdc8d-57fa-7ed9-9b96-4fc00d4515c6) | `own` / `node-fallback` / `space-shared`; rotation, revocation, OAuth refresh, backup exclusion |
| **7** | [UI — login flows and the three integration tiers](019fdc8d-593a-7d15-9c5a-a76d7e2d06dc) | the loopback-callback finding; what each provider supports, measured; Tiers A / B / C |
| **8** | [UI — surfaces, facade operations and apiKeyHelper](019fdc8d-5a56-72b0-bcea-bc9a89483342) | the Connections screen, the spawn dialog, new facade ops, and the `apiKeyHelper` alternative |
| **9** | [Phasing](019fdc8d-5b84-718b-ad1d-2aeb7d8e8551) | P0–P7, and the revised P5a–P5d for the UI |
| **10** | [Open decisions](019fdc8d-5ca4-7009-b9a0-b7495e5687b2) | the eight calls needed before build |
| **11** | [Tier B: full implementation plan](019fdc8d-5dd4-729f-985e-2148300c8364) | design decisions, migration, server, contract, UI, tests, PR sequencing |
| **12** | [Server-side configuration before collaborative tm8](019fdc8d-5ef0-76d5-a29c-781b38b052ff) | **operator prerequisites** — 6 blocking, incl. one active defect that defeats the shipped feature |
| **13** | [Coverage: what Tier B solves, and what it does not](019fdc8d-600b-75b0-9957-70e4e1d20735) | the login/storage/reuse/tracking matrix per provider, and the 10 named gaps |
| **14** | [Adversarial review: findings and disposition](019fdc8d-6133-7c82-a259-fbfdd4ea596e) | **VERDICT: not safe to build as written** — 9 findings, 3 new credential channels, revised sequence |
| **15** | [Measured: the Claude login verbs under a real PTY](019fdc8d-624d-7362-8164-d5e53adb78eb) | closes the last two Claude measurement gaps — `setup-token` vs `auth login` is a **scope** choice, and Claude needs no device flow |

---

## Status

> ### ⛔ REVIEWED 2026-08-07 — NOT SAFE TO BUILD FROM AS WRITTEN
>
> An independent Fable 5 review (sub-doc 14) upheld the storage split, the principal, Tier B's
> shape, the fixed command table and the honesty copy — and found **three false load-bearing
> assumptions, two in the security half**. Headline: **`share_mode='none'` does not restrict PTY
> attach at all**, and `grant_stream_attach` is not even on the socket path — so a credential
> terminal is attachable *and drivable* by every member of the space. A new **PR0** (socket attach
> authorization) precedes everything, and is worth doing whether or not credentials ship.
> Also: the "already shipped" GitHub feature is merged and migrated but **not deployed** — the
> staging process predates its own build by 17 hours and the endpoint answers `no operation bound`.

**No code written.** Build handoff task: `019fdc8d-6368-738f-b30d-6f9acf918d4e` — a cold-start brief carrying the corrected sequence (P0 → PR0 → 1′ → 2′ → 3 → 4 → 5), the measured facts, the traps, and the six items that need a human. Tier B is fully specified in sub-doc 11; operator prerequisites are in
sub-doc 12. The two things to settle first:

- **The `GH_TOKEN` export in `/home/tm8/.bashrc:3` and `/home/tm8/.profile:3` must go.** Measured:
  an interactive or login shell **overrides** the per-account token the shipped feature injects,
  so every `gh`/`git` call an agent makes through its own tool shell uses the machine-wide PAT.
  The already-shipped feature is silently defeated on this box today. Two deleted lines plus a
  token rotation — do this before any further credential work.
- **DECIDED 2026-08-07:** T0 ships — per-identity `HOME` on one OS user is accepted, with the
  honesty copy in the UI. The discriminator is a nullable `work_sessions.credential_provider`,
  orthogonal to `mode`, which is untouched. See sub-doc 13 §A.
