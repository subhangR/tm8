/**
 * REAL-PATH tests for the Resources panel (Lane B).
 *
 * Same discipline as `real/__tests__/sessions.test.tsx`, and for the same
 * reason: the module's ~850 other tests run against `MockFacade`, so a suite
 * that never touches `RealFacade` cannot see the thing that actually breaks —
 * the wire shape. These drive `ResourcePanel` → `RealFacade` → `TmClient` →
 * HTTP with only `fetch` stubbed, and assert against the envelope and DTO
 * shapes the tm8 node genuinely returns.
 *
 * The regressions they exist to prevent, in order of how much they would cost:
 *  - the shared poll silently becoming one-poll-per-consumer (a request storm
 *    that no visual test would ever catch);
 *  - `collections.query` losing `work_session` or `team_member` — a live agent
 *    becomes unreachable, which is the whole reason this panel exists;
 *  - the Docs/Drawings split inverting, so a drawing vanishes from both tabs;
 *  - a doc save going out WITHOUT `expectedVersion`, which is how one edit
 *    silently overwrites another.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act, within } from '@testing-library/react';
import { RealFacade } from '../../RealFacade';
import { TmClient } from '../../TmClient';
import { ResourcePanel } from '../ResourcePanel';
import { DocsTab } from '../tabs/DocsTab';
import { sceneElementCount } from '../tabs/DrawingsTab';
import { groupSessions, isLive } from '../useSessions';
import { docFormat, isDrawing } from '../queries';
import { __resetPollRegistry, subscribeCollection } from '../usePolledCollection';
import type { EntitySummary } from '../../../collab-v2/types/contract';

const SPACE = 'spc_1';
const LIVE_ID = 'ws_live';
const DEAD_ID = 'ws_exited';
const DOC_ID = 'doc_notes';
const DRAW_ID = 'doc_scene';

/** The envelope fields every EntitySummary carries, so the fixtures stay readable. */
function base(id: string, kind: string, title: string) {
  return {
    id,
    spaceId: SPACE,
    kind,
    title,
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 3,
    activityAt: '2026-07-25T13:52:19.444Z',
    createdAt: '2026-07-25T13:52:19.444Z',
    updatedAt: '2026-07-25T13:52:19.444Z',
    deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'Owner', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    badges: {},
  };
}

function workSession(id: string, status: string, exitedAt: string | null = null) {
  return {
    ...base(id, 'work_session', 'Session'),
    state: {
      kind: 'work_session', status, agentTool: 'claude-code', model: 'sonnet',
      shareMode: 'none', startedAt: '2026-07-25T13:52:19.444Z', exitedAt,
    },
  };
}

function teamMember(id: string, title: string) {
  return {
    ...base(id, 'team_member', title),
    state: { kind: 'team_member', owner: base('m1', 'member', 'Owner').createdBy, model: 'opus', agentTool: 'claude-code', liveWork: null },
  };
}

function doc(id: string, title: string, format: 'markdown' | 'excalidraw') {
  return { ...base(id, 'doc', title), state: { kind: 'doc', format, childCount: 0 } };
}

const credentialStatus = {
  providers: [
    { provider: 'anthropic', connected: true, login: null, authMethod: 'oauth', status: 'active', connectedAt: null, lastVerifiedAt: null },
    { provider: 'openai', connected: false, login: null, authMethod: null, status: null, connectedAt: null, lastVerifiedAt: null },
    { provider: 'github', connected: false, login: null, authMethod: null, status: null, connectedAt: null, lastVerifiedAt: null },
    { provider: 'gemini', connected: false, login: null, authMethod: null, status: 'stale', connectedAt: null, lastVerifiedAt: null },
    { provider: 'hermes', connected: false, login: null, authMethod: null, status: 'unavailable', connectedAt: null, lastVerifiedAt: null },
    { provider: 'cursor', connected: true, login: null, authMethod: null, status: 'active', connectedAt: null, lastVerifiedAt: null },
  ],
  gitCredentialStore: 'present',
};

let calls: Array<{ method: string; url: string; body: any }> = [];
/** Bodies the stub serves for `entities.get`, so a save can change what a re-read returns. */
let docBody = '# notes';

