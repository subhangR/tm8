# Session Hooks — the architectural foundation (LLD)

Status: **PROPOSED**. Nothing here is built.
Author: Opus 5 Teammate, session `019fdae8-4783-7c56-9964-073a546ef1b4`, 2026-08-07.
Anchor: task `019fdae7-4b38-789f-b3d2-36dc199ae360`.

Two sibling research sessions are running in parallel and their reports land beside this
one (`RESEARCH-maestro-spells.md`, `RESEARCH-ao-hooks.md`). This document is written to
be **readable without them** and to be **corrected by them**. Where a claim depends on
something they are verifying, it is marked `[SIBLING]`.

---

## 0. Provenance of the claims in this document

Every mechanism below was read out of this tree or probed on this machine today. Two
classes are separated deliberately, because the difference is the difference between a
design and a wish.

**Verified by reading the tree** (file:line cited inline):
spawn sequence, env allowlist, workspace-trust behaviour, `work_sessions` schema and its
single-writer transition RPC, the PTY host's total absence of output parsing, the edge
type registry and `write_edge`, the attention RPC, the event ledger, the catalog.

**Verified by probing the installed agent binaries on this machine today**:
Claude Code `2.1.77` at `/Users/subhang/node_modules/@anthropic-ai/claude-code/cli.js`,
Codex `codex-cli 0.145.0` at `/Users/subhang/.local/bin/codex`. These are string-table
and `--help` probes, not documentation. They are strong enough to design against and
**not** strong enough to ship against; §12 names the live probe each one owes.

**Not verified, and said so**: everything marked `[UNPROVEN]`.

---

## 1. What this is for

The ask was "hooks", but hooks are a transport. The thing actually wanted is:

> **tm8 should learn facts about a session from the agent itself, continuously, and turn
> those facts into graph state — edges, status, attention — without the agent having to
> volunteer them.**

Today every durable fact about a session's *work* arrives by the agent's goodwill. An
agent that never calls `tm8 message send` did, as far as the graph is concerned, nothing.
An agent that edits nineteen files leaves no edge to any of them. An agent sitting on a
permission dialog is drawn as `running` forever, because the only evidence is pixels in a
PTY that nothing reads.

Hooks close that gap by moving the reporting burden from the agent's *intent* to the
agent's *harness*. The harness fires whether or not the agent cooperates, whether or not
the agent is well-prompted, and whether or not the agent is Claude.

### 1.1 The derivations this is meant to unlock

Named here so the transport is designed against real consumers rather than against the
idea of hooks. Each is expanded in §9.

| # | Derivation | Fired by | Writes |
|---|---|---|---|
| R1 | Session activity (busy / quiet / waiting / blocked) | session_start, user_prompt_submit, stop, permission_request, session_end | `work_sessions.activity` |
| R2 | Attention request on a blocked agent, auto-resolved when it unblocks | permission_request → post_tool_use | `attention_requests` |
| R3 | File-provenance edges: which files a session actually touched | post_tool_use (Write/Edit) | `touched` edges |
| R4 | Task work status: `open` → `working` on first turn | user_prompt_submit | `tasks.work_status` |
| R5 | Close-out enforcement: session ended with no durable message on its anchor | session_end | `attention_requests` |
| R6 | Turn accounting: how many turns a session actually took | stop | `session_hook_events` (read model) |
| R7 | Memory capture before context is lost | pre_compact | doc / memory entity |
| R8 | `created_in` promoted from a client claim to a harness fact | post_tool_use | `created_in` edge props |

R1 and R2 are the ones that change the product. R3 is the one that makes the graph a
graph. The rest are cheap once the transport exists.

---

## 2. What already exists — the seam is mostly built

This is the most important section in the document, because it determines how much of
this is new architecture (little) and how much is wiring (most).

### 2.1 tm8 already carries session identity into any child process

`composeEnv` (`packages/execution/src/spawn/manifest.ts:721-826`) injects into the agent
process, always:

```
TM8_SESSION_ID      the work_session uuid
TM8_SPACE_ID        the space uuid
TM8_BASE_URL        where to report back
TM8_TEAM_MEMBER_ID  the persona
TM8_TASK_IDS        comma-separated task uuids
TM8_AGENT_TOOL      claude-code | codex | ...
TM8_MODE            worker | coordinator | ...
TM8_MANIFEST_PATH   absolute path to the launch manifest
```

and, when issued, `TM8_AGENT_TOKEN` — a session-bound credential minted by
`issue_work_session_agent_session` (`packages/server/src/facade/execution-handlers.ts:323-339`).
It also **prepends the built CLI's dist directory to `PATH`**, which is why a spawned
agent can type `tm8` at all.

A hook is a subprocess of the agent. Subprocesses inherit the environment. Therefore:

