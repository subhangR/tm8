---
name: implementation-skeleton
description: Implementation skeleton for harness skill trimming (after probe)
metadata:
  node_type: memory
  type: project
  originSessionId: 55bbe515-ccbe-497f-aec4-295747a705b5
  modified: 2026-09-25T17:13:10.096Z
---

# Implementation Skeleton

## Phase 1: After Probe - Implementation Steps

### Step 1: Extend harness-surface.ts

#### New Types
```typescript
export type SkillOverrideMode = 'off' | 'name-only';
export type SkillOverrideSource = 
  | 'builtin-trim'           // Current: bundled skills
  | 'user-unselected'        // New: user skills not in effective
  | 'plugin-unselected'      // New: plugin skills not selected
  | 'native-name-only'       // New: native skills (double-listing)
  | 'chrome'                 // New: Chrome block

// Audit structure (for manifest)
export interface SkillOverrideRecord {
  name: string;
  source: SkillOverrideSource;
}

export interface HarnessSkillOverrides {
  off?: SkillOverrideRecord[];
  'name-only'?: SkillOverrideRecord[];
}
```

#### Function: Extended laneSkillOverrides()
```typescript
export function laneSkillOverrides(
  config: {
    effectiveSkillNames?: readonly string[];    // Names of effective native skills
    installedUserSkills?: readonly string[];    // All user skills from ~/.claude/skills
    deniedPlugins?: readonly string[];          // Plugins explicitly denied
    equippedPluginNames?: readonly string[];    // Plugin names with equipped skills
  } = {}
): Record<string, 'off' | 'name-only'> {
  const out: Record<string, 'off' | 'name-only'> = {};
  
  // 1. Bundled skills (existing)
  for (const name of LANE_BUNDLED_SKILLS_OFF) {
    out[name] = 'off';
  }
  
  // 2. User skills not in effective set
  const effectiveSet = new Set(config.effectiveSkillNames ?? []);
  for (const skill of config.installedUserSkills ?? []) {
    if (!effectiveSet.has(skill)) {
      out[skill] = 'off';
    }
  }
  
  // 3. [PROBE] Native skills to 'name-only' (if probe shows it works)
  for (const skill of config.effectiveSkillNames ?? []) {
    // Only if it's a native skill AND 'name-only' works
    // out[skill] = 'name-only';  // Conditional on probe result
  }
  
  return out;
}
```

#### Function: Extended laneHarnessRecord()
```typescript
export function laneHarnessRecord(
  launch: {...},
  plugins: HarnessPluginDecisions | null,
  config?: {  // New optional config
    effectiveSkillNames?: readonly string[];
    installedUserSkills?: readonly string[];
    deniedPlugins?: readonly string[];
  }
): {
  ...
  skillOverrides?: {
    off?: SkillOverrideRecord[];
    'name-only'?: SkillOverrideRecord[];
  };
} {
  const surface = launch.harnessSurface ?? 'minimal';
  const surfaceSource = launch.harnessSurfaceSource ?? 'default';
  if (surface === 'inherit') return { surface, surfaceSource };
  
  // Build audit record with all sources
  const overridesDict = laneSkillOverrides(config);
  const overridesRecord: HarnessSkillOverrides = {
    off: [],
    ...(/* if name-only supported */ { 'name-only': [] })
  };
  
  for (const [name, mode] of Object.entries(overridesDict)) {
    const source = determineSource(name);  // Map skill name to source
    if (mode === 'off') {
      overridesRecord.off!.push({ name, source });
    } else if (mode === 'name-only') {
      overridesRecord['name-only']!.push({ name, source });
    }
  }
  
  return {
    surface,
    surfaceSource,
    ...(plugins ? { plugins } : {}),
    mcpServers: [...],
    skillOverrides: overridesRecord,
  };
}
```

### Step 2: Update manifest.ts buildAgentCommand()

```typescript
export function buildAgentCommand(
  launch: ResolvedLaunchConfig,
  env: NodeJS.ProcessEnv = process.env,
  opts: {
    ...
    effectiveSkillNames?: readonly string[];     // NEW
    installedUserSkills?: readonly string[];     // NEW
  } = {},
): string {
  ...
  if (launch.harnessSurface !== 'inherit') {
    args.push('--strict-mcp-config', '--mcp-config', ...);
    const plugins = pluginSettings(...);
    if (Object.keys(plugins).length > 0) settings.enabledPlugins = plugins;
    
    // CHANGED: Pass config to laneSkillOverrides
    settings.skillOverrides = laneSkillOverrides({
      effectiveSkillNames: opts.effectiveSkillNames,
      installedUserSkills: opts.installedUserSkills,
      deniedPlugins: Object.keys(plugins).filter(p => !plugins[p]),
    });
  }
  ...
}
```

### Step 3: Add Chrome Block Trimming

Location: Unknown - need probe results to find where Chrome block is injected

Likely candidate:
- In harness prompt construction
- In system message building
- As a separate setting/flag

Need to:
1. Identify exact location
2. Add conditional trimming when minimal surface
3. Verify it doesn't break operator's Chrome use

## Calls to Update

Two call sites in SpawnService must be updated:
1. **spawn()** - creates new session
2. **resume()** - resumes existing session

Both must build same skillOverrides for consistency.

## Test Structure

### Unit Tests (manifest.test.ts / harness-surface.test.ts)
- Test laneSkillOverrides() with various config inputs
- Test source mapping for each skill
- Test laneHarnessRecord() audit record generation
- Test command line includes correct overrides
- Test 'name-only' mode (after probe confirms it works)

### Negative Control
- Verify non-trimmed skills still work when harnessSurface='inherit'
- Verify keepers (code-review, simplify, etc) are never trimmed
- Verify effective native skills are included appropriately

## Token Reduction Target
- Current: ~33.4k tokens on +lean (i10a measurement)
- Remaining: ~20k from skill_listing + 4.1k from Chrome block
- Target: Remove most of remaining 6k tokens

## Probe Results Needed

### 1. skillOverrides='name-only' Format
- Command: `claude --settings '{"skillOverrides":{"skill-name":"name-only"}}'`
- Test: Verify skill is accessible and works correctly
- Expected: Skill loads but doesn't appear in skill listing

### 2. Chrome Block Setting
- Location: Where in code is it injected?
- Flag/setting: How to remove it without breaking operator use?
- Test: Verify operator can still use Claude in Chrome
- Expected: Block removed from lane, operator unaffected

### 3. Before/After Metrics
- For each trim configuration, measure:
  - `claude --settings '{"skillOverrides":...}'` system prompt token count
  - Skill listing char count
  - First request token count
  - Total for first few requests

## Post-Probe Actions
1. Update this plan with probe results
2. Implement code changes
3. Add tests
4. Run measurements
5. Create PR
6. Link to H2 and H3 tasks
