# TM8 CLI Session Command Journal

**Status:** BUILT and verified end-to-end (2026-08-01). See §17 for what was
actually shipped and where it deviates from this design.
**Task:** `019fbbcb-8dc2-74fa-9862-5a0f50fc3d32` — CLI tm8 command tracking
**Date:** 2026-08-01

**Part 1 (§1-9)** — the journal itself: a file per session, written by the CLI.
**Part 2 (§10-15)** — the Debug tab on the session panel, and the read path the
UI needs to see any of it. Part 2 was added after review and it changes one
premise in Part 1 — see §10.

---

## 1. What is being asked

For a given session, produce the exact per-session record of every `tm8` command
the teammate ran: the command, its input, its output, its response, and a
measure of tokens in each direction. No database — a file per session.

## 2. The one-paragraph answer

Every `tm8` invocation is its own short-lived process, and that process already
knows which session it belongs to (`TM8_SESSION_ID` is injected into every
spawned agent's environment at `packages/execution/src/spawn/manifest.ts:564-573`).
So the journal needs no daemon, no database and no IPC: **each invocation
appends one JSON line describing itself to a session-scoped file just before it
exits.** Concurrency is handled by the OS (`O_APPEND`), ordering by a monotonic
sequence plus timestamps, and absence of a session by writing nothing at all.

## 3. Where the file lives, and how the CLI finds it

The task frames this as part of the environment manifest, and that is the right
seam. Two additions, both in the spawn path:

1. `Tm8Manifest` (`packages/execution/src/spawn/types.ts:286-361`) gains a
   `journal: { path: string; version: '1' }` block.
2. `composeEnv` (`packages/execution/src/spawn/manifest.ts:558-640`) injects
   `TM8_JOURNAL_PATH` alongside the existing always-set vars at `:564-573`.

Path: `<dataDir>/journals/<sessionId>.jsonl`, sibling to the existing
`<dataDir>/manifests/<sessionId>.json` (`SpawnService.ts:134-136`), `dataDir`
defaulting to `~/.tm8-dev` (`SpawnService.ts:127`).

**Why not the session cwd.** A projectless session gets its own scratch dir
(`~/.tm8-dev/scratch/<sessionId>/`, `SpawnService.ts:203`), but a project-backed
session's cwd is the *shared* project directory — a journal written there would
have every session of that project appending to one file and would land inside
the user's repo. The journal root must be session-keyed, not cwd-derived.

`recordManifest` (`types.ts:228-233`) already records env var *names* into the
graph, so `TM8_JOURNAL_PATH` becomes discoverable without storing its value.

**The gate:** if `TM8_JOURNAL_PATH` is unset, the journal is a complete no-op.
A human running `tm8` at their own terminal writes nothing, creates nothing, and
pays nothing. Journaling exists only inside a spawned session.

## 4. The four capture points

All four already exist as single chokepoints. Nothing new needs to be threaded
through the command layer, and no individual command file is touched.

| # | What | Where | Captures |
|---|------|-------|----------|
| 1 | Whole invocation | `run()` — `packages/cli/src/run.ts:235-249` | argv, resolved command path, globals, exit code, wall-clock duration, error class |
| 2 | stdout / stderr | `OutputStreams` seam — `packages/cli/src/output.ts:19-27` | exact byte counts + bounded samples of what the agent will read back |
| 3 | stdin | `readStdin` — `packages/cli/src/args.ts:444-455` | byte count of piped input (`-`) |
| 4 | Each HTTP call | `Tm8Client.send()` — `packages/cli/src/client.ts:203-244` | operation name, method, path, status, request-body bytes (`:228`), response-body bytes (`:242`), duration |

Point 2 is the important one and it is free: `Output` already takes an injected
`streams` object (`output.ts:35`, defaulting to `processStreams` at `:24-27`).
The journal supplies a **tee** — pass every chunk through to the real stream
unchanged, and accumulate length on the way past. No buffering of the full
output, no change to what the agent sees, no reordering.

Point 4 matters because it separates *what the agent asked for* from *what the
server actually did*. One `tm8` command can be zero, one, or several HTTP calls;
recording only the outer invocation would lose the `--server` retarget, the
retries, and the operation names that make the log diagnosable.

## 5. Record shape

One JSON object per line. Field names are stable; unknown fields must be
ignored by readers so the shape can grow.

```json
{
  "v": 1,
  "seq": 42,
  "sessionId": "019fbbcd-cef8-7701-ae98-3d5f1d459ed8",
  "spaceId": "019fb748-0068-76dc-9869-1bb36133c554",
  "teamMemberId": "019fb754-73f6-7771-9204-f45d56598ca1",
  "pid": 51221,
  "startedAt": "2026-08-01T14:22:07.114Z",
  "durationMs": 214,

  "command": {
    "path": ["message", "send"],
    "argv": ["message", "send", "--to", "019f…", "milestone: gates green"],
    "options": { "to": "019f…", "format": "json" },
    "cwd": "/Users/subhang/Desktop/projects/tm8"
  },

  "input":  { "stdinChars": 0 },
  "output": {
    "stdoutChars": 4211,
    "stderrChars": 0,
    "stdoutSample": "{\n  \"id\": \"019f…\",\n  \"kind\": \"message\"…",
    "truncated": true
  },

  "calls": [
    { "operation": "messages.send", "method": "POST", "path": "/v1/messages",
      "status": 200, "requestChars": 186, "responseChars": 4180, "durationMs": 173 }
  ],

  "result": { "exitCode": 0, "error": null },

  "tokens": {
    "estimator": "chars/4",
    "agentToCli": 21,
    "cliToAgent": 1053
  }
}
```

### Direction semantics — stated plainly

- **`agentToCli`** — the command line and any stdin the teammate produced.
  These are tokens the agent *emitted*: its output tokens.
- **`cliToAgent`** — stdout plus stderr, which land in the teammate's context on
  the next turn. These are tokens the agent will *consume*: its input tokens.

Summing `cliToAgent` across a session gives the honest answer to "how much of
this agent's context was spent on tm8 CLI output", which is the number the task
is actually after.

### On the token numbers — the caveat that must stay attached

Per the review decision, counts are **byte-derived estimates**, not tokenizer
output. `@tm8/cli` has exactly two dependencies today, both `workspace:*`
(`packages/cli/package.json`), and adding a tokenizer would put a WASM or
large-table load on the startup path of *every* `tm8` invocation — including the
ones inside tight agent loops.

So the journal records **exact character counts** (which are ground truth and
never wrong) plus a `chars/4` estimate, and it names its estimator in every
record. A reader who wants exact counts can re-tokenize from the samples or from
the character counts offline; the field name `estimator` exists so nobody later
mistakes the estimate for a measurement.

**These are CLI-boundary tokens, not model billing.** They measure text crossing
the CLI seam. They are not the teammate's provider-reported usage, they do not
include the system prompt or conversation history, and they must never be
reported as the session's token spend.

## 6. Writing it safely

**Never change the command's behaviour.** The entire journal write sits in a
`try/catch` that swallows. A full disk, a read-only path or a malformed record
must not alter the exit code and must not print anything — `run()` is the single
error funnel (`run.ts:245-248`) and the journal must not inject into it.

**Never touch stdout.** Output law (`output.ts:1-13`) is that stdout carries data
and nothing else, because `worker init` pipes stdout straight into an agent's
context. The journal writes only to its own file.

**One `write()` per record, `O_APPEND`.** Separate processes append concurrently;
a single append-mode write of a bounded record is atomic in practice and needs no
lock file. This is why records must be *bounded* — see below.

**Bounded records.** `stdoutSample` is capped (proposal: 2 KB) and flagged
`truncated`. Character counts are always exact regardless of truncation. A
`tm8 graph` dump of several MB must not produce a several-MB journal line.

**Redaction.** `TM8_AGENT_TOKEN` and `Authorization` never enter a record; the
existing `send()` sets the bearer at `client.ts:215-217` and the journal captures
only method, path, status and sizes — never headers. Option *values* are captured,
so any option carrying a secret needs an explicit denylist before this ships.

**Streaming commands.** `session drive`/`view` and `event stream` are long-lived
and forward raw bytes (`commands/session.ts:298-306`). They emit their record on
exit like any other command; the counts are the totals for the attachment.

## 7. What this deliberately does not capture

Stating the boundary so the log is not over-trusted:

- **Only `tm8` commands.** `git`, `npm`, file edits — anything else the teammate
  runs in its shell is invisible here. This is a tm8-CLI journal, not a shell
  history.
- **Not the model's real token usage.** See §5.
- **Not another session's commands.** The journal is keyed by the injected
  `TM8_SESSION_ID`; a teammate driving another node with `--server` still writes
  to *its own* journal, which is correct — but the record's `calls[].path` is
  then the only evidence of where the effect landed. Worth recording the
  resolved `baseUrl` per call for exactly this reason.
- **Not resumed-session continuity across manifests.** Resume rewrites the
  manifest (`SpawnService.ts:614`); the journal path is session-keyed, so a
  resumed session appends to the same file. Sequence numbers restart per process,
  which is why `seq` must be paired with `startedAt` for ordering.

## 8. Implementation plan

Small, and mostly in one new file.

1. **`packages/execution`** — add `journal` to `Tm8Manifest` (`types.ts:286-361`),
   compute the path in `SpawnService` next to `manifestPathFor` (`:134-136`),
   inject `TM8_JOURNAL_PATH` in `composeEnv` (`manifest.ts:564-573`).
2. **`packages/cli/src/journal.ts`** (new) — `openJournal(env)` returning either a
   no-op sink or a real one; the stream tee; the record builder; the bounded
   append-on-exit write.
3. **`packages/cli/src/run.ts:235-249`** — construct the journal, wrap the
   `Output` streams with the tee, record the outcome in both the success and the
   catch path.
4. **`packages/cli/src/client.ts:203-244`** — push one call-record per `fetch`.
5. **`packages/cli/src/manifest.ts`** — read the new `journal` block (the reader
   is field-for-field with the writer today; it will reject the new field
   otherwise).
6. **Reader (proposed, phase 2)** — `tm8 session journal <sessionId>` rendering
   the file as a table with per-session totals. Deferred: the file is JSONL and
   `jq` covers the first use.

**Tests.** Journal-off writes nothing; journal-on writes one line per invocation;
counts match a known fixture exactly; a write failure leaves the exit code
untouched; two concurrent processes produce two intact lines; a large output is
truncated with counts still exact.

## 9. Open questions for review

1. **Sample size.** Is a 2 KB `stdoutSample` the right cap, or should the journal
   store counts only (smaller, less useful for reconstructing what the agent saw)?
2. **Option-value redaction.** Which options, if any, may carry secrets? A denylist
   is needed before this ships; I have not enumerated one.
3. **Retention.** Journals accumulate per session and nothing deletes them today.
   `SpawnService.ts:985` deletes the manifest on teardown — should the journal
   survive that (I assume yes, it is the record) and if so, what prunes it?
4. **Should the journal be graph-visible at all?** The task says no database, and
   this design honours that. But a `journalPath` on the session entity would make
   it findable from the UI without changing where the bytes live.

---

# Part 2 — The Debug tab

## 10. The premise Part 1 got away with, and no longer can

Part 1 said "no database, a file on disk" and that is still right for the
*write* path. But **a file in `~/.tm8-dev/journals/` is not reachable from a
browser**, and the audit found there is no precedent to lean on:

> No operation serves the manifest, agent logs, or PTY scrollback over HTTP.
> The only FS-backed read is `files.download`, and it serves *blob-store rows
> keyed by file entities* (`packages/server/src/files/w2-blob-store.ts:83-98`),
> not arbitrary dataDir paths. PTY scrollback reaches the UI only over the
> WebSocket (`packages/server/src/pty/pty-ws-server.ts:278-326`), never HTTP.

So showing the journal in the UI **requires one new read operation**. That is
new ground and it is the single riskiest thing in this document, so it is
specified tightly in §11 rather than waved at.

Three ways to close the gap, and why one wins:

| | Approach | Verdict |
|---|---|---|
| A | New read op that serves the session's journal file | **Chosen.** Keeps "no database", works while the session is live |
| B | Write journal records to Postgres | Rejected — you explicitly said no database, and it puts a DB write on every CLI invocation |
| C | Upload the journal as a file entity at teardown | Rejected — reuses the blob store, but the data only exists *after* the session ends, which is exactly when it stops being useful for debugging |

## 11. The read operation

`execution.journal` — `GET /v2/work-sessions/:workSessionId/journal`

Registered beside the existing execution ops (`packages/contract/src/catalog.ts:142-146`,
handlers at `packages/server/src/facade/execution-handlers.ts:848-1001`). The
server already has `dataDir` in hand: `ExecutionRuntimeDeps.dataDir`
(`execution-handlers.ts:549-553`), wired from `main.ts:108`.

**This is not "read a file from dataDir", and the distinction is the whole
security argument.** No path, prefix, or filename ever comes from the request.
The handler:

1. Takes `workSessionId` from the route and validates it as a UUID.
2. Resolves it through the DB — the entity must exist, be `kind: 'work_session'`,
   and the caller must be authorised to read it. Authorisation is the *existing*
   entity read check; the journal inherits it rather than inventing one.
3. Constructs the path itself: `join(dataDir, 'journals', `${sessionId}.jsonl`)`.
4. Asserts containment before opening, the same discipline as
   `w2-blob-store.ts:80-98`.

A general file-read op would be a directory-traversal surface. This one can only
ever name a file whose path it computed from a UUID it just validated against the
database.

**Bounded response.** A long-lived session can accumulate thousands of records
and the response must not be proportional to that:

```json
{
  "sessionId": "019f…",
  "available": true,
  "totals": { "invocations": 412, "failed": 7,
              "agentToCliEst": 8104, "cliToAgentEst": 412903,
              "estimator": "chars/4" },
  "records": [ /* tail-N, newest last, N default 100 */ ],
  "cursor": { "before": 312, "hasMore": true }
}
```

Totals are computed over the **whole** file, records are a window. That way the
headline number is honest even when the table is truncated.

`available: false` (with a reason) when the file does not exist — a session that
predates the feature, or one spawned with journaling off. That is a real and
common state and it renders as an explained empty, never as a zero.

**Live updates.** Liveness is already polled rather than pushed
(`data/real/liveness.ts:20`), and journal records are written by short-lived CLI
processes that emit no event, so there is nothing to subscribe to. The tab polls
while it is open *and* the session is live, and stops on both counts. No polling
behind a closed tab, none for a finished session.

## 12. The tab itself

### Registration — and the duplicated declaration that will bite

`PanelTab` and `PANEL_TABS` are declared in **two** places, and a tab added to
only one is silently dropped from the URL:

- `packages/tm8-ui/src/panels/detail/chrome.tsx:24` and `:31` — drives `TabStrip`
- `packages/tm8-ui/src/routes/types.ts:12-13` — drives the router; consumed at
  `routes/codec.ts:64` (`new Set(PANEL_TABS)`), parsed from `t=` at `:212`,
  serialized at `:356-357, 412-414`

Both get `'debug'`.

### Making it session-only

`TabStrip` currently maps `PANEL_TABS` unconditionally (`chrome.tsx:340`), so it
needs a `tabs` prop defaulting to `PANEL_TABS`, and `EntityDetailPanel` passes a
filtered list. A Debug tab on a doc or a task would be noise.

The gate must be **`isTerminal`**, which already exists at
`EntityDetailPanel.tsx:351` and derives from `config.panel.archetype`. It must
*not* be a kind check: `panels/no-branching.test.ts` fails the build on any
`kind === '…'` literal in panel code.

Body mounts as a new arm in `PanelBody`'s `if` chain
(`EntityDetailPanel.tsx:435-451`), before the Content fallthrough. It is not
added to `AUX_TABS` (`views/EntityView.tsx:70`), so it renders in the centre
panel rather than the right-hand aux column — correct for a wide table.

### Layout — four sections, in the order you debug in

```
┌ Session · Debug ─────────────────────────────────────────────┐
│  ~412k tokens into context · ~8.1k out · 412 commands · 7 failed
│  estimate, chars/4 · CLI boundary only, not model usage      │
├──────────────────────────────────────────────────────────────┤
│  ▾ Identity & environment                                     │
│    teammate · tool · model · permission mode · workdir        │
│    interaction profile · project · manifest version           │
├──────────────────────────────────────────────────────────────┤
│  ▾ Prompt                                                     │
│    the composed prompt this session actually received,        │
│    with the budget breakdown by section                       │
├──────────────────────────────────────────────────────────────┤
│  ▾ Commands & tokens                        [live ●] [filter] │
│    time    command              exit  ms   calls  in↓   out↑  │
│    14:22   message send          0    214    1   ~1053   ~21  │
│    14:23   entity create doc     2     88    1     ~12   ~34  │
│    ▸ expanded: argv, stdout sample, each HTTP call            │
├──────────────────────────────────────────────────────────────┤
│  ▾ Journey                                                    │
│    spawn → prompts → handoffs → exit, on one timeline         │
└──────────────────────────────────────────────────────────────┘
```

### Where each section's data comes from — three of four are already free

| Section | Source | New work? |
|---|---|---|
| Identity & environment | manifest, via the same `execution.journal` op (redacted) | serves existing data |
| Prompt | the composed prompt (`composePrompt`, `SpawnService.ts:271`); budgets in `packages/prompt/src/budgets.ts`; the *catalog* side is already a build-time import the UI uses at `prompts/PromptsScreen.tsx:29` | serves existing data |
| Commands & tokens | the journal — §5 | the only genuinely new data |
| Journey | **already in the panel's props**: `activity`, `handoffs`, `liveness` (`EntityDetailPanel.tsx:110-122`), fed by `useGateData` | **none** |

The Journey section is nearly free in another way too: `bodies/SessionAnatomy.tsx`
already defines a block vocabulary `'provenance-strip' | 'exit-summary' |
'transcript'` (`:51`) and **is not mounted anywhere** — the terminal arm goes
straight to `WorkSessionContent`. The Debug tab is the surface that vocabulary
was built for.

### Data flow

The journal takes the self-fetching pattern, not the props pattern. Every
existing tab gets its data as props from `useGateData` (`views/useGateData.ts:866-872`),
but the journal is polled, tab-scoped, and needed by exactly one surface —
threading it through the central store would make every view carry it. The
precedent is `channel-screen/LazySessionChatSurface.tsx`, which receives `seam`
and does its own reads. Same shape here: a `seam.journal(sessionId, cursor)`
read added at `data/seam.ts` alongside `handoffs` (`:223`), implemented in
`data/real/ops.ts` next to the other execution ops (`:418-437`) via `bindPath`.

## 13. Honesty rules for this surface

A debug tab that lies is worse than no debug tab. The panel already has a
vocabulary for this — `panels/honesty/` (`DisabledWithReason`, `HollowValue`,
`NOT_WIRED_REASON`) — and it is used rather than bypassed:

- **Every token number carries `~` and the estimator in the section header.**
  `~1,053 est · chars/4`, never a bare `1,053`. The UI must not be the place the
  estimate quietly becomes a measurement.
- **"CLI boundary only, not model usage"** sits in the header, permanently.
  Someone will otherwise read the headline as the session's billed spend.
- **No journal file → an explained empty**, naming which reason (predates the
  feature / journaling off / session never spawned), via `DisabledWithReason`.
  Not a zero, not a spinner.
- **Truncated stdout samples are marked truncated**, with the exact character
  count beside them — the count is ground truth even when the sample is not.
- **Non-tm8 shell commands are absent and the section says so.** §7's boundary
  has to be visible here or the table reads as a complete shell history.

## 14. CSS

New `packages/tm8-ui/src/panels/detail/debug.css`, imported by its component —
the established per-body pattern (`bodies/session-anatomy.css`, etc.).

- Every rule scoped `.cv2-root .pn-…`; the leading `.cv2-root` is mandatory (it
  is the token scope).
- Prefix `pn-debug__…`.
- Tokens only — `var(--pn-ink)`, `--pn-line`, `--pn-mono`. Raw hex is banned by
  `src/hex-ban.test.ts`.
- Body root must be `<div className="pn-body" id="tabpanel-debug" role="tabpanel"
  aria-labelledby="tab-debug">` to match the other tabs (`detail/tabs.tsx:45,158,218`).
- The command table is the one wide thing in the panel; it scrolls in its own
  container so the panel body never scrolls horizontally.

## 15. Revised implementation plan

Part 1 steps 1-5 stand. Added:

6. **`packages/contract`** — declare `execution.journal` in the catalog.
7. **`packages/server`** — handler per §11: UUID validation, DB resolution,
   server-computed path, containment assert, bounded response with totals.
8. **`packages/tm8-ui/src/data`** — `journal` read on the seam + `real/ops.ts`
   wrapper via `bindPath`.
9. **`packages/tm8-ui`** — `'debug'` into **both** `PanelTab`/`PANEL_TABS`
   declarations; `tabs` prop on `TabStrip`; `isTerminal` gate; `PanelBody` arm;
   `DebugTab` component + `debug.css`; mount `SessionAnatomy`'s existing blocks
   for the Journey section.

**Tests.** The op refuses a non-UUID, a non-work_session entity, and an
unauthorised caller; it cannot be made to open a path outside `<dataDir>/journals/`;
a missing file returns `available:false` and not a 500; totals stay correct when
records are windowed. UI: the tab appears only for the terminal archetype; it
survives a URL round-trip through the codec; a missing journal renders the
explained empty; polling stops when the tab closes and when the session is not live.

## 16. Additional open questions

5. **Who may see the Debug tab?** It inherits the entity read check, so anyone
   who can see the session sees its commands. Should it instead be owner-only,
   or gated behind the existing `realSeamFlag`-style dev flag?
6. **Does the prompt section need redaction of its own?** The composed prompt
   contains the teammate's persona and directive, which is fine, but it is
   assembled from sources I have not audited for secrets.
7. **Poll cadence** while a session is live — liveness uses its own cadence
   (`real/liveness.ts:139`); should the journal reuse it or run slower?

---

# Part 3 — As built (2026-08-01)

## 17. What shipped, and where it deviates from the design above

**Deviations, each deliberate:**

1. **No manifest field; the env var alone carries it.** §3 proposed a `journal`
   block on `Tm8Manifest`. Not needed: `envVarNames` is derived from the composed
   env and already reaches the graph via `recordManifest`, so `TM8_JOURNAL_PATH`
   is discoverable without a manifest field and without touching the CLI's
   field-for-field manifest reader. `composeEnv` gained an optional `journalPath`
   parameter — omitting it is how journaling stays off.
2. **No fifth tab.** USER RULING: the Debug surface is a **third chip** on the
   existing Terminal|Chat switch, not a panel tab. §12's tab plan is superseded.
   The switch used to render *only when chat was enabled* (an early return);
   that is gone, so a session with no chat pin now shows Terminal|Debug.
3. **`tm8 session journal <id>` shipped in the same change**, not deferred to a
   phase 2 as §8 step 6 proposed. `discovery-commands.test.ts` refuses to let the
   grammar publish a command path with no registry handler, so documenting the
   operation obliged implementing the command. The guard was right.
4. **Direction is stated from the AGENT's perspective everywhere.** The first
   implementation had the header stats and the table columns on *opposite*
   perspectives, so the same quantity read as "in" in one place and "out" in the
   other and the headline named the wrong direction. Now: `cliToAgent` = "into
   agent context" (the large number), `agentToCli` = "typed by agent".
   `SessionDebugBody.test.tsx` pins it.

**Open questions from §9/§16, resolved:**

- *Sample cap* → 2 KB, `SAMPLE_CHARS` in `packages/cli/src/journal.ts`. Counts stay exact.
- *Redaction* → implemented at WRITE time, so a secret never reaches disk:
  option names matching `token|secret|password|credential|api[-_]?key|bearer|
  authorization` have their value replaced, in both `--k v` and `--k=v` spellings.
- *Debug visibility* → inherits the ordinary entity read check. Anyone who can
  read the session can read its commands. **Still worth a ruling if that is too broad.**

**Still open:**

- **Retention. Nothing prunes `<dataDir>/journals/`.** Journals survive session
  teardown by design (the manifest is deleted at `SpawnService.ts:985`; the journal
  is the record and should outlive it) but they grow without bound.
- The composed prompt was NOT audited for secrets; the Debug surface shows
  identity/commands, not the prompt body.

## 18. Verification actually performed

End-to-end against a real server (port 8891, staging DB, isolated dataDir),
using the built CLI as the writer and the HTTP op as the reader:

| Check | Result |
|---|---|
| Writer → file → HTTP read | 4 invocations, 1 failed; operations and statuses correct |
| Before any command | `available:false`, `no_journal_file` — not an empty table |
| Token math | 5982 chars → 1496 = `ceil(5982/4)` |
| **stdout byte-identical** with journaling on/off | same sha1 |
| Journal path unwritable | exit code unchanged (0) |
| 12 concurrent invocations | 12 intact JSON lines, none torn |
| Secret redaction | plaintext secrets absent from the file |
| Malformed line | counted in `totals.malformed`, skipped, no 500 |
| **Symlink escaping the journals dir** | refused (realpath containment) |
| **Path traversal in the id** | refused at UUID validation |

Suites: CLI 1049 unit ✅ · execution 127 ✅ · server journal 9 ✅ · tm8-ui 1653 ✅
(101 files) · UI production build ✅.

**NOT verified: no browser ever rendered this.** No Chrome extension was
connected, so the Debug surface has only jsdom coverage — structural, not pixel.
Nobody has looked at it.

## 19. The landmine this change hit

Adding ONE row to the contract catalog broke **32 tests across 9 files**, none of
which name the real cause. Frozen count pins (total rows, v1 count, HTTP count,
exposure histogram, per-noun command lists), a **pinned** `CATALOG_DIGEST` in
`packages/cli/src/discovery/operations.ts` (deliberately not computed — `node:crypto`
is unresolvable in a browser bundle), and `tools/conformance`'s generator, whose
own accounting asserts must be updated before it will regenerate.
