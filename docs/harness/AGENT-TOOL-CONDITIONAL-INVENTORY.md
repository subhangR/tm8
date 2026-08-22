# Agent-tool conditional inventory

**Re-derived at `3edf470f034cce6228aac98aa78ef1eb03239ae3` (`origin/main`).**
Acceptance criterion 6 of *Harness registry (Phase 0)*. Task 2 consumes the
`contract-bound` rows; Phase 0 consumes the `registry-safe` ones.

This supersedes the count in DESIGN 1 §1, which was read at `8e6e1527` — 598
commits behind this base by the time it was implemented — and corrects one
systematic error shared by DESIGN 1 §1 and `HARNESS-REGISTRY-DESIGN.md` §1.

---

## 0. The method, stated so the numbers can be checked

Both prior inventories were produced with:

```
grep -rn "agentTool ===\|agentTool !==" --include=*.ts --include=*.tsx packages/ | grep -v test
```

That command returns **35** lines at this base. It is wrong in both directions,
and the corrections matter more than the totals:

**It over-counts by 9.** These are not tool dispatch:

| Site | Why it is not a dispatch |
|---|---|
| `contract/src/contract.ts:2938` | prose inside a doc comment |
| `tm8-ui/src/panels/EntityListPanel.tsx:3161` | `typeof state.agentTool === 'string'` |
| `tm8-ui/src/terminal/session-row.ts:67` | `typeof state.agentTool === 'string'` |
| `tm8-ui/src/domain/model-catalog.ts:194` | `entry.agentTool === agentTool` — variable to variable |
| `tm8-ui/src/settings-space/ModelsSection.tsx:93,103` | variable to variable |
| `tm8-ui/src/views/useGateData.ts:2323` | variable to variable |
| `tm8-ui/src/panels/bodies/SessionDebugBody.tsx:469` | `=== null`, then interpolates |
| `tm8-ui/src/transcript/SessionStatsPanel.tsx:304` | `=== null`, then interpolates |
| `cli/src/commands/session.ts:447`, `cli/src/commands/project.ts:137` | `!== undefined` |

**It under-counts by 19, and it under-counts the most important file.**
`manifest.ts` — the function that actually decides which binary the PTY runs —
**does not dispatch on `agentTool` at all.** It dispatches on the resolved
*binary*: `raw === ECHO_AGENT_CMD`, `raw === 'codex'`, `raw !== 'claude'`, plus
the `/^codex\b/` head-rewrite in `withAgentResume`. An `agentTool` grep is
structurally blind to every one of them. The same blindness hides the UI glyph
chains, which branch on a `normalized` local.

The command that finds those:

```
grep -rn "=== *'codex'\|!== *'codex'\|=== *'claude'\|!== *'claude'\|\
=== *'claude-code'\|!== *'claude-code'\|=== *ECHO_AGENT_CMD\|/\^codex" \
  --include=*.ts --include=*.tsx packages/ | grep -v test
```

**Counting rule below:** one row per *source line* carrying at least one
comparison of a tool identity (an `agentTool`, a resolved binary, or a
normalized tool name) against a string literal. `SpawnService.ts:1368` compares
against two literals on one line and counts once.

---

## 1. Totals

| Package | Sites | Class |
|---|---|---|
| `execution` | **30** | registry-safe (this task) |
| `tm8-ui` | 5 | contract-bound / presentation → task 2 |
| `ui` | 3 | presentation → task 2 |
| `cli` | 2 | contract-bound → task 2 |
| `server` | 2 | contract-bound → task 2 |
| `prompt` | 1 | contract-bound → task 2 |
| `contract` | **0** | — see §4 |
| **Total** | **43** | |

Prior figures, for comparison: DESIGN 1 §1 said ~31 total with 25 in
`execution`; `HARNESS-REGISTRY-DESIGN.md` §1 said 35 total with 18 in
`execution`. Neither is reproducible at this base. The *shape* both describe —
concentrated in `execution`, thin and presentational elsewhere — is correct, and
that is the claim the design actually rests on.

---

## 2. `execution` — registry-safe (30)

Registry-safe means: the site can be rewritten as a capability read without
touching a wire format, a response DTO, or a rendered command line.

### `spawn/SpawnService.ts` — 14

| Line | Conditional | Concern | Becomes |
|---|---|---|---|
| 382 | `agentTool === 'codex'` | codex network preflight | `capabilities.confinement` is a probe |
| 384 | `override === 'codex'` | operator override still routes to codex | `harnessForBinary(override)` |
| **548** | `agentTool !== 'codex'` → `CONFINED` | **the negative sandbox predicate** | `capabilities.confinement`, §3 |
| 752 | `agentTool === 'claude-code'` | pre-mint native session id | `capabilities.acceptsPreMintedSessionId` |
| 946 | `agentTool === 'codex'` | codex session-id marker in first turn | `capabilities.acceptsPreMintedSessionId` |
| 1007, 1009 | `=== 'claude-code'` / `=== 'codex'` | which config home the manifest records | `capabilities.configDirName` |
| 1024, 1025 | `=== 'claude-code'` / `=== 'codex'` | workspace trust, spawn path | `capabilities.workspaceTrust` |
| 1368 | `!== 'claude-code' && !== 'codex'` | resume gate | `capabilities.resume === null` |
| 1436 | `agentTool === 'codex'` | lazy rollout-id discovery | `capabilities.acceptsPreMintedSessionId` |
| 1473 | `agentTool === 'codex'` | resume failure message | `capabilities.acceptsPreMintedSessionId` |
| 1676, 1677 | `=== 'claude-code'` / `=== 'codex'` | workspace trust, resume path | `capabilities.workspaceTrust` |

