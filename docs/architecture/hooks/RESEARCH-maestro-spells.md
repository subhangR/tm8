# RESEARCH — agent-maestro Spells, for the tm8 hook foundation

**Material:** `/Users/subhang/Desktop/Projects/maestro/agent-maestro`, git origin `github.com/subhangR/agent-maestro`, HEAD `1a7a0a5` ("Merge pull request #187 from subhangR/fix/pty-prompt-injection"). Top-level tree only; `.claude/worktrees/`, `dist/`, and `node_modules/` excluded throughout.

**Reader:** the sibling session designing tm8's hook foundation.

**Method:** every claim below cites `path:line` in a file I opened. Where a claim came from a delegated search rather than my own read, it is marked **[2nd-hand]**. Section 12 lists what I could not verify.

---

## 0. The headline, first

The task framing was "a Spell is human-invoked automation while a hook is agent-emitted signal." **That framing is half wrong, and the half that is wrong is the half you need.**

agent-maestro ships **two distinct mechanisms both called "Spell"**, in the same service, sharing a name and almost nothing else:

| | **Mechanism A — "invoke"** | **Mechanism B — "Spell entity"** |
|---|---|---|
| What it is | One-shot templated prompt cast at a session | Persistent `{trigger → action}` rule set bound to a session |
| Trigger | Human/agent calls `POST /api/spells/invoke` | A **Claude hook event** fires |
| Data object | `SpellDefinition` (hardcoded, in-code) | `Spell` (persisted JSON, user-editable) |
| Templating | Yes — `{{field}}` interpolation | **None.** Static strings |
| Human-invoked? | Yes | **No — event-driven** |

Mechanism B **is already a hook system.** It is bound to all 8 Claude hook events, dispatched over HTTP, composed, and folded back into hook exit codes. It is the most directly relevant prior art you have, and it is real — not aspirational. The rest of this report is mostly about Mechanism B, with Mechanism A covered where it differs.

**Second headline:** the interesting engineering in Mechanism B is not the trigger side. Matching is trivial (event equality + one regex). The hard-won parts are **composition** (N rules across M spells folding into ONE process exit code), **fail-open discipline at every layer**, and **the authority boundary on what an action may do**. That is where you should mine it.

---

## 1. What a Spell is as a data object

### 1.1 Mechanism B — the `Spell` entity

Defined at `maestro-server/src/types.ts:725-737`:

```ts
export interface Spell {
  id: string;
  name: string;
  description: string;   // human summary ONLY — explicitly not the injected body
  icon?: string;
  color: SpellColorSlug;
  rules: SpellRule[];
  isDefault?: boolean;   // curated seed → non-deletable
  createdAt: number;
  updatedAt: number;
}
```

The comment at `types.ts:728` is worth quoting because it records a design reversal: `description` is *"Human summary only — NO longer the injected body (that lives on each rule's action)."* An earlier version conflated the spell's identity with its payload; they split them.

A `SpellRule` (`types.ts:694-700`) is the actual unit of behavior:

```ts
export interface SpellRule {
  id: string;          // stable, generated as idGenerator('rule')
  label?: string;      // human handle; drives summary + reset UX
  enabled: boolean;
  trigger: SpellTrigger;
  action: SpellActionConfig;
}
```

A spell holds **1..20 rules** (`validation.ts:690`). Both `trigger` and `action` are **discriminated unions on `type`** — `types.ts:673-675` and `types.ts:683-688`. The comment at `types.ts:678-681` states the reason explicitly: so the dispatcher switch and the editor config panel *"narrow exhaustively — no `(spell as any)` field access."* The dispatcher's exhaustiveness guard at `HookDispatcherService.ts:233-243` uses `const _never: never = action` to make an unhandled action a compile error.

**Take this.** A discriminated union on `type` for both trigger and action, with a `never` exhaustiveness guard at the dispatch switch, is cheap and it is the single thing that keeps a dispatcher honest as the action taxonomy grows.

### 1.2 Identity and versioning

- **Identity:** `id`, generated `idGenerator.generate('spell')` (`SpellService.ts:889`); rules get `idGenerator.generate('rule')` (`SpellService.ts:882`).
- **Versioning: there is none.** No version field, no revision history, no optimistic concurrency. `update()` at `FileSystemSpellRepository.ts:450-472` is a last-write-wins merge over the existing object. `createdAt` and `id` are pinned (`:459-460`), `updatedAt` is stamped (`:461`), and `isDefault` is force-preserved (`:463`) so *"user copies cannot promote themselves."*
- **Rule identity survives edits**, and this matters: `SpellService.ts:920` `reconcileRuleIterations` and `activateSpell`'s `validRuleIds` filter at `SpellService.ts:1041,1054-1057` drop loop counters for rule ids that no longer exist while preserving counters for ids that do. Editing a spell that is live on a session does not reset unrelated loop state. That is a real correctness detail you will hit.

### 1.3 Mechanism A — `SpellDefinition`

`types.ts:790-797`. Fields: `name`, `entityType`, `label`, `description`, `icon?`, `promptTemplate`. These are **hardcoded in the service source**, not persisted — see the table starting `SpellService.ts:43` (`promptTemplate: '{{content}}'`) through `SpellService.ts:153`. Users cannot author these. The only user-authored Mechanism-A object is a `CustomPrompt` (`SpellService.ts:1200-1233`).

---

## 2. Storage

`data/spells/<id>.json`, flat, one file per spell — `FileSystemSpellRepository.ts:331` (`this.spellsDir = path.join(dataDir, 'spells')`), written at `:442-443` and `:466-467`.

