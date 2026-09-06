// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';

import type { LaunchTeammate } from '../domain/launch';
import { NewSessionComposer, type NewSessionComposerProps } from './NewSessionComposer';

/**
 * The Launch Session Composer (design import, 2026-09-06).
 *
 * The load-bearing claims: every config control STATES its current value on
 * the card, every menu pick leaves through its callback, and every refusal is
 * a refusal WITH A REASON — an untrusted project, a scratch working copy, an
 * effort dial on a model with no stops. Each honesty test asserts both halves
 * where it can, or it is only measuring that some string exists.
 */

const TEAMMATES: readonly LaunchTeammate[] = [
  { id: 'tm-forge', name: 'forge', initial: 'F', model: 'claude-sonnet-5', agentTool: 'claude-code', owner: '@ada' },
  { id: 'tm-scout', name: 'scout', initial: 'S', model: 'claude-opus-5', agentTool: 'claude-code', owner: '@ada' },
];

const WORKDIRS = [
  { id: 'scratch', name: 'Scratch', detail: 'No project — a server-managed temporary directory.' },
  { id: 'pj-a', name: 'tm8-ui', detail: 'trusted · ~/code/tm8-ui' },
  {
    id: 'pj-b',
    name: 'vendor-import',
    detail: '',
    disabledReason: "untrusted — can't host sessions · trust it in Node settings",
  },
] as const;

const MODELS = [
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'claude-opus-5', label: 'Claude Opus 5' },
] as const;

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
    workdirs: WORKDIRS,
    workdirId: 'pj-a',
    onPickWorkdir: vi.fn(),
    workdirMode: 'worktree',
    onWorkdirModeChange: vi.fn(),
    workdirChoosable: true,
    teammates: TEAMMATES,
    teammateId: null,
    onPickTeammate: vi.fn(),
    models: MODELS,
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
  return { ...render(<NewSessionComposer {...props} />), props };
}

describe('the working-directory picker', () => {
  it('names the selected directory on the card and lists scratch plus every project', () => {
    const { getByTestId } = renderComposer();
    expect(getByTestId('nsx-workdir').textContent).toContain('tm8-ui');
    fireEvent.click(getByTestId('nsx-workdir'));
    const menu = getByTestId('nsx-workdir-menu');
    expect(within(menu).getByText('Scratch')).toBeTruthy();
    expect(within(menu).getByText('tm8-ui')).toBeTruthy();
    expect(within(menu).getByText('vendor-import')).toBeTruthy();
    // The path is visible BEFORE the pick — a directory chosen blind is a
    // launch into somewhere the viewer never saw.
    expect(within(menu).getByText('trusted · ~/code/tm8-ui')).toBeTruthy();
  });

  it('a pick leaves through the callback and closes the menu; an untrusted row refuses WITH its reason', () => {
    const { getByTestId, queryByTestId, props } = renderComposer();
    fireEvent.click(getByTestId('nsx-workdir'));
    const menu = getByTestId('nsx-workdir-menu');

    const untrusted = within(menu).getByText('vendor-import').closest('button')!;
    expect(untrusted.getAttribute('aria-disabled')).toBe('true');
    expect(untrusted.title).toContain('untrusted');
    fireEvent.click(untrusted);
    expect(props.onPickWorkdir).not.toHaveBeenCalled();

    fireEvent.click(within(menu).getByText('Scratch'));
    expect(props.onPickWorkdir).toHaveBeenCalledWith('scratch');
    expect(queryByTestId('nsx-workdir-menu')).toBeNull();
  });
});

describe('the working-copy toggle beside the directory', () => {
  it('names the current choice and one click switches worktree ⇄ current branch', () => {
    const { getByTestId, props } = renderComposer();
    const copy = getByTestId('nsx-copy');
    expect(copy.textContent).toContain('Worktree');
    fireEvent.click(copy);
    expect(props.onWorkdirModeChange).toHaveBeenCalledWith('project');
  });

  it('refuses on a scratch target — with the checkout reason, not a bare disable', () => {
    const { getByTestId, props } = renderComposer({ workdirChoosable: false });
    const copy = getByTestId('nsx-copy');
    expect(copy.getAttribute('aria-disabled')).toBe('true');
    expect(copy.title).toContain('no project checkout');
    fireEvent.click(copy);
    expect(props.onWorkdirModeChange).not.toHaveBeenCalled();
  });
});

describe('the ··· menu', () => {
  it('carries credential and session mode, each stating its current value', () => {
    const { getByTestId } = renderComposer();
    fireEvent.click(getByTestId('nsx-dots'));
    expect(getByTestId('nsx-credential-row').textContent).toContain('Anthropic credential');
    expect(getByTestId('nsx-credential-row').textContent).toContain('Auto');
    expect(getByTestId('nsx-mode-row').textContent).toContain('Worker');
  });

  it('a credential pick leaves through the callback', () => {
    const { getByTestId, getByTitle, props } = renderComposer();
    fireEvent.click(getByTestId('nsx-dots'));
    fireEvent.click(getByTestId('nsx-credential-row'));
    fireEvent.click(getByTitle('My credential · refuse if this provider is not connected'));
    expect(props.onCredentialChange).toHaveBeenCalledWith('member');
  });

  it('a session-mode pick offers worker and coordinator, in the domain vocabulary', () => {
    const { getByTestId, getByText, props } = renderComposer();
    fireEvent.click(getByTestId('nsx-dots'));
    fireEvent.click(getByTestId('nsx-mode-row'));
    fireEvent.click(getByText('Coordinator'));
    expect(props.onModeChange).toHaveBeenCalledWith('coordinator');
  });

  it('a tool with no personal credential provider refuses the credential row with that reason', () => {
    const { getByTestId, props } = renderComposer({ credentialProviderLabel: null });
    fireEvent.click(getByTestId('nsx-dots'));
    const row = getByTestId('nsx-credential-row');
    expect(row.getAttribute('aria-disabled')).toBe('true');
    expect(row.title).toContain('no personal credential provider');
    fireEvent.click(row);
    expect(props.onCredentialChange).not.toHaveBeenCalled();
  });
});

