import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/http/config.js';
import { normalizeCommandInputForIdempotencyMode } from '../src/http/idempotency.js';

const command = {
  name: 'entities.create', method: 'POST', path: '/v2/entities', kind: 'command', status: 'v1',
} as const;

const read = {
  name: 'entities.get', method: 'GET', path: '/v2/entities/:id', kind: 'read', status: 'v1',
} as const;

describe('idempotency test mode', () => {
  it('is strict by default and only disables for an explicit false value', () => {
    expect(loadConfig({}).idempotencyEnabled).toBe(true);
    expect(loadConfig({ TM8_IDEMPOTENCY_ENABLED: 'off' }).idempotencyEnabled).toBe(false);
    expect(() => loadConfig({ TM8_IDEMPOTENCY_ENABLED: 'maybe' })).toThrow(ConfigError);
  });

  it('leaves every request untouched while strict idempotency is enabled', () => {
    const body = { title: 'keep', clientMutationId: 'caller-id' };
    expect(normalizeCommandInputForIdempotencyMode(command, body, true)).toBe(body);
  });

  it('gives every command a fresh id while idempotency is disabled', () => {
    const first = normalizeCommandInputForIdempotencyMode(
      command,
      { clientMutationId: 'reused' },
      false,
    ) as { clientMutationId: string };
    const second = normalizeCommandInputForIdempotencyMode(
      command,
      { clientMutationId: 'reused' },
      false,
    ) as { clientMutationId: string };

    expect(first.clientMutationId).not.toBe('reused');
    expect(second.clientMutationId).not.toBe('reused');
    expect(first.clientMutationId).not.toBe(second.clientMutationId);
  });

  it('supplies a mutation id for a command body omitted by the client', () => {
    expect(normalizeCommandInputForIdempotencyMode(command, undefined, false)).toMatchObject({
      clientMutationId: expect.any(String),
    });
  });

  it('does not modify reads or malformed non-object command bodies', () => {
    expect(normalizeCommandInputForIdempotencyMode(read, undefined, false)).toBeUndefined();
    expect(normalizeCommandInputForIdempotencyMode(command, 'not-an-object', false)).toBe('not-an-object');
  });
});
