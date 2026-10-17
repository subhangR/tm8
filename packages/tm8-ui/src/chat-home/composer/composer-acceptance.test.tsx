// @vitest-environment jsdom
/**
 * THE COMPOSER'S ACCEPTANCE CRITERIA, ONE `it` EACH (task 01a070d7).
 *
 * Screen-level: the real `ChatHomeScreen` over the fixture port, so a test
 * here fails when the wiring fails, not only when a widget does.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from '../ChatHomeScreen';
import { CHAT_HOME_FIXTURE_THREAD, createChatHomeFixturePort } from '../fixtures';
import type { ChatHomePort, ChatModelOption, ChatTeammateOption } from '../types';

const SPACE_ID = '019f0000-0000-7000-8000-000000000090';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
  { model: 'gpt-5.6-sol', label: 'OpenAI GPT 5.6', provider: 'openai', agentTool: 'codex', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { model: 'house-model', label: 'House model', provider: 'custom', agentTool: 'claude-code' },
];
const TEAMMATES: ChatTeammateOption[] = [
  { id: '019f0000-0000-7000-8000-00000000a001' as EntityId, label: 'Builder', mode: 'worker', permissionMode: null },
  { id: '019f0000-0000-7000-8000-00000000a002' as EntityId, label: 'Conductor', mode: 'coordinator', permissionMode: 'acceptEdits' },
  { id: '019f0000-0000-7000-8000-00000000a003' as EntityId, label: 'Fast Fixer', mode: 'worker', permissionMode: 'plan' },
];

function portWith(overrides: Partial<ChatHomePort> = {}) {
  const { port, controls } = createChatHomeFixturePort();
  return { controls, port: { ...port, listTeammates: async () => TEAMMATES, ...overrides } as ChatHomePort };
}

async function openNewChat(port: ChatHomePort, extra: Partial<Parameters<typeof ChatHomeScreen>[0]> = {}) {
  const view = render(<ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} newMutationId={(p) => `${p}:t`} {...extra} />);
  await waitFor(() => expect(view.getByRole('button', { name: /new chat/i })).toBeTruthy());
  fireEvent.click(view.getByRole('button', { name: /new chat/i }));
  await waitFor(() => expect(view.getByLabelText('Chat model')).toBeTruthy());
  return view;
}

const modeOf = (view: ReturnType<typeof render>) =>
  view.getByTestId('tch-settings-role').getAttribute('data-mode');

function pickRole(view: ReturnType<typeof render>, role: 'worker' | 'coordinator' | 'dispatcher') {
  fireEvent.click(view.getByTestId('tch-settings'));
  fireEvent.click(view.getByTestId(`tch-settings-${role}`));
}

/** The toolbar's controls, by accessible name, in DOM order. */
const toolbarOf = (view: ReturnType<typeof render>) =>
  [...view.container.querySelector('.tch-composer')!.querySelectorAll('button[aria-label]')]
    .map((b) => b.getAttribute('aria-label')!);

