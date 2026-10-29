// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { CollabError, type ActorSummary, type CommandResult, type EntityDetail } from '@tm8/contract';
import { getKind } from '../domain';
import { GenericBody } from '../panels/bodies/GenericBody';
import { LoopHeader } from './LoopHeader';
import { LoopRuns } from './LoopRuns';
import { PauseDialog, resolvePause, tomorrowAtNine } from './PauseDialog';
import type { LoopFormSources } from './sources';
import type { LoopPagePort, LoopRun, LoopView } from './page-port';
import { durationLabel, loopStatus, zonedInstant } from './page-format';
import { resetLoopPageStore, useLoopView } from './useLoopView';
import { RUNNING_POLL_MS } from './LoopRuns';

const LOOP_ID = '019fe999-0000-7000-8000-000000000002';
const SESSION_ID = '019fe999-0000-7000-8000-0000000000aa';
const TASK_ID = '019fe999-0000-7000-8000-0000000000bb';
const RUNNER_ID = '019fe999-0000-7000-8000-0000000000cc';
const NOW = Date.parse('2026-10-28T12:00:00.000Z');

const ada: ActorSummary = { id: '019fe999-0000-7000-8000-0000000000dd', kind: 'member', displayName: 'Ada' } as ActorSummary;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetLoopPageStore();
});

function view(over: { state?: Partial<LoopView['state']>; capabilities?: Partial<LoopView['capabilities']>; definition?: Partial<LoopView['definition']> } = {}): LoopView {
  return {
    id: LOOP_ID, spaceId: 'space-1', version: 7,
    definition: {
      title: 'Daily sweep', schedule: '0 9 * * *', timezone: 'UTC', action: 'spawn',
      teamMemberId: RUNNER_ID, subjectId: null, toolId: null, toolInputs: {},
      prompt: 'Sweep the board', config: { model: 'opus' }, concurrency: 'skip',
      maxRuntimeSeconds: 3600, retry: { attempts: 2, delaySeconds: 300 },
      ...over.definition,
    },
    schedule: {
      valid: true, problem: null, summary: 'Every day at 09:00 UTC',
      next: ['2026-10-29T09:00:00.000Z', '2026-10-30T09:00:00.000Z'],
    },
    state: {
      enabled: true, pausedUntil: null, nextRunAt: '2026-10-28T15:00:00.000Z',
      lastRunAt: '2026-10-27T09:00:00.000Z', lastError: null,
      armedBy: ada, armedAt: '2026-10-27T08:00:00.000Z',
      actingAs: { identity: ada, via: 'armer' }, waitingOnRunId: null,
      ...over.state,
    },
    runs: { total: 0, last: null, last24h: { fired: 0, failed: 0, skipped: 0 }, usage: { inputTokens: null, outputTokens: null, costUsd: null } },
    createdBy: ada, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-27T08:00:00.000Z',
    capabilities: { canEdit: true, canControl: true, canRun: true, canDelete: true, ...over.capabilities },
  };
}

function run(over: Partial<LoopRun> = {}): LoopRun {
  return {
    id: 'run-1', loopId: LOOP_ID, spaceId: 'space-1',
    firedAt: '2026-10-28T11:00:00.000Z', trigger: 'schedule', requestedBy: null,
    action: 'spawn', attempt: 1, status: 'completed', skipReason: null, error: null,
    taskId: TASK_ID, sessionId: SESSION_ID,
    startedAt: '2026-10-28T11:00:01.000Z', endedAt: '2026-10-28T11:05:00.000Z', durationMs: 299_000,
    exitCode: null, outputTail: null, actedAs: ada, endedKind: null, usage: null,
    ...over,
  };
}

function port(over: Partial<LoopPagePort> = {}): LoopPagePort {
  return {
    get: vi.fn(async () => view()),
    enable: vi.fn(async () => view()),
    disable: vi.fn(async () => view({ state: { enabled: false } })),
    resume: vi.fn(async () => view()),
    pause: vi.fn(async (_loop: unknown, until: string) => view({ state: { pausedUntil: until } })),
    runNow: vi.fn(async () => ({ run: run({ id: 'run-new', trigger: 'manual', status: 'running', endedAt: null, durationMs: null }) })),
    runsList: vi.fn(async () => ({ items: [run()], nextCursor: null })),
    runsStop: vi.fn(async (runId: string) => ({ run: run({ id: runId, status: 'stopped' }) })),
    create: vi.fn(), update: vi.fn(), list: vi.fn(), runsGet: vi.fn(), schedulePreview: vi.fn(),
    ...over,
  } as LoopPagePort;
}

