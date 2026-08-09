# Per-member session credentials

Today a spawned tm8 session inherits the **node's** GitHub / Claude / Codex credentials, so
every agent on a shared node acts as one identity. This feature gives each member of a Space
their own connected accounts, and makes a session that member spawns use **that member's**
credentials.

These 17 documents are the design. They were written and adversarially reviewed before any
code, and they are exported here from the tm8 graph so the PR carries its own reasoning. The
graph entities remain the source of truth; each file names its entity id and version.

## Read in this order

| | file | why |
|---|---|---|
| index | [`00-index.md`](00-index.md) | the map |
| **0** | [`00-what-already-exists.md`](00-what-already-exists.md) | **read before 3, 7, 9, 10** — a per-account GitHub feature already shipped on the deployed staging line and made the *opposite* storage choice |
| **14** | [`14-adversarial-review.md`](14-adversarial-review.md) | **the verdict** — the original sequence was found NOT SAFE TO BUILD FROM; this is the register of what changed |
| **11** | [`11-tier-b-implementation-plan.md`](11-tier-b-implementation-plan.md) | **the spec this PR implements**, and the home of every architect ruling R1–R16 |
| 12 | [`12-server-side-configuration.md`](12-server-side-configuration.md) | operator prerequisites — none of this is applied on any node yet |
| 13 | [`13-coverage.md`](13-coverage.md) | what Tier B deliberately does **not** solve |
| 15 | [`15-claude-login-verbs-measured.md`](15-claude-login-verbs-measured.md) | the Claude login verbs driven under a real PTY |
| 1–10 | rehearsal, channels, storage, HOME, sandboxing, policy, UI tiers, UI surfaces, phasing, open decisions | supporting analysis |

## The decisions that shaped the code

Each is recorded with its reasoning in doc 11.

- **R1 — the discriminator is `session_kind`, not `credential_provider`.** The provider already
  lives in `credential_sessions.provider` with its CHECK and its one-live-per-pair index;
  a second copy would have nothing keeping the two in step.
- **R2 — all four `credentials.*` operations are human-only.** An agent's token carries its
  owner's *full* identity, not a reduced principal, so without this an agent could read its
  owner's credential status, delete their token, and open a login terminal in their name.
  Enforced on an **allowlist** (`browser`, `cli`), never a `!== 'agent'` negation, so a future
  fifth session kind is refused rather than silently admitted.
- **R3 — Disconnect terminates.** Revoke first, then the credential session, then that
  account's live agent sessions carrying the provider. The dialog says plainly that vendor-side
  rotation is the real revocation.
- **R4 — the Claude card can never say "Connected as <email>".** `claude setup-token` requests
  inference scope only; `claude auth login` requests six scopes including `org:create_api_key`.
  Storing a credential that can mint further credentials is materially worse on a node with no
  cross-user isolation. The cost is permanent: no profile scope, so no email, ever.
- **R6 — `account_agent_credentials.provider` is `('anthropic','openai')` and no more.**
  A provider is admitted by *measuring* its login flow, not by widening a CHECK. GitHub stays
  string-shaped in 079's `account_git_credentials` on the deployed line.
- **R10 — the credential cap counts `credential_sessions`, not `work_sessions.status`.**
  Nothing writes that status after a crash, so two orphans would have been a permanent
  node-wide login denial-of-service.
- **R13 — the node's own `ANTHROPIC_API_KEY` must be suppressed** for a provider whose member
  credential is being injected. An empty config dir plus a node key silently reports
  `authMethod: "api_key"` — injection bypassed, and the node's identity laundered.
- **R16 — `sessionKind` is optional on the read model and its absence means VISIBLE.** Every
  filter is `!== 'credential'`, never `=== 'agent'`; the opposite polarity to R2's allowlist,
  because hiding real sessions from an older cached payload is the worse failure.

## Honest status

This PR is the **code**. It is not a shipped feature:

- The full stack has **never run against a live server**. Migration 083 has not been applied
  to any database.
- **openai/Codex is unproven** — the login verb is in the fixed command table, but
  `codex login status` output has never been captured on any node. The probe says so in its
  own source.
- **github** is not stored by this stack at all (R6). It depends on `079_account_git_credentials`,
  which exists on the deployed staging line but not on `main`. The UI renders that absence as
  *unknown*, never as "not connected".
- Doc 12's operator configuration has not been applied anywhere.
