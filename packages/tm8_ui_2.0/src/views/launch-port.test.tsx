// @vitest-environment jsdom
/**
 * THE LAUNCH PORT IS WIRED ON EVERY SCREEN THAT HOSTS A LIST.
 *
 * The defect this pins (user report, 2026-08-02): `EntityView` — the screen a
 * rail kind row opens, i.e. the standalone Tasks list — rendered the SAME
 * `EntityListPanel` as the workspace but passed it no `launch` prop. The panel's
 * absent-source defaults (`props.launch?.teammates ?? []`) then produced a Run
 * expand whose teammate select said "no teammates available" and whose model
 * select said "no known models for this tool" — the model list is derived from
 * the SEEDING TEAMMATE's recorded tool, so one empty list empties the other.
 *
 * It read as flaky state rather than a missing prop because `activeTarget` in
 * GateApp is component state initialised to the workspace and never persisted:
 * every RELOAD lands on the screen where the prop WAS passed. "It works after I
 * refresh" was the routing, not a race.
 *
 * These tests assert the two halves separately — the port carries the data, and
 * BOTH hosts hand it to their panel — because a test that only rendered the
 * workspace passed throughout the entire life of the bug.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, waitFor, within } from '@testing-library/react';
import type { EntityId } from '@tm8/contract';
import { LaunchQuickConfig, type LaunchTeammateOption } from '../panels/launch/LaunchQuickConfig';
import { useLaunchPort } from './useLaunchPort';
import { useLaunchSheet } from './useLaunchSheet';
import { EntityView } from './EntityView';
import { useGateData } from './useGateData';
import type { GateData } from './useGateData';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import type { DetailReasons } from '../panels';
import { LAUNCH_CAPACITY, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';

/** Only the slice `useLaunchPort` reads; the rest of GateData is irrelevant here. */
const gateDataStub = () => ({
  spaceId: 'space-1',
  launch: {
    teammates: LAUNCH_TEAMMATES,
    projects: LAUNCH_PROJECTS,
    profiles: LAUNCH_PROFILES,
    capacity: LAUNCH_CAPACITY,
  },
}) as unknown as GateData;

describe('useLaunchPort', () => {
  it('carries every teammate through to the panel-facing option shape', () => {
    const { result } = renderHook(() => useLaunchPort(gateDataStub()));

    expect(result.current.teammates).toHaveLength(LAUNCH_TEAMMATES.length);
    // `label`, not `name`: the panel's own option type. A silently-empty map
    // here is the same class of failure as not passing the prop at all.
    expect(result.current.teammates[0]).toMatchObject({
      id: 'ent-tm-forge',
      label: 'forge',
      agentTool: 'claude-code',
      model: 'claude-sonnet-5',
    });
    expect(result.current.projects.map((p) => p.projectId)).toContain('pj-tm8ui');
  });

  it('resolves the teammate default profile ahead of the space default', () => {
    const { result } = renderHook(() => useLaunchPort(gateDataStub()));

    // forge pins pf-standard, which is ALSO the space default — the source
    // word is what distinguishes an inherited default from a chosen one.
    expect(result.current.profileFor('ent-tm-forge')).toMatchObject({ source: 'teammate-default' });
    // scout pins nothing, so the space default wins and must SAY so.
    expect(result.current.profileFor('ent-tm-scout')).toMatchObject({ source: 'space-default' });
  });

  it('omits onSpawn when the host has no dispatcher, so Launch stays refused', () => {
    const { result } = renderHook(() => useLaunchPort(gateDataStub()));
    expect(result.current.onSpawn).toBeUndefined();

    const spawn = vi.fn();
    const wired = renderHook(() => useLaunchPort(gateDataStub(), { onSpawn: spawn }));
    expect(wired.result.current.onSpawn).toBe(spawn);
  });
});

describe('the quick config renders real options from the port', () => {
  const renderConfig = (teammates: readonly LaunchTeammateOption[]) =>
    render(
      <LaunchQuickConfig
        subject={{ id: 'task-1', title: 'a task' }}
        spaceId="space-1"
        teammates={teammates}
        clientMutationId="cmid-1"
      />,
    );

  it('is EMPTY when the host passes no teammates — the reported symptom', () => {
    // The control. This is exactly what EntityView produced, and it is why both
    // selects went blank at once rather than only the teammate one.
    const view = renderConfig([]);

    expect(within(view.getByTestId('launch-teammate')).getAllByRole('option')).toHaveLength(1);
    expect(view.getByTestId('launch-teammate').textContent).toContain('no teammates available');
    expect(view.getByTestId('launch-model').textContent).toContain('no known models');
  });

  it('offers the teammates AND that teammate’s models when the port is wired', () => {
    const { result } = renderHook(() => useLaunchPort(gateDataStub()));
    const view = renderConfig(result.current.teammates);

    const teammateOptions = within(view.getByTestId('launch-teammate')).getAllByRole('option');
    expect(teammateOptions.map((o) => o.textContent)).toEqual(['forge', 'scout']);

    // The model select is populated BY the seeding teammate's agent tool, so a
    // populated teammate list that left this empty would still be broken.
    const modelOptions = within(view.getByTestId('launch-model')).getAllByRole('option');
    expect(modelOptions.length).toBeGreaterThan(0);
    expect(view.getByTestId('launch-model').textContent).not.toContain('no known models');
    expect((view.getByTestId('launch-model') as HTMLSelectElement).value).toBe('claude-sonnet-5');
  });

  it('RE-SEEDS when teammates arrive after mount', () => {
    // The initializer runs once. Mounted before its sources landed, the config
    // kept a null teammate and a null tool forever — the teammate select had a
    // value matching no option (so it rendered blank) and the model select
    // stayed on "no known models" even once options existed.
    const { result } = renderHook(() => useLaunchPort(gateDataStub()));
    const view = renderConfig([]);
    expect(view.getByTestId('launch-model').textContent).toContain('no known models');

    view.rerender(
      <LaunchQuickConfig
        subject={{ id: 'task-1', title: 'a task' }}
        spaceId="space-1"
        teammates={result.current.teammates}
        clientMutationId="cmid-1"
      />,
    );

    expect((view.getByTestId('launch-teammate') as HTMLSelectElement).value).toBe('ent-tm-forge');
    expect((view.getByTestId('launch-model') as HTMLSelectElement).value).toBe('claude-sonnet-5');
    expect(view.getByTestId('launch-model').textContent).not.toContain('no known models');
  });
});