/** PR5a's bound seam reads; the page only needs `entity` for chip titles. */
function sources() {
  return {
    query: vi.fn(),
    entity: vi.fn(async (id: string) => ({
      id, title: id === RUNNER_ID ? 'Dreamer' : 'Some entity', state: { kind: 'team_member' },
    }) as unknown as EntityDetail),
  } as unknown as LoopFormSources;
}

function header(v: LoopView, p: LoopPagePort = port(), extra: Partial<Parameters<typeof LoopHeader>[0]> = {}) {
  const props = {
    view: v, port: p, onView: vi.fn(), onReload: vi.fn(), onRunsChanged: vi.fn(), onOpenEntity: vi.fn(),
    deleteEntity: vi.fn(async () => ({ patches: [] }) as unknown as CommandResult),
    renderEditor: ({ onClose }: { onClose(): void }) => <div role="dialog" aria-label="Edit loop"><button type="button" onClick={onClose}>close</button></div>,
    ...extra,
  };
  render(<div className="cv2-root"><LoopHeader {...props} /></div>);
  return props;
}

describe('loop page header: status pill and facts', () => {
  it('Enabled, with next run relative + absolute in the loop timezone', () => {
    header(view());
    expect(screen.getByText('Enabled')).toBeTruthy();
    expect(screen.getByTestId('loop-next-run').textContent).toMatch(/^Next run in 3h \(Wed.*15:00 UTC\)$/);
  });

  it('Paused until …', () => {
    header(view({ state: { pausedUntil: '2026-10-29T09:00:00.000Z' } }));
    expect(screen.getByText(/^Paused until Thu.*09:00 UTC$/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change pause…' })).toBeTruthy();
  });

  it('a lapsed pause reads as Enabled', () => {
    expect(loopStatus(view({ state: { pausedUntil: '2026-10-28T11:00:00.000Z' } }), NOW).kind).toBe('enabled');
  });

  it('Disabled outranks paused and says it is not scheduled', () => {
    header(view({ state: { enabled: false, pausedUntil: '2026-10-29T09:00:00.000Z' } }));
    expect(screen.getByText('Disabled')).toBeTruthy();
    expect(screen.getByTestId('loop-next-run').textContent).toBe('Not scheduled while disabled');
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy();
  });

  it('Waiting on previous run', () => {
    header(view({ state: { waitingOnRunId: 'run-live' } }));
    expect(screen.getByText('Waiting on previous run')).toBeTruthy();
  });

  it('the next run is drawn in the loop zone, not the browser zone', () => {
    expect(zonedInstant('2026-10-28T15:00:00.000Z', 'Asia/Kolkata')).toMatch(/20:30 GMT\+5:30$/);
  });

  it('last error banner, and the loop stays enabled', () => {
    header(view({ state: { lastError: 'spawn refused: session cap reached' } }));
    const banner = screen.getByTestId('loop-last-error');
    expect(banner.textContent).toContain('spawn refused: session cap reached');
    expect(screen.getByText('Enabled')).toBeTruthy();
  });

  it('armed by, and the fallback identity when it differs', () => {
    const bob = { id: 'bob', kind: 'member', displayName: 'Bob' } as ActorSummary;
    header(view({ state: { actingAs: { identity: bob, via: 'fallback' } } }));
    const armer = screen.getByTestId('loop-armer').textContent ?? '';
    expect(armer).toContain('Armed by');
    expect(armer).toContain('Ada');
    expect(armer).toContain('running as');
    expect(armer).toContain('Bob');
    expect(armer).toContain('(fallback)');
    expect(armer).toContain('(no longer a member)');
  });

  it('an armer who is still the acting identity is not flagged', () => {
    header(view());
    expect(screen.getByTestId('loop-armer').textContent).not.toContain('no longer');
  });

  it('runs summary: never fired, then the 24 h tally', () => {
    header(view());
    expect(screen.getByTestId('loop-runs-summary').textContent).toBe('Never fired yet.');
    cleanup();
    const v = view();
    v.runs = { ...v.runs, total: 12, last24h: { fired: 3, failed: 1, skipped: 2 } };
    header(v);
    expect(screen.getByTestId('loop-runs-summary').textContent).toBe('12 runs recorded · last 24 h: 3 fired, 1 failed, 2 skipped');
  });

  it('needs arming when there is no one to run as', () => {
    header(view({ state: { armedBy: null, armedAt: null, actingAs: { identity: null, via: 'none' } } }));
    const armer = screen.getByTestId('loop-armer').textContent ?? '';
    expect(armer).toContain('Not armed by a human');
    expect(armer).toContain('needs arming');
  });
});

describe('loop page controls', () => {
  it('Run now shows the new run with a session link at once', async () => {
    const p = port();
    const props = header(view(), p);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const started = await screen.findByTestId('loop-run-started');
    expect(p.runNow).toHaveBeenCalledWith(LOOP_ID, false, { clientMutationId: expect.any(String) });
    expect(within(started).getByText('Running')).toBeTruthy();
    fireEvent.click(within(started).getByRole('button', { name: 'Open session' }));
    expect(props.onOpenEntity).toHaveBeenCalledWith(SESSION_ID);
    expect(props.onRunsChanged).toHaveBeenCalled();
  });

  it('Run now on 409 loop_run_overlap offers Run anyway, which forces', async () => {
    // The server's real shape (run-handlers.ts): details {reason, runId}; its message is API wording, never shown.
    const runNow = vi.fn()
      .mockRejectedValueOnce(new CollabError('conflict', 'a run of this loop is still live; pass force to run anyway',
        { details: { reason: 'loop_run_overlap', runId: 'run-live' } }))
      .mockResolvedValueOnce({ run: run({ id: 'run-forced', status: 'running' }) });
    header(view(), port({ runNow, runsGet: vi.fn(async () => run({ id: 'run-live', status: 'running', sessionId: 'sess-live' })) }));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const overlap = await screen.findByTestId('loop-overlap');
    expect(overlap.textContent).toContain('Not started: the previous run');
    expect(overlap.textContent).toContain('is still live');
    expect(overlap.textContent).not.toContain('pass force');
    expect(within(overlap).getByRole('button', { name: 'Open the live run' })).toBeTruthy();
    fireEvent.click(within(overlap).getByRole('button', { name: 'Run anyway (starts a second run)' }));
    await screen.findByTestId('loop-run-started');
    expect(runNow).toHaveBeenLastCalledWith(LOOP_ID, true, { clientMutationId: expect.any(String) });
  });

  it('an overlap with a run still LAUNCHING says it is starting, and Show run opens its session once it has one', async () => {
    const runNow = vi.fn().mockRejectedValueOnce(new CollabError('conflict',
      'a run of this loop is still launching (run run-live): re-send with the same clientMutationId to get its result, or read loops.runs.get; force starts a second run',
      { details: { reason: 'loop_run_overlap', runId: 'run-live', launching: true } }));
    const runsGet = vi.fn()
      .mockResolvedValueOnce(run({ id: 'run-live', status: 'running', sessionId: null, firedAt: new Date(Date.now() - 60_000).toISOString() }))
      .mockResolvedValueOnce(run({ id: 'run-live', status: 'running', sessionId: null }))
      .mockResolvedValue(run({ id: 'run-live', status: 'running', sessionId: 'sess-live' }));
    const props = header(view(), port({ runNow, runsGet }));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    const overlap = await screen.findByTestId('loop-overlap');
    await waitFor(() => expect(overlap.textContent).toMatch(/The previous run \(fired .+\) is still starting\./));
    expect(overlap.textContent).not.toContain('clientMutationId');
    expect(within(overlap).getByRole('button', { name: 'Run anyway (starts a second run)' })).toBeTruthy();
    // No session yet: the table re-reads and the page says so.
    fireEvent.click(within(overlap).getByRole('button', { name: 'Show run' }));
    expect(await screen.findByText(/still starting: its row in RUNS shows its session/)).toBeTruthy();
    expect(props.onRunsChanged).toHaveBeenCalled();
    expect(props.onOpenEntity).not.toHaveBeenCalled();
    // Once it has one, Show run opens it.
    runNow.mockRejectedValueOnce(new CollabError('conflict', 'still launching', { details: { reason: 'loop_run_overlap', runId: 'run-live', launching: true } }));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    fireEvent.click(within(await screen.findByTestId('loop-overlap')).getByRole('button', { name: 'Show run' }));
    await waitFor(() => expect(props.onOpenEntity).toHaveBeenCalledWith('sess-live'));
  });

  it('a lastError with no firing yet reads "Not scheduled", not "Last firing failed"', () => {
    header(view({ state: { lastError: 'schedule never matches within a year', lastRunAt: null } }));
    const banner = screen.getByTestId('loop-last-error');
    expect(banner.textContent).toContain('Not scheduled: schedule never matches within a year');
    expect(banner.textContent).not.toContain('Last firing failed');
  });

  it('Run now holds ONE mutation id per intent: a retry after a timeout replays it, a new press after success does not', async () => {
    const runNow = vi.fn()
      .mockRejectedValueOnce(new CollabError('upstream_unavailable', 'the tm8 node did not answer within 180000ms'))
      .mockResolvedValueOnce({ run: run({ id: 'run-new', status: 'running' }) })
      .mockResolvedValueOnce({ run: run({ id: 'run-next', status: 'running' }) });
    const props = header(view(), port({ runNow }));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect((await screen.findByRole('alert')).textContent).toContain('may have started');
    expect(props.onRunsChanged).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await screen.findByTestId('loop-run-started');
    const [first, second] = runNow.mock.calls.map(call => (call[2] as { clientMutationId: string }).clientMutationId);
    expect(second).toBe(first);
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(runNow).toHaveBeenCalledTimes(3));
    expect((runNow.mock.calls[2]![2] as { clientMutationId: string }).clientMutationId).not.toBe(first);
  });

  it('Run now refusal (501 until PR2) is named, not swallowed', async () => {
    header(view(), port({ runNow: vi.fn(async () => { throw new CollabError('not_implemented', 'loops.runNow is not implemented'); }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect((await screen.findByRole('alert')).textContent).toContain('501');
  });

  it('Disable sends the version guard and redraws from the returned view', async () => {
    const p = port();
    const props = header(view(), p);
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(props.onView).toHaveBeenCalled());
    expect(p.disable).toHaveBeenCalledWith(expect.objectContaining({ id: LOOP_ID, version: 7 }));
    expect((props.onView.mock.calls[0]![0] as LoopView).state.enabled).toBe(false);
  });

  it('Enable on a disabled loop', async () => {
    const p = port();
    header(view({ state: { enabled: false } }), p);
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(p.enable).toHaveBeenCalledWith(expect.objectContaining({ id: LOOP_ID, version: 7 })));
  });

  it('a version conflict reloads and says so', async () => {
    const props = header(view(), port({ disable: vi.fn(async () => { throw new CollabError('version_conflict', 'stale'); }) }));
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed while you were looking');
    expect(props.onReload).toHaveBeenCalled();
  });

  it('Resume calls loops.resume', async () => {
    const p = port();
    header(view({ state: { pausedUntil: '2026-10-29T09:00:00.000Z' } }), p);
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(p.resume).toHaveBeenCalledWith(expect.objectContaining({ id: LOOP_ID, version: 7 })));
  });

  it('Edit opens the form; Delete confirms, then calls entities.delete', async () => {
    const props = header(view());
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('dialog', { name: 'Edit loop' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(props.deleteEntity).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete loop' }));
    await waitFor(() => expect(props.deleteEntity).toHaveBeenCalledWith(LOOP_ID, expect.objectContaining({ clientMutationId: expect.any(String) })));
  });

  it('every control is honest about capabilities', () => {
    header(view({ capabilities: { canRun: false, canControl: false, canEdit: false, canDelete: false } }));
    const refused = screen.getAllByTestId('disabled-with-reason').map((el) => el.parentElement?.textContent ?? '');
    expect(refused.some((t) => t.includes('Run now') && t.includes('canRun'))).toBe(true);
    expect(refused.some((t) => t.includes('Pause…') && t.includes('canControl'))).toBe(true);
    expect(refused.some((t) => t.includes('Disable') && t.includes('canControl'))).toBe(true);
    expect(refused.some((t) => t.includes('Edit') && t.includes('canEdit'))).toBe(true);
    expect(refused.some((t) => t.includes('Delete') && t.includes('canDelete'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Run now' }).getAttribute('aria-disabled')).toBe('true');
  });
});

describe('pause dialog', () => {
  it('quick picks resolve to 1 h and tomorrow 09:00; custom is bounded', () => {
    const now = new Date(NOW);
    expect('until' in resolvePause('hour', '', now) && resolvePause('hour', '', now)).toMatchObject({ until: new Date(NOW + 3_600_000) });
    const tomorrow = tomorrowAtNine(now);
    expect(tomorrow.getHours()).toBe(9);
    expect(tomorrow.getDate()).toBe(new Date(NOW + 86_400_000).getDate());
    expect(resolvePause('custom', '2026-10-27T10:00', now)).toEqual({ problem: 'The pause must end in the future.' });
    expect(resolvePause('custom', '2028-10-27T10:00', now)).toMatchObject({ problem: expect.stringContaining('365 days') });
    expect(resolvePause('custom', '', now)).toEqual({ problem: 'Pick a date and time.' });
  });

  it('submits loops.pause with the version guard', async () => {
    const p = port();
    const onPaused = vi.fn(); const onClose = vi.fn();
    render(<div className="cv2-root"><PauseDialog view={view()} port={p} onClose={onClose} onPaused={onPaused} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() => expect(onPaused).toHaveBeenCalled());
    expect(p.pause).toHaveBeenCalledWith(expect.objectContaining({ id: LOOP_ID, version: 7 }), new Date(NOW + 3_600_000).toISOString());
    expect(onClose).toHaveBeenCalled();
  });

  it('custom date-time in the past cannot be submitted', () => {
    render(<div className="cv2-root"><PauseDialog view={view()} port={port()} onClose={vi.fn()} onPaused={vi.fn()} /></div>);
    fireEvent.click(screen.getByLabelText(/Custom/));
    fireEvent.change(screen.getByLabelText('Pause until (date and time)'), { target: { value: '2020-01-01T09:00' } });
    expect(screen.getByTestId('pause-resolved').textContent).toBe('The pause must end in the future.');
    expect((screen.getByRole('button', { name: 'Pause' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a refusal stays in the dialog', async () => {
    const onClose = vi.fn();
    render(<div className="cv2-root"><PauseDialog view={view()} port={port({ pause: vi.fn(async () => { throw new CollabError('invalid_input', 'until must be in the future'); }) })} onClose={onClose} onPaused={vi.fn()} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect((await screen.findByRole('alert')).textContent).toContain('until must be in the future');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Pause… in the header opens it', () => {
    header(view());
    fireEvent.click(screen.getByRole('button', { name: 'Pause…' }));
    expect(screen.getByRole('dialog', { name: 'Pause Daily sweep' })).toBeTruthy();
  });
});

describe('runs table', () => {
  function runs(p: LoopPagePort, canControl = true) {
    const onOpenEntity = vi.fn(); const onChanged = vi.fn();
    render(<div className="cv2-root"><LoopRuns loopId={LOOP_ID} port={p} canControl={canControl} epoch={0} onOpenEntity={onOpenEntity} onChanged={onChanged} /></div>);
    return { onOpenEntity, onChanged };
  }

  it('draws every status with its chip, trigger, duration and note', async () => {
    const items = [
      run({ id: 'r1', status: 'running', endedAt: null, durationMs: null, trigger: 'manual' }),
      run({ id: 'r2', status: 'completed' }),
      run({ id: 'r3', status: 'failed', error: 'spawn refused', sessionId: null, taskId: null, durationMs: null }),
      run({ id: 'r4', status: 'skipped', skipReason: 'overlap', sessionId: null, taskId: null, durationMs: null }),
      run({ id: 'r5', status: 'stopped' }),
      run({ id: 'r6', status: 'timed_out', attempt: 2 }),
    ];
    runs(port({ runsList: vi.fn(async () => ({ items, nextCursor: null })) }));
    const rows = await screen.findAllByTestId('loop-run-row');
    expect(rows.map((r) => r.getAttribute('data-status'))).toEqual(['running', 'completed', 'failed', 'skipped', 'stopped', 'timed_out']);
    expect(rows[0]!.textContent).toContain('Run now');
    expect(rows[0]!.textContent).toContain('so far');
    expect(rows[1]!.textContent).toContain('Completed');
    expect(rows[1]!.textContent).toContain('4m 59s');
    expect(rows[2]!.textContent).toContain('spawn refused');
    expect(rows[3]!.textContent).toContain('previous run was still live');
    expect(rows[5]!.textContent).toContain('Timed out');
    expect(rows[5]!.textContent).toContain('retry 1');
    // Stop only on the running row.
    expect(within(rows[0]!).getByRole('button', { name: 'Stop' })).toBeTruthy();
    expect(within(rows[1]!).queryByRole('button', { name: 'Stop' })).toBeNull();
  });

  it('the session link opens the session tab; the task link the task', async () => {
    const { onOpenEntity } = runs(port());
    const row = (await screen.findAllByTestId('loop-run-row'))[0]!;
    fireEvent.click(within(row).getByRole('button', { name: /Open the session/ }));
    expect(onOpenEntity).toHaveBeenCalledWith(SESSION_ID);
    fireEvent.click(within(row).getByRole('button', { name: 'Task' }));
    expect(onOpenEntity).toHaveBeenCalledWith(TASK_ID);
  });

  it('Stop calls loops.runs.stop and redraws the row', async () => {
    const p = port({ runsList: vi.fn(async () => ({ items: [run({ id: 'live', status: 'running', durationMs: null })], nextCursor: null })) });
    const { onChanged } = runs(p);
    const row = (await screen.findAllByTestId('loop-run-row'))[0]!;
    fireEvent.click(within(row).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.getAllByTestId('loop-run-row')[0]!.getAttribute('data-status')).toBe('stopped'));
    expect(p.runsStop).toHaveBeenCalledWith('live');
    expect(onChanged).toHaveBeenCalled();
  });

  it('Stop is refused with a reason without canControl', async () => {
    runs(port({ runsList: vi.fn(async () => ({ items: [run({ status: 'running' })], nextCursor: null })) }), false);
    const row = (await screen.findAllByTestId('loop-run-row'))[0]!;
    expect(within(row).getByTestId('disabled-with-reason').parentElement?.textContent).toContain('canControl');
  });

  it('paginates with the cursor', async () => {
    const runsList = vi.fn()
      .mockResolvedValueOnce({ items: [run({ id: 'a' })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [run({ id: 'b' })], nextCursor: null });
    runs(port({ runsList }));
    fireEvent.click(await screen.findByRole('button', { name: 'Older runs' }));
    await waitFor(() => expect(screen.getAllByTestId('loop-run-row')).toHaveLength(2));
    expect(runsList).toHaveBeenLastCalledWith(LOOP_ID, { limit: 20, cursor: 'c1' });
    expect(screen.queryByRole('button', { name: 'Older runs' })).toBeNull();
  });

  it('empty state', async () => {
    runs(port({ runsList: vi.fn(async () => ({ items: [], nextCursor: null })) }));
    expect((await screen.findByTestId('loop-runs-empty')).textContent).toContain('No runs yet');
  });

  it('error state with retry; 501 says the server lacks it', async () => {
    const runsList = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ items: [run()], nextCursor: null });
    runs(port({ runsList }));
    expect((await screen.findByTestId('loop-runs-error')).textContent).toContain('network down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findAllByTestId('loop-run-row')).toHaveLength(1);
    cleanup();
    runs(port({ runsList: vi.fn(async () => { throw new CollabError('not_implemented', 'nope'); }) }));
    expect((await screen.findByTestId('loop-runs-error')).textContent).toContain('501');
  });

  it('duration labels: unknown is a dash, never zero', () => {
    expect(durationLabel(null)).toBe('—');
    expect(durationLabel(45_000)).toBe('45s');
    expect(durationLabel(3_840_000)).toBe('1h 4m');
  });
});

describe('the registry row mounts the page through GenericBody', () => {
  function detail(): EntityDetail {
    return {
      id: LOOP_ID, kind: 'loop', title: 'Daily sweep', version: 7,
      content: { kind: 'loop', schedule: '0 9 * * *', teamMemberId: RUNNER_ID, config: { model: 'opus' } },
      state: { kind: 'loop' },
      capabilities: { canEdit: true, canDelete: true },
      connections: { outgoing: [], incoming: [] },
    } as unknown as EntityDetail;
  }

  it('header, WHAT IT RUNS, SCHEDULE, SETTINGS and RUNS render from one loops.get, without raw ids', async () => {
    const p = port();
    render(
      <div className="cv2-root">
        <GenericBody detail={detail()} blocks={getKind('loop').panel.blocks ?? []} commands={{ loops: p, loopForm: sources() }} />
      </div>,
    );
    expect(await screen.findByTestId('loop-header')).toBeTruthy();
    expect(screen.getByTestId('loop-what').textContent).toContain('Dreamer');
    expect(screen.getByTestId('loop-schedule').textContent).toContain('Every day at 09:00 UTC');
    expect(screen.getByTestId('loop-settings').textContent).toContain('opus');
    expect(screen.getByTestId('loop-settings').textContent).toContain('2 retries, 5m 0s apart');
    expect(await screen.findAllByTestId('loop-run-row')).toHaveLength(1);
    expect(p.get).toHaveBeenCalledTimes(1);
    const page = document.querySelector('.pn-body')!.textContent ?? '';
    expect(page).not.toContain(RUNNER_ID);
    for (const label of ['WHAT IT RUNS', 'SCHEDULE', 'SETTINGS', 'RUNS']) expect(page).toContain(label);
  });

  it('says so when the surface has no loops client', () => {
    render(<div className="cv2-root"><GenericBody detail={detail()} blocks={getKind('loop').panel.blocks ?? []} commands={null} /></div>);
    expect(screen.getAllByText(/not wired on this surface/).length).toBeGreaterThan(0);
  });

  it('a dispatch loop says the Dispatcher decides; a tool loop names the tool and its inputs', async () => {
    render(<div className="cv2-root"><GenericBody detail={detail()} blocks={getKind('loop').panel.blocks ?? []} commands={{ loops: port({ get: vi.fn(async () => view({ definition: { action: 'dispatch', teamMemberId: null } })) }), loopForm: sources() }} /></div>);
    expect((await screen.findByTestId('loop-what')).textContent).toContain('Dispatcher decides');
    cleanup(); resetLoopPageStore();
    render(<div className="cv2-root"><GenericBody detail={detail()} blocks={getKind('loop').panel.blocks ?? []} commands={{ loops: port({ get: vi.fn(async () => view({ definition: { action: 'tool', toolId: 'tool-1', teamMemberId: null, toolInputs: { repo: 'tm8' } } })) }), loopForm: sources() }} /></div>);
    const what = (await screen.findByTestId('loop-what')).textContent ?? '';
    expect(what).toContain('Runs tool');
    expect(what).toContain('repo = tm8');
    expect(what).not.toContain('tool-1');
  });
});

/* --- PR5b review fixes --------------------------------------------------- */

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function Probe({ p, version }: { p: LoopPagePort; version: number }) {
  const slot = useLoopView(p, LOOP_ID, version);
  return (
    <div>
      <span data-testid="probe-version">{slot.view ? slot.view.version : 'none'}</span>
      <span data-testid="probe-error">{slot.error ? 'error' : ''}</span>
      <button type="button" onClick={() => slot.setView({ ...view(), version: 9 })}>set9</button>
      <button type="button" onClick={() => void slot.reload()}>reload</button>
    </div>
  );
}

describe('one read for the page: newer wins', () => {
  it('a read in flight for an older version is not reused, and its late answer cannot land', async () => {
    const first = deferred<LoopView>(), second = deferred<LoopView>();
    const get = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const p = port({ get });
    const { rerender } = render(<Probe p={p} version={7} />);
    rerender(<Probe p={p} version={8} />);
    expect(get).toHaveBeenCalledTimes(2);
    await act(async () => { second.resolve({ ...view(), version: 8 }); });
    expect(screen.getByTestId('probe-version').textContent).toBe('8');
    await act(async () => { first.resolve({ ...view(), version: 7 }); });
    expect(screen.getByTestId('probe-version').textContent).toBe('8');
  });

  it('a command\'s newer view survives an older reload, and its version needs no second read', async () => {
    const stale = deferred<LoopView>();
    const get = vi.fn().mockResolvedValueOnce({ ...view(), version: 7 }).mockReturnValueOnce(stale.promise);
    const p = port({ get });
    const { rerender } = render(<Probe p={p} version={7} />);
    await waitFor(() => expect(screen.getByTestId('probe-version').textContent).toBe('7'));
    fireEvent.click(screen.getByText('reload'));
    fireEvent.click(screen.getByText('set9'));
    await act(async () => { stale.resolve({ ...view(), version: 8 }); });
    expect(screen.getByTestId('probe-version').textContent).toBe('9');
    rerender(<Probe p={p} version={9} />);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('the slot goes with the last block, so a failed read does not outlive the page', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValue(view());
    const p = port({ get });
    render(<Probe p={p} version={7} />);
    await waitFor(() => expect(screen.getByTestId('probe-error').textContent).toBe('error'));
    cleanup();
    render(<Probe p={p} version={7} />);
    await waitFor(() => expect(screen.getByTestId('probe-version').textContent).toBe('7'));
    expect(screen.getByTestId('probe-error').textContent).toBe('');
  });
});

describe('the runs table follows the loop', () => {
  it('another loop starts empty, and a slow answer for the previous loop is dropped', async () => {
    const slowA = deferred<{ items: LoopRun[]; nextCursor: string | null }>();
    const runsList = vi.fn((loopId: string) => (loopId === LOOP_ID ? slowA.promise : Promise.resolve({ items: [run({ id: 'run-b', loopId: 'loop-b' })], nextCursor: null })));
    const p = port({ runsList: runsList as never });
    const { rerender } = render(<LoopRuns loopId={LOOP_ID} port={p} canControl epoch={0} />);
    rerender(<LoopRuns loopId="loop-b" port={p} canControl epoch={0} />);
    await waitFor(() => expect(screen.getAllByTestId('loop-run-row')).toHaveLength(1));
    await act(async () => { slowA.resolve({ items: [run({ id: 'run-a1' }), run({ id: 'run-a2' })], nextCursor: null }); });
    expect(screen.getAllByTestId('loop-run-row')).toHaveLength(1);
  });

  it('a page-one refresh MERGES: older pages and their cursor stay while a live run is polled (PR5b #3)', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const runsList = vi.fn()
      .mockResolvedValueOnce({ items: [run({ id: 'live', status: 'running', endedAt: null, durationMs: null })], nextCursor: 'c1' })
      .mockResolvedValueOnce({ items: [run({ id: 'old-1' }), run({ id: 'old-2' })], nextCursor: 'c2' })
      .mockResolvedValue({ items: [run({ id: 'new', status: 'running', endedAt: null, durationMs: null }), run({ id: 'live', status: 'completed' })], nextCursor: 'c1-later' });
    render(<LoopRuns loopId={LOOP_ID} port={port({ runsList })} canControl epoch={0} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Older runs' }));
    await waitFor(() => expect(screen.getAllByTestId('loop-run-row')).toHaveLength(3));
    await act(async () => { vi.advanceTimersByTime(RUNNING_POLL_MS); });
    await waitFor(() => expect(screen.getAllByTestId('loop-run-row')).toHaveLength(4));
    expect(screen.getAllByTestId('loop-run-row').map((row) => row.getAttribute('data-run-id'))).toEqual(['new', 'live', 'old-1', 'old-2']);
    expect(screen.getAllByTestId('loop-run-row')[1]!.getAttribute('data-status')).toBe('completed');
    // The cursor still points after the older page, not after page one.
    fireEvent.click(screen.getByRole('button', { name: 'Older runs' }));
    await waitFor(() => expect(runsList).toHaveBeenLastCalledWith(LOOP_ID, { limit: 20, cursor: 'c2' }));
  });

  it('a failed background refresh keeps the rows and says so beside them', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const runsList = vi.fn()
      .mockResolvedValueOnce({ items: [run({ id: 'live', status: 'running', endedAt: null, durationMs: null })], nextCursor: null })
      .mockRejectedValueOnce(new CollabError('upstream_unavailable', 'the tm8 node did not answer'))
      .mockResolvedValue({ items: [run({ id: 'live', status: 'completed' })], nextCursor: null });
    render(<LoopRuns loopId={LOOP_ID} port={port({ runsList })} canControl epoch={0} />);
    await screen.findByTestId('loop-run-row');
    await act(async () => { vi.advanceTimersByTime(RUNNING_POLL_MS); });
    const banner = await screen.findByTestId('loop-runs-refresh-error');
    expect(screen.getAllByTestId('loop-run-row')).toHaveLength(1);
    expect(screen.queryByTestId('loop-runs-error')).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByTestId('loop-runs-refresh-error')).toBeNull());
    expect(screen.getByTestId('loop-run-row').getAttribute('data-status')).toBe('completed');
  });

  it('re-reads page one while a run is live, until it settles', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(NOW);
    const runsList = vi.fn()
      .mockResolvedValueOnce({ items: [run({ status: 'running', endedAt: null, durationMs: null })], nextCursor: null })
      .mockResolvedValue({ items: [run({ status: 'completed' })], nextCursor: null });
    render(<LoopRuns loopId={LOOP_ID} port={port({ runsList })} canControl epoch={0} />);
    await waitFor(() => expect(screen.getByTestId('loop-run-row').getAttribute('data-status')).toBe('running'));
    await act(async () => { vi.advanceTimersByTime(RUNNING_POLL_MS); });
    await waitFor(() => expect(screen.getByTestId('loop-run-row').getAttribute('data-status')).toBe('completed'));
    const calls = runsList.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(RUNNING_POLL_MS * 2); });
    expect(runsList).toHaveBeenCalledTimes(calls);
  });

  it('a scheduled firing (a new lastRunAt) refreshes the table through GenericBody', async () => {
    const runsList = vi.fn(async () => ({ items: [run()], nextCursor: null }));
    const get = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue({ ...view({ state: { lastRunAt: '2026-10-28T11:59:00.000Z' } }), version: 8 });
    const p = port({ get, runsList });
    const body = (version: number) => (
      <div className="cv2-root">
        <GenericBody detail={{ ...pageDetail(), version } as EntityDetail} blocks={getKind('loop').panel.blocks ?? []} commands={{ loops: p, loopForm: sources() }} />
      </div>
    );
    const { rerender } = render(body(7));
    await waitFor(() => expect(runsList).toHaveBeenCalledTimes(1));
    rerender(body(8));
    await waitFor(() => expect(runsList).toHaveBeenCalledTimes(2));
  });
});

describe('the header after the review', () => {
  it('a deadline inside a pause fires when the pause ends, and says so', () => {
    header(view({ state: { pausedUntil: '2026-10-28T18:00:00.000Z', nextRunAt: '2026-10-28T15:00:00.000Z' } }));
    expect(screen.getByTestId('loop-next-run').textContent).toMatch(/^Next run when the pause ends/);
  });

  it('Run now on a disabled loop says it fires once and the schedule stays off', () => {
    header(view({ state: { enabled: false } }));
    expect(screen.getByTestId('loop-run-disabled-note').textContent).toMatch(/fires it once/);
    expect(screen.getByRole('button', { name: 'Run now' }).getAttribute('title')).toMatch(/schedule stays off/);
  });

  it('after a delete nothing on the page acts on the loop, and the host is told', async () => {
    const onDeleted = vi.fn();
    const props = header(view(), port(), { onDeleted });
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete loop' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
    expect(props.deleteEntity).toHaveBeenCalledTimes(1);
    // Every control is now refused with why (DisabledAction), never a live button.
    for (const name of ['Run now', 'Disable', 'Edit', 'Delete']) {
      expect(screen.getByRole('button', { name }).getAttribute('aria-disabled')).toBe('true');
    }
  });
});

function pageDetail(): EntityDetail {
  return {
    id: LOOP_ID, kind: 'loop', title: 'Daily sweep', version: 7,
    content: { kind: 'loop', schedule: '0 9 * * *', teamMemberId: RUNNER_ID, config: { model: 'opus' } },
    state: { kind: 'loop' },
    capabilities: { canEdit: true, canDelete: true },
    connections: { outgoing: [], incoming: [] },
  } as unknown as EntityDetail;
}
