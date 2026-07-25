/**
 * The middle pane's two separately-bounded LRUs: up to four mounted xterms for
 * switch responsiveness, while the visibility driver separately keeps only its
 * three most-recent sockets warm. These tests count MOUNTS and EVICTIONS so the
 * mounted bound cannot silently turn back into "mount the whole fleet".
 *
 * The real path is driven with only `fetch` stubbed, per the house rule that a
 * MockFacade test cannot see the wire shape that actually breaks.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RealFacade } from '../../RealFacade';
import { TmClient } from '../../TmClient';
import { CenterPane, MOUNTED_TERMINAL_LRU_SIZE } from '../CenterPane';

/**
 * The terminal is stubbed, not exercised — it opens a real PTY socket, which is
 * an integration concern proven elsewhere. What matters here is HOW MANY exist
 * and for WHICH session, which is exactly what a stub can answer honestly.
 */
const mounts: string[] = [];
const unmounts: string[] = [];
vi.mock('../../SessionTerminal', async () => {
  const React = await import('react');
  return {
    SessionTerminal: ({ sessionId, live }: { sessionId: string; live: boolean }) => {
      React.useEffect(() => {
        mounts.push(sessionId);
        return () => { unmounts.push(sessionId); };
      }, [sessionId]);
      return <div data-testid="session-terminal" data-session={sessionId} data-live={String(live)} />;
    },
  };
});

/** Thread reads the module's facade CONTEXT; this pane's job is only to anchor it. */
vi.mock('../../../collab-v2/subsystems/thread', () => ({
  Thread: ({ anchorId }: { anchorId: string }) => <div data-testid="thread" data-anchor={anchorId} />,
}));

const SPACE = 'spc_1';
const LIVE_ID = 'ws_live';
const DEAD_ID = 'ws_exited';

function workSession(id: string, status: string) {
  return {
    id, spaceId: SPACE, kind: 'work_session', title: `Session ${id}`,
    parentId: null, position: 1, visibility: 'space', version: 1,
    activityAt: '2026-07-25T13:52:19.444Z', createdAt: '2026-07-25T13:52:19.444Z',
    updatedAt: '2026-07-25T13:52:19.444Z', deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'Owner', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'work_session', status, agentTool: 'claude-code', model: 'sonnet', startedAt: '2026-07-25T13:52:19.444Z', exitedAt: null },
    badges: {},
  };
}

function stubNode() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const id = String(url).includes(DEAD_ID) ? DEAD_ID : LIVE_ID;
    const data = { ...workSession(id, id === DEAD_ID ? 'exited' : 'running'), content: {}, hierarchy: {}, connections: {}, capabilities: {} };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data, requestId: 'r' }) } as unknown as Response;
  }));
}

const facade = () => new RealFacade(new TmClient());

