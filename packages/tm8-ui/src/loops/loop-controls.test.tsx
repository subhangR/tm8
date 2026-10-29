// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { EntityDetail } from '@tm8/contract';
import { getKind } from '../domain';
import { fixtureDetails, loopDreamer, loopFailing, taskGuideLines } from '../fixtures';
import { GenericBody } from '../panels/bodies/GenericBody';
import { LoopControls } from './LoopControls';
import { createFixtureLoopsClient, fixtureLoopView } from './fixture';

afterEach(cleanup);

function loopDetail(over: Record<string, unknown> = {}): EntityDetail {
  const content = {
    kind: 'loop',
    schedule: 'every 1d',
    enabled: true,
    teamMemberId: null,
    subjectId: null,
    prompt: '',
    config: {},
    nextRunAt: '2026-08-10T00:00:00.000Z',
    lastRunAt: null,
    lastError: null,
    ...over,
  };
  return {
    id: '019fe999-0000-7000-8000-000000000002',
    kind: 'loop',
    title: 'Daily sweep',
    version: 7,
    content,
    state: {
      kind: 'loop',
      schedule: content.schedule,
      enabled: content.enabled,
      teamMemberId: content.teamMemberId,
      subjectId: content.subjectId,
      nextRunAt: content.nextRunAt,
      lastRunAt: content.lastRunAt,
      lastError: content.lastError,
    },
    capabilities: {
      canEdit: true, canDelete: true, canAddChild: false, canLink: true,
      canPull: false, canReact: true, canGrantPoints: false, canComplete: false,
    },
    connections: { outgoing: [], incoming: [] },
  } as unknown as EntityDetail;
}

function mount(detail = loopDetail(), wired = true) {
  const loops = createFixtureLoopsClient([fixtureLoopView(detail.id, 'space' as never, {}, { version: detail.version })]);
  const enable = vi.spyOn(loops, 'enable');
  const disable = vi.spyOn(loops, 'disable');
  const runNow = vi.spyOn(loops, 'runNow');
  const onSaved = vi.fn();
  render(
    <div className="cv2-root">
      <LoopControls
        detail={detail}
        loops={wired ? loops : null}
        onSaved={onSaved}
      />
    </div>,
  );
  return { enable, disable, runNow, onSaved };
}

describe('loop lifecycle controls go through the loops.* doors', () => {
  it('mounts from the generic body block declared by the registry', () => {
    const detail = loopDetail();
    const config = getKind('loop');
    render(
      <div className="cv2-root">
        <GenericBody detail={detail} blocks={config.panel.blocks ?? []} commands={null} />
      </div>,
    );
    expect(screen.getByTestId('block-loop-controls')).toBeTruthy();
    expect(screen.getByTestId('loop-controls')).toBeTruthy();
  });

  it('disables through loops.disable under the version guard', async () => {
    const { disable, onSaved } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    expect(disable.mock.calls[0]![0]).toEqual({ id: '019fe999-0000-7000-8000-000000000002', version: 7 });
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('fires Run now through loops.runNow', async () => {
    const { runNow } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(runNow).toHaveBeenCalledWith('019fe999-0000-7000-8000-000000000002'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Fired now'));
  });

  it('enables through loops.enable and computes no deadline in the browser', async () => {
    const { enable } = mount(loopDetail({ enabled: false, nextRunAt: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    expect(enable.mock.calls[0]).toHaveLength(1);
  });

  it('does not advertise Run now while disabled or when the client is unwired', () => {
    const { runNow } = mount(loopDetail({ enabled: false }));
    expect(screen.getByRole('button', { name: 'Run now' }).getAttribute('aria-disabled')).toBe('true');
    expect(runNow).not.toHaveBeenCalled();
    cleanup();
    mount(loopDetail(), false);
    expect(screen.getAllByTestId('disabled-with-reason')).toHaveLength(2);
    expect(screen.getAllByText(/no loops client/)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

/**
 * THE SHIPPED LOOP PANEL — these four facts were written against the profile
 * archetype by the memories/loops lane and moved here with the panel itself.
 *
 * The loop's body follows its VERBS: `loop-controls` mutates, and only
 * `GenericBody` is handed a command executor. So the read blocks came with it,
 * and the two facts the profile field-grid carried — a null runner MEANING
 * "routed through the Dispatcher" rather than missing, and `lastError` beside
 * `enabled` — are now stated by the controls summary itself.
 *
 * A loop's RUN HISTORY *is* its inbound `triggered_by` edges (086 §4.4: there
 * is no separate run table), which is why the panel ends in `peer-rows` and
 * why an empty one has to name the mechanism rather than read as missing data.
 */
const LOOP_BLOCKS = getKind('loop').panel.blocks ?? [];

function mountPanel(id: string) {
  return render(
    <div className="cv2-root">
      <GenericBody detail={fixtureDetails[id]!} blocks={LOOP_BLOCKS} commands={null} />
    </div>,
  );
}

describe('the loop detail draws schedule, instruction and run history from one registry row', () => {
  it('draws the instruction, the schedule, and the runs', () => {
    const { getByTestId } = mountPanel(loopDreamer.id);
    const fields = getByTestId('block-fields').textContent ?? '';
    expect(fields).toContain('remembers set');
    expect(fields).toContain('every 1d');
    expect(getByTestId('loop-controls').textContent).toContain('every 1d');
    // Run history IS the edge neighbourhood — the count is of the same list.
    const runs = getByTestId('block-peer-rows');
    expect(runs.textContent).toContain('RUNS · 1');
    expect(runs.textContent).toContain(taskGuideLines.title);
  });

  it('says an empty run list means it has not fired, not that runs are missing', () => {
    const { getByTestId } = mountPanel(loopFailing.id);
    // A designed absence naming the mechanism, never a blank region.
    expect(getByTestId('block-peer-rows').textContent).toContain('has not fired');
  });

  it('shows lastError beside enabled — "enabled" alone is not a health claim', () => {
    const { getByTestId } = mountPanel(loopFailing.id);
    const controls = getByTestId('loop-controls').textContent ?? '';
    expect(controls).toContain('Enabled');
    expect(controls).toContain('no session slots free');
  });

  it('renders a dispatcher-routed loop without inventing a runner', () => {
    const { getByTestId } = mountPanel(loopDreamer.id);
    const controls = getByTestId('loop-controls').textContent ?? '';
    expect(controls).toContain('Runs as');
    expect(controls).toContain('—');
    expect(controls).toContain('routed through the Dispatcher');
  });
});