- **Format:** raw `JSON.stringify(spell)`, no envelope, no schema version field.
- **Atomicity:** via `atomicWriteFile` (`:8`, `:443`, `:467`).
- **Cache:** full in-memory `Map`, loaded once (`:370-393`), never invalidated by external file change. Edit a spell JSON by hand while the server runs and the server will not see it.
- **Corrupt file handling:** a `JSON.parse` failure on one file logs a warning and **skips that file** (`:382-386`) — one bad spell does not take down the loader.
- **Schema drift handling without a migration file:** `normalizeSpell` at `:355-368` strips the dropped `channel` field from persisted `notify-channel` actions on *every disk read*, idempotently. The comment at `:350-353` is explicit that this exists *"so legacy spell files parse clean against the v2 schema without a migration file."* That is a pragmatic pattern — a read-time normalizer instead of a migration — and it is worth stealing for an early-stage system where you will change the action schema more than once.

### 2.1 Seeds are code, not data

`SPELL_LIBRARY` at `FileSystemSpellRepository.ts:40-316` is a hardcoded array of 13 curated spells compiled into the binary. They are merged with disk contents at read time (`mergeWithLibrary`, `:400-411`), and they have **no disk file at all** unless a user overrides one.

The safety invariants on seeds, declared at `:16-23` and enforced by `test/spell-library-seeds.test.ts`, are the most transferable single idea in this file:

> - every seed's rules[] pass the real Zod `createSpellSchema`;
> - **every `run-command` rule ships `enabled: false`** (a fresh install never fires a command that may not exist);
> - run-command defaults are self-describing (a harmless `echo` placeholder...) — never a hardcoded project script;
> - every rule's action is legal for its hook event per `ACTIONS_BY_EVENT`.

Concretely: `spell_type_safety` ships `enabled: false` (`:243`), and `runCommandPlaceholder` (`:33-38`) emits `echo "[maestro spell] <instruction telling you what to replace this with>"`. **A shipped default that can execute must ship inert.** Take that verbatim.

---

## 3. Scopes and resolution — the weakest part of the design

**Answer: there is essentially one scope. Spell *definitions* are global to the server; spell *bindings* are per-session. There is no project, agent, user, or session scope on the definition.**

Evidence:
- `ISpellRepository` (`ISpellRepository.ts:3-10`) has `findAll()`, `findById(id)` — **no scope parameter anywhere on the interface.**
- Storage is a single flat directory (`FileSystemSpellRepository.ts:331`). No project subdirectory.
- `GET /api/spells` (`spellRoutes.ts:128-139`) takes no query parameters at all — it calls `spellService.listSpells()`, which is a bare `this.spellRepo.findAll()` (`SpellService.ts:868-870`).

The only "precedence" rule that exists is **seed override by id**, `FileSystemSpellRepository.ts:400-411`:

```ts
for (const spell of this.cache.values()) { merged.push(spell); seenIds.add(spell.id); }
for (const seed of SPELL_LIBRARY) { if (!seenIds.has(seed.id)) merged.push(seed); }
```

Disk wins over seed on id collision. The comment at `:397-399` says this exists to allow *"overriding a seed's color/trigger without forking the code."* That is the entire scope-resolution story: **one axis, two layers, disk-over-code.**

Binding is where per-session-ness lives: `Session.activeSpells: ActiveSpell[]` (`types.ts:540`). `ActiveSpell` (`types.ts:745-761`) is the per-session activation record — `spellId`, denormalized `color`, `enabled`, `ruleIterations`, `ruleEnabled?`, `ensembleId?`, `castAt`, `castBy`.

Two design notes on `ActiveSpell` that are load-bearing:

1. **Deliberate non-denormalization of behavior.** `types.ts:741-743`: *"The dispatcher re-reads the spell's rules at fire time, so no trigger fields are denormalized here — only per-rule loop counters."* Editing a spell changes behavior on every session it is live on, immediately. This is a real choice with real consequences (no pinning, no per-session snapshot) and you should make it consciously rather than by accident.
2. **A second, per-session enablement axis.** `ruleEnabled?: Record<string, boolean>` (`types.ts:756`) — a runtime override that disables a rule on *one* session even though the definition says enabled. The dispatcher honors it at `HookDispatcherService.ts:171`. So a rule fires only if `rule.enabled && active.ruleEnabled[rule.id] !== false && active.enabled`.

**Verdict for tm8:** do not copy this. A flat global namespace with a single disk-over-code override is the shape you get when scope was not designed. If tm8 hooks need to live at space / project / session / agent scope, that must be in the repository interface from day one — retrofitting a scope parameter through `findAll()`/`findById()` and every call site is exactly the migration agent-maestro has not done.

---

## 4. What triggers a Spell — traced end to end

### 4.1 The trigger taxonomy

`SpellTrigger` (`types.ts:673-675`):
```ts
| { type: 'hook'; hookEvent: SpellHookEvent; matcher?: string }
| { type: 'schedule'; cron?: string; intervalMs?: number }
```

**`schedule` is schema-ready and hard-rejected at save.** `validation.ts:666-674` — `spellRuleSchema.superRefine` adds a fatal issue `'Scheduled triggers are not available yet'` for any schedule trigger, and returns before further checks. The dispatcher also refuses it defensively at `HookDispatcherService.ts:172` (`if (rule.trigger.type !== 'hook') return false; // schedule rules never fire in v1`). So: **the type exists, the UI can model it, and no schedule rule can ever be persisted or fired.** Two independent refusals. This is the honest way to ship a placeholder — the shape is reserved, the behavior is refused at both the boundary and the engine, and no dead config accrues (`validation.ts:657-659`).

The 8 hook events (`types.ts:659-667`): `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SubagentStop`, `Notification`, `SessionStart`, `SessionEnd`.

### 4.2 The full invocation path

I verified the binding count directly: **both** `maestro-cli/plugins/maestro-orchestrator/hooks/hooks.json` and `maestro-cli/plugins/maestro-worker/hooks/hooks.json` contain exactly **8** `hook dispatch` bindings each. All 8 events are really bound. This is not aspirational.

The chain:

1. **Claude fires a hook.** Bound in `hooks.json` per plugin to `${CLAUDE_PLUGIN_ROOT}/bin/maestro-cli hook dispatch <EVENT>`, matcher `*`, `timeout: 5` seconds. **[2nd-hand for the exact JSON body; the 8-binding count is my own verification.]** Note several events chain *two* commands — e.g. `Stop` runs `session needs-input` then `hook dispatch Stop`.

