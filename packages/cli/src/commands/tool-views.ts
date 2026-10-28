import type { ActorSummary, ToolRun, ToolView } from '@tm8/contract';

/**
 * Human views of the tool noun's pages. `--format json` always emits the DTO
 * these render from; a table here exists so a human or an agent reading a
 * terminal is not paid in context for every tool's full source.
 */

/** The newest run, as `tools.list` items carry it once the server projects one; older servers omit the field. */
export interface ToolLastRun { sessionId: string; state: string; exitCode: number | null; startedAt: string | null; exitedAt: string | null }
export type ToolListItem = ToolView & { lastRun?: ToolLastRun | null };
export interface ToolListPage { items: ToolListItem[]; nextCursor: string | null }
export interface ToolRunsPage { items: ToolRun[]; nextCursor: string | null }

/** Rows padded into aligned columns; the last cell of a row stays ragged. */
export const columns = (rows: readonly (readonly string[])[]): string => rows.map(row => row.map((cell, index) => index === row.length - 1 ? cell
  : cell.padEnd(Math.max(...rows.map(other => other[index]?.length ?? 0)))).join('  ').trimEnd()).join('\n');
export const who = (actor: ActorSummary | null | undefined): string => actor ? `${actor.displayName}${actor.isAgent ? ' (agent)' : ''}` : 'unknown';

/** Whole seconds between two instants as `4s`, `2m 05s` or `1h 02m`; empty until both are known. */
export function duration(startedAt: string | null, exitedAt: string | null): string {
  if (!startedAt || !exitedAt) return '';
  const seconds = Math.round((Date.parse(exitedAt) - Date.parse(startedAt)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`;
}
const outcome = (state: string, exitCode: number | null): string => exitCode === null ? state : `${state} ${exitCode}`;
const lastRun = (run: ToolLastRun | null | undefined): string =>
  run === undefined ? '' : run === null ? 'never' : `${outcome(run.state, run.exitCode)} ${run.startedAt ?? ''}`.trimEnd();

export function renderToolList(page: ToolListPage, words?: string): string {
  if (!page.items.length) return words === undefined
    ? 'no tools in this Space; create one with tm8 tool create, or tm8 tool starters install'
    : `no tools match ${JSON.stringify(words)} in this Space`;
  // The version shown is the execution version runs pin; the entity version is the concurrency token.
  const lines = [columns([['name', 'runtime', 'version', 'access', 'last-run'], ...page.items.map(tool =>
    [tool.definition.name, tool.definition.runtime, `v${tool.executionVersion}`, tool.definition.tm8Access, lastRun(tool.lastRun)])])];
  if (page.nextCursor) lines.push(`more: tm8 tool list${words === undefined ? '' : ` --words ${JSON.stringify(words)}`} --cursor ${page.nextCursor}`);
  return lines.join('\n');
}
export function renderToolRuns(page: ToolRunsPage, name: string): string {
  if (!page.items.length) return `${name}: no runs`;
  const lines = [columns([['id', 'version', 'status', 'exit', 'duration', 'invoker', 'started'], ...page.items.map(run =>
    [run.id, `v${run.toolVersion}`, run.state, run.exitCode === null ? '' : String(run.exitCode), duration(run.startedAt, run.exitedAt), who(run.invoker), run.startedAt ?? ''])])];
  if (page.nextCursor) lines.push(`more: tm8 tool runs ${name} --cursor ${page.nextCursor}`);
  return lines.join('\n');
}
