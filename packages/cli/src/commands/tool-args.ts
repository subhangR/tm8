import { validateToolInputValue, type ToolInput, type ToolJsonValue } from '@tm8/contract';
import { CliError, EXIT_USAGE } from '../exit.js';

export type HelpInput = ToolInput & { configured?: boolean; configuredValue?: ToolJsonValue };
export interface ToolHelp {
  toolId: string; version: number; name: string; description: string; help: string;
  inputs: HelpInput[];
}
const usage = (message: string): never => { throw new CliError(message, EXIT_USAGE); };
export const inputFlag = (input: ToolInput): string => input.flag ?? input.name.replaceAll('_', '-');

export function refuseLiteralToolSecrets(inputs: readonly ToolInput[], argv: readonly string[]): void {
  const flags = new Map<string, ToolInput>();
  for (const input of inputs) if (input.type === 'secret') {
    flags.set(`--${inputFlag(input)}`, input);
    if (input.short) flags.set(`-${input.short}`, input);
  }
  for (const token of argv) {
    const input = flags.get(token.split('=', 1)[0]!);
    if (input) usage(`Secret ${input.name} cannot be passed on argv; use --${inputFlag(input)}-from-env <VAR> or a TTY prompt`);
  }
}

/** Convert a flag/config value without putting the caller's value in a diagnostic. */
export function parseToolValue(input: ToolInput, raw: string): ToolJsonValue {
  let value: ToolJsonValue = raw;
  switch (input.type) {
    case 'secret': return usage(`Secret ${input.name} cannot be passed on argv; use --${inputFlag(input)}-from-env <VAR> or a TTY prompt`);
    case 'int': case 'number':
      if (!raw.trim()) return usage(`${input.name} expects ${input.type}`);
      value = Number(raw); break;
    case 'bool':
      if (raw !== 'true' && raw !== 'false') return usage(`${input.name} expects true or false`);
      value = raw === 'true'; break;
    case 'json':
      try { value = JSON.parse(raw) as ToolJsonValue; }
      catch { return usage(`${input.name} expects valid JSON`); }
      break;
  }
  if (!validateToolInputValue(input, value)) return usage(`Invalid ${input.type} value for ${input.name}${input.type === 'enum' ? `; choose ${input.options.join('|')}` : ''}`);
  return value;
}

/** The dynamic grammar starts AFTER the name, so global names are ordinary inputs here. */
export function parseToolArgs(inputs: readonly HelpInput[], argv: readonly string[], env: NodeJS.ProcessEnv = process.env): {
  inputs: Record<string, ToolJsonValue>; secrets: Record<string, string>;
} {
  refuseLiteralToolSecrets(inputs, argv);
  const values: Record<string, ToolJsonValue> = Object.create(null);
  const secrets: Record<string, string> = Object.create(null);
  const flags = new Map<string, { input: HelpInput; negative?: boolean; fromEnv?: boolean }>();
  for (const input of inputs) {
    const flag = inputFlag(input);
    flags.set(`--${flag}`, { input });
    if (input.short) flags.set(`-${input.short}`, { input });
    if (input.type === 'bool') flags.set(`--no-${flag}`, { input, negative: true });
    if (input.type === 'secret') flags.set(`--${flag}-from-env`, { input, fromEnv: true });
  }
  const seen = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === '--' && index === argv.length - 1) break;
    const eq = token.indexOf('=');
    const key = eq < 0 ? token : token.slice(0, eq);
    const match = flags.get(key);
    if (!match) return usage('Unknown tool argument; use `tm8 tool run <name> --help` for its declared flags');
    const { input } = match;
    if (input.type === 'secret' && !match.fromEnv) return usage(`Secret ${input.name} cannot be passed on argv; use --${inputFlag(input)}-from-env <VAR> or a TTY prompt`);
    if (seen.has(input.name)) return usage(`Input ${input.name} may be given only once`);
    seen.add(input.name);
    if (input.type === 'bool') {
      if (eq >= 0) return usage(`${key} is a switch; use --${inputFlag(input)} or --no-${inputFlag(input)}`);
      values[input.name] = !match.negative;
      continue;
    }
    const raw = eq < 0 ? argv[++index] : token.slice(eq + 1);
    if (raw === undefined || (eq < 0 && /^--?[A-Za-z]/.test(raw))) return usage(`${key} requires a value`);
    if (match.fromEnv) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) return usage(`${key} expects an environment variable name`);
      const secret = env[raw];
      if (!secret || secret.length > 4096) return usage(`Environment variable for secret ${input.name} is missing, empty, or exceeds 4096 characters`);
      secrets[input.name] = secret;
    } else values[input.name] = parseToolValue(input, raw);
  }
  const missing = inputs.filter(input => input.type !== 'secret' && input.required
    && !Object.hasOwn(values, input.name) && !input.configured && !Object.hasOwn(input, 'default'));
  if (missing.length) return usage(`Missing required inputs: ${missing.map(input => input.name).join(', ')}`);
  return { inputs: values, secrets };
}

export function renderToolHelp(help: ToolHelp): string {
  return [`tm8 tool run [--detach] [--keep-open] [--cwd <dir>] ${help.name} [tool arguments]`,
    help.description, '', 'Inputs:', ...help.inputs.map(input => {
      const flag = inputFlag(input);
      const spelling = input.type === 'secret' ? `--${flag}-from-env <VAR>`
        : input.type === 'bool' ? `--${flag} / --no-${flag}` : `--${flag} <${input.type}>`;
      const metadata = [input.type, input.required ? 'required' : 'optional',
        ...(input.type === 'enum' ? [`choices: ${input.options.join('|')}`] : []),
        ...('default' in input ? [`default: ${JSON.stringify(input.default)}`] : []),
        ...(input.configured ? ['configured'] : [])].join(', ');
      return `  ${spelling}${input.short && input.type !== 'secret' ? `, -${input.short}` : ''} (${metadata})${input.description ? ` — ${input.description}` : ''}`;
    }), '', help.help].join('\n');
}
