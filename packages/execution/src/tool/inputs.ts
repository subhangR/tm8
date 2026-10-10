import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CollabError, TOOL_RESERVED_ENV_NAMES, TOOL_RESERVED_ENV_PREFIXES, validateToolInputValue, type ToolJsonValue, type ToolView } from '@tm8/contract';

export interface ResolvedToolInputs {
  values: Record<string, ToolJsonValue>;
  env: Record<string, string>;
  secretEnvKeys: string[];
  secretValues: string[];
  credentialIds: string[];
}
export function withinPath(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
/** Both sides of confinement are canonical paths, including the caller's cwd. */
export async function confineToolPath(path: string, cwd: string, roots: readonly string[]): Promise<string> {
  let canonical: string;
  try { canonical = await realpath(resolve(cwd, path)); }
  catch { throw new CollabError('invalid_input', 'Tool path does not exist'); }
  const allowed = await Promise.all(roots.map(root => realpath(root).catch(() => null)));
  if (!allowed.some(root => root !== null && withinPath(canonical, root))) {
    throw new CollabError('forbidden', 'Tool path is outside the invoking session cwd and path grants');
  }
  return canonical;
}

/** Runtime values override config, which overrides the declaration's default. */
export async function resolveToolInputs(
  tool: ToolView, args: Record<string, ToolJsonValue>, passedSecrets: Record<string, string>,
  options: { cwd: string; roots: readonly string[]; readSecret: (inputName: string, credentialId: string) => Promise<string> },
): Promise<ResolvedToolInputs> {
  const declared = new Map(tool.definition.inputs.map(input => [input.name, input]));
  for (const name of Object.keys(args)) {
    const input = declared.get(name);
    if (!input) throw new CollabError('invalid_input', `Undeclared tool input: ${name}`);
    if (input.type === 'secret') throw new CollabError('invalid_input', `Literal secret refused for ${name}; use a secret prompt or --${input.flag ?? name.replaceAll('_', '-')}-from-env`);
  }
  for (const name of Object.keys(passedSecrets)) {
    if (declared.get(name)?.type !== 'secret') throw new CollabError('invalid_input', `Undeclared secret input: ${name}`);
  }
  const result: ResolvedToolInputs = { values: {}, env: {}, secretEnvKeys: [], secretValues: [], credentialIds: [] };
  const missing: string[] = [];
  for (const input of tool.definition.inputs) {
    const key = input.env ?? input.name.toUpperCase();
    if ((TOOL_RESERVED_ENV_NAMES as readonly string[]).includes(key.toUpperCase()) || TOOL_RESERVED_ENV_PREFIXES.some(prefix => key.toUpperCase().startsWith(prefix))) {
      throw new CollabError('invalid_input', `Reserved tool environment name: ${key}`);
    }
    let value: ToolJsonValue | undefined;
    if (input.type === 'secret') {
      const binding = tool.secretBindings.find(item => item.inputName === input.name);
      const passed = Object.hasOwn(passedSecrets, input.name) ? passedSecrets[input.name] : undefined;
      const secret = passed ?? (binding ? await options.readSecret(input.name, binding.credentialId) : undefined);
      if (secret !== undefined) {
        if (!secret || secret.includes('\0')) throw new CollabError('invalid_input', `Invalid secret input: ${input.name}`);
        result.values[input.name] = { secret: passed === undefined ? binding!.credentialId : 'passed' };
        result.env[key] = secret;
        result.secretEnvKeys.push(key); result.secretValues.push(secret);
        if (passed === undefined) result.credentialIds.push(binding!.credentialId);
      } else if (input.required) missing.push(input.name);
      continue;
    }
    value = Object.hasOwn(args, input.name) ? args[input.name]
      : Object.hasOwn(tool.config, input.name) ? tool.config[input.name] : input.default;
    if (value === undefined) { if (input.required) missing.push(input.name); continue; }
    if (!validateToolInputValue(input, value)) throw new CollabError('invalid_input', `Invalid tool input: ${input.name}`);
    if (input.type === 'path') value = await confineToolPath(value as string, options.cwd, [options.cwd, ...options.roots]);
    const encoded = input.type === 'json' ? JSON.stringify(value) : String(value);
    if (encoded.includes('\0')) throw new CollabError('invalid_input', `Invalid tool input: ${input.name}`);
    result.values[input.name] = value; result.env[key] = encoded;
  }
  if (missing.length) throw new CollabError('invalid_input', `Missing required tool inputs: ${missing.join(', ')}`);
  return result;
}
