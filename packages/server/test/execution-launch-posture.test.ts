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

describe('DbGraphPort.loadSessionLaunchPosture harness choice', () => {
  const load = async (row: Record<string, unknown>) => {
    const db = {
      query: vi.fn(async () => [{
        access_mode: null, permission_mode: null, credential_source: null, credential_sources: null,
        space_credential_ids: null, ...row,
      }]),
      rpc: vi.fn(), tx: vi.fn(), end: vi.fn(),
    } as unknown as Db;
    return new DbGraphPort(db).loadSessionLaunchPosture(
      { identityId: 'identity-1' },
      '11111111-1111-4111-8111-111111111111',
    );
  };

  it('carries a recorded launch.harnessChoice so resume keeps the pick', async () => {
    const posture = await load({ harness_choice: { surface: 'inherit', plugins: ['sales'] } });
    expect(posture!.harnessChoice).toEqual({ surface: 'inherit', plugins: ['sales'] });
  });

  it('omits it when the launch made no pick (or the stored value is not an object)', async () => {
    expect(await load({ harness_choice: null })).not.toHaveProperty('harnessChoice');
    expect(await load({ harness_choice: ['inherit'] })).not.toHaveProperty('harnessChoice');
  });

  it('carries the recorded launch.selection and selectionReasons for resume to replay', async () => {
    const posture = await load({ selection: { memoryIds: ['m'] }, selection_reasons: { skills: 'cli' } });
    expect(posture!.selection).toEqual({ memoryIds: ['m'] });
    expect(posture!.selectionReasons).toEqual({ skills: 'cli' });
    const none = await load({ selection: null, selection_reasons: null });
    expect(none).not.toHaveProperty('selection');
    expect(none).not.toHaveProperty('selectionReasons');
  });
});
