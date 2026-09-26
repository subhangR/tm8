// @vitest-environment jsdom
/**
 * The Run popup's SPAWN PAYLOAD under the v3 card: what a launch sends, what
 * it never writes back, and the model menu's catalog.
 *
 * What must hold: the seeded config goes out (first teammate, its model, High
 * effort, NO access posture unless changed, worktree); the task is never
 * written onto — no title or description patch exists any more; the verb's
 * mode is the opening verb's; the model menu offers the whole catalog and a
 * pick carries its own tool; a session subject is continued, read-only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, waitFor } from '@testing-library/react';
import { LAUNCH_MODEL_CATALOG } from '@tm8/contract';

import { renderPopup } from './launch-test-kit';

beforeEach(() => { localStorage.clear(); });

describe('the spawn payload', () => {
  it('commits the subject with the seeded config, and closes on success', async () => {
    const view = renderPopup();
    const input = await view.spawn();
    expect(input.taskIds).toEqual(['task-9']);
    expect(input.title).toBe('Wire the launch flow');
    expect(input.teamMemberId).toBe('tm-forge');
    expect(input.model).toBe('claude-sonnet-5');
    expect(input.mode).toBe('worker');
    expect(input.reasoningEffort).toBe('high');
    expect(input.accessMode).toBeUndefined();
    expect(input.projectId).toBe('pj-a');
    expect(input.workdir).toEqual({ mode: 'worktree' });
    expect('promptExtra' in input).toBe(false);
    await waitFor(() => expect(view.onDismiss).toHaveBeenCalledTimes(1));
  });

  it('a changed access posture is sent', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-perm'));
    fireEvent.click(view.getByRole('menuitemradio', { name: /^Full access/ }));
    expect((await view.spawn()).accessMode).toBe('fullAccess');
  });

  it('opening on Coordinate commits a coordinator', async () => {
    const view = renderPopup({ mode: 'coordinator', verbLabel: 'Coordinate' });
    expect((await view.spawn()).mode).toBe('coordinator');
  });

  it('no spawn path ⇒ Launch refuses WITH the unwired reason, never enabled-inert', () => {
    const view = renderPopup({ onSpawn: undefined });
    const go = view.getByTestId('nsx-send');
    expect(go.getAttribute('aria-disabled')).toBe('true');
    expect(go.getAttribute('title')).toMatch(/isn’t connected/);
    fireEvent.click(go);
    expect(view.queryByTestId('lcd3-preview')).toBeNull();
  });

  it('a scrim click dismisses', () => {
    const view = renderPopup();
    fireEvent.click(view.container.querySelector('.nsx-popup__scrim')!);
    expect(view.onDismiss).toHaveBeenCalled();
  });
});

describe('the model menu', () => {
  it('offers EVERY catalog model, not only the persona’s tool', () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-model'));
    const menu = view.getByTestId('nsx-model-menu');
    expect(menu.textContent).toContain('OpenAI GPT 6 Astra');
    expect(menu.querySelectorAll('[role="menuitemradio"]')).toHaveLength(LAUNCH_MODEL_CATALOG.length);
  });

  it('carries the picked model’s OWN tool into the spawn, across the vendor line', async () => {
    const view = renderPopup();
    fireEvent.click(view.getByTestId('nsx-model'));
    fireEvent.click(view.getByText('OpenAI GPT 6 Astra'));
    const input = await view.spawn();
    expect(input.model).toBe('gpt-6-astra');
    expect(input.agentTool).toBe('codex');
  });
});

describe('a session subject is continued, not edited', () => {
  const session = { id: 'ws-7', title: 'Fix the reconnect loop', kind: 'work_session' };

  it('reads nothing from it, offers no edit, and sends the notes for the new session', async () => {
    const loadDescription = vi.fn(() => Promise.resolve('never shown'));
    const view = renderPopup({ subject: session, loadDescription, canEditSubject: true });
    expect(loadDescription).not.toHaveBeenCalled();
    fireEvent.click(view.getByTestId('lcd3-subject'));
    expect(view.getByTestId('lcd3-subject-peek').textContent).toContain('Nothing here is loaded');
    expect(view.queryByTestId('lcd3-edit-subject')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.change(view.getByTestId('lcd3-notes'), { target: { value: 'Then check the backoff constants.' } });
    const input = await view.spawn();
    expect(input.taskIds).toEqual(['ws-7']);
    expect(input.title).toBe('Continue: Fix the reconnect loop');
    expect(input.promptExtra).toBe('Then check the backoff constants.');
  });
});
