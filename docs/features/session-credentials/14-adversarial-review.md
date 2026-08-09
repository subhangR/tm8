# 14 — Adversarial review: findings and disposition

> Design document, exported from the tm8 graph at entity `019fdc8d-6133-7c82-a259-fbfdd4ea596e` v2.
> The graph entity is the source of truth; this file is the reviewable copy.

# 14 — Adversarial review: findings and disposition

*Review by `Fable 5 Teammate` (`claude-fable-5`), session `019fdb8f-3324-7243-951d-c642bde02964`,
task `019fdc8d-6468-799c-bcc9-46ed4daeb932`, 2026-08-07. Full text is 5 messages on that task
anchor. Every finding below states a command; the reviewer made no writes and restarted nothing.*

> ## VERDICT: NOT SAFE TO BUILD FROM AS WRITTEN.
>
> Upheld: the storage split, the principal (spawning human), Tier B's shape, the fixed command
> table, the honesty copy, the `SessionLauncher` seam. **Three load-bearing assumptions are false,
> two of them in the security half.**

## Findings

| # | sev | finding |
|---|---|---|
| **D1** | **CRITICAL** | `share_mode='none'` does **not** restrict PTY attach — and `grant_stream_attach` is **not on the socket path at all** |
| **D2** | HIGH | `can_act_as` makes persona-created sessions drivable by every space member |
| **D3** | HIGH | A credential session burns an agent spawn slot |
| **D4** | HIGH | “Put the filter in the read model” is not implementable — **there is no read model** |
| **D5** | HIGH | The ghost reaper force-exits credential sessions |
| **D9** | HIGH | The “already shipped” GitHub feature is **merged and migrated but NOT deployed** |
| **D6** | MED-HIGH | `gh auth token` prefers `$GH_TOKEN` over `hosts.yml` — the extraction seam can persist the wrong secret |
| **D7** | MED | Sub-doc 12 §1 **under-claims**: the shipped helper *launders* the machine PAT under the connected user's name |
| **D8** | MED | §11 §A2's “no interaction-profile pin” is contradicted by an unconditional trigger |

### D1 — the one that changes the plan
Two independent paths that disagree. `execution.streams.attach` → `grant_stream_attach` checks
share_mode, creator and view/drive. The actual socket, `/v2/ws?sessionId=…` → `ptyAuthorize`
(`main.ts:362-384`), checks **only** that the entity exists and is visible — no share_mode, no
creator, no mode — then wires input unconditionally (`pty-ws-server.ts:303`).
`grant_stream_attach` passes `p_token_hash = null` and returns a bare URL, so **skipping the RPC
reaches the same terminal**; `stream_grants` is written and never read for authz. Measured on live
prod against a `share_mode='none'` session created by another member, using the 404 message as the
discriminator (401 unauthenticated / `no such session` invisible / `no live PTY` authorized). Prod
is already a **6-member space**. A Tier B terminal is where a device code is pasted.

### D3 / D4 / D5 / D8 — the “no impact” claim is false about the **row**
The column is fine; `mode` is genuinely untouched. But a credential row is structurally a
`work_sessions` row, and only three predicates ever narrow the session set anywhere in the tree
(`status`, `node_id`, `deleted_at`). Consequences, each measured:
- `internal.live_work_session_count` has no other predicate → **burns a spawn slot node-wide**
  (`53400 session concurrency cap reached`). Also: `TM8_SESSION_CAP=30` on the deployed prod unit,
  not the documented 8.
- **Zero views exist in `public`**; session listing is TypeScript `collections.query`. The filter
  has no single home and must be added in ≥7 places, incl. `registry.ts` `SESSION_TIERS`,
  `useGateData.ts` boot hydration, the **legacy `packages/ui` screens with no status filter at all**,
  `space_kind_counts` (rail badge **and** unseen badge), and `projector.ts` (fans out to every
  subscriber). `057`'s `to_jsonb(ws)` auto-publishes the new column with no code change.
- `reconcileNodeGhosts` force-exits any such row carrying a `node_id`.
- `internal.ensure_core_interaction_pin` fires on **every** `work_sessions` insert — a pin is
  unavoidable. Restate A2 as “no *agent* capabilities”.
- *Good news:* persona-requiring paths fail **closed** with typed errors (42501 / P0002).

### D9 — the premise of sub-doc 0 is unproven in operation
`tm8-staging` MainPID started `Aug 4 17:06`; **164 dist files post-date it**;
`GET /v2/identity/git-credentials` → `no operation bound`. The zero rows in
`account_git_credentials` are consistent with an unreachable endpoint, not just a missing UI.
**Nobody has ever exercised 079 against a running server**, so §0's spawn-injection description is
a code reading — same evidentiary class as the review's own.

## Corrections to this design's own claims