/**
 * The orphan rule's POLARITY depends on where the sheet was opened from.
 *
 * Obligation 2 binds a sheet to the PANEL it came from: panel leaves, sheet
 * goes. But Run on a LIST ROW opens the sheet for an entity that has no panel
 * at all — enforcing hosted-membership there closed the sheet in the same
 * tick it opened, so the direct-to-sheet Run (user ruling 2026-08-09) would
 * flash and vanish on every row whose entity was not already open.
 */
describe('useLaunchSheet — the orphan rule knows a row-opened sheet has no panel', () => {
  const hook = (hostedIds: readonly EntityId[]) =>
    renderHook(({ ids }) => useLaunchSheet({ hostedIds: ids }), {
      initialProps: { ids: hostedIds },
    });

  it('a sheet opened from a LIST ROW (subject never hosted) STAYS OPEN', () => {
    const { result, rerender } = hook(['ent-open-panel' as EntityId]);

    act(() => result.current.open('ent-task-row' as EntityId));
    expect(result.current.subjectId).toBe('ent-task-row');

    // Stack churn — a panel closes elsewhere. Says nothing about this subject.
    rerender({ ids: [] });
    expect(result.current.subjectId).toBe('ent-task-row');
  });

  it('a sheet opened for a HOSTED panel still closes when that panel leaves', () => {
    const { result, rerender } = hook(['ent-open-panel' as EntityId]);

    act(() => result.current.open('ent-open-panel' as EntityId));
    expect(result.current.subjectId).toBe('ent-open-panel');

    rerender({ ids: [] });
    expect(result.current.subjectId).toBeNull();
  });
});

/**
 * THE SHEET EXISTS ON THE KIND SCREEN (user report 2026-08-09): tasks are
 * launched FROM the standalone Tasks screen, and the sheet living only in the
 * workspace centre made "full options" permanently disabled exactly where
 * launching happens. Same vantage as the header comment: only mounting the
 * REAL view can see a missing mount.
 */
describe('the kind screen mounts the FULL launch sheet', () => {
  const REASONS: DetailReasons = {
    presenceHollow: 'Presence isn’t measured yet.',
    versionHistory: 'Version history isn’t available yet.',
    provenanceHollow: 'Authorship provenance isn’t available yet.',
    shareUnavailable: 'Sharing into a session isn’t available yet.',
    withdrawUnavailable: 'Withdrawing a handoff isn’t available yet.',
  };

  function TasksHost(props: { launchSubjectId: EntityId | null; onLaunchCancel?: () => void }) {
    const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: createFixtureSeam() });
    return (
      <EntityView
        data={data as GateData & { pull?: (id: string) => void }}
        kind="task"
        reasons={REASONS}
        onNotice={() => {}}
        onLaunchOpen={() => {}}
        launchSubjectId={props.launchSubjectId}
        onLaunchCancel={props.onLaunchCancel}
      />
    );
  }

  it('renders the sheet over the tasks screen while the shell holds a subject', async () => {
    const onLaunchCancel = vi.fn();
    const view = render(
      <TasksHost launchSubjectId={'ent-task-row' as EntityId} onLaunchCancel={onLaunchCancel} />,
    );

    const sheet = await waitFor(() => view.getByTestId('launch-sheet'));
    // The reorganized anatomy, on THIS screen: teammate and configuration
    // are present, so the mount is the real five-section sheet, not a stub.
    const eyebrows = [...sheet.querySelectorAll('.ls__eyebrow')].map((n) => n.textContent);
    expect(eyebrows).toContain('TEAMMATE');
    expect(eyebrows).toContain('CONFIGURATION');

    // And its verbs reach the shell — Cancel is the shell's close, not a no-op.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close launch sheet' }));
    expect(onLaunchCancel).toHaveBeenCalledTimes(1);
  });

  it('mounts NO sheet when the shell holds none — the fallback state is clean', () => {
    const view = render(<TasksHost launchSubjectId={null} />);
    expect(view.queryByTestId('launch-sheet')).toBeNull();
  });
});
