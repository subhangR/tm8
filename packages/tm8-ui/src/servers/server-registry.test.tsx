// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useServerRegistry } from './server-registry';

/**
 * The regression these tests exist for, measured on prod 2026-07-31:
 *
 * The list was fetched exactly once, at mount. A Server registered afterwards
 * — by the CLI, or from another tab — stayed invisible for the whole life of
 * the tab, and nothing on screen suggested the list was stale: the rail looked
 * complete while it was simply old. The operator's reported symptom was
 * "staging is not in the UI"; the row had been in the DB for forty minutes and
 * the endpoint returned it the whole time.
 *
 * So the assertion that matters is NOT "the hook fetches" — it always did —
 * but "the hook notices a Server it did not see at mount".
 */

interface Connection {
  id: string;
  name: string;
  baseUrl: string;
  username: string | null;
  createdAt: string;
  updatedAt: string;
}

const STAGING: Connection = {
  id: '019fb79e-c121-739d-ae3f-0e60c8446d80',
  name: 'staging',
  baseUrl: 'http://127.0.0.1:8887',
  username: null,
  createdAt: '2026-07-31T10:01:02.494Z',
  updatedAt: '2026-07-31T10:01:02.494Z',
};

const LIST_URL = '/v2/server-connections';

/**
 * Testing Library's default is 1000ms, which this file cannot rely on: every
 * assertion here waits on a fetch -> setState -> re-render chain, and under a
 * full parallel suite run that chain need not finish inside a second. A longer
 * ceiling weakens nothing — the condition must still become true, it is merely
 * allowed to take longer on a loaded machine.
 *
 * HONEST STATUS: this bound is UNFALSIFIED, NOT PROVEN. The flake was seen
 * exactly once, by another lane, at 1083ms and 1068ms. Those durations sitting
 * 68-83ms above the 1000ms default are the fingerprint of a wait bound
 * expiring — a real race would fail fast, or at scattered durations, not twice
 * within a hair of the exact default. That is the whole case for this fix.
 *
 * It is NOT confirmed. The reporting lane then tried hard to reproduce it: 12
 * full-suite runs, three of them under 8 saturating CPU hogs on an 8-core box,
 * AND three more with the 1000ms bound deliberately restored under that same
 * load. Zero reproductions at either bound. So nobody has shown this fix
 * causes anything. The original condition appears to have been a one-off load
 * spike — in the very run that flaked, two heavyweight suites (gate.test.tsx,
 * prompts.test.tsx) went from crashing-at-import to passing for the first
 * time, sharply changing the parallel load profile while this file ran.
 *
 * IF IT EVER RECURS, THE DURATION IS THE MEASUREMENT — do not re-litigate:
 *   fails at ~15s -> the wait bound really is the constraint. Raise it, or
 *                    find what is genuinely that slow.
 *   fails fast    -> NOT a timeout. Suspect a real race between the mount
 *                    refresh and the focus effect, which both invoke the same
 *                    `refresh` callback.
 */
const WAIT = { timeout: 15_000 } as const;

/**
 * Backed by a MUTABLE array so a test can register a Server *after* mount —
 * which is the entire failure mode. A fixed response could not express it.
 */
function mockFetch(state: { connections: Connection[] }) {
  return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    // Every server's reachability probe, including local's (routeBaseUrl '').
    if (url.endsWith('/health')) {
      return {
        ok: true,
        json: async () => ({ ok: true, server: 'tm8-server' }),
      } as unknown as Response;
    }
    if (url === LIST_URL) {
      return {
        ok: true,
        json: async () => ({ data: state.connections }),
      } as unknown as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const listCalls = (fetchMock: ReturnType<typeof mockFetch>): number =>
  fetchMock.mock.calls.filter((call) => String(call[0]) === LIST_URL).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useServerRegistry revalidation', () => {
  it('surfaces a Server registered after mount when the tab regains focus', async () => {
    const state: { connections: Connection[] } = { connections: [] };
    vi.stubGlobal('fetch', mockFetch(state));

    const { result } = renderHook(() => useServerRegistry());
    await waitFor(() => expect(result.current.loading).toBe(false), WAIT);

    // The state the operator was stuck in: only the implicit local node.
    expect(result.current.servers.map((server) => server.id)).toEqual(['local']);

    // Registered out-of-band — the CLI writing straight to the node.
    state.connections = [STAGING];

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(
      () => expect(result.current.servers.map((server) => server.id)).toEqual(['local', 'staging']),
      WAIT,
    );
  });

  it('does not fetch when the tab is being hidden rather than revealed', async () => {
    const state: { connections: Connection[] } = { connections: [STAGING] };
    const fetchMock = mockFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useServerRegistry());
    await waitFor(() => expect(result.current.loading).toBe(false), WAIT);

    const afterMount = listCalls(fetchMock);
    expect(afterMount).toBeGreaterThan(0);

    // visibilitychange fires on BOTH transitions. Revalidating on the hide
    // edge would double every tab switch for a list nobody is looking at.
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(listCalls(fetchMock)).toBe(afterMount);
  });

  it('revalidates when the tab becomes visible again', async () => {
    const state: { connections: Connection[] } = { connections: [] };
    const fetchMock = mockFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useServerRegistry());
    await waitFor(() => expect(result.current.loading).toBe(false), WAIT);

    const afterMount = listCalls(fetchMock);
    state.connections = [STAGING];

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(listCalls(fetchMock)).toBeGreaterThan(afterMount), WAIT);
    await waitFor(
      () => expect(result.current.servers.map((server) => server.id)).toEqual(['local', 'staging']),
      WAIT,
    );
  });
});
