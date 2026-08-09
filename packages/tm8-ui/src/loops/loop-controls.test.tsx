// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandResult, EntityDetail, PatchEntityInput } from '@tm8/contract';
import { getKind } from '../domain';
import { fixtureDetails, loopDreamer, loopFailing, taskGuideLines } from '../fixtures';
import { GenericBody } from '../panels/bodies/GenericBody';
import { LoopControls } from './LoopControls';

afterEach(cleanup);

const OK = { patches: [] } as unknown as CommandResult;

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
  const patchEntity = vi.fn(async () => OK);
  const onSaved = vi.fn();
  render(
    <div className="cv2-root">
      <LoopControls
        detail={detail}
        commands={wired ? { patchEntity } : null}
        onSaved={onSaved}
      />
    </div>,
  );
  return { patchEntity, onSaved };
}

describe('loop lifecycle controls stay on entities.patch', () => {
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

  it('disables without erasing the stored deadline', async () => {
    const { patchEntity, onSaved } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [id, input] = patchEntity.mock.calls[0] as unknown as [string, PatchEntityInput];
    expect(id).toContain('019fe999');
    expect(input.expectedVersion).toBe(7);
    expect(input.content).toEqual({ enabled: false });
    expect(onSaved).toHaveBeenCalledWith(OK);
  });

  it('queues Run now by making nextRunAt due, without claiming synchronous execution', async () => {
    const before = Date.now();
    const { patchEntity } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [, input] = patchEntity.mock.calls[0] as unknown as [string, PatchEntityInput];
    const due = Date.parse(String(input.content?.nextRunAt));
    expect(due).toBeGreaterThanOrEqual(before);
    expect(due).toBeLessThanOrEqual(Date.now());
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('next scheduler tick'));
  });

  it('enabling an unscheduled loop restores a deadline from its schedule', async () => {
    const before = Date.now();
    const { patchEntity } = mount(loopDetail({ enabled: false, nextRunAt: null }));
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(patchEntity).toHaveBeenCalledTimes(1));
    const [, input] = patchEntity.mock.calls[0] as unknown as [string, PatchEntityInput];
    expect(input.content?.enabled).toBe(true);
    const next = Date.parse(String(input.content?.nextRunAt));
    expect(next).toBeGreaterThanOrEqual(before + 24 * 60 * 60_000);
  });

  it('does not advertise Run now while disabled or when the command is unwired', () => {
    const { patchEntity } = mount(loopDetail({ enabled: false }));
    expect(screen.getByRole('button', { name: 'Run now' }).getAttribute('aria-disabled')).toBe('true');
    expect(patchEntity).not.toHaveBeenCalled();
    cleanup();
    mount(loopDetail(), false);
    expect(screen.getAllByTestId('disabled-with-reason')).toHaveLength(2);
    expect(screen.getAllByText(/no patch executor/)).toHaveLength(2);
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
