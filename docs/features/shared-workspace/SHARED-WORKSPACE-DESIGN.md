# tm8 Shared Workspace — design

**Task:** `019fc00b-a167-709e-b6a6-40f0bcee75f6` · **Date:** 2026-08-02 · **Tree:** branch `staging`, HEAD `9f8b589`, working tree dirty (another lane holds the spawn files).
**Method:** direct file reads + call-graph trace from `packages/server/src/main.ts`, plus one live probe against the running staging node. Every current-state claim below carries a `file:line` or a command. Nothing is taken from `STATE.md` or the remote docs (both known stale).

---

## REVISION 2 (2026-08-02) — realigned onto tm8's own architecture, and a naming collision corrected

The owner answered the co-tenant question, and the answer moved the design: *"I should be able to dynamically add more users from the UI itself… a new server gets created, a database gets created, a new environment gets created, but nobody should be able to access it except that particular user."*

**That is not a new architecture. It is tm8's specified one, and it has been FINAL since 2026-07-25.** `docs/architecture/02-NODE-AND-GATEWAY.md` §4.3 defines the gateway's **hosted workspace spawner**: *"Provision/start/stop per-user tm8-server processes sharing the hub's Postgres cluster with **one database per workspace** (stronger isolation than schemas, same cluster — pinned per review Q1). Idle eviction … + per-workspace resource caps."* A new server, a new database, a new environment — the owner described §4.3 almost word for word, and Q1 records that one-DB-per-workspace was already decided deliberately over schemas.

Three consequences, and the first is a correction to this document:

**(1) The word "Workspace" was already taken, and I redefined it.** `02 §1` has used **Workspace** since July to mean *"the root container one server instance serves; one owner identity"* — which is very nearly what §2 below invented it to mean. Two incompatible definitions of the same word in one system is how a design gets built wrong twice. **This document now adopts tm8's vocabulary:** what §2 calls a Workspace is a **hosted workspace** on a hub node, and the execution boundary is the **node** that serves it. The *distinction* §2 draws — collaboration boundary vs execution boundary — survives intact and is still the load-bearing idea; only the label was wrong.

**(2) The component that does all of this does not exist.** Verified, not assumed: there is no `packages/gateway`, `maestro-gateway` is not vendored anywhere in the tree, and `grep -rln gateway packages --include="*.ts"` returns only comments and type notes in `identity/` and `sidecar/`. The gateway block is 0% built. What *does* exist is the half nobody would have guessed: `packages/server/src/sidecar/` is a complete Postgres cluster manager — `createdb` at `cluster.ts:236`, plus `migrate`, `backup`, `upgrade`, `health`, `lock`. **"A database gets created" already has working machinery; "a server gets created" has none.**

**(3) The architecture already forbids exactly what the owner is asking for, and says why.** `02 §4.3`, verbatim: *"**Execution is disabled by default on hosted workspaces** — enabling it is a node-admin capability per workspace, never a space role [R5]: hosted execution is arbitrary code execution on the hub; **process-per-user isolation is a start, not a sandbox.**"*

That is the same conclusion §3.1 of this document reached independently, written down a week earlier. It means the owner's request — every user running their own teammates in their own environment — **requires turning on the one thing the architecture deliberately turned off as unsafe.** So the work in this document is not an addition to §4.3; it is the precondition that makes §4.3's disabled flag safe to flip. That is the sharpest available statement of what this project is for.

Two things I no longer need to design, because they are already law: the hub trust model (`02 §4` [R4] — *"the hub operator is trusted… can technically act as any account homed on their node… Choose your hub like you choose your git host"*) is the blast-radius paragraph at §6.0, already ratified; and account recovery/revocation minimums are fixed by [R6].

---

## 0. One-paragraph answer

The ask is a multi-tenant tm8: one deployment, one API, one auth, N humans, each with their own execution environment — own GitHub credentials, own cloud credentials, own directories, own permissions — each running their own teammates, coordinated by a central teammate. The **data** half of this is already largely built and now genuinely enforced: RLS by space membership executes for real since the Stage-2 role downgrade (`070` + `db/client.ts`). The **execution** half does not exist at all, and it currently *inverts* the data half: every spawned agent runs as the tm8-server's own OS user, with the server's `HOME`, the server's `~/.claude` and `~/.ssh`, the server's LLM API keys, and — because no agent is ever issued a token — the server's **owner identity**. On today's tree, an agent that can shell out is the owner of every space on the node, so RLS protects nothing against an agent. This document introduces **Workspace** as a first-class *execution* boundary orthogonal to Space (the *collaboration* boundary), moves agent spawning out of tm8-server into per-workspace **runner** processes that run as their own unix users, and lists the rules that have to hold for "by any means, one user's space must not enter another's" to be a true statement rather than an aspiration.

