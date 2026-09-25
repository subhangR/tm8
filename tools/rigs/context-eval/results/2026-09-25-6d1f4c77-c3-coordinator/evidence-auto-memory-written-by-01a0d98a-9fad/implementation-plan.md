---
name: implementation-plan
description: Detailed implementation plan for harness skill trimming (skillOverrides)
metadata:
  node_type: memory
  type: project
  originSessionId: 55bbe515-ccbe-497f-aec4-295747a705b5
  modified: 2026-09-25T17:11:06.441Z
---

# Implementation Plan - Harness Skill Trimming

## Phase 1: Probe (BLOCKING - must complete first)

### Probe Requirements
On a separate dev node (:46xx, fresh DB), verify:

1. **skillOverrides Key Format** - Exact syntax for:
   - (a) Turning off a user skill from ~/.claude/skills
   - (b) Turning off ONE skill of an enabled plugin (not all)
   - (c) Setting 'name-only' for equipped native skills
   
2. **Chrome Block Removal** - Which setting/flag drops:
   - Claude in Chrome block (~4.1k chars)
   - Without breaking operator's own Chrome use
   - Read Claude Code docs/settings; probe never guess

3. **Recording** - For each probe, record:
   - The command executed
   - The setting/flag used
   - Before/after skill_listing char count
   - Whether it worked without breaking other features

### Expected skillOverrides Format
Based on task spec, likely structure:
```json
{
  "launch": {
    "harness": {
      "skillOverrides": {
        "off": [
          { "name": "skill-name", "source": "user-unselected|plugin-unselected|chrome" }
        ],
        "name-only": [
          { "name": "skill-name", "source": "native-name-only" }
        ]
      }
    }
  }
}
```

## Phase 2: Implementation (after probe results)

### Files to Modify
1. **packages/execution/src/spawn/harness-surface.ts**
   - Apply skillOverrides.off to exclude skills
   - Apply skillOverrides['name-only'] to native skills
   - Remove Chrome block if flagged

2. **manifest.ts - buildAgentCommand()**
   - Record every trim in launch.harness.skillOverrides
   - Include source metadata for each
   - Mirror on resume (TWO call sites: spawn AND resume)

3. **packages/server/src/configs/registry.ts**
   - Register any new constants
   - Same PR as implementation

### Trimming Logic
1. **User Skills**: Remove if not in effective skill set
   - Source: 'user-unselected'
   
2. **Plugin Skills**: Remove if plugin enabled but skill not selected
   - Source: 'plugin-unselected'
   
3. **Native Skills**: Set to 'name-only' if equipped
   - Source: 'native-name-only'
   - ONLY if probe shows /name still works
   
4. **Chrome Block**: Remove entirely
   - Source: 'chrome'

### Recording Specification
Every trim must be recorded with metadata:
```
launch.harness.skillOverrides = {
  off: [{name, source}],
  "name-only": [{name, source}]
}
```
- Never silent - every trim recorded
- Sources: 'user-unselected', 'plugin-unselected', 'native-name-only', 'chrome'

### Testing
- harness-surface unit tests
- manifest unit tests  
- Negative control test (verify untrimmed skills still work)

## Phase 3: Measurement

### Using I10a Rig
- Main branch baseline
- +lean configuration
- +lean + this implementation
- Measure: first-request tokens, skill_listing char count
- Target: remove most of ~6k remaining tokens

## Phase 4: PR & Handoff

### PR Requirements
- Linked to H2 (01a0d3b2-5292) and H3 (01a0d3b2-5886) with `tm8 task link-pr`
- CI must pass
- Tests included
- When open: message orchestrator 01a0d6d3-9f64-70ff-8651-b243fabb9e11 with "PR READY #N"
- Do NOT merge yourself

## Waiting On
1. Clarification on dev node access
2. Access to Claude Code source repository
3. Probe results from separate dev node
