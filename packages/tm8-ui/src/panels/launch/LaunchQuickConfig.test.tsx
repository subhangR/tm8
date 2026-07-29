// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import type { EntityCapabilities, ExecutionSpawnInput } from '@tm8/contract';
import { FIXTURE_SPACE_ID, fixtureSummaries } from '../../fixtures';
import { modelsFor, resolveAction, type ActionContext } from '../../domain';
import { EntityListPanel, type LaunchSources } from '../EntityListPanel';
import { LaunchQuickConfig, type LaunchTeammateOption } from './LaunchQuickConfig';

/**
 * D44 — the Run flow.
 *
 * The load-bearing claim of every test here is that Run OPENS A CONFIG rather
 * than firing a spawn, and that the config states what it cannot do instead of
 * presenting a button that silently fails. Each honesty test asserts BOTH
 * halves: the wired case must go green where the unwired case goes red, or the
 * test is only measuring that some string exists.
 */

const ctx: ActionContext = { spaceId: FIXTURE_SPACE_ID };

const TEAMMATES: readonly LaunchTeammateOption[] = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
  { id: 'tm-scout', label: 'scout', agentTool: 'claude-code', model: 'claude-haiku-4-5-20251001' },
];

const subject = { id: 'task-1', title: 'Wire the launch flow' };

function sources(over: Partial<LaunchSources> = {}): LaunchSources {
  return {
    spaceId: FIXTURE_SPACE_ID,
    teammates: TEAMMATES,
    projects: [],
    mutationId: (id) => `m:${id}`,
    ...over,
  };
}

/**
 * Run gates on `canEdit`, and ABSENT capabilities mean unknown, which means
 * not permitted. Granting them here is what makes these tests measure the FLOW
 * rather than the permission refusal that would otherwise mask it.
 */
const PERMITTED: EntityCapabilities = {
  canEdit: true,
  canDelete: true,
  canAddChild: true,
  canLink: true,
  canPull: true,
  canReact: true,
  canGrantPoints: true,
  canComplete: true,
};

/** The task list is the surface that carries `run` as a row action. */
function taskRows() {
  const rows = fixtureSummaries.filter((r) => r.kind === 'task');
  if (rows.length === 0) throw new Error('fixtures must supply task rows for this test');
  return rows;
}

describe('the Run verb opens a flow instead of dispatching', () => {
  it('is declared as DATA, so this panel never names the verb or the kind', () => {
    // If this ever goes undefined the panel silently reverts to dispatching,
    // and every test below would still pass against a Run that fires blind.
    expect(resolveAction('run').flow).toBe('launch');
  });

  it('expands the config and does NOT call onAction', () => {
    const onAction = vi.fn();
    const rows = taskRows();
    const { getAllByTestId, queryByTestId, getByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={() => rows}
        ctx={ctx}
        onAction={onAction}
        capabilitiesOf={() => PERMITTED}
        launch={sources()}
      />,
    );

    expect(queryByTestId('launch-quick-config')).toBeNull();
    const run = getAllByTestId('list-tile')[0].querySelector('[aria-label="Run"]');
    expect(run).not.toBeNull();
    fireEvent.click(run as Element);

    const config = getByTestId('launch-quick-config');
    expect(config).toBeTruthy();
    // The Maestro layout is one component: launch controls live in the same
    // expanded card region as the row facts, never in a detached popover.
    expect(config.closest('.pn-tt__meta')).not.toBeNull();
    expect(config.closest('[data-anatomy="control-card"]')).toBe(getAllByTestId('list-tile')[0]);
    // The whole point: opening a configuration is not launching.
    expect(onAction).not.toHaveBeenCalled();
  });

  it('closes again on a second click — the trigger sits inside the dismissal bounds', () => {
    // Regression: the expand dismisses on outside pointer-down. With the
    // bounds set to the config itself, the trigger counted as OUTSIDE, so its
    // own mousedown closed the config a moment before its click re-opened it
    // and the toggle could never close. Bounds are the row, which holds both.
    const rows = taskRows();
    const { getAllByTestId, queryByTestId } = render(
      <EntityListPanel kind="task" rowsFor={() => rows} ctx={ctx} capabilitiesOf={() => PERMITTED}
        launch={sources()} />,
    );
    const run = getAllByTestId('list-tile')[0].querySelector('[aria-label="Run"]') as Element;

    fireEvent.mouseDown(run);
    fireEvent.click(run);
    expect(queryByTestId('launch-quick-config')).toBeTruthy();

    fireEvent.mouseDown(run);
    fireEvent.click(run);
    expect(queryByTestId('launch-quick-config')).toBeNull();
  });

  it('stays reachable without onAction, because clicking it genuinely does something', () => {
    // The enabled-inert rule (R5 #9) turns UNWIRED verbs into
    // disabled-with-reason. A flow verb is not unwired: it opens a config that
    // speaks for itself, so it must NOT be swallowed by that guard.
    const rows = taskRows();
    const { getAllByTestId } = render(
      <EntityListPanel kind="task" rowsFor={() => rows} ctx={ctx} capabilitiesOf={() => PERMITTED}
        launch={sources()} />,
    );
    const tile = getAllByTestId('list-tile')[0];
    expect(tile.querySelector('[aria-label="Run"]')).not.toBeNull();
  });

  it('still disables a NON-flow row verb when nothing is wired — the guard is intact', () => {
    // The other half of the test above: without this, deleting the guard
    // entirely would leave every test in this file green.
    const rows = taskRows();
    const { getAllByTestId } = render(
      <EntityListPanel kind="task" rowsFor={() => rows} ctx={ctx} capabilitiesOf={() => PERMITTED}
        launch={sources()} />,
    );
    const tile = getAllByTestId('list-tile')[0];
    const disabled = within(tile).getAllByTestId('disabled-with-reason');
    expect(disabled.length).toBeGreaterThan(0);
  });
});

