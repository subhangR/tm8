/**
 * W11-migrate report logic (plan 01a0d9eb §3 W11 steps 1, 2, 4; K13). Pure: no
 * database. The pg test (test/db/w11-migrate-report.pg.test.ts) covers the
 * evidence read.
 */
import { describe, expect, it } from 'vitest';

import { pickOwningSpace } from '../../src/projects/owning-space.js';
import {
  buildW11Report,
  formatW11Report,
  realRunRefusals,
  type W11Evidence,
} from '../../src/projects/w11-migrate.js';

const OWNER = 'id_owner';
const OTHER = 'id_other';

function row(over: Partial<W11Evidence> & Pick<W11Evidence, 'folderId' | 'spaceId'>): W11Evidence {
  return {
    folderName: over.folderId.toUpperCase(),
    workingDir: `/tmp/${over.folderId}`,
    spaceName: over.spaceId.toUpperCase(),
    spaceCreatedAt: '2026-08-01T00:00:00.000Z',
    spaceCreatedBy: OWNER,
    sessions: 0,
    sessionsInWindow: 0,
    liveSessions: 0,
    lastSessionAt: null,
    chats: 0,
    chatsInWindow: 0,
    lastChatAt: null,
    worktrees: 0,
    activeWorktrees: 0,
    worktreeBranches: [],
    ...over,
  };
}

const report = (evidence: W11Evidence[], personalIdentity: string | null = OWNER) =>
  buildW11Report({ evidence, personalIdentity, asOf: '2026-09-24T18:40:00.000Z' });

describe('pickOwningSpace (K13)', () => {
  const at = (d: string) => `2026-08-${d}T00:00:00.000Z`;
  it('most activity wins over the tie-break', () => {
    expect(pickOwningSpace([
      { spaceId: 'a', activity30d: 1, createdByOwner: true, createdAt: at('01') },
      { spaceId: 'b', activity30d: 2, createdByOwner: false, createdAt: at('02') },
    ])).toBe('b');
  });
  it('a tie goes to the owner-created space, then the oldest, then the lowest id', () => {
    expect(pickOwningSpace([
      { spaceId: 'a', activity30d: 0, createdByOwner: false, createdAt: at('01') },
      { spaceId: 'b', activity30d: 0, createdByOwner: true, createdAt: at('02') },
    ])).toBe('b');
    expect(pickOwningSpace([
      { spaceId: 'b', activity30d: 0, createdByOwner: false, createdAt: at('01') },
      { spaceId: 'a', activity30d: 0, createdByOwner: false, createdAt: at('02') },
    ])).toBe('b');
    expect(pickOwningSpace([
      { spaceId: 'b', activity30d: 0, createdByOwner: false, createdAt: at('01') },
      { spaceId: 'a', activity30d: 0, createdByOwner: false, createdAt: at('01') },
    ])).toBe('a');
  });
});

describe('buildW11Report', () => {
  it('owner = most sessions + chats in the window; an idle other space is unlinked', () => {
    const r = report([
      row({ folderId: 'f', spaceId: 'a', sessions: 5, sessionsInWindow: 0 }),
      row({ folderId: 'f', spaceId: 'b', spaceCreatedBy: OTHER, sessionsInWindow: 1, chatsInWindow: 1 }),
    ]);
    expect(r.projects).toHaveLength(1);
    const [p] = r.projects;
    expect(p!.owningSpaceId).toBe('b');
    expect(p!.tie).toBe(false);
    expect(p!.spaces.map((s) => [s.spaceId, s.activity, s.action])).toEqual([['a', 0, 'unlink'], ['b', 2, 'keep']]);
  });

  it('an active other space gets a clone, carrying its branches', () => {
    const r = report([
      row({ folderId: 'f', spaceId: 'a', sessionsInWindow: 3 }),
      row({ folderId: 'f', spaceId: 'b', spaceCreatedBy: OTHER, chatsInWindow: 1, worktreeBranches: ['b/x'] }),
    ]);
    const b = r.projects[0]!.spaces.find((s) => s.spaceId === 'b')!;
    expect(b.action).toBe('clone');
    expect(formatW11Report(r)).toContain('B → clone (1 branch(es))');
  });

  it('a tie is flagged and follows the personal identity it is given', () => {
    const evidence = [
      row({ folderId: 'f', spaceId: 'a', spaceCreatedAt: '2026-08-01T00:00:00.000Z' }),
      row({ folderId: 'f', spaceId: 'b', spaceCreatedBy: OTHER, spaceCreatedAt: '2026-08-21T00:00:00.000Z' }),
    ];
    expect(report(evidence, OWNER).projects[0]).toMatchObject({ owningSpaceId: 'a', tie: true });
    expect(report(evidence, OTHER).projects[0]).toMatchObject({ owningSpaceId: 'b', tie: true });
  });

  it('one row per folder, sorted by name, with live sessions summed across spaces', () => {
    const r = report([
      row({ folderId: 'z', spaceId: 'a', liveSessions: 1 }),
      row({ folderId: 'z', spaceId: 'b', liveSessions: 2 }),
      row({ folderId: 'm', spaceId: 'a' }),
      row({ folderId: 'm', spaceId: 'b' }),
    ]);
    expect(r.projects.map((p) => [p.folderId, p.liveSessions])).toEqual([['m', 0], ['z', 3]]);
  });
});

describe('realRunRefusals (plan step 4; K13 confirmation)', () => {
  const quiet = report([row({ folderId: 'f', spaceId: 'a' }), row({ folderId: 'f', spaceId: 'b' })]);
  const live = report([row({ folderId: 'f', spaceId: 'a' }), row({ folderId: 'f', spaceId: 'b', liveSessions: 1 })]);

  it('refuses without a confirmed table; proceeds with one', () => {
    expect(realRunRefusals(quiet, null)).toEqual([{ code: 'no_confirmed_table' }]);
    expect(realRunRefusals(quiet, { f: 'a' })).toEqual([]);
  });

  it('refuses a folder the table leaves out, or confirms to a space it is not granted to', () => {
    expect(realRunRefusals(quiet, {})).toEqual([{ code: 'folder_not_confirmed', folderId: 'f' }]);
    expect(realRunRefusals(quiet, { f: 'c' })).toEqual([{ code: 'confirmed_space_not_granted', folderId: 'f', spaceId: 'c' }]);
    expect(realRunRefusals(quiet, { f: 'b' })).toEqual([]);
  });

  it('refuses a folder with a live session in either space; the same folder idle passes', () => {
    expect(realRunRefusals(live, { f: 'a' })).toEqual([{ code: 'live_sessions', folderId: 'f', liveSessions: 1 }]);
    expect(realRunRefusals(quiet, { f: 'a' })).toEqual([]);
  });
});
