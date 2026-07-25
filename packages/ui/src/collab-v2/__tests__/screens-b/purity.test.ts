// @vitest-environment node
/**
 * THE LAW for screens, enforced: a screen is composition, not a renderer.
 *
 * Two greps over the W3b screen source:
 *  1. no kind-conditionals — kind variation belongs to registry/ (same rules
 *     the entity layer is held to);
 *  2. no bespoke entity markup — a screen must reach entities through the
 *     entity component system (EntityCard/EntityChip/EntityFullView/…), never
 *     by hand-rendering a summary's title/status itself.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const moduleRoot = join(here, '..', '..');
const SCREEN_DIRS = ['screens/docs', 'screens/team', 'screens/leaderboard'];

const KIND_LITERALS = [
  'channel', 'task', 'message', 'member', 'team_member',
  'doc', 'file', 'spell', 'skill', 'pull_request', 'commit',
];

const FORBIDDEN: Array<{ name: string; re: RegExp }> = [
  { name: 'kind equality branch', re: /\bkind\s*[!=]==?\s*['"`]/ },
  { name: 'switch on kind', re: /switch\s*\([^)]*\bkind\b/ },
  { name: 'case on a kind literal', re: new RegExp(`case\\s+['"\`](${KIND_LITERALS.join('|')})['"\`]`) },
  // Hand-rendered entity fields: the registry owns how a summary looks.
  // (`${…}` interpolation is exempt — that's tooltip/aria copy, not markup.)
  { name: 'bespoke entity markup', re: /(?<!\$)\{\s*\w+\.(title|excerpt)\s*\}/ },
];

/** Entity-facing composition each screen must actually use. */
const COMPOSED = [
  'EntityCard', 'EntityChip', 'ChipById', 'CardById', 'EntityFullView',
  'CollectionView', 'Thread', 'discussionSlot', 'LiveBadges', 'Avatar',
  'ConnectionsRail', 'EmptyState',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(join(moduleRoot, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ts|tsx)$/.test(e.name))
    .map((e) => join(moduleRoot, dir, e.name));
}

const files = SCREEN_DIRS.flatMap(sourceFiles);

describe('screen purity — composition only', () => {
  it('scans every W3b screen file', () => {
    expect(files.length).toBeGreaterThanOrEqual(9);
  });

  for (const file of files) {
    const rel = file.slice(moduleRoot.length + 1);
    it(`keeps ${rel} kind-agnostic and markup-free`, () => {
      const src = readFileSync(file, 'utf8');
      for (const rule of FORBIDDEN) {
        const match = src.match(rule.re);
        expect(
          match,
          `${rule.name} found in ${rel}: ${match?.[0] ?? ''}`,
        ).toBeNull();
      }
    });
  }

  for (const dir of SCREEN_DIRS) {
    it(`${dir} renders entities through the entity system`, () => {
      const src = sourceFiles(dir).map((f) => readFileSync(f, 'utf8')).join('\n');
      expect(COMPOSED.some((c) => src.includes(`<${c}`))).toBe(true);
    });
  }
});