describe('waiting for capabilities is not the same as being refused them', () => {
  /**
   * fe->a1c 63 / D6-D39 at the capability layer. Capabilities ride on
   * EntityDetail, so an un-hydrated row's permissions are UNKNOWN. The three
   * tests below are one test: the same surface must produce three DIFFERENT
   * renders for three different facts. Any two collapsing into one is the
   * defect.
   */
  const rows = () => taskRows();

  it('renders the LOADING form while the row has not answered yet', () => {
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rows}
        ctx={ctx}
        onAction={vi.fn()}
        capabilitiesOf={() => undefined}
      />,
    );
    const tile = getAllByTestId('list-tile')[0];
    expect(within(tile).getAllByTestId('checking-permission').length).toBeGreaterThan(0);
    // ...and NOT the refusal form, which would state a permission verdict
    // that has not been reached.
    expect(within(tile).queryByTestId('disabled-with-reason')).toBeNull();
  });

  it('renders the REFUSAL form once the row has answered no', () => {
    const denied = { ...PERMITTED, canEdit: false, canComplete: false };
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rows}
        ctx={ctx}
        onAction={vi.fn()}
        capabilitiesOf={() => denied}
      />,
    );
    const tile = getAllByTestId('list-tile')[0];
    expect(within(tile).getAllByTestId('disabled-with-reason').length).toBeGreaterThan(0);
    expect(within(tile).queryByTestId('checking-permission')).toBeNull();
  });

  it('renders a live control once the row has answered yes', () => {
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rows}
        ctx={ctx}
        onAction={vi.fn()}
        capabilitiesOf={() => PERMITTED}
        launch={sources()}
      />,
    );
    const tile = getAllByTestId('list-tile')[0];
    expect(tile.querySelector('[aria-label="Run"]')).not.toBeNull();
    expect(within(tile).queryByTestId('checking-permission')).toBeNull();
  });

  it('does not announce a refusal it has not reached', () => {
    // The checking state carries no `role="button"` and no reason, because
    // there is no verdict to announce — only a fact still in flight.
    const { getAllByTestId } = render(
      <EntityListPanel
        kind="task"
        rowsFor={rows}
        ctx={ctx}
        onAction={vi.fn()}
        capabilitiesOf={() => undefined}
      />,
    );
    const el = within(getAllByTestId('list-tile')[0]).getAllByTestId('checking-permission')[0];
    expect(el.getAttribute('role')).toBeNull();
    expect(el.getAttribute('aria-label')).toMatch(/checking permissions/i);
  });
});

