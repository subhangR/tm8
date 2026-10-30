import { describe, expect, it } from 'vitest';
import { initialValues, parseValue, runDuration, runInvoker, runTone, runValues } from './values';
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

describe('run facts for the history table', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 9, 10, 12, 0, seconds)).toISOString();
  it('formats a run’s duration from its own timestamps, or from now while it runs', () => {
    expect(runDuration({ startedAt: at(0), exitedAt: '2026-10-10T12:00:00.850Z' })).toBe('850ms');
    expect(runDuration({ startedAt: at(0), exitedAt: at(12) })).toBe('12s');
    expect(runDuration({ startedAt: at(0), exitedAt: at(184) })).toBe('3m 4s');
    expect(runDuration({ startedAt: at(0), exitedAt: at(3720) })).toBe('1h 2m');
    expect(runDuration({ startedAt: at(0), exitedAt: null }, Date.parse(at(5)))).toBe('5s');
    expect(runDuration({ startedAt: null, exitedAt: null })).toBe('—');
  });
  it('labels the invoker as loop, agent or human in that order of evidence', () => {
    const ada = { id: 'a', kind: 'member' as const, displayName: 'Ada', isAgent: false };
    const bot = { ...ada, displayName: 'Scout', isAgent: true };
    expect(runInvoker({ parentSessionId: 'p', invoker: bot, triggeredBy: { id: 'l', title: 'Nightly' } })).toEqual({ kind: 'loop', label: 'Loop · Nightly' });
    expect(runInvoker({ parentSessionId: null, invoker: ada, triggeredBy: { id: 'l', title: null } })).toEqual({ kind: 'loop', label: 'Loop' });
    expect(runInvoker({ parentSessionId: 'p', invoker: ada, triggeredBy: null })).toEqual({ kind: 'agent', label: 'Agent · Ada' });
    expect(runInvoker({ parentSessionId: null, invoker: bot, triggeredBy: null })).toEqual({ kind: 'agent', label: 'Agent · Scout' });
    expect(runInvoker({ parentSessionId: 'p', invoker: null })).toEqual({ kind: 'agent', label: 'Agent' });
    expect(runInvoker({ parentSessionId: null, invoker: ada, triggeredBy: null })).toEqual({ kind: 'human', label: 'Ada' });
    expect(runInvoker({ parentSessionId: null, invoker: null })).toEqual({ kind: 'human', label: 'Unknown' });
  });
  it('tones only a clean exit as settled', () => {
    expect(runTone({ state: 'running', exitCode: null })).toBe('run');
    expect(runTone({ state: 'exited', exitCode: 0 })).toBe('idle');
    expect(runTone({ state: 'exited', exitCode: 2 })).toBe('block');
    expect(runTone({ state: 'timed_out', exitCode: null })).toBe('block');
    expect(runTone({ state: 'killed', exitCode: null })).toBe('block');
  });
});
