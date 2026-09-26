// @vitest-environment jsdom
/**
 * ✦ Jev in the Run popup (Jev UX lane D, parent 01a0d77c).
 *
 * The popup mounts the SAME collapsed entry point and panel as LaunchSheet.
 * What must hold here specifically: Jev reads the popup's LIVE title, task
 * description and instructions, not the saved task; nothing reaches the launch without an
 * Apply click; an applied group is an ordinary selection edit (the popup's
 * own chips show it) and Undo takes it back; the model Apply sets model, tool
 * and effort together; and the spawn carries the selection, `jevRunId`, the
 * unapplied groups' reasons and the per-launch `contextBudgets` — or nothing
 * new without Jev.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { ExecutionSpawnInput, LaunchSuggestResult, ModelSuggestion, ProjectId } from '@tm8/contract';

import type { LaunchProjectOption } from '../domain/launch';
import { answeringPort, item, MEMORIES, MODEL, okGroup } from '../jev/test-support';
import { LAUNCH_DEFAULTS } from '../views/launch-fixtures';
import { LaunchComposerPopup, type LaunchComposerPopupProps } from './LaunchComposerPopup';

const TEAMMATES = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
  { id: 'tm-scout', label: 'scout', agentTool: 'claude-code', model: 'claude-opus-5' },
];
const PROJECTS: readonly LaunchProjectOption[] = [{ projectId: 'pj-a' as ProjectId, name: 'tm8-ui', trusted: true }];

/* Jev's memories as NON-defaults of LAUNCH_DEFAULTS (whose one memory default
   is ent-mem-tokens): Apply must ADD the two it ticks beside that default. */
const JEV_MEMORIES = okGroup({
  ...MEMORIES,
  items: [item('mem-a', 'memory', 2.8, true), item('mem-b', 'memory', 1.9, true), item('mem-c', 'memory', 0.3, false)],
});

const RANKS = okGroup({
  items: [item('tm-scout', 'team_member', 2.7, true, ['space'], 'scout'), item('tm-forge', 'team_member', 1.1, true, ['space'], 'forge')],
  noFit: false,
  floor: 1.5,
});

/* Remembered picks are localStorage; each test starts with none. */
beforeEach(() => { localStorage.clear(); });

function renderPopup(over: Partial<LaunchComposerPopupProps> = {}, groups: Partial<LaunchSuggestResult['groups']> = {}) {
  const port = answeringPort({ teammates: RANKS, memories: JEV_MEMORIES, ...groups });
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
    selection: { load: () => Promise.resolve(LAUNCH_DEFAULTS), candidates: {} },
    ...over,
  };
  const view = render(<LaunchComposerPopup {...props} />);
  const spawn = async () => {
    const calls = onSpawn.mock.calls.length;
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn.mock.calls.length).toBe(calls + 1));
    return onSpawn.mock.calls[onSpawn.mock.calls.length - 1]![0];
  };
  /** The entry point's first press asks Jev AND opens the panel. */
  const ask = async () => {
    /* The description autofills first: asking over a half-loaded draft would
       answer a text the popup is about to replace, and read stale. */
    const chip = view.getByTestId('lcd-subject');
    if (chip.getAttribute('aria-expanded') !== 'true') fireEvent.click(chip);
    const area = view.getByTestId('lcd-description') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).not.toBe(''));
    fireEvent.keyDown(document, { key: 'Escape' });
    await act(async () => { fireEvent.click(view.getByTestId('jev-entry-button')); });
    await waitFor(() => expect(view.getByTestId('jev-entry').getAttribute('data-state')).toBe('ready'));
  };
  return { ...view, port, onSpawn, spawn, ask };
}