---

## 1. Verified current state

### 1.1 The data plane is real (and better than the last audit says)

`docs/identity/AUTH-AND-IDENTITY-VERIFIED-STATE.md` (2026-07-31) leads with "the server connects as a superuser with `rolbypassrls` … migration 008's RLS policy set is largely inert on the read path." **That has since been fixed and the doc predates the fix.** Verified in this tree:

- `packages/server/src/db/client.ts:91-95` binds five values per transaction, including `set_config('role', $5, true)`, defaulting to `tm8_app` (`client.ts:215`). That is `SET LOCAL ROLE` — the downgrade the laws required.
- `db/migrations/070_entities_select_policy_restricted_projection.sql` exists *because* the downgrade made policies execute: its header records a linked project's projection vanishing from reads the moment `tm8_app` became real. A migration written to repair fallout from RLS actually running is strong evidence RLS actually runs.
- PTY attach is no longer unauthenticated: `packages/server/src/main.ts:294-321` gates the WebSocket upgrade on an RLS-governed read of the `work_sessions` entity under the caller's own claims, with not-visible and nonexistent both returning 404.
- Bearer tokens resolve: `main.ts:368-388` verifies `tm8s_…` against `auth_sessions` and carries `actingAsTeamMemberId` through as the actor.

So membership-scoped data isolation is a working mechanism, not a plan.

### 1.2 The execution plane has zero isolation

Four findings, each independently sufficient to break the requirement.

**(a) Every agent runs as the server's OS user.** `PtyHostService.spawn` (`packages/execution/src/pty/PtyHostService.ts:392-407`) calls `pty.spawn(shell, ['-c', command], { cwd, env })`. There is no `uid`/`gid` option, no privilege drop, no sandbox. The agent is the server process's uid, always.

**(b) Every agent inherits the server's home and the server's credentials.** `composeEnv` (`packages/execution/src/spawn/manifest.ts:628-702`) copies from the *server's* `process.env`:

```
SAFE_BASE_ENV_KEYS  = HOME, USER, LOGNAME, SHELL, PATH, LANG, LC_ALL, TERM,
                      COLORTERM, TMPDIR, XDG_CONFIG_HOME, XDG_CACHE_HOME   (manifest.ts:601-614)
AUTH_ENV_KEYS       = ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY,
                      GOOGLE_API_KEY, GOOGLE_GENAI_USE_VERTEXAI,
                      GOOGLE_GENAI_USE_GCA                                  (manifest.ts:591-598)
```

The `env` allowlist is carefully built to keep the *database* URL away from agents — and the comment at `PtyHostService.ts:403` says so explicitly. But one shared `HOME` means every agent on the node reads the same `~/.gitconfig`, the same `~/.ssh`, the same `~/.claude` credentials, the same cloud CLI config. Per-user GitHub or cloud credentials are not merely unimplemented; there is no place to put them.

**(c) No agent is ever authenticated.** `packages/cli/src/env.ts:9-11` documents `TM8_AGENT_TOKEN` as *"absent during G1A because the server binds loopback only (AM-4)"*. `grep -rn TM8_AGENT_TOKEN packages --include="*.ts"` returns **only test files** — nothing in `packages/server` or `packages/execution` ever sets it. `composeEnv` does not emit it.

**(d) No credential means owner.** `main.ts:385-386`: any request without a `tm8s_…` bearer falls through to `owner!()`, the loopback auto-owner. Combined with (c), every spawned agent's `tm8` calls are owner calls. Proven live, not inferred:

```
$ curl -s http://127.0.0.1:7778/v2/spaces
{"data":[{"id":"019fb752-…","name":"t3code",…},
         {"id":"019fb748-…","name":"tm8",…},
         {"id":"019f98d5-…","name":"Smoke Space 795791",…}], …}
```

Three spaces, no credential. That response is what *every agent on this node can get today*.

**The consequence to hold onto:** loopback is currently a trust boundary — `127.0.0.1` implies owner. In a multi-user node every user's agents are on loopback. The single most important structural change in this design is that **loopback stops meaning anything**.

---

## 2. The model: Workspace ⟂ Space