2. **CLI drains stdin and POSTs.** `maestro-cli/src/commands/hook.ts:227` reads stdin first (`readStdin`, `:54-68`) — the comment at `:226` says *"Drain stdin first so we don't leave the pipe dangling on bail."* Stdin is parsed as JSON into `payload`; a non-object becomes `{raw: parsed}`, unparseable becomes `{raw: stdinRaw}` (`:188-200`). Then `postDispatch` (`:76-116`) POSTs `{sessionId, event, payload}` to `/api/hooks/dispatch` with header `X-Session-Id`, under a **4-second `AbortController` timeout** (`:52`, `:86-87`).

3. **Server authorizes.** `hookRoutes.ts:16-46`. Zod-validated (`hookDispatchSchema`, `validation.ts:728-737`), then a **self-only guard** at `:27-35`: the `X-Session-Id` header must equal `body.sessionId`, else `403 hook_self_only`. The comment at `:23-26` states the threat: *"Require them to match so one session can't drive another session's continue-loop/inject/notify side effects."* **Dry-run bypasses this guard** (`:21`) on the stated grounds that it is side-effect-free.

4. **Dispatcher matches.** `HookDispatcherService.dispatch` (`:84-160`):
   - load session, 404 if absent (`:89-90`)
   - `session.activeSpells.filter(a => a.enabled)`; empty → `emptyResult` (`:92-93`)
   - resolve each `spellId` → `Spell`; unresolvable ones are **logged and dropped, not fatal** (`:99-114`)
   - for each `(active, spell)`, filter `spell.rules` by `ruleMatches` (`:124`)

5. **Matching** (`ruleMatches`, `:169-177`): `rule.enabled` → `active.ruleEnabled[rule.id] !== false` → `trigger.type === 'hook'` → `trigger.hookEvent === event` → matcher. **Event matching is exact string equality.** No globbing, no hierarchy, no wildcards on the event itself.

6. **Actions execute** (`executeRuleAction`, `:213-245`), each wrapped in try/catch (`:134-150`).

7. **Composition** (`composeResult`, `:638-668`) — see §6.

8. **CLI folds the result into a process exit** (`foldResult`, `hook.ts:123-137`): `exitCode` 0 or 2; `stdout` written first, then `stderr`; reason newline-terminated. Order matters and is commented at `hook.ts:237-238`: *"Print stdout first so feed-context / inject-prompt is delivered to Claude even when the dispatcher also signals a continue-loop."*

### 4.3 The matcher

`matcherTarget` (`:179-194`) picks what the regex runs against, and it is **event-dependent**:
- `PreToolUse`/`PostToolUse` → `payload.tool_name ?? payload.toolName` — **the tool NAME, not the file path.**
- everything else → first of `matcherTarget`, `path`, `file_path`, `filePath`, `message`, else `JSON.stringify(payload)`.

The tool-name detail is called out as a gotcha in the repository at `FileSystemSpellRepository.ts:25-27`: *"for Pre/PostToolUse the dispatcher matches against the TOOL NAME (payload.tool_name), not the file path — so `Edit|Write` fires on the Edit/Write tools; you cannot narrow by file extension here."* This is a genuine expressiveness limit they documented rather than fixed.

`matcherMatches` (`:196-209`) has two hardening steps: target truncated to 4096 chars (`:55`, `:201-203`) and **`new RegExp` failure falls back to substring `includes`** (`:206-207`). That fallback is a quiet semantic trap — an invalid regex silently becomes a literal search rather than erroring.

### 4.4 Auto-activation — the one non-human bind path

`maestro-cli/src/services/spell-auto-activator.ts` (36 lines) reads `manifest.spells` and POSTs `/api/spells/:id/activate` with `{targetSessionIds:[sessionId]}` for each, via `Promise.allSettled`, fail-open per spell. **[2nd-hand]** So a spawned session can come up with spells pre-bound from its manifest — binding is not exclusively a human UI act.

---

## 5. What a Spell may DO — the authority boundary

Five actions, frozen (`SpellActionType`, `types.ts:628-633`). `gate` was **removed** — `types.ts:624-625`: *"`gate` is dropped; the dispatcher no longer blocks tool calls."*

| Action | Authority | Bounded where |
|---|---|---|
| `inject-prompt` | Emits `session:prompt_send` → written into the target session's PTY | `HookDispatcherService.ts:247-270` |
| `feed-context` | Returns a string as hook stdout. **Pure** — no side effect | `:272-283` |
| `continue-loop` | Forces exit code 2 on Stop/SubagentStop, making the agent continue | `:285-319` |
| `run-command` | **Spawns a real OS process** | `:321-419` |
| `notify-channel` | Emits `notify:progress` → in-app toast. Nothing external | `:488-510` |

### 5.1 The per-event capability matrix

`ACTIONS_BY_EVENT` (`types.ts:709-718`) is a hard matrix of which actions are legal for which event, and `types.ts:703-705` calls it *"single source of truth shared by the Zod schema and the editor action dropdown."*

It is enforced in **two** places: the Zod `superRefine` at `validation.ts:675-682` rejects an illegal pairing at save, and the UI dropdown will not offer it. Key entries: `continue-loop` is legal **only** on `Stop` and `SubagentStop` (`:713-714`); `SessionEnd` permits **only** `run-command` and `notify-channel` (`:717`) because, per `:706-707`, *"SessionEnd is terminal (no further turn to inject/feed/loop into)."*

**Take this.** One exported constant that is simultaneously the validation rule and the UI's option list is how you keep a capability matrix from drifting into three inconsistent copies.

### 5.2 `run-command` — the real authority boundary

This is the most carefully fenced code in the system. Five gates, in order, at `evaluateRunCommandGate` (`:426-459`) and `execRunCommand` (`:321-419`):

