---
name: implementation-checklist
description: Step-by-step implementation checklist for harness skill trimming
metadata:
  node_type: memory
  type: project
  originSessionId: 55bbe515-ccbe-497f-aec4-295747a705b5
  modified: 2026-09-25T17:14:57.423Z
---

# Implementation Checklist

## Phase 1: Code Analysis (COMPLETE)
- [x] Find Claude Code source
- [x] Analyze harness-surface.ts
- [x] Analyze manifest.ts
- [x] Find probe results in manifest
- [x] Verify skillOverrides format
- [x] Identify --no-chrome flag

## Phase 2: Implementation Planning (COMPLETE)
- [x] Document current structure
- [x] Plan extension points
- [x] Identify call sites
- [x] Document data flow

## Phase 3: Code Changes (READY TO START)

### 3.1 Update harness-surface.ts
- [ ] Add SkillOverrideMode type ('off' | 'name-only')
- [ ] Add SkillOverrideSource type with all sources
- [ ] Add SkillOverrideRecord interface
- [ ] Add HarnessSkillOverrides interface with off/name-only arrays
- [ ] Extend laneSkillOverrides() function signature:
  - [ ] Add config parameter with effectiveSkillNames, installedUserSkills, deniedPlugins
  - [ ] Implement user-unselected logic
  - [ ] Implement plugin-unselected logic
  - [ ] Conditional native-name-only (mark as TODO pending probe confirmation)
- [ ] Update laneHarnessRecord() return type with new skillOverrides structure
- [ ] Add helper function to determine source of each skill

### 3.2 Update manifest.ts buildAgentCommand()
- [ ] Add --no-chrome flag when harnessSurface === 'minimal'
- [ ] Update laneSkillOverrides() call to pass config:
  - [ ] Extract effectiveSkillNames from somewhere (TBD)
  - [ ] Extract installedUserSkills from somewhere (TBD)
  - [ ] Compute deniedPlugins from pluginSettings result
- [ ] Verify command structure

### 3.3 Wire Effective Skills Data
- [ ] Find where effectiveSkills is computed in manifest.ts
- [ ] Pass effectiveSkills data to buildAgentCommand opts
- [ ] Extract skill names from effectiveSkills.native
- [ ] Extract skill names from effectiveSkills.indexed
- [ ] Pass to laneSkillOverrides() function

### 3.4 Update Both Call Sites
- [ ] Find SpawnService.spawn() call site
- [ ] Find SpawnService.resume() call site (important: must be consistent)
- [ ] Ensure both pass same data to buildAgentCommand
- [ ] Verify manifest.harness.skillOverrides is populated at both sites

### 3.5 Update Tests
- [ ] Update harness-surface.test.ts:
  - [ ] Test new source types
  - [ ] Test laneSkillOverrides with user skills
  - [ ] Test laneSkillOverrides with plugin skills
  - [ ] Test source determination
  - [ ] Test manifest record generation
- [ ] Update manifest.test.ts:
  - [ ] Test --no-chrome flag when minimal
  - [ ] Test --no-chrome NOT present when inherit
  - [ ] Test skillOverrides in command includes all sources
- [ ] Add new test file for negative control:
  - [ ] Verify keepers (code-review, simplify, security-review, workflow-authoring) are never trimmed

## Phase 4: Measurement
- [ ] Measure baseline (current code)
- [ ] Measure with user-unselected trimming
- [ ] Measure with plugin-unselected trimming
- [ ] Measure with --no-chrome
- [ ] Measure combination of all
- [ ] Document token reduction
- [ ] Compare to target (remove ~6k tokens)

## Phase 5: PR & Handoff
- [ ] Create feature branch
- [ ] Commit code changes
- [ ] Commit test changes
- [ ] Commit measurement results
- [ ] Create PR
- [ ] Link to H2 task (01a0d3b2-5292)
- [ ] Link to H3 task (01a0d3b2-5886)
- [ ] Add "PR READY #N" comment to orchestrator session
- [ ] DO NOT merge

## Open Questions

### Q1: Effective Skills Data Flow
**Question**: Where and how should effectiveSkills be passed to buildAgentCommand?
**Current Status**: Not yet determined
**Impact**: Phase 3.3 and 3.4
**Blocking**: Need to trace data flow in manifest.ts

### Q2: User Skills Source
**Question**: How to identify all user skills from ~/.claude/skills?
**Current Status**: Not yet implemented
**Impact**: Phase 3.1 (user-unselected logic)
**Blocking**: Need to read user skills during spawn

### Q3: native-name-only Confirmation
**Question**: Does skillOverrides='name-only' actually work?
**Current Status**: Assumed yes based on H3 task
**Impact**: Phase 3.1 (conditional implementation)
**Risk**: If no, need different approach for H3

### Q4: Chrome Block Side Effects
**Question**: Does --no-chrome affect anything else?
**Current Status**: Found in manifest, appears safe
**Impact**: Phase 3.2 (implementation confidence)
**Risk**: Low - already in use

## Documentation Needed

- [ ] Update PROBE_RESULTS.md with final probe findings
- [ ] Document any assumptions made (e.g., name-only format)
- [ ] Document token reduction achieved
- [ ] Document any limitations or caveats

## Success Criteria

- [x] skillOverrides format verified
- [x] Chrome block removal method identified
- [ ] Code implements all trim sources
- [ ] All tests pass
- [ ] Token reduction measured and documented
- [ ] PR created and linked
- [ ] No merge needed (delegated)

## Timeline Estimate
- Implementation: 2-3 hours (code + tests)
- Measurement: 1 hour
- PR creation: 30 minutes
- Total: 4-5 hours from now

## Current Status
- Phase 1: ✅ COMPLETE
- Phase 2: ✅ COMPLETE
- Phase 3: ⏳ READY TO START
- Phase 4: ⏳ BLOCKED ON PHASE 3
- Phase 5: ⏳ BLOCKED ON PHASE 4
