// @vitest-environment jsdom
/**
 * The bridge Loops tab (v2 §2.2, Bridges L): the loops whose targets include
 * this bridge, and the new-loop form's schedule line (#1470 review: an empty
 * schedule or a failed preview says so instead of "Checking…" for good).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityId, SpaceId } from '@tm8/contract';
import { bridgeInfra } from '../fixtures/entities';
import { createFixtureLoopsClient, fixtureLoopView } from '../loops/fixture';
import { fixtureBridgeViewOf } from './fixture';
import { LoopsTab } from './tabs/LoopsTab';

afterEach(() => cleanup());

const view = fixtureBridgeViewOf(bridgeInfra)!;
const seeded = () => createFixtureLoopsClient([
  fixtureLoopView('019f0000-0000-7000-8000-0000000000d1' as EntityId, view.spaceId as SpaceId, {
    title: 'Stand-up nudge', schedule: 'every weekday at 09:30', action: 'post',
    targets: [{ bridgeId: view.id, text: 'Morning!' }],
  }),
  fixtureLoopView('019f0000-0000-7000-8000-0000000000d2' as EntityId, view.spaceId as SpaceId, { title: 'Elsewhere' }),
]);

describe('the bridge Loops tab', () => {
  it('lists only the loops that post here, with what each says here', async () => {
    render(<LoopsTab view={view} loops={seeded()} />);
    expect(await screen.findByText('Stand-up nudge')).toBeTruthy();
    expect(screen.getByText('Morning!')).toBeTruthy();
    expect(screen.queryByText('Elsewhere')).toBeNull();
  });

  it('says to type a schedule when it is empty, and says why when the preview fails', async () => {
    const loops = seeded();
    render(<LoopsTab view={view} loops={loops} />);
    fireEvent.click(await screen.findByRole('button', { name: '+ New loop here' }));
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: '' } });
    expect(screen.getByTestId('bridge-new-loop-preview').textContent).toContain('Type a schedule');

    vi.spyOn(loops, 'schedulePreview').mockRejectedValue(new Error('the node is unreachable'));
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'every day at 10:00' } });
    await waitFor(() => expect(screen.getByTestId('bridge-new-loop-preview').textContent)
      .toContain('The schedule could not be checked: the node is unreachable'), { timeout: 3000 });
    expect((screen.getByRole('button', { name: 'Create loop' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
