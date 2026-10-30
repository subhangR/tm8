// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CollabError, type SpaceId } from '@tm8/contract';
import type { LoopRun } from './api';
import { createFixtureLoopsClient, fixtureLoopView } from './fixture';
import { LoopsList } from './LoopsList';

afterEach(cleanup);

const SPACE = '019fe999-0000-7000-8000-00000000c000' as SpaceId;
const ADA = '019fe999-0000-7000-8000-00000000c001';
const TOOL = '019fe999-0000-7000-8000-00000000c002';
const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const failedRun = { id: 'run-1', status: 'failed', firedAt: inHours(-2) } as unknown as LoopRun;

function seed() {
  return [
    fixtureLoopView('019fe999-0000-7000-8000-00000000d001', SPACE, { title: 'Ada sweep', action: 'spawn', teamMemberId: ADA }, {
      schedule: { valid: true, problem: null, summary: 'Every day at 09:00 Europe/London', next: [] },
      state: { ...fixtureLoopView('x', SPACE).state, nextRunAt: inHours(3) },
      runs: { ...fixtureLoopView('x', SPACE).runs, last: failedRun, total: 4 },
    }),
    fixtureLoopView('019fe999-0000-7000-8000-00000000d002', SPACE, { title: 'Triage', action: 'dispatch' }, {
      state: { ...fixtureLoopView('x', SPACE).state, enabled: false },
    }),
    fixtureLoopView('019fe999-0000-7000-8000-00000000d003', SPACE, { title: 'Backup', action: 'tool', toolId: TOOL }, {
      capabilities: { canEdit: false, canControl: false, canRun: false, canDelete: false },
    }),
  ];
}

const sources = {
  query: (async () => ({ page: { items: [], nextCursor: null } })) as never,
  entity: (async (id: string) => ({ id, title: id === ADA ? 'Ada' : 'nightly-backup', state: { kind: id === ADA ? 'team_member' : 'tool' } })) as never,
};

function mount(client = createFixtureLoopsClient(seed())) {
  const onOpen = vi.fn();
  render(<div className="cv2-root"><LoopsList spaceId={SPACE} client={client} sources={sources} onOpen={onOpen} /></div>);
  return { client, onOpen };
}

