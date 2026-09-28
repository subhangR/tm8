// @vitest-environment jsdom
/**
 * ✦ Jev on the launch card v3 (mock 01a0df08; owner answers 01a0df30 and
 * 01a0df3e; the v3 coordinator's Decision 7).
 *
 * What must hold: ✦ is icon-only and says why when it can't ask (no port,
 * no key before any click); one press asks, and the strip's picks land
 * TICKED, marked ✦ in their groups; Jev's top teammate is applied while the
 * teammate is untouched, else it waits in the teammate menu; the model waits
 * in the model menu until clicked; "Undo Jev's changes" reverts Jev's picks
 * and its teammate but keeps the person's later edits; a hand-picked teammate
 * clears Jev's picks and turns ✦ stale WITHOUT re-asking; Jev's other
 * teammates are drawn in the Teammates group but not sent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import type { LaunchSuggestResult } from '@tm8/contract';

import type { JevKeyState } from '../jev';
import { answeringPort, failedGroup, item, MEMORIES, okGroup } from '../jev/test-support';
import { renderPopup } from './launch-test-kit';

beforeEach(() => { localStorage.clear(); });

/* Jev's memories as NON-defaults of LAUNCH_DEFAULTS (whose one memory default
   is ent-mem-tokens): its two suggested ones are ADDED. */
const JEV_MEMORIES = okGroup({
  ...MEMORIES,
  items: [item('mem-a', 'memory', 2.8, true), item('mem-b', 'memory', 1.9, true), item('mem-c', 'memory', 0.3, false)],
});

const RANKS = okGroup({
  items: [
    item('tm-scout', 'team_member', 2.7, true, ['space'], 'scout'),
    item('tm-forge', 'team_member', 1.8, true, ['space'], 'forge'),
    item('tm-other', 'team_member', 1.6, true, ['space'], 'reviewer'),
  ],
  noFit: false,
  floor: 1.5,
});

function setup(groups: Partial<LaunchSuggestResult['groups']> = {}, over: Parameters<typeof renderPopup>[0] = {}) {
  const port = answeringPort({ teammates: RANKS, memories: JEV_MEMORIES, ...groups });
  const view = renderPopup({ jev: port, ...over });
  const ask = async () => {
    await view.ready();
    await act(async () => { fireEvent.click(view.getByTestId('lcd3-jev')); });
    await waitFor(() => expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('done'));
  };
  return { ...view, port, ask };
}

/** ✦'s key as the host reads it (`jevKeyStateOf` over the space's credential list): none unless said. */
const keyStatus = (state: JevKeyState = 'none') => async (): Promise<JevKeyState> => state;

describe('the ✦ button', () => {
  it('is greyed with the reason when the host wires no Jev', () => {
    const view = renderPopup();
    const jev = view.getByTestId('lcd3-jev');
    expect(jev.getAttribute('data-status')).toBe('off');
    expect(jev.getAttribute('title')).toMatch(/isn’t wired/);
  });

  it('is greyed BEFORE any click when the space holds no TypeSafe credential', async () => {
    const view = setup({}, { jevKeyStatus: keyStatus('none') });
    await waitFor(() => expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('off'));
    expect(view.getByTestId('lcd3-jev').getAttribute('title')).toMatch(/Add a TypeSafe key under Space settings → Credentials/);
    expect(view.port.inputs).toHaveLength(0);
  });

  it('is in colour when the space has a TypeSafe default', async () => {
    const view = setup({}, { jevKeyStatus: keyStatus('yes') });
    await view.ready();
    expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('ready');
  });

  it('stays in colour when the key read fails — a refused read is not no_key', async () => {
    const view = setup({}, { jevKeyStatus: async () => { throw new Error('forbidden'); } });
    await view.ready();
    expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('ready');
  });

  it('stays in colour when the list cannot say (a my_default may answer)', async () => {
    const view = setup({}, { jevKeyStatus: keyStatus('unknown') });
    await view.ready();
    expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('ready');
  });
});

