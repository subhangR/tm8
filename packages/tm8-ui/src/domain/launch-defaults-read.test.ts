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
  defaultsNote,
  defaultsChanges,
  launchDefaultsKey,
  nextDefaultsRead,
  NO_TEAMMATE_DEFAULTS_NOTE,
  selectionDefaultsOf,
  shownAnswer,
  UNCONFIRMED_DEFAULTS_NOTE,
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
  it('with an earlier answer it is CACHED: every group draws that answer, ready with confirmation `pending`', () => {
    const read = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    expect(read.phase).toBe('cached');
    const groups = selectionDefaultsOf(read);
    expect(groups.memories).toMatchObject({ status: 'ready', confirmation: 'pending', total: 1 });
    expect(groups.references.status === 'ready' && groups.references.rows.map((r) => r.id)).toEqual(['ent-doc-spec', 'ent-file-log']);
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
    const references = selectionDefaultsOf(read).references;
    expect(references.status === 'ready' && references.confirmation).toBeUndefined();
    expect(defaultsNote(read)).toBeNull();
  });

  it('cached → CONFIRMED with a different set: the changed group is named, with how', () => {
    const cached = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    const read = nextDefaultsRead(cached, { type: 'answered', key: 'k1', result: WITH_EXTRA_SKILL });
    expect(read).toMatchObject({ phase: 'confirmed', changed: [{ group: 'skills', added: 1, removed: 0 }] });
    expect(defaultsNote(read)).toBe('This launch’s defaults changed since you last opened it: skills +1.');
  });

  it('loading → CONFIRMED: a first answer is never reported as a change', () => {
    const loading = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: null });
    const read = nextDefaultsRead(loading, { type: 'answered', key: 'k1', result: WITH_EXTRA_SKILL });
    expect(read).toMatchObject({ phase: 'confirmed', changed: [] });
    expect(defaultsNote(read)).toBeNull();
  });

  it('an answer for ANOTHER key changes nothing — a slow read for the previous teammate never lands', () => {
    const now = nextDefaultsRead(IDLE, { type: 'open', key: 'k2', cached: null });
    expect(nextDefaultsRead(now, { type: 'answered', key: 'k1', result: LAUNCH_DEFAULTS })).toBe(now);
    expect(nextDefaultsRead(now, { type: 'failed', key: 'k1' })).toBe(now);
  });

  it('a later answer for a confirmed key: the same set changes nothing, a different one replaces it and is named', () => {
    const confirmed = nextDefaultsRead(nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: null }), { type: 'answered', key: 'k1', result: LAUNCH_DEFAULTS });
    expect(nextDefaultsRead(confirmed, { type: 'answered', key: 'k1', result: LAUNCH_DEFAULTS })).toBe(confirmed);
    expect(nextDefaultsRead(confirmed, { type: 'answered', key: 'k1', result: WITH_EXTRA_SKILL }))
      .toMatchObject({ phase: 'confirmed', result: WITH_EXTRA_SKILL, changed: [{ group: 'skills', added: 1, removed: 0 }] });
  });

  it('an answer recovers a FAILED read (a re-read through a new loader, not a retry) — compared with what was shown', () => {
    const failed = nextDefaultsRead(nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS }), { type: 'failed', key: 'k1' });
    expect(nextDefaultsRead(failed, { type: 'answered', key: 'k1', result: WITH_EXTRA_SKILL }))
      .toMatchObject({ phase: 'confirmed', changed: [{ group: 'skills', added: 1, removed: 0 }] });
  });

  it('a failure over a cached answer KEEPS it on the card, marked failed, and says so', () => {
    const cached = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    const read = nextDefaultsRead(cached, { type: 'failed', key: 'k1' });
    expect(read).toMatchObject({ phase: 'failed', shown: LAUNCH_DEFAULTS });
    const skills = selectionDefaultsOf(read).skills;
    // Still drawn, marked `failed`: an EDITED group now blocks Launch until a retry confirms it.
    expect(skills).toMatchObject({ status: 'ready', confirmation: 'failed', total: 1 });
    expect(shownAnswer(read)).toBe(LAUNCH_DEFAULTS);
    expect(defaultsNote(read)).toBe(UNCONFIRMED_DEFAULTS_NOTE);
  });

  it('retry re-opens a failed read: back to cached with what was shown (or loading), never another key', () => {
    const cached = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: LAUNCH_DEFAULTS });
    const failed = nextDefaultsRead(cached, { type: 'failed', key: 'k1' });
    expect(nextDefaultsRead(failed, { type: 'retry', key: 'k2' })).toBe(failed);
    expect(nextDefaultsRead(failed, { type: 'retry', key: 'k1' })).toEqual({ phase: 'cached', key: 'k1', cached: LAUNCH_DEFAULTS });
    const bare = nextDefaultsRead(nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: null }), { type: 'failed', key: 'k1' });
    expect(nextDefaultsRead(bare, { type: 'retry', key: 'k1' })).toEqual({ phase: 'loading', key: 'k1' });
    // Only a failed read retries.
    expect(nextDefaultsRead(cached, { type: 'retry', key: 'k1' })).toBe(cached);
  });

  it('a failure with nothing cached is FAILED — every group unknown, nothing said beyond the groups’ own reason', () => {
    const loading = nextDefaultsRead(IDLE, { type: 'open', key: 'k1', cached: null });
    const read = nextDefaultsRead(loading, { type: 'failed', key: 'k1' });
    expect(read).toEqual({ phase: 'failed', key: 'k1', shown: null });
    expect(selectionDefaultsOf(read).skills).toEqual({ status: 'unknown', reason: UNKNOWN_DEFAULTS_NOTE, readFailed: true });
    expect(shownAnswer(read)).toBeNull();
    expect(defaultsNote(read)).toBeNull();
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