tm8 already has a boundary for *who sees what data*. It does not have one for *whose machine, whose uid, whose credentials, whose files*. Conflating them would be the obvious mistake, and it would fail the user's actual use case.

| | **Space** (exists) | **Workspace** (new) |
|---|---|---|
| Answers | who may read/write these entities | where and as whom agents execute |
| Enforced by | Postgres RLS on `members` rows | unix uid, filesystem mode, process boundary |
| Cardinality | many humans per space | **exactly one owner identity per workspace** |
| Shared? | yes, that is the point | never |

**The rule that makes the requirement satisfiable:** a work session launched by identity *U* executes in *U's* workspace, regardless of which space the task lives in. Two people can collaborate on one task, in one shared space, and each one's agent runs on their own credentials in their own filesystem, with no path from one to the other. **Shared data, private execution.**

### 2.1 The central teammate requests; it never impersonates

The identity lane surfaced the constraint that settles this, and Postgres already enforces it. `can_act_as` (`002:254-272`) permits acting as a persona **only if** that persona's `owner_member_id` is the caller's own member row, and node-admin explicitly does not widen it (`002:249-252`). That yields a fork with no third option:

- **(a) the central teammate owns every persona** — it can spawn and act as all of them, and every entity they create is attributed to the *central* identity. Per-user attribution is lost, and lost **irreversibly**: the distinguishing information is never recorded, so no later migration can recover it.
- **(b) each user owns their own persona** — attribution is correct per-user, and the central teammate cannot act as them.

**This design takes (b),** which is what the database already enforces, and it is the same conclusion the execution side reaches independently: coordination is a data-plane privilege and must never become an execution-plane one.

The refinement worth keeping, because (b) is otherwise read as "the hub can do nothing useful": **delegated *launch* is not delegated *identity*.** A hub that asks Alice's workspace to start a session — where the session runs on Alice's runner, under Alice's own persona token, minted by Alice's own identity — involves nobody acting as anyone else. `can_act_as` is satisfied trivially because Alice's workspace acts as Alice. `created_by` stays Alice. So the hub gets a real mechanism rather than a prose instruction: a **spawn request** is a first-class entity that the target workspace accepts or declines, and acceptance is what mints the token. The hub proposes work; the workspace consents and executes; attribution follows the executor. If a future requirement can only be met by the hub acting *as* someone, that is the design saying the boundary is in the wrong place.

### 2.2 What "hub proposes, workspace consents" still leaks

The identity lane stress-tested §2.1 and found three residual holes. None invalidates the shape; all three are real and the first is the one to design against.

**(1) Authority laundering — the gap that matters.** The hub cannot act *as* Alice, but it authors the request, and the request is the instruction Alice's agent executes with Alice's full authority. So the hub does not impersonate Alice, it **directs** her, and the graph truthfully records Alice as the author. That is worse than impersonation in one specific way: it is attributable, legitimate-looking, and leaves no trace that the hub composed it. `can_act_as` is satisfied and the property is still lost.

**The fix is that attribution must record who ASKED, not only who EXECUTED** — for a coordinator design those are different facts, and today the schema only captures the second. Two conditions, because a naive requester field would not survive contact:

- **Server-written, never payload-supplied.** The requester edge is written by the request path from the *authenticated requester's* identity — same discipline as R1's `workspaceId`. A requester field the hub fills in is a requester field the hub can omit.
- **It must outlive the requester.** If the hub can hard-delete its own request entity, provenance evaporates retroactively. The request tombstones; it does not vanish.

The cheap part: **the edge already exists.** `authored_from` is validated by migration 019 and has **zero producers** — measured, end to end. So this is not a new edge type, it is finally emitting one that was specified and never wired.

**(2) Consent by an agent is not consent by a human.** "The workspace consents" means nothing if Alice's runner auto-accepts — and it will, because auto-accept is what makes the system useful. Then the hub has Alice's authority with Alice's attribution and one indirection in between. So **acceptance is a policy Alice set in advance, not a judgement her agent makes at request time**: enumerable by her beforehand, visible to her afterwards. Two additions — the policy is itself a workspace-scoped, versioned entity so that "what was I auto-accepting at the time?" is answerable *after* the policy changes; and **the default is deny**, because an auto-accept default makes consent decorative on day one.

**(3) Aggregation.** The hub sees the results of every tenant's work by construction. That is not authority to act, but it is a cross-tenant read position nobody granted explicitly, and "not content" stops meaning "not sensitive" once it aggregates. Not fixable by design — only by stating it (§6.0) and deciding retention deliberately.