describe('composer acceptance', () => {
  afterEach(() => localStorage.clear());

  it('ac_1 · one toolbar under the field: [+][⚙ role][👥 N] … [model·effort][send]', async () => {
    const view = await openNewChat(portWith().port);
    expect(toolbarOf(view)).toEqual(['Add to this turn', 'Chat settings', 'Coordinator team', 'Chat model', 'Send']);
    // Teammate, credentials, mode options, project and permissions all live in the ⚙ panel now.
    expect(view.queryByLabelText('Chat teammate')).toBeNull();
    expect(view.queryByLabelText('Chat credentials')).toBeNull();
    expect(view.queryByTestId('tch-rail')).toBeNull();
    fireEvent.click(view.getByTestId('tch-settings'));
    // One row grammar: label, value, › — and no native selects anywhere in the panel.
    for (const id of ['tch-settings-teammate', 'tch-settings-permission', 'tch-credentials']) {
      expect(view.getByTestId(id).getAttribute('aria-haspopup')).toBe('menu');
    }
    // A project this surface cannot change is a read-only row: no submenu.
    expect(view.getByTestId('tch-settings-project-locked').getAttribute('aria-haspopup')).toBeNull();
    expect(view.getByTestId('tch-settings-menu').querySelector('select')).toBeNull();
    // A toggle is a switch.
    expect(view.getByTestId('tch-mode-options-webSearch').getAttribute('role')).toBe('switch');
  });

  it('a settings row opens a submenu that the keyboard drives, and Esc closes only the submenu', async () => {
    const view = await openNewChat(portWith().port);
    fireEvent.click(view.getByTestId('tch-settings'));
    const row = view.getByTestId('tch-settings-permission');
    fireEvent.keyDown(row, { key: 'Enter' });
    const menu = view.getByTestId('tch-settings-permission-menu');
    expect(within(menu).getAllByRole('menuitemradio').map((o) => o.querySelector('.tch-submenu__name')!.textContent))
      .toEqual(['Read-only', 'Ask first', 'Auto']);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    fireEvent.click(view.getByTestId('tch-settings-permission-auto'));
    expect(view.queryByTestId('tch-settings-permission-menu')).toBeNull();
    expect(view.getByTestId('tch-settings-permission-value').textContent).toBe('Auto');
    fireEvent.click(row);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.queryByTestId('tch-settings-permission-menu')).toBeNull();
    expect(view.getByTestId('tch-settings-menu')).toBeTruthy();
  });

  it('ac_2 · the ⚙ offers exactly Worker / Coordinator / Dispatcher, each over its server mode', async () => {
    const view = await openNewChat(portWith().port);
    expect(view.getByTestId('tch-settings-role').textContent).toBe('Coordinator');
    fireEvent.click(view.getByTestId('tch-settings'));
    const roles = within(view.getByRole('radiogroup', { name: 'Chat mode' })).getAllByRole('radio');
    expect(roles.map((r) => r.querySelector('.tch-menu__modename')!.textContent)).toEqual(['Worker', 'Coordinator', 'Dispatcher']);
    expect(view.getByTestId('tch-settings-worker').textContent).toContain('does the work');
    expect(view.getByTestId('tch-settings-worker').getAttribute('title')).toContain('edits files');
    fireEvent.click(view.getByTestId('tch-settings-worker'));
    expect(view.getByTestId('tch-settings-role').textContent).toBe('Worker');
    expect(modeOf(view)).toBe('build');
    pickRole(view, 'dispatcher');
    expect(modeOf(view)).toBe('orchestrate');
    pickRole(view, 'coordinator');
    expect(modeOf(view)).toBe('ask');
  });

  it('ac_3 · effort lives in the model popover and is disabled with a reason where unsupported', async () => {
    const view = await openNewChat(portWith().port);
    expect(view.queryByLabelText('Reasoning effort')).toBeNull();
    fireEvent.click(view.getByLabelText('Chat model'));
    const effort = view.getByTestId('tch-model-effort');
    // A slider over THIS model's stops, with a clickable label per notch.
    expect(within(effort).getAllByRole('button').map((r) => r.textContent)).toEqual(['Low', 'Medium', 'High', 'Max']);
    fireEvent.click(view.getByTestId('tch-model-effort-max'));
    expect(view.getByLabelText('Chat model').textContent).toContain('Max');
    expect(view.getByTestId('tch-model-effort-now').textContent).toBe('Max');
    expect(view.getByTestId('tch-model-effort-hint').textContent).toBe('slowest · most thorough');
    // Arrow keys step notch by notch.
    const thumb = within(effort).getByRole('slider');
    fireEvent.keyDown(thumb, { key: 'ArrowLeft' });
    expect(view.getByTestId('tch-model-effort-now').textContent).toBe('High');
    expect(thumb.getAttribute('aria-valuetext')).toBe('High');
    fireEvent.click(view.getByTestId('tch-model-house-model'));
    expect(view.getByTestId('tch-model-effort').textContent).toContain('does not declare effort stops');
    expect(within(view.getByTestId('tch-model-effort')).queryAllByRole('slider')).toHaveLength(0);
  });

  it('ac_8 + ac_10 · crew rows take any model incl. codex; coordinator list says why codex is out', async () => {
    const { port, controls } = portWith();
    const view = await openNewChat(port);
    pickRole(view, 'dispatcher');
    const crew = await waitFor(() => view.getByTestId('tch-crew'));
    fireEvent.click(within(crew).getByTestId('tch-crew-add'));
    fireEvent.click(within(crew).getByTestId('tch-crew-add'));
    expect(within(crew).getAllByRole('listitem')).toHaveLength(2);

    // ac_8: a worker may run a codex model.
    fireEvent.click(view.getByLabelText('Worker 2 model'));
    const codexRow = view.getByTestId('tch-crew-w2-model-gpt-5.6-sol');
    expect(codexRow.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(codexRow);
    expect(view.getByLabelText('Worker 2 model').textContent).toContain('GPT 5.6');
    fireEvent.click(view.getByTestId('tch-crew-w2-model-effort-xhigh'));

    // ac_10: the coordinator list draws the same model disabled, with the reason.
    fireEvent.keyDown(view.getByLabelText('Worker 2 model'), { key: 'Escape' });
    fireEvent.click(view.getByLabelText('Chat model'));
    expect(view.getByTestId('tch-model-gpt-5.6-sol').getAttribute('aria-disabled')).toBe('true');
    expect(view.getByTestId('tch-model-gpt-5.6-sol').textContent).toContain('Claude Code only');
    fireEvent.keyDown(view.getByLabelText('Chat model'), { key: 'Escape' });

    // The brief is visible before send and rides the opening turn.
    expect(view.getByTestId('tch-crew-brief').textContent).toContain('model gpt-5.6-sol via codex');
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Ship the release.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]!.body).toMatch(/^Ship the release\.\n/);
    expect(controls.roots[0]!.body).toContain('Crew for this thread');
    expect(controls.roots[0]!.body).toContain('effort xhigh');
    expect(controls.roots[0]!.mode).toBe('orchestrate');
  });

  it('ac_12 · only the team chip comes and goes with the role; mode options ride the ⚙ panel', async () => {
    const view = await openNewChat(portWith().port);
    const coordinator = toolbarOf(view);
    pickRole(view, 'worker');
    const worker = toolbarOf(view);
    pickRole(view, 'dispatcher');
    expect(toolbarOf(view)).toEqual(worker);
    expect(coordinator.filter((label) => label !== 'Coordinator team')).toEqual(worker);

    fireEvent.click(view.getByTestId('tch-settings'));
    fireEvent.click(view.getByTestId('tch-mode-options-autonomy'));
    fireEvent.click(view.getByTestId('tch-mode-options-autonomy-auto-dispatch'));
    fireEvent.click(view.getByTestId('tch-mode-options-parallelism'));
    fireEvent.click(view.getByTestId('tch-mode-options-parallelism-6'));
    // Sanity: the policy under the crew panel reflects the ⚙.
    expect(view.getByTestId('tch-crew-policy').textContent).toContain('auto-dispatch');
  });

  it('/build on an empty input selects the mode instead of sending', async () => {
    const { port, controls } = portWith();
    const view = await openNewChat(port);
    const field = view.getByLabelText('Message the chat agent');
    fireEvent.change(field, { target: { value: '/build' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(modeOf(view)).toBe('build');
    expect(view.getByTestId('tch-settings-role').textContent).toBe('Worker');
    expect((field as HTMLTextAreaElement).value).toBe('');
    expect(controls.roots).toHaveLength(0);
  });

  it('the send button is muted while the draft is empty', async () => {
    const view = await openNewChat(portWith().port);
    const send = view.getByRole('button', { name: 'Send' });
    expect(send.getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'hi' } });
    expect(send.getAttribute('aria-disabled')).toBe('false');
  });
});

