// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import type { LaunchTeammate } from '../domain/launch';
import { helpRows } from '../shell/ShortcutsOverlay';
import { LAUNCH_KEYS } from '../keyboard';
import { NewSessionComposer, type NewSessionComposerProps } from './NewSessionComposer';
import { launchActionFor } from './launch-keys';

/**
 * The launch card's keys (task 01a1156f, user ruling "Esc, then a letter"):
 * Esc leaves the prompt FOR THE CARD, one letter reaches each control from
 * there, a keyboard-opened menu takes focus and gives it back, and no letter
 * ever fires while typing.
 */

const TEAMMATES: readonly LaunchTeammate[] = [
  { id: 'tm-forge', name: 'forge', initial: 'F', model: 'claude-sonnet-5', agentTool: 'claude-code', owner: '@ada' },
];

function renderComposer(over: Partial<NewSessionComposerProps> = {}) {
  const props: NewSessionComposerProps = {
    draft: 'Fix the flaky test.',
    onDraftChange: vi.fn(),
    onSubmit: vi.fn(),
    busy: false,
    refusal: null,
    derivedTitle: 'Fix the flaky test',
    title: '',
    onTitleChange: vi.fn(),
    workdirs: [
      { id: 'scratch', name: 'Scratch', detail: '' },
      { id: 'pj-a', name: 'tm8-ui', detail: 'trusted · ~/code/tm8-ui' },
    ],
    workdirId: 'pj-a',
    onPickWorkdir: vi.fn(),
    workdirMode: 'worktree',
    onWorkdirModeChange: vi.fn(),
    workdirChoosable: true,
    teammates: TEAMMATES,
    teammateId: null,
    onPickTeammate: vi.fn(),
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
      { id: 'claude-opus-5', label: 'Claude Opus 5' },
    ],
    model: 'claude-sonnet-5',
    onPickModel: vi.fn(),
    effortStops: ['low', 'medium', 'high', 'max'],
    effort: 'high',
    onEffortChange: vi.fn(),
    accessMode: 'auto',
    onAccessModeChange: vi.fn(),
    credentialProviderLabel: 'Anthropic',
    credential: null,
    onCredentialChange: vi.fn(),
    mode: 'worker',
    onModeChange: vi.fn(),
    ...over,
  };
  const view = render(<NewSessionComposer {...props} />);
  const prompt = view.getByLabelText('Describe what this session should do');
  const card = view.getByTestId('nsx-card');
  /** Esc out of the prompt, the way a user reaches the letters. */
  const toCard = () => {
    prompt.focus();
    fireEvent.keyDown(prompt, { key: 'Escape' });
  };
  return { ...view, props, prompt, card, toCard };
}

describe('Esc leaves the prompt for the card', () => {
  it('moves focus from the prompt to the card and consumes the key', () => {
    const { prompt, card } = renderComposer();
    prompt.focus();
    const passed = fireEvent.keyDown(prompt, { key: 'Escape' });
    expect(passed).toBe(false); // preventDefault: the app shell must not act on it too
    expect(document.activeElement).toBe(card);
  });

  it('does the same from the title field', () => {
    const { getByTestId, card } = renderComposer();
    const title = getByTestId('nsx-title');
    title.focus();
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(document.activeElement).toBe(card);
  });

  it('a second Esc on the full-screen card hands focus back to the page', () => {
    const { card, toCard } = renderComposer();
    toCard();
    fireEvent.keyDown(card, { key: 'Escape' });
    expect(document.activeElement).not.toBe(card);
  });

  it('names the letters under the card only while the card holds focus', () => {
    const { getByTestId, toCard, prompt } = renderComposer();
    prompt.focus();
    expect(getByTestId('nsx-keys').textContent).toContain('Esc');
    toCard();
    expect(getByTestId('nsx-keys').textContent).toContain('model');
  });
});

