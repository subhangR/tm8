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
  await waitFor(() => expect(view.getByLabelText('Chat model')).toBeTruthy());
  return view;
}

describe('composer acceptance', () => {
  it('ac_1 · one per-turn row inside the box: no teammate picker, no thread rail under it', async () => {
    const view = await openNewChat(portWith().port);
    const composer = view.container.querySelector('.tch-composer')!;
    expect(within(composer as HTMLElement).getByLabelText('Chat mode')).toBeTruthy();
    expect(within(composer as HTMLElement).getByLabelText('Chat model')).toBeTruthy();
    expect(within(composer as HTMLElement).getByLabelText('Add to this turn')).toBeTruthy();
    expect(view.queryByLabelText('Chat teammate')).toBeNull();
    expect(view.queryByTestId('tch-rail')).toBeNull();
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

  it('ac_8 + ac_10 · crew rows take any model incl. codex; coordinator list says why codex is out', async () => {
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
