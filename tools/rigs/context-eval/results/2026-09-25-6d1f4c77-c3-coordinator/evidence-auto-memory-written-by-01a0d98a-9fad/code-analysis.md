---
name: code-analysis
description: Analysis of Claude Code harness-surface.ts and manifest.ts for skillOverrides implementation
metadata:
  node_type: memory
  type: project
  originSessionId: 55bbe515-ccbe-497f-aec4-295747a705b5
  modified: 2026-09-25T17:12:30.384Z
---

# Code Analysis - Harness Skill Trimming

## Current Implementation

### laneSkillOverrides() - harness-surface.ts:69-71
```typescript
export function laneSkillOverrides(): Record<string, 'off'> {
  return Object.fromEntries(LANE_BUNDLED_SKILLS_OFF.map((name) => [name, 'off' as const]));
}
```
- Currently only returns bundled skills (claude-api, dataviz, etc.)
- Returns simple Record<string, 'off'>

### laneHarnessRecord() - harness-surface.ts:174-199
```typescript
export function laneHarnessRecord(
  launch: {...},
  plugins: HarnessPluginDecisions | null,
): {
  ...
  skillOverrides?: { off: { name: string; source: 'builtin-trim' }[] };
} {
  ...
  skillOverrides: {
    off: Object.keys(laneSkillOverrides()).map((name) => ({ name, source: 'builtin-trim' as const })),
  },
}
```
- Converts Record<string, 'off'> to array of objects with source
- Currently only supports 'off' mode with 'builtin-trim' source

### buildAgentCommand() - manifest.ts:894-991
```typescript
if (launch.harnessSurface !== 'inherit') {
    args.push('--strict-mcp-config', '--mcp-config', shellQuote(minimalMcpConfig(launch.mcpServers)));
    const plugins = pluginSettings(opts.installedClaudePlugins ?? [], [
      ...(launch.plugins ?? []),
      ...(opts.equippedClaudePlugins ?? []),
    ]);
    if (Object.keys(plugins).length > 0) settings.enabledPlugins = plugins;
    settings.skillOverrides = laneSkillOverrides();  // <-- CALLED HERE
  }
```
- Line 983 sets skillOverrides on settings
- Uses simple Record<string, 'off'> format for command line

## Data Structures Available

### effectiveSkills - from computeEffectiveSkills()
- `native`: skills loaded natively (from disk paths, directly callable)
- `indexed`: skills loaded via graph (non-native)
- `skipped`: skills excluded for various reasons

### pluginDecisions() - harness-surface.ts:128-143
```typescript
export function pluginDecisions(
  installed: readonly string[],
  lists: { launchPick: readonly string[] | null; persona: readonly string[]; effective: readonly string[] },
): HarnessPluginDecisions {
  const out: HarnessPluginDecisions = { allowed: [], denied: [] };
  // ...
  out.allowed.push({ id, source: PluginAllowSource }); // 'launch' | 'effective-skill' | 'persona'
  out.denied.push({ id, because: PluginDenyReason }); // 'launch-pick' | 'not-chosen'
}
```
- Already separates allowed vs denied plugins with reasons
- Perfect source for plugin-unselected trimming

### equippedClaudePlugins() - harness-surface.ts:150-161
- Returns plugin names for equipped skills
- Used to allowlist plugin skills

## Sources for Trimming

### 1. User Skills (user-unselected)
- Need: User skills from ~/.claude/skills not in effective skills
- Available: effectiveSkills.skipped with reason (if already computed)
- Challenge: Need to distinguish user-level skills from other levels

### 2. Plugin Skills (plugin-unselected)
- Need: Installed plugins not in allowlist (launch.plugins + effective skills)
- Available: pluginDecisions().denied array with reason 'not-chosen'
- Clean mapping: denied.because === 'not-chosen' → plugin-unselected

### 3. Native Skills (native-name-only)
- Need: Native skills to use 'name-only' mode instead of 'off'
- Current state: effectiveSkills.native contains native skills
- Challenge: Need to verify 'name-only' format works (requires probe)
- Prevents double-listing: native skill loaded via /name pointer vs tm8 index

### 4. Chrome Block (chrome)
- Current location: Unknown - need to find in harness prompt/config
- Task note: "~4.1k chars in every lane's harness system prompt"
- Not MCP config, so --strict-mcp-config doesn't handle it
- Need to find where it's injected and how to trim

## Signal Source for Implementation

### Manifest.ts Manifest Data
The manifest object contains everything needed:
- `launch.plugins`: launch pick for plugins
- `launch.mcpServers`: MCP config
- `optEffectiveSkills`: computed effective skills
- Context already has this data at build time

### Probe Requirements (BLOCKING)
Before implementing, must verify:
1. **skillOverrides['name-only']** format - does it work and what does it take?
2. **Chrome block removal** - which setting/flag, doesn't break operator's Chrome use
3. **Format verification** - exact structure for {'off'|'name-only'} entries with sources

## Two Call Sites (Important)
- **SpawnService.spawn()** - buildAgentCommand() called
- **SpawnService.resume()** - buildAgentCommand() called again
- Both must record same skillOverrides for consistency

## Next Steps
1. Probe: Verify skillOverrides format and Chrome setting (blocked on dev node)
2. Implement: Extend laneSkillOverrides() and laneHarnessRecord()
3. Integrate: Wire effective skills data into manifest.ts
4. Test & Measure: Verify token reduction and no regressions
