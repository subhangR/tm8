// @vitest-environment jsdom
/**
 * The Run popup's CONTEXT CHIPS (I9, design 01a0d348 §5.1–5.2) — the same
 * per-group selection the launch sheet holds, as three count chips that each
 * open their group in a popover (owner's pick, I9b form 2026-09-25).
 *
 * What must hold here: the defaults are read for the popup's teammate and
 * subject; an untouched launch carries no `selection` (only why each group
 * kept its defaults); an edited group rides the spawn as its exact set; and
 * in Jev mode Jev's answered groups replace the popup's own, per group.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ExecutionSpawnInput, LaunchSuggestResult, ProjectId } from '@tm8/contract';

import type { LaunchProjectOption } from '../domain/launch';
import { answeringPort, failedGroup } from '../jev/test-support';
import { LAUNCH_DEFAULTS, LAUNCH_REFERENCE_CANDIDATES } from '../views/launch-fixtures';
import { LaunchComposerPopup, type LaunchComposerPopupProps } from './LaunchComposerPopup';

const TEAMMATES = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
];
const PROJECTS: readonly LaunchProjectOption[] = [{ projectId: 'pj-a' as ProjectId, name: 'tm8-ui', trusted: true }];

function renderPopup(over: Partial<LaunchComposerPopupProps> = {}, groups: Partial<LaunchSuggestResult['groups']> = {}) {
  const load = vi.fn(async () => LAUNCH_DEFAULTS);
  const onSpawn = vi.fn<(input: ExecutionSpawnInput) => void>();
  const props: LaunchComposerPopupProps = {
    subject: { id: 'task-9', title: 'Wire the launch flow' },
    spaceId: 'sp-1',
    teammates: TEAMMATES,
    projects: PROJECTS,
    onSpawn,
    onDismiss: vi.fn(),
    clientMutationId: 'm:test',
    jev: answeringPort(groups),
    selection: { load, candidates: { references: LAUNCH_REFERENCE_CANDIDATES } },
    ...over,
  };
  const view = render(<div className="cv2-root"><LaunchComposerPopup {...props} /></div>);
  const spawn = async () => {
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    return onSpawn.mock.calls.at(-1)![0];
  };
  const open = async (group = 'references') => {
    await waitFor(() => expect(view.getByTestId(`lsel-chip-${group}`).textContent).not.toMatch(/…/));
    fireEvent.click(view.getByTestId(`lsel-chip-${group}`));
    await view.findByTestId('lsel-popover');
  };
  return { ...view, load, onSpawn, spawn, open };
}

describe('the Run popup’s context chips', () => {
  it('reads the defaults for the popup’s teammate and subject', async () => {
    const view = renderPopup();
    await waitFor(() => expect(view.load).toHaveBeenCalledWith({ teamMemberId: 'tm-forge', subjectId: 'task-9' }));
  });

  it('shows three count chips, nothing open, none amber', async () => {
    const view = renderPopup();
    await waitFor(() => expect(view.getByTestId('lsel-chip-references').textContent).toMatch(/2 refs/));
    expect(view.getByTestId('lsel-chip-memories').textContent).toMatch(/1 memory/);
    expect(view.getByTestId('lsel-chip-skills').textContent).toMatch(/1 skill/);
    expect(view.container.querySelector('.lsel-chip--edited')).toBeNull();
    expect(view.queryByTestId('lsel-popover')).toBeNull();
  });

  it('an untouched launch sends NO selection — only why each group kept its defaults', async () => {
    const view = renderPopup();
    await waitFor(() => expect(view.load).toHaveBeenCalled());
    const input = await view.spawn();
    expect('selection' in input).toBe(false);
    expect(input.selectionReasons).toEqual({ memories: 'not-asked', skills: 'not-asked', references: 'not-asked' });
  });

  it('a removed default turns its chip amber, and its group rides the spawn as the exact set', async () => {
    const view = renderPopup();
    await view.open();
    fireEvent.click(view.getByTestId('lsel-row-references-ent-doc-spec'));
    const chip = view.getByTestId('lsel-chip-references');
    expect(chip.textContent).toMatch(/1 ref/);
    expect(chip.className).toMatch(/lsel-chip--edited/);
    const input = await view.spawn();
    expect(input.selection).toEqual({ referenceIds: ['ent-file-log'] });
    expect(input.selectionReasons).toEqual({ memories: 'not-asked', skills: 'not-asked' });
  });

  it('an addition from the space joins the defaults', async () => {
    const view = renderPopup();
    await view.open();
    const group = view.getByTestId('lsel-group-references');
    fireEvent.click(within(group).getByRole('button', { name: /add references/ }));
    fireEvent.click(within(group).getByText('Another doc'));
    const input = await view.spawn();
    expect(input.selection).toEqual({ referenceIds: ['ent-doc-spec', 'ent-file-log', 'ent-doc-other'] });
  });

  it('Escape closes the popover and keeps the edit', async () => {
    const view = renderPopup();
    await view.open();
    fireEvent.click(view.getByTestId('lsel-row-references-ent-doc-spec'));
    fireEvent.keyDown(view.getByTestId('lsel-popover'), { key: 'Escape' });
    expect(view.queryByTestId('lsel-popover')).toBeNull();
    expect(view.getByTestId('lsel-chip-references').className).toMatch(/lsel-chip--edited/);
  });

  it('in Jev mode a failed group keeps its defaults as jev-failed while the answered one goes', async () => {
    const view = renderPopup({}, { skills: failedGroup('timeout') });
    await act(async () => { fireEvent.click(view.getByTestId('jev-ask')); });
    await waitFor(() => expect(view.getByTestId('jev-strip')).toBeTruthy());
    // Jev's groups are Jev's: their chips say so and do not open.
    const memories = view.getByTestId('lsel-chip-memories');
    expect(memories.textContent).toMatch(/Jev’s memories/);
    fireEvent.click(memories);
    expect(view.queryByTestId('lsel-popover')).toBeNull();
    const input = await view.spawn();
    expect(input.selection).toEqual({ memoryIds: ['mem-a', 'mem-b'] });
    expect(input.selectionReasons).toEqual({ skills: 'jev-failed', references: 'not-asked' });
  });

  it('without a defaults read, the groups cannot be edited and nothing is selected', async () => {
    const view = renderPopup({ selection: undefined });
    expect(view.getByTestId('lsel-chip-memories').textContent).toMatch(/\? memories/);
    fireEvent.click(view.getByTestId('lsel-chip-memories'));
    expect(view.getAllByText(/didn’t say what this launch loads by default/).length).toBeGreaterThan(0);
    const input = await view.spawn();
    expect('selection' in input).toBe(false);
  });
});
