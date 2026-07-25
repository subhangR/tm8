// @vitest-environment node
/**
 * THE LAW for L5, enforced: screens COMPOSE, they do not branch on kind.
 *
 * No `kind === …` / `switch (kind)` / `case '<kind>'` anywhere in the W3c
 * screen dirs — every kind difference must come from the registry via
 * EntityChip/EntityCard/CollectionView. Also asserts the screens never reach
 * for a raw entity-rendering join of their own (no bespoke `<div class="card">`
 * markup standing in for an EntityCard).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = join(here, '..', '..');

const SCREEN_DIRS = ['screens/channel', 'screens/tracking', 'screens/settings'];

const KIND_LITERALS = [
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
];

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'kind equality branch', re: /\bkind\s*[!=]==?\s*['"`]/ },
  { name: 'switch on kind', re: /switch\s*\([^)]*\bkind\b/ },
  { name: 'case on a kind literal', re: new RegExp(`case\\s+['"\`](${KIND_LITERALS.join('|')})['"\`]`) },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(join(moduleRoot, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(moduleRoot, dir, e.name));
}

describe('screens purity (W3c) — composition only', () => {
  const files = SCREEN_DIRS.flatMap(sourceFiles);

  it('scans a non-trivial surface', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  for (const file of SCREEN_DIRS.flatMap(sourceFiles)) {
    const rel = file.slice(moduleRoot.length + 1);
    it(`keeps ${rel} kind-agnostic`, () => {
      const src = readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN) {
        const match = src.match(rule.re);
        expect(
          match,
          `${rule.name} found: ${match?.[0] ?? ''} — kind variation belongs in registry/`,
        ).toBeNull();
      }
    });
  }

  it('renders entities only through the entity/collection systems', () => {
    // Every screen that shows an entity must import one of these; none may
    // hand-roll entity markup.
    const composers = /EntityCard|EntityChip|CollectionView|Thread|EntityFullView|ChipById|CardById/;
    const entityScreens = files.filter((f) => /Row|Shelf|Section|Hub|Screen|Tabs/.test(f));
    for (const file of entityScreens) {
      const src = readFileSync(file, 'utf8');
      // A screen file either renders entities through the shared components or
      // renders no entities at all (pure chrome/plumbing).
      const mentionsEntities = /EntitySummary|EntityDetail/.test(src);
      if (mentionsEntities) {
        expect(
          composers.test(src),
          `${file.slice(moduleRoot.length + 1)} touches entities without a shared entity component`,
        ).toBe(true);
      }
    }
  });
});