> **A hook command in a tm8-spawned session is already authenticated, already
> session-bound, already space-scoped, and already has `tm8` on its `PATH` — with no new
> plumbing whatsoever.**

This is the piece Agent Orchestrator had to invent (it writes a session id into the hook
config file at spawn). tm8 gets it for free from work already shipped. It collapses the
hardest part of the design into a single sentence: **the hook command is
`tm8 hook emit <event>` and it needs no arguments beyond the event name.**

The direct consequence, which resolves §6.3's worst hazard before it is raised: because
identity comes from the *environment* and not from the *file*, the hook config file does
not need to be per-session. Two sessions sharing a project working directory can share
one hook file and still report as themselves.

### 2.2 tm8 already writes agent config at spawn

`packages/execution/src/spawn/workspace-trust.ts` already reaches into agent
configuration before the PTY opens:

- Claude: `~/.claude.json` → `projects[realpath(cwd)].hasTrustDialogAccepted = true`
  (lines 88-137, read-modify-write under a serialising promise queue, mode `0o600`).
- Codex: `~/.codex/config.toml` → appends `[projects."<path>"]\ntrust_level = "trusted"`
  (lines 156-197, **append-only, never parsed**, idempotent by regex probe).

Both are best-effort, never fail the spawn, and are opt-out via
`TM8_AUTO_TRUST_WORKSPACE=false`. Called from `SpawnService` at line 556-557, before PTY
spawn.

So the *act* of writing agent config at spawn is precedent, not innovation. §6 rules on
**where** hook config may be written, which is emphatically not where trust is written.

### 2.3 What is missing

| Layer | State |
|---|---|
| Session identity in the hook process | **exists**, free (§2.1) |
| Writing agent config at spawn | **exists** (§2.2) |
| An `activity` field distinct from `status` | missing — designed in `SESSION-ACTIVITY-SEPARATION-DESIGN.md`, PROPOSED, unbuilt |
| Any PTY output parsing | **deliberately absent** — `PtyHostService` tracks only `lastOutputAt`; no content scanning anywhere |
| An ingress for agent-emitted events | missing |
| A normalized event vocabulary across agent tools | missing |
| A rule layer turning events into graph writes | missing |
| Hook config at any scope | missing |

Note the shape: **three of eight rows are already green, and one of the missing rows is
already designed.** This is a wiring project with one genuinely new subsystem (the rule
layer), not a new platform.

---

## 3. Architecture

Four layers, each with exactly one job, and a hard rule at every boundary.

```
  ┌──────────────────────────────────────────────────────────────────────┐
  │ 1. EMITTER — inside the agent process                                │
  │    agent harness fires a hook  →  `tm8 hook emit <native-event>`     │
  │    identity from env. fail-open. non-blocking. spools on failure.    │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │  POST /v2/sessions/:id/hook-events
  ┌───────────────────────────────▼──────────────────────────────────────┐
  │ 2. INGRESS — server                                                  │
  │    authenticate, ADAPT native event → canonical event, append.       │
  │    Append-only. Never decides anything. Never writes the graph.      │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │  session_hook_events (durable, ordered)
  ┌───────────────────────────────▼──────────────────────────────────────┐
  │ 3. REACTOR — server, rule-driven                                     │
  │    canonical event + session state  →  zero or more EFFECTS          │
  │    Pure function of (event, current state, rule set). Idempotent.    │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │  effects
  ┌───────────────────────────────▼──────────────────────────────────────┐
  │ 4. EFFECTS — EXISTING operations only                                │
  │    write_edge · create_attention_request · activity transition ·     │
  │    set_work_status · messages.post                                   │
  │    The hook system gets NO write path of its own.                    │
  └──────────────────────────────────────────────────────────────────────┘
```

### D1 — The hook system is a producer of facts, never an owner of state

**Ruling: layer 4 introduces no new write path into the graph.** Every effect a hook can
have is an existing operation, called with the hook's actor, subject to the same RLS, the
same idempotency ledger, the same event emission.

This is not tidiness. tm8 already carries a scar from the alternative:
`tracking.refresh` (migration 017) writes to a queue **nothing processes**. A hook
subsystem that grows its own writers becomes a second, unaudited graph API, and the first
time the two disagree the debugging cost exceeds everything hooks ever bought.

Corollary: if a derivation needs an operation tm8 does not have, that operation gets built
**as a first-class operation**, catalogued and available to humans and to the CLI — not as
a hook-only side door.

### D2 — Layer 2 never decides; layer 3 never transports

The ingress writes a row and returns `202`. It does not resolve rules, does not look at
prior state, does not write the graph. The reactor never talks to an agent.

This is what makes the whole thing testable: the reactor is a pure function you can drive
with a fixture stream of canonical events and assert effects on, with no PTY, no agent, no
network. Every prior tm8 defect in this area lived in the gap between two well-tested
halves (`SESSION-ACTIVITY-SEPARATION-DESIGN.md` §8); a seam this sharp is the only known
cure.

