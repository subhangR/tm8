# The Harness Registry

**Status:** DESIGN. Nothing here is built. Reviewed and agreed before implementation.
**Analysis base:** `3edf470f034cce6228aac98aa78ef1eb03239ae3` (`origin/main`).
**Sibling:** [`AO-VS-TM8-COMPONENT-ANALYSIS.md`](AO-VS-TM8-COMPONENT-ANALYSIS.md) — where the gap was measured.
**Out of scope:** activity signals. That is `ACTIVITY-SIGNAL-DESIGN.md`, owned separately. Phase 3 below references it and does not design it.

**Terminology warning.** This document uses "harness" to mean *an adapter for one
agent CLI*. `HARNESS-FLAVORS-AND-ORCHESTRATION-PLAN.md` uses "harness" to mean *the
prompt composition an agent boots with* (Cartographer / Navigator / Conductor). The
two are orthogonal — any flavor can run on any harness. They share a word and nothing
else.

---

## 1. The argument: this is a law violation, not a missing feature

Adding agent CLIs to tm8 reads like a feature request. It is not. tm8 has a written
law about exactly this shape of code, and `buildAgentCommand` is on the wrong side
of it.

**T-L4** (`docs/architecture/01-LAWS.md:29-33`) — *"Kinds are data — including
user-defined kinds"*:

> *Forbids:* `if (kind === '…')` outside the registry; dynamic DDL.

And here is the dispatch that actually decides which binary a session runs
(`packages/execution/src/spawn/manifest.ts:552-581`):

```ts
const raw = override || AGENT_TOOL_BINARIES[launch.agentTool];
if (!raw) throw new SpawnError(`unsupported agent tool: ${launch.agentTool}`, 'invalid_input', …);

if (raw === ECHO_AGENT_CMD) return `node ${shellQuote(echoAgentPath())}`;
if (raw === 'codex')        return renderCodexCommand(buildCodexArgs(launch, …));
if (raw !== 'claude')       return raw;

const args: string[] = [];
if (launch.permissionMode === 'bypassPermissions') args.push('--dangerously-skip-permissions');
else args.push('--permission-mode', mapClaudePermissionMode(launch.permissionMode));
if (launch.model)           args.push('--model', shellQuote(launch.model));
if (launch.reasoningEffort) args.push('--effort', launch.reasoningEffort);
if (opts.claudeSessionId)   args.push('--session-id', shellQuote(opts.claudeSessionId));
return ['claude', ...args].join(' ');
```

A three-entry lookup table followed by a chain of string equality tests, with one
provider's entire flag vocabulary inlined into the tail of the function. Adding a
third real agent means adding a fourth branch here — and then finding every other
place that made the same assumption.

**How honest is the T-L4 appeal?** It should be stated precisely, because overclaiming
it would weaken the case. **T-L4 is written about entity kinds.** Its subject is the
`KindRegistry` and the `entity_kinds` table; `agentTool` is not an entity kind, and a
literal reading of the law does not reach this file. The argument here is that the
law's *principle* extends, and it rests on three things rather than on the letter:

1. **The forbidden shape is the same shape.** T-L4 does not forbid `if (kind === …)`
   because kinds are special. It forbids it because behaviour keyed on a string
   literal makes the set of legal values a property of the *code* rather than of a
   *registry* — and every such site must then be found and edited in lockstep. That
   is precisely what `buildAgentCommand` does.
2. **tm8 already applies the pattern beyond entity kinds.** The edge-type registry,
   the interaction-profile registry, and the operation catalog (T-L12) are all the
   same move applied to non-kind vocabulary. A registry is tm8's default answer to
   "an open set of named things with per-name behaviour."
3. **The cost is already being paid.** Below.

**35 sites already branch on the string** — non-test, across four packages:

| Package | Sites | Representative |
|---|---|---|
| `execution` | 18 | `SpawnService.ts:1024-1025`, `manifest.ts:207`, `agent-config-dirs.ts:11-13`, `read-transcript.ts:752-775` |
| `tm8-ui` | 10 | `domain/launch.ts:58,65`, `settings-space/ModelsSection.tsx:93`, `views/useGateData.ts:2323` |
| `server` | 2 | `chat/compose.ts:230`, `chat/handlers.ts:36` |
| `cli` | 2 | `commands/session.ts:447`, `commands/project.ts:137` |

