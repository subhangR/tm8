# Design — tm8 MCP layer + Slack connector

Task `019fbf79-baac-73f6-ad53-d31d0f5cd209` (sheet row #34) · tm8 `main` @ `24778c2`, read 2026-08-02
Conforms to the TM8-only scope directive (doc `019fc1f9-bcc5-7e6e-a65c-09ecfd81c9ff`). Every path below is in `/home/tm8/prod-workspace/tm8`.

| This document delivers | This document leaves alone |
|---|---|
| The reason `03 §5`'s central promise cannot be built today, and the map that fixes it | The operation catalog itself — a missing operation is a catalog change, raised separately |
| A v1 tool map re-derived from tm8's live 125-operation catalog | `spaces.*`, `execution.*`, `files.*`, `artifacts.*` and all destructive ops — excluded, with reasons |
| The exact SDK binding, verified against `@modelcontextprotocol/sdk` 1.30.0 | Transport beyond stdio — HTTP would pressure the loopback bind that *is* the security control |
| Outbound Slack, off by default | Azure DevOps and CI/CD connectors — sibling tasks; the sheet's bar is "at least one" |
| A build order in which every step ends in a check | The Slack workspace and bot token — a human must provision them (blocking `ac_2`) |

## 🧾 Verified ground truth

Measured, not assumed. Re-check with the cited `path:line` before trusting any row.

| Fact | Value | Where |
|---|---|---|
| Catalog size | 125 operations, 26 families | `packages/contract/src/catalog.ts:30` |
| Reserved operations | 2 — `search.query`, `bridge.fetchBlob`; must answer `501`, never `404` | `packages/contract/src/catalog.ts:8` |
| Input-schema binding | **67 `bound` · 46 `none` · 12 `unbound`** (= 125) | `packages/cli/src/discovery/operations.ts:125` |
| Operation → Zod map | **does not exist** | see next section |
| `inputSchemaRef` | a string synthesized from the operation name | `packages/cli/src/discovery/operations.ts:1533` |
| Exported Zod schemas | 204, keyed by schema name, not operation name | `packages/contract/src/schemas.ts` |
| zod version | `^3.23.0` — no native `z.toJSONSchema()` (that is zod 4) | `packages/contract/package.json:18` |
| Bearer auth | implemented; `Bearer tm8s_…` verified against `auth_sessions` | `packages/server/src/main.ts:367-389` |
| Persona scoping | a token may act only as its `team_member`; Postgres still authorises | `packages/server/src/main.ts:381-383` |
| Path binding | `bindPath(op, params)`; zero hand-written URLs in the package | `packages/cli/src/client.ts:6-24` |
| Response modes | closed set: `envelope` / `bytes` / `stream` | `packages/cli/src/client.ts:57-60` |
| Signed-webhook precedent | hand-rolled on `node:crypto` | `packages/server/src/voice/livekit-token.ts:2` |
| MCP implementation | none — `grep -ril mcp` returns docs and comments only | — |

## ⛔ The blocker — no operation→schema map exists

`docs/collab-v2-api-design/03-CONSUMER-SURFACES.md:106` promises: *"Tool JSON schemas are generated from the contract's Zod schemas — one source of truth, so the MCP layer cannot drift."*

Nothing can generate them. The whole of what exists is `packages/cli/src/discovery/operations.ts:1533`:

```ts
inputSchemaRef: row.input === 'none' ? null : `tm8://schema/${operation}/input`,
```

That is a URI **built by string template from the operation name**. No resolver dereferences it. The 204 schemas in `packages/contract/src/schemas.ts` are exported under schema names (`EntityPatchInputSchema`); nothing joins the two namespaces. `inputSchemaRef` is a label, not a binding — so this is the first task, and `03 §5` does not mention it.

**Deliverable:** a frozen table exported from `packages/contract`, one row per `bound` operation.

```ts
// packages/contract/src/operation-schemas.ts
export const OPERATION_INPUT_SCHEMAS: Partial<Record<OperationName, z.ZodTypeAny>> = {
  'entities.patch': EntityPatchInputSchema,
  'messages.post':  MessagePostInputSchema,
  // … one row per bound operation
};
```

**The honesty rule this creates.** The map must agree with `packages/cli/src/discovery/operations.ts:125` on all 125 operations:

| `input` | Count | MCP treatment |
|---|---|---|
| `bound` | 67 | schema generated from the mapped Zod schema |
| `none` | 46 | path/query params only; empty object schema |
| `unbound` | 12 | **may not be exposed as a tool** |

An `unbound` operation carries a request body and has no frozen schema (`packages/cli/src/discovery/operations.ts:138`). Hand-writing one in the MCP package makes that package a second, divergent definition of the operation's input — precisely the drift T-L12 forbids (`docs/tm8-architecture/01-LAWS.md:84`). Either freeze the schema in `packages/contract`, which benefits every surface, or leave the operation out.

The 12: `spaces.invites.create/revoke/redeem`, `spaces.taskAxes.delete`, `entities.delete`, `entities.restore`, `edges.delete`, `commands.undo`, `projects.unlink`, `inbox.markRead`, `readMarks.upsert`, `savedViews.delete`. Note that `entities.delete`, `entities.restore` and `edges.delete` are **destructive and unschema'd** — the worst pairing, and the reason they are excluded below rather than deferred.

**Emitting JSON Schema.** MCP `inputSchema` is JSON Schema draft-07.

| Option | Cost | Decision |
|---|---|---|
| Add `zod-to-json-schema` to `packages/mcp` | one dependency, contained to the new package | ✅ **take this** |
| Upgrade `@tm8/contract` to zod 4 for native `z.toJSONSchema()` | server, CLI and UI all consume these schemas | ❌ blast radius for a benefit only MCP needs today |

## 🧱 Shape

```
MCP client (Claude Code, Cursor)
        │  JSON-RPC 2.0 over stdio
        ▼
  packages/mcp                  ← the only new package
        │  bindPath(op, params) + Authorization: Bearer tm8s_…
        ▼
  tm8-server HTTP facade        ← unchanged
        ▼
  Postgres (RLS, can_act_as)    ← unchanged
```

**stdio, not HTTP.** The node binds loopback and the tailnet address only, and that binding *is* the security control — there is no auth on the transport itself. An HTTP MCP transport creates pressure to widen it. stdio keeps the process local to a user who already holds a session, and is what every MCP client supports first.

**No business logic in this layer.** It is a projection: tool → operation → `bindPath` → facade. Behaviour the facade lacks is a catalog change (`docs/tm8-architecture/01-LAWS.md:84`), never logic smuggled into the binding.

## 🔧 The v1 tool map

The one part of `03 §5` worth keeping verbatim is its rule: **one tool per catalog family, discriminated by a parameter**, because LLM tool-selection cost scales with tool count (`docs/collab-v2-api-design/03-CONSUMER-SURFACES.md:92`). 125 tools would be actively worse than 8.

| Tool | Discriminator | Operations | Binding |
|---|---|---|---|
| `tm8_read` | `mode` | `entities.context` *(default)*, `.get`, `.children`, `.hierarchy`, `.connections`, `.activity`, `.versions`, `.feed` | all `none` |
| `tm8_query` | `mode: collection\|graph` | `collections.query`, `graph.query` | `bound` |
| `tm8_entity_write` | `action: create\|patch\|move` | `entities.create`, `.patch`, `.move` | `bound` |
| `tm8_message` | `action: list\|post\|edit` | `messages.list`, `.post`, `.edit` | `bound` / `none` |
| `tm8_task_flow` | `action` | `entities.commands.work`, `.complete`, `.pull`, `.linkPr`, `.linkCommit` | `bound` |
| `tm8_attention` | `action` | `attentionRequests.list`, `.create`, `.update`, `.resolveEntity` | `bound` |
| `tm8_edge` | `action: list\|create\|patch` | `edges.list`, `.create`, `.patch` | `bound` / `none` |
| `tm8_actions` | — | `actions.list` | `none` |

Eight tools, about thirty operations, and every one of them `bound` or `none`.

**`tm8_read` defaults to `entities.context`, not `entities.get`.** A journal analysis of 3,018 CLI invocations (19 sessions, 2026-08-01) isolated 282 real-agent records carrying 66% of the tokens. Within those, `entity get` cost ~487,836 estimated tokens — 42% of all real agent traffic — across 48 calls, because its syntax is `tm8 entity get <entity-id>` with no bounding flags. On the same entity ids `entity context` measured 87% and 64% smaller. (Figures are `chars/4` CLI-boundary estimates, never provider-billed usage.) A tool that defaults to the unbounded read imports that cost into every MCP client, permanently.

**`tm8_actions` is not filler.** `actions.list` is how a client asks what is currently permitted on an entity. Without it an agent guesses and collects a `403`; with it, capability discovery works the way it already does for UI and CLI — one bit, three surfaces.

**Excluded from v1, with reasons:** `spaces.*` (23 ops — largest family, lowest agent value, highest blast radius) · `execution.*` (7 — spawn and terminate are the highest-power surface in the system; open question below) · `auth.*` (this server consumes a session, it does not mint one) · `files.*` (three-step upload, `bytes` response mode) · `artifacts.*`, `projects.*`, `interactionProfiles.*`, `savedViews.*`, `handoffs.*`, `entityKinds.*`, `voice.*` · all 12 destructive/unbound ops · `events.subscribe` (`stream` mode; no matching MCP primitive here). `search.query` is reserved (no FTS in v1) — reserving the slot is fine, pretending it works violates `packages/contract/src/catalog.ts:8`.

## ⚙️ SDK binding

Handlers register with **Zod schema objects, never strings**:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema }
  from '@modelcontextprotocol/sdk/types.js';   // ← the import that is easy to omit

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => { /* … */ });
```

The SDK reads `schema.shape.method.value` to derive the method name. A string has no `.shape`, so `setRequestHandler` throws `Schema is missing a method literal` **at module load** — before any request is handled, and with a stack trace that points at the SDK rather than at the mistake.

This is not hypothetical. Prior art in this workspace (a 449-line MCP server for a different product, with ~1,200 lines of accompanying architecture documentation) registers handlers as `setRequestHandler("tools/list", …)`. Installed clean and given a single `initialize` frame, it dies at line 80 with exactly that error. **The prose did not prevent the crash; one startup check would have.** That is why the last column of the build table exists.

**stdout is the JSON-RPC channel.** A stray `console.log` corrupts the stream and the client reports a protocol error rather than your message. Diagnostics go to `stderr`.

## 🚨 Errors

The facade already answers `{error:{code,message,requestId,retryable,details?}}` (`packages/cli/src/client.ts:13-14`). The closed taxonomy — `invalid_input`, `unauthenticated`, `forbidden`, `not_found`, `version_conflict`, `not_implemented` — maps onto MCP tool errors carrying both the code and the `requestId`.

**A failed call never returns an empty success.** A tool answering `{}` on a `403` teaches the model that the entity is empty rather than forbidden, and the model will act on that. The `requestId` must survive into the error text; it is what joins an MCP failure to a server log line.

`version_conflict` deserves care: `entities.patch` is `expectedVersion`-guarded, so a conflict is normal and recoverable. The error must say to re-read and re-apply, and must never suggest dropping the guard.

## 🔌 Slack connector

Scoped to the sheet's own bar — *"at least one optional connector works end-to-end"* — so: one connector, **off by default, inert when unconfigured**.

**Direction: outbound (tm8 → Slack) for v1.** The sheet keeps in-platform messaging primary; outbound is what makes tm8 visible to a team living in Slack without moving anything into it. Recorded as an open question — if bidirectional is meant, `ac_2` and the estimate both grow.

**Mechanism.** Subscribe to the existing event stream; on a message posted to a watched anchor, or an attention request raised, post to the configured channel. Config-gated: no token means the subscription is never registered and nothing else in the server changes.

**Two rules carried over as intent** from a Slack-MCP ecosystem survey in this workspace, which reached them independently:

| Rule | tm8 mechanism |
|---|---|
| Writes opt-in and whitelisted; default read-only | `commandPermissions` on `team_member` already gates command groups |
| Bot-style identity — post as the agent's persona, not a generic app | the `author{kind,id}` discriminator already carries this |

**Secrets.** The bot token and signing secret are new secrets in a system whose control is its bind address. They live in `/etc/tm8/*.env` (systemd is authoritative; the repo's `deploy/staging/env.sh` is stale), never in the repo, and never in logs, the CLI journal, or the event stream. The connector must not widen the bind — outbound HTTPS only.

**Inbound, only if outbound lands cleanly.** Follow `packages/server/src/voice/livekit-token.ts:2` and `packages/server/src/http/voice-webhook.ts` — signature verification hand-rolled on `node:crypto`, mounted as its own route. The precedent exists and is already reviewed; do not invent a second style.

## ✅ Build order

Each step ends in a check whose output is the evidence. No step is done on a `200`.

| # | Step | Done when | Criterion |
|---|---|---|---|
| 1 | `OPERATION_INPUT_SCHEMAS` in `packages/contract` | test proves every `bound` op has an entry and no `unbound`/unknown op does | `ac_4` |
| 2 | `packages/mcp` skeleton + `zod-to-json-schema` | `npm run check` clean | `ac_4` |
| 3 | stdio server, `tm8_read` only | `echo '{"jsonrpc":"2.0","id":1,"method":"initialize",…}' \| node dist/index.js` returns a result | `ac_3` |
| 4 | Remaining seven tools | `tools/list` returns 8 tools, each with a non-empty `inputSchema`; one `tools/call` matches the CLI for the same id | `ac_3`, `ac_6` |
| 5 | **Gate test** | fails on a hand-written schema, a non-catalog op, or an `unbound` op — **and has been demonstrated to fail** | `ac_5` |
| 6 | Error mapping | unauthenticated / unknown-op / forbidden each yield a typed error carrying code + `requestId` | `ac_7` |
| 7 | Slack outbound | anchor message reaches the channel in under 30s | `ac_8` |
| 8 | Off-by-default | server starts with no Slack config; CLI and UI byte-identical | `ac_9`, `ac_10` |

Step 5 is the one that must not be dropped under time pressure. Steps 1–4 build the layer; step 5 is what stops it becoming the third parallel API that `docs/tm8-architecture/01-LAWS.md:84` exists to forbid.

## ❓ Open questions

| # | Question | Blocking? |
|---|---|---|
| 1 | Slack direction — outbound assumed. Bidirectional grows `ac_2` and the estimate. | no, default stated |
| 2 | Who provisions the Slack workspace, app and bot token? No code makes `ac_2` verifiable without them. | **yes** — attention raised on the task |
| 3 | Should `execution.*` join the tool set? Excluded from v1 as highest-power, highest-risk. | no |
| 4 | Should the MCP server always act as a persona rather than the owner (`packages/server/src/main.ts:381-383`)? Leaning yes — it makes every MCP write attributable. | no |

## 📚 Prior art

| Source | Use it for | Do not use it for |
|---|---|---|
| `docs/collab-v2-api-design/03-CONSUMER-SURFACES.md:92` | the one-tool-per-family rule | its `collab_*` table — pre-tm8 operation names, every row a 404 |
| `docs/tm8-architecture/01-LAWS.md:84` | T-L12, one catalog and three projections — FINAL | — |
| A Maestro-scoped MCP server elsewhere on this box | tool-granularity instincts, and the startup-crash trap above | its code, paths or types — different product, and it does not run |
