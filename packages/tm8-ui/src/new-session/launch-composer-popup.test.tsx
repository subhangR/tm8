// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ExecutionSpawnInput, ProjectId } from '@tm8/contract';

import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';
import type { LaunchProjectOption } from '../domain/launch';
import { LaunchComposerPopup, type LaunchComposerPopupProps } from './LaunchComposerPopup';

/**
 * The Run popup — the canvas card as a modal tile over an existing task.
 *
 * The load-bearing claims: the payload names THE SUBJECT (taskIds, title), the
 * verb's mode is prop-authoritative, the big textarea is INSTRUCTIONS for this
 * launch (`promptExtra`) while the task's description is edited from the
 * subject chip (autofilled, and a real edit saves back onto the task in one
 * patch with a title edit, BEFORE the spawn), success closes the tile, and a
 * refusal keeps it up with the reason and a shake.
 */

/* Remembered picks live in localStorage, which jsdom keeps across a file's
   tests: every test starts with none. */
beforeEach(() => { localStorage.clear(); });

/** Opens the subject chip's popover and returns the description field. */
function openDescription(view: { getByTestId(id: string): HTMLElement }): HTMLTextAreaElement {
  fireEvent.click(view.getByTestId('lcd-subject'));
  return view.getByTestId('lcd-description') as HTMLTextAreaElement;
}

const TEAMMATES = [
  { id: 'tm-forge', label: 'forge', agentTool: 'claude-code', model: 'claude-sonnet-5' },
  { id: 'tm-scout', label: 'scout', agentTool: 'claude-code', model: 'claude-opus-5' },
];

const PROJECTS: readonly LaunchProjectOption[] = [
  { projectId: 'pj-a' as ProjectId, name: 'tm8-ui', trusted: true },
];

const subject = { id: 'task-9', title: 'Wire the launch flow' };

function renderPopup(over: Partial<LaunchComposerPopupProps> = {}) {
  const props: LaunchComposerPopupProps = {
    subject,
    spaceId: 'sp-1',
    teammates: TEAMMATES,
    projects: PROJECTS,
    onSpawn: vi.fn(),
    onDismiss: vi.fn(),
    clientMutationId: 'm:test',
    ...over,
  };
  return { ...render(<LaunchComposerPopup {...props} />), props };
}

describe('the spawn payload', () => {
  it('commits the subject with the seeded config: first teammate, its model, High effort, Auto posture, worktree', async () => {
    const { getByTestId, props } = renderPopup();
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());
    const input = (props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.taskIds).toEqual(['task-9']);
    expect(input.title).toBe('Wire the launch flow');
    expect(input.teamMemberId).toBe('tm-forge');
    expect(input.model).toBe('claude-sonnet-5');
    expect(input.mode).toBe('worker');
    expect(input.reasoningEffort).toBe('high');
    expect(input.accessMode).toBe('auto');
    expect(input.projectId).toBe('pj-a');
    expect(input.workdir).toEqual({ mode: 'worktree' });
    // Nothing typed ⇒ the field is ABSENT, not empty — untyped context is not
    // an empty statement.
    expect('promptExtra' in input).toBe(false);
    // A SUCCESSFUL launch closes the tile by itself; only a refusal keeps it
    // open (asserted separately below).
    await waitFor(() => expect(props.onDismiss).toHaveBeenCalledTimes(1));
  });

  it('the textarea is INSTRUCTIONS for this launch: it rides as promptExtra and never touches the task', async () => {
    const onSaveSubject = vi.fn();
    const { getByLabelText, getByTestId, props } = renderPopup({
      loadDescription: () => Promise.resolve('Reconnect drops after 30s.'),
      onSaveSubject,
    });
    fireEvent.change(getByLabelText('Instructions for this session'), {
      target: { value: '  Start from latest main.  ' },
    });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());
    const input = (props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.promptExtra).toBe('Start from latest main.');
    expect(onSaveSubject).not.toHaveBeenCalled();
  });

  it('the task’s DESCRIPTION is edited from the subject chip: it saves onto the task in one patch, never as promptExtra', async () => {
    const onSaveSubject = vi.fn();
    const view = renderPopup({
      loadDescription: () => Promise.resolve('Reconnect drops after 30s.'),
      onSaveSubject,
    });
    // Autofilled with the task's real body before any edit.
    const area = openDescription(view);
    await waitFor(() => expect(area.value).toBe('Reconnect drops after 30s.'));

    fireEvent.change(area, { target: { value: 'Reconnect drops after 30s. Logs in #build-failures.' } });
    fireEvent.change(view.getByTestId('nsx-title'), { target: { value: 'Launch flow session' } });
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.props.onSpawn).toHaveBeenCalled());

    // ONE save call carrying both edits — atomic on the wire.
    expect(onSaveSubject).toHaveBeenCalledTimes(1);
    expect(onSaveSubject).toHaveBeenCalledWith({
      title: 'Launch flow session',
      description: 'Reconnect drops after 30s. Logs in #build-failures.',
    });
    const input = (view.props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.title).toBe('Launch flow session');
    // The description travels ON THE TASK, not as a launch side-channel.
    expect('promptExtra' in input).toBe(false);
  });

  it('an untouched autofill saves nothing back', async () => {
    const onSaveSubject = vi.fn();
    const view = renderPopup({
      loadDescription: () => Promise.resolve('Existing body.'),
      onSaveSubject,
    });
    const area = openDescription(view);
    await waitFor(() => expect(area.value).toBe('Existing body.'));
    fireEvent.click(view.getByTestId('nsx-send'));
    await waitFor(() => expect(view.props.onSpawn).toHaveBeenCalled());
    expect(onSaveSubject).not.toHaveBeenCalled();
  });

  it('with no save path the description is read-only, and says why', async () => {
    const view = renderPopup({ loadDescription: () => Promise.resolve('Existing body.') });
    const area = openDescription(view);
    await waitFor(() => expect(area.value).toBe('Existing body.'));
    expect(area.readOnly).toBe(true);
    expect(view.getByTestId('lcd-subject-menu').textContent).toContain('can’t save onto the task');
  });

  it('the verb’s mode is prop-authoritative: Coordinate commits a coordinator', async () => {
    const { getByTestId, props } = renderPopup({ mode: 'coordinator', verbLabel: 'Coordinate' });
    // No chrome above the card (owner ruling 2026-09-07) — the verb survives
    // as the dialog's accessible name.
    expect(getByTestId('launch-quick-config').getAttribute('aria-label')).toBe('Coordinate configuration');
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());
    expect((props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0].mode).toBe('coordinator');
  });
});

