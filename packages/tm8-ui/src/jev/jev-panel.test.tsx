// @vitest-environment jsdom
/**
 * Lane B's surface on its own, over a hand-built Jev state (lane A's shape):
 * the one ✦ entry point opens and closes the panel with focus handled, every
 * Apply and Undo calls the state's action and nothing else, an unticked row
 * says why, and the budget meter says the three things that are not a plain
 * "used / budget": no budget, index off, and over budget.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, within } from '@testing-library/react';
import type { EntitySuggestion } from '@tm8/contract';

import {
  BudgetMeter,
  formatBytes,
  METER_INDEX_OFF_COPY,
  METER_NULL_BUDGET_COPY,
  METER_SKILL_TOOLTIP,
} from './BudgetMeter';
import { entryBadge, JevEntryPoint } from './JevEntryPoint';
import { JevPanel, type JevPanelSource } from './JevPanel';
import { answeringPort, cost, failedGroup, item, MEMORIES, MODEL, okGroup, SKILLS, TEAMMATES } from './test-support';
import {
  JEV_ENTITY_GROUPS,
  useJevSuggestions,
  type JevApplyHost,
  type JevAppliedGroup,
  type JevAppliedLedger,
  type JevEntityGroup,
  type JevEntityGroupView,
  type JevGroups,
  type JevGroupState,
} from './useJevSuggestions';

const REFERENCES: EntitySuggestion = {
  items: [
    item('ref-a', 'doc', 2.4, true, ['parent'], 'Invite design doc'),
    { ...item('ref-b', 'doc', 2.0, false, ['task'], 'Join screen spec'), reason: 'over-budget', default: true },
  ],
  considered: 2,
  total: 2,
  budget: 4096,
  floor: 1.5,
};

const ANSWERS: Record<JevEntityGroup, EntitySuggestion> = { memories: MEMORIES, skills: SKILLS, references: REFERENCES };
const TICKS: Record<JevEntityGroup, string[]> = { memories: ['mem-a', 'mem-b'], skills: ['sk-a'], references: ['ref-a'] };

function viewOf(group: JevEntityGroup, ticked: readonly string[] = TICKS[group], over: Partial<JevEntityGroupView> = {}): JevEntityGroupView {
  const value = ANSWERS[group];
  return {
    group,
    state: okGroup(value) as JevGroupState<EntitySuggestion>,
    rows: value.items.map((row) => ({ ...row, ticked: ticked.includes(row.entityId) })),
    ticked: ticked as JevEntityGroupView['ticked'],
    budget: value.budget,
    budgetSource: 'jev',
    floor: value.floor,
    usedBytes: 300 * ticked.length,
    frameBytes: 0,
    overBudget: false,
    contextIndex: 'on',
    inPrompt: true,
    proposal: { removed: [], added: [] },
    applyRefusal: null,
    applied: null,
    appliedIsCurrent: false,
    ...over,
  };
}

const ANSWERED: JevGroups = {
  model: okGroup(MODEL),
  teammates: okGroup(TEAMMATES),
  memories: okGroup(MEMORIES),
  skills: okGroup(SKILLS),
  references: okGroup(REFERENCES),
} as JevGroups;

const appliedGroup = (added: string[], removed: string[] = [], at = 3): JevAppliedGroup => ({
  at, added: added as never, removed: removed as never, ticks: added as never, touched: [...added, ...removed] as never,
  before: { removed: [], added: [] }, requestId: 'rq-1',
});

function source(over: Partial<JevPanelSource> = {}): JevPanelSource {
  return {
    groups: ANSWERED,
    state: 'ready',
    run: cost(5, 0.00021, 1100),
    askRefusal: null,
    ask: vi.fn(),
    retry: vi.fn(),
    contextIndex: 'on',
    entity: { memories: viewOf('memories'), skills: viewOf('skills'), references: viewOf('references') },
    toggle: vi.fn(() => null),
    tickRefusal: null,
    teammatePick: TEAMMATES.items[0]!,
    teammateRefusal: null,
    modelRefusal: null,
    modelMatches: false,
    applied: {},
    applyGroup: vi.fn(() => null),
    applyTeammate: vi.fn(() => null),
    applyModel: vi.fn(() => null),
    applyAll: vi.fn(() => ({ applied: [], skipped: {} })),
    undo: vi.fn(() => null),
    undoAll: vi.fn(),
    ...over,
  };
}

const IDLE: JevGroups = {
  model: { status: 'idle' }, teammates: { status: 'idle' }, memories: { status: 'idle' },
  skills: { status: 'idle' }, references: { status: 'idle' },
};
const idleEntity = () => Object.fromEntries(JEV_ENTITY_GROUPS.map((g) => [g, viewOf(g, [], { state: { status: 'idle' }, rows: [] })])) as JevPanelSource['entity'];

const MODEL_CHOICE = { model: 'claude-sonnet-5', agentToolId: 'claude-code', reasoningEffort: 'high' as const };
const failedView = (g: JevEntityGroup) => viewOf(g, [], { state: failedGroup('timeout') as JevGroupState<EntitySuggestion>, rows: [] });

describe('JevEntryPoint', () => {
  it('is collapsed by default, a real button with aria-expanded, and the panel is not rendered', () => {
    const view = render(<JevEntryPoint jev={source()} modelLabel="Claude Sonnet 5" />);
    const button = view.getByTestId('jev-entry-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('opens the panel, moves focus to its heading, and Escape closes it back onto the button', () => {
    const view = render(<JevEntryPoint jev={source()} modelLabel="Claude Sonnet 5" />);
    const button = view.getByTestId('jev-entry-button');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = view.getByTestId('jev-panel');
    expect(button.getAttribute('aria-controls')).toBe(panel.id);
    expect(document.activeElement).toBe(within(panel).getByRole('heading', { level: 2 }));

    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(view.queryByTestId('jev-panel')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('Close in the panel collapses it too', () => {
    const view = render(<JevEntryPoint jev={source()} modelLabel="m" />);
    fireEvent.click(view.getByTestId('jev-entry-button'));
    fireEvent.click(view.getByTestId('jev-panel-close'));
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('the first press asks Jev and opens; a later press only toggles', () => {
    const jev = source({ groups: IDLE, entity: idleEntity(), state: 'idle', run: null, teammatePick: null });
    const view = render(<JevEntryPoint jev={jev} modelLabel="m" />);
    expect(view.getByTestId('jev-entry-badge').textContent).toBe('✦ Ask Jev');
    fireEvent.click(view.getByTestId('jev-entry-button'));
    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('jev-panel')).toBeTruthy();

    const answered = source();
    view.rerender(<JevEntryPoint jev={answered} modelLabel="m" />);
    fireEvent.click(view.getByTestId('jev-entry-button'));
    expect(answered.ask).not.toHaveBeenCalled();
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('a refused surface says why and neither asks nor opens', () => {
    const jev = source({ groups: IDLE, entity: idleEntity(), state: 'idle', askRefusal: 'no port here' });
    const view = render(<JevEntryPoint jev={jev} modelLabel="m" />);
    const button = view.getByTestId('jev-entry-button');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('no port here');
    fireEvent.click(button);
    expect(jev.ask).not.toHaveBeenCalled();
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('the badge counts suggestions and applied changes, and shows the cost', () => {
    const applied: JevAppliedLedger = {
      model: { at: 1, value: MODEL_CHOICE, previous: null },
      memories: appliedGroup(['mem-b'], ['mem-c'], 2),
    };
    const view = render(<JevEntryPoint jev={source({ applied })} modelLabel="m" />);
    // model 1 + teammate 1 + memories 2 + skills 1 + references 1
    expect(view.getByTestId('jev-entry-badge').textContent).toBe('✦ 6 suggested · 3 applied');
    expect(view.getByTestId('jev-entry-cost').textContent).toBe('$0.00021');
  });

  it('says asking, failed, partly failed, stale and unavailable', () => {
    expect(entryBadge(source({ state: 'asking' }))).toBe('✦ Asking Jev…');
    expect(entryBadge(source({ state: 'unavailable' }))).toBe('✦ Jev unavailable');
    const allFailed = Object.fromEntries(Object.keys(ANSWERED).map((g) => [g, failedGroup('timeout')])) as unknown as JevGroups;
    expect(entryBadge(source({ groups: allFailed }))).toBe('✦ Jev failed');
    const skillsFailed = source({
      groups: { ...ANSWERED, skills: failedGroup('timeout') } as JevGroups,
      entity: { memories: viewOf('memories'), skills: failedView('skills'), references: viewOf('references') },
    });
    expect(entryBadge(skillsFailed)).toBe('✦ 5 suggested · 0 applied · 1 failed');
    expect(entryBadge(source({ state: 'stale' }))).toBe('✦ 6 suggested · 0 applied · stale');
  });

  it('unavailable offers the key settings link', () => {
    const view = render(<JevEntryPoint jev={source({ state: 'unavailable' })} modelLabel="m" />);
    expect(view.getByTestId('jev-add-key')).toBeTruthy();
  });
});

describe('JevPanel', () => {
  const panel = (jev: JevPanelSource) => render(<JevPanel jev={jev} modelLabel="Claude Sonnet 5" />);

  it('has one section per group', () => {
    const view = panel(source());
    for (const g of ['model', 'teammate', 'memories', 'skills', 'references']) {
      expect(view.getByTestId(`jev-panel-${g}`)).toBeTruthy();
    }
  });

  it('each apply path calls its own action and nothing else', () => {
    const jev = source();
    const view = panel(jev);
    fireEvent.click(view.getByTestId('jev-apply-all'));
    expect(jev.applyAll).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByTestId('jev-apply-model'));
    expect(jev.applyModel).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByTestId('jev-apply-teammate'));
    expect(jev.applyTeammate).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('jev-apply-teammate').textContent).toBe('Apply scout');
    for (const g of JEV_ENTITY_GROUPS) {
      fireEvent.click(view.getByTestId(`jev-apply-${g}`));
      expect(jev.applyGroup).toHaveBeenLastCalledWith(g);
    }
    expect(jev.applyGroup).toHaveBeenCalledTimes(3);
    expect(jev.undo).not.toHaveBeenCalled();
    expect(jev.undoAll).not.toHaveBeenCalled();
  });

  it('Apply all says what it skipped and why', () => {
    const jev = source({ applyAll: vi.fn(() => ({ applied: ['model', 'teammate'] as const, skipped: { memories: 'ranked for the old teammate' } })) });
    const view = panel(jev);
    fireEvent.click(view.getByTestId('jev-apply-all'));
    expect(view.getByTestId('jev-panel-notice').textContent).toBe('Applied 2. Not applied: Memories — ranked for the old teammate');
  });

  it('a refused action says its reason instead of swallowing it', () => {
    const jev = source({
      applied: { teammate: { at: 1, teamMemberId: 'ent-tm-scout', previous: null } },
      undo: vi.fn(() => 'There was no teammate before this Apply to go back to — pick one.'),
    });
    const view = panel(jev);
    fireEvent.click(view.getByTestId('jev-undo-teammate'));
    expect(view.getByTestId('jev-panel-notice').textContent).toMatch(/no teammate before/);
  });

  it('an applied group turns into Undo, and every undo path calls undo', () => {
    const applied: JevAppliedLedger = {
      model: { at: 1, value: MODEL_CHOICE, previous: null },
      teammate: { at: 2, teamMemberId: 'ent-tm-scout', previous: 'ent-tm-forge' },
      skills: appliedGroup(['sk-a']),
    };
    const jev = source({
      applied,
      entity: { memories: viewOf('memories'), skills: viewOf('skills', TICKS.skills, { applied: applied.skills!, appliedIsCurrent: true }), references: viewOf('references') },
    });
    const view = panel(jev);
    expect(view.queryByTestId('jev-apply-model')).toBeNull();
    expect(view.getByTestId('jev-applied-skills').textContent).toBe('Applied ✓');
    fireEvent.click(view.getByTestId('jev-undo-model'));
    expect(jev.undo).toHaveBeenLastCalledWith('model');
    fireEvent.click(view.getByTestId('jev-undo-teammate'));
    expect(jev.undo).toHaveBeenLastCalledWith('teammate');
    fireEvent.click(view.getByTestId('jev-undo-skills'));
    expect(jev.undo).toHaveBeenLastCalledWith('skills');
    fireEvent.click(view.getByTestId('jev-ledger-undo-skills'));
    expect(jev.undo).toHaveBeenLastCalledWith('skills');
    fireEvent.click(view.getByTestId('jev-undo-all'));
    expect(jev.undoAll).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('jev-apply-memories')).toBeTruthy();
  });

  it('an applied group whose picks moved on offers Re-apply beside Undo', () => {
    const jev = source({
      applied: { memories: appliedGroup(['mem-b']) },
      entity: { memories: viewOf('memories', TICKS.memories, { applied: appliedGroup(['mem-b']), appliedIsCurrent: false }), skills: viewOf('skills'), references: viewOf('references') },
    });
    const view = panel(jev);
    expect(view.getByTestId('jev-applied-memories').textContent).toMatch(/changed since/);
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    expect(jev.applyGroup).toHaveBeenCalledWith('memories');
    expect(view.getByTestId('jev-undo-memories')).toBeTruthy();
  });

  it('"Applied to this launch" names what each Apply changed, oldest first', () => {
    const applied: JevAppliedLedger = {
      memories: appliedGroup(['mem-a'], ['mem-c'], 3),
      model: { at: 1, value: MODEL_CHOICE, previous: null },
      teammate: { at: 2, teamMemberId: 'ent-tm-scout', previous: null },
    };
    const view = panel(source({ applied }));
    expect(view.queryByTestId('jev-ledger-empty')).toBeNull();
    const lines = within(view.getByTestId('jev-ledger')).getAllByRole('listitem').map((li) => li.dataset.testid);
    expect(lines).toEqual(['jev-ledger-model', 'jev-ledger-teammate', 'jev-ledger-memories']);
    expect(view.getByTestId('jev-ledger-model').textContent).toContain('Claude Sonnet 5 · high · claude-code');
    expect(view.getByTestId('jev-ledger-teammate').textContent).toContain('scout');
    const mem = view.getByTestId('jev-ledger-memories').textContent!;
    expect(mem).toContain('added Invite links are single-use');
    expect(mem).toContain('removed default memory mem-c');
  });

  it('with nothing applied the record says so', () => {
    expect(panel(source()).getByTestId('jev-ledger-empty').textContent).toMatch(/Nothing yet/);
  });

  it('a refused model Apply says why and does nothing; a matching model is not re-offered', () => {
    const jev = source({ modelRefusal: 'not in this catalog' });
    const view = panel(jev);
    const apply = view.getByTestId('jev-apply-model');
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(apply);
    expect(jev.applyModel).not.toHaveBeenCalled();
    expect(view.getByTestId('jev-panel-model-refusal').textContent).toBe('not in this catalog');
    view.unmount();
    const same = panel(source({ modelMatches: true }));
    expect(same.getByTestId('jev-apply-model').getAttribute('aria-disabled')).toBe('true');
  });

  it('a refused teammate Apply says why', () => {
    const jev = source({ teammatePick: null, teammateRefusal: 'Jev found no teammate that fits this work — pick one yourself.' });
    const view = panel(jev);
    fireEvent.click(view.getByTestId('jev-apply-teammate'));
    expect(jev.applyTeammate).not.toHaveBeenCalled();
    expect(view.getByTestId('jev-apply-teammate').getAttribute('title')).toMatch(/no teammate that fits/);
  });

  it('a row shows level and score, default, sources and its header source and text', () => {
    const view = panel(source());
    const row = view.getByTestId('jev-prow-mem-a');
    expect(view.getByTestId('jev-level-mem-a').textContent).toBe('critical · 2.8');
    expect(row.textContent).toContain('default');
    expect(row.textContent).toContain('teammate');
    expect(row.textContent).toContain('space');
    expect(view.getByTestId('jev-header-source-mem-a').textContent).toBe('derived header');
    expect(view.getByTestId('jev-header-text-mem-a').textContent).toBe('Invite links are single-use');
  });

  it('header text and titles render as plain text, never HTML', () => {
    const hostile = { ...item('mem-x', 'memory', 2, true, ['space'], '<img src=x onerror=alert(1)>'),
      header: { whenToUse: null, summary: '<b>bold</b>', keywords: [], source: 'authored' as const, version: 2 } };
    const jev = source({ entity: { memories: viewOf('memories', ['mem-x'], { rows: [{ ...hostile, ticked: true }] }), skills: viewOf('skills'), references: viewOf('references') } });
    const view = panel(jev);
    const row = view.getByTestId('jev-prow-mem-x');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(view.getByTestId('jev-header-text-mem-x').textContent).toBe('<b>bold</b>');
    expect(view.getByTestId('jev-header-source-mem-x').textContent).toBe('authored header');
  });

  it('every unticked row says why: below the floor, over budget (a default, loudly), or your untick', () => {
    const jev = source({ entity: { memories: viewOf('memories', ['mem-b']), skills: viewOf('skills'), references: viewOf('references') } });
    const view = panel(jev);
    expect(view.getByTestId('jev-why-mem-c').textContent).toBe('below the floor — scored 0.3, the group needs 1.5.');
    expect(view.getByTestId('jev-why-ref-b').textContent).toBe('A default, left out: over budget — the group’s 4.0 KB was full when its turn came.');
    expect(view.getByTestId('jev-why-ref-b').className).toContain('jev-prow__why--default');
    expect(view.getByTestId('jev-why-mem-a').textContent).toBe('A default, left out: you unticked it.');
    expect(view.queryByTestId('jev-why-mem-b')).toBeNull();
    const box = within(view.getByTestId('jev-prow-mem-c')).getByRole('checkbox');
    expect(box.getAttribute('aria-describedby')).toBe('jev-why-mem-c');
  });

  it('a tick calls toggle with the row’s group, and a refused tick says why at the row', () => {
    const jev = source({ tickRefusal: { group: 'references', id: 'ref-b', reason: 'at most 240', kind: null } });
    const view = panel(jev);
    fireEvent.click(within(view.getByTestId('jev-prow-ref-b')).getByRole('checkbox'));
    expect(jev.toggle).toHaveBeenCalledWith('references', 'ref-b');
    expect(view.getByTestId('jev-tick-refusal-ref-b').textContent).toBe('at most 240');
  });

  it('the references meter says it is not in the prompt while the index is off, and hides row bytes', () => {
    const jev = source({
      contextIndex: 'off',
      entity: { memories: viewOf('memories'), skills: viewOf('skills'), references: viewOf('references', TICKS.references, { contextIndex: 'off', inPrompt: false, usedBytes: 0 }) },
    });
    const view = panel(jev);
    expect(view.getByTestId('jev-meter-references').dataset.meter).toBe('index-off');
    expect(view.getByTestId('jev-prow-ref-a').textContent).not.toMatch(/\d B\b/);
    expect(view.getByTestId('jev-meter-memories').dataset.meter).toBe('within');
  });

  it('a failed group shows its own retry and no Apply, the others are untouched', () => {
    const jev = source({
      groups: { ...ANSWERED, skills: failedGroup('timeout') } as JevGroups,
      entity: { memories: viewOf('memories'), skills: failedView('skills'), references: viewOf('references') },
    });
    const view = panel(jev);
    expect(view.queryByTestId('jev-apply-skills')).toBeNull();
    fireEvent.click(view.getByTestId('jev-skills-retry'));
    expect(jev.retry).toHaveBeenCalledWith('skills');
    expect(view.getByTestId('jev-apply-memories')).toBeTruthy();
  });

  it('stale offers Ask again', () => {
    const jev = source({ state: 'stale' });
    fireEvent.click(panel(jev).getByTestId('jev-panel-ask-again'));
    expect(jev.ask).toHaveBeenCalledTimes(1);
  });
});

/* THE REAL HOOK, end to end: the panel's buttons reach lane A's actions and
   through them the surface's host — and nothing reaches the host without a click. */
