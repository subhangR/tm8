# Jev client and activation records

`JevClient.ask(state, questions, options?)` still returns a result or `null`.
`askDetailed` returns `{ok: true, response, jevModel, latencyMs}` or
`{ok: false, reason, jevModel, inputTokens, latencyMs}`. Defaults are a 5000 ms
**total** budget, 2000 ms per attempt and one retry. Constructor defaults can
be overridden per call; the old constructor `timeoutMs` aliases
`attemptTimeoutMs`. The deadline covers retries, fetch and response-body
parsing, including transports that ignore cancellation. JavaScript cannot
preempt synchronous serialization or parsing; an overrun is detected before
accepting a result, while stalled asynchronous work is raced against a timer.

429, 529, other 5xx, timeouts and network failures may retry while budget
remains. Other HTTP failures, missing keys and malformed answers stop at once.
Failure reasons are `timeout`, `budget`, `429`, `529`, `5xx`, `no_key`,
`unparsed`, `http_error` and `network`. No response body or exception text is
copied into a failure record.

Routing, context and roster expose `adviseDetailed`, `planDetailed` and
`chooseDetailed`. Each returns `{value, activation}`. Failed attempts have a
`JevFailureActivation` with an explicit reason and `value: null`; skipping an
activation (off, no task, no candidates) has both fields null. Existing
`advise`, `plan`, and `choose` retain their nullable fail-open behavior.
Environment factories still omit an advisor when policy is off or the key is
absent. A caller that needs a `no_key` activation can construct a client with
an empty key and call a detailed advisor method. Server migration is separate.

Every logical ask submits exactly one usage entry, including exhausted retries,
missing keys and unparsed responses. `usage` supplies `caller`, `spaceId` and
`subjectId`; advisors supply their caller and task attribution. Unavailable IDs
are null. The row also contains `at`, `jevModel`, `inputTokens`, `costUsd`,
`latencyMs` and `outcome`. Tokens are reported usage, not an estimate for failed
requests without usage. Cost uses the existing Jev input-token rate. The
ledger contains no state, prompts, questions, skill bodies, secrets or errors.

The default sink appends `jev-usage.jsonl` under `dataDir`, or the node root
selected by `TM8_DATA_DIR` / `TM8_ENV`. Pass `usageSink` to replace persistence,
`fetchImpl` to replace transport, and `now` to control the millisecond clock.
Environment factories accept these through `clientOptions`. Sink failures are
swallowed; writes run asynchronously so disk cannot hold up launch. An abrupt
process exit can lose a pending row. `client.flushUsage()` optionally drains
pending writes for tests or orderly shutdown; it is outside the call budget.

`jevModel` is the actual non-alias identifier echoed by the service, including
dated/build identifiers. Missing, blank, unknown and floating alias identities
are null; no requested alias is substituted. Context/roster records also carry
`jevModels` for distinct concrete versions across groups/chunks. Their singular
`jevModel` is null if any contributing identity is unknown or versions differ.
Consumers must not use a null identity as a concrete-model cache key.

`contextIntentFor` and its input types are exported by `@tm8/jev`. The pure
builder accepts `(persona, task, sheet, eligibleSkills)` supplied by an
authorized loader. It deduplicates entities within each group, preserving
source order and the first row's provenance. Legacy strings retain null entity
identity. A structural legacy overload accepts the existing spawn context's
`teamMember`, `skills` and `tasks` shape and preserves `m<i>`, `s<i>` and `t<i>`
positions. `ContextDecision` adds `entityId`, `entityVersion`, `widened` and
`source` alongside the original positional `id`. This package does not discover
eligible entities or change filesystem, access, score or selection caps.
