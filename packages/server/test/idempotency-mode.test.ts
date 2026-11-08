import { describe, expect, it } from 'vitest';

import {
  AuthLoginInputSchema,
  AuthLogoutInputSchema,
  AuthSignupInputSchema,
  OPERATIONS,
  type OperationBinding,
} from '@tm8/contract';

import { ConfigError, loadConfig } from '../src/http/config.js';
import { normalizeCommandInputForIdempotencyMode } from '../src/http/idempotency.js';
import { INPUT_SCHEMAS } from '../src/facade/input-schemas.js';

const command = {
  name: 'entities.create', method: 'POST', path: '/v2/entities', kind: 'command', status: 'v1',
} as const;

const read = {
  name: 'entities.get', method: 'GET', path: '/v2/entities/:id', kind: 'read', status: 'v1',
} as const;

const binding = (name: string): OperationBinding => {
  const op = (OPERATIONS as readonly OperationBinding[]).find((o) => o.name === name);
  if (!op) throw new Error(`no such operation: ${name}`);
  return op;
};

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

  /**
   * THE ONE THAT SHIPPED THE BUG. The assertion is made against the REAL strict
   * DTO rather than against a hand-written expectation of what the normalizer
   * produces, because the defect was precisely a disagreement between the two:
   * the injector supplied `clientMutationId` to schemas that `.strict()`ly
   * forbid it, so with the ledger disabled — the DEFAULT — every signup, login
   * and logout answered `invalid_input: Unrecognized key(s)` and no account
   * could be created or used on any such server.
   */
  it.each([
    ['auth.signup', AuthSignupInputSchema, { username: 'someone', password: 'a-long-enough-password' }],
    ['auth.login', AuthLoginInputSchema, { username: 'someone', password: 'a-long-enough-password' }],
    ['auth.logout', AuthLogoutInputSchema, {}],
  ] as const)('leaves %s parseable by its own strict schema', (name, schema, body) => {
    const normalized = normalizeCommandInputForIdempotencyMode(binding(name), body, false);
    const parsed = schema.safeParse(normalized);
    expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
  });

  it('gives every other command a fresh id while idempotency is disabled', () => {
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

describe('idempotency test mode never injects a key a strict DTO refuses', () => {
  it('leaves mcp.proxy.request alone, so a connector call from a chat or session validates', () => {
    const op = binding('mcp.proxy.request');
    const body = { sessionId: '00000000-0000-4000-8000-000000000001', serverId: '00000000-0000-4000-8000-000000000002',
      message: { jsonrpc: '2.0', id: 1, method: 'tools/list' } };
    const normalized = normalizeCommandInputForIdempotencyMode(op, body, false, INPUT_SCHEMAS['mcp.proxy.request']);
    expect(normalized).toEqual(body);
    expect(INPUT_SCHEMAS['mcp.proxy.request']!.safeParse(normalized).success).toBe(true);
  });

  it('holds for every mounted command: an injected id is never the reason a body fails', () => {
    // Was 9 commands (mcp.proxy.request, chat.interrupt, mcp.oauth.callback,
    // spaceLinks.invoke, bridges.listen, bridges.handles.claim and three
    // spacePassword ops) on a server with the ledger off, the default.
    const refused: string[] = [];
    for (const op of OPERATIONS as readonly OperationBinding[]) {
      const schema = INPUT_SCHEMAS[op.name as keyof typeof INPUT_SCHEMAS];
      if (op.kind !== 'command' || !schema) continue;
      const parsed = schema.safeParse(normalizeCommandInputForIdempotencyMode(op, {}, false, schema));
      if (!parsed.success && parsed.error.issues.some(i => i.code === 'unrecognized_keys' && (i as { keys: string[] }).keys.includes('clientMutationId'))) refused.push(op.name);
    }
    expect(refused).toEqual([]);
  });

  it('still injects for a command whose DTO declares the id', () => {
    const op = binding('entities.create');
    const normalized = normalizeCommandInputForIdempotencyMode(op, { title: 'x' }, false, INPUT_SCHEMAS['entities.create']) as { clientMutationId?: string };
    expect(typeof normalized.clientMutationId).toBe('string');
  });
});

