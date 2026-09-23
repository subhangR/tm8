// @vitest-environment jsdom
/**
 * ✦ Ask Jev in the Run popup (design 01a0cb80 §3.2, lane U).
 *
 * Same hook and components as LaunchSheet, arranged as a strip and a Review
 * drawer. What must hold here specifically: the button is beside Launch; Jev
 * reads the popup's LIVE title and description, not the saved task; the strip
 * tallies the ticks; Review opens the same checklist; and the spawn carries
 * exactly the ticked `selection` + `jevRunId` — or nothing new without Jev.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ExecutionSpawnInput, LaunchSuggestResult, ProjectId } from '@tm8/contract';

import type { LaunchProjectOption } from '../domain/launch';
import { answeringPort, item, MODEL, okGroup } from '../jev/test-support';
import { LaunchComposerPopup, type LaunchComposerPopupProps } from './LaunchComposerPopup';

const TEAMMATES = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
  { id: 'tm-scout', label: 'scout', agentTool: 'claude-code', model: 'claude-opus-5' },
];
const PROJECTS: readonly LaunchProjectOption[] = [{ projectId: 'pj-a' as ProjectId, name: 'tm8-ui', trusted: true }];

const RANKS = okGroup({
  items: [item('tm-scout', 'team_member', 2.7, true, ['space'], 'scout'), item('tm-forge', 'team_member', 1.1, true, ['space'], 'forge')],
  noFit: false,
});

function renderPopup(over: Partial<LaunchComposerPopupProps> = {}, groups: Partial<LaunchSuggestResult['groups']> = {}) {
  const port = answeringPort({ teammates: RANKS, ...groups });
  const onSpawn = vi.fn<(input: ExecutionSpawnInput) => void>();
  const props: LaunchComposerPopupProps = {
    subject: { id: 'task-9', title: 'Wire the launch flow' },
    spaceId: 'sp-1',
    teammates: TEAMMATES,
    projects: PROJECTS,
    onSpawn,
    onDismiss: vi.fn(),
    clientMutationId: 'm:test',
    loadDescription: () => Promise.resolve('Reconnect drops after 30s.'),
    jev: port,
    ...over,
  };
  const view = render(<LaunchComposerPopup {...props} />);
  const spawn = async () => {
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    return onSpawn.mock.calls.at(-1)![0];
  };
  const ask = async () => {
    await act(async () => { fireEvent.click(view.getByTestId('jev-ask')); });
    await waitFor(() => expect(view.getByTestId('jev-strip')).toBeTruthy());
  };
  return { ...view, port, onSpawn, spawn, ask };
}

describe('the button', () => {
  it('sits beside Launch in the controls row', () => {
    const view = renderPopup();
    const ask = view.getByTestId('jev-ask');
    expect(ask.textContent).toBe('✦ Ask Jev');
    expect(ask.nextElementSibling).toBe(view.getByTestId('nsx-send'));
  });

  it('is refused with the reason when the host wires no Jev port', () => {
    const view = renderPopup({ jev: undefined });
    expect(view.getByTestId('jev-ask').getAttribute('aria-disabled')).toBe('true');
  });
});

describe('the draft is the popup’s live text', () => {
  it('sends the edited title and description, not the saved task', async () => {
    const view = renderPopup();
    const area = view.getByLabelText('Describe what this session should do') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe('Reconnect drops after 30s.'));
    fireEvent.change(area, { target: { value: 'Reconnect drops after 30s. Logs in #build.' } });
    fireEvent.change(view.getByTestId('nsx-title'), { target: { value: 'Fix reconnect' } });
    await view.ask();
    expect(view.port.inputs[0]!.draft).toEqual({ title: 'Fix reconnect', description: 'Reconnect drops after 30s. Logs in #build.' });
    expect(view.port.inputs[0]!.teamMemberId).toBe('tm-forge');
    expect(view.port.inputs[0]!.subjectId).toBe('task-9');
  });

  it('editing after the answer is stale, with Ask again', async () => {
    const view = renderPopup();
    await view.ask();
    fireEvent.change(view.getByTestId('nsx-title'), { target: { value: 'Something else' } });
    expect(view.getByTestId('jev-stale').textContent).toMatch(/Changed since Jev looked/);
    await act(async () => { fireEvent.click(view.getByTestId('jev-ask-again')); });
    expect(view.port.inputs[1]!.draft?.title).toBe('Something else');
  });
});

describe('the strip', () => {
  it('shows the top teammate, the model with Apply, the tallies and the run cost', async () => {
    const view = renderPopup();
    await view.ask();
    const strip = view.getByTestId('jev-strip');
    expect(within(strip).getByTestId('jev-rank-tm-scout').textContent).toContain('scout');
    expect(within(strip).getByTestId('jev-model-apply')).toBeTruthy();
    expect(within(strip).getByTestId('jev-strip-counts').textContent).toContain('Memories 2/3 · Skills 1/2');
    expect(within(strip).getByTestId('jev-run-cost').textContent).toBe('✦ 7 calls · 1.1 s · $0.00021');
  });

  it('a teammate click selects it and re-asks memories and skills in the same run', async () => {
    const view = renderPopup();
    await view.ask();
    fireEvent.click(view.getByTestId('jev-rank-tm-scout'));
    await waitFor(() => expect(view.port.inputs).toHaveLength(2));
    expect(view.port.inputs[1]!.groups).toEqual(['memories', 'skills']);
    expect(view.port.inputs[1]!.runId).toBe(view.port.inputs[0]!.runId);
    const input = await view.spawn();
    expect(input.teamMemberId).toBe('tm-scout');
  });

  it('Apply sets model, tool and effort together', async () => {
    const view = renderPopup({}, { model: okGroup({ ...MODEL, model: 'gpt-5.6-sol', agentTool: 'codex', effort: 'xhigh' }) });
    await view.ask();
    fireEvent.click(view.getByTestId('jev-model-apply'));
    const input = await view.spawn();
    expect(input).toMatchObject({ model: 'gpt-5.6-sol', agentTool: 'codex', reasoningEffort: 'xhigh' });
  });
});

describe('Review', () => {
  it('opens a drawer holding the same checklist for both groups', async () => {
    const view = renderPopup();
    await view.ask();
    expect(view.queryByTestId('jev-review-drawer')).toBeNull();
    fireEvent.click(view.getByTestId('jev-review'));
    const drawer = view.getByTestId('jev-review-drawer');
    expect(within(drawer).getByTestId('jev-checklist-memory')).toBeTruthy();
    expect(within(drawer).getByTestId('jev-checklist-skill')).toBeTruthy();
    expect(within(drawer).getByTestId('jev-memory-count').textContent).toBe('✦ 2 of 3 ticked · exact set');
    // A tick in the drawer moves the strip's tally.
    fireEvent.click(within(drawer).getByTestId('jev-row-mem-c').querySelector('input')!);
    expect(view.getByTestId('jev-strip-counts').textContent).toContain('Memories 3/3');
  });
});

describe('the spawn payload', () => {
  it('carries exactly the ticked selection and the run, and no memoryIds', async () => {
    const view = renderPopup();
    await view.ask();
    fireEvent.click(view.getByTestId('jev-review'));
    fireEvent.click(view.getByTestId('jev-row-sk-a').querySelector('input')!);
    const input = await view.spawn();
    expect(input.selection).toEqual({ memoryIds: ['mem-a', 'mem-b'], skillIds: [] });
    expect(input.jevRunId).toBe(view.port.inputs[0]!.runId);
    expect('memoryIds' in input).toBe(false);
  });

  it('Reset sends no selection, the run still linked', async () => {
    const view = renderPopup();
    await view.ask();
    fireEvent.click(view.getByTestId('jev-review'));
    fireEvent.click(view.getByTestId('jev-drawer-reset'));
    const input = await view.spawn();
    expect('selection' in input).toBe(false);
    expect(input.jevRunId).toBe(view.port.inputs[0]!.runId);
  });

  it('without pressing Ask Jev, the payload is identical to a popup with no Jev', async () => {
    const first = renderPopup();
    const a = await first.spawn();
    first.unmount();
    const b = await renderPopup({ jev: undefined }).spawn();
    expect(a).toEqual(b);
    expect('selection' in a).toBe(false);
    expect('jevRunId' in a).toBe(false);
  });
});
