// @vitest-environment jsdom
/**
 * The ONE lane line (107) — the honesty rules as unit truths:
 *   · no branch fact ⇒ NO claim (null, and the component renders nothing);
 *   · the mode badge maps workdir facts to the ruled vocabulary
 *     (project ⇒ 'shared' — a link mark, not a word, now carries the honesty);
 *   · a pre-107 summary (neither field) renders nothing rather than a guess.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionLaneLine, isMintedBranch, sessionLaneOf } from './SessionLane.js';

const base = {
  kind: 'work_session',
  status: 'running',
  agentTool: 'claude-code',
  model: null,
  shareMode: 'none',
  startedAt: null,
  exitedAt: null,
};

describe('sessionLaneOf', () => {
  it('reads the worktree lane: branch + attributable mode', () => {
    expect(sessionLaneOf({ ...base, checkoutBranch: 'tm8/ab12cd34', workdirMode: 'worktree' }))
      .toEqual({ branch: 'tm8/ab12cd34', mode: 'worktree' });
  });

  it("maps 'project' to the 'shared' mode fact", () => {
    expect(sessionLaneOf({ ...base, checkoutBranch: 'main', workdirMode: 'project' }))
      .toEqual({ branch: 'main', mode: 'shared' });
  });

  it('renders NO claim for a null branch, whatever the mode says', () => {
    expect(sessionLaneOf({ ...base, checkoutBranch: null, workdirMode: 'scratch' })).toBeNull();
    expect(sessionLaneOf({ ...base, checkoutBranch: null, workdirMode: 'project' })).toBeNull();
  });

  it('renders NO claim for a pre-107 summary that has neither field', () => {
    expect(sessionLaneOf(base)).toBeNull();
  });

  it('answers a branch with no badge when only the branch fact arrived', () => {
    expect(sessionLaneOf({ ...base, checkoutBranch: 'main' })).toEqual({ branch: 'main', mode: null });
  });

  it('reads nothing from a non-session state', () => {
    expect(sessionLaneOf({ kind: 'task', status: 'open' })).toBeNull();
    expect(sessionLaneOf(null)).toBeNull();
  });
});

describe('SessionLaneLine', () => {
  it('draws the branch glyph, the name and the worktree SYMBOL, never the word', () => {
    render(<SessionLaneLine lane={{ branch: 'tm8/ab12cd34', mode: 'worktree' }} />);
    const line = screen.getByTestId('session-lane-line');
    expect(line.textContent).toContain('tm8/ab12cd34');
    // The mark replaces the green word outright — no pill is drawn at all —
    // and the symbol carries the meaning as a labelled `img`. (Asserting on
    // textContent would be blind here: the svg's own <title> counts as text.)
    expect(line.querySelector('.kit-pill')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('worktree');
  });

  it('a shared checkout draws the link SYMBOL, never the word', () => {
    render(<SessionLaneLine lane={{ branch: 'main', mode: 'shared' }} />);
    const line = screen.getByTestId('session-lane-line');
    // Same treatment as `worktree`: the mark replaces the toned word outright
    // — no pill is drawn — and the symbol carries the meaning as a labelled
    // `img`, not a hardcoded string match on rendered text.
    expect(line.querySelector('.kit-pill')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('not exclusively');
  });

  it('renders NOTHING for null — honest absence draws no placeholder', () => {
    const { container } = render(<SessionLaneLine lane={null} />);
    expect(container.innerHTML).toBe('');
  });
});

/**
 * THE COMPACT TILE FORM (user ruling 2026-09-24): a minted `tm8/<uuid>` lane
 * branch is the worktree id spelled out, so the list tile draws the worktree
 * mark alone — and the mark is a door onto the worktree tile. The Git tab
 * (no `compact`) keeps the full name.
 */
describe('SessionLaneLine — compact tile form', () => {
  const minted = 'tm8/01a0d301-f012-73a7-9763-016e3316c16f';

  it('recognises only the branches tm8 mints', () => {
    expect(isMintedBranch(minted)).toBe(true);
    expect(isMintedBranch('tm8/chat/01a0d302-9ea9-7b63-b9df-a1f0806979b5')).toBe(true);
    expect(isMintedBranch('feat/login-fix')).toBe(false);
    expect(isMintedBranch('tm8/ab12cd34')).toBe(false);
    expect(isMintedBranch('main')).toBe(false);
  });

  it('collapses a minted branch to the mark, keeping the name in its tooltip', () => {
    render(<SessionLaneLine lane={{ branch: minted, mode: 'worktree' }} compact />);
    const line = screen.getByTestId('session-lane-line');
    expect(line.querySelector('.pn-lane__branch')).toBeNull();
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain(minted);
  });

  it('keeps a human-named branch on the tile', () => {
    render(<SessionLaneLine lane={{ branch: 'feat/login-fix', mode: 'worktree' }} compact />);
    expect(screen.getByTestId('session-lane-line').querySelector('.pn-lane__branch')?.textContent)
      .toContain('feat/login-fix');
  });

  it('leaves a shared checkout exactly as it was — no worktree to open', () => {
    const onToggle = vi.fn();
    render(
      <SessionLaneLine lane={{ branch: 'main', mode: 'shared' }} compact door={{ open: false, onToggle }} />,
    );
    expect(screen.getByTestId('session-lane-line').textContent).toContain('main');
    expect(screen.queryByTestId('session-lane-worktree-door')).toBeNull();
  });

  it('the full form (Git tab) still spells a minted branch out', () => {
    render(<SessionLaneLine lane={{ branch: minted, mode: 'worktree' }} />);
    expect(screen.getByTestId('session-lane-line').textContent).toContain(minted);
  });

  it('with a door, the mark is a toggle button that does not select the row', () => {
    const onToggle = vi.fn();
    const onRow = vi.fn();
    const { rerender } = render(
      <div onClick={onRow}>
        <SessionLaneLine lane={{ branch: minted, mode: 'worktree' }} compact door={{ open: false, onToggle, controlsId: 'g1' }} />
      </div>,
    );
    const door = screen.getByTestId('session-lane-worktree-door');
    expect(door.getAttribute('aria-expanded')).toBe('false');
    expect(door.getAttribute('aria-label')).toMatch(/^Show this session’s worktree/);
    fireEvent.click(door);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onRow).not.toHaveBeenCalled();
    rerender(
      <div onClick={onRow}>
        <SessionLaneLine lane={{ branch: minted, mode: 'worktree' }} compact door={{ open: true, onToggle, controlsId: 'g1' }} />
      </div>,
    );
    const open = screen.getByTestId('session-lane-worktree-door');
    expect(open.getAttribute('aria-expanded')).toBe('true');
    expect(open.getAttribute('aria-controls')).toBe('g1');
    expect(open.className).toContain('pn-st__count--open');
  });
});
