// @vitest-environment jsdom
/**
 * THE LIVE DOCK'S THREE STATES.
 *
 * The strip sits above the composer forever, so its failure mode is not
 * looking wrong — it is being furniture. These tests pin the two behaviours
 * that stop it becoming that: it disappears completely when there is nothing,
 * and it collapses itself to one line when the work is over rather than
 * waiting to be dismissed.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LiveDock } from './LiveDock';
import {
  CREW_ALL_DONE,
  CREW_ALL_WORKING,
  CREW_EMPTY,
  CREW_ONE_NEEDS_YOU,
  CREW_ONE_STUCK,
} from './crew-fixtures';

describe('nothing at all', () => {
  it('renders no strip, not an empty one', () => {
    const { container } = render(<LiveDock crew={CREW_EMPTY} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('nothing live', () => {
  it('collapses to a single line that says what happened', () => {
    render(<LiveDock crew={CREW_ALL_DONE} />);
    expect(screen.getByTestId('live-dock').getAttribute('data-state')).toBe('settled');
    expect(screen.getByTestId('live-dock-alldone').textContent).toBe(
      'All done — 2 helpers finished.',
    );
    // Nothing left to disclose, so no disclosure control and no rows.
    expect(screen.queryByTestId('live-dock-toggle')).toBeNull();
    expect(screen.queryAllByTestId('live-dock-row')).toHaveLength(0);
  });

  it('does NOT collapse while a helper is stuck or silent', () => {
    // "Nobody is running" is not "everything is done". Collapsing here would
    // hide the one helper that needs a person behind a finished-looking line.
    render(<LiveDock crew={CREW_ONE_STUCK} />);
    expect(screen.getByTestId('live-dock').getAttribute('data-state')).toBe('live');
    expect(screen.queryByTestId('live-dock-alldone')).toBeNull();
  });
});

describe('something live', () => {
  it('leads with one pill and one line', () => {
    render(<LiveDock crew={CREW_ALL_WORKING} />);
    const head = screen.getByTestId('live-dock-toggle');
    expect(head.textContent).toContain('2 working');
    expect(head.textContent).toContain('Cleaning up the checkout page · 2m so far');
  });

  it('starts closed and expands to a row per helper', () => {
    render(<LiveDock crew={CREW_ALL_WORKING} />);
    expect(screen.queryAllByTestId('live-dock-row')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('live-dock-toggle'));
    const rows = screen.getAllByTestId('live-dock-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('Drafter')).toBeTruthy();
    expect(within(rows[0]!).getByText('Rewriting the checkout page layout')).toBeTruthy();
    expect(within(rows[2]!).getByText('Waiting its turn')).toBeTruthy();
  });

  it('shows every helper when open — the strip does not collapse its own list', () => {
    // The CARD collapses above six because it is a block in the transcript.
    // The dock is already collapsed by default; opening it and then hiding
    // rows would leave a person with no way to see them at all.
    render(<LiveDock crew={CREW_ONE_NEEDS_YOU} />);
    fireEvent.click(screen.getByTestId('live-dock-toggle'));
    expect(screen.getAllByTestId('live-dock-row')).toHaveLength(3);
  });

  it('is urgent only when a helper is asking', () => {
    const { rerender } = render(<LiveDock crew={CREW_ONE_NEEDS_YOU} />);
    expect(screen.getByTestId('live-dock').getAttribute('data-urgent')).toBe('true');
    expect(screen.getByTestId('live-dock-toggle').textContent).toContain('1 needs you');

    rerender(<LiveDock crew={CREW_ALL_WORKING} />);
    expect(screen.getByTestId('live-dock').getAttribute('data-urgent')).toBeNull();
  });

  it('announces ONLY when a helper is asking (P4, design §7)', () => {
    const { rerender } = render(<LiveDock crew={CREW_ALL_WORKING} />);
    // A working→finished transition must be silent.
    expect(screen.getByTestId('live-dock-announce').textContent).toBe('');

    rerender(<LiveDock crew={CREW_ONE_NEEDS_YOU} />);
    expect(screen.getByTestId('live-dock-announce').textContent).toBe(
      'Reviewer needs a word from you.',
    );
    expect(screen.getByTestId('live-dock-announce').getAttribute('aria-live')).toBe('polite');
  });

  it('does not announce a stuck helper — stuck is loud on its row, not in the ear', () => {
    render(<LiveDock crew={CREW_ONE_STUCK} />);
    expect(screen.getByTestId('live-dock-announce').textContent).toBe('');
  });

  it('a stuck crew leads with stuck, not with what else is running', () => {
    render(<LiveDock crew={CREW_ONE_STUCK} />);
    expect(screen.getByTestId('live-dock-toggle').textContent).toContain('1 stuck');
  });

  it('offers the fuller view only when the host has one', () => {
    const onOpenCrew = vi.fn();
    const { rerender } = render(<LiveDock crew={CREW_ALL_WORKING} />);
    fireEvent.click(screen.getByTestId('live-dock-toggle'));
    expect(screen.queryByRole('button', { name: 'Open the full card' })).toBeNull();

    rerender(<LiveDock crew={CREW_ALL_WORKING} onOpenCrew={onOpenCrew} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open the full card' }));
    expect(onOpenCrew).toHaveBeenCalledOnce();
  });

  it('falls back to the summary line when the host named no work', () => {
    render(<LiveDock crew={{ helpers: [{ key: 'k1', role: 'Drafter', state: 'running' }] }} />);
    // A pill beside an empty span is a strip that looks broken; the summary
    // is still a true sentence about the crew.
    expect(screen.getByTestId('live-dock-line').textContent).toBe('1 working');
  });
});
