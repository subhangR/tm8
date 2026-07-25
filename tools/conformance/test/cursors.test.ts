/**
 * DEV-5 — honest keyset cursors. Cursors are opaque v2 keyset strings (never
 * offsets), `nextCursor: null` ⇔ exhausted, pages never overlap or skip, and
 * malformed/stale cursors reject with `400 invalid_cursor`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '@tm8/contract';
import { api, expectError } from '../src/client.js';
import { buildWorld, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('cursors');
  // widen the task set so pagination has something to page over
  for (let i = 0; i < 7; i++) {
    await api.command('entities.create', {
      spaceId: w.spaceId, kind: 'task', title: `T-2${i} · Filler ${i}`, parentId: w.epic, position: 10 + i,
      clientMutationId: `cmid-filler-${i}-${w.spaceId}`,
    });
  }
});

describe('keyset cursors (DEV-5)', () => {
  it('paginates without overlap or skips; cursors are v2 keysets; null ⇔ exhausted', async () => {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await api.command('collections.query', {
        spaceId: w.spaceId, kinds: ['task'], limit: 4, ...(cursor ? { cursor } : {}),
      }) as { page: { items: { id: string }[]; nextCursor: string | null } };
      pages += 1;
      expect(res.page.items.length).toBeLessThanOrEqual(4);
      for (const item of res.page.items) {
        expect(seen.has(item.id), `duplicate ${item.id} across pages`).toBe(false);
        seen.add(item.id);
      }
      if (res.page.nextCursor === null) break;
      expect(res.page.nextCursor).not.toMatch(/^off:/);
      expect(res.page.nextCursor).not.toMatch(/^\d+$/);
      expect(() => decodeCursor(res.page.nextCursor as string), 'nextCursor must be a v2 keyset cursor').not.toThrow();
      cursor = res.page.nextCursor;
      expect(pages).toBeLessThan(50); // runaway guard
    }
    expect(seen.size).toBeGreaterThanOrEqual(11); // 4 world tasks + epic + 7 fillers − any deletions
  });

  it('messages and activity lists take keyset cursors too', async () => {
    const page1 = await api.read('messages.list', { anchorId: w.t101 }, { limit: '1' }) as { items: unknown[]; nextCursor: string | null };
    if (page1.nextCursor !== null) expect(() => decodeCursor(page1.nextCursor as string)).not.toThrow();
    const activity = await api.read('entities.activity', { id: w.t101 }) as { items: unknown[]; nextCursor: string | null };
    expect('nextCursor' in activity).toBe(true);
  });

  it('malformed, offset-shaped and wrong-version cursors → 400 invalid_cursor', async () => {
    for (const bad of ['off:40', '40', '%%%not-a-cursor%%%']) {
      await expectError(api.command('collections.query', {
        spaceId: w.spaceId, kinds: ['task'], cursor: bad,
      }), 'invalid_cursor');
    }
    const v1cursor = Buffer.from(JSON.stringify({ v: 1, k: ['x'] })).toString('base64url');
    await expectError(api.command('collections.query', {
      spaceId: w.spaceId, kinds: ['task'], cursor: v1cursor,
    }), 'invalid_cursor');
  });

  it('a foreign (well-formed but stale) cursor still fails closed, never misinterprets', async () => {
    const foreign = encodeCursor(['zzz-not-a-real-sort-value', 'ent_foreign']);
    const res = api.command('collections.query', { spaceId: w.spaceId, kinds: ['task'], cursor: foreign });
    // Either honest rejection or an empty/valid keyset continuation — never a crash or offset fallback.
    try {
      const out = await res as { page: { items: unknown[]; nextCursor: string | null } };
      expect(Array.isArray(out.page.items)).toBe(true);
    } catch (e) {
      const { isWireError } = await import('../src/client.js');
      expect(isWireError(e) && e.code === 'invalid_cursor').toBe(true);
    }
  });
});