describe('the title is the task’s, and a launch persists an edit', () => {
  it('opens holding the task title as a VALUE, not a placeholder', () => {
    const { getByTestId } = renderPopup();
    expect((getByTestId('nsx-title') as HTMLInputElement).value).toBe('Wire the launch flow');
  });

  it('an edited title saves BEFORE the spawn; an untouched one saves nothing', async () => {
    const calls: string[] = [];
    const onSaveSubject = vi.fn(() => { calls.push('save'); });
    const onSpawn = vi.fn(() => { calls.push('spawn'); });
    const first = renderPopup({ onSaveSubject, onSpawn });
    fireEvent.change(first.getByTestId('nsx-title'), { target: { value: 'Reconnect loop fix' } });
    fireEvent.click(first.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    expect(onSaveSubject).toHaveBeenCalledWith({ title: 'Reconnect loop fix' });
    expect(calls).toEqual(['save', 'spawn']);
    expect((onSpawn.mock.calls[0] as unknown[])[0]).toMatchObject({ title: 'Reconnect loop fix' });
    first.unmount();

    const untouched = renderPopup({ onSaveSubject: vi.fn() });
    fireEvent.click(untouched.getByTestId('nsx-send'));
    await waitFor(() => expect(untouched.props.onSpawn).toHaveBeenCalled());
    expect(untouched.props.onSaveSubject).not.toHaveBeenCalled();
  });

  it('a REFUSED save stops the launch with its reason — the spawn never fires', async () => {
    const onSaveSubject = vi.fn()
      .mockRejectedValueOnce(new Error('version conflict — the task changed'))
      .mockResolvedValueOnce(undefined);
    const { getByTestId, getByRole, props } = renderPopup({ onSaveSubject });
    fireEvent.change(getByTestId('nsx-title'), { target: { value: 'Renamed' } });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(getByRole('alert').textContent).toContain('version conflict'));
    expect(props.onSpawn).not.toHaveBeenCalled();
    expect(props.onDismiss).not.toHaveBeenCalled();
    // The reason is a NOTICE, not a block — Launch stays live so the edits
    // can be retried instead of discarded by dismissing the tile.
    expect(getByTestId('nsx-send').getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalledTimes(1));
    expect(onSaveSubject).toHaveBeenCalledTimes(2);
  });
});

