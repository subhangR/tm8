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
import { render, renderHook, within } from '@testing-library/react';
import { LaunchQuickConfig, type LaunchTeammateOption } from '../panels/launch/LaunchQuickConfig';
import { useLaunchPort } from './useLaunchPort';
import type { GateData } from './useGateData';
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
