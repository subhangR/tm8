---
name: probe-results
description: Probe results and format specifications for skillOverrides implementation
metadata:
  node_type: memory
  type: project
  originSessionId: 55bbe515-ccbe-497f-aec4-295747a705b5
  modified: 2026-09-25T17:14:38.174Z
---

# Probe Results

## Discovery Date
2026-09-25 (from manifest analysis)

## Key Findings

### 1. skillOverrides Format (VERIFIED)

#### Command-Line Format (--settings)
```json
{
  "skillOverrides": {
    "skill-name-1": "off",
    "skill-name-2": "off",
    ...
  }
}
```

#### Manifest Record Format (audit)
```json
{
  "skillOverrides": {
    "off": [
      {
        "name": "skill-name",
        "source": "builtin-trim"  // Will be: builtin-trim|user-unselected|plugin-unselected
      }
    ]
  }
}
```

#### Modes Observed
- `"off"` - skill is disabled entirely
- (To be verified: `"name-only"` - skill loads via name pointer but not listed)

### 2. Chrome Block Removal (DISCOVERED)

#### Flag: --no-chrome
- **Location**: Command-line argument in buildAgentCommand output
- **Status**: Already in use in manifest
- **Effect**: Removes Claude in Chrome block (~4.1k chars) from system prompt
- **Safety**: No impact on operator's own Chrome extension (different context)

#### Current Command in Manifest
```
claude --dangerously-skip-permissions --model ... --no-chrome --settings '...'
```

### 3. Current Trimmed Skills (from manifest)

All set to 'off' with source 'builtin-trim':
- claude-api
- dataviz  
- fewer-permission-prompts
- init
- keybindings-help
- loop
- run
- schedule
- update-config
- (Plus many others: accessibility-a11y, astro, built-in-browser, chrome-browser, etc.)

Plus many skills set to 'off' that should be reviewed for source categorization.

## Implementation Status

### Ready to Implement
- ✅ skillOverrides format (manifest + command-line)
- ✅ Chrome block handling (--no-chrome flag)
- ✅ Manifest structure

### Remaining Probe Item (Lower Priority)
- ⏳ Confirm 'name-only' mode works
  - Likely works based on task requirements
  - Can proceed speculatively and test
  - H3 task specifically mentions this

## Next Implementation Steps

1. **Add --no-chrome flag** to buildAgentCommand() when minimal surface
2. **Extend laneSkillOverrides()** to include:
   - User skills not in effective set (source: 'user-unselected')
   - Plugin skills not selected (source: 'plugin-unselected')  
   - Native skills (source: 'native-name-only') with mode 'name-only' [conditional]
3. **Extend laneHarnessRecord()** to build audit record with all sources
4. **Update both call sites** (spawn and resume) in SpawnService
5. **Add tests** for all trimming sources
6. **Measure** token reduction before/after

## Format Specifications

### Manifest Structure (laneHarnessRecord return)
```typescript
{
  surface: 'minimal',
  surfaceSource: 'default',
  plugins?: HarnessPluginDecisions,
  mcpServers?: { name: string; source: 'persona' }[],
  skillOverrides?: {
    off?: { name: string; source: SkillOverrideSource }[],
    'name-only'?: { name: string; source: SkillOverrideSource }[]  // NEW
  }
}
```

### Command Line Format (buildAgentCommand)
```
claude --dangerously-skip-permissions --model ... --no-chrome --settings '{"skillOverrides":{"skill":"off",...},"enabledPlugins":{...}}'
```

## Sources for Trimming

| Source | Type | Determination |
|--------|------|----------------|
| builtin-trim | Skill | Hardcoded LANE_BUNDLED_SKILLS_OFF list |
| user-unselected | Skill | User skill NOT in effectiveSkills.native |
| plugin-unselected | Skill | Plugin skill of denied plugin |
| native-name-only | Skill | Native skill in effectiveSkills.native [conditional] |
| chrome | Config | Always trim when minimal surface |

## Verified Sources
- ✅ builtin-trim (current implementation)
- ✅ chrome (--no-chrome flag exists)
- ⚠️  user-unselected (will implement based on effective skills)
- ⚠️  plugin-unselected (will implement based on plugin decisions)
- ⏳ native-name-only (probe pending, likely works)