describe('dismissal and refusal honesty', () => {
  it('Escape closes an open menu FIRST, and only the next Escape dismisses the popup', () => {
    const { getByTestId, queryByTestId, props } = renderPopup();
    fireEvent.click(getByTestId('nsx-model'));
    expect(getByTestId('nsx-model-menu')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByTestId('nsx-model-menu')).toBeNull();
    expect(props.onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a scrim click dismisses; an empty prompt does NOT withhold Launch (the subject is the prompt)', () => {
    const { container, getByTestId, props } = renderPopup();
    expect(getByTestId('nsx-send').getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(container.querySelector('.nsx-popup__scrim')!);
    expect(props.onDismiss).toHaveBeenCalledTimes(1);
  });

  it('a REFUSED launch keeps the tile up with the reason, and shakes it (owner final ruling 2026-09-07)', async () => {
    const onSpawn = vi.fn()
      .mockRejectedValueOnce(new Error('no session slots free'))
      .mockResolvedValueOnce(undefined);
    const { getByTestId, getByRole, container, props } = renderPopup({ onSpawn });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(getByRole('alert').textContent).toContain('no session slots free'));
    expect(props.onDismiss).not.toHaveBeenCalled();
    // The refusal is FELT: the frame carries the shake for its animation's life.
    expect(container.querySelector('[data-testid="launch-card"]')!.hasAttribute('data-shake')).toBe(true);
    // And it is correctable: Launch stays enabled so a second click retries.
    expect(getByTestId('nsx-send').getAttribute('aria-disabled')).not.toBe('true');
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(props.onDismiss).toHaveBeenCalledTimes(1));
  });

  it('no dispatcher ⇒ Launch refuses WITH the unwired reason, never enabled-inert', () => {
    const { getByTestId, getByRole } = renderPopup({ onSpawn: undefined });
    expect(getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('true');
    expect(getByRole('alert').textContent).toContain('isn’t connected');
  });
});

/**
 * THE MODEL MENU IS THE NODE'S CATALOG, not the selected persona's slice of it.
 *
 * Both of these were live defects in the Run popup until 2026-09-22, and they
 * are opposite failures of the same tool filter: a space with no roster got an
 * EMPTY menu, and a space whose front-row persona runs Claude Code could not
 * reach a single Codex — or, once the cross-provider keys landed, Groq — row.
 */
describe('the model menu', () => {
  const openModelMenu = (over: Partial<LaunchComposerPopupProps> = {}) => {
    const rendered = renderPopup(over);
    fireEvent.click(rendered.getByTestId('nsx-model'));
    return rendered;
  };

  it('offers EVERY catalog model, not only the front-row persona’s tool', () => {
    const { getByTestId } = openModelMenu();
    const menu = getByTestId('nsx-model-menu');
    // The seeded persona is claude-code; a Codex row and a Groq row prove the
    // menu is no longer a function of it.
    expect(menu.textContent).toContain('OpenAI GPT 6 Astra');
    expect(menu.textContent).toContain('GPT-OSS 120B (Groq)');
    expect(menu.textContent).toContain('Kimi K2 Thinking');
    expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(LAUNCH_MODEL_CATALOG.length);
  });

  it('still shows the catalog when the space has NO teammates at all', () => {
    const { getByTestId } = openModelMenu({ teammates: [] });
    const menu = getByTestId('nsx-model-menu');
    expect(menu.textContent).not.toContain('no known models for this agent tool');
    expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(LAUNCH_MODEL_CATALOG.length);
  });

  it('carries the picked model’s OWN tool into the spawn, across the vendor line', async () => {
    // The teammate records claude-code. Picking a Codex model has to move the
    // tool with it, or the node builds `claude --model gpt-6-astra` and the
    // spawn fails at the CLI for a choice the picker offered.
    const { getByTestId, getByText, props } = openModelMenu();
    fireEvent.click(getByText('OpenAI GPT 6 Astra'));
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());
    const input = (props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.model).toBe('gpt-6-astra');
    expect(input.agentTool).toBe('codex');
  });

  it('leaves a persona’s own model on its recorded tool when nothing was picked', async () => {
    const { getByTestId, props } = renderPopup();
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());
    const input = (props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.model).toBe('claude-sonnet-5');
    expect(input.agentTool).toBe('claude-code');
  });
});

/**
 * ▶ ON A SESSION CONTINUES IT (migration 200). The subject is the session being
 * picked up, so neither field edits it: the title names the NEW session and the
 * body is the viewer's instructions for it, carried as `promptExtra`.
 */
describe('a session subject is continued, not edited', () => {
  const session = { id: 'ws-7', title: 'Fix the reconnect loop', kind: 'work_session' };

  it('opens titled "Continue: …", loads no description, and saves nothing back', async () => {
    const onSaveSubject = vi.fn();
    const loadDescription = vi.fn(() => Promise.resolve('never shown'));
    const { getByTestId, getByLabelText, queryByTestId, props } = renderPopup({
      subject: session,
      loadDescription,
      onSaveSubject,
    });
    expect((getByTestId('nsx-title') as HTMLInputElement).value).toBe('Continue: Fix the reconnect loop');
    expect(loadDescription).not.toHaveBeenCalled();
    // The subject chip explains the continuation instead of offering an editor.
    fireEvent.click(getByTestId('lcd-subject'));
    expect(queryByTestId('lcd-description')).toBeNull();
    expect(getByTestId('lcd-subject-menu').textContent).toContain('Nothing here is loaded');

    fireEvent.change(getByTestId('nsx-title'), { target: { value: 'Reconnect, round two' } });
    fireEvent.change(getByLabelText('Instructions for this session'), {
      target: { value: 'Then check the backoff constants.' },
    });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());

    // The session being continued is never renamed or re-described.
    expect(onSaveSubject).not.toHaveBeenCalled();
    const input = (props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.taskIds).toEqual(['ws-7']);
    expect(input.title).toBe('Reconnect, round two');
    expect(input.promptExtra).toBe('Then check the backoff constants.');
  });

  it('with nothing typed, sends the default title and no promptExtra', async () => {
    const { getByTestId, props } = renderPopup({ subject: session });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());
    const input = (props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.title).toBe('Continue: Fix the reconnect loop');
    expect('promptExtra' in input).toBe(false);
  });
});
