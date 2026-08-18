// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { fixtureDetails, taskUuidTitle } from '../fixtures/entities';
import { TransferControl } from './TransferControl';
import { resetTransferDirectoryCache } from './transfer-client';

/**
 * The gate the user ruled: the control exists ONLY when a remote server is
 * connected. No connection — no button, not a disabled one; on a
 * single-server node the concept does not apply. With a connection, a
 * transferable kind gets the live button and an untransferable kind gets
 * disabled-with-reason.
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

  it('refuses an untransferable kind with a reason, not silence', async () => {
    vi.stubGlobal('fetch', fetchAnswering([CONNECTION]));
    render(<TransferControl detail={sessionDetail} />);
    const refused = await screen.findByTestId('disabled-with-reason');
    expect(refused.getAttribute('aria-label')).toBe('Transfer to another server');
    expect(refused.textContent).toContain('can’t be transferred yet');
  });
});
