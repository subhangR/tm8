import { describe, expect, it } from 'vitest';

import {
  launchFolderSpace,
  pickOwningSpace,
  type OwningSpaceReportRow,
} from '../../src/projects/owning-space.js';

/**
 * K13 per Subhang's note on form 01a0db32: the owning space comes from an
 * explicit owner-confirmed mapping; an unmapped project is refused. The
 * fixture is the W11 dry run's seven multi-linked projects (report doc
 * 01a0db2d-aaed) with their activity and owner columns — which a heuristic
 * would have followed, and which the rule must ignore.
 */
const UTHO_PROD = 'space:utho-prod';
const REPORT: OwningSpaceReportRow[] = [
  { projectId: 'BeFree', spaceId: UTHO_PROD, activity30d: 102, createdByOwner: true },
  { projectId: 'lvlup', spaceId: 'space:lvlup', activity30d: 8, createdByOwner: false },
  { projectId: 'TA', spaceId: 'space:uhn', activity30d: 1, createdByOwner: false },
  { projectId: 'Hustle', spaceId: UTHO_PROD, activity30d: 0, createdByOwner: true },
  { projectId: 'NutriSnack', spaceId: UTHO_PROD, activity30d: 0, createdByOwner: true },
  { projectId: 'VibeKit', spaceId: UTHO_PROD, activity30d: 0, createdByOwner: true },
  { projectId: 'Will', spaceId: UTHO_PROD, activity30d: 0, createdByOwner: true },
];
const MAPPING = new Map([
  ['tm8', UTHO_PROD],
  ['BeFree', 'space:befree'],
  ['lvlup', 'space:lvlup'],
  ['VibeKit', 'space:vibekit'],
]);

describe('pickOwningSpace — the K13 rule is the mapping', () => {
  it('a mapped project resolves to its mapped space, whatever its activity or owner columns say', () => {
    expect(pickOwningSpace('BeFree', MAPPING)).toEqual({ ok: true, projectId: 'BeFree', spaceId: 'space:befree' });
    expect(pickOwningSpace('lvlup', MAPPING)).toEqual({ ok: true, projectId: 'lvlup', spaceId: 'space:lvlup' });
    expect(pickOwningSpace('VibeKit', MAPPING)).toEqual({ ok: true, projectId: 'VibeKit', spaceId: 'space:vibekit' });
    expect(pickOwningSpace('tm8', MAPPING)).toEqual({ ok: true, projectId: 'tm8', spaceId: UTHO_PROD });
  });

  it('an unmapped project is refused — never defaulted to the owner\'s or the busiest space', () => {
    for (const projectId of ['TA', 'Hustle', 'NutriSnack', 'Will']) {
      expect(pickOwningSpace(projectId, MAPPING)).toEqual({ ok: false, projectId, reason: 'unmapped' });
    }
    expect(pickOwningSpace('BeFree', new Map())).toEqual({ ok: false, projectId: 'BeFree', reason: 'unmapped' });
  });

  it('over the whole dry-run fixture: 3 resolve, 4 refuse', () => {
    const decisions = REPORT.map((row) => pickOwningSpace(row.projectId, MAPPING));
    expect(decisions.filter((d) => d.ok).map((d) => d.projectId)).toEqual(['BeFree', 'lvlup', 'VibeKit']);
    expect(decisions.filter((d) => !d.ok).map((d) => d.projectId)).toEqual(['TA', 'Hustle', 'NutriSnack', 'Will']);
  });
});

describe('launchFolderSpace — fresh-node launch grant (not K13)', () => {
  it('the owner\'s oldest space, then the oldest, then the lowest id; order-independent', () => {
    const a = { spaceId: 'b', createdByOwner: false, createdAt: '2026-01-01T00:00:00Z' };
    const b = { spaceId: 'c', createdByOwner: true, createdAt: '2026-03-01T00:00:00Z' };
    const c = { spaceId: 'a', createdByOwner: true, createdAt: '2026-02-01T00:00:00Z' };
    expect(launchFolderSpace([a, b, c])).toBe('a');
    expect(launchFolderSpace([c, b, a])).toBe('a');
    expect(launchFolderSpace([a])).toBe('b');
    expect(launchFolderSpace([])).toBeNull();
  });
});
