import { createHash } from 'node:crypto';
import { TOOL_STARTERS, toolStarterNamed, type ToolStarter, type ToolView } from '@tm8/contract';
import { CliError, EXIT_USAGE } from '../exit.js';

/** A tool of the starter's name already in the Space; it need not be the starter itself. */
export interface ExistingTool { toolId: string; version: number; matchesStarter: boolean }
export interface StarterListItem extends ToolStarter { existing: ExistingTool | null }
export type StarterInstallItem =
  | { name: string; status: 'created'; toolId: string; version: number; header: 'set' | 'failed' }
  | { name: string; status: 'skipped'; reason: 'exists'; toolId: string | null }
  | { name: string; status: 'failed'; error: { code: string; message: string } };

const known = (): string => TOOL_STARTERS.map(starter => starter.name).join(', ');
export function requireStarter(name: string): ToolStarter {
  const starter = toolStarterNamed(name);
  if (!starter) throw new CliError(`Unknown starter ${name}; choose from ${known()} (tm8 tool starters list)`, EXIT_USAGE);
  return starter;
}
/** `--only` names, repeatable or comma-separated; none selects every starter. */
export function selectStarters(only: readonly string[]): readonly ToolStarter[] {
  const names = only.flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  if (only.length && !names.length) throw new CliError(`--only expects a starter name: ${known()}`, EXIT_USAGE);
  const wanted = new Set(names.map(name => requireStarter(name).name));
  return wanted.size ? TOOL_STARTERS.filter(starter => wanted.has(starter.name)) : TOOL_STARTERS;
}
export const existingTool = (starter: ToolStarter, tool: ToolView | undefined): ExistingTool | null => tool ? {
  toolId: tool.id, version: tool.version,
  matchesStarter: tool.sourceSha256 === createHash('sha256').update(starter.source).digest('hex'),
} : null;

const columns = (rows: string[][]): string => rows.map(row => row.map((cell, index) => index === row.length - 1 ? cell
  : cell.padEnd(Math.max(...rows.map(other => other[index]!.length)))).join('  ').trimEnd()).join('\n');
export function renderStarters(list: { items: StarterListItem[] }): string {
  return [`${list.items.length} starter tools; install with: tm8 tool starters install [--only <name>...]`,
    columns(list.items.map(item => [item.name, item.runtime, item.existing
      ? `exists v${item.existing.version}${item.existing.matchesStarter ? '' : ' (other source)'}` : 'not installed', item.description]))].join('\n');
}
export function renderInstall(result: { items: StarterInstallItem[] }): string {
  const count = (status: StarterInstallItem['status']): number => result.items.filter(item => item.status === status).length;
  return [columns(result.items.map(item => item.status === 'created'
    ? ['created', item.name, `${item.toolId} v${item.version}${item.header === 'failed' ? ' (selection header not set)' : ''}`]
    : item.status === 'skipped' ? ['skipped', item.name, `already exists${item.toolId ? ` (${item.toolId})` : ''}`]
      : ['failed', item.name, `${item.error.code}: ${item.error.message}`])),
  `${count('created')} created, ${count('skipped')} skipped, ${count('failed')} failed`].join('\n');
}
