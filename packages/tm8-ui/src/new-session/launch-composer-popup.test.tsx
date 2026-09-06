// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ExecutionSpawnInput, ProjectId } from '@tm8/contract';

import type { LaunchProjectOption } from '../domain/launch';
import { LaunchComposerPopup, type LaunchComposerPopupProps } from './LaunchComposerPopup';

/**
 * The Run popup — the canvas card as a modal tile over an existing task.
 *
 * The load-bearing claims: the payload names THE SUBJECT (taskIds, title), the
 * verb's mode is prop-authoritative, the optional textarea travels as
 * `promptExtra` and ONLY when typed, and a refused launch keeps the popup on
 * screen with the reason instead of closing like a success.
 */

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
  });

  it('typed context travels as promptExtra and a typed title overrides the subject’s', async () => {
    const { getByTestId, getByLabelText, props } = renderPopup();
    fireEvent.change(getByLabelText('Describe what this session should do'), {
      target: { value: 'The CI logs are in #build-failures.' },
    });
    fireEvent.change(getByTestId('nsx-title'), { target: { value: 'Launch flow session' } });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(props.onSpawn).toHaveBeenCalled());
    const input = (props.onSpawn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ExecutionSpawnInput;
    expect(input.promptExtra).toBe('The CI logs are in #build-failures.');
    expect(input.title).toBe('Launch flow session');
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

  it('an edited title renames the task BEFORE the spawn; an untouched one renames nothing', async () => {
    const calls: string[] = [];
    const onRenameSubject = vi.fn(() => { calls.push('rename'); });
    const onSpawn = vi.fn(() => { calls.push('spawn'); });
    const first = renderPopup({ onRenameSubject, onSpawn });
    fireEvent.change(first.getByTestId('nsx-title'), { target: { value: 'Reconnect loop fix' } });
    fireEvent.click(first.getByTestId('nsx-send'));
    await waitFor(() => expect(onSpawn).toHaveBeenCalled());
    expect(onRenameSubject).toHaveBeenCalledWith('Reconnect loop fix');
    expect(calls).toEqual(['rename', 'spawn']);
    expect((onSpawn.mock.calls[0] as unknown[])[0]).toMatchObject({ title: 'Reconnect loop fix' });
    first.unmount();

    const untouched = renderPopup({ onRenameSubject: vi.fn() });
    fireEvent.click(untouched.getByTestId('nsx-send'));
    await waitFor(() => expect(untouched.props.onSpawn).toHaveBeenCalled());
    expect(untouched.props.onRenameSubject).not.toHaveBeenCalled();
  });

  it('a REFUSED rename stops the launch with its reason — the spawn never fires', async () => {
    const onRenameSubject = vi.fn().mockRejectedValue(new Error('version conflict — the task changed'));
    const { getByTestId, getByRole, props } = renderPopup({ onRenameSubject });
    fireEvent.change(getByTestId('nsx-title'), { target: { value: 'Renamed' } });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(getByRole('alert').textContent).toContain('version conflict'));
    expect(props.onSpawn).not.toHaveBeenCalled();
    expect(props.onDismiss).not.toHaveBeenCalled();
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

  it('a REFUSED launch keeps the popup with the node’s reason; only success dismisses', async () => {
    const onSpawn = vi.fn().mockRejectedValue(new Error('no session slots free'));
    const { getByTestId, getByRole, props } = renderPopup({ onSpawn });
    fireEvent.click(getByTestId('nsx-send'));
    await waitFor(() => expect(getByRole('alert').textContent).toContain('no session slots free'));
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it('no dispatcher ⇒ Launch refuses WITH the unwired reason, never enabled-inert', () => {
    const { getByTestId, getByRole } = renderPopup({ onSpawn: undefined });
    expect(getByTestId('nsx-send').getAttribute('aria-disabled')).toBe('true');
    expect(getByRole('alert').textContent).toContain('isn’t connected');
  });
});