1. **`readOnly` permission mode** on the session's team-member snapshot → blocked (`:431-433`).
2. **Explicit per-team-member opt-out** — `commandPermissions.commands['spell-run-command'] === false` or `groups['spell'] === false` (`:438-443`).
3. **Always-on binary denylist** on `argv[0]` basename (`:448-450`), the set being `sh, bash, zsh, dash, fish, ksh, csh, env, sudo` (`:65-67`). The stated reason (`:60-64`): these *"turn the no-shell execFile into an arbitrary-command vector."*
4. **Optional allowlist** — when `MAESTRO_SPELL_CMD_ALLOWLIST` is non-empty, only listed binaries run (`:453-456`).
5. **Concurrency ceiling** — 3 in-flight per session, 16 global (`:56-59`, `:345-362`); over cap returns `status: 'skipped'`, it does not queue.

Plus: `execFile` **not** `exec` — no shell, args passed as an array (`:376-383`); 30s timeout (`:51`); 256KB max stdout (`:53`); children tracked in a `Set` and SIGTERM'd on server shutdown (`:73`, `shutdown()` `:686-693`).

The gate-authority comment at `:421-424` is the single most important line for your design:

> *"decide whether a run-command may execute for the **EXECUTING session's team member**. Auto-activated/shared spells get no special trust — the gate keys off the running session, not the spell author."*

**Take this, emphatically.** Authority is evaluated against the identity of the *context the hook fires in*, never against whoever authored the rule. In a system where automation objects can be shared, seeded, or auto-activated from a manifest, keying authority off the author is a privilege-escalation bug waiting to happen.

### 5.3 Where the boundary leaks

- **`inject-prompt` is unbounded in content.** Any string up to 10,000 chars (`validation.ts:630`) goes straight into another agent's input. There is no allowlist, no review, no attribution marker on the injected text (`HookDispatcherService.ts:253-261` sends `senderSessionId: null`). The *only* gate on inject-prompt is the act of binding the spell to the session.
- **The `run-command` acknowledgement is browser-side only.** `maestro-ui/.../editor/ActionPanels.tsx:103-110` renders a checkbox reading *"⚠ This rule runs shell commands on your machine. I understand and want to allow it."*, and `editor/editorState.ts:343` blocks save with *"Acknowledge the shell-command warning to save."* — but `runCommandAck` is a **client-side editor-state field only** (`editorState.ts:137`), and it does not exist in `createSpellSchema` (`validation.ts:685-691`), which is `.strict()` and would in fact *reject* it if sent. So the CLI and any direct API caller bypass the acknowledgement entirely. The real server-side defense is §5.2, not the checkbox. Also note `editorState.ts:215`: `base.runCommandAck = true; // already-saved run-command is trusted` — re-editing an existing run-command rule pre-acknowledges it. (Verified directly.)

---

## 6. Composition — the part you will actually need

N rules across M spells fire on one event and must fold into **one process exit code and one stdout stream**. `composeResult` (`HookDispatcherService.ts:638-668`):

- **stdout:** all non-empty `outcome.stdout` joined with `'\n\n'`, in `(activeSpell × rule)` iteration order (`:641`). Order is the session's `activeSpells` array order, then the spell's `rules` array order — i.e. **cast order, not priority.** There is no priority field anywhere.
- **continue-loop:** *"any continue wins"* (`types.ts:845`), and **only on Stop/SubagentStop** (`:640,643`). Reasons from all continuing rules are joined with `'\n\n'` (`:644-646`).
- **A continue-loop on a non-Stop event is silently downgraded** to a stdout hint (`:658-659`) — it does not block, it does not error.
- **There is no block path.** `blocked` is hardcoded `false` (`:651`, `:663`) and retained only for CLI wire compatibility (`types.ts:903`).

Exit code is therefore binary: **2 iff (some rule continues AND event is Stop/SubagentStop), else 0.**

Loop bounding (`execContinueLoop`, `:285-319`): per-rule counter in `active.ruleIterations[rule.id]`, cap `maxIterations` (default 1, max 100 per `validation.ts:646`). Over cap → `continue: false` with a "reached max iterations" reason, so Stop succeeds normally. Counters are staged in a Map during the loop and persisted in **one** `sessionRepo.update` after all rules run (`:120-121`, `:158`, `persistIterationUpdates` `:620-631`) — not per-rule. That is deliberate and it matters for write amplification on a hot path.

**Take this.** Write down your composition rules before you write the dispatcher: what wins, in what order, and what happens when two rules disagree. agent-maestro got to a defensible answer ("any continue wins", "no block path at all") by *deleting* a capability (`gate`) rather than by solving the harder composition problem. That is a legitimate move and probably the right one for v1.

---

## 7. Arguments, context, templating, injection

### 7.1 Mechanism B has no templating at all

`inject-prompt` and `feed-context` carry a **static `prompt: string`**. `execInjectPrompt` (`:247-270`) and `execFeedContext` (`:272-283`) pass `action.prompt` through **verbatim** — no substitution, no access to the hook payload, no session context. A rule cannot say "the file that was just edited was `{{file_path}}`."

The hook payload reaches exactly three places: the matcher target (`:176`), `run-command`'s `cwd` fallback (`:365`), and `notify-channel`'s default message which interpolates only the event name (`:495`). **The payload never reaches an injected prompt.**

This is a significant expressiveness gap and it is the most likely thing tm8 will need that Spells do not have. It is also, I suspect, exactly why the injection surface is as small as it is.

### 7.2 Mechanism A does template, and here is the hazard

`interpolateTemplate` (`SpellService.ts:773-780`):

```ts
return template.replace(/\{\{(\w+)(?:\s*\|\|\s*(\w+))?\}\}/g, (_, key, fallback) => {
  const value = data[key];
  if (value !== undefined && value !== null && value !== '') return String(value);
  if (fallback) return data[fallback] !== undefined ? String(data[fallback]) : '';
  return '';
});
```

Properties: `\w+` keys only (no path traversal, no `__proto__` reach via dots), single `||` fallback, missing → empty string. **The template is trusted** (hardcoded at `SpellService.ts:43-153`); **the data is not** (entity fields from `resolveEntity`, `:651`).

