# Scheduled tool runs: a loop runs a tool

Tools v2 PR-C (task `01a182cd-2f12-7d34-92ed-fb60adc049de`; contract: Tools v2 design doc `01a182cb-de75-7ec8-b8fe-650d4ca88580` §4, "FINAL SEAM CONTRACT"). A loop whose action is a tool fires it with **no HTTP request and no bearer**: the loop executor calls a server-internal entry point, and the run is recorded exactly like a run started from the CLI or the UI. This page is the seam between the Tools side (this PR: the entry point and migration 389) and the Loops side (the executor's `fireTool`, which calls it).

## The entry point

```ts
ToolRuntime.runScheduled(claims: DbClaims, request: {
  toolId: string;
  inputs: Record<string, ToolJsonValue>;   // stored public values; a bound secret is used by leaving its slot out
  firingKey: string;                        // distinct per firing
  triggeredByLoopId: string;
  runAsTeamMemberId?: string;               // the loop's runs-as persona; required iff the tool's tm8Access ≠ none
  title?: string;                           // the loop's title, printed in the run header only
}): Promise<{ sessionId: string; toolVersion: number; sourceSha256: string }>
```

`packages/server/src/tools/runtime.ts`. `main.ts` hands the node's `ToolRuntime` to `createLoopExecutorPort` as the optional `tools` dependency; a node without an execution block has none, and such a loop cannot fire a tool. `runScheduled` reads no loop row and is agnostic to how the loop stores its action: the executor passes the tool, the inputs, the persona and the loop id.

## Identity

The claims are `createLoopExecutorPort.claimsForLoop(loop, actAsIdentity)` (375) and nothing else: the firing identity, `nodeAdmin: false`, **no `authKind`**, no auth session, no link, no work-session claim, no actor, no background-job claim. `runScheduled` refuses any other shape with `forbidden` before reading anything. Who the firing identity is belongs to the Loops side: the human who armed the loop while they are still an active member, else the loop's creator while they are, else the loop parks and never fires. There is no owner fallback and nothing ever runs as the loopback owner.

The run's `created_by` is that member's own row, its `parent_id` is null (there is no invoking session), and bound secrets are opened as that account: `read_tool_credential` visibility applies and a secret the account may not see fails closed with `forbidden` "Tool credential is unavailable", before any row exists.

## Inputs

The stored inputs are checked against the **current** definition before any row is written. One `invalid_input` names every problem at once: an undeclared or renamed input, a value that no longer fits its type, a secret slot carrying a value (secret values are never stored; the secret is bound to the tool), a required input that is neither supplied, configured, defaulted nor (for a secret) bound. Values then resolve as every run does, run argument → configured value → declared default, with bound secrets read as the firing account and no passed secrets at all. The Loops side validates the same way at loop create and update for early feedback; this check is the one that counts, because the definition may have changed since.

A tool with `tm8Access` `read` or `write` and no `runAsTeamMemberId` is refused with `invalid_input` ("tool *name* needs a runs-as persona for tm8 API access") before any row, so no killed run is left behind.

## The run and its provenance (migration 389)

`start_tool_session` gains a trailing `p_triggered_by_loop_id`; the ten-argument form is dropped, as 348 did for `execution_spawn`, and existing callers resolve through the new default. The call passes `p_tool_version = tool.version` (never null: the null form skips the stale-source check and could run code the firing never validated), `p_keep_open = false`, no `p_actor_id`, and `clientMutationId = tool-fire:<firingKey>`. The run pins `tool_version = tools.execution_version`, the definition version (migration 388); that is the `toolVersion` returned and the `v<N>` in the run header, while `p_tool_version` stays the concurrency check against the version the firing validated.

When the loop id is set, the function refuses, before writing anything, unless the claims carry no auth kind, no link and no work-session claim; the loop is live and in the run's space; the version is pinned; keep-open is off. It then writes the run row, the `executes` edge **and the run's `triggered_by` edge to the loop in the same transaction**, under `w1_set_writer('spawn')`, with props `{provenance: true, firedAt}`, no exception handler and no `on conflict` (348:192-215 copied). A run either has its provenance or does not exist, and 347 refuses the marker to every other writer, so the edge cannot be forged afterwards. Loops migration 394 redefines this gate, keeping 389's signature and grants, to also require `loops.tool_id = p_tool_id`: a loop-triggered run executes only the loop's own tool. The executor passes the tool id from the loop row, so the check refuses only a loop re-pointed to another tool between that read and the fire.

**Replay.** The firing key makes two firings two runs and a transport retry a replay: a second call with the same key returns the original run (`__tm8_replayed: true`) and `runScheduled` neither remints nor relaunches. A replay is honoured only for a run this same loop fired; another loop's key is refused (`invariant_violation`).

## The token (only when `tm8Access` ≠ `none`)

`issue_tool_session_loop_session(p_session_id, p_loop_id, p_team_member_id, p_token_hash, p_expires_at, p_api_scope)` mints the run's tm8 bearer on the authority of the marked edge, not the caller's say-so. It requires: no-bearer claims (auth kind empty, no link, no work-session claim); a live top-level tool run (319's predicate) created by the caller's own member; a **provenance-marked** `triggered_by` edge from that run to that loop (an unmarked run-history edge is never enough); the loop live in the space with `team_member_id` equal to the persona; `can_act_as` the persona; the run's pinned `tool_tm8_access` ≠ `none`. It has no fallback branch: it mints whenever its gate holds and refuses (`forbidden`) otherwise.

The token is kind **`agent`**, acting as the loop's runs-as persona, pinned to the run (`work_session_id`) and its space, labelled `tool-loop:<run>`, with no parent (there is no bearer to descend from), expiring no later than the run's pinned timeout + 60 s. Scope is `read` when the pinned access or the requested scope is `read`, else `write`. Minting also writes `participates_in` persona → run, the canonical teammate relationship; a run without a token has no such edge. No path produces a human-kind token or a persona-less agent token.

Revocation is unchanged: the launcher revokes on every exit, 319's settlement trigger and the resolver backstop key on `work_session_id`, and `revoke_agent_auth_session` works because a persona is named.

## Launch and record

After the mint the run is marked `running` and handed to the launcher exactly as `run()` does: adopt on ready, record the exit, revoke the token, close the PTY. `keepOpen` is always false (a retained shell would hold one of the member's eight tool-session slots, and the loop's overlap guard would then skip the loop forever). The cwd is the firing identity's scratch directory, `<dataDir>/tool-workspaces/<identity>/<toolId>`, with no override.

The wrapper's header now prints the cwd on every run, and a scheduled run names its origin:

```
── url-check v3 · loop: Nightly check · inputs: urls ──
── cwd: /var/lib/tm8/tool-workspaces/<identity>/<toolId> ──
```

`title` is printed there and nowhere else: the run session's title stays the tool's name, one title rule for every run path, so a firing adds no version bump or "renamed" activity. The loop reaches the UI through the marked edge.

The record is the one every run has: `executes` run → tool; `triggered_by` run → loop with the provenance marker; `participates_in` persona → run when a token was minted; pinned version, source hash, access and timeout; outcome via `record_tool_exit`. No task is derived: the executor's `fireTool` returns `{ taskId: null, sessionId }`.

## Failures the executor writes to `last_error`

The schedule advances either way; the firing is one attempt. The first group leaves **no run row**; the second leaves a run recorded as `killed` (status `failed`, outcome `stopped`) with its marked edge, and its token revoked if one was minted.

| Error | When | Run row |
|---|---|---|
| `invalid_input` | stored inputs no longer fit the current definition (every input named); tm8 access with no runs-as persona | none |
| `forbidden` "Tool credential is unavailable" | a bound secret the firing account may not use | none |
| `version_conflict` (40001) | source or execution settings edited between load and start | none |
| `invariant_violation` "loop tool_id does not name this tool" | the loop was re-pointed to another tool between the executor's read and the fire (394) | none |
| `limit_exceeded` | the firing member already has eight tool sessions | none |
| `forbidden` from the mint | the mint's gate refused (persona is not the loop's, loop no longer live, …) | killed, marked edge, no token |
| `upstream_unavailable` "Tool launch failed" | the PTY could not start | killed, marked edge, token revoked |

A **nonzero exit is not a firing failure**: `record_tool_exit` settles the run as `completed` with its exit code, and the loop page reads state and exit from the newest `triggered_by` run; the output tail is fetched lazily through `tools.runs.get`.

## Tests

- `packages/server/test/tools/scheduled-runs.test.ts`: the server half on a real PTY and a recording database fake, one case per contract rule, asserting exactly what reaches the database.
- `packages/server/test/tools/scheduled-runs.pg.test.ts`: migration 389 and `runScheduled` on the production composition over a throwaway database with real PTYs, the token resolved by production auth. The reviewer's checks are one `it` each: (1) the mint admits only no-bearer claims whose authority is a marked edge; (2) kind-agent token acting as the persona, revoked on every exit path including launch failure; (3) the version is never null; (4) two firings are two runs and a retry is a replay; (5) `tm8Access: none` mints nothing; (6) no path produces a human-kind or persona-less token; plus bound secrets are used only when the firing account may use them. (7), a parked loop never reaching the mint, is the loop executor's test.

```sh
cd packages/server
./node_modules/.bin/vitest run test/tools/scheduled-runs.test.ts test/tools/execution.test.ts
TM8_W1_ADMIN_DATABASE_URL=postgres://tm8@127.0.0.1:5443/postgres \
  ./node_modules/.bin/vitest run --no-file-parallelism test/tools/scheduled-runs.pg.test.ts
```
