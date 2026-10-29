import { validateToolInputValue, type ToolInput, type ToolJsonValue, type ToolRun, type ToolView } from '@tm8/contract';
import type { PillTone } from '../kit/Pill';

export function initialValues(tool: ToolView): Record<string, string> {
  return Object.fromEntries(tool.definition.inputs.filter(input => input.type !== 'secret').map(input => {
    const value = Object.prototype.hasOwnProperty.call(tool.config, input.name) ? tool.config[input.name] : 'default' in input ? input.default : undefined;
    return [input.name, value === undefined ? '' : input.type === 'json' ? JSON.stringify(value) : String(value)];
  }));
}
export function parseValue(input: ToolInput, text: string): ToolJsonValue {
  let value: ToolJsonValue = text;
  if (input.type === 'int' || input.type === 'number') value = text.trim() ? Number(text) : NaN;
  if (input.type === 'bool') value = text === 'true' ? true : text === 'false' ? false : text;
  if (input.type === 'json') {
    try { value = JSON.parse(text) as ToolJsonValue; } catch { throw new Error(`${input.name}: enter valid JSON.`); }
  }
  if (!validateToolInputValue(input, value)) throw new Error(`${input.name}: enter a valid ${input.type} value${'min' in input && input.min !== undefined ? ` (minimum ${input.min})` : ''}${'max' in input && input.max !== undefined ? ` (maximum ${input.max})` : ''}.`);
  return value;
}
export function runValues(tool: ToolView, values: Record<string, string>, secrets: Record<string, string>) {
  const inputs: Record<string, ToolJsonValue> = {};
  for (const input of tool.definition.inputs) {
    if (input.type === 'secret') {
      if (input.required && !secrets[input.name] && !tool.secretBindings.some(binding => binding.inputName === input.name)) throw new Error(`${input.name}: set a secret or provide one for this run.`);
    } else if (values[input.name] !== '' && values[input.name] !== undefined) {
      inputs[input.name] = parseValue(input, values[input.name]!);
    } else if (input.required && !Object.prototype.hasOwnProperty.call(tool.config, input.name) && !('default' in input && input.default !== undefined)) {
      throw new Error(`${input.name}: a value is required.`);
    }
  }
  return { inputs, secrets: Object.fromEntries(Object.entries(secrets).filter(([, value]) => value !== '')) };
}
type RunOutcome = Pick<ToolRun, 'state' | 'exitCode'>;
export function runLabel(run: RunOutcome): string {
  switch (run.state) {
    case 'running': return 'Running';
    case 'exited': return run.exitCode === null ? 'Exited' : `Exited ${run.exitCode}`;
    case 'timed_out': return 'Timed out';
    case 'killed': return 'Killed';
  }
}
/** Running is in motion; anything but a clean exit 0 is a block. */
export function runTone(run: RunOutcome): PillTone {
  return run.state === 'running' ? 'run' : run.state !== 'exited' || run.exitCode !== 0 ? 'block' : 'idle';
}
/** '850ms', '12s', '3m 4s', '1h 2m': how long a run took, or has taken so far while it runs. */
export function runDuration(run: Pick<ToolRun, 'startedAt' | 'exitedAt'>, now: number = Date.now()): string {
  if (!run.startedAt) return '—';
  const end = run.exitedAt ? Date.parse(run.exitedAt) : now;
  const ms = Math.max(0, end - Date.parse(run.startedAt));
  if (Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
/**
 * Who started a run, for the audit column: a loop when a provenance-marked
 * `triggered_by` names one, an agent when the run is a child of an agent
 * session (or its invoker is an agent), otherwise the human by name.
 */
export function runInvoker(run: Pick<ToolRun, 'parentSessionId' | 'invoker' | 'triggeredBy'>): { kind: 'loop' | 'agent' | 'human'; label: string } {
  if (run.triggeredBy) return { kind: 'loop', label: run.triggeredBy.title ? `Loop · ${run.triggeredBy.title}` : 'Loop' };
  if (run.parentSessionId || run.invoker?.isAgent) return { kind: 'agent', label: run.invoker?.displayName ? `Agent · ${run.invoker.displayName}` : 'Agent' };
  return { kind: 'human', label: run.invoker?.displayName ?? 'Unknown' };
}
export const shortSha = (sha: string) => sha.slice(0, 8);
/** What a run of a tool with tm8 API access may do as the person running it. */
export function apiAccessNotice(access: 'read' | 'write'): string {
  return access === 'read'
    ? 'This tool can read tm8 as you while it runs. Its access ends when it exits.'
    : 'This tool can read and change tm8 as you while it runs. Its access ends when it exits.';
}
