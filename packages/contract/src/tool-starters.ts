import type { ToolDefinition, ToolInput } from './tools.js';
import { TOOL_STARTER_DATA } from './tool-starters.data.js';

/** `examples/tools/<name>/spec.json`: exactly what `tm8 tool create --spec` accepts. */
export interface ToolStarterSpec {
  inputs: ToolInput[];
  help: string;
  tm8Access: ToolDefinition['tm8Access'];
  timeoutSeconds: number;
}

/**
 * A starter tool from `examples/tools/<name>/`, shipped as data so the UI's
 * "Start from a starter" and the CLI read one set without a repository
 * checkout. The example files stay the single source of truth;
 * `scripts/generate-tool-starters.mjs` regenerates `tool-starters.data.ts`
 * and `test/tool-starters.test.ts` fails on any drift.
 */
export interface ToolStarter {
  /** The tool name, and the starter's directory. */
  name: string;
  /** `tool.sh` is bash, `tool.py` is python. */
  runtime: ToolDefinition['runtime'];
  description: string;
  /** The source file, byte for byte. */
  source: string;
  spec: ToolStarterSpec;
  /** Selection header text, set with `entities.header.set` after `tools.create`. */
  whenToUse: string;
  summary: string;
}

/** Every starter tool, sorted by name. */
export const TOOL_STARTERS: readonly ToolStarter[] = TOOL_STARTER_DATA;

export function toolStarterNamed(name: string): ToolStarter | undefined {
  return TOOL_STARTERS.find((starter) => starter.name === name);
}

/** The starter as a complete definition for `tools.create`, sharing nothing with the module's data. */
export function toolStarterDefinition(starter: ToolStarter): ToolDefinition {
  const { inputs, help, tm8Access, timeoutSeconds } = starter.spec;
  return {
    name: starter.name,
    description: starter.description,
    runtime: starter.runtime,
    source: starter.source,
    inputs: JSON.parse(JSON.stringify(inputs)) as ToolInput[],
    help,
    tm8Access,
    timeoutSeconds,
  };
}
