import { describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { fixtureSummaries } from '../../fixtures';
import { renderBadge } from './tile-badges';

/** A tool summary: `state` is the projected view (definition, bindings, lastRun, versions). */
const row = (state: Record<string, unknown>): EntitySummary => ({ ...fixtureSummaries[0]!, kind: 'tool', state: { kind: 'tool', ...state } } as unknown as EntitySummary);
const definition = { name: 'url-check', runtime: 'bash', inputs: [{ name: 'url', type: 'string' }, { name: 'token', type: 'secret' }, { name: 'other', type: 'secret' }] };

describe('tool tile badges', () => {
  it('shows runtime, the inputs count, secrets bound over declared, and the execution version', () => {
    expect(renderBadge('toolRuntime', row({ definition }))).toEqual({ slot: 'meta', text: 'bash' });
    expect(renderBadge('toolInputs', row({ definition }))).toEqual({ slot: 'meta', text: '3 inputs' });
    expect(renderBadge('toolInputs', row({ definition: { ...definition, inputs: [definition.inputs[0]] } }))).toEqual({ slot: 'meta', text: '1 input' });
    expect(renderBadge('toolInputs', row({ definition: { ...definition, inputs: [] } }))).toBeNull();
    expect(renderBadge('toolSecrets', row({ definition, secretBindings: [{ inputName: 'token', credentialId: 'c' }] }))).toEqual({ slot: 'meta', text: '1/2 secrets set' });
    expect(renderBadge('toolSecrets', row({ definition }))).toEqual({ slot: 'meta', text: '0/2 secrets set' });
    expect(renderBadge('toolSecrets', row({ definition: { ...definition, inputs: [definition.inputs[0]] } }))).toBeNull();
    // The version a tile prints is the one runs pin, never the concurrency token.
    expect(renderBadge('toolVersion', row({ definition, version: 5, executionVersion: 3 }))).toEqual({ slot: 'meta', text: 'v3' });
    expect(renderBadge('toolVersion', row({ definition, version: 2 }))).toEqual({ slot: 'meta', text: 'v2' });
    expect(renderBadge('toolVersion', row({ definition }))).toBeNull();
  });
  it('draws the last run as the status and when it ran as meta, and nothing for a tool that never ran', () => {
    const lastRun = { sessionId: 's', state: 'exited', exitCode: 1, startedAt: '2026-10-28T10:00:00Z', exitedAt: new Date(Date.now() - 90_000).toISOString() };
    expect(renderBadge('toolLastRun', row({ definition, lastRun }))).toEqual({ slot: 'status', word: 'exited 1', tone: 'block', dot: 'solid' });
    expect(renderBadge('toolLastRun', row({ definition, lastRun: { ...lastRun, exitCode: 0 } }))).toEqual({ slot: 'status', word: 'exited 0', tone: 'idle', dot: 'solid' });
    expect(renderBadge('toolLastRun', row({ definition, lastRun: { ...lastRun, state: 'running', exitCode: null, exitedAt: null } }))).toEqual({ slot: 'status', word: 'running', tone: 'run', dot: 'solid' });
    const at = renderBadge('toolLastRunAt', row({ definition, lastRun }));
    expect(at?.slot).toBe('meta');
    expect((at as { text: string }).text).toMatch(/^ran /);
    expect(renderBadge('toolLastRun', row({ definition, lastRun: null }))).toBeNull();
    expect(renderBadge('toolLastRun', row({ definition }))).toBeNull();
    expect(renderBadge('toolLastRunAt', row({ definition }))).toBeNull();
  });
});
