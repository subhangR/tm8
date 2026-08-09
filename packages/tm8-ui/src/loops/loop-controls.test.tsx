// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CommandResult, EntityDetail, PatchEntityInput } from '@tm8/contract';
import { getKind } from '../domain';
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
