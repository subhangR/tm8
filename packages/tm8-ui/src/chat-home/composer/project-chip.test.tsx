// @vitest-environment jsdom
/**
 * THE PROJECT IS ON THE COMPOSER ROW (task 01a159fa).
 *
 * Bhargav (19 Oct): "projects don't have a working folder". Subhang (20 Oct):
 * "chat already should have the project switcher in the composer in the start
 * state". The project used to be reachable only inside ⚙, so a new chat looked
 * projectless. The chip shows it before the first message, can be changed
 * until the chat starts, is what the chat starts in, and reads the same value
 * as the ⚙ row.
 */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { ChatHomeScreen } from '../ChatHomeScreen';
import { createChatHomeFixturePort } from '../fixtures';
import type { ChatModelOption, ChatProjectOption } from '../types';

const SPACE_ID = '019f0000-0000-7000-8000-0000000000d1';
const MODELS: ChatModelOption[] = [
  { model: 'claude-sonnet-4-5', label: 'Sonnet 4.5', provider: 'Anthropic', agentTool: 'claude-code', efforts: ['low', 'medium', 'high', 'max'] },
];
const PROJECTS: ChatProjectOption[] = [
  { id: 'p-docs' as EntityId, name: 'Docs Site' },
  { id: 'p-api' as EntityId, name: 'API' },
];

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function newChat(projects: readonly ChatProjectOption[] | null = PROJECTS) {
  const { port, controls } = createChatHomeFixturePort();
  const withProjects = projects === null ? port : { ...port, listProjects: async () => projects };
  const view = render(<ChatHomeScreen port={withProjects} spaceId={SPACE_ID} models={MODELS} coldStart="composer" />);
  await waitFor(() => view.getByLabelText('Message the chat agent'));
  return { view, controls };
}

const chipOf = (view: ReturnType<typeof render>) => view.getByTestId('tch-project-value').textContent;

describe('the composer project chip', () => {
  it('is on the row of a new chat before the first message, on Scratch when nothing was picked', async () => {
    const { view } = await newChat();
    expect(view.getByLabelText('Chat project')).toBeTruthy();
    expect(chipOf(view)).toBe('Scratch');
  });

  it('lists Scratch and every project, and the pick is what the chat starts in', async () => {
    const { view, controls } = await newChat();
    fireEvent.click(view.getByLabelText('Chat project'));
    await waitFor(() => view.getByTestId('tch-project-p-api'));
    expect(view.getByTestId('tch-project-__scratch__')).toBeTruthy();
    fireEvent.click(view.getByTestId('tch-project-p-docs'));
    expect(chipOf(view)).toBe('Docs Site');

    /* Still changeable before the chat starts. */
    fireEvent.click(view.getByLabelText('Chat project'));
    fireEvent.click(view.getByTestId('tch-project-p-api'));
    expect(chipOf(view)).toBe('API');

    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'pwd' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({ workdirMode: 'project', projectId: 'p-api' });
  });

  it('reads the same value as the ⚙ panel row', async () => {
    const { view } = await newChat();
    fireEvent.click(view.getByLabelText('Chat project'));
    await waitFor(() => view.getByTestId('tch-project-p-docs'));
    fireEvent.click(view.getByTestId('tch-project-p-docs'));
    fireEvent.click(view.getByTestId('tch-settings'));
    expect(view.getByTestId('tch-settings-project-value').textContent).toBe('Docs Site');
  });

  it('picking Scratch back starts the chat in scratch', async () => {
    const { view, controls } = await newChat();
    fireEvent.click(view.getByLabelText('Chat project'));
    await waitFor(() => view.getByTestId('tch-project-p-docs'));
    fireEvent.click(view.getByTestId('tch-project-p-docs'));
    fireEvent.click(view.getByLabelText('Chat project'));
    fireEvent.click(view.getByTestId('tch-project-__scratch__'));
    expect(chipOf(view)).toBe('Scratch');
    fireEvent.change(view.getByLabelText('Message the chat agent'), { target: { value: 'pwd' } });
    fireEvent.click(view.getByRole('button', { name: /send/i }));
    await waitFor(() => expect(controls.roots).toHaveLength(1));
    expect(controls.roots[0]).toMatchObject({ workdirMode: 'scratch' });
  });

  it('a surface that cannot list projects shows Scratch, refused with the reason', async () => {
    const { view } = await newChat(null);
    const chip = view.getByLabelText('Chat project') as HTMLButtonElement;
    expect(chip.disabled).toBe(true);
    expect(chip.title).toMatch(/cannot list projects/);
    expect(chipOf(view)).toBe('Scratch');
  });
});
