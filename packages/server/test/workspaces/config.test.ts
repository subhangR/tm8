import { describe, expect, it } from 'vitest';
import { loadWorkspaceConfiguration, publicOrigin } from '../../src/workspaces/config.js';

describe('workspace deployment configuration', () => {
  it('works standalone without a hosted-auth dependency', () => {
    const config = loadWorkspaceConfiguration({});
    expect(config.capabilities).toMatchObject({ distributedSystemFlag: false, authentication: 'local', maxUsersPerMachine: 10 });
    expect(config.controlOrigin).toBeUndefined();
  });
  it('refuses malformed flags and incomplete distributed nodes', () => {
    expect(() => loadWorkspaceConfiguration({ TM8_DISTRIBUTED_SYSTEM_FLAG: 'yes' })).toThrow();
    expect(() => loadWorkspaceConfiguration({ TM8_DISTRIBUTED_SYSTEM_FLAG: 'true' })).toThrow(/require/);
    expect(() => loadWorkspaceConfiguration({ TM8_MAX_USERS_PER_MACHINE: '0' })).toThrow();
  });
  it('never treats a deployment role as an authentication bypass', () => {
    expect(() => loadWorkspaceConfiguration({ TM8_SERVICE_ROLE: 'control' })).toThrow();
    expect(() => loadWorkspaceConfiguration({ TM8_DISTRIBUTED_SYSTEM_FLAG: 'true', TM8_SERVICE_ROLE: 'standalone' })).toThrow();
  });
  it('rejects redirect credentials, paths and unencrypted public origins', () => {
    for (const origin of ['https://user:secret@example.com', 'https://example.com/path', 'https://example.com/#x', 'http://example.com']) {
      expect(() => publicOrigin(origin, true)).toThrow();
    }
    expect(publicOrigin('http://127.0.0.1:4611', true)).toBe('http://127.0.0.1:4611');
    expect(() => publicOrigin('http://127.0.0.1:4611')).toThrow();
  });
});
