// @vitest-environment jsdom
/**
 * Lane B's surface on its own, over a hand-built Jev state (lane A's shape):
 * the one ✦ entry point opens and closes the panel with focus handled, every
 * Apply and Undo calls the state's action and nothing else, an unticked row
 * says why, and the budget meter says the three things that are not a plain
 * "used / budget": no budget, index off, and over budget.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, within } from '@testing-library/react';
import type { EntitySuggestion } from '@tm8/contract';

import {
  BudgetMeter,
  formatBytes,
  METER_INDEX_OFF_COPY,
  METER_NULL_BUDGET_COPY,
  METER_SKILL_TOOLTIP,
} from './BudgetMeter';
import { entryBadge, JevEntryPoint } from './JevEntryPoint';
import { JevPanel } from './JevPanel';
import type { JevLedgerEntry, JevPanelSource } from './lane-a-stub';
import { cost, failedGroup, item, MEMORIES, MODEL, okGroup, SKILLS, TEAMMATES } from './test-support';
import type { JevGroups } from './useJevSuggestions';

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

const ANSWERED: JevGroups = {
  model: okGroup(MODEL),
  teammates: okGroup(TEAMMATES),
  memories: okGroup(MEMORIES),
  skills: okGroup(SKILLS),
  references: okGroup(REFERENCES),
} as JevGroups;

function source(over: Partial<JevPanelSource> = {}): JevPanelSource {
  return {
    groups: ANSWERED,
    state: 'ready',
    run: cost(5, 0.00021, 1100),
    askRefusal: null,
    ask: vi.fn(),
    retry: vi.fn(),
    ticked: { memory: ['mem-a', 'mem-b'], skill: ['sk-a'], reference: ['ref-a'] },
    toggle: vi.fn(() => null),
    contextIndex: 'on',
    meter: {
      memories: { budget: 12288, floor: 1.5, usedBytes: 600 },
      skills: { budget: null, floor: 1.5, usedBytes: 420 },
      references: { budget: 4096, floor: 1.5, usedBytes: 380 },
    },
    applied: [],
    applyAll: vi.fn(),
    applyGroup: vi.fn(),
    applyTeammate: vi.fn(),
    applyModel: vi.fn(),
    undo: vi.fn(),
    undoAll: vi.fn(),
    ...over,
  };
}

const IDLE: JevGroups = {
  model: { status: 'idle' }, teammates: { status: 'idle' }, memories: { status: 'idle' },
  skills: { status: 'idle' }, references: { status: 'idle' },
};

describe('JevEntryPoint', () => {
  it('is collapsed by default, a real button with aria-expanded, and the panel is not rendered', () => {
    const view = render(<JevEntryPoint jev={source()} modelLabel="Claude Sonnet 5" modelRefusal={null} />);
    const button = view.getByTestId('jev-entry-button');
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('opens the panel, moves focus to its heading, and Escape closes it back onto the button', () => {
    const view = render(<JevEntryPoint jev={source()} modelLabel="Claude Sonnet 5" modelRefusal={null} />);
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
    const view = render(<JevEntryPoint jev={source()} modelLabel="m" modelRefusal={null} />);
    fireEvent.click(view.getByTestId('jev-entry-button'));
    fireEvent.click(view.getByTestId('jev-panel-close'));
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('the first press asks Jev and opens; a later press only toggles', () => {
    const jev = source({ groups: IDLE, state: 'idle', run: null });
    const view = render(<JevEntryPoint jev={jev} modelLabel="m" modelRefusal={null} />);
    expect(view.getByTestId('jev-entry-badge').textContent).toBe('✦ Ask Jev');
    fireEvent.click(view.getByTestId('jev-entry-button'));
    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(view.getByTestId('jev-panel')).toBeTruthy();

    const answered = source();
    view.rerender(<JevEntryPoint jev={answered} modelLabel="m" modelRefusal={null} />);
    fireEvent.click(view.getByTestId('jev-entry-button'));
    expect(answered.ask).not.toHaveBeenCalled();
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('a refused surface says why and neither asks nor opens', () => {
    const jev = source({ groups: IDLE, state: 'idle', askRefusal: 'no port here' });
    const view = render(<JevEntryPoint jev={jev} modelLabel="m" modelRefusal={null} />);
    const button = view.getByTestId('jev-entry-button');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('no port here');
    fireEvent.click(button);
    expect(jev.ask).not.toHaveBeenCalled();
    expect(view.queryByTestId('jev-panel')).toBeNull();
  });

  it('the badge counts suggestions and applied changes, and shows the cost', () => {
    const applied: JevLedgerEntry[] = [
      { group: 'model', at: 1, model: MODEL },
      { group: 'memories', at: 2, added: ['mem-b'], removed: ['mem-c'] },
    ];
    const view = render(<JevEntryPoint jev={source({ applied })} modelLabel="m" modelRefusal={null} />);
    // model 1 + teammate 1 + memories 2 + skills 1 + references 1
    expect(view.getByTestId('jev-entry-badge').textContent).toBe('✦ 6 suggested · 3 applied');
    expect(view.getByTestId('jev-entry-cost').textContent).toBe('$0.00021');
  });

  it('says asking, failed, partly failed, stale and unavailable', () => {
    expect(entryBadge(source({ state: 'asking' }))).toBe('✦ Asking Jev…');
    expect(entryBadge(source({ state: 'unavailable' }))).toBe('✦ Jev unavailable');
    const allFailed = Object.fromEntries(
      Object.keys(ANSWERED).map((g) => [g, failedGroup('timeout')]),
    ) as unknown as JevGroups;
    expect(entryBadge(source({ groups: allFailed }))).toBe('✦ Jev failed');
    expect(entryBadge(source({ groups: { ...ANSWERED, skills: failedGroup('timeout') } as JevGroups })))
      .toBe('✦ 5 suggested · 0 applied · 1 failed');
    expect(entryBadge(source({ state: 'stale' }))).toBe('✦ 6 suggested · 0 applied · stale');
  });

  it('unavailable offers the key settings link', () => {
    const view = render(<JevEntryPoint jev={source({ state: 'unavailable' })} modelLabel="m" modelRefusal={null} />);
    expect(view.getByTestId('jev-add-key')).toBeTruthy();
  });
});

describe('JevPanel', () => {
  const panel = (jev: JevPanelSource, modelRefusal: string | null = null) =>
    render(<JevPanel jev={jev} modelLabel="Claude Sonnet 5" modelRefusal={modelRefusal} />);

  it('has one section per group', () => {
    const view = panel(source());
    for (const g of ['model', 'teammates', 'memories', 'skills', 'references']) {
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
    fireEvent.click(view.getByTestId('jev-apply-teammates'));
    expect(jev.applyTeammate).toHaveBeenCalledTimes(1);
    for (const g of ['memories', 'skills', 'references'] as const) {
      fireEvent.click(view.getByTestId(`jev-apply-${g}`));
      expect(jev.applyGroup).toHaveBeenLastCalledWith(g);
    }
    expect(jev.applyGroup).toHaveBeenCalledTimes(3);
    expect(jev.undo).not.toHaveBeenCalled();
    expect(jev.undoAll).not.toHaveBeenCalled();
  });

  it('an applied group turns into Undo, and every undo path calls undo', () => {
    const applied: JevLedgerEntry[] = [
      { group: 'model', at: 1, model: MODEL },
      { group: 'teammates', at: 2, teammateId: 'ent-tm-scout', previousTeammateId: null },
      { group: 'skills', at: 3, added: ['sk-a'], removed: [] },
    ];
    const jev = source({ applied });
    const view = panel(jev);
    expect(view.queryByTestId('jev-apply-model')).toBeNull();
    fireEvent.click(view.getByTestId('jev-undo-model'));
    expect(jev.undo).toHaveBeenLastCalledWith('model');
    fireEvent.click(view.getByTestId('jev-undo-teammates'));
    expect(jev.undo).toHaveBeenLastCalledWith('teammates');
    fireEvent.click(view.getByTestId('jev-undo-skills'));
    expect(jev.undo).toHaveBeenLastCalledWith('skills');
    fireEvent.click(view.getByTestId('jev-ledger-undo-skills'));
    expect(jev.undo).toHaveBeenLastCalledWith('skills');
    fireEvent.click(view.getByTestId('jev-undo-all'));
    expect(jev.undoAll).toHaveBeenCalledTimes(1);
    // Groups not applied still offer Apply.
    expect(view.getByTestId('jev-apply-memories')).toBeTruthy();
  });

  it('"Applied to this launch" names what each Apply changed', () => {
    const applied: JevLedgerEntry[] = [
      { group: 'model', at: 1, model: MODEL },
      { group: 'teammates', at: 2, teammateId: 'ent-tm-scout', previousTeammateId: null },
      { group: 'memories', at: 3, added: ['mem-a'], removed: ['mem-c'] },
    ];
    const view = panel(source({ applied }));
    expect(view.queryByTestId('jev-ledger-empty')).toBeNull();
    expect(view.getByTestId('jev-ledger-model').textContent).toContain('Claude Sonnet 5 · high · claude-code');
    expect(view.getByTestId('jev-ledger-teammates').textContent).toContain('scout');
    const mem = view.getByTestId('jev-ledger-memories').textContent!;
    expect(mem).toContain('added Invite links are single-use');
    expect(mem).toContain('removed default memory mem-c');
  });

  it('with nothing applied the record says so', () => {
    expect(panel(source()).getByTestId('jev-ledger-empty').textContent).toMatch(/Nothing yet/);
  });

  it('a refused model Apply says why and does nothing', () => {
    const jev = source();
    const view = panel(jev, 'not in this catalog');
    const apply = view.getByTestId('jev-apply-model');
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(apply);
    expect(jev.applyModel).not.toHaveBeenCalled();
    expect(view.getByTestId('jev-panel-model-refusal').textContent).toBe('not in this catalog');
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
    const groups = { ...ANSWERED, memories: okGroup({ ...MEMORIES, items: [hostile] }) } as JevGroups;
    const view = panel(source({ groups }));
    const row = view.getByTestId('jev-prow-mem-x');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(view.getByTestId('jev-header-text-mem-x').textContent).toBe('<b>bold</b>');
    expect(view.getByTestId('jev-header-source-mem-x').textContent).toBe('authored header');
  });

  it('every unticked row says why: below the floor, over budget (a default, loudly), or your untick', () => {
    const jev = source({ ticked: { memory: ['mem-b'], skill: ['sk-a'], reference: ['ref-a'] } });
    const view = panel(jev);
    expect(view.getByTestId('jev-why-mem-c').textContent).toBe('below the floor — scored 0.3, the group needs 1.5.');
    expect(view.getByTestId('jev-why-ref-b').textContent).toBe('A default, left out: over budget — the group’s 4.0 KB was full when its turn came.');
    expect(view.getByTestId('jev-why-ref-b').className).toContain('jev-prow__why--default');
    expect(view.getByTestId('jev-why-mem-a').textContent).toBe('A default, left out: you unticked it.');
    // A ticked row has no reason line.
    expect(view.queryByTestId('jev-why-mem-b')).toBeNull();
    const box = within(view.getByTestId('jev-prow-mem-c')).getByRole('checkbox');
    expect(box.getAttribute('aria-describedby')).toBe('jev-why-mem-c');
  });

  it('a tick calls toggle with the row’s kind', () => {
    const jev = source();
    const view = panel(jev);
    fireEvent.click(within(view.getByTestId('jev-prow-ref-b')).getByRole('checkbox'));
    expect(jev.toggle).toHaveBeenCalledWith('reference', 'ref-b');
  });

  it('a failed group shows its own retry and no Apply, the others are untouched', () => {
    const jev = source({ groups: { ...ANSWERED, skills: failedGroup('timeout') } as JevGroups });
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

describe('BudgetMeter', () => {
  it('within budget: used / budget, as a meter', () => {
    const view = render(<BudgetMeter group="memories" usedBytes={600} budget={12288} contextIndex="on" />);
    const meter = view.getByTestId('jev-meter-memories');
    expect(meter.dataset.meter).toBe('within');
    expect(meter.textContent).toContain('600 B / 12 KB');
    expect(view.getByRole('meter').getAttribute('aria-valuenow')).toBe('600');
    expect(view.queryByTestId('jev-meter-memories-over')).toBeNull();
  });

  it('a null budget takes what the prompt has left', () => {
    const view = render(<BudgetMeter group="skills" usedBytes={420} budget={null} contextIndex="on" />);
    const meter = view.getByTestId('jev-meter-skills');
    expect(meter.dataset.meter).toBe('no-budget');
    expect(meter.textContent).toContain(`420 B · ${METER_NULL_BUDGET_COPY}`);
    expect(view.queryByRole('meter')).toBeNull();
  });

  it('skills explain that their bytes assume indexed, not native', () => {
    const view = render(<BudgetMeter group="skills" usedBytes={420} budget={2048} contextIndex="on" />);
    expect(view.getByTestId('jev-meter-skills').getAttribute('title')).toBe(METER_SKILL_TOOLTIP);
    expect(view.getByRole('img', { name: METER_SKILL_TOOLTIP })).toBeTruthy();
    const mem = render(<BudgetMeter group="memories" usedBytes={1} budget={2} contextIndex="on" />);
    expect(mem.getByTestId('jev-meter-memories').getAttribute('title')).toBeNull();
  });

  it('references with the context index off show no bytes', () => {
    const view = render(<BudgetMeter group="references" usedBytes={380} budget={4096} contextIndex="off" />);
    const meter = view.getByTestId('jev-meter-references');
    expect(meter.dataset.meter).toBe('index-off');
    expect(meter.textContent).toContain(METER_INDEX_OFF_COPY);
    expect(meter.textContent).not.toMatch(/\bB\b|KB/);
  });

  it('memory bytes stay real with the context index off', () => {
    const view = render(<BudgetMeter group="memories" usedBytes={600} budget={12288} contextIndex="off" />);
    expect(view.getByTestId('jev-meter-memories').textContent).toContain('600 B / 12 KB');
  });

  it('over budget is visible, allowed, and says by how much', () => {
    const view = render(<BudgetMeter group="references" usedBytes={5120} budget={4096} contextIndex="on" />);
    const meter = view.getByTestId('jev-meter-references');
    expect(meter.dataset.meter).toBe('over');
    expect(view.getByTestId('jev-meter-references-over').textContent).toMatch(/^Over budget by 1.0 KB\. Allowed/);
    expect(view.getByRole('meter').getAttribute('aria-valuetext')).toBe('5.0 KB of 4.0 KB, over budget');
  });

  it('formats bytes', () => {
    expect(formatBytes(300)).toBe('300 B');
    expect(formatBytes(1229)).toBe('1.2 KB');
    expect(formatBytes(12288)).toBe('12 KB');
  });
});
