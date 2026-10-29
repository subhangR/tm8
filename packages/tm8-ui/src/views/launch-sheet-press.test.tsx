// @vitest-environment jsdom
/**
 * THE SHEET'S PRESS HOLDS JEV (lane E). An answer landing while the launch is
 * on its way is held; the host unmounts the sheet when the launch goes
 * through, so a sheet still standing when `launching` falls back means it
 * did not — and the held answer is shown after all, never asked for twice.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, EntitySuggestion } from '@tm8/contract';

import { LaunchSheet, type LaunchSelection } from './LaunchSheet';
import { LAUNCH_CAPACITY, LAUNCH_DEFAULTS, LAUNCH_MEMORIES, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';
import { answer, item, pendingPort } from '../jev/test-support';

const MEMORIES: EntitySuggestion = {
  items: [item('mem-new', 'memory', 2.9, true, ['space'], 'A memory Jev picked')],
  considered: 1, total: 1, budget: 1024, floor: 1.5,
};
const OK = { status: 'ok' as const, value: MEMORIES, cost: { calls: 1, inputTokens: 1, outputTokens: 0, usd: 0, latencyMs: 1 } };

describe('the sheet’s press', () => {
  it('holds an answer landing during the launch, and shows it when the launch did not go through', async () => {
    const port = pendingPort();
    const onLaunch = vi.fn<(config: LaunchSelection) => void>();
    const sheet = (launching: boolean) => (
      <div className="cv2-root">
        <LaunchSheet
          subjectId={'task-1' as EntityId} spaceId="sp-1" fromChip="◔ Run ▸" fromCaption="task pre-associated"
          teammates={LAUNCH_TEAMMATES} projects={LAUNCH_PROJECTS} profiles={LAUNCH_PROFILES} capacity={LAUNCH_CAPACITY}
          memories={LAUNCH_MEMORIES} jev={port} loadLaunchDefaults={async () => LAUNCH_DEFAULTS}
          onLaunch={onLaunch} onDispatch={() => {}} onCancel={() => {}} launching={launching}
        />
      </div>
    );
    const view = render(sheet(false));
    await waitFor(() => expect(view.getByTestId('lsel-toggle-memories').textContent).toMatch(/1 default/));
    await act(async () => { fireEvent.click(view.getByTestId('jev-entry-button')); });
    expect(port.calls).toHaveLength(1);

    fireEvent.click(view.getByRole('button', { name: /Launch ▸/ }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
    view.rerender(sheet(true));

    await act(async () => { port.calls[0]!.resolve(answer(port.calls[0]!.input, { memories: OK })); });
    expect(view.queryByText('A memory Jev picked')).toBeNull();

    // The host clears `launching` and the sheet is still up: the launch was refused.
    view.rerender(sheet(false));
    await waitFor(() => expect(view.getAllByText('A memory Jev picked').length).toBeGreaterThan(0));
    expect(port.calls).toHaveLength(1);
  });
});
