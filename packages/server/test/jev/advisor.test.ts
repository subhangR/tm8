/**
 * Spec 01a0e248 decision 10 — the Ask Jev key ladder, unit-level: the space's
 * typesafe key (my_default, else the space default), else none (`no_key`).
 * There is no member (203) or node (`TYPESAFE_API_KEY`) rung. The pg half —
 * which space row the SQL picks (my_default for humans, else the space
 * default) — is test/db/server-only-credentials.pg.test.ts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { DbClaims } from '../../src/db/types.js';
import { createJevAdvisorResolver, type JevAdvisorResolverDeps } from '../../src/jev/advisor.js';
import type { JevAdvisorPort } from '../../src/jev/port.js';

const SPACE = '01a0e268-0000-7000-8000-000000000001';
const claims = (authKind: string): DbClaims => ({ identityId: 'who', nodeAdmin: false, requestId: 'r', authKind }) as DbClaims;

function harness(over: Partial<JevAdvisorResolverDeps> & { space?: string | null } = {}) {
  const built: string[] = [];
  const readSpaceKey = vi.fn(async () => over.space ?? null);
  const resolve = createJevAdvisorResolver({
    readSpaceKey,
    advisorForKey: (key) => { built.push(key); return { key } as unknown as JevAdvisorPort; },
    ...over,
  });
  return { resolve, built, readSpaceKey };
}

describe('Ask Jev key ladder: space key → no_key', () => {
  it('the space key answers, read for THIS space with the caller’s claims', async () => {
    const h = harness({ space: 'space-key' });
    expect(await h.resolve(claims('browser'), { spaceId: SPACE })).not.toBeNull();
    expect(h.built).toEqual(['space-key']);
    expect(h.readSpaceKey).toHaveBeenCalledWith(expect.objectContaining({ authKind: 'browser' }), SPACE);
  });

  it('an agent reads the space key too (the SQL gives it the space default, never a my_default)', async () => {
    const h = harness({ space: 'space-key' });
    await h.resolve(claims('agent'), { spaceId: SPACE });
    expect(h.built).toEqual(['space-key']);
  });

  it('no_key: no space key → null, for a human and an agent alike, whatever the node environment holds', async () => {
    vi.stubEnv('TYPESAFE_API_KEY', 'node-key');
    try {
      for (const kind of ['browser', 'cli', 'agent']) {
        const h = harness();
        expect(await h.resolve(claims(kind), { spaceId: SPACE })).toBeNull();
        expect(h.built).toEqual([]);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a blank space key is no key', async () => {
    const h = harness({ space: '   ' });
    expect(await h.resolve(claims('browser'), { spaceId: SPACE })).toBeNull();
    expect(h.built).toEqual([]);
  });

  it('an unreadable space key is no_key, logged once without a key', async () => {
    const warn = vi.fn();
    const h = harness({
      readSpaceKey: vi.fn(async () => { throw new Error('stored space credential is unreadable'); }),
      logger: { warn },
    });
    expect(await h.resolve(claims('browser'), { spaceId: SPACE })).toBeNull();
    expect(h.built).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('without a space id nothing is read and the answer is no_key, not a guess', async () => {
    const h = harness({ space: 'space-key' });
    expect(await h.resolve(claims('browser'))).toBeNull();
    expect(h.readSpaceKey).not.toHaveBeenCalled();
    expect(h.built).toEqual([]);
  });
});

describe('the removed rungs stay removed', () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), '../../src');

  it('no server source reads TYPESAFE_API_KEY', () => {
    for (const file of ['main.ts', 'jev/advisor.ts', 'jev/jev-adapter.ts', 'jev/handlers.ts', 'facade/handlers/w2/credentials.ts']) {
      const code = readFileSync(join(src, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/TYPESAFE_API_KEY/);
    }
  });

  it('the resolver takes no member or node key', () => {
    const code = readFileSync(join(src, 'jev/advisor.ts'), 'utf8');
    expect(code).not.toMatch(/readMemberKey|nodeKey/);
  });
});
