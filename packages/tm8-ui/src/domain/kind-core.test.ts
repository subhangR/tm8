import { describe, expect, it } from 'vitest';
import { KIND_ART as CORE_ART, KIND_CORE, kindBySlug as coreKindBySlug } from '@tm8/client-core/kinds';
import { KIND_ART } from './kind-art';
import { allKinds, kindBySlug, registerCustomKinds } from './registry';

/*
 * L-A, SAME WORDS AS THE PHONE APP. tm8-ui's rows spread `KIND_CORE[kind]` from
 * `@tm8/client-core/kinds` (t-p0-client-core), the table the phone app's
 * registry spreads too. These cases hold the web registry equal to it, so a row
 * that overrides a label, a plural, a slug or a route strategy after the spread
 * fails here rather than shipping a second word for the same kind.
 */

const STATIC_ROWS = allKinds().filter((row) => Object.hasOwn(KIND_CORE, row.kind));

describe('the registry extends KIND_CORE', () => {
  it('has one row for every KIND_CORE kind, and no static row KIND_CORE lacks', () => {
    expect(STATIC_ROWS.map((row) => row.kind).sort()).toEqual(Object.keys(KIND_CORE).sort());
    expect(allKinds()).toHaveLength(STATIC_ROWS.length);
  });

  it('says each kind with KIND_CORE’s label, plural, slug, strategy, group and mark', () => {
    for (const row of STATIC_ROWS) {
      const core = KIND_CORE[row.kind as keyof typeof KIND_CORE];
      expect(
        {
          label: row.label,
          labelPlural: row.labelPlural,
          slug: row.slug,
          strategy: row.strategy,
          group: row.group,
          iconArt: row.iconArt,
        },
        row.kind,
      ).toEqual(core);
      expect(row.iconArt, row.kind).toBe(core.iconArt);
    }
  });

  it('re-exports the one KIND_ART table, not a copy', () => {
    expect(KIND_ART).toBe(CORE_ART);
  });
});

describe('the route codec still validates `k/{slug}` the way the registry did', () => {
  /* The codec moved to client-core and reads `kindBySlug` from there, which
     knows the static rows only. Its test is `kindBySlug(slug) !== null || a
     c-{name} slug`, and every custom row's slug is `c-{name}`, so the answer is
     the one tm8-ui's own lookup gives, with and without custom kinds. */
  const known = (lookup: (slug: string) => unknown, slug: string) =>
    lookup(slug) !== null || (slug.startsWith('c-') && slug.length > 2);
  const slugs = [
    ...STATIC_ROWS.flatMap((row) => (row.slug === null ? [] : [row.slug])),
    'designs',
    'c-recipe',
    'c-',
    'nope',
    '',
  ];

  it('agrees for every slug before any custom kind is registered', () => {
    for (const slug of slugs) expect(known(coreKindBySlug, slug), slug).toBe(known(kindBySlug, slug));
  });

  it('agrees once a space registers custom kinds', () => {
    registerCustomKinds([{ kind: 'c:recipe' }, { kind: 'c:incident_report', icon: '!' }]);
    for (const slug of [...slugs, 'c-incident_report']) {
      expect(known(coreKindBySlug, slug), slug).toBe(known(kindBySlug, slug));
    }
    registerCustomKinds([]);
  });
});
