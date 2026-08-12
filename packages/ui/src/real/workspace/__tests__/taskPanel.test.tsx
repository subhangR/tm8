/**
 * REAL-PATH tests for the workspace's left column.
 *
 * Same discipline as `real/__tests__/sessions.test.tsx`, and for the same
 * reason: the module's ~850 tests all run against `MockFacade`, so a suite that
 * never touches `RealFacade` cannot see the thing that actually breaks — the
 * wire shape. These drive `TaskPanel` → `RealFacade` → `TmClient` → HTTP with
 * only `fetch` stubbed, and assert on the BODIES that go over the wire.
 *
 * The three regressions they exist to catch:
 *   1. a write that loses `expectedVersion` or `completerIds` and starts 400ing
 *      (or worse, starts overwriting changes the panel never rendered);
 *   2. the Run button losing its `tm8:spawn-request` detail, which silently
 *      disconnects the entire spawn loop — the panel would still look fine;
 *   3. the reorder grip becoming enabled against a 501 operation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RealFacade } from '../../RealFacade';
import { TmClient } from '../../TmClient';
import { SPAWN_REQUEST_EVENT, SESSION_SPAWNED_EVENT } from '../../tm8Kinds';
import { TaskPanel } from '../TaskPanel';
import { __resetViewerCache } from '../useTasks';
import { __resetPollRegistry } from '../usePolledCollection';

const SPACE = '019f98b3-3989-7cd2-826a-af4291250e52';
const VIEWER = '019f98b3-3989-7d23-a745-8cfbc91081a1';

function actor(id: string, displayName: string) {
  return { id, kind: 'member', displayName, avatar: null, isAgent: false };
}

function task(
  id: string,
  title: string,
  parentId: string | null = null,
  workStatus = 'open',
  extra: { assignees?: unknown[]; dueDate?: string | null } = {},
) {
  return {
    id, spaceId: SPACE, kind: 'task', title, parentId, position: 1,
    visibility: 'space', version: 7,
    activityAt: '2026-07-25T12:24:14.651Z',
    createdAt: '2026-07-25T09:55:10.388Z',
    updatedAt: '2026-07-25T09:55:10.630Z',
    deletedAt: null,
    createdBy: { id: VIEWER, kind: 'member', displayName: 'Owner', avatar: null, isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'task', workStatus, priority: 'high', axes: {}, dueDate: extra.dueDate ?? null,
      assignees: extra.assignees ?? [], acceptance: { total: 0, completed: 0 },
    },
    badges: {},
  };
}

const ROWS = [task('t_parent', 'Parent task'), task('t_child', 'Child task', 't_parent'), task('t_solo', 'Solo task', null, 'done')];

let calls: Array<{ method: string; url: string; body: any }> = [];

const TRUSTED_PROJECT = 'prj_trusted';
const MEMBER_ID = 'tm_echo';
const NEW_SESSION = 'ws_new';

function project(id: string, trust: 'trusted' | 'untrusted') {
  return {
    id, name: id, repoUrl: null, workingDir: `/tmp/${id}`, trust,
    defaults: {}, createdAt: '2026-07-25T00:00:00Z', updatedAt: '2026-07-25T00:00:00Z',
  };
}

function stubNode(
  items: unknown[] = ROWS,
  opts: { projects?: unknown[]; linked?: unknown[] } = {},
) {
  // Untrusted first on purpose: execution.spawn REFUSES untrusted projects, so
  // resolution must skip it rather than pick the head of the list.
  const projects = opts.projects ?? [project('prj_untrusted', 'untrusted'), project(TRUSTED_PROJECT, 'trusted')];
  // `linked` models GET /v2/projects?spaceId= — the SPACE's linked projects,
  // which is a different set from the node's projects. Defaults to "the trusted
  // one is already linked"; pass [] for the not-yet-linked case.
  const linked = opts.linked ?? [project(TRUSTED_PROJECT, 'trusted')];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const u = String(url);
    calls.push({ method, url: u, body });

    let data: unknown = {};
    if (u.includes('/v2/execution/spawn')) {
      data = { entity: { id: NEW_SESSION, kind: 'work_session' }, patches: [] };
    } else if (u.includes('/v2/spaces/') && u.includes('/projects')) {
      data = { spaceId: SPACE, projectId: body?.projectId, patches: [] };
    } else if (u.includes('/v2/projects')) {
      // Scoped vs unscoped is the whole bug: the unfiltered list is node-wide.
      data = u.includes('spaceId=') ? linked : projects;
    } else if (u.includes('/v2/collections/query')) {
      const kinds: string[] = body?.kinds ?? [];
      data = kinds.includes('team_member')
        ? { query: body, page: { items: [{ id: MEMBER_ID, kind: 'team_member', title: 'Echo Agent' }], nextCursor: null } }
        : { query: body, page: { items, nextCursor: null } };
    } else if (u.includes('/navigation')) {
      // The only read on this node that names the caller — `completeTask`
      // refuses without it, so the panel genuinely depends on this shape.
      data = {
        spaceId: SPACE,
        viewer: { id: VIEWER, kind: 'member', displayName: 'Owner', avatar: null, role: 'owner', isAgent: false },
        unreadTotal: 0, channels: [],
      };
    } else {
      data = { patches: [] };
    }
    return {
      ok: true, status: 200, text: async () => JSON.stringify({ data, requestId: 'req_test' }),
    } as unknown as Response;
  }));
}

function panel(over: Partial<React.ComponentProps<typeof TaskPanel>> = {}) {
  return (
    <TaskPanel
      facade={new RealFacade(new TmClient())}
      spaceId={SPACE}
      selectedTaskId={null}
      onSelectTask={vi.fn()}
      {...over}
    />
  );
}

const bodyOf = (fragment: string) => calls.filter((c) => c.url.includes(fragment)).at(-1)?.body;

beforeEach(() => { calls = []; __resetPollRegistry(); __resetViewerCache(); stubNode(); });
afterEach(() => { __resetPollRegistry(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('reading tasks', () => {
  it('queries real tasks through collections.query and renders the wire shape', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    const query = calls.find((c) => c.url.includes('/v2/collections/query'));
    expect(query?.method).toBe('POST');
    expect(query?.body.kinds).toEqual(['task']);
    expect(query?.body.spaceId).toBe(SPACE);
    // Sorted by something that is real today. `position` is deliberately not
    // offered: it can only be WRITTEN through `entities.move`, which is 501.
    expect(query?.body.sort).toBe('priority');
  });

  it('nests children and only shows them once expanded', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    expect(screen.queryByTestId('task-title-t_child')).toBeNull();
    fireEvent.click(screen.getByTestId('task-caret-t_parent'));
    expect(screen.getByTestId('task-title-t_child')).toBeTruthy();

    // And collapsing puts it back — expansion is state, not a one-way door.
    fireEvent.click(screen.getByTestId('task-caret-t_parent'));
    expect(screen.queryByTestId('task-title-t_child')).toBeNull();
  });

  it('sends the status filter to the server instead of filtering the page locally', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    fireEvent.click(screen.getByTestId('task-filter-working'));

    await waitFor(() => expect(bodyOf('/v2/collections/query')?.filters).toEqual({ workStatus: ['working'] }));
  });

  it('changing the sort re-asks the server', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    fireEvent.change(screen.getByTestId('task-sort'), { target: { value: 'dueDate' } });

    await waitFor(() => expect(bodyOf('/v2/collections/query')?.sort).toBe('dueDate'));
  });

  it('says an empty space is empty, and says a filtered empty is a real answer', async () => {
    stubNode([]);
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-empty')).toBeTruthy());
    expect(screen.getByTestId('task-empty').textContent).toMatch(/No tasks in this space yet/i);

    fireEvent.click(screen.getByTestId('task-filter-done'));
    await waitFor(() => expect(screen.getByTestId('task-empty').textContent).toMatch(/the server filtered these/i));
  });
});

describe('filtering by assignee', () => {
  const ADA = actor('act_ada', 'Ada');
  const BRAM = actor('act_bram', 'Bram');
  const PAST = '2020-01-01T00:00:00.000Z';
  const FUTURE = '2999-01-01T00:00:00.000Z';

  // Deliberately client-side, and this is the one design call worth pinning:
  // `filters.assigneeIds` exists server-side, but the option list has to come
  // from somewhere and `RealFacade.getSpace` reports `unavailable.members`.
  // Filtering the page keeps the option list stable — a server-side filter would
  // shrink the very rows the options are read from, so selecting Ada would erase
  // Bram from the menu and strand the user inside their own filter.
  const ASSIGNED = [
    task('t_ada', 'Ada task', null, 'open', { assignees: [ADA], dueDate: PAST }),
    task('t_ada_future', 'Ada later task', null, 'open', { assignees: [ADA], dueDate: FUTURE }),
    task('t_bram', 'Bram task', null, 'open', { assignees: [BRAM], dueDate: PAST }),
    task('t_both', 'Shared task', null, 'open', { assignees: [ADA, BRAM] }),
    task('t_nobody', 'Unassigned task'),
  ];

  const titles = () => screen.queryAllByTestId(/^task-title-/).map((el) => el.getAttribute('data-testid'));

  async function open() {
    stubNode(ASSIGNED);
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_ada')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-filter-assignee'));
  }

  it('offers the people on the loaded tasks, once each and by name', async () => {
    await open();
    const options = screen.getByTestId('task-assignee-options');
    expect(options.textContent).toContain('Ada');
    expect(options.textContent).toContain('Bram');
    // Ada is on three tasks; she is one option, not three.
    expect(screen.getAllByTestId('task-filter-assignee-act_ada')).toHaveLength(1);
  });

  it('shows only that person’s tasks when one is selected', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));

    expect(titles()).toEqual(expect.arrayContaining([
      'task-title-t_ada', 'task-title-t_ada_future', 'task-title-t_both',
    ]));
    expect(titles()).not.toContain('task-title-t_bram');
    // No new server round-trip: this narrows the page the panel already has.
    expect(bodyOf('/v2/collections/query')?.filters?.assigneeIds).toBeUndefined();
  });

  it('is OR across the selection, not AND', async () => {
    // THE EDGE CASE. An `every` over the selected ids returns the empty list,
    // because almost no task is assigned to everyone you picked — and an empty
    // list reads as "nobody has any tasks" rather than as a broken predicate.
    await open();
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_bram'));

    expect(titles()).toEqual(expect.arrayContaining([
      'task-title-t_ada', 'task-title-t_bram', 'task-title-t_both',
    ]));
    expect(titles()).not.toContain('task-title-t_nobody');
  });

  it('hides a task with no assignees while any person is selected, and brings it back', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));
    expect(titles()).not.toContain('task-title-t_nobody');

    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));
    expect(titles()).toContain('task-title-t_nobody');
  });

  it('composes with Overdue and counts as an active filter', async () => {
    await open();
    // From a clean slate: the panel BOOTS with sort `priority`, which is itself
    // one active filter, so the badge reads 1 before anything is touched.
    // Clearing first makes this assert the two filters under test, not that plus
    // a default the user never chose.
    fireEvent.click(screen.getByText('All'));
    await waitFor(() => expect(screen.queryByTestId('task-filter-count')).toBeNull());
    fireEvent.click(screen.getByTestId('task-filter-assignee'));
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));
    fireEvent.click(screen.getByText('Overdue'));

    // Ada AND overdue: her future-dated task and Bram's overdue one both drop.
    expect(titles()).toContain('task-title-t_ada');
    expect(titles()).not.toContain('task-title-t_ada_future');
    expect(titles()).not.toContain('task-title-t_bram');
    // The badge must learn about the new filter or it under-reports what is on.
    expect(screen.getByTestId('task-filter-count').textContent).toBe('2');
  });

  it('keeps a selected person selectable after their last visible task moves away', async () => {
    // Otherwise the filter stays ON, keeps hiding rows, and the only control
    // that could turn it off has disappeared from the menu.
    await open();
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));
    stubNode([task('t_bram', 'Bram task', null, 'open', { assignees: [BRAM] })]);

    await waitFor(() => expect(screen.getByTestId('task-filter-assignee-act_ada')).toBeTruthy());
    // 2 = the selected person plus the panel's default `priority` sort.
    expect(screen.getByTestId('task-filter-count').textContent).toBe('2');
  });

  it('clearing with All drops the assignee filter too', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));
    fireEvent.click(screen.getByText('All'));

    // All also resets tab, statuses and sort, which re-asks the server — hence
    // the wait: the rows blank out until that answer lands.
    await waitFor(() => expect(titles()).toContain('task-title-t_nobody'));
    expect(screen.queryByTestId('task-filter-count')).toBeNull();
  });

  it('says an assignee-empty list is scoped to the page, not settled by the server', async () => {
    await open();
    fireEvent.click(screen.getByTestId('task-filter-assignee-act_ada'));
    fireEvent.change(screen.getByPlaceholderText('Search tasks'), { target: { value: 'zzzz' } });

    expect(screen.getByTestId('task-empty').textContent).toMatch(/on the tasks loaded/i);
  });
});

describe('writing tasks', () => {
  it('creates a task through entities.create with the space and kind', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    fireEvent.change(screen.getByTestId('task-new-input'), { target: { value: 'Ship the workspace' } });
    fireEvent.click(screen.getByTestId('task-new-submit'));

    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v2/entities'))).toBe(true));
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/v2/entities'))!.body;
    expect(created).toMatchObject({ spaceId: SPACE, kind: 'task', title: 'Ship the workspace' });
    expect(created.actorId).toBe(VIEWER);
  });

  it('renames through entities.patch carrying expectedVersion', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    fireEvent.doubleClick(screen.getByTestId('task-title-t_parent'));
    const input = screen.getByTestId('task-title-input-t_parent');
    fireEvent.change(input, { target: { value: 'Renamed' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(bodyOf('/v2/entities/t_parent')).toBeTruthy());
    // Optimistic concurrency is the whole point: a stale panel must lose loudly
    // rather than overwrite an edit it never rendered.
    expect(bodyOf('/v2/entities/t_parent')).toMatchObject({ title: 'Renamed', expectedVersion: 7 });
  });

  it('does not write when a rename did not change the title', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    fireEvent.doubleClick(screen.getByTestId('task-title-t_parent'));
    fireEvent.keyDown(screen.getByTestId('task-title-input-t_parent'), { key: 'Enter' });

    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('sets status through content.workStatus — a real patch, not a client label', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-status-t_parent')).toBeTruthy());

    fireEvent.change(screen.getByTestId('task-status-t_parent'), { target: { value: 'working' } });

    await waitFor(() => expect(bodyOf('/v2/entities/t_parent')?.content).toEqual({ workStatus: 'working' }));
    expect(bodyOf('/v2/entities/t_parent')?.expectedVersion).toBe(7);
  });

  it('completes with expectedVersion AND a completerId read from navigation', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-complete-t_parent')).toBeTruthy());
    // The viewer read has to have landed, or the facade refuses before the wire.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/navigation'))).toBe(true));

    fireEvent.click(screen.getByTestId('task-complete-t_parent'));

    await waitFor(() => expect(bodyOf('/commands/complete')).toBeTruthy());
    expect(bodyOf('/commands/complete')).toMatchObject({ expectedVersion: 7, completerIds: [VIEWER] });
  });

  it('disables Done on a task the graph already finished', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-complete-t_solo')).toBeTruthy());
    expect((screen.getByTestId('task-complete-t_solo') as HTMLButtonElement).disabled).toBe(true);
  });

  it('surfaces a write failure instead of pretending it saved', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-new-input')).toBeTruthy());

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 409,
      text: async () => JSON.stringify({ error: { code: 'conflict', message: 'version conflict' } }),
    } as unknown as Response)));

    fireEvent.change(screen.getByTestId('task-new-input'), { target: { value: 'Doomed' } });
    fireEvent.click(screen.getByTestId('task-new-submit'));

    await waitFor(() => expect(screen.getByTestId('task-error')).toBeTruthy());
  });
});

describe('the spawn loop and the honest refusal', () => {
  it('Run SPAWNS DIRECTLY — no dialog, no tm8:spawn-request', async () => {
    // THE BEHAVIOUR THIS PINS, and it is a deliberate reversal of what this
    // test used to assert. Run previously raised `tm8:spawn-request` and opened
    // SpawnDialog to ask for a project and a persona. maestro does not: its Run
    // calls `onExecute(selectedMemberId || undefined)` and resolves the rest
    // (ExecutionBar.tsx). So Run now spawns, and the dialog is reserved for the
    // entity-card surface where choosing is the point.
    const dialogReqs: unknown[] = [];
    const spawned: Array<{ sessionId: string; taskId: string }> = [];
    const onReq = (e: Event) => dialogReqs.push((e as CustomEvent).detail);
    const onSpawned = (e: Event) => spawned.push((e as CustomEvent).detail);
    window.addEventListener(SPAWN_REQUEST_EVENT, onReq);
    window.addEventListener(SESSION_SPAWNED_EVENT, onSpawned);

    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-run-t_parent')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-run-t_parent'));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/v2/execution/spawn'))).toBe(true));
    window.removeEventListener(SPAWN_REQUEST_EVENT, onReq);
    window.removeEventListener(SESSION_SPAWNED_EVENT, onSpawned);

    // The spawn body carries everything resolved WITHOUT asking the user.
    const body = calls.find((c) => c.url.includes('/v2/execution/spawn'))!.body;
    expect(body).toMatchObject({ spaceId: SPACE, taskIds: ['t_parent'] });
    expect(body.projectId).toBe(TRUSTED_PROJECT);
    expect(body.teamMemberId).toBe(MEMBER_ID);

    // NO dialog was asked for. This is the regression that matters: a
    // reintroduced prompt would still spawn eventually and look fine.
    expect(dialogReqs).toEqual([]);

    // And the workspace is told, so the centre pane attaches the new terminal
    // rather than leaving a live agent nothing points at.
    expect(spawned).toEqual([{ sessionId: NEW_SESSION, taskId: 't_parent' }]);
  });

  it('resolves the SPACE-LINKED project, not the first project on the node', async () => {
    // THE BUG THIS PINS, and it blocked a real user: execution.spawn requires
    // the project be linked to the task's SPACE, but the unfiltered
    // GET /v2/projects is node-wide. Resolving from it picked a project linked
    // to some OTHER space and the server refused with
    // "project ... is not linked to this space".
    stubNode(ROWS, {
      projects: [project('prj_other_space', 'trusted'), project(TRUSTED_PROJECT, 'trusted')],
      linked: [project(TRUSTED_PROJECT, 'trusted')],
    });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-run-t_parent')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-run-t_parent'));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/v2/execution/spawn'))).toBe(true));
    // The node-wide list's FIRST trusted entry is prj_other_space; taking it
    // would reproduce the outage. The space-scoped answer must win.
    expect(calls.find((c) => c.url.includes('/v2/execution/spawn'))!.body.projectId).toBe(TRUSTED_PROJECT);
    expect(calls.some((c) => c.url.includes('spaceId='))).toBe(true);
  });

  it('LINKS a trusted project when the space has none, instead of dead-ending', async () => {
    stubNode(ROWS, { linked: [] });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-run-t_parent')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-run-t_parent'));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/v2/execution/spawn'))).toBe(true));
    // Linked first, then spawned — and the link names the trusted project.
    const link = calls.find((c) => c.method === 'POST' && /\/v2\/spaces\/.*\/projects$/.test(c.url));
    expect(link).toBeTruthy();
    expect(link!.body.projectId).toBe(TRUSTED_PROJECT);
    expect(calls.indexOf(link!)).toBeLessThan(calls.findIndex((c) => c.url.includes('/v2/execution/spawn')));
    expect(calls.find((c) => c.url.includes('/v2/execution/spawn'))!.body.projectId).toBe(TRUSTED_PROJECT);
  });

  it('does NOT relink when the space already has a linked project', async () => {
    stubNode(ROWS, { linked: [project(TRUSTED_PROJECT, 'trusted')] });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-run-t_parent')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-run-t_parent'));

    await waitFor(() => expect(calls.some((c) => c.url.includes('/v2/execution/spawn'))).toBe(true));
    expect(calls.some((c) => c.method === 'POST' && /\/v2\/spaces\/.*\/projects$/.test(c.url))).toBe(false);
  });

  it('surfaces a spawn failure instead of a Run button that does nothing', async () => {
    // A Run that silently no-ops is indistinguishable from a slow spawn, and
    // there is nothing on screen to read. Resolution failures must be visible.
    stubNode(ROWS, { projects: [], linked: [] });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-run-t_parent')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-run-t_parent'));

    await waitFor(() => expect(screen.getByTestId('task-error')).toBeTruthy());
    expect(screen.getByTestId('task-error').textContent).toMatch(/project/i);
  });

  it('renders the reorder grip DISABLED with its reason rather than hiding it', async () => {
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-grip-t_parent')).toBeTruthy());

    const grip = screen.getByTestId('task-grip-t_parent') as HTMLButtonElement;
    // Shown, dimmed, explained. A hidden handle reads as "this product does not
    // reorder tasks"; an enabled one would throw against a 501. The sentence is
    // Unavailable.tsx's — asserted here so a lane that re-enables the write has
    // to come through the capability register rather than around it.
    expect(grip.title).toMatch(/moveEntity is not implemented on this node/);
    expect(grip.disabled).toBe(true);
  });
});

describe('selection', () => {
  it('clicking a title selects it, and clicking the selected one clears it', async () => {
    const onSelectTask = vi.fn();
    render(panel({ onSelectTask, selectedTaskId: null }));
    await waitFor(() => expect(screen.getByTestId('task-title-t_parent')).toBeTruthy());

    fireEvent.click(screen.getByTestId('task-title-t_parent'));
    expect(onSelectTask).toHaveBeenCalledWith('t_parent');

    __resetPollRegistry();
    render(panel({ onSelectTask, selectedTaskId: 't_parent' }));
    await waitFor(() => expect(screen.getAllByTestId('task-title-t_parent').length).toBeGreaterThan(1));
    fireEvent.click(screen.getAllByTestId('task-title-t_parent')[1]!);
    expect(onSelectTask).toHaveBeenLastCalledWith(null);
  });
});
