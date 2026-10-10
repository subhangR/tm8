import { describe, expect, it } from 'vitest';

import {
  CreatableEntityKindSchema,
  EntityKindSchema,
  KIND_ALIAS_UNTIL,
  MenuKindRefSchema,
  normalizeKindAlias,
} from '../src/index.js';

/*
 * `design` was renamed `craft` by migration 315 (2026-10-10). The old name is
 * an INPUT alias for 90 days; nothing ever outputs it.
 */
describe('the design -> craft kind alias', () => {
  it('maps design to craft and passes everything else through', () => {
    expect(normalizeKindAlias('design')).toBe('craft');
    expect(normalizeKindAlias('craft')).toBe('craft');
    expect(normalizeKindAlias('c:design')).toBe('c:design');
    expect(normalizeKindAlias(7)).toBe(7);
  });

  it('every kind input accepts design and parses it as craft', () => {
    for (const schema of [EntityKindSchema, CreatableEntityKindSchema, MenuKindRefSchema]) {
      expect(schema.parse('design')).toBe('craft');
      expect(schema.parse('craft')).toBe('craft');
      expect(schema.safeParse('designs').success).toBe(false);
    }
  });

  it('is deprecated with a removal date 90 days after the rename', () => {
    expect(KIND_ALIAS_UNTIL).toBe('2027-01-08');
  });
});
