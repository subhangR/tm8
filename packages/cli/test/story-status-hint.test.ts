/**
 * A story's status is MANUAL (migration 288). The context only HINTS when the
 * task progress plainly disagrees with it, and names the setter.
 */
import { describe, expect, it } from 'vitest';
import { storyContextLines, storyStatusHint } from '../src/story-render.js';

const ID = '01a0fe79-b9b4-7802-a0da-6ddf84a1f983';
const state = (tp: Record<string, number>) => ({
  kind: 'story',
  taskProgress: { work: 0, done: 0, inProgress: 0, toDo: 0, blocked: 0, cancelled: 0, ...tp },
});

describe('storyStatusHint', () => {
  it('suggests in_progress for a to_do story with work under way', () => {
    const [line] = storyStatusHint('to_do', state({ work: 37, done: 1, inProgress: 6, toDo: 30 }), ID);
    expect(line).toContain('status is to_do');
    expect(line).toContain(`tm8 entity update ${ID} --expect-version <n> --status in_progress`);
  });

  it('suggests done when every task is finished', () => {
    const [line] = storyStatusHint('in_progress', state({ work: 4, done: 4 }), ID);
    expect(line).toContain('--status done');
  });

  it.each(['toDo', 'inProgress', 'blocked'])('cancelled tasks cannot complete remaining %s work', bucket => {
    const tp = { work: 2, done: 1, cancelled: 1, [bucket]: 1 };
    expect(storyStatusHint('in_progress', state(tp), ID)).toEqual([]);
    expect(storyStatusHint('to_do', state(tp), ID).join('\n')).not.toContain('--status done');
  });

  it('suggests done when all noncancelled work is complete', () => {
    expect(storyStatusHint('in_progress', state({ work: 2, done: 2, cancelled: 1 }), ID)[0]).toContain('--status done');
    expect(storyStatusHint('to_do', state({ work: 0, cancelled: 3 }), ID)).toEqual([]);
  });

  it('is silent when status and progress agree, or there is no work', () => {
    expect(storyStatusHint('to_do', state({ work: 3, toDo: 3 }), ID)).toEqual([]);
    expect(storyStatusHint('in_progress', state({ work: 3, inProgress: 1, toDo: 2 }), ID)).toEqual([]);
    expect(storyStatusHint('done', state({ work: 2, done: 2 }), ID)).toEqual([]);
    expect(storyStatusHint('to_do', state({}), ID)).toEqual([]);
  });

  it('prints in the context section when the caller passes the status', () => {
    const lines = storyContextLines({ state: state({ work: 2, inProgress: 2 }) }, 'to_do', ID);
    expect(lines.some((l) => l.startsWith('status hint:'))).toBe(true);
    expect(storyContextLines({ state: state({ work: 2, inProgress: 2 }) }).some((l) => l.startsWith('status hint:'))).toBe(false);
  });
});