### D3 — Fail-open, always, at every layer

**A hook must never be able to stop an agent from working.**

Claude Code hooks can *block* — a `PreToolUse` hook exiting non-zero, or returning
decision JSON, denies the tool call. Codex's hook payloads carry the same shape.

> **Ruling: tm8's default hooks always exit 0 and never emit a decision.** They are
> one-way telemetry. Blocking is not in scope for Phase 1, Phase 2 or Phase 3, and if it
> is ever in scope it arrives as a separate, explicitly-named, opt-in hook class.

The reasoning is blunt: tm8's server and the agent are on the same machine only by
accident of the current deployment. A tm8 hiccup that can deny tool calls converts an
outage of tm8 into an outage of **every agent on the box**, including agents doing
unrelated work, including the human's own terminal if the hook ever reaches a global
config file (which §6 forbids for exactly this reason).

### D4 — Hooks are on the agent's latency budget, so they must not spend it

Hooks run **synchronously inside the agent's turn**. Codex's configured handler carries an
explicit `timeoutSec`; Claude Code applies a default timeout. Every millisecond a hook
spends is a millisecond the agent is not working, multiplied by every tool call.

> **Ruling: `tm8 hook emit` has a hard local budget — ~200 ms connect, ~1 s total — and
> never retries inline.** On any failure or timeout it appends the event to a local spool
> (`${dataDir}/hooks/${sessionId}.jsonl`, mode `0o600`, the journal's existing pattern)
> and exits 0 immediately.

Durability is bought by the spool, not by blocking. A later successful emit, or a server-
side drain, replays the spool. §7.3 gives it an idempotency key so replay is safe.

This is the inverse of the usual instinct and it is deliberate: an event delivered late is
a small loss; an agent stalled per-tool-call is a large one.

### D5 — One canonical vocabulary; adapters map into it, never out of it

The reactor must never contain `if (agentTool === 'codex')`. Agent differences are
resolved once, at ingress, by the adapter (§5), and never again.

### D6 — Missing evidence is a state, not a default

Following AO and the session-activity design: the *absence* of a hook record is a real,
distinct fact — "the pipeline is not reporting" — and must never be collapsed into
"the agent is resting". `NULL` says it; nothing else may.

The operational payoff is the one that matters: a broken hook pipeline must look like a
broken hook pipeline, not like a room full of idle agents.

---

## 4. Scopes and resolution

The ask named this explicitly: *"for each agent session local hooks, default hooks, hooks
on different scopes"*.

### 4.1 The four scopes

| Scope | Lives on | Set by | Purpose |
|---|---|---|---|
| `builtin` | the node, in code | tm8 itself | the derivation hooks of §1.1. Always installed, cannot be removed, only disabled wholesale by `TM8_HOOKS_ENABLED=false` |
| `space` | `spaces` | space owner/admin | policy for every session in the space |
| `teammate` | `team_members` | whoever configures the persona | per-persona behaviour |
| `session` | `work_sessions` | the spawner, at spawn, via the manifest | one-off, per-run |

`builtin` is a scope and not a hardcode because it must be **inspectable**: an operator
has to be able to ask "what is going to fire in this session, and why" and get a complete
answer. A rule you cannot list is a rule you cannot debug.

### 4.2 Resolution — merge by id, never replace the collection

The effective hook set for a session is the **union of all four scopes**, keyed by
`(scope, hookId)`, with a more specific scope overriding a less specific one **for the
same `hookId` only**.

> **Ruling: resolution merges by id. A narrower scope MUST NOT be able to replace the
> whole collection.**

This is a scar, not a preference. tm8 has already lost work to exactly this shape —
concurrent lanes each rewriting a whole collection where an append was meant, silently
dropping the other lane's entries. A hook set is a collection under concurrent edit from a
space admin, a persona author and a spawner. It must merge.

Explicit disable is therefore also by id: a narrower scope sets `enabled: false` on a
`hookId` it wants gone. There is no "clear all", because "clear all" is how you silently
turn off R2 for the whole space and find out three weeks later.

### 4.3 Precedence, and the one thing precedence may not do

`session` > `teammate` > `space` > `builtin`.

**A narrower scope may not disable a `builtin` hook that the space has marked
`required`.** Otherwise a persona author can opt an agent out of being observed, which is
precisely backwards: observation exists because agents cannot be relied upon to
self-report.

### 4.4 What a scope may configure

A hook definition is deliberately small. It is **not** a scripting surface.

```ts
interface HookDefinition {
  hookId: string;               // stable, e.g. 'tm8.activity', 'tm8.file-provenance'
  scope: 'builtin'|'space'|'teammate'|'session';
  events: CanonicalEvent[];     // which canonical events it subscribes to
  enabled: boolean;
  match?: { toolName?: string };// narrow within an event
  effects: EffectRef[];         // named, registered effects. NOT arbitrary code.
}
```

`effects` are **references to registered effect implementations**, not code, not shell,
not templates. A space admin composes from a catalogue; they do not author behaviour.

> **Ruling: a hook definition can never carry an executable string.** The moment a
> space-scoped config field becomes a shell command, any space member with config write
> access has remote code execution on every node that runs a session for that space. tm8
> is multi-tenant with RLS; this is not a theoretical objection.

This is the sharpest divergence from every prior art in reach. Claude Code hooks, Codex
hooks and (almost certainly `[SIBLING]`) maestro's Spells all take a command string,
because all of them are single-user tools where the config author and the machine owner
are the same person. In tm8 they are not, and the design must not pretend otherwise.

The escape hatch, if one is ever needed, is a `session`-scoped hook supplied by the
spawner — because the spawner already chose the command line, already chose the access
mode, and already has the authority the hook would grant. That is the only scope where a
command string could ever be defensible, and it is out of scope here.

---

## 5. Agents and adapters

The requirement was explicit: *"they should work for codex, claude and other agents as
well"*.

### 5.1 What the installed agents actually offer

Probed on this machine today (§0). This is the load-bearing table of the whole document.

**Claude Code 2.1.77** — 11 hook events, from the bundle's own string table:

```
PreToolUse   PostToolUse   UserPromptSubmit   Notification   Stop
SubagentStart   SubagentStop   SessionStart   SessionEnd
PreCompact   PostCompact
```

Config: `settings.json` / `settings.local.json` / `managed-settings.json` (all three
present in the bundle). Hook payload arrives on stdin as JSON; `session_id`,
`transcript_path`, `cwd`, `tool_name`, `tool_input`, `tool_response` are confirmed field
names in the bundle.

**Codex 0.145.0** — `hooks` is a **stable, enabled feature** (`codex features list`).
10 hook events, from the binary's string table:

```
pre_tool_use   post_tool_use   permission_request   user_prompt_submit
session_start  session_end     subagent_start       subagent_stop
pre_compact    post_compact
```

Config: a `hooks.json` file; handlers execute via `SHELL -lc`. The configured-handler
struct carries `eventName`, `handlerType`, `timeoutSec`, `sourcePath`, `displayOrder`,
`isManaged`, `currentHash`, `trustStatus`. There is a `HookScope` and a `HookSource`, so
Codex has its own multi-scope model that tm8's §4 must be layered *on top of*, not fought
with.

### 5.2 The capability matrix, and the finding that inverts the prior art

| Canonical event | Claude Code 2.1.77 | Codex 0.145.0 |
|---|---|---|
| `session_start` | `SessionStart` | `session_start` |
| `session_end` | `SessionEnd` | `session_end` |
| `turn_start` | `UserPromptSubmit` | `user_prompt_submit` |
| **`turn_end`** | **`Stop`** | **— none —** |
| `tool_pre` | `PreToolUse` | `pre_tool_use` |
| `tool_post` | `PostToolUse` | `post_tool_use` |
| **`permission_wait`** | **`Notification`** (weak: also fires for non-permission notices) | **`permission_request`** (strong: purpose-built) |
| `subagent_start` | `SubagentStart` | `subagent_start` |
| `subagent_end` | `SubagentStop` | `subagent_stop` |
| `pre_compact` | `PreCompact` | `pre_compact` |
| `post_compact` | `PostCompact` | `post_compact` |

Two asymmetries, and they run in **opposite directions**:

1. **Codex has no turn-boundary event.** Claude's `Stop` is a real "the turn ended"
   signal. Codex has nothing between `user_prompt_submit` and `session_end`. So R1's
   `busy → quiet` transition is directly reportable on Claude and must be *inferred* on
   Codex.
2. **Codex has a purpose-built `permission_request`; Claude does not.** Claude signals a
   pending permission through `Notification`, which also fires for other notices — so on
   Claude, `permission_wait` is a *guess* unless the payload distinguishes it
   `[UNPROVEN]`, whereas on Codex it is a *fact*.

This matters because it **inverts the prior art already recorded in this repository**.
`SESSION-ACTIVITY-SEPARATION-DESIGN.md` §4.4 records AO's finding that Codex declares
`EmitsBlockedActivity() == false` — *"it installs no post-tool-use hook, so a blocked
state could never be cleared mid-turn"* — and therefore must never be auto-nudged.

**Codex 0.145.0 has both `permission_request` and `post_tool_use`.** The capability that
was structurally absent when AO measured it now exists. Any tm8 design that copies AO's
capability table verbatim would ship a permanent, wrong pessimism about Codex.

The lesson generalises past this instance: **the capability matrix is version-scoped
runtime state, not a constant.** Which is D7.

### D7 — Capability is declared per adapter, per version, and is probed — never assumed

```ts
interface HookCapability {
  agentTool: string;
  probedVersion: string;          // the version this was measured against
  supports: Record<CanonicalEvent, 'native'|'absent'|'weak'>;
  emitsTurnEnd: boolean;
  emitsPermissionWait: boolean;
  clearsPermissionWait: boolean;  // has tool_post to close a permission_wait
}
```

`weak` is a first-class value and earns its keep immediately: it is exactly Claude's
`Notification`, and a `weak` signal may set `waiting` but may never justify confident
copy (D6 of the session-activity design).

The capability record carries `probedVersion` because it will go stale. When the installed
version does not match `probedVersion`, the honest behaviour is to **degrade to the
intersection and surface a warning**, not to assume the table still holds.

### 5.3 Adapters that must exist

- `claude-code` — full.
- `codex` — full, minus `turn_end`.
- **`generic`** — the floor. An agent tool with no hook system at all still gets
  `session_start` and `session_end`, because tm8 spawns and reaps the process itself and
  knows both without asking anyone. Everything else is `absent`, activity is `NULL`, and
  the UI says "no signal". `echo-agent`, `gemini` and `hermes` land here until measured.

The `generic` adapter is what makes the claim "works for other agents as well" honest
rather than aspirational: unknown agents get a real, small, correct set — not a silent
nothing, and not a pretence of coverage.

---

## 6. Where hook config is written

### 6.1 The rule

> **Ruling: hook configuration is written into the session's working directory, never
> into a user-global agent config file.**

`workspace-trust.ts` writes to `~/.claude.json` and `~/.codex/config.toml` — *user-global*
files shared by every session on the machine **and by the human's own terminal**. Writing
a hook there would fire `tm8 hook emit` inside the user's personal Claude sessions,
reporting their private work to a tm8 space, and — under D3's forbidden alternative — a
tm8 outage would break the human's own tooling.

Trust can live in a global file because it is idempotent, additive, per-path and
meaningless outside the path it names. A hook is none of those things.

Targets:

| Agent | File | Written |
|---|---|---|
| `claude-code` | `<cwd>/.claude/settings.local.json` | merge into `hooks`, preserving anything already there |
| `codex` | `<cwd>/.codex/hooks.json` | merge, preserving `sourcePath`/managed entries |
| `generic` | none | server-side only |

Both are gitignore-worthy and the installer must add them to `.git/info/exclude` for
project-mode sessions rather than to `.gitignore`, which is a tracked file it has no right
to modify.

### 6.2 Merge, never overwrite

Same ruling as §4.2, for the same reason, one layer down: a developer's own
`.claude/settings.local.json` in a project directory is *their* file. tm8 adds its hook
entries by `hookId` and removes only its own. `workspace-trust.ts` already models the
discipline — it never overwrites an existing entry (lines 88-137) — and that behaviour is
the precedent to copy.

### 6.3 The shared-cwd case, which is not a problem

Project-mode sessions share one working directory
(`resolveWorkdir`, `packages/execution/src/spawn/manifest.ts:300`), so N concurrent
sessions share one hook file. This looks like a blocker and is not, because of §2.1: the
hook command is byte-identical for every session and identity comes from the environment.
One file, N sessions, correct attribution.

What *is* a real hazard is the write race — N spawns merging into one file concurrently.
`workspace-trust.ts` already solved this with a serialising promise queue
(`trustUpdateTail`); the hook installer uses the same mechanism, and additionally must be
idempotent so a lost race is harmless rather than corrupting.

### 6.4 Codex's trust gate — a live blocker until proven otherwise

Codex's configured-handler struct carries `trustStatus`, `currentHash` and `isManaged`,
and the binary contains strings about *"skipping materialized plugin hook trust after
account changed"* and *"failed to trust materialized plugin hooks"*.

The plain reading is that **Codex hashes hook files and gates execution on trust**. A
`hooks.json` that tm8 materialises may therefore be installed, syntactically valid, and
**silently never run**.

This is the highest-risk unknown in the document, and it is exactly the failure shape tm8
keeps re-learning: a configuration that looks applied, produces no error, and does
nothing. It must be settled by a live probe (§12.1) before any Codex work is scheduled,
and the probe must assert the hook **fired**, not that the file exists.

---

## 7. Data model

Highest committed migration in this tree is **073**. Memory records 074 and 076 existing
elsewhere, and a known checksum-drift incident around 072. **Verify the next free number
at implementation time and never `create or replace` a function another lane owns.**

### 7.1 `session_hook_events` — append-only, the system of record

```sql
create table public.session_hook_events (
  id                uuid primary key,
  space_id          uuid not null references public.spaces(id),
  work_session_id   uuid not null references public.work_sessions(entity_id),
  seq               bigint not null,          -- per session, monotonic
  event             text not null,            -- CANONICAL vocabulary (§5.2)
  native_event      text not null,            -- exactly what the agent said
  agent_tool        text not null,
  occurred_at       timestamptz not null,     -- agent clock
  received_at       timestamptz not null default now(),
  tool_name         text,
  correlation_id    text,                     -- tool_use id, for pre/post pairing
  payload           jsonb not null default '{}'::jsonb,
  emit_key          text not null,            -- idempotency (§7.3)
  unique (work_session_id, emit_key)
);
```

Both `occurred_at` and `received_at` exist because the spool (D4) makes them genuinely
different, and collapsing them would destroy the only evidence that the pipeline was
lagging.

`native_event` is stored beside `event` because the adapter mapping **will** be wrong at
least once, and when it is, the raw record is the only thing that permits a re-derivation
without re-running the agents.

Retention: a session's hook stream is bounded by its life, but a busy agent fires
`tool_pre`/`tool_post` per tool call and that is the highest-volume table tm8 would have.
Ruling: retain in full for live sessions; compact to counters on session exit. Volume
must be **measured** in Phase 1, not assumed (§13.3).

### 7.2 `work_sessions.activity` — adopted wholesale, not redesigned

`SESSION-ACTIVITY-SEPARATION-DESIGN.md` §6 already specifies this and its reasoning is
sound. **This document adopts it unchanged and claims no credit for it:**

```sql
alter table public.work_sessions
  add column activity text
    check (activity in ('busy','quiet','waiting_input','blocked')),
  add column activity_at timestamptz;
```

`status` keeps its lifecycle-only meaning and its existing vocabulary. Written by a
sibling RPC, never by `work_session_transition`'s status arm — merging them at the API
boundary would undo in one function the separation the schema just bought.

The one amendment hooks permit: that design reached `waiting_input`/`blocked` only in its
Phase 2 and called them "unreachable until then". With §5.2's finding they are reachable
**immediately on Codex** via `permission_request`, and reachable-but-`weak` on Claude.
Hooks pull that phase forward.

### 7.3 Idempotency: `emit_key`

`emit_key = sha256(session_id || native_event || occurred_at || correlation_id || nonce)`,
computed **in the emitter** and carried in the request. The unique constraint makes spool
replay (D4) a no-op on the second delivery.

The nonce exists because two identical `tool_pre` events for the same tool in the same
millisecond are legal, and a key that collapses them would silently drop real events.

### 7.4 Hook config storage

Per §4.4, config is data, not code:

```sql
alter table public.spaces        add column hook_config jsonb;  -- space scope
alter table public.team_members  add column hook_config jsonb;  -- teammate scope
alter table public.work_sessions add column hook_config jsonb;  -- session scope
```

`builtin` lives in code and is *listed* through the same resolver, so
`tm8 hook list --for <session>` returns one merged, ordered, fully-attributed answer —
every hook that will fire, and which scope put it there.

---

## 8. The ingress

### 8.1 It is a catalog operation, not a support transport

tm8 has exactly two non-catalog support transports (raw file-upload `PUT`, and the voice
webhook), and `packages/server/src/http/server.ts:78-88` declares them deviations rather
than precedent.

Adding a catalog operation is expensive — the catalog currently holds ~130 bindings, and
memory records that one new row breaks ~32 tests via count pins, digests, manifests and
guards. That cost is worth paying here, and the reason is specific: hook events are how a
session's work becomes visible, so the operation must be **discoverable through
`tm8 help`, listable through `action list`, and subject to the same RLS and idempotency
ledger as every other write**. A side door would be exempt from all four, and the first
question anyone asks in an outage — "did the event arrive?" — would have no tooling behind
it.

```
hookEvents.emit    POST /v2/sessions/:sessionId/hook-events    command
hookEvents.list    GET  /v2/sessions/:sessionId/hook-events    read
hooks.resolve      GET  /v2/sessions/:sessionId/hooks          read
```

`hooks.resolve` exists so §4.1's inspectability claim is real. A resolver you cannot query
is a resolver nobody trusts.

### 8.2 Authorization

The bearer is `TM8_AGENT_TOKEN`, already session-bound. Therefore:

> **A session may only emit hook events about itself.** The `:sessionId` in the path must
> equal the token's bound session; a mismatch is `403`, not a merge.

This is the property a support transport would not have had, and it is the entire
security story for layer 1.

### 8.3 Batch, because D4's spool produces batches

`hookEvents.emit` accepts an array. A drained spool is one call, not fifty.

---

## 9. The reactor — the derivations

A pure function `(canonical event, session state, resolved hook set) → Effect[]`.

**R1 — activity.** `session_start`/`turn_start`/`tool_pre`/`tool_post` → `busy`.
`turn_end` → `quiet`. `permission_wait` → `blocked` (Codex) or `waiting_input` (Claude,
`weak`). `session_end` → clear. A `blocked` state is cleared **only** by a `tool_post`
with the matching `correlation_id`, or by `turn_end` — never by silence, because a blocked
agent is silent by definition.

On Codex, absent `turn_end`, `quiet` falls back to the silence detector at the threshold
the session-activity design set (45 s), and the fallback is recorded as such so the UI can
be less confident about it.

**R2 — attention.** `permission_wait` → `create_attention_request(session_entity, reason,
points)`. The matching `tool_post` → `resolveEntity`. Both are existing operations
(`db/migrations/050_entity_attention.sql:43-95`).

This is the derivation that makes "Needs Attention" mean something. Memory records that
the attention feature is UI-complete with **zero production writers**. R2 is the first
real one, and it arrives without a line of new UI.

Guard: one open request per `(session, correlation_id)`. An agent hitting twelve
permission prompts must not produce twelve inbox rows.

**R3 — file provenance.** `tool_post` where `tool_name ∈ {Write, Edit, NotebookEdit}` →
`write_edge(session, file-or-entity, 'touched', props)`. `write_edge` upserts on
`(src,dst,type)`, so the hundredth edit of one file is one edge.

This needs an edge type that does not exist and possibly an entity kind for a file path.
Per D1 it is built as a first-class edge type in the registry
(`db/migrations/001_core_graph.sql:751-760`), not as a hook-private table. This is the
largest single piece of new work in the document and it is what turns hooks from
"observability" into "the graph derives itself".

**R4 — task status.** First `turn_start` on a session with `working_on` edges → task
`open` → `working`, via the existing `entities.commands.work`.

Only that transition. **Hooks never complete a task** — completion is gated on acceptance
criteria and is a human-meaningful claim; a harness event is not evidence for it.

**R5 — close-out.** `session_end` with no message authored by that session on its anchor →
attention request. This makes "work nobody can see has not happened" an enforced property
rather than an instruction in a system prompt that agents routinely ignore.

**R6/R7/R8** — cheap once the transport exists; deferred to Phase 4.

### D8 — The reactor is idempotent and order-tolerant

The spool (D4) means events can arrive late and out of order. Every rule is written so
that re-delivery is a no-op and a late event cannot resurrect a stale state — the same
discipline `work_session_transition` already enforces by refusing transitions out of a
terminal status (`db/migrations/007_rpc_catalog.sql:2120-2173`).

Concretely: the reactor compares `occurred_at` against `activity_at` and drops any event
older than the current state. Not a nicety — without it, a spool drained after a session
exits would mark a dead agent `busy`.

---

## 10. Security

1. **No executable strings in space-scoped config** (§4.4). The single most important
   line in this document.
2. **Session-bound ingress** (§8.2). A session cannot speak for another session.
3. **Hook payloads are untrusted data.** `tool_input` contains whatever the agent was
   doing — file contents, prompts, arbitrary user text. It is stored and rendered as
   untrusted, never interpolated into a prompt, never executed. The existing
   `<untrusted_data>` envelope discipline applies unchanged.
4. **No secrets in payloads.** `payload` is subject to the same credential-pattern guard
   the manifest already carries. Note the known false-positive: that guard's `sk-` pattern
   has no word boundary and matches inside ordinary words. Tighten it or scope it, do not
   copy it naively.
5. **Never the global config file** (§6.1).
6. **Fail-open** (D3) — a security property as much as an availability one: a hook that
   can block is a hook that can be used to block.

---

## 11. Phases

| Phase | Content | Blocked on |
|---|---|---|
| **0** | Live probes (§12.1). Settle Codex trust, Claude payload discrimination, hook latency. | nothing |
| **1** | `session_hook_events`, ingress op, `tm8 hook emit` with spool, `claude-code` adapter, installer, R1 activity + the `activity` column | Phase 0 |
| **2** | `codex` adapter + `generic` adapter; R2 attention; capability probing | Phase 1 |
| **3** | Scope resolution (§4) end to end: space/teammate/session config, `hooks.resolve`, `tm8 hook list` | Phase 1 |
| **4** | R3 file provenance (new edge type), R4, R5 | Phase 3 |
| **5** | R6-R8 | Phase 4 |

Phase 0 is not ceremony. Two of its three probes can invalidate a phase outright, and
finding that out after the migration has landed is how tm8 acquires the scars it keeps
writing memory files about.

Phase 1 ships Claude-only **on purpose**. One agent, one adapter, one rule, end to end and
proven — then generalise. The alternative, building the abstraction across three agents
before any of them works, is how the capability matrix ends up asserted instead of
measured.

---

## 12. What must be proven

### 12.1 Phase 0 probes — each can change the design

1. **Codex trust gate (§6.4).** Materialise a `hooks.json`, run a real Codex session,
   assert the hook **fired**. If trust blocks it, find the trust mechanism or Codex hooks
   are out of reach and the Codex adapter degrades to `generic` + silence detection.
   *This probe can delete Phase 2.*
2. **Claude `Notification` discrimination.** Does the payload distinguish a permission
   prompt from other notices? If not, `permission_wait` on Claude is permanently `weak`
   and R2's copy must stay hedged on Claude. *Changes R2's user-facing text.*
3. **Hook latency, measured against a real agent.** Wall-clock cost of `tm8 hook emit` per
   tool call, on a session doing real work. If it is not comfortably under D4's budget,
   the spool becomes the primary path rather than the fallback. *Changes the emitter.*

### 12.2 Acceptance for Phase 1 — seam-crossing, not layer-local

The session-activity design's §8 diagnosis applies verbatim and its lesson is the
acceptance bar here: PR #10's defect survived 1770 green tests because it lived in the gap
between two well-tested halves. So:

1. **The one that would catch the equivalent bug.** A real Claude session, a real hook
   firing, a row in `session_hook_events`, `activity='busy'`, **and** `statusOf === 'live'`
   in the same assertion. Both halves at once — the PR #10 defect was that the two were
   mutually exclusive.
2. Spool replay is a no-op: emit, kill the server, emit again after restart, assert
   exactly one row.
3. A hook failing (server down, token expired, network gone) does **not** stall the agent.
   Measured, with the agent still completing its turn.
4. Late-arriving `busy` does not resurrect an exited session (D8).
5. `.claude/settings.local.json` with pre-existing user content survives install and
   uninstall byte-identical apart from tm8's own entries.
6. Two concurrent spawns into one project cwd both install, both emit, and attribute
   correctly (§6.3).

**Fake timers are not acceptable** for 3 or 4. Memory records a fix in adjacent code
passing 40/40 under fake timers while submitting 0/4 against a real agent.

---

## 13. Open questions

1. **Does R3 need a file entity kind?** A `touched` edge needs endpoints, and a file path
   is not currently an entity. Options: a new `file` kind (large, permanent), edge props
   carrying a path with the entity being the project (cheap, weaker), or defer R3.
   *Recommendation: defer until Phase 4 and decide with the volume data from Phase 1.*
2. **Where does the reactor run?** In-process on the ingress request is simplest and makes
   the effect synchronous with the event; a queue is more robust but tm8 already has one
   dead queue (`tracking.refresh`, migration 017) that nothing drains. *Recommendation:
   in-process, and only introduce a queue when a measurement demands it.*
3. **Event volume.** `tool_pre`/`tool_post` per tool call across N concurrent sessions,
   each producing an entity upsert through R1. The session-activity design flagged the
   same concern at a 45 s threshold; hooks are far higher frequency. Must be measured in
   Phase 1. R1 should coalesce: not every `tool_post` needs to write `activity` when it is
   already `busy`.
4. **Does the interaction profile own hook scope?** Profiles are immutable-per-session and
   already govern session behaviour. A profile-scoped hook set would be a fifth scope with
   the strongest immutability guarantee. Deferred, and worth a look in Phase 3.
5. **Resume.** A resumed session gets a new PTY and possibly a re-installed hook file. Do
   its hook events continue the same `seq` stream? *Recommendation: yes — one
   `work_session`, one stream — but confirm against how resume reuses the row.*

---

## 14. What this document owes its sources

`SESSION-ACTIVITY-SEPARATION-DESIGN.md` did the hard thinking on activity-vs-lifecycle and
on why storing a derivation in the wrong column is fatal. §7.2 adopts its schema unchanged
and its ruling — *do not write activity into `status`* — is inherited here as binding, not
re-argued.

The Agent Orchestrator research it drew on supplied the shape of the whole pipeline: ask
the agent rather than watch the pixels, correlate a blocked state by tool id, declare
capability per adapter, and treat missing evidence as its own state. Where this document
departs from AO — no executable strings in shared config, fail-open as a hard rule, a
catalog operation instead of a private endpoint — the reason is always the same one: AO is
single-user, single-machine, loopback and unauthenticated by design, and tm8 is none of
those. `[SIBLING]` The AO research session will confirm or correct that reading.

Its one correction to the inherited record is §5.2: Codex has gained `permission_request`
**and** `post_tool_use` since AO measured it, so AO's ruling that Codex can never report or
clear a blocked state is no longer true of Codex 0.145.0. Adopting the prior art verbatim
would have shipped a permanent, wrong pessimism — which is the argument for D7's
version-scoped, probed capability record rather than a constant table.