**The injection hazard is real but it is prompt-injection, not code-injection.** There is **no escaping whatsoever** — `String(value)` and done. So a task whose `description` field contains adversarial instructions gets interpolated into `'Execute the following task:\n\n...{{initialPrompt || description}}'` (`SpellService.ts:69`) and delivered verbatim into another agent's PTY. Substitution is single-pass (`String.replace` does not re-scan its own output), so `{{a}}` resolving to `{{b}}` will **not** recurse — that one class is closed. But there is no delimiter, no fencing, no "the following is untrusted data" marker around interpolated content.

For tm8 this is directly relevant: your own system prompt already wraps untrusted content in `<untrusted_data>` envelopes. agent-maestro does not. If a tm8 hook ever interpolates graph content into a prompt, **fence it at the interpolation site**, not by convention.

### 7.3 The CLI `--args` path is inert

`SpellInvocationPayload.args?: Record<string, any>` (`types.ts:821-822`, "Forward-compat per-spell args from CLI --args") is accepted by the schema as a loose passthrough (`validation.ts:521`) — and `invoke` (`SpellService.ts:784-847`) **never reads it**. Only `entityData` from `resolveEntity` feeds interpolation (`:802`). **`--args` is accepted and discarded.** Unwired.

---

## 8. Failure, timeout, and firing at a session that cannot receive

The system is **fail-open at every single layer**. Enumerated:

| Layer | Failure | Behavior | Cite |
|---|---|---|---|
| CLI | unknown event | exit 0, no request | `hook.ts:173-176` |
| CLI | no `MAESTRO_SESSION_ID` | exit 0 | `hook.ts:179-182` |
| CLI | no `MAESTRO_SERVER_URL` | exit 0 | `hook.ts:183-186` |
| CLI | server non-2xx | `null` → exit 0 | `hook.ts:106-109`, `:204-207` |
| CLI | timeout (4s) / network error | `null` → exit 0 | `hook.ts:111-115`, `:204-207` |
| CLI | unparseable stdin | wrapped as `{raw}`, continues | `hook.ts:197-199` |
| Server | session not found | **throws** `NotFoundError` → 404 → CLI exit 0 | `HookDispatcherService.ts:90` |
| Server | `activeSpells` empty | `emptyResult`, exit 0 | `:92-93` |
| Server | spell id unresolvable | warn + **drop that spell**, others run | `:99-114` |
| Server | rule action throws | catch, `status:'error'`, **other rules continue** | `:134-150` |
| Server | invalid matcher regex | falls back to substring match | `:206-207` |
| Server | `run-command` fails/times out | logged only; **no feedback to the agent** | `:387-394` |
| Server | `spell:rule_fired` emit throws | swallowed — *"must never affect dispatch"* | `:615-617` |
| CLI (auto-activate) | per-spell activation failure | `allSettled`, warn, continue | **[2nd-hand]** |

The design intent is stated at `types.ts:849-850`: *"On any internal rule error the rule is skipped (fail-open) and the error is surfaced for logging; other rules continue."*

**Timeouts, all three of them, and they do not agree:**
- Claude → CLI: **5s** (`hooks.json` `timeout: 5`) **[2nd-hand]**
- CLI → server: **4s** (`hook.ts:52`)
- `run-command` child: **30s** (`HookDispatcherService.ts:51`)

The 4s-inside-5s nesting is deliberate and correct — the CLI gives up before Claude kills it, so it can still exit 0 cleanly. The 30s child timeout exceeding both is *why* `run-command` had to become fire-and-forget: a synchronous 30s command would blow the 5s hook budget every time. `:373-375` confirms — *"the command's latency is fully decoupled from the hook response."*

### 8.1 Firing at a session that cannot receive it — the honest answer

**The dispatcher does not know and does not find out.** `inject-prompt` returns success (`:262-269`) the instant `eventBus.emit` resolves. Delivery is a separate, downstream, *unacknowledged* concern:

- `SessionPromptDeliveryService.ts:30-51` consumes `session:prompt_send`. It fires `deliverPrompt(...)` with `void` and `.then()` — deliberately, per `:33-34`: *"do not hold the event bus (and prompt HTTP response) open during send-mode's 200ms Enter gap."*
- On failure it does exactly one thing: `logger.warn('Session prompt rejected by server PTY queue')` (`:38-42`). **No event, no retry, no notification to the spell, no `status:'error'`.**
- `PtyHostService.deliverPrompt` (`:511-561`) returns `false` on three bounds: oversized prompt (`:517-523`), too many sessions with pending prompts (`:527-532`), per-session queue overflow (`:542-555`). Returns `true` otherwise.
- Crucially, **"no PTY exists yet" is not a failure.** `:501-507`: *"If no PTY exists yet (spawn/resume attach gap), the prompt stays queued and spawn/spawnIfAbsent flushes it deterministically."* There is a `beginPromptHandoff`/`completePromptHandoff` pair (`:490-499`) that pauses draining across a spawn/resume, so prompts sent into the attach gap are buffered rather than lost.
- Only `owner === 'server'` delivers (`SessionPromptDeliveryService.ts:29-31`, `:58-63`). **When the PTY is Tauri-hosted, this service is inert** and delivery is UI-owned (`:12-15`). So whether a spell's `inject-prompt` lands at all depends on a deployment-mode variable the spell system has no visibility into.

**Net:** a spell can fire "successfully", report `status: 'ok'`, emit `spell:rule_fired`, light up the activity feed — and the prompt can be dropped into a warn log. The observability surface reports **dispatch** outcome, not **delivery** outcome, and nothing in the UI distinguishes them.

**This is the single biggest hole in the design and the one I would most want tm8 not to reproduce.** If a hook's action is "deliver something to an agent," the acknowledgement must come back from the thing that actually delivered it.

---

## 9. Surfaces, and which are actually wired

### 9.1 Server — fully wired

`spellRoutes.ts` (268 lines), all Zod-validated, uniform error envelope `{error, code, message}`:

Mechanism A: `GET /spells/definitions` (:25), `GET /spells/entities/:type` (:40), `POST /spells/invoke` (:56), custom prompts CRUD (:70, :84, :98, :112).
Mechanism B: `GET /spells` (:128), `GET /spells/:id` (:142), `POST /spells` (:156), `PUT /spells/:id` (:170), `DELETE /spells/:id` (:184), `POST /spells/:id/activate` (:198), `POST /spells/:id/toggle` (:223), `POST /spells/:id/deactivate` (:238), `POST /spells/:id/reset-loop` (:253).
Dispatch: `POST /api/hooks/dispatch` (`hookRoutes.ts:16`).

### 9.2 CLI — wired **[2nd-hand]**

`maestro-cli/src/commands/spell.ts` (681 lines) reportedly exposes 14 subcommands (`entities`, `list`, `invoke`, `library`, `show`, `create`, `edit`, `remove`, `activate`, `deactivate`, `active`, `reset-loop`, `prompt-create`, `prompt-delete`), each mapped to a real endpoint with no stubs. `maestro hook dispatch <EVENT>` supports `--dry-run` (`hook.ts:224`), which prints a per-rule match report (`renderDryRunReport`, `hook.ts:144-158`) and **always exits 0** (`:209-213`).

The dry-run design (C2) is worth noting on its own: `dryRunRule` (`HookDispatcherService.ts:520-572`) recomputes what each matched rule *would* do — including evaluating the full `run-command` permission gate to report `skipReason` (`:559-564`) — while executing nothing: *"no execFile, no session:prompt_send, no counter increments, no domain events"* (`:515-517`). **A first-class "what would fire here?" probe that runs the real matcher and the real authorization gate is a strong idea and cheap to build in from the start.** Retrofitting it is much harder because you must audit every side effect.

### 9.3 UI — wired, real events **[2nd-hand]**

The files named in the research brief (`maestro-ui/src/hooks/useSpells.ts`, `useSpellInvocation.ts`, `maestro-ui/src/stores/useSpellStore.ts`) **do not exist.** I confirmed this myself by directory listing — `maestro-ui/src/hooks/` contains no spell files at all. The real surface is 7 zustand stores under `maestro-ui/src/stores/`: `useSpellStudioStore`, `useSpellbookStore`, `useSpellLibraryStore`, `useActiveSpellsStore`, `useSpellLauncherStore`, `useSpellNotificationsStore`, `useSpellActivationStore`.

Reported wiring: `SpellStudio` mounts globally from `AppModals.tsx:694`; library CRUD hits real endpoints (`useSpellLibraryStore.ts:66,83,89,95`); activation/toggle/reset hit real endpoints (`useSpellActivationStore.ts:50,73,96,117`); and the activity feed consumes **real** `spell:rule_fired` websocket events, not mock data (`useMaestroStore.ts:653`, `SpellActivityFeed.tsx:28`), capped at 60 entries per session.

Server-side, `spell:rule_fired` is emitted per rule at `HookDispatcherService.ts:605-614` with `{sessionId, spellId, ruleId, event, action, outcome, reason?, timestamp}`, where `outcome` is one of `ok | error | blocked | skipped` (`types.ts:864`). **Per-rule, per-fire observability with a four-state outcome — including `blocked` (permission-gated) and `skipped` (concurrency cap) as distinct from `error` — is the right granularity.** Copy it.

### 9.4 Mobile — read-only, and **stale** (verified directly)

`maestro-mobile/src/domain/entities/spell.ts` defines only `SpellDefinition`, `SpellEntity`, `SpellInvocationPayload`, `SpellInvocationResult`, `CustomPrompt`. **There is no `Spell`, no `SpellRule`, no trigger, no action.** Mobile implements Mechanism A only.

The file carries a REALITY NOTE at `:3-8` that is now **factually wrong about the current tree**:

> *"this worktree's server has NO rich Spell entity (action/loopType/trigger/failMode/color), NO SPELL_COLORS, and NO Ensemble — those live on a different branch (staging)."*

At HEAD `1a7a0a5` the server has all three: `Spell` with rules (`types.ts:725`), `SPELL_COLORS` (`types.ts:610`), `Ensemble` (`types.ts:917`). The note was accurate when written and nobody updated it. **This is exactly the doc-versus-source drift the brief warned about, and it is sitting in a source file rather than a doc.** The mobile client is a full mechanism behind the server.

### 9.5 Firebase / cloud sharing — partial **[2nd-hand]**

`maestro-ui/src/firebase/SpaceSpellsClient.ts` implements a copy-based (not live-sync) share path into Collab Spaces, with schema version 2 (`spaceShareTypes.ts:110`), a v1-compat fallback that degrades a legacy body-only doc into a **disabled** `inject-prompt` stub (`:129-130`), and read-boundary validation that drops malformed rules (`:94-115`). Reported as read-path implemented, publish/share UI not found. Treat as partially wired.

---

## 10. What Spells deliberately do NOT do

These are refusals with evidence, not gaps:

1. **Do not block tool calls.** `gate` was designed, then removed. `types.ts:624` (*"`gate` is dropped; the dispatcher no longer blocks tool calls"*), `types.ts:848` (*"There is NO block path"*), `blocked` hardcoded false at `:651,663`. The entire `PreToolUse`-as-a-veto capability was deleted.
2. **Do not run on a schedule.** Schema-ready, rejected at save (`validation.ts:667-673`) and at dispatch (`HookDispatcherService.ts:172`).
3. **Do not run shells.** `execFile` not `exec`; `sh/bash/zsh/dash/fish/ksh/csh/env/sudo` denied unconditionally (`:65-67`, `:448-450`).
4. **Do not notify anything external.** `notify-channel` lost its `channel` field in C3; `types.ts:641-645` calls it *"an honest in-app-only surface"*; the repository normalizer actively strips `channel` from legacy files (`FileSystemSpellRepository.ts:355-368`).
5. **Do not block the hook on command latency.** `run-command` is fire-and-forget with no configurable timeout; `types.ts:681` — *"run-command exposes NO `timeoutMs`."*
6. **Do not let one session drive another's side effects.** `hook_self_only` (`hookRoutes.ts:27-35`).
7. **Do not let a spell author confer authority.** Gate keys off the executing session (`HookDispatcherService.ts:421-424`).
8. **Do not fire enabled-by-default commands on a fresh install.** Every seed `run-command` ships `enabled: false` (`FileSystemSpellRepository.ts:18-19`).
9. **Do not version or audit spell definitions.** No history, no revisions, no author field on `Spell`.
10. **Do not scope to project/agent/user.** §3.
11. **Do not carry hook payload data into injected prompts.** §7.1.
12. **Do not prioritize.** No ordering field; composition order is cast order (§6).