**And a bound: if acceptance mints a token, request *volume* mints credentials.** An unthrottled hub can mint unlimited tokens in Alice's name and exhaust her resources. **Rate-limit at the runner, not at the hub** — the hub is the thing being bounded, so the bound cannot live inside it. Same reasoning as R9 checking server-side rather than trusting a runner's own claim: put the control on the side that is not the subject of it.

**The central teammate** is a workspace like any other — the *hub* workspace, owned by the space owner. It coordinates through the graph: assigning tasks, sending messages, reading reported results. It has no ambient execution authority anywhere else, and there is deliberately no mechanism by which it could acquire any. Coordination is a data-plane privilege; it must never become an execution-plane one. (This is the same discipline `identity/types.ts` already applies to node-admin: node-level role never widens `can_act_as`.)

Sketch:

```
                    ┌──────────────────────────────┐
                    │  tm8-server   (one API,      │
                    │   one identity block,        │
                    │   holds the DB credential)   │
                    └───┬──────────┬──────────┬────┘
        runner protocol │          │          │        (authenticated, per-workspace)
                    ┌───▼───┐  ┌───▼───┐  ┌───▼───┐
                    │ hub   │  │ ws-A  │  │ ws-B  │    runner process
                    │ uid   │  │ uid   │  │ uid   │    own unix user, 0700 home
                    │ creds │  │ creds │  │ creds │    own GitHub/cloud creds
                    └───────┘  └───────┘  └───────┘
                       ▲           ▲          ▲
                    central     Alice's     Bob's
                    teammate    teammates   teammates
```

---

## 3. The Workspace Runner

**tm8-server must stop spawning PTYs.** As long as the process that holds the database credential is also the process that forks agents, "the agent runs as someone else" is unachievable without making the server privileged — which is worse.

**Design:** one **runner** process per workspace, running as its own unix user `tm8w-<slug>`, home `/srv/tm8/ws/<workspaceId>` mode `0700`, started by systemd (or launchd) as that user. The runner **dials out** to the server, authenticates with a workspace enrollment token, and thereafter receives spawn/input/kill commands and streams PTY bytes back.

### 3.1 Isolation strength — the decision, written down

The identity lane is right that this is the only question that decides how much of the requirement is real, and that it must be chosen deliberately rather than defaulted into.

**DECISION (Revision 2, owner-answered): containers, one per hosted workspace. Not unix users.** The owner said "whatever it might be, whether a Linux user or our own manager user" — leaving the mechanism to this lane — but then added the requirement that settles it: *"I should be able to dynamically add more users from the UI itself."*

**Self-service provisioning is itself the argument for containers,** and it is a stronger argument than the isolation table below:

- **Creating a unix user needs root and permanently mutates the host.** A UI button that runs `useradd` means the web-facing server can create OS accounts — the worst privilege surface in the system, and one that cannot be sandboxed because the whole point is that it modifies the host. Deprovisioning is worse: orphaned uids, leftover home directories, stale sudoers entries, and files owned by a uid that gets recycled to a different tenant later.
- **Creating a container is an API call to a daemon.** Reversible, needs no host mutation, and disposable — which is what makes "add a user from the UI" a safe operation rather than a privileged one. Rootless podman means the daemon is not root either.
- **Containers are the only rung that supplies what `02 §4.3` already requires.** Idle eviction and per-workspace resource caps are in the specification; cgroups provide them and unix users do not. A tenant who fork-bombs or fills the disk takes down every other tenant on a unix-user deployment.
- Each container runs its own tm8-server, its own database (in the shared cluster, per Q1), its own credentials and its own filesystem — which is "a new server, a new database, a new environment" exactly as asked.

Unix users remain a *fallback* for a single-tenant or dev deployment where no container runtime exists, and separate VMs stay the answer for tenants whose threat model needs a separate kernel. The original phrasing below (unix users first, containers as target) is superseded: the self-service requirement moved containers from target to baseline.

This is phaseable without a rewrite for one structural reason: the runner speaks a **network protocol**, so isolation strength is a *deployment variable*, not an architecture variable. The same runner binary runs as a systemd unit under `tm8w-alice`, inside a rootless podman container, or on a separate VM dialing in over TLS. Nothing above the protocol changes.

What each rung actually buys, because the differences are specific and not interchangeable:

| | unix users | + containers | + VMs |
|---|---|---|---|
| Cross-tenant file reads | **closed** (0700 homes) | closed | closed |
| `/proc/<pid>/environ` theft | **closed** — owner-only, so F6's cross-tenant half dies here | closed | closed |
| Process-list leakage (`ps`, cmdline) | open | **closed** (PID ns) | closed |
| Shared `/tmp`, world-readable server files | open — see §5 R8 | **closed** (mount ns) | closed |
| Reaching `127.0.0.1:4610` directly | open | **closed** (net ns) | closed |
| Resource exhaustion / fork bomb | open | **closed** (cgroups) | closed |
| Local privilege escalation → root | open | mitigated, shared kernel | **closed** |
| Cost | ~zero | low | a VM per tenant |

Two things fall out that are worth stating rather than discovering:

- **Unix users are load-bearing, not a token gesture.** They are the rung that closes F6 across tenants: `/proc/<pid>/environ` is readable only by the process owner and root, so the moment two workspaces are two unix users, one tenant can no longer steal the other's `TM8_AGENT_TOKEN`. That single fact is why R6 (no fallback to in-process spawn) is a hard failure rather than a warning.
- **Unix users leave loopback open,** which is why R3 (kill the auto-owner) is a *prerequisite* of Phase 2 and not a nice-to-have. Under unix users every tenant's agent can still open `127.0.0.1:4610`; the only thing standing between them and the whole graph is that the server demands a token. Containers close the port too, and are the reason containers are the target rather than the ceiling.

**Who the co-tenants are decides which rung is honest.** Members of one team who already trust each other and the box operator: unix users are proportionate. Mutually-distrusting tenants or paying customers: nothing below separate VMs honours "by any means", and offering less while claiming the requirement is met would be the worst outcome available.

Outbound dial, not inbound spawn, for three reasons:

1. **The server needs no privilege.** No root, no setuid helper, no `sudo` rule. The server can never become another uid because it never tries.
2. **It works off-host.** A runner on a separate VM behind NAT connects out the same way. That matters because "each user's own cloud credentials" ends at per-user VMs, and this design should reach that without a protocol change.
3. **The wire format already exists.** `@tm8/pty-protocol` plus `PtyHostService`'s framing already carry exactly these bytes. `PtyHostService` moves into the runner essentially intact; tm8-server becomes a relay between the browser WebSocket and the runner connection.

**The runner holds no database credential and cannot reach Postgres.** It speaks one protocol to one peer. It is, in exchange, the only thing that holds the workspace's secrets.

---

## 4. Credentials

The existing discipline is right and should be extended rather than replaced: `recordManifest` records **env var names, never values** (`spawn/types.ts:247`, and `SpawnResult.envVarNames` is documented "names only — values are never returned, logged or recorded"). Push that one hop further:

- The **server** composes the manifest and a list of env var *names* the session needs.
- The **runner** resolves those names to values from its own user-owned store (`$HOME/.tm8/secrets.env`, mode `0600`, owned by the workspace uid) and merges them into the child env.
- The server never holds a workspace credential. A full server compromise leaks the graph — it does not leak anyone's GitHub token, cloud key, or LLM key.

### 4.1 The agent token must leave the environment (review finding F6)

The identity lane flags `TM8_AGENT_TOKEN`-in-an-env-var as the weakest available storage, and for a multi-tenant node it is decisive. §3.1 closes the *cross-tenant* half — separate uids make `/proc/<pid>/environ` unreadable to the neighbour. But it leaves a second exposure that no isolation rung fixes, because it is inside the tenant:

**every child process the agent spawns inherits the token.** Agents shell out constantly. Every `npm install`, every build script, every MCP server, every `make` target receives the tenant's tm8 identity in its environment. A malicious postinstall script does not need to escape anything — it is handed the credential. Containers do not help; VMs do not help.

**So the runner becomes the credential store, and the token never enters any process env.** The runner already holds the workspace's secrets (§4); it holds this one too, and the CLI fetches it on demand over the runner's unix socket, authenticated by `SO_PEERCRED`. One more name the runner resolves — resolved *over a socket*, not *into an environment*. This is a refinement of §4 rather than a new mechanism, and it is the thing worth taking to the Tokens lane: F6's fix and this design's secret path are the same piece of work.

**`AUTH_ENV_KEYS` copy-from-server-env must be deleted on the workspace path** (`manifest.ts:665-668`). Leaving it means the operator's keys keep flowing into every workspace and the whole exercise is decorative. Same for `HOME`/`XDG_*` in `SAFE_BASE_ENV_KEYS`: those become **runner-supplied**, not server-inherited. `PATH`, `LANG`, `TERM` may stay server-supplied — they are not credentials and the agent's TUI needs them sane.