function stubNode() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const u = String(url);
    calls.push({ method, url: u, body });

    let data: unknown = {};
    if (u.endsWith('/v2/identity/credentials') && method === 'GET') {
      data = credentialStatus;
    } else if (u.includes('/v2/identity/credentials/login-sessions/') && u.endsWith('/finish')) {
      data = {
        workSessionId: 'ws_login', provider: 'openai', connected: true,
        login: null, authMethod: 'oauth', status: 'active', stored: true, terminated: true,
      };
    } else if (u.endsWith('/v2/identity/credentials/login-sessions') && method === 'POST') {
      data = {
        workSessionId: 'ws_login', spaceId: body?.spaceId, provider: body?.provider,
        expiresAt: '2026-09-04T12:10:00.000Z', command: `${body?.provider} login`,
      };
    } else if (u.includes('/v2/collections/query')) {
      const kind = body?.kinds?.[0];
      const items =
        kind === 'work_session'
          ? [workSession(LIVE_ID, 'running'), workSession(DEAD_ID, 'exited', '2026-07-25T13:52:08.000Z')]
          : kind === 'team_member'
            ? [teamMember('tm_1', 'Rhea')]
            : kind === 'doc'
              ? [doc(DOC_ID, 'Notes', 'markdown'), doc(DRAW_ID, 'Architecture', 'excalidraw')]
              : [];
      data = { query: body, page: { items, nextCursor: null } };
    } else if (u.includes(`/v2/entities/${DOC_ID}`) && method === 'PATCH') {
      data = { entity: doc(DOC_ID, 'Notes', 'markdown'), patches: [] };
      docBody = body?.content?.body ?? docBody;
    } else if (u.includes(`/v2/entities/${DOC_ID}`)) {
      data = { ...doc(DOC_ID, 'Notes', 'markdown'), content: { kind: 'doc', body: docBody, format: 'markdown' }, hierarchy: {}, connections: {}, capabilities: {} };
    } else if (u.includes(`/v2/entities/${DRAW_ID}`)) {
      data = {
        ...doc(DRAW_ID, 'Architecture', 'excalidraw'),
        content: { kind: 'doc', body: JSON.stringify({ type: 'excalidraw', elements: [{ id: 'a' }, { id: 'b' }] }), format: 'excalidraw' },
        hierarchy: {}, connections: {}, capabilities: {},
      };
    } else if (u.includes('/v2/entities') && method === 'POST') {
      data = { entity: base('new', body?.kind ?? 'doc', body?.title ?? ''), patches: [] };
    }

    return { ok: true, status: 200, text: async () => JSON.stringify({ data, requestId: 'req_test' }) } as unknown as Response;
  }));
}

function panel(over: Partial<React.ComponentProps<typeof ResourcePanel>> = {}) {
  const facade = new RealFacade(new TmClient());
  return { facade, onOpenSession: vi.fn(), spaceId: SPACE, openSessionId: null, ...over };
}