describe('the entry point', () => {
  it('is one collapsed ✦ button — no strip, no drawer, no second Ask button', () => {
    const view = renderPopup();
    expect(view.getByTestId('jev-entry-badge').textContent).toBe('✦ Ask Jev');
    expect(view.getByTestId('jev-entry-button').getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('jev-panel')).toBeNull();
    expect(view.queryByTestId('jev-ask')).toBeNull();
    expect(view.queryByTestId('jev-strip')).toBeNull();
    expect(view.queryByTestId('jev-review-drawer')).toBeNull();
  });

  it('is refused with the reason when the host wires no Jev port', () => {
    const view = renderPopup({ jev: undefined });
    const button = view.getByTestId('jev-entry-button');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('the first press asks and opens the panel; the badge counts suggestions and applies', async () => {
    const view = renderPopup();
    await view.ask();
    expect(view.port.inputs).toHaveLength(1);
    expect(view.getByTestId('jev-panel')).toBeTruthy();
    expect(view.getByTestId('jev-entry-badge').textContent).toMatch(/suggested · 0 changes applied/);
  });
});

describe('the draft is the popup’s live text', () => {
  it('sends the edited title, description and instructions, not the saved task', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('lcd-subject'));
    const area = view.getByTestId('lcd-description') as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toBe('Reconnect drops after 30s.'));
    fireEvent.change(area, { target: { value: 'Reconnect drops after 30s. Logs in #build.' } });
    fireEvent.change(view.getByTestId('nsx-title'), { target: { value: 'Fix reconnect' } });
    fireEvent.change(view.getByLabelText('Instructions for this session'), { target: { value: 'Start with the backoff.' } });
    await view.ask();
    // The briefing the agent gets: the task as edited, then this launch's instructions.
    expect(view.port.inputs[0]!.draft).toEqual({
      title: 'Fix reconnect',
      description: 'Reconnect drops after 30s. Logs in #build.\n\nStart with the backoff.',
    });
    expect(view.port.inputs[0]!.teamMemberId).toBe('tm-forge');
    expect(view.port.inputs[0]!.subjectId).toBe('task-9');
  });

  it('editing after the answer is stale, with Ask again', async () => {
    const view = renderPopup();
    await view.ask();
    fireEvent.change(view.getByTestId('nsx-title'), { target: { value: 'Something else' } });
    expect(view.getByTestId('jev-panel-stale').textContent).toMatch(/Changed since Jev looked/);
    await act(async () => { fireEvent.click(view.getByTestId('jev-panel-ask-again')); });
    expect(view.port.inputs[1]!.draft?.title).toBe('Something else');
  });
});