beforeEach(() => { mounts.length = 0; unmounts.length = 0; stubNode(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('CenterPane — bounded mounted terminal LRU', () => {
  it('mounts one terminal on the initial selection', async () => {
    render(<CenterPane facade={facade()} spaceId={SPACE} sessionId={LIVE_ID} taskId={null} />);

    await waitFor(() => expect(screen.getByTestId('session-terminal')).toBeTruthy());
    // The cache grows only through real switches; an initial selection does not
    // pre-mount speculative xterms for the rest of the fleet.
    expect(document.querySelectorAll('[data-testid="session-terminal"]')).toHaveLength(1);
    expect(screen.getByTestId('session-terminal').getAttribute('data-session')).toBe(LIVE_ID);
  });

  it('keeps an ordinary switch mounted and visibility-hidden for fast return', async () => {
    const f = facade();
    const { rerender } = render(<CenterPane facade={f} spaceId={SPACE} sessionId={LIVE_ID} taskId={null} />);
    await waitFor(() => expect(mounts).toContain(LIVE_ID));

    rerender(<CenterPane facade={f} spaceId={SPACE} sessionId={DEAD_ID} taskId={null} />);

    await waitFor(() => expect(mounts).toContain(DEAD_ID));
    expect(unmounts).not.toContain(LIVE_ID);
    expect(document.querySelectorAll('[data-testid="session-terminal"]')).toHaveLength(2);
    const cached = screen.getByTestId('terminal-layer-cached');
    expect(cached.getAttribute('data-session-id')).toBe(LIVE_ID);
    expect(cached.style.visibility).toBe('hidden');
  });

  it('evicts and fully unmounts the least-recently-viewed terminal at the bound', async () => {
    const f = facade();
    const ids = Array.from({ length: MOUNTED_TERMINAL_LRU_SIZE + 1 }, (_, index) => `ws_${index + 1}`);
    const { rerender } = render(
      <CenterPane facade={f} spaceId={SPACE} sessionId={ids[0]!} taskId={null} />,
    );
    for (const id of ids.slice(1)) {
      rerender(<CenterPane facade={f} spaceId={SPACE} sessionId={id} taskId={null} />);
    }
    await waitFor(() => expect(mounts).toContain(ids.at(-1)!));
    expect(document.querySelectorAll('[data-testid="session-terminal"]'))
      .toHaveLength(MOUNTED_TERMINAL_LRU_SIZE);
    expect(unmounts).toContain(ids[0]);

    // Returning to an evicted id creates a fresh xterm (which reattaches at
    // offset 0/full-ring replay) and evicts the next LRU entry.
    rerender(<CenterPane facade={f} spaceId={SPACE} sessionId={ids[0]!} taskId={null} />);
    await waitFor(() => expect(mounts.filter((id) => id === ids[0])).toHaveLength(2));
    expect(unmounts).toContain(ids[1]);
    expect(document.querySelectorAll('[data-testid="session-terminal"]'))
      .toHaveLength(MOUNTED_TERMINAL_LRU_SIZE);
  });

  it('keeps the terminal MOUNTED but visibility-hidden behind the Thread tab', async () => {
    render(<CenterPane facade={facade()} spaceId={SPACE} sessionId={LIVE_ID} taskId="tsk_1" />);
    await waitFor(() => expect(screen.getByTestId('session-terminal')).toBeTruthy());

    fireEvent.click(screen.getByTestId('center-tab-thread'));

    await waitFor(() => expect(screen.getByTestId('thread')).toBeTruthy());
    expect(screen.getByTestId('thread').getAttribute('data-anchor')).toBe('tsk_1');
    // Still mounted: unmount-on-switch leaks retained xterm instances and costs a
    // full ring replay on every glance at the thread.
    expect(screen.getByTestId('session-terminal')).toBeTruthy();
    expect(unmounts).not.toContain(LIVE_ID);
    // Hidden with visibility so layout remains measurable. The visibility
    // driver discovers it by polling computed style; no CSS visibility event
    // exists.
    expect(screen.getByTestId('terminal-layer').style.visibility).toBe('hidden');
  });

  it('keeps the full title and session id recoverable when the head truncates', async () => {
    render(<CenterPane facade={facade()} spaceId={SPACE} sessionId={LIVE_ID} taskId={null} />);
    await waitFor(() => expect(document.querySelector('.ws-center__title')?.textContent).toBe(`Session ${LIVE_ID}`));

    // jsdom cannot see the truncation itself — this pins the RECOVERY path, which
    // is the part that makes truncation acceptable. The head genuinely truncates
    // at ordinary widths (measured in the browser: a 35px title beside a 214px
    // UUID before the shrink order was fixed).
    expect(document.querySelector('.ws-center__id')?.getAttribute('title')).toBe(LIVE_ID);

    // And the id rides the TITLE's tooltip as well, because the id element itself
    // reaches zero width at a narrow centre column — measured in the browser — and
    // a zero-width element cannot be hovered. The title holds an 8ch floor, so
    // this is the copy that always survives.
    expect(document.querySelector('.ws-center__title')?.getAttribute('title')).toContain(LIVE_ID);
  });

  it('disables the Thread tab with a reason when no task is selected', () => {
    render(<CenterPane facade={facade()} spaceId={SPACE} sessionId={LIVE_ID} taskId={null} />);
    const tab = screen.getByTestId('center-tab-thread') as HTMLButtonElement;
    expect(tab.disabled).toBe(true);
    expect(tab.title).toContain('select a task');
  });

  it('keeps image paste visible but disabled with its missing upload capability explained', async () => {
    render(<CenterPane facade={facade()} spaceId={SPACE} sessionId={LIVE_ID} taskId={null} />);
    const paste = await screen.findByTestId('terminal-image-paste') as HTMLButtonElement;
    expect(paste.disabled).toBe(true);
    expect(paste.title).toMatch(/uploadFile|upload/i);
  });

  it('mounts no terminal at all with nothing selected, and says why', async () => {
    render(<CenterPane facade={facade()} spaceId={SPACE} sessionId={null} taskId={null} />);
    expect(screen.queryByTestId('session-terminal')).toBeNull();
    expect(screen.getByTestId('center-empty')).toBeTruthy();
    // The output ring is not a transcript, and the difference survives a restart.
    expect(screen.getByTestId('center-transcript-note').textContent).toMatch(/output ring/i);
  });

  it('still shows an exited session, with the composer disabled', async () => {
    render(<CenterPane facade={facade()} spaceId={SPACE} sessionId={DEAD_ID} taskId={null} />);

    // The server keeps the ring, so a finished run stays readable — a completed
    // session you cannot read back is the lost-work problem all over again.
    await waitFor(() => expect(screen.getByTestId('session-terminal').getAttribute('data-live')).toBe('false'));
    await waitFor(() => expect((screen.getByTestId('composer-terminate') as HTMLButtonElement).disabled).toBe(true));
  });
});
