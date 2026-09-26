/**
 * W11-migrate report logic (plan 01a0d9eb §3 W11 steps 1, 2, 4; K13 as the
 * owner's explicit mapping). Pure: no database. #845's
 * test/projects/owning-space.test.ts covers pickOwningSpace itself. The pg test (test/db/w11-migrate-report.pg.test.ts) covers the
 * evidence read.
 */
import { describe, expect, it } from 'vitest';

import {
  buildW11Report,
  formatW11Report,
  parseOwningSpaceMapping,
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

const map = (entries: Record<string, string>) => new Map(Object.entries(entries));
const report = (evidence: W11Evidence[], mapping: Record<string, string>) =>
  buildW11Report({ evidence, mapping: map(mapping), nodeOwnerIdentity: OWNER, asOf: '2026-09-24T18:40:00.000Z' });

describe('buildW11Report', () => {
  const f = [
    row({ folderId: 'f', spaceId: 'a', sessionsInWindow: 3 }),
    row({ folderId: 'f', spaceId: 'b', spaceCreatedBy: OTHER, chatsInWindow: 1, worktreeBranches: ['b/x'] }),
  ];

  it('the owner is the mapped space even when it has less activity; activity is a report column', () => {
    const [p] = report(f, { f: 'b' }).projects;
    expect(p!.decision).toEqual({ ok: true, spaceId: 'b' });
    expect(p!.spaces.map((s) => [s.spaceId, s.activity30d, s.createdByOwner, s.action]))
      .toEqual([['a', 3, true, 'owner_decides'], ['b', 1, false, 'keep']]);
  });

  it('an idle other space is unlinked; an active one is left to the owner', () => {
    const idle = [row({ folderId: 'f', spaceId: 'a' }), row({ folderId: 'f', spaceId: 'b', sessions: 5 })];
    expect(report(idle, { f: 'a' }).projects[0]!.spaces.map((s) => s.action)).toEqual(['keep', 'unlink']);
    expect(report(f, { f: 'a' }).projects[0]!.spaces.map((s) => s.action)).toEqual(['keep', 'owner_decides']);
  });

  it('an unmapped folder has no owner and no actions; a mapping outside its grants is refused too', () => {
    expect(report(f, {}).projects[0]).toMatchObject({ decision: { ok: false, reason: 'unmapped' } });
    expect(report(f, {}).projects[0]!.spaces.map((s) => s.action)).toEqual([null, null]);
    expect(report(f, { f: 'c' }).projects[0]!.decision).toEqual({ ok: false, reason: 'mapped_space_not_granted', spaceId: 'c' });
  });

  it('the node owner only sets a column: swapping who created the spaces changes no decision', () => {
    const swapped = f.map((r) => ({ ...r, spaceCreatedBy: r.spaceCreatedBy === OWNER ? OTHER : OWNER }));
    expect(report(swapped, { f: 'b' }).projects[0]!.decision).toEqual(report(f, { f: 'b' }).projects[0]!.decision);
  });

  it('one row per folder, sorted by name, with live sessions summed across spaces', () => {
    const r = report([
      row({ folderId: 'z', spaceId: 'a', liveSessions: 1 }),
      row({ folderId: 'z', spaceId: 'b', liveSessions: 2 }),
      row({ folderId: 'm', spaceId: 'a' }),
      row({ folderId: 'm', spaceId: 'b' }),
    ], { z: 'a', m: 'b' });
    expect(r.projects.map((p) => [p.folderId, p.liveSessions])).toEqual([['m', 0], ['z', 3]]);
  });

  it('the markdown names the mapped owner and marks a refused folder', () => {
    const out = formatW11Report(report([...f, row({ folderId: 'g', spaceId: 'a' }), row({ folderId: 'g', spaceId: 'b' })], { f: 'b' }));
    expect(out).toContain('| F `/tmp/f` | B | A → owner_decides | 0 |');
    expect(out).toContain('| G `/tmp/g` | REFUSED: not in the mapping | — | 0 |');
  });
});

describe('realRunRefusals (plan step 4; K13 mapping)', () => {
  const quiet = [row({ folderId: 'f', spaceId: 'a' }), row({ folderId: 'f', spaceId: 'b' })];
  const live = [row({ folderId: 'f', spaceId: 'a' }), row({ folderId: 'f', spaceId: 'b', liveSessions: 1 })];

  it('refuses a folder the mapping leaves out; the same folder mapped passes', () => {
    expect(realRunRefusals(report(quiet, {}))).toEqual([{ code: 'unmapped', folderId: 'f' }]);
    expect(realRunRefusals(report(quiet, { f: 'a' }))).toEqual([]);
  });

  it('refuses a mapping to a space the folder is not granted to', () => {
    expect(realRunRefusals(report(quiet, { f: 'c' }))).toEqual([{ code: 'mapped_space_not_granted', folderId: 'f', spaceId: 'c' }]);
    expect(realRunRefusals(report(quiet, { f: 'b' }))).toEqual([]);
  });

  it('refuses a folder with a live session in either space; the same folder idle passes', () => {
    expect(realRunRefusals(report(live, { f: 'a' }))).toEqual([{ code: 'live_sessions', folderId: 'f', liveSessions: 1 }]);
    expect(realRunRefusals(report(quiet, { f: 'a' }))).toEqual([]);
  });
});

describe('parseOwningSpaceMapping', () => {
  it('reads folder id -> space id', () => {
    expect([...parseOwningSpaceMapping('{"f":"a","g":"b"}')]).toEqual([['f', 'a'], ['g', 'b']]);
  });
  it('rejects anything that is not an object of non-empty strings', () => {
    for (const bad of ['[]', 'null', '"x"', '{"f":1}', '{"f":""}']) {
      expect(() => parseOwningSpaceMapping(bad)).toThrow(/mapping/);
    }
  });
});
