# Effective skill index (F3)

`@tm8/execution` exports `computeEffectiveSkills(input: EffectiveSkillsInput): EffectiveSkills`.
Input contains `agentTool`, absolute `workdir`, `projectRoot: string | null`, and cached `equips: ResolvedSkillRow[]`; optional `scannedAt`, `agentConfigDir`, and `homeDir` describe the launch environment. The helper never reads files. `loadSkillEquipment(q, spaceId, teamMemberId)` in the server reads teammate/ancestor equipment only, under caller claims, with explicit Space bounds. Distinct filesystem paths remain distinct; graph-only names retain nearest-first resolution and equal-depth ambiguity errors.

`EffectiveSkills` has `native`, `indexed`, `skipped`, and `scannedAt`. Entries contain entity ID, name, full description, provider, level, optional source path/hash, load pointer, native flag, and implicit-invocation flag. There are no skill bodies. Missing files and explicit Codex disables are recorded as skipped; native Claude collisions follow loader precedence. Native scope checks use the actual workdir and selected provider config directory, so a worktree outside the original source tree uses absolute source pointers.

The read-only launch-sheet endpoint is:

```
GET /v2/spaces/:spaceId/skills/preview
  ?teamMemberId=<uuid>
  &projectId=<uuid>
  &agentTool=claude-code|codex
  &workdir=/absolute/path
  &agentConfigDir=/absolute/provider/config
```

Only `teamMemberId` is required. The endpoint uses cached metadata, performs no scan or file reads, and does not provision credentials. Defaults are the teammate's tool (then Claude), linked project workdir (then `/`), and OS provider config convention. Callers previewing a selected credential home should supply its config directory. The actual spawn always uses its resolved tool/workdir/credential directory.

The result extends `EffectiveSkills` with `rows`: entityId, entityVersion, name, full description, provider, level, sourcePath, scope (`native|indexed|skipped`), indexLine, contentHash, missing, equippedBy (`persona|ancestor`), disableModelInvocation, allowImplicitInvocation, and optional skip reason. Skipped entries have `indexLine: null`. `@tm8/prompt.serializeSkillIndexEntry` produces the exact escaped entry text used by prompt composition. Preview describes equipment, not the unequipped candidate corpus. No eligibility field is invented.

Spawn applies the existing combined 32,768-byte prompt budget to serialized, escaped index text after other prompt material. There is no skill count cap. Whole omitted entries appear in `manifest.droppedSkills` and the effective audit, with `byte-budget` or `relevance` reasons. Full descriptions remain available to candidate consumers and previews.

Migration 199 adds `public.work_sessions.skills`; `record_session_manifest` writes the effective audit atomically with the manifest. Entity and event projections expose it as `work_session.state.skills`. The audit includes hashes and scan timestamp; no session equips or correction edges are created or consumed.

Spawn emits manifest v1. The CLI v1 reader retains the compact index for `worker init`. The separate v2 bootstrap manifest remains a closed, 4 KiB control-only document; its prohibition on authored skills cannot affect the v1 spawn path. Neither path injects skill bodies.