describe('asking', () => {
  it('one press asks, and the strip’s picks land ticked, marked ✦', async () => {
    const view = setup();
    await view.ask();
    expect(view.port.inputs).toHaveLength(1);
    expect(view.getByTestId('lcd3-group-memory').textContent).toMatch(/✦ 2/);
    const input = await view.spawn();
    expect(input.selection?.memoryIds).toEqual(['ent-mem-tokens', 'mem-a', 'mem-b']);
    expect(input.jevRunId).toBeTruthy();
  });

  it('its top teammate is applied while the teammate is untouched; the others are drawn but not sent', async () => {
    const view = setup();
    await view.ask();
    expect(view.getByTestId('nsx-team').getAttribute('aria-label')).toBe('Teammate: scout');
    const group = view.getByTestId('lcd3-group-teammate');
    expect(group.getAttribute('data-unsent')).toBe('true');
    fireEvent.click(group);
    expect(view.getByTestId('lcd3-group-unsent').textContent).toMatch(/can’t take teammates/);
    const input = await view.spawn();
    expect(input.teamMemberId).toBe('tm-scout');
  });

  it('after a hand-picked teammate, Jev’s pick waits in the teammate menu instead', async () => {
    const view = setup();
    await view.ready();
    fireEvent.click(view.getByTestId('nsx-team'));
    fireEvent.click(within(view.getByTestId('nsx-team-menu')).getByRole('menuitemradio', { name: /^forge/ }));
    await act(async () => { fireEvent.click(view.getByTestId('lcd3-jev')); });
    await waitFor(() => expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('done'));
    expect(view.getByTestId('nsx-team').getAttribute('aria-label')).toBe('Teammate: forge');
    fireEvent.click(view.getByTestId('nsx-team'));
    fireEvent.click(view.getByTestId('lcd3-jev-teammate'));
    expect(view.getByTestId('nsx-team').getAttribute('aria-label')).toBe('Teammate: scout');
  });

  it('the model waits in the model menu until clicked', async () => {
    const view = setup({ model: okGroup({ tier: 'deep', model: 'claude-opus-5', agentTool: 'claude-code', effort: 'max', need: 2.4, workKind: 'design', reasons: ['Cross-package change.'] }) });
    await view.ask();
    expect(view.getByTestId('nsx-model').textContent).toContain('✦');
    fireEvent.click(view.getByTestId('lcd3-jev'));
    expect(view.getByTestId('lcd3-jev-suggests').textContent).toMatch(/a model/);
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(view.getByTestId('nsx-model'));
    const row = view.getByTestId('lcd3-jev-model');
    expect(row.textContent).toContain('Cross-package change.');
    fireEvent.click(row);
    const input = await view.spawn();
    expect(input.model).toBe('claude-opus-5');
    expect(input.reasoningEffort).toBe('max');
  });

  it('a failed group has a Retry in the ✦ menu', async () => {
    const view = setup({ skills: failedGroup('timeout') });
    await view.ask();
    fireEvent.click(view.getByTestId('lcd3-jev'));
    const retry = view.getByTestId('lcd3-jev-retry-skills');
    expect(retry.textContent).toContain('timeout');
    await act(async () => { fireEvent.click(retry); });
    expect(view.port.inputs).toHaveLength(2);
  });

  it('its cost shows in the menu', async () => {
    const view = setup();
    await view.ask();
    fireEvent.click(view.getByTestId('lcd3-jev'));
    expect(view.getByTestId('lcd3-jev-menu').textContent).toMatch(/\$/);
  });
});

describe('undo and staleness', () => {
  it('Undo Jev’s changes reverts its picks and its teammate, and keeps a later edit of yours', async () => {
    const view = setup();
    await view.ask();
    const menu = await view.openGroup('skill');
    fireEvent.click(within(menu).getByTestId('lcd3-group-add-sk-extra'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(view.getByTestId('lcd3-jev'));
    fireEvent.click(view.getByTestId('lcd3-jev-undo'));
    expect(view.getByTestId('nsx-team').getAttribute('aria-label')).toBe('Teammate: forge');
    const input = await view.spawn();
    expect(input.selection?.memoryIds ?? ['ent-mem-tokens']).toEqual(['ent-mem-tokens']);
    expect(input.selection?.skillIds).toContain('sk-extra');
  });

  it('a hand-picked teammate clears Jev’s picks and turns ✦ stale — without asking again', async () => {
    const view = setup();
    await view.ask();
    fireEvent.click(view.getByTestId('nsx-team'));
    fireEvent.click(within(view.getByTestId('nsx-team-menu')).getByRole('menuitemradio', { name: /^forge/ }));
    await waitFor(() => expect(view.getByTestId('lcd3-jev').getAttribute('data-status')).toBe('stale'));
    expect(view.port.inputs).toHaveLength(1);
    expect(view.getByTestId('lcd3-group-memory').textContent).not.toMatch(/✦/);
  });
});

describe('the spawn payload', () => {
  it('without pressing ✦, the payload carries no Jev run', async () => {
    const view = setup();
    await view.ready();
    const input = await view.spawn();
    expect(input.jevRunId).toBeUndefined();
    expect(view.port.inputs).toHaveLength(0);
  });
});
