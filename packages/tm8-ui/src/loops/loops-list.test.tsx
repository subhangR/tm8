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