| claim | disposition |
|---|---|
| `BASH_ENV` ignored by `bash -lc` (§11 §I table) | **WRONG** — it *is* honoured by `-lc`. Conclusion unchanged (`HOME` is still the only lever reaching interactive shells), the cell is not. |
| Loopback auto-owner is BLOCKING (§12 §4) | **ALREADY MITIGATED** — `TM8_DISABLE_AUTO_OWNER=1` on the prod unit; `/v2/spaces` → 401, WS upgrade → 401. Downgrade to ADVISORY: *verify the flag on every node and pin it in the unit file.* |
| “hours not days” on the 4 measurement gaps (§13 §C1) | **half credible.** #2 done in ~5 min by the reviewer. #1 credible. #3 (concurrent refresh) needs a real expiry — plan a day or accept the risk. #4 is **not a measurement** — it needs a node with a Codex login; move to C2 beside the OAuth App. |
| Gap 8 (revocation) severity | **raise it.** With D1, Disconnect leaves the secret live *and* the capturing terminal drivable. Reviewer would make Disconnect terminate that identity's live sessions. |
| Gap 5 (SSH / non-GitHub) severity | **raise it.** Not “gets nothing” — silently gets the machine-wide `store` credential, because the helper reset is URL-scoped (C6). |

**Upheld under attack:** the `.bashrc`/`.profile` override (reproduced verbatim); `CLAUDE_CONFIG_DIR`
replaces `~/.claude` and alone decides (reviewer ran *both* directions, incl. the positive control);
`gh` refusing to log in with `GH_TOKEN` set; the codex loopback listener (`ss` showed a real
`127.0.0.1:1455`); the storage split (tried to argue it was a rationalisation of history and
could not); the empty-helper reset — which works **even against the unscoped
`credential.helper = store`** in `/home/tm8/.gitconfig`, better than claimed.

## Three more credential channels (sub-doc 2 named four)

- **C5 `XDG_CONFIG_HOME` — outranks `HOME`.** `SAFE_BASE_ENV_KEYS` copies it from the server env,
  and `gh` resolves `GH_CONFIG_DIR` > `$XDG_CONFIG_HOME/gh` > `$HOME/.config/gh`. **A per-identity
  `HOME` is not sufficient.** Latent today (unset on the prod unit) — one operator `Environment=`
  line from silently reverting `gh` isolation with no error. `composeEnv` must set or clear XDG
  explicitly; `composeCredentialEnv` is already safe because it builds from scratch.
- **C6 `~/.git-credentials` + `credential.helper = store`** — live on this box, 0600, holding a
  token. Neutralised for github.com by the shipped reset, **unguarded for every other host**.
- **C7 `TM8_AGENT_TOKEN` is the human's full identity, not a reduced principal.**
  `issue_agent_auth_session` binds the *spawning human's* account; `acting_as_team_member_id`
  constrains `resolve_actor` only — `identity_id()`, `can_act_as`, `is_space_member` and
  `entity_readable` all key off identity. So once `credentials.*` exists, **an agent holding
  `TM8_AGENT_TOKEN` can call it as its owner** — read status, delete the token, start a login
  terminal in their name. §10 decision 8 says “human-initiated only” with no mechanism. The
  distinguisher exists — `auth_sessions.kind = 'agent'` — and the credential ops must check it.
  **This is a design addition, not a gap.**

*Checked and clean: no `~/.netrc`, no `~/.npmrc`, no `/etc/gitconfig`, no MCP servers (0 of 412
project entries).*

## Revised sequence

| PR | contents |
|---|---|
| **P0** | Delete the two `export GH_TOKEN` lines, rotate the PAT. **Ahead of everything** — live, silent, misattributes pushes (D7). Still unfixed at review time. |
| **PR0 (new)** | Socket attach authorization: make `ptyAuthorize` enforce what `grant_stream_attach` decides, or bind `p_token_hash` to the socket; carry view/drive on the upgrade. Socket-level test: Bob cannot attach or drive Alice's `share_mode='none'` session. **Worth doing whether or not credentials ship.** |
| **PR1′** | migration + RLS + RPCs **+** `and credential_provider is null` in `live_work_session_count` **+** the `repair_w1_foundations` guard, `node_id` NULL by construction. |
| **PR2′** | as before **+** `create_envelope` with `current_member_id`, never `resolve_actor` (D2), **+** assert no `GH_TOKEN`/`GITHUB_TOKEN` in the probe env and cross-check `gh api user` before storing (D6). |
| **PR3/4** | as written; PR4 explicitly carries the D4 list filters, incl. the legacy `packages/ui` screens. |
| **PR5** | as written, still last — **plus** explicit XDG handling (C5). |

Add to sub-doc 12 as blocking: **restart the staging node onto `5f01cc4` and prove the three
`gitCredentials.*` ops answer before treating 079 as shipped** (D9).