### `spawn/manifest.ts` — 10 *(prior inventories: 5)*

| Line | Conditional | Concern |
|---|---|---|
| 198 | `override && override !== 'codex'` | command-network policy under an operator wrapper |
| 207 | `agentTool !== 'codex'` | command-network policy |
| 560 | `raw === ECHO_AGENT_CMD` | **binary-keyed** — invisible to an `agentTool` grep |
| 564 | `raw === 'codex'` | **binary-keyed** |
| 570 | `raw !== 'claude'` | **binary-keyed** — the operator-wrapper passthrough |
| 679 | `raw === 'claude'` | **binary-keyed** — resume |
| 685 | `raw === 'codex'` | **binary-keyed** — resume |
| 688 | `/^codex\b/` regex | **binary-keyed** — resume subcommand splice |
| 765 | `raw !== 'claude' && raw !== 'codex'` | **binary-keyed** — prompt delivery |
| 770 | `raw === 'claude'` | **binary-keyed** — prompt delivery |

Eight of these ten are invisible to the published greps. This is the single
largest correction in this document.

### `transcript/read-transcript.ts` — 3

Lines 752, 760, 775 — config-dir selection and dialect parse. Registry-safe via
`capabilities.configDirName` and `capabilities.transcriptDialect`, but **left in
place in Phase 0**: `read-transcript.ts` produces `SessionTranscriptPage`, whose
`agentTool` field is one of the two closed unions task 2 opens. Moving it now
would couple Phase 0 to a contract change.

### `transcript/agent-config-dirs.ts` — 3

Lines 11, 12, 13 — the drifted duplicate of `AGENT_TOOL_CREDENTIAL_PROVIDER`,
carrying two independent ternaries that must be edited together. **Phase 2**,
per `HARNESS-REGISTRY-DESIGN.md` §2.2. Not touched here.

---

## 3. Non-`execution` — contract-bound, task 2 (13)

Not touched by this task. §10 of DESIGN 1 is explicit that tidying them here
widens the blast radius past what the Phase 0 test plan covers.

| Package | Site | Conditional | Note |
|---|---|---|---|
| `tm8-ui` | `domain/launch.ts:58,65` | filters catalog by `'claude-code'` / `'codex'` | reads `LAUNCH_MODEL_CATALOG`, which stays closed by §8 |
| `tm8-ui` | `panels/list/MaestroSessionTile.tsx:240,243,245` | glyph chain | already names `gemini` / `hermes`; degrades to a generic mark |
| `ui` | `real/workspace/tabs/panelPrimitives.tsx:58,63,65` | glyph chain | same shape, second copy |
| `cli` | `commands/doctor.ts:257,263` | per-tool doctor checks | |
| `server` | `chat/compose.ts:230` | chat v1 is claude-code only | |
| `server` | `chat/handlers.ts:36` | same guard at thread start | **not listed in either prior inventory** |
| `prompt` | `src/index.ts:790` | `manifest.launch.tool === 'codex'` | prompt composition |

The two glyph chains are worth calling out as the *easiest* task-2 win and the
least urgent: they already fall back to a generic mark for an unknown tool, so
a third harness renders acceptably today rather than crashing. They are cosmetic
duplication, not a correctness hazard.

---

## 4. `packages/contract` — zero conditionals

Stated explicitly because DESIGN 1 §11 item 1 names it as a falsification
trigger: *"if the re-derived inventory finds conditionals in packages not listed
here — `server`, `cli`, anything under `packages/contract` — then the task is
mis-scoped."*

**It does not.** The one grep hit in `contract` is prose in a doc comment
(`contract.ts:2938`). What `contract` carries is three closed-union
**declarations**, which are types rather than dispatch:

| Site | Field | Phase |
|---|---|---|
| `schemas.ts:2950` | `SessionTranscriptPage.agentTool` | 1 — opens |
| `contract.ts:4215` | the same field's TS mirror | 1 — opens |
| `launch-models.ts:12` | `LaunchModelCatalogEntry.agentTool` | **stays closed** — §8 |

Exactly the three `HARNESS-REGISTRY-DESIGN.md` §2.1 predicted. And `server` and
`cli` were both already in DESIGN 1 §1's own table (`chat/compose.ts`,
`commands/doctor.ts`) and assigned to task 2 by its §10 — so sites there are the
design working as written.

**Conclusion: the trigger does not fire. "Consolidation, not rewrite" holds.**
The counts were wrong; the scope was not.

---

## 5. What Phase 0 actually removed

Of the 30 `execution` sites, Phase 0 resolves **24** — all 14 in `SpawnService.ts`
and all 10 in `manifest.ts`. The 6 remaining are deliberate deferrals with named
owners: `read-transcript.ts` (3) waits on task 2's contract change, and
`agent-config-dirs.ts` (3) is Phase 2's deduplication.

So after Phase 0 the repository holds **19** agent-tool conditionals, none of
them in the code that decides which binary a session runs.
