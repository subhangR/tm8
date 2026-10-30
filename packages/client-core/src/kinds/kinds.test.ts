import { describe, expect, it } from 'vitest';
import { CORE_KIND_INFO, CoreEntityKindSchema } from '@tm8/contract';
import { KIND_ART } from './kind-art';
import { CUSTOM_KIND_FALLBACK, KIND_CORE, kindBySlug } from './kinds';

/*
 * KIND_CORE is the one place both apps read a kind's words from (L-A). These
 * cases pin what the type cannot: the row set is exactly the contract's core
 * kinds plus the fallback, each group is the contract's, and the slugs are an
 * address space (unique, so `k/{slug}` names one kind).
 */

const CORE = CoreEntityKindSchema.options;

describe('KIND_CORE', () => {
  it('has exactly the 34 core kinds and the c:* fallback', () => {
    // MEASURED: 33 at b342584a2 (main adb9c5c03); 34 at a16ae6b95, where Bridges B0a
    // (593984ff1, migration 395) added 'bridge'. A new kind moves this pin on purpose.
    expect(CORE).toHaveLength(34);
    expect(Object.keys(KIND_CORE).sort()).toEqual([...CORE, CUSTOM_KIND_FALLBACK].sort());
  });

  it("carries the contract's group for every core kind, and `custom` for the fallback", () => {
    for (const kind of CORE) expect(KIND_CORE[kind].group, kind).toBe(CORE_KIND_INFO[kind].group);
    expect(KIND_CORE[CUSTOM_KIND_FALLBACK].group).toBe('custom');
  });

  it('draws every kind with its own mark from KIND_ART', () => {
    for (const kind of CORE) expect(KIND_CORE[kind].iconArt, kind).toBe(KIND_ART[kind]);
    expect(KIND_CORE[CUSTOM_KIND_FALLBACK].iconArt).toBe(KIND_ART.custom);
  });

  it('gives no two kinds the same slug, and every non-null slug is a plain path segment', () => {
    const slugs = Object.values(KIND_CORE).flatMap((row) => (row.slug === null ? [] : [row.slug]));
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z][a-z-]*$/);
  });

  it('has a label and a plural for every row', () => {
    for (const [kind, row] of Object.entries(KIND_CORE)) {
      expect(row.label.length, kind).toBeGreaterThan(0);
      expect(row.labelPlural.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('kindBySlug', () => {
  it('finds the row a slug addresses', () => {
    expect(kindBySlug('tasks')).toBe(KIND_CORE.task);
    expect(kindBySlug('connectors')).toBe(KIND_CORE.mcp_server);
  });

  it('lands an old `designs` link on crafts', () => {
    expect(kindBySlug('designs')).toBe(KIND_CORE.craft);
  });

  it('answers null for a slug no static row has, custom slugs included', () => {
    expect(kindBySlug('nope')).toBeNull();
    expect(kindBySlug('c-recipe')).toBeNull();
    expect(kindBySlug('')).toBeNull();
  });
});
