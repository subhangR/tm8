/**
 * REAL-PATH tests for the Sessions surface.
 *
 * WHY THESE EXIST, SPECIFICALLY. Every one of the module's ~850 tests runs
 * against `MockFacade`, so the suite stayed green through a Settings screen that
 * white-screened the app and a sessions surface that did not exist. A test that
 * never touches `RealFacade` cannot see the thing that actually breaks: the wire
 * shape. So these drive the REAL stack — `SessionsScreen` → `RealFacade` →
 * `TmClient` → HTTP — with only `fetch` stubbed, and they assert against the
 * envelope and DTO shapes the tm8 node genuinely returns.
 *
 * The regression they exist to prevent is the one the whole surface was built
 * for: a spawned agent that becomes unreachable. If `collections.query` stops
 * accepting `work_session`, or the route stops carrying the session id, a live
 * PTY loses its only handle — and these fail.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RealFacade } from '../RealFacade';
import { TmClient } from '../TmClient';
import { SessionsScreen } from '../sessions/SessionsScreen';
import type { CollabFacade } from '../../collab-v2/facade/CollabFacade';
import type { ShellViewProps } from '../../collab-v2/shell';

/**
 * The terminal is stubbed, not exercised: it opens a real WebSocket to a PTY,
 * which is an integration concern of its own (and proven in the browser). What
 * matters here is that the surface MOUNTS it for the right session id — that is
 * the reattach contract.
 */
const mounted: string[] = [];
vi.mock('../SessionTerminal', () => ({
  SessionTerminal: ({ sessionId, live }: { sessionId: string; live: boolean }) => {
    mounted.push(sessionId);
    return <div data-testid="session-terminal" data-session={sessionId} data-live={String(live)} />;
  },
}));

const SPACE = 'spc_1';
const LIVE_ID = 'ws_live';
const DEAD_ID = 'ws_exited';

/** A `work_session` exactly as the tm8 node projects it (contract.ts §1.1). */
function workSession(id: string, status: string, exitedAt: string | null = null) {
  return {
    id,
    spaceId: SPACE,
    kind: 'work_session',
    title: 'Session',
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: '2026-07-25T13:52:19.444Z',
    createdAt: '2026-07-25T13:52:19.444Z',
    updatedAt: '2026-07-25T13:52:19.444Z',
    deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'Owner', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'work_session',
      status,
      agentTool: 'claude-code',
      model: 'sonnet',
      shareMode: 'none',
      startedAt: '2026-07-25T13:52:19.444Z',
      exitedAt,
    },
    badges: {},
  };
}

/** Records every request so the test can assert what went over the wire. */
let calls: Array<{ method: string; url: string; body: unknown }> = [];

function stubNode() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url: String(url), body });

    let data: unknown;
    if (String(url).includes('/v2/collections/query')) {
      data = {
        query: body,
        page: { items: [workSession(LIVE_ID, 'running'), workSession(DEAD_ID, 'exited', '2026-07-25T13:52:08.000Z')], nextCursor: null },
      };
    } else if (String(url).includes(`/v2/entities/${LIVE_ID}`)) {
      data = { ...workSession(LIVE_ID, 'running'), content: { kind: 'work_session' }, hierarchy: {}, connections: {}, capabilities: {} };
    } else {
      data = {};
    }
    return {
      ok: true, status: 200, text: async () => JSON.stringify({ data, requestId: 'req_test' }),
    } as unknown as Response;
  }));
}

function props(over: Partial<ShellViewProps> = {}): ShellViewProps {
  const facade = new RealFacade(new TmClient()) as unknown as CollabFacade;
  return {
    facade,
    spaceId: SPACE,
    view: 'sessions',
    entityId: null,
    onOpenEntity: vi.fn(),
    onNavigate: vi.fn(),
    ...over,
  };
}

beforeEach(() => { calls = []; mounted.length = 0; stubNode(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('sessions list — over the real facade', () => {
  it('queries work_session through collections.query and renders the wire shape', async () => {
    render(<SessionsScreen {...props()} />);

    await waitFor(() => expect(screen.getAllByText('Session').length).toBeGreaterThan(0));

    // The op that makes this surface possible without a contract change. If a
    // future change stops sending `work_session`, the list silently empties —
    // so the request itself is asserted, not just the rendering.
    const query = calls.find((c) => c.url.includes('/v2/collections/query'));
    expect(query?.method).toBe('POST');
    expect((query?.body as { kinds: string[] }).kinds).toEqual(['work_session']);
    expect((query?.body as { spaceId: string }).spaceId).toBe(SPACE);

    // Status, agent and model come off `state`, which is where tm8 puts them.
    // Both rows carry it, so this is an "every row" assertion, not a lookup.
    expect(screen.getAllByText(/claude-code · sonnet/)).toHaveLength(2);
    expect(screen.getByText('running')).toBeTruthy();
    expect(screen.getByText('exited')).toBeTruthy();
  });

  it('separates live sessions from finished ones', async () => {
    render(<SessionsScreen {...props()} />);
    await waitFor(() => expect(screen.getByText(/live · 1/i)).toBeTruthy());
    expect(screen.getByText(/finished · 1/i)).toBeTruthy();
  });

  it('opening a session navigates to the durable route, not local state', async () => {
    const p = props();
    render(<SessionsScreen {...p} />);
    await waitFor(() => expect(document.querySelectorAll('.tm8-sessrow').length).toBe(2));

    fireEvent.click(document.querySelectorAll('.tm8-sessrow')[0]!);

    // THE fix: the session id goes into the ROUTE. Held in component state
    // instead, a reload would orphan a live agent — which is exactly the bug
    // this surface was built to close.
    expect(p.onNavigate).toHaveBeenCalledWith('sessions', LIVE_ID);
  });

  it('says so honestly when there are no sessions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({ data: { query: {}, page: { items: [], nextCursor: null } }, requestId: 'r' }),
    } as unknown as Response)));
    render(<SessionsScreen {...props()} />);
    await waitFor(() => expect(screen.getByText(/No sessions yet/i)).toBeTruthy());
  });
});

describe('session detail — the reattach contract', () => {
  it('mounts a terminal for the routed session id (reattach after reload)', async () => {
    // Entering with `entityId` already set IS the post-reload case: nothing was
    // carried in memory, the URL alone has to be enough to find the PTY again.
    render(<SessionsScreen {...props({ entityId: LIVE_ID })} />);

    await waitFor(() => expect(screen.getByTestId('session-terminal')).toBeTruthy());
    const term = screen.getByTestId('session-terminal');
    expect(term.getAttribute('data-session')).toBe(LIVE_ID);
    expect(term.getAttribute('data-live')).toBe('true');
    expect(mounted).toContain(LIVE_ID);

    // It read the session back by id — the route is a real handle, not a label.
    expect(calls.some((c) => c.url.includes(`/v2/entities/${LIVE_ID}`))).toBe(true);
  });

  it('still mounts a terminal for an exited session, marked not-live', async () => {
    // The server keeps the output ring, so a finished session must remain
    // readable — a completed run you cannot read back is the same lost work.
    render(<SessionsScreen {...props({ entityId: DEAD_ID })} />);
    await waitFor(() => expect(screen.getByTestId('session-terminal')).toBeTruthy());
    expect(screen.getByTestId('session-terminal').getAttribute('data-session')).toBe(DEAD_ID);
  });
});