*(Command: `grep -rn "agentTool ===\|agentTool !==" --include=*.ts --include=*.tsx
packages/ | grep -v test`.)*

Every one of those is a place a third harness can be forgotten. The registry's job is
to make forgetting impossible: **one dispatch point, and a compile error anywhere a
capability is assumed rather than asked for.**

**The failure mode this actually prevents is already in the tree's history.** The
comment above `AGENT_TOOL_BINARIES` (`manifest.ts:481-490`) records what happened the
last time a tool selection failed to reach the dispatch point:

> *"a per-session `agentTool: 'codex'` landed on the work_session row, the manifest,
> and `TM8_AGENT_TOOL` — everywhere EXCEPT the one place that decides which binary the
> PTY actually runs… Measured 2026-07-28: a spawn with `agentTool: 'codex'` produced a
> work_session row and manifest that both said `codex`, while the live PTY's argv
> (`ps -p <pid> -o args=`) was the bare `claude` command."*

That table was the fix. The registry is the same fix, generalised — and applied
before the next tool arrives rather than after it silently launches the wrong binary.

---

## 2. Two corrections to the premise, and they both make the work smaller

The task that commissioned this document carried two assumptions from the prior
analysis. Neither reproduces at `3edf470f`, and the corrected versions change the
shape and the cost of Phases 1 and 2. They are stated up front because a reviewer
comparing this document to its brief will otherwise read them as omissions.

### 2.1 `agentTool` is *not* a literal union on the wire

The premise was: *"`agentTool`: literal union → registry-validated id."*

**It is already `z.string().nullable()` almost everywhere.** In
`packages/contract/src/schemas.ts` the field is an open string at lines **322, 371,
2273, 2416, 2626**. `ResolvedLaunchConfig.agentTool` is declared `string`
(`manifest.ts:175`). `AGENT_TOOL_CREDENTIAL_PROVIDER` is deliberately *"keyed on the
resolved `launch.tool` string rather than a union"* (`agent-credentials.ts:44-47`).

The union survives in exactly **three** contract locations:

| Location | What it types | Should it open? |
|---|---|---|
| `schemas.ts:2950` | `SessionTranscriptPage.agentTool` | **Yes** — it names the transcript dialect parsed. |
| `contract.ts:4215` | the same field's TS mirror | **Yes** — same field. |
| `launch-models.ts:12` | `LaunchModelCatalogEntry.agentTool` | **No.** See §8 — this one is *deliberately* closed. |

plus `KNOWN_AGENT_TOOLS` in `packages/tm8-ui/src/domain/model-catalog.ts:30`, whose
own comment already states the design intent precisely: *"Free strings on the wire; a
closed set here, because the launcher builds a different CLI invocation per tool."*

**Consequence.** The contract migration is **two response fields and a UI constant**,
not a sweep of 463 occurrences. The 463 figure counts *reads of an already-open
string*, and reads do not need migrating. Phase 1 shrinks accordingly (§5), and the
real cost moves to where it always was: the 35 dispatch sites in §1.

### 2.2 The credential provider table already exists

The premise was: *"Generalise `knownAgentConfigDirs` from the anthropic/openai ternary
to a provider table driven by `capabilities.credentialProvider`."*

**The provider table is already there**, in `packages/execution/src/spawn/agent-credentials.ts`:

```ts
export const AGENT_TOOL_CREDENTIAL_PROVIDER: Readonly<Record<string, AgentCredentialProvider>> = {
  'claude-code': 'anthropic',
  codex: 'openai',
};                                                        // :48

export const AGENT_CREDENTIAL_CONFIG_DIR_VAR = {
  anthropic: 'CLAUDE_CONFIG_DIR',
  openai: 'CODEX_HOME',
} as const satisfies Record<AgentCredentialProvider, string>;   // :60
```

The ternary the premise describes survives in exactly one place —
`packages/execution/src/transcript/agent-config-dirs.ts:11-13` — and it is a **drifted
duplicate** of the table above, carrying *two* independent ternaries (one for the
provider, one for the directory name) that must be edited together:

```ts
const provider = opts.agentTool === 'claude-code' ? 'anthropic'
  : opts.agentTool === 'codex' ? 'openai' : null;
const nodeDir = join(opts.home ?? homedir(), opts.agentTool === 'codex' ? '.codex' : '.claude');
```

**Consequence.** Phase 2 changes character: it is *deduplication first* — delete the
ternaries, point `knownAgentConfigDirs` at the existing table — and only then widening
`AgentCredentialProvider` past `'anthropic' | 'openai'`. Smaller, and lower risk,
because the hard thinking (which env var redirects which CLI, verified in both
directions with a positive control — `agent-credentials.ts:56-61`) is already done.

---

## 3. What a harness is

Shaped to tm8's existing vocabulary — `ResolvedLaunchConfig`, `SpawnError`,
`PermissionMode` — and deliberately **not** a transliteration of AO's Go interface. A
Go `interface` with 26 implementations is the right answer in a language with no
discriminated unions and no structural typing of capabilities. tm8 has both, and it
already has a house style for this: a frozen record of typed descriptors with a
lookup, exactly like `OPERATIONS` (T-L12) and `AGENT_TOOL_CREDENTIAL_PROVIDER`.

```ts
// packages/execution/src/harness/types.ts

/** What a harness can be ASKED to do. Every field is a question the caller must
 *  ask rather than assume — that is the whole point of the registry. */
export interface HarnessCapabilities {
  /** Which vendor credential this tool authenticates with; null = no injection.
   *  Supersedes AGENT_TOOL_CREDENTIAL_PROVIDER (§6). */
  readonly credentialProvider: AgentCredentialProvider | null;

  /** How the system prompt reaches the child. Tier axis — see §7. */
  readonly systemPromptDelivery: 'flag' | 'config-kv' | 'file' | 'none';

  /** How the task prompt reaches the child. `positional` is Tier A. */
  readonly taskPromptDelivery: 'positional' | 'stdin' | 'none';

  /** EXACT-ID resume only. `null` means: refuse loudly, never restart fresh and
   *  present it as resumed. Today's `withAgentResume` already does this. */
  readonly resume: HarnessResume | null;

  /** Can tm8 pre-mint the child's conversation id (`--session-id <uuid>`)?
   *  Claude can; Codex mints its own rollout id (manifest.ts:522-529). */
  readonly acceptsPreMintedSessionId: boolean;

  /** Confinement story. `probe` REQUIRES a runnable probe — see §9.3.
   *  It is never inferred from paths, capability bits, or a binary on PATH. */
  readonly confinement: 'none' | 'provider-sandbox' | { probe: SandboxProbeId };

  /** Transcript dialect this tool writes, if tm8 can read it. Feeds
   *  SessionTranscriptPage.unavailableReason = 'unsupported_agent_tool'. */
  readonly transcriptDialect: TranscriptDialect | null;
}

export interface Harness {
  /** The `agentTool` id. The registry key; stable, lowercase-kebab. */
  readonly id: string;
  /** Default binary. TM8_AGENT_CMD still overrides node-wide (§4). */
  readonly binary: string;
  readonly capabilities: HarnessCapabilities;

  /** Build the child's LOGICAL argv. No shell quoting, no joining — §4. */
  buildArgv(launch: ResolvedLaunchConfig, opts: BuildArgvOptions): string[];

  /** Append system/task prompts to an argv. Delivery per `capabilities`. */
  withPrompts(argv: readonly string[], prompts: Prompts, launch: ResolvedLaunchConfig): string[];

  /** Transform an argv into the exact-id resume invocation.
   *  MUST throw SpawnError when `capabilities.resume === null`. */
  withResume(argv: readonly string[], system: string, nativeSessionId: string,
             launch: ResolvedLaunchConfig): string[];
}
```

**Why capabilities are data rather than optional methods.** A missing method is
discovered by calling it. A `capabilities` record is discovered by *asking*, which is
what lets a caller refuse before spawning rather than after. `withAgentResume` already
demonstrates the pattern it makes universal (`manifest.ts:695-699`):

```ts
throw new SpawnError(`agent tool '${launch.agentTool}' has no resume-by-id contract`,
                     'invalid_input', { agentTool: launch.agentTool });
```