beforeEach(() => { calls = []; docBody = '# notes'; __resetPollRegistry(); stubNode(); });
afterEach(() => { __resetPollRegistry(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// Pure logic — the predicates the whole panel gates on
// ---------------------------------------------------------------------------

describe('liveness and grouping', () => {
  it('treats spawning and idle as LIVE, not just running', () => {
    // The bug this guards: a whitelist of running-ish statuses drops a real
    // live agent into the finished bucket behind disabled buttons.
    for (const status of ['running', 'spawning', 'idle']) {
      expect(isLive(workSession('x', status) as unknown as EntitySummary)).toBe(true);
    }
    for (const status of ['exited', 'failed']) {
      expect(isLive(workSession('x', status) as unknown as EntitySummary)).toBe(false);
    }
  });

  it('splits every session into exactly one bucket', () => {
    const sessions = [
      workSession('a', 'running'), workSession('b', 'exited'),
      workSession('c', 'idle'), workSession('d', 'failed'),
    ] as unknown as EntitySummary[];
    const { live, finished } = groupSessions(sessions);
    expect(live.map((s) => s.id)).toEqual(['a', 'c']);
    expect(finished.map((s) => s.id)).toEqual(['b', 'd']);
    expect(live.length + finished.length).toBe(sessions.length);
  });

  it('routes an unknown doc format to Docs rather than losing it', () => {
    // A row the server returns must be reachable in SOME tab. Defaulting to
    // markdown is what stops an unrecognised format from vanishing from both.
    const weird = { ...doc('d', 'Odd', 'markdown'), state: { kind: 'doc', format: 'pdf', childCount: 0 } };
    expect(docFormat(weird as unknown as EntitySummary)).toBe('markdown');
    expect(isDrawing(weird as unknown as EntitySummary)).toBe(false);
  });

  it('distinguishes an empty scene from an unreadable one', () => {
    expect(sceneElementCount(JSON.stringify({ elements: [] }))).toBe(0);
    expect(sceneElementCount(JSON.stringify({ elements: [{ id: 'a' }] }))).toBe(1);
    expect(sceneElementCount('not json')).toBeNull();
    expect(sceneElementCount('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The shared poll — the invariant no visual test would catch
// ---------------------------------------------------------------------------

describe('shared polling', () => {
  it('serves N subscribers of one query from ONE request', async () => {
    const facade = new RealFacade(new TmClient());
    const q = { spaceId: SPACE, kinds: ['doc'] as any, limit: 200, sort: 'activityAt_desc' as const };
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    const un = [
      subscribeCollection(facade, q, 10_000, a),
      subscribeCollection(facade, q, 10_000, b),
      subscribeCollection(facade, q, 10_000, c),
    ];
    await waitFor(() => expect(a).toHaveBeenCalledWith(expect.objectContaining({ items: expect.any(Array) })));

    const queries = calls.filter((k) => k.url.includes('/v2/collections/query'));
    expect(queries).toHaveLength(1);
    // and the late subscribers still got the data
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ items: expect.any(Array) }));
    expect(c).toHaveBeenCalledWith(expect.objectContaining({ items: expect.any(Array) }));
    for (const u of un) u();
  });

  it('stops polling when the last subscriber leaves', async () => {
    const facade = new RealFacade(new TmClient());
    const q = { spaceId: SPACE, kinds: ['doc'] as any, limit: 200, sort: 'activityAt_desc' as const };
    const un = subscribeCollection(facade, q, 10_000, vi.fn());
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    un();
    const after = calls.length;
    // A cleared interval cannot fire; if the registry leaked the entry this grows.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(after);
  });

  it('stays warm across a gap in subscribers, so a tab switch is free', async () => {
    // Docs and Drawings are ONE query split by format, but only the active tab
    // is mounted — so they never overlap. Without a warm window the switch
    // re-fetches and flashes "Loading…" at rows we already had.
    const facade = new RealFacade(new TmClient());
    const q = { spaceId: SPACE, kinds: ['doc'] as any, limit: 200, sort: 'activityAt_desc' as const };
    const first = vi.fn();
    const un1 = subscribeCollection(facade, q, 10_000, first);
    await waitFor(() => expect(first).toHaveBeenCalledWith(expect.objectContaining({ items: expect.any(Array) })));
    un1();

    const second = vi.fn();
    const un2 = subscribeCollection(facade, q, 10_000, second);
    // Served SYNCHRONOUSLY from the warm snapshot — never a null items pass.
    expect(second).toHaveBeenCalledTimes(1);
    expect(second.mock.calls[0]![0].items).toHaveLength(2);
    expect(calls.filter((k) => k.url.includes('/v2/collections/query'))).toHaveLength(1);
    un2();
  });

  it('keeps the last good rows when a refresh fails', async () => {
    const facade = new RealFacade(new TmClient());
    const q = { spaceId: SPACE, kinds: ['doc'] as any, limit: 200, sort: 'activityAt_desc' as const };
    const seen: Array<{ items: unknown[] | null; error: string | null }> = [];
    const un = subscribeCollection(facade, q, 10_000, (s) => seen.push({ items: s.items, error: s.error }));
    await waitFor(() => expect(seen.at(-1)?.items).toHaveLength(2));

    // Now make the node fail, and force a re-read.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { refreshCollection } = await import('../usePolledCollection');
    refreshCollection(facade, q);

    await waitFor(() => expect(seen.at(-1)?.error).toContain('network down'));
    // THE POINT: rows survive the failure. Blanking them would state "there is
    // nothing here", which is not what a dropped request means.
    expect(seen.at(-1)?.items).toHaveLength(2);
    un();
  });
});

// ---------------------------------------------------------------------------
// The panel over the real facade
// ---------------------------------------------------------------------------

describe('ResourcePanel — over the real facade', () => {
  it('draws five agent providers plus terminal as one state-aware quick strip', async () => {
    render(<ResourcePanel {...panel()} />);
    await screen.findByLabelText('Claude — connected');

    const toolbar = screen.getByRole('toolbar', { name: 'Quick launch' });
    expect(within(toolbar).getAllByTestId(/^quick-provider-/)).toHaveLength(5);
    expect(toolbar.querySelectorAll('.pn-qchip--icon')).toHaveLength(6);
    expect(within(toolbar).getByLabelText('Cursor — connected')).toBeTruthy();

    const expected = {
      anthropic: ['connected', '✓'],
      openai: ['disconnected', '○'],
      hermes: ['unavailable', '×'],
      gemini: ['unknown', '?'],
    } as const;
    for (const [provider, [stateName, mark]] of Object.entries(expected)) {
      const chip = within(toolbar).getByTestId(`quick-provider-${provider}`);
      expect(chip.getAttribute('data-provider-state')).toBe(stateName);
      expect(chip.querySelector('.pn-qchip__state')?.textContent).toBe(mark);
    }
  });

  it('keeps connected launchers on the existing spawn gate', async () => {
    render(<ResourcePanel {...panel()} />);
    const claude = await screen.findByLabelText('Claude — connected') as HTMLButtonElement;

    expect(claude.disabled).toBe(true);
    expect(claude.title).toMatch(/Choose a task and agent/);
  });

  it('does not offer a click for a provider whose CLI is unavailable', async () => {
    render(<ResourcePanel {...panel()} />);
    const hermes = await screen.findByLabelText('Hermes — unavailable');

    expect(hermes.tagName).toBe('SPAN');
    expect(hermes.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(hermes);
    expect(calls.some((call) => call.url.includes('/credentials/login-sessions'))).toBe(false);
  });

  it('starts the sign-in terminal for a disconnected provider and exposes finish', async () => {
    const p = panel();
    render(<ResourcePanel {...p} />);
    fireEvent.click(await screen.findByLabelText('Codex — disconnected'));

    await waitFor(() => expect(calls).toContainEqual(expect.objectContaining({
      method: 'POST',
      url: expect.stringContaining('/v2/identity/credentials/login-sessions'),
      body: { spaceId: SPACE, provider: 'openai' },
    })));
    expect(p.onOpenSession).toHaveBeenCalledWith('ws_login');

    fireEvent.click(screen.getByRole('button', { name: "I've finished" }));
    await waitFor(() => expect(calls.some((call) =>
      call.url.endsWith('/v2/identity/credentials/login-sessions/ws_login/finish'),
    )).toBe(true));
  });

  it('lists work_sessions through collections.query, grouped live/finished', async () => {
    render(<ResourcePanel {...panel()} />);
    await waitFor(() => expect(screen.getByText(/live · 1/)).toBeTruthy());
    expect(screen.getByText(/finished · 1/)).toBeTruthy();

    const q = calls.find((k) => k.url.includes('/v2/collections/query'));
    expect(q?.body.kinds).toEqual(['work_session']);
    expect(q?.body.sort).toBe('activityAt_desc');
  });

  it('drives the center pane on click rather than mounting a terminal', async () => {
    const p = panel();
    render(<ResourcePanel {...p} />);
    await waitFor(() => expect(screen.getAllByText('Session').length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByText('Session')[0]!);
    expect(p.onOpenSession).toHaveBeenCalledWith(LIVE_ID);
    // One terminal, one owner: a terminal per row would blow the GPU-context cap.
    expect(screen.queryByTestId('session-terminal')).toBeNull();
  });

  it('shows the live badge only when something is live', async () => {
    render(<ResourcePanel {...panel()} />);
    await waitFor(() => expect(screen.getByLabelText('1 live')).toBeTruthy());
  });

  it('captions the absent transcript instead of implying scrollback is one', async () => {
    render(<ResourcePanel {...panel()} />);
    await waitFor(() => expect(screen.getByText(/not a saved transcript/i)).toBeTruthy());
  });

  it('lists team_members and hides the hollow liveWork field', async () => {
    render(<ResourcePanel {...panel()} />);
    fireEvent.click(screen.getByTestId('res-tab-agents'));
    await waitFor(() => expect(screen.getByText('Rhea')).toBeTruthy());

    const q = calls.filter((k) => k.url.includes('/v2/collections/query')).find((k) => k.body.kinds?.[0] === 'team_member');
    expect(q).toBeTruthy();
    // The hollow field is captioned, never rendered as a confident status.
    expect(screen.getByText(/not shown/i)).toBeTruthy();
  });

  it('splits one doc query into Docs and Drawings', async () => {
    render(<ResourcePanel {...panel()} />);

    fireEvent.click(screen.getByTestId('res-tab-docs'));
    await waitFor(() => expect(screen.getByText('Notes')).toBeTruthy());
    expect(screen.queryByText('Architecture')).toBeNull();

    fireEvent.click(screen.getByTestId('res-tab-drawings'));
    await waitFor(() => expect(screen.getByText('Architecture')).toBeTruthy());
    expect(screen.queryByText('Notes')).toBeNull();

    // ONE query served both tabs.
    const docQueries = calls.filter((k) => k.url.includes('/v2/collections/query') && k.body.kinds?.[0] === 'doc');
    expect(docQueries).toHaveLength(1);
  });

  it('opens a drawing read-only and reports its element count', async () => {
    render(<ResourcePanel {...panel()} />);
    fireEvent.click(screen.getByTestId('res-tab-drawings'));
    await waitFor(() => expect(screen.getByText('Architecture')).toBeTruthy());
    fireEvent.click(screen.getByText('Architecture'));

    await waitFor(() => expect(screen.getByTestId('drawing-viewer')).toBeTruthy());
    expect(screen.getByText(/2 elements/)).toBeTruthy();
    const area = screen.getByLabelText(/Scene source/) as HTMLTextAreaElement;
    expect(area.readOnly).toBe(true);
  });
});

describe('DocsTab — writes', () => {
  it('saves with expectedVersion so a concurrent edit cannot be silently clobbered', async () => {
    const facade = new RealFacade(new TmClient());
    render(<DocsTab facade={facade} spaceId={SPACE} />);
    await waitFor(() => expect(screen.getByText('Notes')).toBeTruthy());
    fireEvent.click(screen.getByText('Notes'));

    await waitFor(() => expect(screen.getByTestId('doc-editor')).toBeTruthy());
    const area = await screen.findByLabelText(/Body of Notes/);
    fireEvent.change(area, { target: { value: '# rewritten' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const patch = calls.find((k) => k.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(patch!.body.expectedVersion).toBe(3);
      expect(patch!.body.content.body).toBe('# rewritten');
    });
  });

  it('refuses a body over the server cap before sending it', async () => {
    const facade = new RealFacade(new TmClient());
    render(<DocsTab facade={facade} spaceId={SPACE} />);
    await waitFor(() => expect(screen.getByText('Notes')).toBeTruthy());
    fireEvent.click(screen.getByText('Notes'));
    const area = await screen.findByLabelText(/Body of Notes/);

    fireEvent.change(area, { target: { value: 'x'.repeat(200_001) } });
    const save = screen.getByText('Save') as HTMLButtonElement;
    // Disabled, with the reason — not a 500 from Postgres.
    expect(save.disabled).toBe(true);
    expect(save.title).toMatch(/200,000/);
    expect(calls.some((k) => k.method === 'PATCH')).toBe(false);
  });

  it('creates a doc through entities.create with a markdown default', async () => {
    const facade = new RealFacade(new TmClient());
    render(<DocsTab facade={facade} spaceId={SPACE} />);
    await waitFor(() => expect(screen.getByText('Notes')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('New document title'), { target: { value: 'Fresh' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => {
      const post = calls.find((k) => k.method === 'POST' && k.url.includes('/v2/entities'));
      expect(post?.body).toMatchObject({ kind: 'doc', title: 'Fresh', content: { format: 'markdown' } });
    });
  });
});
