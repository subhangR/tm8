import { describe, expect, it } from 'vitest';
import { HarnessRegistry, HarnessRuntimeError, type HarnessAdapter, type HarnessCapabilities } from '../src/runtime/index.js';

const caps: HarnessCapabilities = {
  schemaVersion: 1, harness: 'codex', binaryVersion: '0.161.0', protocolRevision: 'v2-0.161.0',
  nativeResume: 'supported', portableBootstrap: 'supported', cancelActiveTurn: 'supported',
  nativeTurnIds: 'supported', usage: 'supported', contextReading: 'supported',
  interactiveRequests: 'unsupported', textInputs: 'supported', imageInputs: 'unknown',
  fileInputs: 'unsupported', builtInToolRestriction: 'unknown',
  configuration: { model: 'per_turn', reasoningEffort: 'per_turn', serviceTier: 'per_turn', instructions: 'restart', tools: 'restart', credential: 'restart' },
};
const adapter: HarnessAdapter = { kind: 'codex', capabilities: async () => caps, open: async () => { throw new Error('not called'); } };
const target = { harness: 'codex' as const, model: 'backend-model', provider: 'groq', reasoningEffort: 'high', serviceTier: null };

describe('HarnessRegistry', () => {
  it('admits the resolved harness without inferring it from model/provider names', async () => {
    expect(await new HarnessRegistry([adapter]).admit(target, ['nativeResume'])).toBe(caps);
  });
  it('refuses unknown and unsupported required features before opening/materializing', async () => {
    const registry = new HarnessRegistry([adapter]);
    await expect(registry.admit(target, ['imageInputs'])).rejects.toBeInstanceOf(HarnessRuntimeError);
    await expect(registry.admit(target, ['interactiveRequests'])).rejects.toBeInstanceOf(HarnessRuntimeError);
    expect(() => registry.get('claude')).toThrow('unavailable');
  });
  it('refuses duplicate registration and unsupported effort configuration', async () => {
    expect(() => new HarnessRegistry([adapter, adapter])).toThrow('Duplicate');
    const noEffort = { ...adapter, capabilities: async () => ({ ...caps, configuration: { ...caps.configuration, reasoningEffort: 'unknown' as const } }) };
    await expect(new HarnessRegistry([noEffort]).admit(target)).rejects.toThrow('reasoningEffort');
  });
});