---

## 5. The rules that give "by any means" teeth

Each of these is a place where a plausible-looking implementation silently loses the property.

**R1 — `workspaceId` is server-derived from the caller's identity, never client-supplied.** Exactly the discipline `workdirPath` already has (`spawn/types.ts:80` "Absolute path, from public.projects.working_dir. NEVER client-supplied"; `types.ts:133` "Server-computed absolute path. The client never supplies this"). A spawn request that names its own workspace is a privilege-escalation primitive.

**R2 — every agent gets a real token.** An `agent`-kind `auth_sessions` row pinned to its `team_member` *and* its workspace, delivered as `TM8_AGENT_TOKEN`. The seam already exists and has never been used: `internal.acting_as()` reads `tm8.acting_as`, and `resolve_actor` is `coalesce(requested, actor_id(), current_member_id(space))` — a correctly-shaped, correctly-ordered claim slot that nothing in TypeScript has ever bound. Cost: near-zero new SQL.

**R3 — kill the auto-owner fallback, automatically.** The moment a node has more than one workspace, "no credential ⇒ owner" (`main.ts:385`) must become 401. This is a one-line change with a large blast radius (every local `tm8` invocation, every existing test that relies on loopback), which is exactly why it must be **derived from workspace count**, not an operator-set config flag. A config someone can forget to flip is a config that will be forgotten. Note this does not violate T-L7 ("auth is always on; local is the degenerate case") — it *completes* it: one workspace is the degenerate case and keeps today's behavior.

**R4 — a runner may only act on its own sessions.** Per-connection workspace authentication, and a server-side check on **every frame** that the addressed `work_session.workspace_id` matches the connection's workspace. Checking at attach time only is the classic mistake; session ids are guessable enough and long-lived enough that per-frame is the correct granularity.

**R5 — path containment, asserted twice.** Every server-computed path for a workspace must `realpath` under that workspace's root, checked **before and after** resolution. This is already implemented and battle-tested — `isContainedIn` in `execution/src/worktree/WorktreeManager.ts:39-44`, with the "realpath BOTH before and after" rule stated in that file's header. Reuse it; do not write a second one.

**R6 — no fallback to in-process spawn.** Once a node has workspaces, a spawn that cannot reach its runner must **fail loudly**. A degraded path that quietly runs the agent as the server's uid is precisely the outcome this design exists to prevent, and it is the shape these bugs always take.

**R7 — loopback is not a trust boundary.** Stated separately because it is a *mental* rule as much as a code one. Every `127.0.0.1 ⇒ trusted` assumption in the tree has to be found and re-examined; on a multi-workspace node, every user's agents are on loopback.

**R8 — the server's own files must stop being world-readable.** Verified defect, confirmed independently by the identity lane: `SpawnService.ts:742-747` writes the manifest with `writeFile(...)` and `:407`/`:705` create the scratch cwd with `mkdir(..., { recursive: true })`, **all with no `mode` argument**. Node defaults to `0o666 & ~umask` / `0o777 & ~umask` — measured on disk as 0644 files inside 0755 directories, 111 manifests + 13 scratch dirs on this node and 195 manifests on the identity lane's. Under unix-user isolation (§3.1) this is a cross-tenant read channel that survives every other control here, because it *bypasses* the uid boundary rather than crossing it.

**What is exposed is worse than "session metadata".** `manifest.agent.identity` is the **full persona text** — today's specialist personas run 5,400–7,000 bytes of mission brief each, and older ones carry bug theories, file pointers and ruled-out hypotheses. And per the identity lane: **the manifest is the only place a persona is visible at all** — `entity get` and the collection read do not surface it. So the single most context-dense artefact the system produces is also the one nobody classifies as sensitive, precisely because nothing else displays it.

**Three ways the obvious fix silently under-delivers** — all three are why this needs care rather than a one-line patch:

1. **`writeFile`'s `mode` applies only at creation, and the temp name is fixed.** `const tmp = \`${path}.tmp\`` (`:746`). If a `.tmp` survives a crash between write and rename, the next spawn writes *into the existing file* and it **keeps its old 0644**. `{ mode: 0o600 }` alone is therefore not sufficient — `chmod` explicitly before the rename, or unlink the temp first.
2. **`mkdir`'s `mode` applies only to directories it creates.** `~/.tm8-dev/manifests` already exists at 0755 on every node, so `{ recursive: true, mode: 0o700 }` changes **nothing** there. The existing directory must be chmod'd.
3. **Fixing the code remediates no existing file.** The manifests already on disk stay world-readable, and they are the ones that already exposed personas. A one-time sweep is part of the fix, not follow-up — and it must cover leftover `.tmp` files, which the glob for `*.json` will miss.

