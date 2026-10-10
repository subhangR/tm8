// @vitest-environment jsdom
/**
 * A Run opened INSIDE A CRAFT starts with the Crafter (owner decisions §5;
 * QA defect 01a12597): the craft's own Run, the overview's and a page tab's
 * all mount the same card under `CraftLaunchScope`. Outside a craft, Auto
 * stays the roster's front row.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { renderPopup } from './launch-test-kit';
import { CraftLaunchScope, rosterForLaunchScope } from './launch-scope';

const ROSTER = [
  { id: 'tm-coord', label: 'Coordinator', agentTool: 'claude-code', model: 'claude-opus-5-5[1m]' },
  { id: 'tm-architect', label: 'Graph Architect', agentTool: 'claude-code', model: 'claude-opus-5-5[1m]' },
  { id: 'tm-crafter', label: 'Crafter', agentTool: 'claude-code', model: 'claude-opus-5-5[1m]' },
];

beforeEach(() => { localStorage.clear(); });

describe('the launch card in a craft', () => {
  it('a Run inside a craft spawns the Crafter, shown as Auto’s current pick', async () => {
    const view = renderPopup({ teammates: ROSTER }, (card) => <CraftLaunchScope craftId="craft-1">{card}</CraftLaunchScope>);
    expect(view.getByTestId('nsx-team').textContent).toContain('Crafter');
    const input = await view.spawn();
    expect(input.teamMemberId).toBe('tm-crafter');
    // …and is ABOUT the craft, so the session may manage its tabs (L3).
    expect(input.aboutEntityId).toBe('craft-1');
  });

  it('a Run outside a craft keeps Auto on the roster’s front row', async () => {
    const view = renderPopup({ teammates: ROSTER });
    const input = await view.spawn();
    expect(input.teamMemberId).toBe('tm-coord');
    expect('aboutEntityId' in input).toBe(false);
  });
});

describe('rosterForLaunchScope', () => {
  it('moves the Crafter to the front only in a craft, else the Graph Architect, else leaves the roster', () => {
    const scope = { craftId: 'craft-1' };
    expect(rosterForLaunchScope(ROSTER, null)).toBe(ROSTER);
    expect(rosterForLaunchScope(ROSTER, scope).map((t) => t.id)).toEqual(['tm-crafter', 'tm-coord', 'tm-architect']);
    expect(rosterForLaunchScope(ROSTER.slice(0, 2), scope).map((t) => t.id)).toEqual(['tm-architect', 'tm-coord']);
    const plain = [ROSTER[0]!];
    expect(rosterForLaunchScope(plain, scope)).toBe(plain);
  });
});
