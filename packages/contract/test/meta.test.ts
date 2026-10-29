/**
 * `meta.get` (GET /v2/meta, s-lld §4 version signals): the catalog row and the
 * wire schema. The handler's derivation lives in packages/server/test/meta.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { MetaGetResultSchema, getOperation, isOperationName } from '../src/index.js';

const answer = {
  contractVersion: '0.1.0',
  catalogSha256: 'a'.repeat(64),
  eventSchemaVersion: 1,
  features: ['meta.get', 'identity.get', 'events.subscribe'],
  minClients: {},
};

describe('meta.get catalog row', () => {
  it('is a v1 read at GET /v2/meta, open to every caller', () => {
    expect(isOperationName('meta.get')).toBe(true);
    const op = getOperation('meta.get');
    expect(op).toEqual({ name: 'meta.get', method: 'GET', path: '/v2/meta', kind: 'read', status: 'v1' });
    // No humanOnly: an agent, a signed-out app and the CLI all read it.
    expect('humanOnly' in op).toBe(false);
  });
});

describe('MetaGetResultSchema', () => {
  it('parses the five fields', () => {
    expect(MetaGetResultSchema.parse(answer)).toEqual(answer);
    expect(MetaGetResultSchema.parse({ ...answer, minClients: { 'tm8-mobile': '1.2.0' } }).minClients)
      .toEqual({ 'tm8-mobile': '1.2.0' });
  });

  it('refuses a digest that is not lowercase hex SHA-256, and a missing field', () => {
    for (const catalogSha256 of ['A'.repeat(64), 'a'.repeat(63), `sha256:${'a'.repeat(64)}`]) {
      expect(MetaGetResultSchema.safeParse({ ...answer, catalogSha256 }).success, catalogSha256).toBe(false);
    }
    for (const field of Object.keys(answer)) {
      const partial: Record<string, unknown> = { ...answer };
      delete partial[field];
      expect(MetaGetResultSchema.safeParse(partial).success, field).toBe(false);
    }
    expect(MetaGetResultSchema.safeParse({ ...answer, eventSchemaVersion: 0 }).success).toBe(false);
    expect(MetaGetResultSchema.safeParse({ ...answer, features: [''] }).success).toBe(false);
  });

  it('still parses the answer of a NEWER node: unknown fields and unknown operation names', () => {
    // An app older than the node must be able to read this answer, because
    // learning that it is too old is the reason it asks.
    const newer = {
      ...answer,
      contractVersion: '0.2.0',
      features: [...answer.features, 'devices.register', 'some.future.op'],
      minClients: { 'tm8-mobile': '2.0.0', 'tm8-watch': '1.0.0' },
      somethingAddedLater: { x: 1 },
    };
    const parsed = MetaGetResultSchema.parse(newer);
    expect(parsed.features).toContain('some.future.op');
    expect(parsed.minClients['tm8-mobile']).toBe('2.0.0');
    expect('somethingAddedLater' in parsed).toBe(false);
  });
});