describe('letters on the card', () => {
  it('never fire while typing in the prompt', () => {
    const { prompt, queryByTestId, props } = renderComposer();
    prompt.focus();
    for (const key of Object.values(LAUNCH_KEYS)) fireEvent.keyDown(prompt, { key });
    expect(queryByTestId('nsx-model-menu')).toBeNull();
    expect(props.onEffortChange).not.toHaveBeenCalled();
    expect(props.onWorkdirModeChange).not.toHaveBeenCalled();
  });

  it(`${LAUNCH_KEYS.model} opens the model menu on the current choice; ↓ moves; a pick gives focus back to the card`, () => {
    const { card, toCard, getByTestId, props } = renderComposer();
    toCard();
    fireEvent.keyDown(card, { key: LAUNCH_KEYS.model });
    const menu = getByTestId('nsx-model-menu');
    expect(document.activeElement?.textContent).toContain('Claude Sonnet 5');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toContain('Claude Opus 5');
    expect(menu.contains(document.activeElement)).toBe(true);
    fireEvent.click(document.activeElement!); // Enter on a focused button is a click
    expect(props.onPickModel).toHaveBeenCalledWith('claude-opus-5');
    expect(document.activeElement).toBe(card);
  });

  it.each([
    [LAUNCH_KEYS.permission, 'nsx-perm-menu'],
    [LAUNCH_KEYS.teammate, 'nsx-team-menu'],
    [LAUNCH_KEYS.workdir, 'nsx-workdir-menu'],
    [LAUNCH_KEYS.options, 'nsx-dots-menu'],
  ])('%s opens %s', (key, menu) => {
    const { card, toCard, getByTestId } = renderComposer();
    toCard();
    fireEvent.keyDown(card, { key });
    expect(getByTestId(menu).contains(document.activeElement)).toBe(true);
  });

  it(`${LAUNCH_KEYS.effort} cycles effort and ${LAUNCH_KEYS.worktree} flips the working copy`, () => {
    const { card, toCard, props } = renderComposer();
    toCard();
    fireEvent.keyDown(card, { key: LAUNCH_KEYS.effort });
    expect(props.onEffortChange).toHaveBeenCalledWith('max');
    fireEvent.keyDown(card, { key: LAUNCH_KEYS.worktree });
    expect(props.onWorkdirModeChange).toHaveBeenCalledWith('project');
  });

  it(`${LAUNCH_KEYS.worktree} does nothing where there is no checkout to choose`, () => {
    const { card, toCard, props } = renderComposer({ workdirChoosable: false });
    toCard();
    fireEvent.keyDown(card, { key: LAUNCH_KEYS.worktree });
    expect(props.onWorkdirModeChange).not.toHaveBeenCalled();
  });

  it(`${LAUNCH_KEYS.prompt} goes back into the prompt`, () => {
    const { card, toCard, prompt } = renderComposer();
    toCard();
    fireEvent.keyDown(card, { key: LAUNCH_KEYS.prompt });
    expect(document.activeElement).toBe(prompt);
  });

  it('Enter on the card launches, and a refused launch stays refused', () => {
    const ok = renderComposer();
    ok.toCard();
    fireEvent.keyDown(ok.card, { key: 'Enter' });
    expect(ok.props.onSubmit).toHaveBeenCalledTimes(1);
    ok.unmount();

    const refused = renderComposer({ refusal: 'No capacity.' });
    refused.toCard();
    fireEvent.keyDown(refused.card, { key: 'Enter' });
    expect(refused.props.onSubmit).not.toHaveBeenCalled();
  });

  it('leaves modified keys alone (Ctrl+M is not m)', () => {
    const { card, toCard, queryByTestId } = renderComposer();
    toCard();
    fireEvent.keyDown(card, { key: LAUNCH_KEYS.model, ctrlKey: true });
    expect(queryByTestId('nsx-model-menu')).toBeNull();
  });
});

describe('one table', () => {
  it('maps each contract letter to its action, and nothing else', () => {
    for (const [action, key] of Object.entries(LAUNCH_KEYS)) expect(launchActionFor(key)).toBe(action);
    expect(launchActionFor('M')).toBeNull();
  });

  it('lists the launch keys in the ? overlay', () => {
    const launch = helpRows('other').find((section) => section.group === 'Launch');
    expect(launch?.rows.map((b) => b.keys)).toEqual(
      expect.arrayContaining(['Esc', ...Object.values(LAUNCH_KEYS), 'Enter']),
    );
  });
});
