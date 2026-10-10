import { validateToolInputValue, type ToolInput, type ToolJsonValue, type ToolRun, type ToolView } from '@tm8/contract';

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
export function runLabel(run: ToolRun): string {
  switch (run.state) {
    case 'running': return 'Running';
    case 'exited': return run.exitCode === null ? 'Exited' : `Exited ${run.exitCode}`;
    case 'timed_out': return 'Timed out';
    case 'killed': return 'Killed';
  }
}
export const UI_ACCESS_REFUSAL = 'Tools with tm8 API access cannot be run from the UI in v1. Run this tool with the tm8 CLI in an agent session.';
