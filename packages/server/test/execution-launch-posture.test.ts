import { describe, expect, it, vi } from 'vitest';

import { CREDENTIAL_PROVIDERS } from '@tm8/execution';

import type { Db } from '../src/db/types.js';
import { DbGraphPort } from '../src/facade/execution-handlers.js';

describe('DbGraphPort.loadSessionLaunchPosture credential sources', () => {
  it('reloads every admitted provider from the canonical provider set', async () => {
    const storedSources = Object.fromEntries(
      CREDENTIAL_PROVIDERS.map((provider) => [provider, null]),
    ) as Record<string, string | null>;
    storedSources.gemini = 'member';
    storedSources.cursor = 'node';
    storedSources.not_admitted = 'member';

    const query = vi.fn(
      async (_claims: unknown, _sql: string, _params?: readonly unknown[]) => [{
        access_mode: 'acceptEdits',
        permission_mode: null,
        credential_source: null,
        credential_sources: storedSources,
      }],
    );
    const db = {
      query,
      rpc: vi.fn(),
      tx: vi.fn(),
      end: vi.fn(),
    } as unknown as Db;

    const posture = await new DbGraphPort(db).loadSessionLaunchPosture(
      { identityId: 'identity-1' },
      '11111111-1111-4111-8111-111111111111',
    );

    expect(Object.keys(posture!.credentialSources!)).toEqual(CREDENTIAL_PROVIDERS);
    expect(posture!.credentialSources).toMatchObject({ gemini: 'member', cursor: 'node' });
    expect(posture!.credentialSources).not.toHaveProperty('not_admitted');

    const sql = query.mock.calls[0]![1] as string;
    expect(sql).toContain("#>  '{launch,credentialSources}'");
    expect(sql).not.toContain('{launch,credentialSources,');
  });
});
