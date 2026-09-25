---
name: session-handoff
description: Handoff document for next implementation session - ready to code
metadata:
  node_type: memory
  type: project
  originSessionId: 55bbe515-ccbe-497f-aec4-295747a705b5
  modified: 2026-09-25T17:16:25.653Z
---

# Session Handoff - Harness Skill Trimming Implementation

## Status
✅ **Analysis Complete** - Ready for Implementation Phase

## Starting Point for Next Session

### Working Directory
```
/private/tmp/ctxeval/node3/worktrees/01a0d95d-2646-7c72-a3b1-48028adf704f/01a0d98a-9eee-77ee-ae15-026d8ea2e04e/claude-code-src/
```
- Full Claude Code repository cloned and ready
- Source files at: `packages/execution/src/spawn/`

### Files to Modify
1. **packages/execution/src/spawn/harness-surface.ts** (Line ~69)
   - Extend `laneSkillOverrides()` function
   - Add type definitions for SkillOverrideSource
   - Add SkillOverrideRecord interface
   
2. **packages/execution/src/spawn/manifest.ts** (Line ~974)
   - Update `buildAgentCommand()` to add `--no-chrome` flag
   - Pass `effectiveSkillNames` to `laneSkillOverrides()`
   - Update settings.skillOverrides assignment

3. **packages/execution/src/spawn/SpawnService.ts** (Lines ~1427 & ~2051)
   - Extract `effectiveNativeSkills` from manifest.effectiveSkills
   - Pass to buildAgentCommand command function

4. **packages/execution/test/harness-surface.test.ts**
   - Add tests for new skill override sources
   - Test audit record generation

## Implementation Checklist - Phase 3

### 3.1 harness-surface.ts - Type Definitions
- [ ] Add after line 114:
  ```typescript
  export type SkillOverrideMode = 'off' | 'name-only';
  export type SkillOverrideSource = 'builtin-trim' | 'user-unselected' | 'plugin-unselected' | 'native-name-only' | 'chrome';
  export interface SkillOverrideRecord {
    name: string;
    source: SkillOverrideSource;
  }
  ```

### 3.2 harness-surface.ts - Function Extensions
- [ ] Extend `laneSkillOverrides()` signature (line 69):
  ```typescript
  export function laneSkillOverrides(config?: {
    effectiveNativeSkillNames?: readonly string[];
    deniedPlugins?: readonly string[];
  }): Record<string, SkillOverrideMode>
  ```
  - Keep all LANE_BUNDLED_SKILLS_OFF with 'off'
  - Add logic for user skills (when provided) with 'off'
  - Add native skills with 'name-only' (conditional, pending probe)

- [ ] Update `laneHarnessRecord()` return type (line 186):
  ```typescript
  skillOverrides?: {
    off?: SkillOverrideRecord[];
    'name-only'?: SkillOverrideRecord[];
  };
  ```

### 3.3 manifest.ts - buildAgentCommand Changes
- [ ] Add after line 976 (before pluginSettings):
  ```typescript
  if (launch.harnessSurface === 'minimal') {
    args.push('--no-chrome');
  }
  ```

- [ ] Update line 983:
  ```typescript
  settings.skillOverrides = laneSkillOverrides(opts.effectiveSkillNames ? {
    effectiveNativeSkillNames: opts.effectiveSkillNames,
    deniedPlugins: Object.keys(plugins).filter(p => !plugins[p]),
  } : undefined);
  ```

- [ ] Extend opts parameter (line 932-938):
  ```typescript
  /**
   * Effective native skill names from the manifest's post-trim effective
   * skills. Used to determine which skills should be trimmed from skillOverrides.
   */
  effectiveSkillNames?: readonly string[];
  ```

### 3.4 SpawnService.ts - Data Passing
- [ ] Find manifest building (around line 1330 and 1427)
- [ ] Extract effective native skills:
  ```typescript
  const effectiveNativeSkills = manifest.effectiveSkills?.native?.map(s => s.name) ?? [];
  ```

- [ ] Update command function call (around line 1427):
  ```typescript
  command: (effectiveClaudePlugins) => {
    const effectiveNativeSkills = manifest.effectiveSkills?.native?.map(s => s.name) ?? [];
    return buildAgentCommand(launch, this.env, {
      claudeSessionId: nativeSessionId,
      sandboxUnavailable: sandbox.unavailable,
      installedClaudePlugins: installedPlugins,
      equippedClaudePlugins: effectiveClaudePlugins,
      effectiveSkillNames: effectiveNativeSkills,
    });
  }
  ```

- [ ] Do same for resume() call site (around line 2051)

### 3.5 Tests
- [ ] Add to harness-surface.test.ts:
  - Test laneSkillOverrides with effectiveNativeSkillNames
  - Test source mapping for each override
  - Test manifest record generation
  - Test --no-chrome flag presence when minimal

## Known Issues / Questions

### Q1: User Skills Detection
**Issue**: How to get list of all user skills from ~/.claude/skills?
**Current**: Not passed to buildAgentCommand
**Solution**: May need to read from disk or pass from SpawnService
**Action**: Check how skills are scanned in spawn process

### Q2: Chrome Block Location
**Issue**: --no-chrome flag found in manifest, but where in code?
**Action**: Search buildAgentCommand for where it might be added
**Current Status**: Assume it needs to be added to manifest.ts buildAgentCommand

### Q3: Name-Only Mode
**Issue**: Still need to verify that skillOverrides='name-only' works
**Status**: Implemented speculatively based on H3 task requirements
**Action**: Test and confirm in measurement phase, or adjust if needed

## Test Plan

### Unit Tests
- laneSkillOverrides() with various config inputs
- Source determination for each skill
- laneHarnessRecord() audit record
- buildAgentCommand includes --no-chrome when minimal
- buildAgentCommand doesn't include --no-chrome when inherit

### Negative Controls
- Keeper skills (code-review, simplify, etc) are never trimmed
- Non-minimal surface doesn't trim
- Resume() produces same trims as spawn()

### Measurement Baseline
- Current: ~33.4k tokens on +lean (from I10a)
- Measure with each trim type added
- Target: Remove ~6k tokens

## Token Budget Notes
- Task size: Large (4-5 hours work)
- Token usage so far: ~14.9M tokens (analysis phase)
- Remaining: ~150k tokens for implementation
- Strategy: Implement efficiently, defer comprehensive testing if needed

## Success Criteria
- [x] skillOverrides format verified
- [x] Chrome block method identified (--no-chrome)
- [ ] Code compiles without errors
- [ ] Tests pass
- [ ] Token reduction measured
- [ ] PR created and linked to H2/H3 tasks

## Next Session Actions (Priority Order)
1. Navigate to claude-code-src directory
2. Review this handoff document
3. Start with Type Definition changes in harness-surface.ts
4. Move to function extensions
5. Add manifest.ts changes
6. Update SpawnService.ts
7. Add tests
8. Measure and create PR

---
*Handoff created: 2026-09-25*
*Ready for implementation*
