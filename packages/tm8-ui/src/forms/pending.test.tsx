// @vitest-environment jsdom
/**
 * Forms W3 session surfaces (decision 11): the batched pending read, the
 * session tile chip and the session panel banner, over a fake
 * `forms.pendingForSessions` and the fixture forms port.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DurableWorkspaceEvent, EntitySummary, StatusCategory } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../fixtures';
import type { ActionContext, QueryFilter } from '../domain';
import { EntityListPanel } from '../panels';
import { createFixtureFormsPort } from './fixture-port';
import { FORM_FIXTURE_FORMS, FORM_FIXTURE_IDS, FORM_FIXTURE_RESPONSES } from './fixtures';
import { PendingFormsBanner } from './PendingFormsBanner';
import {
  FORMS_PENDING_MAX_SESSIONS,
  PendingFormsProvider,
  createPendingFormsStore,
  type FormPendingItem,
  type FormPendingSession,
  type FormsPendingForSessionsResult,
  type PendingFormsSource,
} from './pending';
import { FormsPortProvider } from './seam';

const SPACE = FIXTURE_SPACE_ID as string;

/** A fake server: a per-session answer, every call recorded, events pushed by hand. */
function fakeSource(answerFor: (sessionId: string) => FormPendingSession | null) {
  const calls: string[][] = [];
  const listeners = new Set<(e: DurableWorkspaceEvent) => void>();
  const source: PendingFormsSource = {
    spaceId: SPACE,
    async pendingForSessions({ spaceId, sessionIds }): Promise<FormsPendingForSessionsResult> {
      expect(spaceId).toBe(SPACE);
      calls.push([...sessionIds]);
      return { sessions: sessionIds.map(answerFor).filter((s): s is FormPendingSession => s !== null) };
    },
    async formDetail(formId) {
      const f = FORM_FIXTURE_FORMS.find((x) => x.id === formId)!;
      return { id: f.id, title: f.title, version: f.version, content: { kind: 'form', ...f.content } };
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const emit = (e: object) => listeners.forEach((cb) => cb(e as DurableWorkspaceEvent));
  return { source, calls, emit };
}

const item = (formId: string, title: string, extra: Partial<FormPendingItem> = {}): FormPendingItem => ({
  formId, title, version: 1, structureVersion: 1, questionCount: 2, openedAt: null, draft: null, ...extra,
});

const pending = (workSessionId: string, forms: FormPendingItem[], queued = 0, total = forms.length): FormPendingSession => ({
  workSessionId, total, queued, forms,
});

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('the pending store', () => {
  it('batches every registered session into ONE read (no N+1)', async () => {
    const { source, calls } = fakeSource(() => null);
    const store = createPendingFormsStore(source, { debounceMs: 0 });
    for (const id of ['ws-a', 'ws-b', 'ws-c', 'ws-b']) store.register(id);
    await store.settled();
    expect(calls).toEqual([['ws-a', 'ws-b', 'ws-c']]);
    store.dispose();
  });

  it(`splits more than ${FORMS_PENDING_MAX_SESSIONS} sessions into bounded reads`, async () => {
    const { source, calls } = fakeSource(() => null);
    const store = createPendingFormsStore(source, { debounceMs: 0 });
    for (let i = 0; i < 150; i++) store.register(`ws-${i}`);
    await store.settled();
    expect(calls.map((c) => c.length)).toEqual([100, 50]);
    store.dispose();
  });

  it('refetches on the events that can change the answer, and only those', async () => {
    const answer = pending('ws-a', [item('form-1', 'One')]);
    const { source, calls, emit } = fakeSource((id) => (id === 'ws-a' ? answer : null));
    const store = createPendingFormsStore(source, { debounceMs: 0 });
    store.register('ws-a');
    await store.settled();
    expect(store.get('ws-a')).toEqual(answer);
    expect(store.get('ws-other')).toBeNull();

    const refetchesOn = async (e: object) => {
      const before = calls.length;
      emit(e);
      await store.settled();
      return calls.length - before;
    };
    const summary = (kind: string, id: string) => ({ ...fixtureSummaries[0], id, kind, state: { kind } });

    expect(await refetchesOn({ type: 'entity.upsert', entity: summary('form', 'form-new') })).toBe(1);
    expect(await refetchesOn({ type: 'entity.activity_touched', id: 'form-1', kind: 'form', activityAt: 'x' })).toBe(1);
    expect(await refetchesOn({ type: 'entity.upsert', entity: summary('work_session', 'ws-a') })).toBe(1);
    expect(await refetchesOn({ type: 'message.created', anchorId: 'form-1', message: {} })).toBe(1);
    // Nothing a pending answer depends on:
    expect(await refetchesOn({ type: 'entity.upsert', entity: summary('work_session', 'ws-elsewhere') })).toBe(0);
    expect(await refetchesOn({ type: 'entity.upsert', entity: summary('task', 't-1') })).toBe(0);
    expect(await refetchesOn({ type: 'message.created', anchorId: 'ws-a', message: {} })).toBe(0);
    store.dispose();
  });

  it('a burst of events costs one read', async () => {
    vi.useFakeTimers();
    try {
      const { source, calls, emit } = fakeSource(() => null);
      const store = createPendingFormsStore(source, { debounceMs: 300 });
      store.register('ws-a');
      await act(async () => { await vi.advanceTimersByTimeAsync(301); });
      expect(calls).toHaveLength(1);
      for (let i = 0; i < 5; i++) emit({ type: 'entity.activity_touched', id: `form-${i}`, kind: 'form', activityAt: 'x' });
      await act(async () => { await vi.advanceTimersByTimeAsync(301); });
      expect(calls).toHaveLength(2);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The tile chip
// ---------------------------------------------------------------------------

const SESSION = fixtureSummaries.find((s) => s.state.kind === 'work_session')!;
function session(id: string, title: string): EntitySummary {
  return {
    ...SESSION,
    id: id as EntitySummary['id'],
    title,
    parentId: null,
    deletedAt: null,
    category: 'in_progress' as StatusCategory,
    state: { ...SESSION.state, status: 'running' } as EntitySummary['state'],
  };
}
const rowsFor = (rows: readonly EntitySummary[]) => (filter: QueryFilter) =>
  rows.filter((r) => !filter.category || filter.category.includes(r.category as StatusCategory));
const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };
const tileOf = (container: HTMLElement, id: string) => container.querySelector<HTMLElement>(`[data-session-node="${id}"]`)!;

describe('the session tile chip', () => {
  it('counts the forms waiting on each session, from one read for the whole list', async () => {
    const rows = [session('ws-one', 'One form'), session('ws-three', 'Three forms'), session('ws-none', 'Nothing'), session('ws-queued', 'Queued')];
    const { source, calls } = fakeSource((id) => ({
      'ws-one': pending('ws-one', [item('f-1', 'Pick a strategy')]),
      'ws-three': pending('ws-three', [item('f-2', 'A'), item('f-3', 'B')], 0, 3),
      'ws-queued': pending('ws-queued', [], 1),
    } as Record<string, FormPendingSession>)[id] ?? null);
    const store = createPendingFormsStore(source, { debounceMs: 0 });
    const view = render(
      <PendingFormsProvider store={store}>
        <EntityListPanel kind="work_session" rowsFor={rowsFor(rows)} ctx={ctx} />
      </PendingFormsProvider>,
    );
    await waitFor(() => expect(within(tileOf(view.container, 'ws-one')).queryByTestId('pending-forms-chip')).not.toBeNull());

    expect(within(tileOf(view.container, 'ws-one')).getByTestId('pending-forms-chip').textContent).toBe('1 form waiting');
    // `total`, not the listed page, is the count.
    expect(within(tileOf(view.container, 'ws-three')).getByTestId('pending-forms-chip').textContent).toBe('3 forms waiting');
    expect(within(tileOf(view.container, 'ws-none')).queryByTestId('pending-forms-chip')).toBeNull();
    expect(within(tileOf(view.container, 'ws-queued')).queryByTestId('pending-forms-chip')).toBeNull();
    expect(within(tileOf(view.container, 'ws-queued')).getByTestId('queued-answers-chip').textContent).toBe('1 answer queued');

    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual(['ws-none', 'ws-one', 'ws-queued', 'ws-three']);
    store.dispose();
  });

  it('with no provider, a tile draws no chip', () => {
    const view = render(<EntityListPanel kind="work_session" rowsFor={rowsFor([session('ws-one', 'One')])} ctx={ctx} />);
    expect(view.queryByTestId('pending-forms-chip')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The session panel banner
// ---------------------------------------------------------------------------

describe('the session panel banner', () => {
  it('opens Fill inline, and disappears once the viewer submits', async () => {
    const port = createFixtureFormsPort({ responses: FORM_FIXTURE_RESPONSES });
    const formId = FORM_FIXTURE_IDS.migration;
    // The fake server derives waiting-ness from the port's rows, as the SQL does:
    // mode 'single' waits until anyone has a current submitted response.
    const { source } = fakeSource((id) => {
      const answered = port.rows.some((r) => r.formId === formId && r.isCurrent);
      return id === 'ws-1' && !answered
        ? pending('ws-1', [item(formId, 'Pick the migration strategy', { draft: { id: 'resp-ada-draft', version: 1 } })])
        : null;
    });
    const store = createPendingFormsStore(source, { debounceMs: 0 });
    render(
      <FormsPortProvider port={port}>
        <PendingFormsProvider store={store}>
          <PendingFormsBanner sessionId="ws-1" />
        </PendingFormsProvider>
      </FormsPortProvider>,
    );

    const banner = await screen.findByTestId('pending-forms-banner');
    expect(within(banner).getByText('1 form waiting')).toBeTruthy();
    expect(within(banner).getByText(/draft saved/)).toBeTruthy();
    expect(screen.queryByTestId('pending-form-fill')).toBeNull();

    fireEvent.click(within(banner).getByRole('button', { name: 'Continue' }));
    const fill = await screen.findByTestId('pending-form-fill');
    await within(fill).findByTestId('fill-form');
    // The autosaved draft is the one Fill resumes.
    expect((within(fill).getByLabelText('Dual write') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(within(fill).getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(screen.queryByTestId('pending-forms-banner')).toBeNull());
    expect(port.rows.some((r) => r.formId === formId && r.status === 'submitted' && r.isCurrent)).toBe(true);
    store.dispose();
  });

  it('says when answers are queued, with Resume now only where the host wires it', async () => {
    const { source } = fakeSource((id) => (id === 'ws-q' ? pending('ws-q', [], 2) : null));
    const store = createPendingFormsStore(source, { debounceMs: 0 });
    const onResume = vi.fn();
    const view = render(
      <PendingFormsProvider store={store}>
        <PendingFormsBanner sessionId="ws-q" onResume={onResume} />
      </PendingFormsProvider>,
    );
    const queued = await screen.findByTestId('pending-forms-queued');
    expect(queued.textContent).toContain('2 answers queued');
    fireEvent.click(within(queued).getByRole('button', { name: 'Resume now' }));
    expect(onResume).toHaveBeenCalledTimes(1);

    view.rerender(
      <PendingFormsProvider store={store}>
        <PendingFormsBanner sessionId="ws-q" />
      </PendingFormsProvider>,
    );
    expect(within(screen.getByTestId('pending-forms-queued')).queryByRole('button')).toBeNull();
    expect(screen.getByTestId('pending-forms-queued').textContent).toContain('delivered when the session resumes');
    store.dispose();
  });

  it('renders nothing for a session with nothing waiting', async () => {
    const { source, calls } = fakeSource(() => null);
    const store = createPendingFormsStore(source, { debounceMs: 0 });
    render(
      <PendingFormsProvider store={store}>
        <PendingFormsBanner sessionId="ws-quiet" />
      </PendingFormsProvider>,
    );
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(screen.queryByTestId('pending-forms-banner')).toBeNull();
    store.dispose();
  });
});