describe('the config refuses honestly rather than presenting a dead button', () => {
  it('renders Launch disabled-with-reason when no dispatcher is supplied', () => {
    const { getByTestId, queryByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        clientMutationId="m:1"
      />,
    );
    expect(queryByTestId('launch-commit')).toBeNull();
    const reason = within(getByTestId('launch-quick-config')).getAllByTestId('disabled-with-reason');
    expect(reason.some((el) => el.textContent?.includes('Launch'))).toBe(true);
  });

  it('renders a real Launch when one IS supplied', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    expect(getByTestId('launch-commit')).toBeTruthy();
  });

  it('refuses with no teammate to run as, and names that as the blocker', () => {
    const { queryByTestId, getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={[]}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    // A dispatcher IS wired here, so a surviving Launch would prove the
    // refusal came from canLaunch and not from the not-wired branch.
    expect(queryByTestId('launch-commit')).toBeNull();
    expect(getByTestId('launch-quick-config').textContent).toMatch(/teammate/i);
  });
});

describe('what the config states before you commit', () => {
  it('shows an unknown live-session count as unknown, never as zero', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        loadFor={() => ({ teamMemberId: 'tm-forge', liveSessionCount: null })}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    const load = getByTestId('launch-load');
    expect(load.textContent).toMatch(/unknown, not zero/);
    expect(load.textContent).not.toMatch(/^no live sessions$/);
    expect(load.className).toContain('lq__load--hollow');
  });

  it('shows a known zero as a plain zero — the other half of hollow', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        loadFor={() => ({ teamMemberId: 'tm-forge', liveSessionCount: 0 })}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    const load = getByTestId('launch-load');
    expect(load.textContent).toBe('no live sessions');
    expect(load.className).not.toContain('hollow');
  });

  it('states the profile WITH its provenance, so an inherited default is not read as a choice', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        profileFor={() => ({ profileId: 'pf-1', label: 'Standard', source: 'teammate-default' })}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    const line = getByTestId('launch-profile').textContent ?? '';
    expect(line).toContain('Standard');
    // The provenance is the point; the bare label alone would be the defect.
    expect(line).toMatch(/default/);
  });

  it('states capacity before the click, not after a refusal', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        capacity={{ slotsFree: 2, slotsTotal: 6 }}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    expect(getByTestId('launch-capacity').textContent).toBe('2 of 6 session slots free');
  });

  it('refuses at zero slots, with capacity as the stated cause', () => {
    const { queryByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        capacity={{ slotsFree: 0, slotsTotal: 6 }}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    expect(queryByTestId('launch-commit')).toBeNull();
  });
});

