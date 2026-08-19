// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { fixtureDetails, taskUuidTitle } from '../fixtures/entities';
import { TransferControl } from './TransferControl';
import { resetTransferDirectoryCache } from './transfer-client';

/**
 * The gate the user ruled: the control exists ONLY when a remote server is
 * connected AND the kind can actually travel. No connection — no button, not a
 * disabled one; on a single-server node the concept does not apply. A kind the
 * engine cannot carry is the same answer for the same reason (ruling
 * 2026-08-19; see the last test). One arm is live: a transferable kind with a
 * connection, which is what keeps absence meaningful.
 */

const taskDetail = fixtureDetails[taskUuidTitle.id] as EntityDetail;
/** Same envelope, a kind the engine refuses — the fixture set has no session detail. */
const sessionDetail = { ...taskDetail, kind: 'work_session' } as EntityDetail;

const CONNECTION = {
  id: '019fb79e-c121-739d-ae3f-0e60c8446d80',
  name: 'prod',
  baseUrl: 'https://tm8.example',
  username: null,
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
};

function fetchAnswering(connections: unknown[] | Error): typeof fetch {
  return vi.fn(async () => {
    if (connections instanceof Error) throw connections;
    return new Response(JSON.stringify({ data: connections }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  resetTransferDirectoryCache();
  try {
    window.localStorage?.clear();
  } catch {
    // This jsdom build exposes no localStorage; the pass store tolerates that.
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TransferControl', () => {
  it('renders nothing when no remote server is connected', async () => {
    vi.stubGlobal('fetch', fetchAnswering([]));
    render(<TransferControl detail={taskDetail} />);
    await waitFor(() => {
      expect(screen.queryByLabelText('Transfer to another server')).toBeNull();
    });
  });

  it('renders nothing when the registry is unreachable', async () => {
    vi.stubGlobal('fetch', fetchAnswering(new Error('offline')));
    render(<TransferControl detail={taskDetail} />);
    await waitFor(() => {
      expect(screen.queryByLabelText('Transfer to another server')).toBeNull();
    });
  });

  it('shows the live button for a transferable kind once a connection exists', async () => {
    vi.stubGlobal('fetch', fetchAnswering([CONNECTION]));
    render(<TransferControl detail={taskDetail} />);
    const button = await screen.findByLabelText('Transfer to another server');
    expect(button.tagName).toBe('BUTTON');
  });

  /*
   * WAS "refuses an untransferable kind with a reason, not silence" — reversed
   * by user ruling 2026-08-19, and the reversal is about WHICH honesty form
   * this case takes, not about dropping one.
   *
   * The old arm drew a dimmed ⇄ reading "this kind can't be transferred yet".
   * But `TRANSFERABLE_KINDS` is not a rollout order — it is what the engine can
   * carry — and a work_session is off it because a session IS a process on a
   * node: its pty and its worktree are the machine it runs on. There is no
   * later release in which it travels, so "yet" was a control promising
   * something the design does not intend. That puts it with the no-connection
   * case above (a concept that does not apply ⇒ render nothing) rather than
   * with deferred features (⇒ disabled-with-reason).
   *
   * It cost real pixels too: a permanently unpressable control in
   * `.pn-panelbar__end`, the fixed-width side of the one bar in the app that
   * had run out of room, helping push the session panel's own tabs off the edge
   * in order to say a thing that will never change.
   *
   * THE RULE IS STILL PINNED, one test up: a transferable kind with a
   * connection gets a LIVE button. That is what stops absence here from
   * quietly coming to mean "broken" instead of "not a thing".
   */
  it('renders nothing for an untransferable kind — not a permanent refusal', async () => {
    vi.stubGlobal('fetch', fetchAnswering([CONNECTION]));
    const { container } = render(<TransferControl detail={sessionDetail} />);
    // WAITED FOR, not asserted immediately: this control is empty on its first
    // frame no matter what, while the directory read is in flight, so a bare
    // check would pass just as happily with the refusal arm still in place.
    await waitFor(() => {
      expect(screen.queryByLabelText('Transfer to another server')).toBeNull();
    });
    expect(screen.queryByTestId('disabled-with-reason')).toBeNull();
    expect(container.firstChild).toBeNull();
  });
});
