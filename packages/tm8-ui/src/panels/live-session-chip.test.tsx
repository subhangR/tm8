// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveSessionChip, liveSessionChipOf } from './LiveSessionChip';

const NOW = new Date('2026-10-06T16:00:00.000Z');

describe('LiveSessionChip (P0g: flag only)', () => {
  it('says nothing while someone is on the task', () => {
    for (const state of ['live', 'person'] as const) {
      const { container } = render(<LiveSessionChip live={{ state, since: null, sessionId: null }} now={NOW} />);
      expect(container.textContent).toBe('');
    }
    expect(liveSessionChipOf(undefined)).toBeNull();
  });

  it('flags a task nobody is on, with how long', () => {
    render(<LiveSessionChip live={{ state: 'no_session', since: '2026-10-03T16:00:00.000Z', sessionId: null }} now={NOW} />);
    const chip = screen.getByTestId('live-session-chip');
    expect(chip.textContent).toBe('No live session');
    expect(chip.getAttribute('data-state')).toBe('no_session');
    expect(chip.getAttribute('title')).toContain('For 3d.');
  });

  it('names a crashed session and an idle person distinctly', () => {
    render(<LiveSessionChip live={{ state: 'session_down', since: null, sessionId: 'x' }} now={NOW} />);
    expect(screen.getByText('Session crashed')).toBeTruthy();
    render(<LiveSessionChip live={{ state: 'person_idle', since: '2026-09-01T00:00:00.000Z', sessionId: null }} now={NOW} />);
    expect(screen.getByText('No activity 7d')).toBeTruthy();
  });
});
