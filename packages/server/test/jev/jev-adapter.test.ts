/**
 * `jev-adapter.ts` — the port onto `@tm8/jev`, and the rule that makes the
 * port worth having: it is the ONLY server file that imports the client.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const jev = vi.hoisted(() => ({
  createJevClient: vi.fn((options: { apiKey: string }) => ({ ask: vi.fn(), apiKey: options.apiKey })),
  rankByRelevance: vi.fn(),
  adviseModel: vi.fn(),
}));
vi.mock('@tm8/jev', () => jev);

import {
  JEV_ADVISOR_CACHE_LIMIT,
  jevAdvisorForKey,
  resetJevAdvisorCache,
} from '../../src/jev/jev-adapter.js';

describe('jevAdvisorForKey — one client per key (Lane K)', () => {
  beforeEach(() => { vi.clearAllMocks(); resetJevAdvisorCache(); });

  it('each key builds a client carrying exactly that key, reused on the next request', async () => {
    const a = jevAdvisorForKey('key-a');
    const b = jevAdvisorForKey('key-b');
    expect(jevAdvisorForKey('key-a')).toBe(a);
    expect(a).not.toBe(b);
    expect(jev.createJevClient.mock.calls.map(([options]) => options)).toEqual([{ apiKey: 'key-a' }, { apiKey: 'key-b' }]);

    const task = { title: 't', description: 'd' };
    await b.model(task);
    // Control for the line above: a's client is a different object from b's.
    expect((jev.adviseModel.mock.calls[0]![0] as { apiKey: string }).apiKey).toBe('key-b');
  });

  it('hands every call to rankByRelevance / adviseModel unchanged, on the key’s own client', async () => {
    const ranked = { ok: true, ranked: [], calls: [] };
    const advised = { ok: false, reason: 'timeout', call: { jevModel: null, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 5000, outcome: 'timeout' } };
    jev.rankByRelevance.mockResolvedValue(ranked);
    jev.adviseModel.mockResolvedValue(advised);

    const advisor = jevAdvisorForKey('k');
    const client = jev.createJevClient.mock.results[0]!.value;
    const task = { title: 'Fix login', description: 'SSO lands on 404' };
    const candidates = [{ id: 'm1', text: 'a memory' }];
    await expect(advisor.rank({ task, candidates, noun: 'memory' })).resolves.toBe(ranked);
    await expect(advisor.model(task)).resolves.toBe(advised);

    expect(jev.createJevClient).toHaveBeenCalledTimes(1);
    expect(jev.rankByRelevance).toHaveBeenNthCalledWith(1, client, { task, candidates, noun: 'memory' });
    expect(jev.adviseModel).toHaveBeenCalledWith(client, task);
  });

  it('bounds the cache and rebuilds an evicted key rather than handing out another', () => {
    const first = jevAdvisorForKey('key-0');
    for (let i = 1; i <= JEV_ADVISOR_CACHE_LIMIT; i += 1) jevAdvisorForKey(`key-${String(i)}`);
    const again = jevAdvisorForKey('key-0');
    expect(again).not.toBe(first);
    expect(jev.createJevClient).toHaveBeenLastCalledWith({ apiKey: 'key-0' });
  });
});

describe('the port is the boundary', () => {
  it('no server source file but jev-adapter.ts imports @tm8/jev', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '../../src');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : path.endsWith('.ts') ? [path] : [];
    });
    const importers = walk(src)
      .filter((file) => /from\s+['"]@tm8\/jev['"]|import\(\s*['"]@tm8\/jev['"]\s*\)/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file));
    expect(importers).toEqual(['jev/jev-adapter.ts']);
  });
});