describe('what Launch actually commits', () => {
  it('defaults to the first trusted linked project and submits project workdir', () => {
    const onSpawn = vi.fn<(input: ExecutionSpawnInput) => void>();
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        projects={[
          { projectId: 'project-untrusted', name: 'vendor', trusted: false },
          { projectId: 'project-current', name: 'tm8', trusted: true },
        ]}
        onSpawn={onSpawn}
        clientMutationId="m:project"
      />,
    );

    fireEvent.click(getByTestId('launch-commit'));
    expect(onSpawn).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-current',
      workdir: { mode: 'project' },
      mode: 'worker',
    }));
  });

  it('sends the configured teammate, model and task through buildSpawnInput', () => {
    const onSpawn = vi.fn<(input: ExecutionSpawnInput) => void>();
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={onSpawn}
        clientMutationId="m:1"
      />,
    );
    fireEvent.click(getByTestId('launch-commit'));

    expect(onSpawn).toHaveBeenCalledTimes(1);
    const input = onSpawn.mock.calls[0][0];
    expect(input.spaceId).toBe(FIXTURE_SPACE_ID);
    expect(input.clientMutationId).toBe('m:1');
    expect(JSON.stringify(input)).toContain('tm-forge');
    expect(JSON.stringify(input)).toContain(subject.id);
  });

  it('re-seeds tool and model together when the teammate changes', () => {
    // Patching one field would leave the previous persona's model attached to
    // the new one — a config that looks deliberate and is not.
    const onSpawn = vi.fn<(input: ExecutionSpawnInput) => void>();
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={onSpawn}
        clientMutationId="m:1"
      />,
    );
    fireEvent.change(getByTestId('launch-teammate'), { target: { value: 'tm-scout' } });
    fireEvent.click(getByTestId('launch-commit'));

    const serialized = JSON.stringify(onSpawn.mock.calls[0][0]);
    expect(serialized).toContain('tm-scout');
    expect(serialized).toContain('claude-haiku');
    expect(serialized).not.toContain('claude-sonnet');
  });

  it('mints a fresh mutation id for each deliberate submit attempt', async () => {
    const newClientMutationId = vi.fn()
      .mockReturnValueOnce('m:fresh-1')
      .mockReturnValueOnce('m:fresh-2');
    const onSpawn = vi.fn()
      .mockRejectedValueOnce(new Error('first attempt refused'))
      .mockResolvedValueOnce(undefined);
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={onSpawn}
        newClientMutationId={newClientMutationId}
      />,
    );

    fireEvent.click(getByTestId('launch-commit'));
    await waitFor(() => expect((getByTestId('launch-commit') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(getByTestId('launch-commit'));

    expect(newClientMutationId).toHaveBeenCalledTimes(2);
    expect(onSpawn.mock.calls.map(([input]) => input.clientMutationId)).toEqual([
      'm:fresh-1',
      'm:fresh-2',
    ]);
  });

  it('offers only models the selected tool actually has', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    const options = within(getByTestId('launch-model')).getAllByRole('option');
    const expected = modelsFor('claude-code');
    expect(expected.length).toBeGreaterThan(0);
    expect(options).toHaveLength(expected.length);
  });

  it('states the absence rather than guessing when the tool is unknown', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={[{ id: 'tm-x', label: 'x', agentTool: 'not-a-real-tool', model: null }]}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    expect(getByTestId('launch-model').textContent).toMatch(/no known models/);
  });
});

describe('a refused launch must not look like a successful one', () => {
  /**
   * Caught in the browser, not here. The first version did
   * `void onSpawn(...); onDismiss()` — fire and close unconditionally. The
   * fixture seam refused the spawn ("entity tm-forge not found"), the promise
   * rejected into nothing, the config closed anyway, and the ONLY trace was a
   * console exception. Two opposite outcomes, one identical rendering: the
   * same facet collapse as a hollow zero, at the commit step.
   */
  it('keeps the config open and shows the node’s own words when the spawn rejects', async () => {
    const onDismiss = vi.fn();
    const onSpawn = vi.fn().mockRejectedValue(new Error('entity tm-forge not found'));
    const { getByTestId, findByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={onSpawn}
        onDismiss={onDismiss}
        clientMutationId="m:1"
      />,
    );
    fireEvent.click(getByTestId('launch-commit'));

    const card = await findByTestId('launch-refusal');
    // The NODE's sentence, not a generic apology.
    expect(card.textContent).toMatch(/entity tm-forge not found/);
    // And the configuration survives, so it can be corrected rather than retyped.
    expect(getByTestId('launch-quick-config')).toBeTruthy();
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('dismisses only when the spawn actually resolves — the other half', async () => {
    const onDismiss = vi.fn();
    const { getByTestId, queryByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={vi.fn().mockResolvedValue(undefined)}
        onDismiss={onDismiss}
        clientMutationId="m:1"
      />,
    );
    fireEvent.click(getByTestId('launch-commit'));

    await vi.waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(queryByTestId('launch-refusal')).toBeNull();
  });
});

describe('the escape to the full sheet', () => {
  it('is disabled-with-reason when the sheet is not hosted, never silently missing', () => {
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={vi.fn()}
        clientMutationId="m:1"
      />,
    );
    expect(getByTestId('launch-quick-config').textContent).toMatch(/full options/);
  });

  it('opens the sheet when one IS hosted', () => {
    const onFullOptions = vi.fn();
    const { getByTestId } = render(
      <LaunchQuickConfig
        subject={subject}
        spaceId={FIXTURE_SPACE_ID}
        teammates={TEAMMATES}
        onSpawn={vi.fn()}
        onFullOptions={onFullOptions}
        clientMutationId="m:1"
      />,
    );
    fireEvent.click(getByTestId('launch-full-options'));
    expect(onFullOptions).toHaveBeenCalledTimes(1);
  });
});
