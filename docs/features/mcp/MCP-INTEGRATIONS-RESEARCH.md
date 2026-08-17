# TM8 MCP integrations — research

**Status:** research. Nothing is built. 2026-08-09.
**Question asked:** how should tm8 define *inbound* MCP (servers tm8 consumes) and
*outbound* MCP (tools tm8 provides) so that each earns its keep.

---

## 0. Verdict

**tm8 has zero MCP code.** Verified: no client, no server, no transport, no dependency.
The only occurrence of the string in the tree is `user:mcp_servers` in a credential-lane
scratch note about Claude's OAuth scopes. Three comments promise a future MCP projection
(`packages/contract/src/catalog.ts:7`, `packages/cli/src/client.ts:6`,
`docs/harness/AGENT-HARNESS-AND-COMMAND-DISCOVERY.md:57`) and none of them has been acted on.

**Inbound and outbound are not two halves of one feature.** They share a name and nothing
else — different owner, different cost, different risk, different payoff date:

| | Inbound | Outbound |
|---|---|---|
| What it is | tm8-spawned agents get external tools | external hosts get tm8 |
| Where it lands | `packages/execution/src/spawn/` | `packages/server/src/` |
| tm8 writes | a config file before the PTY opens | an MCP server |
| Protocol code | **none** — the agent CLI is the MCP host | a full server |
| Blocked on | nothing (composes with two in-flight lanes) | a zod→JSON-Schema step |
| Real cost | small | moderate, and mostly *curation*, not code |
| Value | governance of tools agents already want | tm8 reachable from hosts tm8 didn't spawn |

**Recommended order:** inbound first (cheap, composes with the credential and hooks lanes
already in flight), outbound second, and outbound should ship as **~8 curated tools, not a
127-operation projection**.

**One finding is time-sensitive and belongs to another lane.** See §3.2 hazard 2: when
`feat/spawn-credential-injection` merges, every MCP server the user has configured in
`~/.claude.json` silently disappears from tm8-spawned sessions. That is a regression in a
feature nobody has built yet, which is the cheapest possible moment to fix it.

---

## 1. The protocol moved under us — 2026-07-28

The current revision (`2026-07-28`, five spec releases in) is the largest change since MCP
launched, and it lands *toward* tm8's architecture rather than away from it. Anything
written against the older stateful model is now wrong.

| Change | What it means for tm8 |
|---|---|
| **Stateless core.** `initialize`/`notifications/initialized` removed, no `Mcp-Session-Id`, every request self-contained and carries its own version + capabilities in `_meta` | tm8's HTTP facade is *already* this. Bearer token per request, no connection state, no handshake. The frame in `packages/server/src/http/server.ts` needs no new concept |
| **`server/discover`** replaces the handshake as the identity/capability RPC | one new endpoint, static content |
| **Sampling, Roots and Logging are DEPRECATED** | do not build them. "tm8 borrows the caller's model" is off the table |
| **MRTR** — a call answers `resultType: "input_required"` with `inputRequests`, the client retries carrying `inputResponses` + `requestState` | how a tm8 tool asks the caller's human a question mid-call |
| **Tasks are now an official extension** `io.modelcontextprotocol/tasks` | see §1.1 — this is the important one |
| **`tools/list` MUST NOT vary per-connection, but MAY vary by the authorization on the request** | per-space / per-member tool scoping survives statelessness, keyed off the bearer token. Rely on the token, never on connection state |
| **Cacheable results** — `ttlMs` + `cacheScope` required on all `*/list` and `resources/read` | tm8 has event sequence numbers and cursors already; freshness hints are derivable |
| **`subscriptions/listen`** replaces the GET stream and `resources/subscribe` | maps onto tm8's existing `events.subscribe` (WS `/v2/ws`) and `events.poll` |
| **SSE resumability removed** — a broken stream loses the request | fine; tm8's durability lives in the graph, not the transport |
| Stateful tools guidance: return an explicit **handle**, treat it as *a name, not a capability*, re-authorize on every call | tm8 entity UUIDs are exactly this, and tm8 already re-authorizes per request |

### 1.1 A tm8 work session *is* an MCP Task

This is a structural match, not an analogy. Read the two column headings as one:

| MCP Tasks extension | tm8 today |
|---|---|
| `CreateTaskResult` → `taskId`, `ttlMs`, `pollIntervalMs` | `execution.spawn` → a `work_session` entity id |
| status `working` | session running in a PTY |
| status `input_required` + `inputRequests` | session blocked, needs a human decision |
| `tasks/get` polling | `entity context <work-session-id>` |
| `tasks/update` with `inputResponses` — client→server input mid-flight | `tm8 message send --to <work-session-id>` |
| `tasks/cancel`, cooperative | `session terminate` |
| terminal `completed` / `failed` / `cancelled` with the final `result` | the closing message on the anchor |
| "durable handle survives client crash and reconnect" | the entire point of tm8 |

Every other MCP server on the market is a **data adapter** — it wraps an API and returns
rows. tm8 owns *compute*: it spawns real agents with real PTYs, durably, visibly, with a
human able to intervene. The Tasks extension is the only place in the protocol where that
is expressible, and it was designed for exactly this shape ("CI pipelines, batch
processing, **human approvals**").

**So the single highest-value outbound tool is not a read. It is `tm8_delegate`.** See §2.3.

---

## 2. Outbound — tm8 as an MCP server

### 2.1 How much of "the catalog projects itself" is actually true

The catalog comment says HTTP, CLI and "future MCP tools" are projections of one list.
Measured against the tree, that is about 60% true, and knowing *which* 60% decides the design.

**Mechanical, free:**

- **Generic dispatch by operation name.** `HandlerRegistry.get(name)`
  (`packages/server/src/facade/registry.ts`) resolves any of the 127 operations to a handler,
  and `implemented()` enumerates the ones that are actually built. An MCP layer never needs
  a per-operation switch.
- **Routing derives from the catalog.** `packages/server/src/http/router.ts:80-85` compiles
  the route table from `OPERATIONS` in one pass; nothing is hand-listed.
- **Path parameters are declared** — they are the `:id` segments in each catalog row's path.
- **Every operation already has prose.** The CLI projection carries a `summary`, `intentTags`,
  `sideEffect`, `authzTarget`, `idempotency`, `examples` and `notes` per operation
  (`packages/cli/src/discovery/operations.ts:78-115`). MCP `description`, and the
  `readOnlyHint`/`destructiveHint`/`idempotentHint` annotations, are derivable from fields
  that already exist. This is unusually good starting material.

**Not free:**

- **Input schemas cover commands only.** `INPUT_SCHEMAS`
  (`packages/server/src/facade/input-schemas.ts:109`) is a `Partial<Record<OperationName, ZodTypeAny>>`
  with **69 entries** out of 127 (pinned at `packages/server/test/w2/rolling-public.integration.test.ts:515`).
  It binds request *bodies*. The ~50 read operations have no body and therefore no entry.
- **Query parameters are undeclared anywhere.** Handlers receive `query: URLSearchParams`
  raw (`packages/server/src/http/types.ts:51`) and each parses its own. There is no machine-readable
  description of what `entities.feed` or `collections.query` accept. MCP requires a JSON Schema
  `inputSchema` per tool — for reads, **that schema does not exist and must be written by hand.**
- **No Zod→JSON Schema anywhere in the tree.** No `zod-to-json-schema`, no OpenAPI emission.
  The `inputSchemaRef` / `outputSchemaRef` values (`tm8://schema/<op>/input`) are *pointers to
  nothing* — a naming convention, not a served artifact.

**Consequence:** "project all 127 operations" is not a small mechanical loop. It is 50
hand-written query schemas plus a converter. Which is fine, because you should not do it anyway.

### 2.2 Do not ship 127 tools

Tool definitions enter the model's context on every call whether used or not. A 127-tool
server would consume a large context budget before the user says anything, and degrade tool
selection through poorly differentiated neighbours (`entities.get` vs `entities.context` vs
`entities.feed` vs `entities.children` vs `entities.hierarchy` — five reads a model must
choose between, four of which are wrong most of the time). Anthropic's Tool Search, GA in
February 2026, exists precisely to stop this, and reports ~85% token reduction against
static loading.

tm8 already solved this problem once, for itself. The CLI is deliberately discovery-first:
the agent persona in this very session says *"Discover syntax with `tm8 help --format json`
and ask for only the noun or action help the current step needs; do not assume a command."*
127 operations do not fit in a head — human or model — so tm8 made them searchable instead
of resident. **The outbound MCP server should make the same choice, and it can, because
`tm8_help` is itself a tool.**

There is also an honest question of whether outbound MCP helps *tm8-spawned* sessions at all.
It mostly does not: `tm8` is already on their PATH with an agent token, at zero context cost.
The trade is real and directional —

- **CLI:** zero resident context, pays round-trips to discover. Wins at 127 operations.
- **MCP:** resident schema cost, zero discovery round-trips. Wins at ~8 tools.

— which is another reason to keep the tool set small, and to be clear that **outbound's real
audience is hosts tm8 did not spawn**: the user's own Claude Desktop, Claude Code, Cursor, an
IDE, a colleague's agent. That is the population that has no tm8 CLI and no agent token.

### 2.3 The tool set that earns its context

**Tier 1 — build these eight.**

| Tool | Backs onto | Why it earns the slot |
|---|---|---|
| `tm8_delegate` | `execution.spawn` + Tasks extension | the differentiator (§1.1). Hand work to a durable, human-visible tm8 agent; poll with `tasks/get`; steer with `tasks/update`; stop with `tasks/cancel`. No other MCP server can offer this |
| `tm8_context` | `entities.context` | the one orientation read. Bounded by construction: summary, hierarchy, recent messages, allowed actions, current version. Already the call tm8's own personas are ordered to make first |
| `tm8_find` | `collections.query` | the entry point when you don't have an id. Paginated |
| `tm8_message_send` | `messages.post` | durable communication on an anchor — in tm8, work nobody can see has not happened |
| `tm8_task_create` | `entities.create` | intake from wherever the human already is |
| `tm8_task_update` | task domain commands | **caution:** state, value and assignment are three different writes; `state.assignees` is a projection. Model this as one tool with an explicit discriminated action, not one "patch" blob |
| `tm8_inbox` | inbox / read-marks | "what needs me" — the highest-frequency human question |
| `tm8_help` | the CLI discovery projection | the escape hatch. Keeps the resident set at eight while leaving all 127 operations reachable. This is Tool Search, built from material tm8 already has |

**Tier 2 — after Tier 1 is proven:** `tm8_feed` (activity on an entity), `tm8_graph`
(relationship traversal — tm8's actual distinctive data shape), `tm8_session_logs`
(`execution.transcript`), `tm8_memory` (the substrate on `feat/memory-substrate`).

**Tier 3 — explicit non-goals.** Do not expose space administration, governance, custom
kinds, menus, node settings, or *anything* in the credential domain. The credential
operations are guarded human-only by design (§2.6); routing them through a model-controlled
tool would be a straight defeat of that guard. Write this into the design as a rule, not a
backlog item.

### 2.4 Resources: `tm8://` already exists

tm8 already mints a URI scheme — `tm8://help`, `tm8://help/operation/<op>`,
`tm8://schema/<op>/input` (`packages/cli/src/discovery/operations.ts:1562-1568`,
`packages/contract/src/contract.ts:2107`). Those refs are *already shaped like MCP resources
and currently resolve to nothing*. Making them resolvable serves both the CLI's own
discovery promise and MCP resources in one move:

- `tm8://entity/<id>` — an entity as a readable resource, so a host can attach a task to a
  conversation without spending a tool call
- `tm8://help/operation/<op>` and `tm8://schema/<op>/input` — make the existing pointers real
- resource **links** returned from tools: `tm8_find` should return `resource_link` items
  rather than dumping bodies, letting the host fetch only what it opens

`resources/list` must be bounded and cacheable (`ttlMs`, `cacheScope: "private"`). Do not
enumerate a space's entities into it; list the handful of stable roots and serve the rest by
URI template.

### 2.5 Prompts

Cheap and underrated. tm8 has a built prompt catalog (`packages/prompt/`) with composed
personas and briefing templates. Exposing a few as MCP prompts — "brief a lane", "write a
closing receipt", "review this PR the way tm8 reviews PRs" — turns institutional practice
into something a host can invoke by name. Low cost, no new domain.

### 2.6 Auth: an MCP caller is a fourth `authKind`, and that is a real decision

There are **two different `authKind` vocabularies** in this codebase and it is easy to
conflate them:

1. `authKind: 'bearer' | 'auto-owner'` — the contract DTO, *how* you authenticated
   (`packages/contract/src/contract.ts:871`, `schemas.ts:1070`).
2. `authKind?: 'browser' | 'cli' | 'agent'` — `auth_sessions.kind`, *who* you are
   (`packages/server/src/http/types.ts:54` on `feat/credential-contract-ops`, bound into the
   PG claim `tm8.auth_kind`, `identity/claims.ts:51`).

The credential lane guards human-only operations with an allowlist over the **second** enum:
`browser|cli` are human, `agent` is not. An MCP caller is a new principal that the enum has
no value for, and the default is dangerous: **if an MCP client authenticates as `cli`, it
silently inherits human privileges including the credential operations.** So:

- add `mcp` as a fourth value, and **exclude it from the human-only allowlist**;
- the MCP client presents `Authorization: Bearer tm8s_…`, exactly like every other caller —
  no new auth mechanism, and the CLI credential store already knows how to mint and hold one;
- scope `tools/list` by that token (permitted by the spec — see §1) so a caller sees only the
  tools their grants permit;
- **before** exposing tm8 to a third-party host, remember the deployment context: the
  readiness note on removing the Utho VPN found `nginx satisfy any` and an unauthenticated
  `/v2/ws`. A public `/mcp` endpoint inherits every one of those problems. Outbound MCP over
  the public internet is blocked on that cleanup, not on MCP.

### 2.7 Transport and where it plugs in

Streamable HTTP, one route. The server is Node's native `http` with manual matching, so the
MCP endpoint sits beside `/health` and before `router.match`
(`packages/server/src/http/server.ts:218`). Requests must accept the mandated
`Mcp-Method` / `Mcp-Name` headers. `subscriptions/listen` is a long-lived POST-response
stream — the existing WS upgrade path (`server.ts:126-154`) is *not* it, but the event
plumbing behind it (`events/subscriptions.ts`) is reusable.

For local use, a thin **stdio** wrapper shipped inside the existing `tm8` CLI binary
(`tm8 mcp serve`) is the cheapest possible first delivery: it reuses the CLI's credential
store, needs no network exposure, and is what Claude Desktop/Code want anyway.

### 2.8 Catalog row, or not?

Adding a catalog operation is repo-wide. Verified again here: one row moves `CATALOG_DIGEST`
(which lives in more than one file), the conformance manifest and generator, `/health`
counts, the exhaustive `Record<OperationName, Row>` in the CLI, and a set of hardcoded count
pins across contract, CLI, server and conformance suites. Roughly 20 files, several of them
owned by other lanes.

**Ruling: build outbound MCP as a non-catalog transport, and say so in the code.** It is a
*projection of* the catalog, not a member of it — the same relationship the HTTP facade and
the CLI have. Its tools dispatch through `HandlerRegistry.get(name)`, so it cannot drift into
a parallel API, and it adds zero catalog rows. Precedent exists: the universal clipboard
shipped as non-catalog support transport. Revisit only if MCP becomes a contract-frozen
surface.

The one place this is *not* free: the tool→operation mapping must be tested against the
catalog, or a renamed operation breaks MCP silently. That test is cheap and must exist from
day one.

---

## 3. Inbound — external MCP servers inside tm8 sessions

### 3.1 The seam is spawn, and today it is ungoverned

tm8 does not need to speak MCP to give its agents MCP tools. `claude` and `codex` *are* MCP
hosts; tm8 launches them (`packages/execution/src/spawn/manifest.ts:389 buildAgentCommand`).
`HOME` is forwarded (`SAFE_BASE_ENV_KEYS`, `manifest.ts:694`), so whatever is in the operator's
`~/.claude.json` or `~/.codex/config.toml` is already visible to every spawned session.

That is also the whole problem. Today inbound MCP is: *whatever happens to be in one
machine's home directory*. It is not per-teammate, not per-space, not auditable, invisible in
the graph, and it does not survive the move to hosted workspaces where the agent's home is
not the user's home. **The value of "inbound MCP" as a tm8 feature is not access — access is
already free. It is governance.**

### 3.2 Five things that silently break an MCP server inside a tm8 session

1. **The child environment is an allowlist, not an inheritance.** `composeEnv`
   (`manifest.ts:721-826`) builds the environment from scratch: `TM8_*` vars, then
   `SAFE_BASE_ENV_KEYS` (`:694` — `HOME USER LOGNAME SHELL PATH LANG LC_ALL TERM COLORTERM
   TMPDIR XDG_CONFIG_HOME XDG_CACHE_HOME`), then `AUTH_ENV_KEYS` (`:684` — Anthropic/OpenAI/
   Gemini/Google only). A `JIRA_API_TOKEN` or `GITHUB_TOKEN` exported in your shell **does not
   reach the agent**, so a stdio MCP server that reads its secret from the parent environment
   gets nothing and usually fails in a way that looks like a broken tool rather than a missing
   variable. Cure: inline the value in the MCP config, or source it from the credential store.

2. **⚠ The credential lane will hide the user's MCP config, and nobody has noticed.**
   `feat/spawn-credential-injection` (`0565e71`, unpushed) injects a per-member
   `CLAUDE_CONFIG_DIR`. That variable **replaces** the default config location — it does not
   layer over it. The day that lane merges, `~/.claude.json` stops being read by spawned
   sessions, and with it every MCP server the operator had configured there. The same lane
   also suppresses the node's `ANTHROPIC_API_KEY` deliberately (ruling R13), which is correct
   for auth and makes the config directory the *only* channel. **Whoever builds inbound MCP
   config injection must own writing MCP entries into that per-member directory, or inbound
   MCP silently ceases to work at merge time.** This is worth raising on the credential lane's
   anchor now, while it is a design note rather than an incident.

3. **Codex sits behind an exact-host network allowlist.** Every non-`bypassPermissions` Codex
   spawn is pinned with `CODEX_LOOPBACK_CONFIG_OVERRIDES` (`manifest.ts:68-75`):
   `features.network_proxy.domains={"127.0.0.1"="allow", "localhost"="allow"}`. A remote HTTPS
   MCP server is therefore unreachable from a sandboxed Codex session — it will work under
   Claude and fail under Codex, which reads as flakiness. **Unverified:** whether the policy
   reaches MCP *subprocesses* or only the agent process. Measure before promising Codex support.

4. **OAuth needs a browser a PTY does not have.** Browser-consent flows block before the agent
   emits anything — the documented silent-hang class. Use token/header auth, or complete the
   OAuth once interactively as the same OS user so the token lands in the shared config.

5. **Project-scope config prompts for approval.** `claude mcp add -s project` writes `.mcp.json`
   and asks for confirmation on first use — another unattended block. Any tm8-written config
   must land in a scope that does not prompt.

### 3.3 The design: MCP servers as tm8 entities, injected at spawn

Three parts, each of which has precedent in the tree:

**(a) Definition — an MCP server is an entity.** Name, transport (stdio command / remote URL),
scope, and a *reference* to a credential rather than a secret. `connections` already exists as
a first-class concept in the contract (`EntityDetail.connections`, `entities.connections`,
`serverConnections.*`), and the credential wave already models per-member secrets. An MCP
server definition is a connection with a launch shape. Secrets stay in the credential store;
the entity holds a pointer. Never put a token in an entity body — it is graph data and it is
readable.

**(b) Grant — who gets which server.** The unit should be the **teammate**, with space-level
defaults and per-task overrides. "The reviewer teammate gets GitHub and Sentry read; the
implementer gets GitHub write; the researcher gets neither" is a sentence tm8 can currently
express about nothing. This is the actual product of inbound MCP, and it composes with the
existing per-member credential model rather than duplicating it.

**(c) Injection — write the config before the PTY opens.** The pattern is established twice:
`spawn/workspace-trust.ts` already reaches into `~/.claude.json` and `~/.codex/config.toml`
(atomic write, `0600`, serialised queue, idempotent, best-effort, never fails the spawn), and
the hooks foundation LLD (`docs/architecture/hooks/LLD-hooks-foundation.md` §6) already rules
that per-session agent config belongs in the **session's working directory, never a
user-global file** — because a user-global write fires in the operator's own terminal too.
MCP config injection is the same operation on a different key, and should reuse the same
adapter-per-agent-kind structure the hooks design defines. If the hooks lane builds first,
inbound MCP is a second consumer of finished machinery.

Where the file lands is the one open question, and hazard 2 above decides it: it must be the
per-member credential home, so that the credential lane and the MCP lane agree on a single
config directory instead of racing for it.

### 3.4 Which inbound servers, ranked by tm8-specific value

Ranked by what tm8 agents demonstrably already do in this repo, not by popularity:

1. **GitHub.** tm8 already links PRs and commits to tasks (`task link-pr` / `link-commit`) but
   never creates them; agents drive `gh` by hand constantly, and PR review is a recurring
   spawned-agent job. Highest value, token auth, no OAuth browser problem.
2. **Playwright / browser.** This repo verifies UI work with screenshots and e2e capture
   scripts, and has a standing problem that jsdom passes what the browser fails. A governed
   browser tool turns "verified in jsdom" into "verified in pixels".
3. **Postgres, read-only.** Debugging in this project is repeatedly a database question
   (delivery rows, migration ledger, orphaned sessions). A read-only connection scoped to the
   dev cluster is high-value and low-risk; production must not be reachable this way.
4. **Sentry / observability.** Error → tm8 task is the cleanest possible intake story and
   plays directly to tm8's coordination model.
5. **Jira / Linear / Notion.** Intake and context. Note that MCP is an agent-tool protocol,
   not a sync bus: an agent holding both a Jira tool and the tm8 CLI can transcribe an issue
   into a task today. A *real* connector — webhooks, field mapping, idempotency — is a tm8
   domain through the catalog, and should not be mistaken for an MCP integration.
6. **Slack.** Lower priority; tm8's own messaging is the durable channel by design.

### 3.5 What must be probed before any of this is promised

- Does the Codex loopback proxy apply to MCP subprocesses? (hazard 3)
- Does Codex's trust gate refuse tm8-written config the way the hooks LLD warns it might?
- Capability is version-scoped state, not a constant — Claude and Codex differ in what they
  support and it changes per release. Any adapter needs a version-gated capability matrix,
  and "the docs say so" is not a measurement.

---

## 4. The composition is the point

The two halves are worth more together than apart, and the round trip is short enough to state:

> A developer in their own Claude Code — never spawned by tm8 — calls `tm8_delegate`. tm8
> returns an MCP task handle and spawns a real agent session, which is visible in the tm8 UI
> to the whole team. That agent starts with exactly the external tools its teammate grant
> allows: GitHub, a browser, a read-only database. It works, posts durable messages on the
> anchor, and opens a PR. Along the way it needs a decision, so the task turns
> `input_required`; the developer answers through `tasks/update` and never leaves their
> editor. The task completes and the handle resolves to a result — while the entire history
> stays in the graph, readable by a human who was asleep for all of it.

Nothing in that paragraph requires a protocol feature that does not exist as of 2026-07-28,
and nothing in it requires tm8 to become something it is not. Both halves are adapters over
machinery tm8 already has.

---

## 5. Build order

| Step | What | Depends on | Catalog rows |
|---|---|---|---|
| 0 | Decide the config-directory contract with the credential lane (§3.2 hazard 2) | conversation, not code | 0 |
| 1 | Inbound: write MCP config at spawn, one agent kind (`claude-code`), server definitions read from a space-level config | hooks/credential injection pattern | 0 |
| 2 | Inbound: MCP servers as entities + per-teammate grants + credential-store secret refs | connections + credential lane | some |
| 3 | Zod→JSON Schema converter; make `tm8://schema/...` and `tm8://help/...` actually resolve | none | 0 |
| 4 | Outbound: stdio `tm8 mcp serve` with Tier 1 **reads only** (`tm8_context`, `tm8_find`, `tm8_help`, resources) | step 3 | 0 |
| 5 | Outbound: writes (`tm8_message_send`, `tm8_task_create`, `tm8_task_update`) + the `mcp` authKind | step 4, §2.6 | 0 |
| 6 | Outbound: `tm8_delegate` with the Tasks extension | step 5 | 0 |
| 7 | Outbound: remote Streamable HTTP `/mcp` | **the Utho `satisfy any` / unauthenticated `/v2/ws` cleanup** | 0 |

Step 1 delivers value with no catalog change, no protocol code and no new domain. Steps 4-6
are the ones that make tm8 reachable from everywhere its users already are.

---

## 6. What I could not verify

- Whether the Codex network proxy policy reaches MCP subprocesses (§3.2 hazard 3) — needs a
  live probe, not a code read.
- Which MCP spec revision Claude Code and Codex currently *implement*. `2026-07-28` is
  published and the Tier-1 SDKs ship it, with support rolling out across Claude products, but
  a host on an older revision changes the outbound design materially (sessions, `initialize`,
  no Tasks). **Measure the host before writing the server.**
- The exact shape of the `connections` domain on the credential branches — read for intent
  here, not line by line.
- Everything about the credential lanes is read from unpushed branches
  (`feat/credential-*`, `feat/spawn-credential-injection`); none of it is on `main`, and the
  merge order between them is already known to be load-bearing.

## Sources

- [MCP 2026-07-28 key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
- [MCP tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP Tasks extension](https://modelcontextprotocol.io/extensions/tasks/overview)
- [The 2026-07-28 specification (announcement)](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Bringing MCP 2026-07-28 to Claude](https://claude.com/blog/bringing-mcp-2026-07-28-to-claude)
- [MCP tool design: practical approaches and tradeoffs (AWS)](https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/)
- [MCP context bloat at enterprise scale](https://agentmarketcap.ai/blog/2026/04/08/mcp-context-bloat-enterprise-scale-tool-definitions-agent-context-budget)
- [Best practices for building MCP servers](https://www.philschmid.de/mcp-best-practices)
