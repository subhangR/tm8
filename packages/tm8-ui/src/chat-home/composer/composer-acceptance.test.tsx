// @vitest-environment jsdom
/**
 * THE COMPOSER'S ACCEPTANCE CRITERIA, ONE `it` EACH (task 01a070d7).
 *
 * Screen-level: the real `ChatHomeScreen` over the fixture port, so a test
 * here fails when the wiring fails, not only when a widget does.
 */
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from '../ChatHomeScreen';
import { createChatHomeFixturePort } from '../fixtures';
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
  await waitFor(() => expect(view.getByLabelText('Chat teammate')).toBeTruthy());
  return view;
}

describe('composer acceptance', () => {
  it('ac_1 · per-turn row inside the box, thread rail under it, at different weights', async () => {
    const view = await openNewChat(portWith().port);
    const composer = view.container.querySelector('.tch-composer')!;
    expect(within(composer as HTMLElement).getByLabelText('Chat mode')).toBeTruthy();
    expect(within(composer as HTMLElement).getByLabelText('Chat teammate')).toBeTruthy();
    expect(within(composer as HTMLElement).getByLabelText('Chat model')).toBeTruthy();
    expect(within(composer as HTMLElement).getByLabelText('Add to this turn')).toBeTruthy();
    const rail = view.getByTestId('tch-rail');
    expect(composer.contains(rail)).toBe(false);
    expect(within(rail).getByLabelText('Project').closest('.tch-pick')?.classList.contains('tch-pick--quiet')).toBe(true);
    expect(within(rail).getByLabelText('Permissions').closest('.tch-pick')?.classList.contains('tch-pick--quiet')).toBe(true);
    expect(rail.textContent).toContain('where changes land');
    expect(rail.textContent).toContain('how far without asking');
  });

  it('ac_2 · the mode menu is Read / Shape / Act with consequence captions, Act emphasised', async () => {
    const view = await openNewChat(portWith().port);
    fireEvent.click(view.getByLabelText('Chat mode'));
    const menu = view.getByTestId('tch-mode-menu');
    const groups = [...menu.querySelectorAll('.tch-pickmenu__group')].map((el) => el.textContent);
    expect(groups).toEqual(['Read', 'Shape', 'Act']);
    expect(menu.querySelector('.tch-pickmenu__group[data-emphasis]')?.textContent).toBe('Act');
    expect(view.getByTestId('tch-mode-build').textContent).toContain('edits files and the graph for real');
    expect(view.getByTestId('tch-mode-ask').textContent).toContain('changes nothing');
  });

  it('ac_3 · effort lives in the model popover and is disabled with a reason where unsupported', async () => {
    const view = await openNewChat(portWith().port);
    expect(view.queryByLabelText('Reasoning effort')).toBeNull();
    fireEvent.click(view.getByLabelText('Chat model'));
    const effort = view.getByTestId('tch-model-effort');
    expect(within(effort).getAllByRole('radio').map((r) => r.textContent)).toEqual(['fast', 'balanced', 'deep', 'max']);
    fireEvent.click(view.getByTestId('tch-model-effort-max'));
    expect(view.getByLabelText('Chat model').textContent).toContain('max');
    fireEvent.click(view.getByTestId('tch-model-house-model'));
    expect(view.getByTestId('tch-model-effort').textContent).toContain('does not declare effort stops');
    expect(within(view.getByTestId('tch-model-effort')).queryAllByRole('radio')).toHaveLength(0);
  });

  it('ac_4 · project is offered only in the empty state, sends without it, and locks after', async () => {
    const { port, controls } = portWith({
      listProjects: async () => [{ id: '019f0000-0000-7000-8000-00000000b001' as EntityId, name: 'tm8-web' }],
    });
    const view = await openNewChat(port);
    fireEvent.click(view.getByLabelText('Project'));
    expect(view.getByTestId('tch-rail-project-menu').textContent).toContain('tm8-web');
    fireEvent.keyDown(view.getByLabelText('Project'), { key: 'Escape' });
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'hello' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({ workdirMode: 'scratch' });
    expect(controls.roots[0]).not.toHaveProperty('projectId');
    await waitFor(() => expect(view.getByTestId('tch-rail-project-locked')).toBeTruthy());
    expect(view.queryByLabelText('Project')).toBeNull();
    // ac_5 · permissions stays live on the configured thread.
    expect((view.getByLabelText('Permissions') as HTMLButtonElement).disabled).toBe(false);
  });

  it('ac_4b · a chosen project is sent as the write-once binding', async () => {
    const { port, controls } = portWith({
      listProjects: async () => [{ id: '019f0000-0000-7000-8000-00000000b001' as EntityId, name: 'tm8-web' }],
    });
    const view = await openNewChat(port);
    await waitFor(() => { fireEvent.click(view.getByLabelText('Project')); expect(view.getByTestId('tch-rail-project-019f0000-0000-7000-8000-00000000b001')).toBeTruthy(); });
    fireEvent.click(view.getByTestId('tch-rail-project-019f0000-0000-7000-8000-00000000b001'));
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'hello' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({ workdirMode: 'project', projectId: '019f0000-0000-7000-8000-00000000b001' });
  });

  it('ac_6 · BUILD under Read-only is surfaced between composer and rail with a one-click raise', async () => {
    const view = await openNewChat(portWith().port);
    fireEvent.click(view.getByLabelText('Permissions'));
    fireEvent.click(view.getByTestId('tch-rail-permission-read-only'));
    expect(view.queryByTestId('tch-rail-conflict')).toBeNull();
    fireEvent.click(view.getByLabelText('Chat mode'));
    fireEvent.click(view.getByTestId('tch-mode-build'));
    const strip = view.getByTestId('tch-rail-conflict');
    expect(strip.textContent).toContain('Read-only');
    // Physically in the gap: inside the rail element, before its row.
    expect(view.getByTestId('tch-rail').firstElementChild).toBe(strip);
    fireEvent.click(view.getByTestId('tch-rail-raise'));
    expect(view.queryByTestId('tch-rail-conflict')).toBeNull();
    expect(view.getByLabelText('Permissions').textContent).toContain('Ask first');
  });

  it('ac_7 · orchestrate filters to coordinators and preselects one; degrades to everyone with a note', async () => {
    const view = await openNewChat(portWith().port);
    fireEvent.click(view.getByLabelText('Chat mode'));
    fireEvent.click(view.getByTestId('tch-mode-orchestrate'));
    await waitFor(() => expect(view.getByLabelText('Chat teammate').textContent).toContain('Conductor'));
    fireEvent.click(view.getByLabelText('Chat teammate'));
    const rows = within(view.getByTestId('tch-teammate-menu')).getAllByRole('option');
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining('Conductor')]);
    view.unmount();

    const noCoordinators = portWith({ listTeammates: async () => TEAMMATES.filter((t) => t.mode !== 'coordinator') }).port;
    const view2 = await openNewChat(noCoordinators);
    fireEvent.click(view2.getByLabelText('Chat mode'));
    fireEvent.click(view2.getByTestId('tch-mode-orchestrate'));
    fireEvent.click(view2.getByLabelText('Chat teammate'));
    const menu = view2.getByTestId('tch-teammate-menu');
    expect(within(menu).getAllByRole('option')).toHaveLength(2);
    expect(menu.textContent).toContain('No coordinator teammate exists');
  });

  it('ac_8 + ac_9 + ac_10 · crew rows take any model incl. codex; worker access is capped; coordinator list says why codex is out', async () => {
    const { port, controls } = portWith();
    const view = await openNewChat(port);
    fireEvent.click(view.getByLabelText('Chat mode'));
    fireEvent.click(view.getByTestId('tch-mode-orchestrate'));
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

    // ac_9: under Ask first, Auto is not selectable for a worker; a stale pick is capped in the brief.
    // (Conductor's own permission_mode is acceptEdits, so the derived ceiling was Auto — lower it first.)
    expect(view.getByLabelText('Permissions').textContent).toContain('Auto');
    fireEvent.click(view.getByLabelText('Permissions'));
    fireEvent.click(view.getByTestId('tch-rail-permission-ask-first'));
    fireEvent.click(view.getByLabelText('Worker 1 options'));
    const access = view.getByTestId('tch-crew-w1-access') as HTMLSelectElement;
    const auto = [...access.options].find((o) => o.value === 'acceptEdits')!;
    expect(auto.disabled).toBe(true);
    expect(auto.textContent).toContain('ceiling');
    fireEvent.change(access, { target: { value: 'plan' } });
    fireEvent.keyDown(view.getByLabelText('Worker 1 options'), { key: 'Escape' });

    // The brief is visible before send and rides the opening turn.
    expect(view.getByTestId('tch-crew-brief').textContent).toContain('accessMode plan');
    expect(view.getByTestId('tch-crew-brief').textContent).toContain('model gpt-5.6-sol via codex');
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'Ship the release.' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]!.body).toMatch(/^Ship the release\.\n/);
    expect(controls.roots[0]!.body).toContain('Crew for this thread');
    expect(controls.roots[0]!.body).toContain('effort xhigh');
    expect(controls.roots[0]!.mode).toBe('orchestrate');
  });

  it('ac_11 · a node that projects no teammate role gets an unfiltered roster and says so', async () => {
    const port = portWith({ listTeammates: async () => TEAMMATES.map(({ id, label }) => ({ id, label })) }).port;
    const view = await openNewChat(port);
    fireEvent.click(view.getByLabelText('Chat mode'));
    fireEvent.click(view.getByTestId('tch-mode-orchestrate'));
    fireEvent.click(view.getByLabelText('Chat teammate'));
    const menu = view.getByTestId('tch-teammate-menu');
    expect(within(menu).getAllByRole('option')).toHaveLength(3);
    expect(menu.textContent).toContain('does not project teammate roles');
  });

  it('ac_12 · the row’s controls are the same set in every mode; ⚙ badges the non-default count', async () => {
    const view = await openNewChat(portWith().port);
    const controlsOf = () =>
      [...view.container.querySelector('.tch-composer')!.querySelectorAll('button[aria-label]')]
        .map((b) => b.getAttribute('aria-label')!.replace(/^(ask|explain|plan|craft|build|orchestrate) options$/, '⚙'))
        .sort();
    const before = controlsOf();
    expect(before).toContain('⚙');
    for (const mode of ['explain', 'plan', 'craft', 'build', 'orchestrate']) {
      fireEvent.click(view.getByLabelText('Chat mode'));
      fireEvent.click(view.getByTestId(`tch-mode-${mode}`));
      expect(controlsOf()).toEqual(before);
    }
    expect(view.queryByTestId('tch-mode-options-badge')).toBeNull();
    fireEvent.click(view.getByLabelText('orchestrate options'));
    fireEvent.change(view.getByTestId('tch-mode-options-autonomy'), { target: { value: 'auto-dispatch' } });
    fireEvent.change(view.getByTestId('tch-mode-options-parallelism'), { target: { value: '6' } });
    expect(view.getByTestId('tch-mode-options-badge').textContent).toBe('2');
    // Sanity: the policy under the crew panel reflects the ⚙.
    expect(view.getByTestId('tch-crew-policy').textContent).toContain('auto-dispatch');
  });

  it('the teammate’s standing permission sets the default rung and says so', async () => {
    const view = await openNewChat(portWith().port);
    fireEvent.click(view.getByLabelText('Chat teammate'));
    fireEvent.click(view.getByTestId('tch-teammate-019f0000-0000-7000-8000-00000000a003'));
    expect(view.getByLabelText('Permissions').textContent).toContain('Read-only');
    fireEvent.click(view.getByLabelText('Permissions'));
    expect(view.getByTestId('tch-rail-permission-menu').textContent).toContain('Fast Fixer defaults to Read-only');
  });

  it('/build on an empty input selects the mode instead of sending', async () => {
    const { port, controls } = portWith();
    const view = await openNewChat(port);
    const field = view.getByLabelText('Message the chat agent');
    fireEvent.change(field, { target: { value: '/build' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(view.getByLabelText('Chat mode').textContent).toContain('build');
    expect((field as HTMLTextAreaElement).value).toBe('');
    expect(controls.roots).toHaveLength(0);
  });
});