describe('the loops list', () => {
  it('draws the six columns from the server view', async () => {
    mount();
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map(h => h.textContent)).toEqual(['Title', 'Runs', 'Schedule', 'Next run', 'Last run', 'Enabled']);
    const ada = screen.getByTestId('loop-row-019fe999-0000-7000-8000-00000000d001');
    await waitFor(() => expect(ada.textContent).toContain('Ada'));
    expect(ada.textContent).toContain('Every day at 09:00 Europe/London');
    expect(ada.textContent).toMatch(/in 3h/);
    expect(ada.querySelector('time')?.getAttribute('title')).toBeTruthy();
    expect(ada.textContent).toContain('Failed');
    expect(ada.textContent).toMatch(/2h ago/);
    const triage = screen.getByTestId('loop-row-019fe999-0000-7000-8000-00000000d002');
    expect(triage.textContent).toContain('Dispatcher');
    expect(triage.textContent).toContain('Disabled');
    expect(triage.textContent).toContain('Never');
    await waitFor(() => expect(screen.getByTestId('loop-row-019fe999-0000-7000-8000-00000000d003').textContent).toContain('nightly-backup'));
  });

  it('the Enabled switch calls loops.disable / loops.enable under the row version', async () => {
    const { client } = mount();
    const disable = vi.spyOn(client, 'disable');
    const enable = vi.spyOn(client, 'enable');
    fireEvent.click(await screen.findByRole('switch', { name: 'Disable Ada sweep' }));
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    expect(disable.mock.calls[0]![0]).toMatchObject({ id: '019fe999-0000-7000-8000-00000000d001', version: 1 });
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Ada sweep' }).getAttribute('aria-checked')).toBe('false'));
    fireEvent.click(screen.getByRole('switch', { name: 'Enable Triage' }));
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
  });

  it('a refused toggle says why and a viewer without control cannot toggle', async () => {
    const { client } = mount();
    vi.spyOn(client, 'disable').mockRejectedValue(new CollabError('version_conflict', 'changed'));
    fireEvent.click(await screen.findByRole('switch', { name: 'Disable Ada sweep' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    const locked = screen.getByRole('switch', { name: 'Disable Backup' });
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    const disable = vi.spyOn(client, 'disable');
    disable.mockClear();
    fireEvent.click(locked);
    expect(disable).not.toHaveBeenCalled();
  });

  it('opens a loop from its title and offers New loop in the header', async () => {
    const { onOpen } = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Triage' }));
    expect(onOpen).toHaveBeenCalledWith('019fe999-0000-7000-8000-00000000d002');
    fireEvent.click(screen.getByTestId('loop-new'));
    expect(screen.getByRole('dialog', { name: 'New loop' })).toBeTruthy();
  });

  it('asks the server once the filter pauses, not on every keystroke', async () => {
    const { client } = mount();
    const list = vi.spyOn(client, 'list');
    await screen.findByRole('table');
    list.mockClear();
    for (const text of ['n', 'ni', 'nig', 'night']) fireEvent.change(screen.getByLabelText('Filter loops'), { target: { value: text } });
    expect(list).not.toHaveBeenCalled();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(list.mock.calls[0]![1]).toMatchObject({ words: 'night' });
  });

  it('a second click while the switch is busy sends nothing', async () => {
    const { client } = mount();
    let finish: () => void = () => undefined;
    const disable = vi.spyOn(client, 'disable').mockImplementation(loop => new Promise(resolve => {
      finish = () => resolve({ ...(loop as never), state: { ...fixtureLoopView('x', SPACE).state, enabled: false } } as never);
    }));
    const toggle = await screen.findByRole('switch', { name: 'Disable Ada sweep' });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-busy')).toBe('true'));
    fireEvent.click(toggle);
    expect(disable).toHaveBeenCalledTimes(1);
    finish();
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Ada sweep' }).getAttribute('aria-busy')).toBeNull());
  });

  it('says an empty space has no loops yet', async () => {
    mount(createFixtureLoopsClient());
    expect((await screen.findByTestId('loops-empty')).textContent).toContain('No loops yet');
  });
});

/* --- PR5a review fixes --------------------------------------------------- */

const ADA_ID = '019fe999-0000-7000-8000-00000000d001';

describe('a row\'s version goes stale each time its loop fires', () => {
  it('the switch re-reads a loop it was refused for and flips the fresh one', async () => {
    const { client } = mount();
    // The loop fired: same definition and state, a newer version.
    client.loops.set(ADA_ID, { ...client.loops.get(ADA_ID)!, version: 5 });
    const disable = vi.spyOn(client, 'disable');
    fireEvent.click(await screen.findByRole('switch', { name: 'Disable Ada sweep' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Ada sweep' })).toBeTruthy());
    expect(disable.mock.calls.map(([loop]) => loop.version)).toEqual([1, 5]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a loop someone else already flipped is shown as it is, and nothing is sent again', async () => {
    const { client } = mount();
    const ada = client.loops.get(ADA_ID)!;
    client.loops.set(ADA_ID, { ...ada, version: 2, state: { ...ada.state, enabled: false } });
    const disable = vi.spyOn(client, 'disable');
    fireEvent.click(await screen.findByRole('switch', { name: 'Disable Ada sweep' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Already disabled by someone else.');
    expect(disable).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('switch', { name: 'Enable Ada sweep' })).toBeTruthy();
  });

  it('a read that started before a toggle cannot land the older row over it', async () => {
    const { client } = mount();
    await screen.findByRole('table');
    const stale = await client.list(SPACE, { limit: 100 });
    let answer: (page: typeof stale) => void = () => undefined;
    const list = vi.spyOn(client, 'list').mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
    // A refresh starts (the tab comes back), then the toggle lands first.
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(list).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('switch', { name: 'Disable Ada sweep' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Enable Ada sweep' })).toBeTruthy());
    answer(stale);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByRole('switch', { name: 'Enable Ada sweep' })).toBeTruthy();
  });
});

describe('the list stays honest when a read fails or a fact is missing', () => {
  it('a failed refresh keeps the rows on screen and says they may be stale', async () => {
    const { client } = mount();
    await screen.findByRole('table');
    vi.spyOn(client, 'list').mockRejectedValue(new Error('node unreachable'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect((await screen.findByTestId('loops-refresh-error')).textContent).toContain('node unreachable');
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('Last run falls back to the loop\'s lastRunAt while the run projection is empty', async () => {
    const view = fixtureLoopView('019fe999-0000-7000-8000-00000000d010', SPACE, { title: 'Quiet', action: 'dispatch' }, {
      state: { ...fixtureLoopView('x', SPACE).state, lastRunAt: inHours(-5) },
    });
    mount(createFixtureLoopsClient([view]));
    const row = await screen.findByTestId('loop-row-019fe999-0000-7000-8000-00000000d010');
    expect(row.textContent).toMatch(/5h ago/);
    expect(row.textContent).not.toContain('Never');
  });

  it('a paused loop reads "Paused · resumes in …"; an expired pause reads as scheduled', async () => {
    const paused = fixtureLoopView('019fe999-0000-7000-8000-00000000d011', SPACE, { title: 'Held', action: 'dispatch' }, {
      state: { ...fixtureLoopView('x', SPACE).state, pausedUntil: inHours(3), nextRunAt: inHours(1) },
    });
    const expired = fixtureLoopView('019fe999-0000-7000-8000-00000000d012', SPACE, { title: 'Back', action: 'dispatch' }, {
      state: { ...fixtureLoopView('x', SPACE).state, pausedUntil: inHours(-1), nextRunAt: inHours(2) },
    });
    mount(createFixtureLoopsClient([paused, expired]));
    expect((await screen.findByTestId('loop-row-019fe999-0000-7000-8000-00000000d011')).textContent).toMatch(/Paused · resumes in 3h/);
    expect(screen.getByTestId('loop-row-019fe999-0000-7000-8000-00000000d012').textContent).toMatch(/in 2h/);
  });

  it('Show more reads one page at a time, however often it is clicked', async () => {
    // A hidden tab: the minute refresh reads nothing, so a machine slow enough to cross 60 s cannot race
    // the page read (the first read and Show more do not wait on visibility).
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      const many = Array.from({ length: 101 }, (_, index) =>
        fixtureLoopView(`019fe999-0000-7000-8000-${String(index).padStart(12, '0')}`, SPACE, { title: `Loop ${index}`, action: 'dispatch' }));
      const client = createFixtureLoopsClient(many);
      mount(client);
      const more = await screen.findByRole('button', { name: 'Show more' });
      const list = vi.spyOn(client, 'list');
      fireEvent.click(more);
      fireEvent.click(more);
      await waitFor(() => expect(screen.queryByRole('button', { name: /Show more|Loading/ })).toBeNull());
      expect(list).toHaveBeenCalledTimes(1);
      expect(list.mock.calls[0]?.[1]?.cursor).toBeDefined();
      expect(screen.getAllByRole('switch')).toHaveLength(101);
    } finally {
      visibility.mockRestore();
    }
  });

  it('does not poll while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      const { client } = mount();
      await screen.findByRole('table');
      const list = vi.spyOn(client, 'list');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(list).not.toHaveBeenCalled();
      visibility.mockReturnValue('visible');
      await vi.advanceTimersByTimeAsync(61_000);
      expect(list).toHaveBeenCalled();
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('draws the loop open in the detail pane as the selected row', async () => {
    const onOpen = vi.fn();
    render(<div className="cv2-root"><LoopsList spaceId={SPACE} client={createFixtureLoopsClient(seed())} sources={sources} onOpen={onOpen} selectedId={ADA_ID} /></div>);
    const row = await screen.findByTestId(`loop-row-${ADA_ID}`);
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('loop-row-019fe999-0000-7000-8000-00000000d002').getAttribute('aria-selected')).toBe('false');
  });
});
