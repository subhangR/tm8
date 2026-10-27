import { describe, expect, it } from 'vitest';
import { parseValue, runValues, initialValues } from './values';
import { fixtureTool } from './fixture';

describe('typed run input validation', () => {
  it('checks integer bounds and safe integers, enum membership, JSON and explicit false', () => {
    expect(() => parseValue({ name: 'limit', type: 'int', min: 1, max: 200 }, '0')).toThrow('minimum 1');
    expect(() => parseValue({ name: 'limit', type: 'int' }, '1.5')).toThrow();
    expect(() => parseValue({ name: 'limit', type: 'int' }, '9007199254740992')).toThrow();
    expect(() => parseValue({ name: 'state', type: 'enum', options: ['open'] }, 'closed')).toThrow();
    expect(parseValue({ name: 'draft', type: 'bool' }, 'false')).toBe(false);
    expect(parseValue({ name: 'payload', type: 'json' }, '{"ok":false}')).toEqual({ ok: false });
  });
  it('does not lose zero, false, JSON null or a configured override of a declared default', () => {
    const tool = { ...fixtureTool, config: { verbose: false, limit: 0, state: 'closed' } };
    expect(initialValues(tool)).toMatchObject({ verbose: 'false', limit: '0', state: 'closed' });
    expect(parseValue({ name: 'payload', type: 'json' }, 'null')).toBeNull();
  });
  it('names all unconfigured required values and uses a bound secret when the override is blank', () => {
    const tool = structuredClone(fixtureTool); tool.config = {}; tool.definition.inputs.find(input => input.name === 'token')!.required = true;
    expect(() => runValues(tool, initialValues(tool), {})).toThrow('url: a value is required');
    tool.config.url = 'https://example.test'; tool.secretBindings.push({ inputName: 'token', credentialId: '00000000-0000-4000-8000-000000000003', keyHint: '…1234' });
    expect(runValues(tool, initialValues(tool), {})).toMatchObject({ secrets: {} });
  });
});