Manifests and scratch roots must be created 0600/0700 under the workspace uid. Cheap, live on every single-tenant node today, and exactly the class that ships silently because nothing observable changes when it is wrong.

*(Not a live vulnerability, noted so it is not re-derived later: a fixed-name temp file is a symlink-attack target only if its directory is writable by another user. It is 0755 today, so it is not exploitable — but it becomes exploitable the moment anything makes that directory group- or other-writable, which is a plausible mistake during multi-tenant provisioning.)*

**R9 — the workspace↔session check is belt-and-braces, not RLS alone.** R4's per-frame comparison must be an *explicit server-side check*, in addition to whatever RLS policy governs the workspace tables. The identity lane's warning is the reason: every RLS policy written since migration 008 had never executed in production until the role downgrade landed, so the policy surface accumulated untested and migration 070 is the first result of running it rather than a one-off. This design leans on the OS for user-to-user *execution* isolation, but it leans on the database for *which runner may drive which session* — and that is not a place to rely on a control whose track record is "never ran".

---

## 6. What this does *not* protect against

Stated plainly, because a security design that overclaims is worse than none. Trust that is written down is a design; trust that is assumed is a vulnerability.

### 6.0 Blast radius, in one paragraph

**The operator of this box can read any user's credentials and act as any user.** Root reads every workspace's home directory, every secret store, every session token, the memory of every running agent, and the Postgres data directory underneath all of it. No control in this document constrains root, and none can: the isolation here is between *tenants*, never between a tenant and the machine's administrator. Every co-tenant therefore trusts the box operator absolutely. That is a property of shared hosting, not a defect in this design — but a prospective tenant who cannot accept it does not need a better configuration, they need their own box, and "run your own node" is a legitimate and fully-supported answer.

- **The hub accumulates a cross-tenant read position.** By construction it sees the results of every tenant's work (§2.2 hazard 3). No control here prevents that — it is what coordination *is*. It is disclosed rather than mitigated, and how long those results are retained is a deliberate decision, not a default.
- **Shared data stays shared.** If Alice and Bob are both members of a space, their agents read the same rows and can message each other. This isolates *environments*, not information anyone deliberately shared. If two users must not see each other's *data*, they need separate spaces — which already works.
- **A compromised tm8-server reaches every workspace.** It issues the commands. It cannot read a workspace's secrets (§4), but it can tell a runner to execute something as that user. The server is the trusted computing base; that is inherent to one-API-one-auth, which is what was asked for.
- **Unix users are not a sandbox against kernel escapes.** They stop `cat ~alice/.ssh/id_ed25519`; they do not stop a local privilege-escalation exploit. Containers or per-user VMs are the next rung — and because the runner protocol is a network protocol, that is a **deployment swap, not a rewrite**. Design for it now, build it later.
- **macOS is single-workspace only.** Per-user unix accounts + launchd per user is not a road worth walking on a dev laptop. Multi-workspace on darwin must **refuse to start**, not silently collapse to one uid.
- **Nothing here constrains what an agent does with its own credentials.** Alice's agent has Alice's GitHub token and can push anywhere Alice can. That is the point of giving it her credentials.

---

## 6.5 Provisioning is the most dangerous surface in the system

Self-service provisioning creates servers, databases, containers and credentials from a web request. It deserves its own rules, because a defect here does not leak one tenant — it manufactures them.

**P1 — never interpolate client input into an identifier.** Container names, database names, filesystem paths and unix identifiers derive from a **server-minted UUID**, never from the display name the user typed. `createdb` with a user-supplied name is a textbook injection, and the sidecar's `createdb` (`cluster.ts:236`) is a real code path that would carry it. The display name is data: stored, shown, never used to name anything.

**P2 — node-admin only, and rate-limited.** `02 §4.3` already makes enabling execution a node-admin capability per workspace [R5]; provisioning itself is the same class. Rate-limiting is not abuse-prevention here, it is cost control: each provision is a database and a container.

**P3 — provisioning must be idempotent and rollback-safe, because partial tenants are the normal failure.** Container up but database missing; database created but migrations failed; both up but credentials never written. Each of these leaves a tenant that *looks* provisioned. This is not hypothetical on this infrastructure — Utho VMs have been observed reporting `Running` with IP addresses assigned and no working NIC, where the only tell was a zero byte-count. **A provisioning step that reports success is not evidence the tenant works;** the check is an end-to-end probe as the new tenant, not the sum of the create calls.

