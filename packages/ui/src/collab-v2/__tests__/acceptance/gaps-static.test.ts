// @vitest-environment node
/**
 * W5 STATIC GAP MARKERS (Sentinel-owned).
 *
 * Source-level facts that the acceptance verdict rests on. Each `GAP:` test
 * pins the CURRENT state of an unmet §L7 / §L8 requirement, so the day the gap
 * is closed this file fails and someone updates it deliberately — the opposite
 * of a silently-passing suite that has drifted away from the plan.
 *
 * Also pins the acceptance rig's fidelity to `CollabV2App`, since the rig
 * re-assembles the app composition rather than importing it.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      out.push(full.slice(MODULE_ROOT.length + 1));
    }
  };
  walk(MODULE_ROOT);
  return out.sort();
}

function grepModule(re: RegExp, keep: (path: string) => boolean): string[] {
  return sourceFiles()
    .filter(keep)
    .filter((rel) => re.test(readFileSync(join(MODULE_ROOT, rel), 'utf8')));
}

const isProduct = (rel: string): boolean => !rel.startsWith('__tests__');

const FROM = 'from';
const IMPORT = 'import';

// ---------------------------------------------------------------------------
// §L7 — offline
// ---------------------------------------------------------------------------

describe('GAP — offline (01-IMPLEMENTATION-PLAN.md L7: "offline banner, read-only + queued composer")', () => {
  it('the connection store has ZERO UI readers — the seam landed, the surface did not', () => {
    const readers = grepModule(
      /useConnectionStore|selectConnected/,
      (rel) => isProduct(rel) && !rel.startsWith('stores/'),
    );
    expect(readers, `connection-store readers outside stores/: ${readers.join(', ') || 'none'}`)
      .toEqual([]);
  });

  it('no component renders an offline banner or a queued/disabled composer', () => {
    const banners = grepModule(
      /offline[-\s]?banner|OfflineBanner|reconnecting/i,
      // stores/, mock/ and facade/ only MENTION the banner in comments that
      // describe it as future work — the point of this test is that no
      // rendering surface exists.
      (rel) => isProduct(rel) && !rel.startsWith('mock/')
        && !rel.startsWith('facade/') && !rel.startsWith('stores/'),
    );
    expect(banners, `offline-banner UI: ${banners.join(', ') || 'none'}`).toEqual([]);
  });

  it('the offline state is unreachable from the running app (no dev toggle in CollabV2App)', () => {
    const app = readFileSync(join(MODULE_ROOT, 'CollabV2App.tsx'), 'utf8');
    expect(app.includes('setConnected'),
      'CollabV2App ships a simulation toggle but no connection toggle').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §L8 / brief §10.4 — promote does not parent
// ---------------------------------------------------------------------------

describe('GAP — promote-to-doc never parents (brief §10.4 "doc lands as child of the spec doc")', () => {
  it('promoteMessage builds its seed without a parentId', () => {
    const src = readFileSync(join(MODULE_ROOT, 'interactions', 'promote', 'index.tsx'), 'utf8');
    const seed = src.slice(src.indexOf('export async function promoteMessage'));
    const body = seed.slice(0, seed.indexOf('\n}'));
    expect(body).toContain('attachTo');
    expect(body.includes('parentId'),
      'the promote seed carries no parentId, so the doc is born at the root').toBe(false);
  });

  it('...even though CreateSeed supports one and createFromSeed forwards it', () => {
    const create = readFileSync(join(MODULE_ROOT, 'interactions', 'create', 'index.tsx'), 'utf8');
    expect(create).toContain('parentId?: EntityId | null;');
    expect(create).toContain('parentId: seed.parentId');
  });
});

// ---------------------------------------------------------------------------
// §L8 — gallery coverage ("every kind × zoom × state")
// ---------------------------------------------------------------------------

describe('GAP — gallery coverage vs the definition of done', () => {
  const gallery = (): string =>
    readdirSync(join(MODULE_ROOT, 'gallery'))
      .filter((f) => /\.tsx?$/.test(f))
      .map((f) => readFileSync(join(MODULE_ROOT, 'gallery', f), 'utf8'))
      .join('\n');

  it('Z1/Z2/Z3 are covered', () => {
    const src = gallery();
    for (const zoom of ['EntityChip', 'EntityCard', 'EntityPanel']) {
      expect(src, `${zoom} present`).toContain(zoom);
    }
  });

  it('Z4 is NOT covered — EntityFullView never renders in the gallery', () => {
    expect(gallery().includes('EntityFullView'),
      'all 11 kind × Z4 cells are missing; the 5 Z4 layout variants are unexercised').toBe(false);
  });

  it('empty and error cells are NOT covered', () => {
    const src = gallery();
    expect(src.includes('EmptyState'), 'no empty cell').toBe(false);
    expect(/isCollabError|catch\s*\(/.test(src), 'no error cell and no load-failure handling')
      .toBe(false);
  });

  it('the gallery mounts no W2/W3/W4 component except ThreadGallery', () => {
    const src = gallery();
    for (const component of [
      'ConnectionsRail', 'ReactionsPointsBar', 'CommandPalette', 'CollectionView',
      'GraphCanvas', 'LiveBadges', 'StalenessBadge', 'BlockedBadge', 'DropSurface',
      'CreationModal', 'PromoteMenu', 'UndoPill',
    ]) {
      expect(src.includes(component), `${component} has no gallery presence`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// layer law — the one direction violation, pinned
// ---------------------------------------------------------------------------

describe('GAP — layer direction: screens (L5) import interactions (L6)', () => {
  it('exactly two screens reach upward, and they are the drop-surface owners', () => {
    const upward = grepModule(
      new RegExp(`${FROM} '\\.\\./\\.\\./interactions'`),
      (rel) => isProduct(rel) && rel.startsWith('screens/'),
    );
    expect(upward.sort(), 'if this list grows, the inversion is spreading').toEqual([
      'screens/channel/ChannelHubBody.tsx',
      'screens/team/MemberCard.tsx',
    ]);
  });

  it('interactions/ never reaches into screens/ or shell/ (the inversion is one-way)', () => {
    const downward = grepModule(
      new RegExp(`${FROM} '\\.\\./(\\.\\./)?(screens|shell)`),
      (rel) => isProduct(rel) && rel.startsWith('interactions/'),
    );
    expect(downward).toEqual([]);
  });

  it('no test anywhere enforces import direction between layers', () => {
    const enforcers = grepModule(
      new RegExp(`${IMPORT}\\s+direction|layer\\s+(law|direction|violation)`, 'i'),
      (rel) => !isProduct(rel),
    );
    // this file is the only place the rule is written down at all
    expect(enforcers.filter((f) => !f.includes('acceptance/')),
      'no pre-existing layer-direction test').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rig fidelity
// ---------------------------------------------------------------------------

describe('acceptance rig fidelity', () => {
  it('mounts the same view modules CollabV2App mounts', () => {
    const app = readFileSync(join(MODULE_ROOT, 'CollabV2App.tsx'), 'utf8');
    for (const registry of [
      'homeViews', 'inboxViews', 'tasksViews', 'docsViews', 'teamViews',
      'leaderboardViews', 'channelViews', 'trackingViews', 'settingsViews',
    ]) {
      expect(app, `CollabV2App still spreads ${registry}`).toContain(`...${registry}`);
    }
    expect(app, 'and still registers the generic Z4 route').toContain('entity: EntityZ4Route');
  });

  it('GAP: CollabV2App exports no composition, so the rig must copy it', () => {
    const app = readFileSync(join(MODULE_ROOT, 'CollabV2App.tsx'), 'utf8');
    expect(/export\s+(const|function)\s+VIEWS/.test(app)).toBe(false);
    expect(/export\s+function\s+PanelBody/.test(app)).toBe(false);
  });
});