Its doc comment (`manifest.ts:658-659`) already names tools that do not exist yet —
*"a tool with no resume-by-id contract (echo-agent, gemini, hermes) must never be
silently restarted fresh and presented as resumed."* The registry is where `gemini`
and `hermes` stop being names in a comment.

**Error taxonomy.** `SpawnError` codes are already the contract taxonomy
(`types.ts:823-839`). The registry reuses them without addition:

| Situation | Code |
|---|---|
| Unknown harness id | `invalid_input` |
| Known harness, capability absent (no resume contract) | `invalid_input` |
| Known harness, capability suppressed by the node (operator wrapper) | `not_implemented` |
| Harness registered but adapter not written (reserved slot) | `not_implemented` |

The last row is T-L12's honest `501` applied to harnesses: a reserved id answers
"not implemented", never "no such tool."

---

## 4. Argv arrays, and one render at the end

Today `buildAgentCommand` returns a **string**, and every downstream transform is
string surgery. The most pointed example is in `withAgentResume`
(`manifest.ts:688`):

```ts
const parts = [command.replace(/^codex\b/, 'codex resume')];
```

A regex rewriting a command line to insert a subcommand. It is correct today and it
is correct only because there are two shapes to keep in one head.

The internals move to `string[]`, rendered exactly once at the boundary that needs a
shell. This is not a new idea in this codebase — **`buildCodexArgs` already does it**
(`manifest.ts:590-628`), returning logical argv, with `renderCodexCommand`
(`:631-639`) quoting only the values that are not fixed CLI vocabulary:

```ts
rendered.push(previous === '--model' || previous === '-c' ? shellQuote(arg) : arg);
```

Phase 0 generalises that existing split to every harness rather than inventing it.
`shellQuote` (`manifest.ts:464`) stays exactly as it is; what changes is that it is
called in one place instead of nine.

**What must not change in Phase 0:**

- **`TM8_AGENT_CMD` remains the node-wide operator override** and still wins over
  everything (`manifest.ts:504-506`). It is a complete operator-owned wrapper, used
  verbatim, and the registry must not guess flags into its private vocabulary — which
  is why it keeps refusing resume (`not_implemented`) and keeps returning prompts
  unchanged (`manifest.ts:738-740`).
- **The positional prompt goes last**, after every flag, *"because both CLIs stop
  parsing options at the first non-option argument"* (`manifest.ts:742-743`).
- **The rendered string for the three existing harnesses is byte-identical.** That is
  the gate, not a goal.

---

## 5. Phases

| Phase | Scope | Est |
|---|---|---|
| **0 Registry** | `packages/execution/src/harness/`; registry is the sole dispatch point; the 3 existing harnesses migrated onto it; internals move from command-strings to **argv arrays** rendered once at the end. **Zero behaviour change.** | ~800 LOC |
| **1 Contract** | Open the two `SessionTranscriptPage.agentTool` union sites to registry-validated ids; `KNOWN_AGENT_TOOLS` derives from the registry. **`LaunchModelCatalogEntry` stays closed** (§8). Catalog revision. | **~150 LOC** *(was ~400)* |
| **2 Credentials** | Delete the drifted ternaries in `agent-config-dirs.ts`; point `knownAgentConfigDirs` at the existing table; widen `AgentCredentialProvider` past two vendors; drive both from `capabilities.credentialProvider`. | **~200 LOC** *(was ~300)* |
| **3 Activity** | **Out of scope.** → `ACTIVITY-SIGNAL-DESIGN.md`. | — |
| **4 Harnesses** | One tier-A/B/C adapter each. Tiering per §7. **Gated on §8.** | ~500 each |

Phases 1 and 2 are re-estimated down from the commissioning brief; §2 says why.

### Phase 0 — the registry, and the gate that proves it

The whole of Phase 0 is a refactor whose success condition is that **nothing
observable changes.** The gate is the existing suite: `packages/execution/test/` has
34 test files, and the load-bearing ones here are `spawn-manifest.test.ts`,
`session-resume.test.ts`, `spawn-sandbox-preflight.test.ts`,
`spawn-secret-boundary.test.ts`, and `prompt-fidelity.test.ts`.

Two of those are specifically valuable as a gate because they encode *measured
production defects* rather than intended behaviour:

- `spawn-sandbox-preflight.test.ts:3` — *"THE DEFECT, as reproduced on the live prod
  node 2026-08-02"*.