describe('the Coordinator team chip', () => {
  afterEach(() => localStorage.clear());
  const [BUILDER, CONDUCTOR] = TEAMMATES;

  it('shows 👥 1 by default — the generic worker — and only in Coordinator mode', async () => {
    const view = await openNewChat(portWith().port);
    expect(view.getByTestId('tch-team-count').textContent).toBe('1');
    pickRole(view, 'worker');
    expect(view.queryByTestId('tch-team')).toBeNull();
    pickRole(view, 'dispatcher');
    expect(view.queryByTestId('tch-team')).toBeNull();
    pickRole(view, 'coordinator');
    expect(view.getByTestId('tch-team')).toBeTruthy();
  });

  it('ticked teammates and added models move above the search, count, and ride the turn as a team field', async () => {
    const { port, controls } = portWith({
      listTeammates: async () => TEAMMATES.map((t) => (t.id === CONDUCTOR!.id ? { ...t, model: 'claude-sonnet-5' } : t)),
    });
    const view = await openNewChat(port);
    fireEvent.click(view.getByTestId('tch-team'));
    const picker = view.getByTestId('tch-team-picker');
    const picked = () => picker.querySelector('.tch-teampick__picked')!;
    const list = () => picker.querySelector('.tch-teampick__list')!;
    expect(list().textContent).toContain('Conductor');

    fireEvent.click(view.getByTestId(`tch-team-${CONDUCTOR!.id}`));
    expect(picked().textContent).toContain('Conductor');
    expect(list().textContent).not.toContain('Conductor');
    // A ticked teammate defaults to its own model at Medium.
    expect((view.getByTestId(`tch-team-${CONDUCTOR!.id}-model`) as HTMLSelectElement).value).toBe('claude-sonnet-5');
    expect((view.getByTestId(`tch-team-${CONDUCTOR!.id}-effort`) as HTMLSelectElement).value).toBe('medium');
    fireEvent.change(view.getByTestId(`tch-team-${CONDUCTOR!.id}-effort`), { target: { value: 'high' } });

    fireEvent.click(view.getByTestId('tch-team-add-model'));
    fireEvent.change(view.getByTestId('tch-team-added-0-effort'), { target: { value: 'low' } });
    expect(view.getByTestId('tch-team-count').textContent).toBe('3');
    expect(view.getByTestId('tch-team').getAttribute('title')).toContain('Conductor (Claude Sonnet 5/high)');

    // Unticking moves it back down.
    fireEvent.click(view.getByTestId(`tch-team-${BUILDER!.id}`));
    fireEvent.click(view.getByTestId(`tch-team-${BUILDER!.id}`));
    expect(list().textContent).toContain('Builder');
    expect(view.getByTestId('tch-team-count').textContent).toBe('3');

    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Plan the release.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    // The body is the human's words only; the team rides as a turn field (328).
    expect(controls.roots[0]!.body).toBe('Plan the release.');
    expect(controls.roots[0]!.team).toEqual({ members: [
      { name: 'Worker', model: 'Claude Sonnet 5', effort: 'medium' },
      { name: 'Worker', model: 'Claude Sonnet 5', effort: 'low' },
      { name: 'Conductor', teammateId: CONDUCTOR!.id, model: 'Claude Sonnet 5', effort: 'high' },
    ] });
  });

  it('a default team sends no team field', async () => {
    const { port, controls } = portWith();
    const view = await openNewChat(port);
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Hello.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]!.body).toBe('Hello.');
    expect(controls.roots[0]).not.toHaveProperty('team');
  });

  it('an open chat sends the team on each turn, and never in the body', async () => {
    const { port, controls } = portWith();
    const view = render(
      <ChatHomeScreen port={port} spaceId={SPACE_ID} models={MODELS} routeThreadId={CHAT_HOME_FIXTURE_THREAD.summary.rootId} />,
    );
    await waitFor(() => expect(view.getByTestId('tch-settings-role').getAttribute('data-mode')).toBe('plan'));
    fireEvent.click(view.getByTestId('tch-team'));
    fireEvent.click(view.getByTestId(`tch-team-${BUILDER!.id}`));
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Next step.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.posts).toHaveLength(1));
    expect(controls.posts[0]!.body).toBe('Next step.');
    expect(controls.posts[0]!.team?.members.map((m) => m.name)).toEqual(['Worker', 'Builder']);
  });

  it('the pick persists across a remount', async () => {
    const first = await openNewChat(portWith().port);
    fireEvent.click(first.getByTestId('tch-team'));
    fireEvent.click(first.getByTestId(`tch-team-${BUILDER!.id}`));
    expect(first.getByTestId('tch-team-count').textContent).toBe('2');
    first.unmount();
    const view = await openNewChat(portWith().port);
    expect(view.getByTestId('tch-team-count').textContent).toBe('2');
  });
});