**P4 — deprovisioning must be designed as carefully as provisioning.** An orphaned tenant still holds credentials. Removal has to cover the container, the database, the secret store, the filesystem, the auth sessions and the routing entry — and the design should say what happens to the *graph* history the tenant authored, because [R6] already rules that authored history survives account revocation.

**P5 — the provisioner is the one privileged component; keep it tiny and auditable.** Everything else in this design is deliberately unprivileged. The provisioner is not, and it is the one place where a code-review miss becomes a host compromise rather than a tenant compromise.

---

## 7. Phasing

**Phase 0 — close the open door.** Independent of workspaces; every one of these is a live defect today and worth landing regardless of whether the rest is ever built.
- Issue `TM8_AGENT_TOKEN` for spawned agents; bind `tm8.acting_as` (R2).
- Derive auto-owner shutoff from workspace count (R3) — lands inert at count ≤ 1.
- Stop copying `AUTH_ENV_KEYS` from the server env; route through named-secret resolution (§4).

**Phase 1 — workspace as data.** `public.workspaces` + membership; `workspace_id` on `work_sessions`, `projects`, `worktree_allocations`; RLS; CLI noun; R1 enforcement in `SpawnService`. No behavior change yet — one workspace, today's semantics.

**Phase 2 — the runner.** Protocol, enrollment, per-workspace unix user provisioning, `PtyHostService` relocation, server becomes relay. R4/R5/R6 land here.

**Phase 3 — the vault.** Per-runner secret store; manifest carries names only, end to end.

**Phase 4 — hub teammate + fan-out.** Central-teammate UX, cross-workspace task assignment (data-plane only), off-host runners — which is where per-user cloud credentials naturally live.

**Phase 5 — containers/VMs** as a deployment swap behind the unchanged runner protocol.

Phase 0 is small and independently valuable. Phase 2 is the expensive one and the one that actually delivers the requirement; everything before it is groundwork and everything after is reach.

---

## 8. Open questions for the owner

1. **~~Who are the co-tenants?~~ ANSWERED (Revision 2).** Self-service provisioning from the UI, per-tenant server + database + environment, no cross-tenant access. Settled as containers per §3.1; the mechanism question is closed.
2. **Does a workspace map 1:1 to a human, or may one human hold several?** The design assumes one *owner identity* per hosted workspace — which `02 §1` independently requires — but does not forbid a person owning several (work/personal credential sets). Cheap now, expensive to retrofit.

3. **THE NEW ONE, and it is the only thing that could make this work wrong: how do tenants collaborate once each has their own database?** One database per hosted workspace (Q1) means Alice's entities are not in Bob's database and not in the hub's. A central teammate cannot see Alice's tasks with a query, because there is no shared table to query. `02 §3` already answers this and the answer should be confirmed rather than assumed: **collaboration happens in the hub's own shared space, which everyone acts in directly; private work happens in your own hosted workspace, which pulls from that shared space over the bridge (T-L6, workspace↔workspace).** So §2's "shared data, private execution" holds *inside the hub's shared space* and does not stretch across hosted workspaces.

   Two things follow that the owner should see before building: the central teammate coordinates in the shared space and is **blind to a tenant's private workspace by construction** — which is the isolation working, not a bug — and the bridge that carries pull/report-back **is also unbuilt** — measured, not inferred: the contract catalog contains exactly **one** bridge operation, `bridge.fetchBlob`, status `reserved`, `not_implemented`, with no public command (`catalog.ts:120`; `tm8 help bridge` confirms "Reserved Phase-2 cross-node blob path — no public command"). There is no pull, no report-back, no event subscribe. The only working cross-node code in the tree is `http/remote-proxy.ts`. So if tenants must genuinely collaborate rather than merely coexist, **the bridge is on the critical path, it is a larger piece of work than the provisioner, and today it is one reserved endpoint.**

**Closed since the first draft.** *"May the hub launch into a member's workspace?"* — resolved by §2.1. The hub requests and the workspace consents; nothing ever acts as anyone else. `can_act_as` already enforces it, and choosing otherwise would destroy per-user attribution irreversibly. *"Utho box or per-user VMs?"* is no longer the framing: §3.1 makes isolation strength a deployment variable behind an unchanged runner protocol, so the box choice follows from question 1 rather than preceding it.
