// @vitest-environment jsdom
/**
 * THE LAUNCHING PAGE (task 01a182d2): it draws the model it is given — the
 * launch line, five phases each saying its own state in words, the clock —
 * and the failure with the node's words; its two verbs appear only where a
 * host can perform them. The session's work view shows it while the session
 * boots and hands over to the surfaces, in place, once it runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import {
  beginLaunch,
  launchPageModel,
  LaunchPageHostContext,
  resetLaunches,
  transition,
  type BootingSession,
  type LaunchPageHost,
} from '../../launch-handoff';
import type { LaunchStarted } from '../../new-session/launch-started';
import { SessionLaunching } from './SessionLaunching';
import { WorkSessionContent } from './WorkSessionContent';

const launch: LaunchStarted = {
  clientMutationId: 'mut-1',
  subjectId: 'task-1' as EntityId,
  title: 'Fix the flaky login test',
  verb: 'worker',
  teammate: { id: 'tm-1' as EntityId, name: 'Opus 5.5 1M Teammate' },
  model: 'claude-opus-5',
  effort: 'max',
  accessMode: 'fullAccess',
  workdir: { kind: 'project', projectId: 'proj-1', mode: 'worktree', baseRef: 'main' },
  notes: '',
};

const booting = (patch: Partial<BootingSession> = {}): BootingSession => ({
  id: 's-1',
  title: 'Fix the flaky login test',
  createdAt: new Date().toISOString(),
  status: 'spawning',
  bootPhase: null,
  started: false,
  teammate: 'Opus 5.5 1M Teammate',
  model: 'claude-opus-5',
  workdirMode: 'worktree',
  checkoutBranch: 'tm8/s-1',
  endedReason: null,
  bootPhaseAt: null,
  ...patch,
});

function host(): LaunchPageHost {
  return { editAndRetry: vi.fn(), dismiss: vi.fn(), choose: vi.fn(), resume: vi.fn() };
}

afterEach(() => {
  cleanup();
  resetLaunches();
});

describe('the launching page', () => {
  it('draws the launch line, the five phases in words, and a running clock', () => {
    render(<SessionLaunching model={launchPageModel(beginLaunch(launch), null)!} />);

    expect(screen.getByTestId('session-launching').dataset.state).toBe('starting');
    expect(screen.getByRole('status').textContent).toContain('Launching');
    expect(screen.getByText('Fix the flaky login test')).toBeTruthy();
    expect(screen.getByTestId('session-launching-line').textContent).toBe(
      'Opus 5.5 1M TeammateClaude Opus 5MaxBypassWorktree from main',
    );
    const rows = screen.getAllByRole('listitem');
    expect(rows.map((row) => row.dataset.mark)).toEqual(['active', 'pending', 'pending', 'pending', 'pending']);
    expect(rows[0]!.textContent).toContain('in progress');
    expect(rows[1]!.textContent).toContain('not yet');
    expect(screen.getByTestId('session-launching-clock').textContent).toMatch(/^\d+\.\d s$/);
  });

  it('a failure shows the node’s words with Edit and retry and Dismiss, which act on the launch', () => {
    beginLaunch(launch);
    const failed = transition('mut-1', {
      type: 'fail',
      failure: { message: 'session concurrency cap reached (64/64)', code: 'conflict', uncertain: false },
    });
    const pageHost = host();
    render(
      <LaunchPageHostContext.Provider value={pageHost}>
        <SessionLaunching model={launchPageModel(failed, null)!} />
      </LaunchPageHostContext.Provider>,
    );

    expect(screen.getByRole('alert').textContent).toContain('session concurrency cap reached (64/64)');
    expect(screen.getAllByRole('listitem')[0]!.dataset.mark).toBe('failed');
    expect(screen.queryByTestId('session-launching-clock')).toBeNull();
    fireEvent.click(screen.getByTestId('session-launching-retry'));
    expect(pageHost.editAndRetry).toHaveBeenCalledWith('mut-1');
    fireEvent.click(screen.getByTestId('session-launching-dismiss'));
    expect(pageHost.dismiss).toHaveBeenCalledWith('mut-1');
  });

  it('a timed-out check’s found sessions are offered to pick, never adopted', () => {
    beginLaunch(launch);
    const failed = transition('mut-1', {
      type: 'fail',
      failure: { message: 'found some', code: 'upstream_unavailable', uncertain: true, candidates: [{ id: 's-7' as EntityId, title: 'A teammate’s run' }] },
    });
    const pageHost = host();
    render(
      <LaunchPageHostContext.Provider value={pageHost}>
        <SessionLaunching model={launchPageModel(failed, null)!} />
      </LaunchPageHostContext.Provider>,
    );
    fireEvent.click(screen.getByText('Open “A teammate’s run”'));
    expect(pageHost.choose).toHaveBeenCalledWith('mut-1', 's-7');
  });

  it('draws no verbs where no host can perform them', () => {
    beginLaunch(launch);
    const failed = transition('mut-1', { type: 'fail', failure: { message: 'refused', code: null, uncertain: false } });
    render(<SessionLaunching model={launchPageModel(failed, null)!} />);
    expect(screen.getByRole('alert').textContent).toContain('refused');
    expect(screen.queryByTestId('session-launching-retry')).toBeNull();
    expect(screen.queryByTestId('session-launching-dismiss')).toBeNull();
  });

  it('says it is checking while a timed-out launch is being looked for', () => {
    beginLaunch(launch);
    render(<SessionLaunching model={launchPageModel(transition('mut-1', { type: 'check' }), null)!} />);
    expect(screen.getByTestId('session-launching-checking')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Checking');
  });
});

describe('the session’s work view while it boots', () => {
  const surfaces = {
    terminal: <div data-testid="the-terminal">terminal</div>,
    transcript: <div>transcript</div>,
  };

  it('shows the launching page instead of the surfaces, and mounts none of them', () => {
    render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting({ bootPhase: 'lane' })} />);
    expect(screen.getByTestId('work-session-content').dataset.surface).toBe('launching');
    expect(screen.getAllByRole('listitem').map((row) => row.dataset.mark)).toEqual(['done', 'done', 'active', 'pending', 'pending']);
    expect(screen.queryByTestId('the-terminal')).toBeNull();
  });

  it('becomes the live session in place once the session runs', () => {
    const { rerender } = render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting()} />);
    expect(screen.getByTestId('session-launching')).toBeTruthy();

    rerender(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting({ status: 'running', started: true })} />);

    expect(screen.queryByTestId('session-launching')).toBeNull();
    expect(screen.getByTestId('work-session-content').dataset.surface).toBe('terminal');
    expect(screen.getByTestId('the-terminal')).toBeTruthy();
  });

  it('carries this window’s launch on: its line and its clock, not the session’s', () => {
    beginLaunch(launch, Date.now() - 1_500);
    transition('mut-1', { type: 'admit', sessionId: 's-1' as EntityId, at: Date.now() - 1_000 });
    render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting()} />);
    expect(screen.getByTestId('session-launching-line').textContent).toContain('Worktree from main');
    expect(screen.getByTestId('session-launching-phase-admitted').textContent).toContain('0.5 s');
  });

  it('a failed session this window did not launch is the work view’s to tell', () => {
    render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting({ status: 'failed', bootPhase: 'failed' })} />);
    expect(screen.queryByTestId('session-launching')).toBeNull();
  });

  it('a session stuck starting past the node’s lost-session window gets its surfaces back, with one line saying so', () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting({ createdAt: old })} />);
    expect(screen.queryByTestId('session-launching')).toBeNull();
    expect(screen.getByTestId('the-terminal')).toBeTruthy();
    expect(screen.getByTestId('work-session-never-started')).toBeTruthy();
  });

  it('a boot on screen when it crosses the lost-session window gives way to its surfaces by itself', () => {
    vi.useFakeTimers();
    try {
      const nearlyStale = new Date(Date.now() - (10 * 60_000 - 1_000)).toISOString();
      render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting({ createdAt: nearlyStale })} />);
      expect(screen.getByTestId('session-launching')).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.queryByTestId('session-launching')).toBeNull();
      expect(screen.getByTestId('work-session-never-started')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a recent phase change keeps an old session’s boot on the page', () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} boot={booting({ createdAt: old, bootPhase: 'lane', bootPhaseAt: new Date().toISOString() })} />);
    expect(screen.getByTestId('session-launching')).toBeTruthy();
  });

  it('a session with no boot facts renders its surfaces as before', () => {
    render(<WorkSessionContent sessionId="s-1" profile={null} {...surfaces} />);
    expect(screen.queryByTestId('session-launching')).toBeNull();
    expect(screen.getByTestId('the-terminal')).toBeTruthy();
  });
});