---

## 11. What transfers to a tm8 hook system, and what does not

### 11.1 First, correct the premise

The brief framed the mismatch as "Spell = human-invoked automation, hook = agent-emitted signal." **Mechanism B is not human-invoked.** Its trigger is an agent-emitted signal (a Claude hook event), delivered over HTTP, matched server-side, and folded back into the agent's control flow. The human act is **binding** (`activate`), not **firing** — and even binding can be automated from a session manifest (§4.4).

So the real axis of difference is not human-vs-agent. It is this:

> **A Spell is a rule bound to a *session*, fired by a *process-lifecycle* event, whose output is folded back into that same process's *exit code*.**
> **A tm8 hook will be a rule bound to a *graph entity*, fired by a *domain* event, whose output has nowhere obvious to go.**

Everything below follows from that.

### 11.2 Transfers — take these

**T1. Discriminated-union trigger and action, with a `never` exhaustiveness guard.** `types.ts:673-688`, `HookDispatcherService.ts:233-243`. Cheap; keeps the dispatcher and the editor honest as the taxonomy grows. Non-negotiable.

**T2. The `ACTIONS_BY_EVENT` capability matrix as one exported constant.** `types.ts:709-718`, consumed by both `validation.ts:675-682` and the UI dropdown. tm8 will have more event types than agent-maestro's 8 and more actions than 5; without a single matrix you get three drifting copies. This is the highest value-per-line item in the whole codebase.

**T3. Authority keyed to the firing context, never the rule author.** `HookDispatcherService.ts:421-424`. tm8 hooks will be authored in one session and fire in another — this is *more* true for tm8 than for maestro, since your entities are shared across a Space by construction. Get this right at the schema level or you will be retrofitting an author-vs-executor distinction later.

**T4. Explicit, written-down composition rules.** §6. Decide before writing the dispatcher: what wins, in what order, what happens on disagreement. Note that they reached a defensible answer partly by *deleting* `gate`. Deleting a capability to make composition tractable is a legitimate v1 move.

**T5. Fail-open by default, at every layer, deliberately.** §8. A hook system that can break the agent it observes will be turned off. Every layer of agent-maestro degrades to "exit 0, do nothing." **But** — see M4 — fail-open must be *chosen* per action, not inherited by accident.

**T6. Dry-run as a first-class, day-one capability.** `HookDispatcherService.ts:520-572`, `hook.ts:144-158,209-213`. Runs the real matcher and the real permission gate, executes nothing, reports per-rule `wouldExecute` + `skipReason`. Retrofitting this requires auditing every side effect; building it in costs one branch in the dispatch loop. For tm8, where a hook may fan out across a graph, "show me what this would do" is not a debugging nicety, it is a safety requirement.

**T7. Per-rule observability with a four-state outcome.** `ok | error | blocked | skipped` (`types.ts:864`), emitted per rule per fire (`:605-614`). Distinguishing "denied by policy" from "dropped for capacity" from "threw" is what makes the feed diagnostic instead of decorative.

**T8. Ship-inert defaults.** Every seeded `run-command` ships `enabled: false` with a self-describing `echo` placeholder (`FileSystemSpellRepository.ts:16-23, 33-38`), enforced by a test. Any tm8 hook template with side effects should ship disabled.

**T9. Read-time normalization instead of migrations, while the schema is young.** `normalizeSpell` (`:355-368`). Idempotent, cheap, runs on every read. Right call for a system whose action schema will change several more times.

**T10. Reserve a shape, refuse it at two layers.** The `schedule` trigger: in the type, in the schema-as-rejected, refused again in the engine (`validation.ts:667-673`, `HookDispatcherService.ts:172`). This is how to ship a placeholder without accruing dead config. Contrast with `args` (§7.3), which is accepted and silently discarded — that is the anti-pattern.

**T11. Nest your timeouts deliberately.** 4s CLI-to-server inside 5s Claude-to-CLI (`hook.ts:52` vs `hooks.json`). The inner budget must expire first so the outer layer can exit cleanly rather than being killed.

### 11.3 Does not transfer — the mismatches, specifically

**M1. The exit-code return channel does not exist for tm8.** This is the deepest mismatch. A Spell's entire feedback path — `exitCode: 0 | 2`, stdout, stderr — exists because a Claude hook is a *child process of the agent*, and the agent's harness reads its exit code. `foldResult` (`hook.ts:123-137`) is the whole contract. `continue-loop` — arguably the most valuable action, and the one the three most prominent seeds all use (`spell_self_critic`, `spell_plan_first`, `spell_focus_keeper`) — is **nothing but a way to return exit 2**. A tm8 hook fired by a domain event has no process, no exit code, and no synchronous reader. **`continue-loop` and `feed-context` do not port at all.** Do not try to emulate them; design a return channel appropriate to your event source, or accept that tm8 hooks are fire-and-forget and say so.

**M2. Session-scoped binding does not fit a graph.** `ActiveSpell` lives on `Session.activeSpells` (`types.ts:540`) — a single array on a single mutable object. This works because a session is a leaf with an obvious owner. tm8 entities are a *hierarchy* with parents, children, and cross-links. You must answer questions Spells never face: does a hook on a parent fire for a child? Do bindings inherit? What fires when an entity is re-parented? agent-maestro has **zero** guidance here because it has zero hierarchy (§3). This is your genuinely novel design work.

