// @vitest-environment jsdom
/**
 * The ONE lane line (107) — the honesty rules as unit truths:
 *   · no branch fact ⇒ NO claim (null, and the component renders nothing);
 *   · the mode badge maps workdir facts to the ruled vocabulary
 *     (project ⇒ 'shared' — a link mark, not a word, now carries the honesty);
 *   · a pre-107 summary (neither field) renders nothing rather than a guess.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SessionLaneLine, sessionLaneOf } from './SessionLane.js';

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