describe('JevPanel over useJevSuggestions', () => {
  const ready = (ids: string[]) => ({
    status: 'ready' as const,
    rows: ids.map((id) => ({ id: id as never, kind: 'memory', title: id, text: null, derived: false, via: null })),
    total: ids.length,
  });

  function Harness({ host }: { host: JevApplyHost }) {
    const jev = useJevSuggestions({ port: answeringPort({ references: okGroup(REFERENCES) }), spaceId: 'sp-1', subjectId: 'task-1', teammateId: 'tm-1', host });
    return <JevEntryPoint jev={jev} modelLabel="Claude Sonnet 5" />;
  }

  function hostFor(): JevApplyHost & { setEdit: ReturnType<typeof vi.fn>; setModel: ReturnType<typeof vi.fn>; setTeammate: ReturnType<typeof vi.fn> } {
    return {
      defaults: { memories: ready(['mem-a', 'mem-b']), skills: ready(['sk-a', 'sk-b']), references: ready([]) },
      edits: { memories: { removed: [], added: [] }, skills: { removed: [], added: [] }, references: { removed: [], added: [] } },
      setEdit: vi.fn(),
      setTeammate: vi.fn(),
      model: { model: 'claude-opus-5', agentToolId: 'claude-code', reasoningEffort: 'medium' },
      setModel: vi.fn(),
      modelRefusal: () => null,
    };
  }

  it('asks on the first press, applies nothing until a click, then Apply reaches the host and the ledger shows it', async () => {
    const host = hostFor();
    const view = render(<Harness host={host} />);
    await act(async () => { fireEvent.click(view.getByTestId('jev-entry-button')); });
    expect(await view.findByTestId('jev-apply-skills')).toBeTruthy();
    expect(host.setEdit).not.toHaveBeenCalled();
    expect(host.setModel).not.toHaveBeenCalled();
    expect(host.setTeammate).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId('jev-apply-skills'));
    expect(host.setEdit).toHaveBeenCalledTimes(1);
    expect(host.setEdit.mock.calls[0]![0]).toBe('skills');
    // Jev ticks sk-a (a default) and leaves out sk-b, a default under the floor: the edit removes it.
    expect(host.setEdit.mock.calls[0]![1]).toEqual({ removed: ['sk-b'], added: [] });
    expect(view.getByTestId('jev-ledger-skills').textContent).toContain('removed default skill sk-b');

    fireEvent.click(view.getByTestId('jev-apply-model'));
    expect(host.setModel).toHaveBeenCalledWith({ model: 'claude-sonnet-5', agentToolId: 'claude-code', reasoningEffort: 'high' });
    fireEvent.click(view.getByTestId('jev-apply-teammate'));
    expect(host.setTeammate).toHaveBeenCalledWith('ent-tm-scout');
    expect(view.getByTestId('jev-entry-badge').textContent).toBe('✦ 6 suggested · 3 applied');
  });
});
