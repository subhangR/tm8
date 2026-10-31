/**
 * `meta.get` — GET /v2/meta (TM8 Mobile S2), black-box against a real Server.
 *
 * This client sends no credential at all, which is the access under test: a
 * node answers it before anybody signs in. The answer must arrive in the
 * standard envelope, parse with the contract's schema, and agree with the
 * contract this suite was built from — a Server built from another catalog
 * fails here by its digest, which is what the field is for.
 */
import { createHash } from 'node:crypto';

import {
  CONTRACT_VERSION,
  MetaGetResultSchema,
  OPERATIONS,
  RESERVED_OPERATIONS,
  WORKSPACE_EVENT_SCHEMA_VERSION,
  bindPath,
} from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import { rawRequest } from '../src/client.js';

async function readMeta() {
  const res = await rawRequest('GET', bindPath('meta.get'));
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const body = res.body as { data?: unknown; requestId?: unknown };
  expect(typeof body.requestId).toBe('string');
  expect(res.headers.get('x-tm8-request-id')).toBe(body.requestId);
  return MetaGetResultSchema.parse(body.data);
}

describe('meta.get — GET /v2/meta', () => {
  it('answers a caller with no credential, in the envelope, parsed by MetaGetResultSchema', async () => {
    const meta = await readMeta();
    expect(Object.keys(meta).sort()).toEqual(
      ['catalogSha256', 'contractVersion', 'eventSchemaVersion', 'features', 'minClients'],
    );
  });

  it('speaks the contract this suite was built from', async () => {
    const meta = await readMeta();
    expect(meta.contractVersion).toBe(CONTRACT_VERSION);
    expect(meta.catalogSha256).toBe(createHash('sha256').update(JSON.stringify(OPERATIONS)).digest('hex'));
    expect(meta.eventSchemaVersion).toBe(WORKSPACE_EVENT_SCHEMA_VERSION);
  });

  it('features: v1 catalog rows only, in catalog order, never a reserved row, itself included', async () => {
    const meta = await readMeta();
    const v1 = OPERATIONS.filter((op) => op.status === 'v1').map((op) => op.name as string);
    let at = 0;
    for (const name of meta.features) {
      const next = v1.indexOf(name, at);
      expect(next, `${name} is not a v1 row after position ${at}`).toBeGreaterThanOrEqual(0);
      at = next + 1;
    }
    for (const op of RESERVED_OPERATIONS) expect(meta.features).not.toContain(op.name);
    expect(meta.features).toEqual(expect.arrayContaining(['meta.get', 'auth.claim.status', 'events.subscribe']));
  });

  it('minClients names clients and MAJOR.MINOR.PATCH minimums', async () => {
    const meta = await readMeta();
    for (const [client, version] of Object.entries(meta.minClients)) {
      expect(client).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});
