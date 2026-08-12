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

const ADA = actor('019f98b3-0000-7000-8000-00000000ada0', 'Ada');
const BRAM = actor('019f98b3-0000-7000-8000-00000000b7a0', 'Bram');
/** Cleo has no tasks anywhere — she is how we prove the menu is a ROSTER read. */
const CLEO = actor('019f98b3-0000-7000-8000-00000000c1e0', 'Cleo');

function actorRow(a: { id: string; displayName: string }, kind = 'member') {
  return { id: a.id, spaceId: SPACE, kind, title: a.displayName, parentId: null, version: 1 };
}
const ROSTER = [actorRow(ADA), actorRow(BRAM), actorRow(CLEO)];

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
  items: any[] = ROWS,
  opts: { projects?: unknown[]; linked?: unknown[]; actors?: unknown[] } = {},
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
      if (kinds.includes('member')) {
        // The ROSTER read. `member`/`team_member` are ordinary entity rows and
        // `collections.query` has no kind allowlist, so this is the real shape.
        data = { query: body, page: { items: opts.actors ?? ROSTER, nextCursor: null } };
      } else if (kinds.includes('team_member')) {
        data = { query: body, page: { items: [{ id: MEMBER_ID, kind: 'team_member', title: 'Echo Agent' }], nextCursor: null } };
      } else {
        // Model `filters.assigneeIds` the way the server implements it —
        // `dst_id = any(...)` over `assigned_to` edges, i.e. OR across the set.
        // Without this the list assertions below would be testing the stub's
        // indifference rather than the filter.
        const ids: string[] | undefined = body?.filters?.assigneeIds;
        const page = ids && ids.length > 0
          ? items.filter((t: any) => (t?.state?.assignees ?? []).some((a: any) => ids.includes(a.id)))
          : items;
        data = { query: body, page: { items: page, nextCursor: null } };
      }
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
  const PAST = '2020-01-01T00:00:00.000Z';
  const FUTURE = '2999-01-01T00:00:00.000Z';

  const ASSIGNED = [
    task('t_ada', 'Ada task', null, 'open', { assignees: [ADA], dueDate: PAST }),
    task('t_ada_future', 'Ada later task', null, 'open', { assignees: [ADA], dueDate: FUTURE }),
    task('t_bram', 'Bram task', null, 'open', { assignees: [BRAM], dueDate: PAST }),
    task('t_both', 'Shared task', null, 'open', { assignees: [ADA, BRAM] }),
    task('t_nobody', 'Unassigned task'),
  ];

  const titles = () => screen.queryAllByTestId(/^task-title-/).map((el) => el.getAttribute('data-testid'));
  // The roster read is also a `collections.query`, so the generic `bodyOf` can
  // return it instead of the task query. Always ask for the TASK one.
  const taskQuery = () => calls
    .filter((c) => c.url.includes('/v2/collections/query') && (c.body?.kinds ?? []).includes('task'))
    .at(-1)?.body;
  const filters = () => taskQuery()?.filters;

  async function open(items: any[] = ASSIGNED, opts: { actors?: unknown[] } = {}) {
    stubNode(items, opts);
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-filter-assignee'));
    await waitFor(() => expect(screen.getByTestId(`task-filter-assignee-${ADA.id}`)).toBeTruthy());
  }

  it('asks the SERVER to filter, through filters.assigneeIds', async () => {
    // The whole design in one assertion. `assigneeIds` is real SQL over
    // `assigned_to` edges, so the answer covers the space rather than the page —
    // and a match inside a collapsed parent cannot go missing.
    await open();
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));

    await waitFor(() => expect(filters()?.assigneeIds).toEqual([ADA.id]));
  });

  it('offers people who have NO tasks — the menu is a roster, not a scrape of the page', async () => {
    // Cleo is assigned nothing. A menu built from the loaded tasks could never
    // list her, which is exactly why that design was wrong: you could not filter
    // by a teammate until they already had visible work.
    await open();
    expect(screen.getByTestId(`task-filter-assignee-${CLEO.id}`).textContent).toContain('Cleo');
    // And picking her is a real, empty, server-side answer.
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${CLEO.id}`));
    await waitFor(() => expect(screen.getByTestId('task-empty').textContent).toMatch(/the server filtered these/i));
  });

  it('lists agents alongside people, marked as agents', async () => {
    await open(ASSIGNED, { actors: [actorRow(ADA), actorRow({ id: MEMBER_ID, displayName: 'Echo Agent' }, 'team_member')] });
    const agent = screen.getByTestId(`task-filter-assignee-${MEMBER_ID}`);
    expect(agent.textContent).toContain('Echo Agent');
    // An agent is assignable exactly like a person; hiding them would hide work.
    expect(agent.textContent).toContain('agent');
  });

  it('is OR across the selection, not AND', async () => {
    // THE EDGE CASE, now pinned at the seam that decides it: the server's
    // `dst_id = any(...)`. Both ids go over the wire as a set, and tasks
    // belonging to either come back — a task assigned only to Ada survives
    // "Ada or Bram" though it is not also Bram's.
    await open();
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${BRAM.id}`));

    await waitFor(() => expect(filters()?.assigneeIds).toEqual([ADA.id, BRAM.id]));
    await waitFor(() => expect(titles()).toContain('task-title-t_bram'));
    expect(titles()).toEqual(expect.arrayContaining([
      'task-title-t_ada', 'task-title-t_bram', 'task-title-t_both',
    ]));
    expect(titles()).not.toContain('task-title-t_nobody');
  });

  it('finds a match inside a COLLAPSED parent instead of reporting zero', async () => {
    // THE BUG THE CLIENT-SIDE VERSION HAD, and it is the normal shape of a
    // task tree: subtasks carry the assignment, parents do not. Filtering the
    // fetched page ran over `flattenTree`, which omits a collapsed parent's
    // children entirely — so picking Ada showed an empty list while Ada's task
    // sat one click away. Server-side, the row comes back and `buildTaskTree`
    // promotes it to a root because its parent is not in the page.
    await open([
      task('t_parent', 'Unassigned parent'),
      task('t_child', 'Ada subtask', 't_parent', 'open', { assignees: [ADA] }),
    ]);
    expect(screen.queryByTestId('task-title-t_child')).toBeNull(); // collapsed

    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));

    await waitFor(() => expect(screen.getByTestId('task-title-t_child')).toBeTruthy());
    expect(screen.queryByTestId('task-empty')).toBeNull();
  });

  it('drops a task with no assignees while a person is selected, and brings it back', async () => {
    await open();
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));
    await waitFor(() => expect(titles()).not.toContain('task-title-t_nobody'));

    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));
    await waitFor(() => expect(titles()).toContain('task-title-t_nobody'));
    // NB the unfiltered rows come back from the poll registry's warm entry
    // rather than a fresh request, so there is no new wire body to inspect here.
    // That `assigneeIds` is dropped rather than sent empty is pinned directly on
    // the query factory in taskTree.test.ts — an `assigneeIds: []` would filter
    // everything out instead of nothing.
  });

  it('composes with Overdue and counts as an active filter', async () => {
    await open();
    // The panel BOOTS with sort `priority`, which the count treats as an active
    // filter, so the badge reads 1 before anything is touched. Clear first, or
    // this would assert that quirk rather than the two filters under test.
    fireEvent.click(screen.getByText('All'));
    await waitFor(() => expect(screen.queryByTestId('task-filter-count')).toBeNull());
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));
    fireEvent.click(screen.getByText('Overdue'));

    // Ada AND overdue. Her future-dated task and Bram's overdue one both drop —
    // one filter applied by the server, one in the browser, composing.
    await waitFor(() => expect(titles()).toEqual(['task-title-t_ada']));
    expect(screen.getByTestId('task-filter-count').textContent).toBe('2');
  });

  it('clears the whole selection from inside the menu', async () => {
    // WHY THIS ROW EXISTS: a selected person who has since left the space is no
    // longer in the roster, so their own row is gone and cannot un-select them —
    // the filter would stay on, hiding rows, with nothing on screen to switch it
    // off. This clear does not depend on the roster containing anyone.
    // (The vanishing itself is not driven here: the roster polls at
    // ACTOR_POLL_MS = 30s, which a test cannot wait out honestly.)
    await open();
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${BRAM.id}`));
    await waitFor(() => expect(filters()?.assigneeIds).toEqual([ADA.id, BRAM.id]));
    expect(screen.getByTestId('task-filter-assignee-clear').textContent).toContain('2');

    fireEvent.click(screen.getByTestId('task-filter-assignee-clear'));

    await waitFor(() => expect(titles()).toContain('task-title-t_nobody'));
    expect(screen.queryByTestId('task-filter-assignee-clear')).toBeNull();
    expect(screen.getByTestId('task-filter-assignee').textContent).not.toContain('·');
  });

  it('clearing with All drops the assignee filter too', async () => {
    await open();
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${ADA.id}`));
    await waitFor(() => expect(filters()?.assigneeIds).toEqual([ADA.id]));

    fireEvent.click(screen.getByText('All'));

    await waitFor(() => expect(titles()).toContain('task-title-t_nobody'));
    expect(filters()?.assigneeIds).toBeUndefined();
    expect(screen.queryByTestId('task-filter-count')).toBeNull();
  });

  it('a server-filtered zero is called the server’s answer; a browser-filtered one is not', async () => {
    await open();
    fireEvent.click(screen.getByTestId(`task-filter-assignee-${CLEO.id}`));
    await waitFor(() => expect(screen.getByTestId('task-empty').textContent).toMatch(/the server filtered these/i));

    // Now add a filter the browser applies. The sentence must stop crediting the
    // server, because the server never saw this one — and with the page
    // truncated it may be hiding rows it never fetched.
    fireEvent.change(screen.getByPlaceholderText('Search tasks'), { target: { value: 'zzzz' } });
    expect(screen.getByTestId('task-empty').textContent).toMatch(/on the tasks loaded/i);
  });

  it('opening the assignee menu closes the status menu, and Escape closes both', async () => {
    // They are all `position: absolute; left: 0` on one row: two open at once is
    // two menus stacked on the same pixels.
    await open();
    expect(screen.getByTestId('task-filter-assignee').getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(screen.getByText(/^Status/));
    expect(screen.queryByTestId('task-assignee-options')).toBeNull();
    expect(screen.getByTestId('task-filter-assignee').getAttribute('aria-expanded')).toBe('false');

    // Toggling Status again really closes it. Clearing siblings with a
    // close-all-then-toggle pair would re-open it here instead.
    fireEvent.click(screen.getByText(/^Status/));
    expect(screen.getByTestId('task-filter-working')).toBeTruthy();
    expect(screen.getByText(/^Status/).getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(screen.getByTestId('task-filter-assignee'));
    expect(screen.getByTestId('task-assignee-options')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('task-assignee-options')).toBeNull();
  });

  it('closes the menu on a click outside it', async () => {
    await open();
    fireEvent.mouseDown(screen.getByTestId('task-list'));
    expect(screen.queryByTestId('task-assignee-options')).toBeNull();
  });

  it('says a failed roster read failed, instead of showing an empty space', async () => {
    stubNode(ASSIGNED, { actors: [] });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('task-list')).toBeTruthy());
    fireEvent.click(screen.getByTestId('task-filter-assignee'));
    await waitFor(() => expect(screen.getByTestId('task-assignee-options').textContent)
      .toMatch(/Nobody in this space yet/i));
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