**M3. Global-flat scope is an anti-pattern to avoid, not a model to copy.** §3. `ISpellRepository` (`ISpellRepository.ts:3-10`) has no scope parameter on any method. tm8 is multi-Space by construction; a scope axis must be in the repository interface from the first commit. Retrofitting it through `findAll()`/`findById()` and every call site is the migration agent-maestro has conspicuously not done.

**M4. Universal fail-open is wrong for a graph-mutating hook.** For agent-maestro, "the hook did nothing" is always safe — the worst case is a missing reminder. If a tm8 hook's action is `create entity` or `send message` or `transition task state`, silent failure means **the graph is now wrong and nobody knows.** Take T5's *mechanism* (bounded, logged, non-fatal degradation) but make the failure *policy* a per-action property. Some actions must fail loudly and surface an attention request.

**M5. Static prompts are too weak for tm8.** §7.1 — no Spell action can reference its triggering payload. That is tolerable when every action is a generic reminder ("never commit secrets"). tm8 hooks will need the triggering entity's id, kind, and fields, which means you need templating, which means you inherit §7.2's problem — **and agent-maestro's templating has no escaping and no untrusted-data fencing.** Do not copy `interpolateTemplate` (`SpellService.ts:773-780`). Fence interpolated graph content at the interpolation site, the way this session's own prompt envelope does.

**M6. `run-command` is a bigger risk in tm8 and its mitigations are load-bearing.** If tm8 keeps a process-executing action, port **all five gates** (§5.2) — readOnly mode, per-member opt-out, binary denylist, optional allowlist, concurrency caps — plus `execFile`-not-`exec`, plus child tracking with SIGTERM on shutdown. And note that the UI acknowledgement is **client-side only** (§5.3) and does not exist in the server schema. Server-side gates are the only real ones. If you can ship v1 without process execution, do.

**M7. Do not reproduce the unacknowledged-delivery hole.** §8.1. A spell reports `ok` and lights up the activity feed while the prompt dies in a `logger.warn` inside `SessionPromptDeliveryService.ts:38-42`. Dispatch outcome and delivery outcome are different facts and this system conflates them. If a tm8 hook action is "deliver X to Y," the acknowledgement must come back from whatever actually delivered it — otherwise your observability is confidently wrong, which is worse than absent.

**M8. Composition-by-cast-order will not survive a graph.** §6 — stdout concatenates in `activeSpells` array order and there is no priority field anywhere. Fine for 1-3 rules on one session. If tm8 hooks can be inherited down a hierarchy, N grows and order becomes nondeterministic-feeling to users. Decide on explicit ordering (or explicit unordered-ness) up front.

**M9. Zero versioning is survivable for maestro and probably not for tm8.** §1.2 — no version, no history, no author on `Spell`. tm8 has versioning and `allowed actions` as first-class concepts; a hook definition that mutates the graph should be at least as auditable as the entities it mutates. Expect to add `version` and `createdBy` that agent-maestro never needed.

### 11.4 If you take one thing

Take **T2 (the capability matrix as a single shared constant)** and **T3 (authority from the firing context, not the author)**. They are small, they are load-bearing, and they are both very expensive to retrofit.

Avoid **M1**: do not port `continue-loop`/`feed-context` semantics without first answering what a tm8 hook's return channel actually *is*. That question is upstream of most of your other decisions, and agent-maestro cannot answer it for you — its answer was "a process exit code," and you do not have a process.

---

## 12. What I could not verify

- **The `hooks.json` bodies.** I verified by direct count that both `maestro-cli/plugins/maestro-orchestrator/hooks/hooks.json` and `maestro-cli/plugins/maestro-worker/hooks/hooks.json` contain exactly 8 `hook dispatch` bindings. The per-event matcher/timeout details and the chained commands (e.g. `session needs-input` before `hook dispatch Stop`) are **[2nd-hand]** from a delegated read. The 5s timeout figure is from that same second-hand read; I did not open the JSON myself.
- **`maestro-cli/src/commands/spell.ts` (681 lines).** The 14-subcommand inventory and the "no stubs" verdict are **[2nd-hand]**. I did not open this file. Treat the "fully wired, no TODOs" claim as plausible but unaudited — that agent's report was uniformly positive, which warrants mild suspicion.
- **UI wiring.** All `maestro-ui` claims in §9.3 are **[2nd-hand]** except the `run-command` acknowledgement (`ActionPanels.tsx:103-110`, `editorState.ts:137,215,343`), which I verified directly. I confirmed the three brief-named UI files do not exist by directory listing.
- **Firebase/Collab-Space sharing** (§9.5) is **[2nd-hand]** and reported as partial. I did not verify the publish path either way. Its absence in that report is not evidence of its absence in the tree.
- **I did not read the design docs.** `docs/spell-system-explainer.md`, `docs/spells-design.md`, `docs/spells-server-design.md`, `docs/spells-cli-design.md`, `docs/spells-ui-design.md` and ~8 sibling spell docs all exist at `docs/`. I went straight to source per the brief's instruction to prefer it, and every claim above is sourced from code. **I therefore cannot report where the docs and the tree disagree** — only that the in-source REALITY NOTE at `maestro-mobile/src/domain/entities/spell.ts:3-8` is itself stale against HEAD (§9.4), which suggests the docs are worth distrusting by default.
- **Nothing was executed.** No server run, no CLI run, no tests run. Everything here is static reading. Behavior under concurrency, under real hook load, and the actual end-to-end latency of a dispatch are all unverified.
- **Test files were not read** beyond noting their existence: `maestro-server/test/` contains `websocket-bridge-spell-firing.test.ts`, `spell-cast-toggle.test.ts`, `spell-library-seeds.test.ts`, `spell-activespells-persistence.test.ts`, `spell-reset-loop.test.ts`, `spell-migration.test.ts`, `hook-dispatcher.test.ts`. Coverage claims in §9.2 are **[2nd-hand]**.