describe('Apply is a click, and an ordinary edit', () => {
  it('an answer alone changes nothing the launch sends', async () => {
    const bare = renderPopup({ jev: undefined });
    const plain = await bare.spawn();
    bare.unmount();
    const view = renderPopup();
    await view.ask();
    const input = await view.spawn();
    expect(input.selection).toEqual(plain.selection);
    expect(input.teamMemberId).toBe(plain.teamMemberId);
    expect(input.model).toBe(plain.model);
    // Asked but never applied: the groups launch on their defaults and say why.
    expect(input.jevRunId).toBe(view.port.inputs[0]!.runId);
    expect(input.selectionReasons?.memories).toBeDefined();
  });

  it('applying memories writes Jev’s ticks into the popup’s own selection', async () => {
    const view = renderPopup();
    await view.ask();
    await waitFor(() => expect(view.getByTestId('jev-apply-memories').getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    // The popup's own chip carries the edit: two added beside the one default.
    expect(view.getByTestId('lsel-chip-memories').className).toMatch(/lsel-chip--edited/);
    const input = await view.spawn();
    expect([...(input.selection?.memoryIds ?? [])].sort()).toEqual(['ent-mem-tokens', 'mem-a', 'mem-b']);
  });

  it('Undo takes an applied group back out of the launch', async () => {
    const view = renderPopup();
    await view.ask();
    await waitFor(() => expect(view.getByTestId('jev-apply-memories').getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    fireEvent.click(view.getByTestId('jev-undo-memories'));
    expect(view.getByTestId('lsel-chip-memories').className).not.toMatch(/lsel-chip--edited/);
    const input = await view.spawn();
    expect(input.selection?.memoryIds).toBeUndefined();
    expect(input.selectionReasons?.memories).toBeDefined();
  });

  it('Apply model sets model, tool and effort together', async () => {
    const view = renderPopup({}, { model: okGroup({ ...MODEL, model: 'gpt-5.6-sol', agentTool: 'codex', effort: 'xhigh' }) });
    await view.ask();
    fireEvent.click(view.getByTestId('jev-apply-model'));
    const input = await view.spawn();
    expect(input).toMatchObject({ model: 'gpt-5.6-sol', agentTool: 'codex', reasoningEffort: 'xhigh' });
  });

  it('Apply all that changes the teammate still launches Jev’s model (the teammate re-seed must not undo it)', async () => {
    const view = renderPopup({}, { model: okGroup({ ...MODEL, model: 'gpt-5.6-sol', agentTool: 'codex', effort: 'xhigh' }) });
    await view.ask();
    fireEvent.click(view.getByTestId('jev-apply-all'));
    await waitFor(() => expect(view.getByTestId('jev-undo-all')).toBeTruthy());
    const input = await view.spawn();
    expect(input).toMatchObject({ teamMemberId: 'tm-scout', model: 'gpt-5.6-sol', agentTool: 'codex', reasoningEffort: 'xhigh' });
  });

  it('Apply all, then Undo all, returns the launch to what it was', async () => {
    const bare = renderPopup({ jev: undefined });
    const before = await bare.spawn();
    bare.unmount();
    const view = renderPopup();
    await view.ask();
    await waitFor(() => expect(view.getByTestId('jev-apply-memories').getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(view.getByTestId('jev-apply-all'));
    await waitFor(() => expect(view.getByTestId('jev-undo-all')).toBeTruthy());
    fireEvent.click(view.getByTestId('jev-undo-all'));
    const after = await view.spawn();
    expect(after.selection).toEqual(before.selection);
    expect(after.teamMemberId).toBe(before.teamMemberId);
    expect(after.model).toBe(before.model);
  });
});

/* THE MODEL AND TEAMMATE ENTRIES ARE CURRENT OR THEY SAY SO (coordinator's
   ruling on #828): two Jev Applies compose in either order; a person's own
   teammate pick is not overridden, and the row stops claiming "Applied". */
describe('applied model and teammate stay honest', () => {
  const SOL = okGroup<ModelSuggestion>({ ...MODEL, model: 'gpt-5.6-sol', agentTool: 'codex', effort: 'xhigh' });
  const handPick = (view: ReturnType<typeof renderPopup>, name: string) => {
    fireEvent.click(view.getByTestId('nsx-team'));
    fireEvent.click(within(view.getByTestId('nsx-team-menu')).getByRole('menuitemradio', { name: new RegExp(`^${name}`) }));
  };
  const answered = async () => {
    const view = renderPopup({}, { model: SOL });
    await view.ask();
    return view;
  };

  it('Apply model, then Apply teammate: the launch carries the applied model and both rows say Applied', async () => {
    const view = await answered();
    fireEvent.click(view.getByTestId('jev-apply-model'));
    fireEvent.click(view.getByTestId('jev-apply-teammate'));
    await waitFor(() => expect(view.getByTestId('jev-applied-teammate')).toBeTruthy());
    expect(view.getByTestId('jev-applied-model')).toBeTruthy();
    expect(view.queryByTestId('jev-replaced-model')).toBeNull();
    const input = await view.spawn();
    expect(input).toMatchObject({ teamMemberId: 'tm-scout', model: 'gpt-5.6-sol', agentTool: 'codex', reasoningEffort: 'xhigh' });
  });

  it('Apply model, then a teammate picked BY HAND: that teammate’s default goes out, and the row says it was replaced', async () => {
    const view = await answered();
    fireEvent.click(view.getByTestId('jev-apply-model'));
    handPick(view, 'scout');
    expect(view.getByTestId('jev-replaced-model').textContent).toBe('Applied, then replaced by scout’s default model.');
    expect(view.queryByTestId('jev-applied-model')).toBeNull();
    expect(view.queryByTestId('jev-undo-model')).toBeNull();
    await waitFor(() => expect(view.getByTestId('jev-entry-badge').textContent).toMatch(/0 changes applied/));
    const input = await view.spawn();
    expect(input).toMatchObject({ teamMemberId: 'tm-scout', model: 'claude-opus-5' });
  });

  it('Re-apply on a replaced model restores it, and the row says Applied again', async () => {
    const view = await answered();
    fireEvent.click(view.getByTestId('jev-apply-model'));
    handPick(view, 'scout');
    fireEvent.click(view.getByTestId('jev-reapply-model'));
    expect(view.getByTestId('jev-applied-model')).toBeTruthy();
    await waitFor(() => expect(view.getByTestId('jev-entry-badge').textContent).toMatch(/1 change applied/));
    const input = await view.spawn();
    expect(input).toMatchObject({ teamMemberId: 'tm-scout', model: 'gpt-5.6-sol', agentTool: 'codex', reasoningEffort: 'xhigh' });
  });

  it('an applied teammate changed by hand says so; Re-apply brings Jev’s pick back', async () => {
    const view = await answered();
    fireEvent.click(view.getByTestId('jev-apply-teammate'));
    await waitFor(() => expect(view.getByTestId('jev-applied-teammate')).toBeTruthy());
    handPick(view, 'forge');
    expect(view.getByTestId('jev-replaced-teammate').textContent).toBe('Applied, then changed by hand.');
    expect(view.queryByTestId('jev-undo-teammate')).toBeNull();
    fireEvent.click(view.getByTestId('jev-reapply-teammate'));
    const input = await view.spawn();
    expect(input.teamMemberId).toBe('tm-scout');
  });

  it('Undo all leaves replaced entries alone: the hand-picked teammate and its model survive', async () => {
    const ATLAS = { id: 'tm-atlas', label: 'atlas', agentTool: 'claude-code', model: 'claude-fable-5-1' };
    const view = renderPopup({ teammates: [...TEAMMATES, ATLAS] }, { model: SOL });
    await view.ask();
    fireEvent.click(view.getByTestId('jev-apply-all'));
    await waitFor(() => expect(view.getByTestId('jev-undo-all')).toBeTruthy());
    /* By hand: atlas, whose default is fable-5-1. The teammate Apply's "previous"
       is forge and the model Apply's is forge's sonnet-5, so an Undo that
       ignored the replacement would put forge + sonnet-5 back over the pick. */
    handPick(view, 'atlas');
    expect(view.getByTestId('jev-replaced-model')).toBeTruthy();
    expect(view.getByTestId('jev-replaced-teammate')).toBeTruthy();
    fireEvent.click(view.getByTestId('jev-undo-all'));
    expect(view.getByTestId('jev-replaced-model')).toBeTruthy();
    const input = await view.spawn();
    expect(input).toMatchObject({ teamMemberId: 'tm-atlas', model: 'claude-fable-5-1' });
  });

  it('a group re-ticked by hand after Apply stops counting, says so, and Re-apply restores it', async () => {
    const view = await answered();
    await waitFor(() => expect(view.getByTestId('jev-apply-memories').getAttribute('aria-disabled')).toBeNull());
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    await waitFor(() => expect(view.getByTestId('jev-entry-badge').textContent).toMatch(/2 changes applied/));
    // By hand, in the popup's own Memories group: take mem-a back out.
    fireEvent.click(view.getByTestId('lsel-chip-memories'));
    fireEvent.click(view.getByTestId('lsel-row-memories-mem-a'));
    expect(view.getByTestId('jev-replaced-memories').textContent).toBe('Applied, then changed by hand.');
    expect(view.queryByTestId('jev-undo-memories')).toBeNull();
    expect(view.getByTestId('jev-entry-badge').textContent).toMatch(/1 change applied/);
    expect(view.getByTestId('jev-ledger-memories').textContent).not.toContain('mem-a');
    fireEvent.click(view.getByTestId('jev-reapply-memories'));
    const input = await view.spawn();
    expect([...(input.selection?.memoryIds ?? [])].sort()).toEqual(['ent-mem-tokens', 'mem-a', 'mem-b']);
  });
});

describe('the spawn payload', () => {
  it('without pressing Ask Jev, the payload is identical to a popup with no Jev', async () => {
    const first = renderPopup();
    const a = await first.spawn();
    first.unmount();
    const b = await renderPopup({ jev: undefined }).spawn();
    expect(a).toEqual(b);
    expect('selection' in a).toBe(false);
    expect('jevRunId' in a).toBe(false);
    expect('contextBudgets' in a).toBe(false);
  });
});
