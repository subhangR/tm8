/**
 * `TOOL_STARTERS` (`src/tool-starters.ts`) against its single source of truth,
 * `examples/tools/<name>/`. Any edit to a starter's source, spec.json or
 * starter.json that is not regenerated into `src/tool-starters.data.ts` fails
 * here; so does a hand edit of the generated module.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_STARTERS, ToolDefinitionSchema, toolStarterDefinition, toolStarterNamed } from '../src/index.js';
import { DATA_MODULE, EXAMPLES_ROOT, readToolStarters, renderToolStarterData } from '../scripts/generate-tool-starters.mjs';

const REGENERATE = 'examples/tools changed without regenerating; run node packages/contract/scripts/generate-tool-starters.mjs';

describe('TOOL_STARTERS', () => {
  it('is exactly what examples/tools holds, byte for byte', () => {
    const fromFiles = readToolStarters();
    expect(fromFiles.length).toBeGreaterThan(0);
    expect(TOOL_STARTERS, REGENERATE).toEqual(fromFiles);
    expect(readFileSync(DATA_MODULE, 'utf8'), REGENERATE).toBe(renderToolStarterData(fromFiles));
  });

  it('includes every example directory, and the four the design names', () => {
    const dirs = readdirSync(EXAMPLES_ROOT).filter((name) => statSync(join(EXAMPLES_ROOT, name)).isDirectory()).sort();
    expect(TOOL_STARTERS.map((starter) => starter.name)).toEqual(dirs);
    expect(dirs).toEqual(expect.arrayContaining(['url-check', 'gh-pr-status', 'space-digest', 'slack-notify']));
  });

  it('reads the source of the runtime it declares', () => {
    for (const starter of TOOL_STARTERS) {
      const file = starter.runtime === 'bash' ? 'tool.sh' : 'tool.py';
      expect(starter.source).toBe(readFileSync(join(EXAMPLES_ROOT, starter.name, file), 'utf8'));
    }
  });

  it('gives every starter a valid definition and a selection header', () => {
    for (const starter of TOOL_STARTERS) {
      const definition = toolStarterDefinition(starter);
      expect(ToolDefinitionSchema.safeParse(definition).success, starter.name).toBe(true);
      expect(definition.name).toBe(starter.name);
      expect(starter.description.trim(), starter.name).not.toBe('');
      expect(starter.whenToUse, starter.name).toMatch(/^Open when /);
      expect(starter.summary.trim(), starter.name).not.toBe('');
    }
  });

  it('hands out definitions that share nothing with the module data', () => {
    const starter = toolStarterNamed('gh-pr-status')!;
    const definition = toolStarterDefinition(starter);
    definition.inputs[0]!.name = 'changed';
    expect(toolStarterNamed('gh-pr-status')!.spec.inputs[0]!.name).toBe('repo');
    expect(toolStarterNamed('no-such-starter')).toBeUndefined();
  });
});
