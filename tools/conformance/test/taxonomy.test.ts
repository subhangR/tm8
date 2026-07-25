/**
 * DEV-8 — the closed error taxonomy, and T-L12's honesty rules:
 * - reserved operations answer `501 not_implemented` (never 404),
 * - v1 operations never answer 501 (they exist — that is the M1 bar),
 * - every observed error code maps to its normative HTTP status.
 */
import { describe, expect, it } from 'vitest';
import {
  ERROR_STATUS, RESERVED_OPERATIONS, V1_OPERATIONS, WireErrorBodySchema,
} from '@tm8/contract';
import { rawRequest } from '../src/client.js';

function dummyParams(path: string): string {
  return path.replace(/:[A-Za-z]+/g, 'conf-missing-id');
}

describe('taxonomy + honesty (DEV-8, DEV-13)', () => {
  it('reserved operations are honest 501s, never 404s', async () => {
    for (const op of RESERVED_OPERATIONS) {
      if (op.method === 'WS') continue;
      const res = await rawRequest(op.method, dummyParams(op.path));
      expect(res.status, `${op.name} must 501`).toBe(501);
      const parsed = WireErrorBodySchema.safeParse(res.body);
      expect(parsed.success, `${op.name} 501 body drift`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.error.code).toBe('not_implemented');
        expect(parsed.data.error.retryable).toBe(false);
      }
    }
  });

  it('v1 read operations are implemented — none may answer 501', async () => {
    const failures: string[] = [];
    for (const op of V1_OPERATIONS) {
      if (op.method !== 'GET') continue;
      const res = await rawRequest('GET', dummyParams(op.path));
      if (res.status === 501) failures.push(`${op.name} (${op.method} ${op.path})`);
    }
    expect(failures, `v1 operations answering 501 not_implemented:\n${failures.join('\n')}`).toEqual([]);
  });

  it('every observed error status matches ERROR_STATUS[code]', async () => {
    const probes = [
      rawRequest('GET', '/v2/entities/conf-missing-id'),
      rawRequest('GET', '/v2/no-such-route'),
      rawRequest('POST', '/v2/entities', undefined, { rawBody: 'nope{' }),
      rawRequest('GET', '/v2/search', undefined, { query: { q: 'x' } }),
    ];
    for (const res of await Promise.all(probes)) {
      if (res.status < 400) continue;
      const parsed = WireErrorBodySchema.safeParse(res.body);
      expect(parsed.success, `error body drift at status ${res.status}: ${JSON.stringify(res.body)}`).toBe(true);
      if (parsed.success) {
        expect(res.status, `status/code mismatch for ${parsed.data.error.code}`)
          .toBe(ERROR_STATUS[parsed.data.error.code]);
      }
    }
  });
});
