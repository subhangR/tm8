// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { EntitySummary } from '@tm8/contract';
import { createFixtureLoopsClient, fixtureLoopViewOf } from './fixture';
import { loopRowNoteOf } from './LoopRowNote';
import { loopRowStatus } from './row-facts';

afterEach(cleanup);

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const row = (state: Partial<Extract<EntitySummary['state'], { kind: 'loop' }>> = {}, id = 'loop-1') => ({
  id, kind: 'loop', title: 'Nightly', spaceId: 'sp-1',
  state: {
    kind: 'loop', action: 'spawn', schedule: 'every 2h', timezone: 'UTC', enabled: true, pausedUntil: null,
    teamMemberId: 'tm-1', toolId: null, subjectId: null, nextRunAt: inHours(2), lastRunAt: null, lastError: null, ...state,
  },
}) as unknown as EntitySummary;

describe('a loop row in the generic lists', () => {
  it('draws the stored schedule and the server\'s next run; nothing for another kind', () => {
    render(<div>{loopRowNoteOf(row())}</div>);
    const note = screen.getByTestId('loop-row-note-loop-1');
    expect(note.textContent).toContain('every 2h · UTC');
    expect(note.textContent).toMatch(/next in 2h/);
    expect(loopRowNoteOf({ ...row(), kind: 'task', state: { kind: 'task' } } as unknown as EntitySummary)).toBeNull();
  });

  it('an expired pause reads as enabled; a last error is named, never called a failed run', () => {
    expect(loopRowStatus(row({ pausedUntil: inHours(-1) }).state as never)).toBe('enabled');
    render(<div>{loopRowNoteOf(row({ lastError: 'schedule never matches within a year', nextRunAt: null }))}</div>);
    const note = screen.getByTestId('loop-row-note-loop-1');
    expect(note.textContent).toContain('last error');
    expect(note.textContent).not.toContain('failed');
    expect(note.querySelector('[title]')?.getAttribute('title')).toBeTruthy();
  });
});

describe('the fixture loops client', () => {
  it('answers for the fixture loop entities and filters by words and limit like the server', async () => {
    const views = [row({}, 'a'), { ...row({}, 'b'), title: 'Daily digest' }, { ...row({}, 'c'), title: 'Nightly digest' }]
      .map(r => fixtureLoopViewOf(r as EntitySummary)!);
    const client = createFixtureLoopsClient(views);
    expect((await client.list('sp-1' as never, { words: 'digest nightly' })).items.map(v => v.id)).toEqual(['c']);
    const first = await client.list('sp-1' as never, { limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = await client.list('sp-1' as never, { limit: 2, cursor: first.nextCursor! });
    expect(second).toMatchObject({ nextCursor: null });
    expect(second.items.map(v => v.id)).toEqual(['c']);
  });
});
