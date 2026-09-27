/**
 * S6 (server_only_space_credentials) — the Ask Jev key ladder, unit-level: the space's typesafe key
 * first, then (release 1 only, unchanged) the caller's 203 key for a human,
 * then the node key, then none (`no_key`). The pg half — which space row the
 * SQL picks (my_default for humans, else the space default) — is
 * test/db/server-only-credentials.pg.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import type { DbClaims } from '../../src/db/types.js';
import { createJevAdvisorResolver, type JevAdvisorResolverDeps } from '../../src/jev/advisor.js';
import type { JevAdvisorPort } from '../../src/jev/port.js';

const SPACE = '01a0e268-0000-7000-8000-000000000001';
const claims = (authKind: string): DbClaims => ({ identityId: 'who', nodeAdmin: false, requestId: 'r', authKind }) as DbClaims;

function harness(over: Partial<JevAdvisorResolverDeps> & { space?: string | null; member?: string | null } = {}) {
  const built: string[] = [];
  const readSpaceKey = vi.fn(async () => over.space ?? null);
  const readMemberKey = vi.fn(async () => over.member ?? null);
  const resolve = createJevAdvisorResolver({
    readSpaceKey,
    readMemberKey,
    nodeKey: 'node-key',
    advisorForKey: (key) => { built.push(key); return { key } as unknown as JevAdvisorPort; },
    ...over,
  });
  return { resolve, built, readSpaceKey, readMemberKey };
}

describe('Ask Jev key ladder (server_only_space_credentials + release-1 fallback)', () => {
  it('rung 1: the space key wins over the member and node keys, and is read for THIS space', async () => {
    const h = harness({ space: 'space-key', member: 'member-key' });
    expect(await h.resolve(claims('browser'), { spaceId: SPACE })).not.toBeNull();
    expect(h.built).toEqual(['space-key']);
    expect(h.readSpaceKey).toHaveBeenCalledWith(expect.objectContaining({ authKind: 'browser' }), SPACE);
    expect(h.readMemberKey).not.toHaveBeenCalled();
  });

  it('rung 1 for an agent too: the space key is not human-only', async () => {
    const h = harness({ space: 'space-key' });
    await h.resolve(claims('agent'), { spaceId: SPACE });
    expect(h.built).toEqual(['space-key']);
  });

  it('rung 2 (R1): no space key → a human’s 203 key', async () => {
    const h = harness({ member: 'member-key' });
    await h.resolve(claims('cli'), { spaceId: SPACE });
    expect(h.built).toEqual(['member-key']);
  });

  it('rung 2 is human-only: an agent with no space key skips the 203 key to the node key', async () => {
    const h = harness({ member: 'member-key' });
    await h.resolve(claims('agent'), { spaceId: SPACE });
    expect(h.readMemberKey).not.toHaveBeenCalled();
    expect(h.built).toEqual(['node-key']);
  });

  it('rung 3 (R1): no space key, no 203 key → the node key', async () => {
    const h = harness();
    await h.resolve(claims('browser'), { spaceId: SPACE });
    expect(h.built).toEqual(['node-key']);
  });

  it('no_key: nothing on any rung → null', async () => {
    const h = harness({ nodeKey: '  ' });
    expect(await h.resolve(claims('browser'), { spaceId: SPACE })).toBeNull();
    expect(h.built).toEqual([]);
  });

  it('an unreadable space key falls through (release 1 is additive) and never logs a key', async () => {
    const warn = vi.fn();
    const h = harness({
      member: 'member-key',
      readSpaceKey: vi.fn(async () => { throw new Error('stored space credential is unreadable'); }),
      logger: { warn },
    });
    await h.resolve(claims('browser'), { spaceId: SPACE });
    expect(h.built).toEqual(['member-key']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/member-key|node-key/);
  });

  it('a blank space key is no key (control: the next rung answers)', async () => {
    const h = harness({ space: '   ' });
    await h.resolve(claims('browser'), { spaceId: SPACE });
    expect(h.built).toEqual(['node-key']);
  });

  it('without a space id the space rung is skipped, not guessed', async () => {
    const h = harness({ space: 'space-key' });
    await h.resolve(claims('browser'));
    expect(h.readSpaceKey).not.toHaveBeenCalled();
    expect(h.built).toEqual(['node-key']);
  });
});