- `spawn-secret-boundary.test.ts` — asserts on `buildAgentCommand(launch, {})` output
  directly, so it will catch any drift in the rendered string.

**Phase 0 adds no new assertions to those files.** If the refactor is correct they
pass unmodified; if any of them needs editing to pass, the refactor changed behaviour
and is wrong. That is the whole gate, and it is stronger than a new test would be.

One new test file is in scope — `harness-registry.test.ts` — asserting registry
invariants that no existing test can express: every registered id resolves; an
unregistered id throws `invalid_input`; a `resume: null` harness throws rather than
restarting; `capabilities.confinement === {probe}` has a registered probe.

### Phases 1 and 2

Sequenced after 0 because both consume `capabilities`. Phase 1 touches
`packages/contract`, which is the only cross-package dependency (§9.2) — so it lands
alone, with its own catalog revision, and never rides along with an adapter.

---

## 6. Credentials — the first cost multiplier

> **AO runs on your laptop, as you, using your `~/.claude`. tm8 is a shared server.**

This is the single largest reason "26 harnesses" does not mean "26 adapters."

`agent-config-dirs.ts` isolates per-member credential directories: given a
`dataDir`, it enumerates `credentials/id_*` and returns
`join(dataDir, 'credentials', id_x, provider)` for each identity. That is the
mechanism by which two members' agent sessions on one node do not read each other's
logins.

Making that work for one provider took, and is documented as having taken, real
measurement:

- **The redirect variable is verified, not assumed.** `agent-credentials.ts:56-58` —
  *"`CLAUDE_CONFIG_DIR` REPLACES Claude's default config location and alone decides
  it — verified in both directions, including a positive control, so it may be relied
  on rather than belt-and-braced with a second mechanism."*
- **The node's own key must be actively removed**, not merely shadowed
  (`agent-credentials.ts:65-70`, finding C8 / architect ruling 13) — measured with
  `claude auth status`, synthetic credentials, and the real CLI.
- **Workspace trust must be written into the same config home the child will use**,
  before the child exists, *"since the dialog blocks on first directory access, and
  this launch is unattended — nobody is watching the PTY to answer it"*
  (`SpawnService.ts:1015-1025`). Writing it into the node account instead leaves the
  child untrusted and *"reintroduc[es] shared mutable provider state."*
- **Disconnection must reach live sessions.** `credential-catalog.ts:104-108` maps
  providers to the tools that hold them, and treats `github` as `null` meaning *every*
  tool — *"narrowing it would leave live sessions holding a token the member believes
  they just disconnected."*

**So a new harness is not one adapter. It is a credential-isolation story × N
members**, and it needs four things answered by measurement:

1. **Injection** — which env var redirects this CLI's config home, verified in both
   directions with a positive control? If none exists, per-member isolation is not
   possible and the harness must say so rather than silently share.
2. **Removal** — what node-level credential must be stripped from the child's
   environment so a machine-wide helper cannot answer with somebody else's login?
3. **Redaction** — what secrets appear in this CLI's output, for `secret-redaction.ts`?
4. **Trust gate** — does this CLI have a first-run trust dialog, and can it be
   pre-answered in the member's own config home?

