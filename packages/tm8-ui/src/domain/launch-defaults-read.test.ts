/**
 * THE LAUNCH DEFAULTS READ'S STATE MACHINE — every transition, and the two
 * promises it makes the card: a cached answer is drawn but never called
 * confirmed by anything except this read's own answer, and a confirmation that
 * changes nothing visible says nothing.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchDefaultsResult } from '@tm8/contract';

import { LAUNCH_DEFAULTS } from '../views/launch-fixtures';
import {
  changedDefaultsNote,
  defaultsChanges,
  launchDefaultsKey,
  nextDefaultsRead,
  NO_TEAMMATE_DEFAULTS_NOTE,
  selectionDefaultsOf,
  shownAnswer,
  type LaunchDefaultsRead,
} from './launch-defaults-read';
import { UNKNOWN_DEFAULTS_NOTE } from './launch-selection';

const IDLE: LaunchDefaultsRead = { phase: 'idle', key: null, reason: '' };

/** The fixture with one more skill default — what the node says after a skill was equipped. */
const WITH_EXTRA_SKILL: LaunchDefaultsResult = {
  ...LAUNCH_DEFAULTS,
  skills: {
    ...LAUNCH_DEFAULTS.skills,
    items: [...LAUNCH_DEFAULTS.skills.items, { entityId: 'ent-sk-new', kind: 'skill', title: 'graphify', via: 'teammate', headerText: null, headerSource: null, promptBytes: 120 }],
    total: 2,
  },
};

describe('the read opens on a launch key', () => {
  it('with an earlier answer it is CACHED, and every group draws that answer as `cached`', () => {
    const read = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    expect(read.phase).toBe('cached');
    const groups = selectionDefaultsOf(read);
    expect(groups.memories).toMatchObject({ status: 'cached', total: 1 });
    expect(groups.references.status === 'cached' && groups.references.rows.map((r) => r.id)).toEqual(['ent-doc-spec', 'ent-file-log']);
    expect(shownAnswer(read)).toBe(LAUNCH_DEFAULTS);
  });

  it('without one it is LOADING, and nothing is drawn', () => {
    const read = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: null });
    expect(read.phase).toBe('loading');
    expect(selectionDefaultsOf(read).skills).toEqual({ status: 'loading' });
    expect(shownAnswer(read)).toBeNull();
  });

  it('closes to IDLE with its reason, every group unknown with it', () => {
    const read = nextDefaultsRead(IDLE, { type: 'close', reason: NO_TEAMMATE_DEFAULTS_NOTE });
    expect(read).toEqual({ phase: 'idle', key: null, reason: NO_TEAMMATE_DEFAULTS_NOTE });
    expect(selectionDefaultsOf(read).memories).toEqual({ status: 'unknown', reason: NO_TEAMMATE_DEFAULTS_NOTE });
    // Closing again for the same reason is no change at all (same object: no re-render).
    expect(nextDefaultsRead(read, { type: 'close', reason: NO_TEAMMATE_DEFAULTS_NOTE })).toBe(read);
  });
});

describe('the node answers', () => {
  it('cached → CONFIRMED with the same set: nothing changed, and the note stays silent', () => {
    const cached = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    const reordered: LaunchDefaultsResult = {
      ...LAUNCH_DEFAULTS,
      references: { ...LAUNCH_DEFAULTS.references, items: [...LAUNCH_DEFAULTS.references.items].reverse() },
    };
    const read = nextDefaultsRead(cached, { type: 'answered', key: 'k1', result: reordered });
    expect(read).toMatchObject({ phase: 'confirmed', changed: [] });
    expect(selectionDefaultsOf(read).references.status).toBe('ready');
    expect(changedDefaultsNote(read)).toBeNull();
  });

  it('cached → CONFIRMED with a different set: the changed group is named, with how', () => {
    const cached = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    const read = nextDefaultsRead(cached, { type: 'answered', key: 'k1', result: WITH_EXTRA_SKILL });
    expect(read).toMatchObject({ phase: 'confirmed', changed: [{ group: 'skills', added: 1, removed: 0 }] });
    expect(changedDefaultsNote(read)).toBe('This launch’s defaults changed since you last opened it: skills +1.');
  });

  it('loading → CONFIRMED: a first answer is never reported as a change', () => {
    const loading = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: null });
    const read = nextDefaultsRead(loading, { type: 'answered', key: 'k1', result: WITH_EXTRA_SKILL });
    expect(read).toMatchObject({ phase: 'confirmed', changed: [] });
    expect(changedDefaultsNote(read)).toBeNull();
  });

  it('an answer for ANOTHER key changes nothing — a slow read for the previous teammate never lands', () => {
    const now = nextDefaultsRead(IDLE, { type: 'open', key: 'k2', cached: null });
    expect(nextDefaultsRead(now, { type: 'answered', key: 'k1', result: LAUNCH_DEFAULTS })).toBe(now);
    expect(nextDefaultsRead(now, { type: 'failed', key: 'k1' })).toBe(now);
  });

  it('a second answer for a confirmed key changes nothing', () => {
    const confirmed = nextDefaultsRead(nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: null }), { type: 'answered', key: 'k1', result: LAUNCH_DEFAULTS });
    expect(nextDefaultsRead(confirmed, { type: 'answered', key: 'k1', result: WITH_EXTRA_SKILL })).toBe(confirmed);
  });

  it('a failure is FAILED — every group unknown, the cached rows withdrawn rather than left standing unconfirmed', () => {
    const cached = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    const read = nextDefaultsRead(cached, { type: 'failed', key: 'k1' });
    expect(read.phase).toBe('failed');
    expect(selectionDefaultsOf(read).skills).toEqual({ status: 'unknown', reason: UNKNOWN_DEFAULTS_NOTE });
    expect(shownAnswer(read)).toBeNull();
  });
});

describe('what counts as a change', () => {
  it('is the default SET per group — additions and removals counted separately', () => {
    const fewer: LaunchDefaultsResult = { ...WITH_EXTRA_SKILL, references: { ...LAUNCH_DEFAULTS.references, items: LAUNCH_DEFAULTS.references.items.slice(0, 1), total: 1 } };
    expect(defaultsChanges(LAUNCH_DEFAULTS, fewer)).toEqual([
      { group: 'skills', added: 1, removed: 0 },
      { group: 'references', added: 0, removed: 1 },
    ]);
  });

  it('keys a read by exactly what `launch.defaults` answers for', () => {
    expect(launchDefaultsKey({ teamMemberId: 'tm' as never })).toBe('tm|||');
    expect(launchDefaultsKey({ teamMemberId: 'tm' as never, subjectId: 's' as never, agentTool: 'codex', interactionProfileId: 'p' as never })).toBe('tm|s|codex|p');
  });
});
