import { describe, expect, it } from 'vitest';
import { ToolDefinitionSchema, ToolInputSchema, ToolRunInputSchema, ToolSecretBindInputSchema, validateToolInputValue } from '../src/tools.js';
import { CoreEntityKindSchema, EntityStateSchema, ServerOnlyCredentialProviderNameSchema, SpaceCredentialProviderNameSchema, WorkSessionKindSchema } from '../src/schemas.js';
const definition = { name: 'url-check', description: 'Check URLs', help: '', runtime: 'bash',
  source: 'curl "$URL"', inputs: [{ name: 'url', type: 'string', required: true }], tm8Access: 'none', timeoutSeconds: 900 };
describe('stored tool interface', () => {
  it('admits the tool kind and both terminal session kinds', () => {
    expect(CoreEntityKindSchema.parse('tool')).toBe('tool');
    expect(EntityStateSchema.safeParse({ kind: 'tool', definition }).success).toBe(true);
    for (const kind of ['tool', 'container_exec']) expect(WorkSessionKindSchema.parse(kind)).toBe(kind);
    expect(ServerOnlyCredentialProviderNameSchema.parse('tool')).toBe('tool');
    expect(SpaceCredentialProviderNameSchema.safeParse('tool').success).toBe(false);
  });
  it('rejects literal secret defaults and undeclared fields', () => {
    for (const input of [{ name: 'token', type: 'secret', default: 'secret' },
      { name: 'url', type: 'string', command: 'bash' }, { name: 'token', type: 'secret', value: 'secret' }]) {
      expect(ToolInputSchema.safeParse(input).success).toBe(false);
    }
    expect(ToolDefinitionSchema.safeParse({ ...definition, command: 'bash' }).success).toBe(false);
    expect(ToolRunInputSchema.safeParse({ toolId: crypto.randomUUID(), clientMutationId: 'run', source: 'code' }).success).toBe(false);
  });
  it('rejects reserved and ambiguous environment and flag mappings', () => {
    for (const inputs of [[{ name: 'tm8_token', type: 'string' }], [{ name: 'value', type: 'string', env: 'TM8_AGENT_TOKEN' }],
      [{ name: 'one', type: 'string', env: 'TOKEN' }, { name: 'two', type: 'string', env: 'TOKEN' }],
      [{ name: 'draft', type: 'bool' }, { name: 'no_draft', type: 'string' }],
      [{ name: 'token', type: 'secret' }, { name: 'token_from_env', type: 'string' }],
      [{ name: 'help', type: 'bool' }]]) expect(ToolDefinitionSchema.safeParse({ ...definition, inputs }).success).toBe(false);
  });
  it('refuses inputs that overwrite runtime control variables', () => {
    for (const env of ['PATH', 'HOME', 'SHELL', 'BASH_ENV', 'IFS', 'LD_PRELOAD', 'PYTHONPATH', 'USER', 'PROMPT_COMMAND', 'PWD', 'OLDPWD', 'LC_ALL']) {
      expect(ToolDefinitionSchema.safeParse({ ...definition, inputs: [{ name: 'value', type: 'string', env }] }).success).toBe(false);
      expect(ToolDefinitionSchema.safeParse({ ...definition, inputs: [{ name: env.toLowerCase(), type: 'string' }] }).success).toBe(false);
    }
  });
  it('enforces numeric and enum defaults and values', () => {
    for (const input of [{ name: 'limit', type: 'int', min: 5, max: 2 }, { name: 'limit', type: 'int', min: 2, default: 1 },
      { name: 'state', type: 'enum', options: ['open'], default: 'closed' },
      { name: 'state', type: 'enum', options: ['open', 'open'] }]) expect(ToolInputSchema.safeParse(input).success).toBe(false);
    const input = ToolInputSchema.parse({ name: 'limit', type: 'int', min: 1, max: 200 });
    for (const value of [0, 201, 1.1, '20', Infinity]) expect(validateToolInputValue(input, value)).toBe(false);
    expect(validateToolInputValue(input, 20)).toBe(true);
  });
  it('measures source bytes and bounds the number of declared inputs', () => {
    expect(ToolDefinitionSchema.safeParse({ ...definition, source: 'é'.repeat(131073) }).success).toBe(false);
    expect(ToolDefinitionSchema.safeParse({ ...definition, inputs: Array.from({ length: 65 }, (_, i) => ({ name: `value_${i}`, type: 'string' })) }).success).toBe(false);
  });
  it('binds a credential reference or receives a new secret with exactly one form', () => {
    const request = { toolId: crypto.randomUUID(), expectedVersion: 1, inputName: 'token', clientMutationId: 'bind' };
    const credentialId = crypto.randomUUID();
    expect(ToolSecretBindInputSchema.safeParse({ ...request, credentialId }).success).toBe(true);
    expect(ToolSecretBindInputSchema.safeParse({ ...request, value: 'from-stdin', label: 'Account' }).success).toBe(true);
    for (const fields of [{}, { credentialId, value: 'ambiguous' }, { value: '' }]) {
      expect(ToolSecretBindInputSchema.safeParse({ ...request, ...fields }).success).toBe(false);
    }
  });
  it('defaults CLI and agent launches to closing the PTY and preserves a UI override', () => {
    const request = { toolId: crypto.randomUUID(), clientMutationId: 'run' };
    expect(ToolRunInputSchema.parse(request).keepOpen).toBe(false);
    expect(ToolRunInputSchema.parse({ ...request, keepOpen: true }).keepOpen).toBe(true);
  });
});