**Design position: an unanswerable question is a refusal, not a default.** A harness
whose `credentialProvider` is non-null and whose injection variable is unverified
**must not register**. The failure it prevents is the worst kind available here — one
member's agent authenticating as another — and it is silent. This mirrors §9.3's
sandbox rule: the honest answer is a refusal, and tm8 already prefers loud refusals to
quiet degradation (T-L12's `501`, `withAgentResume`, `observer.ts:128-132`).

A harness with `credentialProvider: null` — `echo-agent`, an operator wrapper — is
exempt, because it authenticates with nothing. `AGENT_TOOL_CREDENTIAL_PROVIDER`
already models that correctly (`agent-credentials.ts:44-47`).

---

## 7. Tiering by capability, not by logo

The tier is a **property of the CLI's contract**, derived from `capabilities`. It is
not a ranking of vendors, and it is not a statement about model quality.

### Tier A — near drop-in

`systemPromptDelivery: 'flag'` · `taskPromptDelivery: 'positional'` ·
`resume: { byExactId: true }`

A positional prompt, a system-prompt flag, and exact-id resume. `claude-code` is the
reference implementation. A tier-A harness is a descriptor plus a small `buildArgv`;
most of it is flag-name mapping.

**Cost:** ~150 LOC of adapter, and the §6 credential work.

### Tier B — resume-capable, bespoke prompt delivery

`systemPromptDelivery: 'config-kv' | 'file'` · `resume: {…}`

`codex` is already here and is the proof the tier is real, in three details tm8 had to
discover:

- The system prompt travels as `-c developer_instructions=<json>`, because
  *"`instructions` is reserved by Codex and silently ignored"* (`manifest.ts:735-736`).
  A silently-ignored key is the worst possible failure: the flag is accepted, the
  session starts, and the agent has no identity.
- `resume` is a **subcommand before the flags**, with the rollout id **positional
  after them** (`manifest.ts:686-687`).
- Codex mints its own rollout id, so `acceptsPreMintedSessionId: false` — which is why
  `SpawnService.ts:1436` has a distinct nativeSessionId-discovery path for it.

**Cost:** ~500 LOC. The expense is not the argv; it is finding the three details, and
each is only findable by running the thing.

### Tier C — no resume contract; refuse loudly

`resume: null`

The tool cannot be resumed by exact id. The harness registers, spawns, and **refuses
resume with a typed error** — never restarts fresh and presents the result as resumed.
`withAgentResume` already implements exactly this (`manifest.ts:695-699`), and
`SpawnService.ts:1368-1374` refuses at the service layer too, so the behaviour has a
home before the registry exists.

**`--continue` and `--last` are permanently out of bounds.** `manifest.ts:653-654`:
*"Exact-id only: no `--continue`, no `--last` — both mean 'most recent', which resumes
the WRONG conversation the moment two sessions share a cwd."* On a shared server two
sessions sharing a cwd is the normal case, not the edge case. A tier-C harness that
"supports resume" via `--continue` is a data-crossing bug wearing a feature's clothes.

**Cost:** ~500 LOC, and the refusal surfaces need to be honest end to end — a UI that
offers a resume button for a tier-C session is the same lie one layer up.

---

## 8. The open product question — deliberately not answered here

`LAUNCH_MODEL_CATALOG` is **curated on purpose**. Its header
(`packages/contract/src/launch-models.ts:3-6`):

> *"Models the node deliberately offers for a new session. These are concrete
> provider/tool identifiers, not marketing aliases."*

Nine entries, six `claude-code` and three `codex` (`claude-opus-5`,
`claude-opus-5[1m]`, `claude-fable-5`, `claude-fable-5[1m]`, `claude-sonnet-5`,
`claude-haiku-4-5-20251001`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), each
with a `seedName` that becomes a bootstrapped teammate
(`server/src/bootstrap/default-teammates.ts`).

**Shipping 26 harnesses may be a genuine product reversal.** A curated list says "we
chose these and we stand behind them." A registry of 26 says "here is everything;
pick." Those are different products with different support surfaces, and the second
one cannot be reached by accident.

**So this document deliberately separates the two decisions:**

- **Phases 0–2 make 26 *possible*.** They remove the architectural obstacle — the
  string dispatch — and commit to nothing. If the answer turns out to be "four
  harnesses, forever," Phases 0–2 were still correct, because they fix a law violation
  that exists at two harnesses.
- **Phase 4 is where a human decides the list.** Each entry is a support commitment,
  a credential-isolation story (§6), and a sandbox probe (§9.3).

**That decision is Tarkesh's, not this document's.** What this document asserts is
narrower and, I think, uncontroversial: *the two-agent limit should not be enforced by
an `if` statement.* Whether the limit itself should move is a separate question, and
answering it is not a precondition for Phases 0–2.

**Implication for Phase 1, and it is why the estimate dropped.**
`LaunchModelCatalogEntry.agentTool` **stays** `'claude-code' | 'codex'` — the catalog
is *supposed* to be closed, and opening it would erase the curation §8 is about.
Phase 1 opens the *transcript-dialect* union (a fact about what was parsed) and leaves
the *catalog* union (a product commitment) alone. Conflating those two would have made
Phase 1 both larger and wrong.

---

## 9. The three cost multipliers tm8 has and AO does not

### 9.1 Credentials

§6. AO is one user on one laptop with one `~/.claude`; tm8 is N members on a shared
host, and per-member isolation has to be measured per provider rather than assumed.

### 9.2 The contract is THE LAW

`packages/contract` is the only cross-package dependency. Widening anything in it
touches `server`, `execution`, `cli`, `mcp`, `tm8-ui`, and `ui` simultaneously, and it
is governed by T-L12 — one catalog, three projections, never parallel APIs.

The mitigating fact from §2.1 is that the wire is *already* open, so Phase 1 is two
response fields and a derived UI constant rather than a sweep. But the discipline
still applies: **Phase 1 lands alone**, with its own catalog revision, and no adapter
rides along with it.

### 9.3 Sandbox honesty

`sandbox-probe.ts` exists because inference was tried and was wrong. Its header is the
argument in full:

> *"Measured on the prod node 2026-08-02: the flag went out, codex started fine, the
> session reached 'Ready when you are.', accepted a message, and then failed EVERY
> shell command with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`,
> while tm8 continued to report the session as `running`."*

And the reason the obvious check is the wrong check (`sandbox-probe.ts:18-32`): codex
**ships its own bwrap**, so "is bwrap installed?" answers yes while the sandbox
cannot work. The real blocker was AppArmor —
`/proc/sys/kernel/apparmor_restrict_unprivileged_userns` set to 1 — and the two
sandbox shapes failed differently and at different depths:

```
bwrap --unshare-all --share-net   -> setting up uid map: Permission denied
bwrap --unshare-all               -> loopback: Failed RTM_NEWADDR
```

> *"No amount of inspecting paths, capability masks or `systemd-detect-virt` predicts
> that pair. Only running it does."*

So `capabilities.confinement: { probe }` **requires a runnable probe** — the
provider's own sandbox entry point, exercising the identical machinery with the
identical bundled helper, because that is *"the provider's answer to the provider's
question, which is the only kind that stays true across codex releases."*

**And the honest-command-line rule follows from it.** When the probe says the node
cannot confine, the harness must not emit the flag. `buildCodexArgs` collapses to
`--dangerously-bypass-approvals-and-sandbox` rather than keeping `--ask-for-approval`
and dropping only `--sandbox`, because approvals with no sandbox *"is a policy that
stops to ask with nobody at the terminal to answer… and it would buy no confinement in
exchange for it"* (`manifest.ts:601-607`). Whether an unconfined launch may proceed at
all is a **security** decision, answered in `SpawnService`, which refuses by default
(`manifest.ts:541-546`); the harness's only job is to emit a command line that tells
the truth about what it got.

**Every new harness needs its confinement story probed, not inferred** — including
`confinement: 'none'`, which is a legitimate and honest answer and must be surfaced as
one.

---

## 10. What this design does not do

- **No activity signals.** → `ACTIVITY-SIGNAL-DESIGN.md`.
- **No model discovery.** `launch-models.ts` stays nine hardcoded entries. An
  `authprobe`/`modelcatalog` equivalent is a separate design and §8's product question
  is upstream of it.
- **No new harnesses in Phases 0–2.** Zero behaviour change is the Phase 0 gate.
- **No answer to "which 26."** §8.
- **No change to `TM8_AGENT_CMD` semantics.** It remains the node-wide operator
  override, used verbatim, refusing resume and prompt-injection because tm8 cannot
  know its private flag vocabulary.
- **No migration of `LaunchModelCatalogEntry.agentTool`.** §8.

---

## 11. Review checklist

Agreement is needed on these before Phase 0 starts:

1. **The T-L4 argument as stated in §1** — an extension of the law's principle, not a
   literal reading. Is the extension accepted?
2. **§2's two corrections** — do reviewers agree the wire is already open (§2.1) and
   the provider table already exists (§2.2)? Both re-estimates depend on it.
3. **§3's `HarnessCapabilities` shape** — capabilities as data rather than optional
   methods.
4. **§5's Phase 0 gate** — that *editing an existing spawn/manifest test to make it
   pass* is defined as failure.
5. **§6's refusal position** — a harness with an unverified credential-injection
   variable must not register.
6. **§8** — that Phases 0–2 proceed without the 26-harness product decision, and that
   `LaunchModelCatalogEntry` stays closed.
