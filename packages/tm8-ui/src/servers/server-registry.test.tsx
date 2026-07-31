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
    await waitFor(() => expect(result.current.loading).toBe(false));

    // The state the operator was stuck in: only the implicit local node.
    expect(result.current.servers.map((server) => server.id)).toEqual(['local']);

    // Registered out-of-band — the CLI writing straight to the node.
    state.connections = [STAGING];

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    await waitFor(() =>
      expect(result.current.servers.map((server) => server.id)).toEqual(['local', 'staging']),
    );
  });

  it('does not fetch when the tab is being hidden rather than revealed', async () => {
    const state: { connections: Connection[] } = { connections: [STAGING] };
    const fetchMock = mockFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useServerRegistry());
    await waitFor(() => expect(result.current.loading).toBe(false));

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
    await waitFor(() => expect(result.current.loading).toBe(false));

    const afterMount = listCalls(fetchMock);
    state.connections = [STAGING];

    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(listCalls(fetchMock)).toBeGreaterThan(afterMount));
    await waitFor(() =>
      expect(result.current.servers.map((server) => server.id)).toEqual(['local', 'staging']),
    );
  });
});