describe('the footer knobs', () => {
  it('the model button names the current model and a pick leaves through the callback', () => {
    const { getByTestId, props } = renderComposer();
    expect(getByTestId('nsx-model').textContent).toContain('Claude Sonnet 5');
    fireEvent.click(getByTestId('nsx-model'));
    fireEvent.click(within(getByTestId('nsx-model-menu')).getByText('Claude Opus 5'));
    expect(props.onPickModel).toHaveBeenCalledWith('claude-opus-5');
  });

  it('the effort dial cycles through the model’s own stops and wraps', () => {
    // Seeded at High — the owner's ruling (2026-09-07): the dial always names
    // a real stop, never an unpinned "Default".
    const seeded = renderComposer();
    expect(seeded.getByTestId('nsx-effort').textContent).toContain('High');
    fireEvent.click(seeded.getByTestId('nsx-effort'));
    expect(seeded.props.onEffortChange).toHaveBeenCalledWith('max');
    seeded.unmount();

    const last = renderComposer({ effort: 'max' });
    expect(last.getByTestId('nsx-effort').textContent).toContain('Max');
    fireEvent.click(last.getByTestId('nsx-effort'));
    // Past the top stop it wraps to the first — always a real stop.
    expect(last.props.onEffortChange).toHaveBeenCalledWith('low');
  });

  it('a model with no effort stops disables the dial WITH the reason', () => {
    const { getByTestId, props } = renderComposer({ effortStops: [] });
    const dial = getByTestId('nsx-effort');
    expect(dial.getAttribute('aria-disabled')).toBe('true');
    expect(dial.title).toContain('no reasoning-effort setting');
    fireEvent.click(dial);
    expect(props.onEffortChange).not.toHaveBeenCalled();
  });

  it('the permission menu offers the three postures in the domain’s words', () => {
    const { getByTestId, props } = renderComposer();
    expect(getByTestId('nsx-perm').textContent).toContain('Auto');
    fireEvent.click(getByTestId('nsx-perm'));
    const menu = getByTestId('nsx-perm-menu');
    expect(within(menu).getByText('Auto')).toBeTruthy();
    expect(within(menu).getByText('Safe')).toBeTruthy();
    fireEvent.click(within(menu).getByText('Bypass'));
    expect(props.onAccessModeChange).toHaveBeenCalledWith('fullAccess');
  });

  it('Auto teammate is named, not anonymous: the row says who it currently resolves to', () => {
    const { getByTestId, props } = renderComposer();
    // Auto selected ⇒ the chip carries the role word, not a persona it did not pin.
    expect(getByTestId('nsx-team').textContent).toContain('Teammate');
    fireEvent.click(getByTestId('nsx-team'));
    const menu = getByTestId('nsx-team-menu');
    expect(within(menu).getByText('pick for me · currently forge')).toBeTruthy();
    expect(within(menu).getByText('claude-opus-5 · claude-code · owned by @ada')).toBeTruthy();
    fireEvent.click(within(menu).getByText('scout'));
    expect(props.onPickTeammate).toHaveBeenCalledWith('tm-scout');
  });
});

describe('the title and the commit', () => {
  it('the derived name is the title placeholder, and typing overrides through the callback', () => {
    const { getByTestId, props } = renderComposer();
    const input = getByTestId('nsx-title') as HTMLInputElement;
    expect(input.placeholder).toBe('Fix the flaky test');
    fireEvent.change(input, { target: { value: 'Flaky test hunt' } });
    expect(props.onTitleChange).toHaveBeenCalledWith('Flaky test hunt');
  });

  it('an empty prompt withholds Launch; a refusal blocks WITH its reason on screen', () => {
    const empty = renderComposer({ draft: '', derivedTitle: '' });
    const send = empty.getByTestId('nsx-send');
    expect(send.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(send);
    expect(empty.props.onSubmit).not.toHaveBeenCalled();
    empty.unmount();

    const refused = renderComposer({ refusal: 'No session slots free.' });
    expect(refused.getByRole('alert').textContent).toContain('No session slots free.');
    fireEvent.click(refused.getByTestId('nsx-send'));
    expect(refused.props.onSubmit).not.toHaveBeenCalled();
  });

  it('a ready prompt launches from the button and from Enter, but never mid-IME', () => {
    const { getByTestId, getByLabelText, props } = renderComposer();
    fireEvent.click(getByTestId('nsx-send'));
    expect(props.onSubmit).toHaveBeenCalledTimes(1);

    const area = getByLabelText('Describe what this session should do');
    fireEvent.keyDown(area, { key: 'Enter' });
    expect(props.onSubmit).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(area, { key: 'Enter', isComposing: true });
    expect(props.onSubmit).toHaveBeenCalledTimes(2);
  });
});
