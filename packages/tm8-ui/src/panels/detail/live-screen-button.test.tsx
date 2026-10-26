// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { LiveScreenButton, liveCommandOf } from './LiveScreenButton';

function task(description: string, extra: Partial<EntityDetail> = {}): EntityDetail {
  return { id: 't1', kind: 'task', deletedAt: null, category: 'in_progress', content: { description }, ...extra } as unknown as EntityDetail;
}

describe('liveCommandOf', () => {
  it('reads the live: line of a task description', () => {
    expect(liveCommandOf(task('Testing the app.\nlive: /w/bin/jm-live iphone shopping\nmore'), true)).toBe('/w/bin/jm-live iphone shopping');
  });
  it('is off without the line, on finished tasks, and on other kinds', () => {
    expect(liveCommandOf(task('no stream here'), true)).toBeNull();
    expect(liveCommandOf(task('live: x', { category: 'done' } as Partial<EntityDetail>), true)).toBeNull();
    expect(liveCommandOf(task('live: x', { category: 'cancelled' } as Partial<EntityDetail>), true)).toBeNull();
    expect(liveCommandOf(task('live: x'), false)).toBeNull();
    expect(liveCommandOf(task('live:   '), true)).toBeNull();
    expect(liveCommandOf(task(`live: ${'x'.repeat(501)}`), true)).toBeNull();
  });
});

describe('LiveScreenButton', () => {
  it('hands the command to the host and never more', () => {
    const onWatch = vi.fn();
    render(<LiveScreenButton command="jm-live iphone" onWatch={onWatch} />);
    fireEvent.click(screen.getByTestId('watch-live'));
    expect(onWatch).toHaveBeenCalledWith('jm-live iphone');
    expect(screen.getByTestId('watch-live').textContent).toContain('Watch live');
  });
});
