// @vitest-environment jsdom
/**
 * THE PER-GROUP METER AND THE "OVER BUDGET" REASON (I7 UI, Jev UX lane C).
 *
 * Each group — memories, skills, references — mounts lane B's BudgetMeter
 * for what THIS LAUNCH carries, with bytes from Jev's ranked rows, else
 * `launch.defaults`; with no bytes known it shows the count only. A default a
 * person's Jev Apply removed says why. Every rule has its negative control.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { contextGroupFrameBytes } from '@tm8/prompt';
import type { EntitySuggestion, LaunchDefaultsResult, SpawnSelectionGroup } from '@tm8/contract';

import { LAUNCH_DEFAULTS } from '../views/launch-fixtures';
import { item } from '../jev/test-support';
import { appliedReasons, groupMeter, LaunchSelectionGroups, useLaunchSelection, type LaunchSelection, type LaunchSelectionBudgetProps } from '.';

type Budgeted = LaunchSelectionBudgetProps;

/**
 * The sheet fixture with lane E's byte facts STRIPPED, whether or not the
 * fixture carries them yet — each test then states exactly the bytes it means.
 */
const BARE: LaunchDefaultsResult = (() => {
  const strip = (g: SpawnSelectionGroup) => {
    const { budget: _b, floor: _f, ...rest } = LAUNCH_DEFAULTS[g] as typeof LAUNCH_DEFAULTS[typeof g] & { budget?: unknown; floor?: unknown };
    return { ...rest, items: rest.items.map(({ promptBytes: _p, ...i }: typeof rest.items[number] & { promptBytes?: number }) => i) };
  };
  const { contextIndex: _c, ...result } = LAUNCH_DEFAULTS as LaunchDefaultsResult & { contextIndex?: unknown };
  return { ...result, memories: strip('memories'), skills: strip('skills'), references: strip('references') } as LaunchDefaultsResult;
})();

/** `launch.defaults` with lane E's fields, as the node will send them. */
function withBytes(bytes: Record<string, number>, budgets: Partial<Record<SpawnSelectionGroup, number | null>>, contextIndex?: 'on' | 'off'): LaunchDefaultsResult {
  const group = (g: SpawnSelectionGroup) => ({
    ...BARE[g],
    items: BARE[g].items.map((i) => (i.entityId in bytes ? { ...i, promptBytes: bytes[i.entityId] } : i)),
    ...(g in budgets ? { budget: budgets[g] } : {}),
  });
  return { ...BARE, memories: group('memories'), skills: group('skills'), references: group('references'), ...(contextIndex ? { contextIndex } : {}) } as LaunchDefaultsResult;
}

let captured: LaunchSelection | null = null;
function Harness({ defaults, budgeted }: { defaults: LaunchDefaultsResult; budgeted: Budgeted }) {
  const selection = useLaunchSelection({ load: async () => defaults, teammateId: 'tm-1', subjectId: 'task-1' });
  captured = selection;
  return <div className="cv2-root"><LaunchSelectionGroups selection={selection} groups={['memories', 'skills', 'references']} candidates={{}} collapsed {...budgeted} /></div>;
}

async function mount(defaults: LaunchDefaultsResult = BARE, budgeted: Budgeted = {}) {
  const view = render(<Harness defaults={defaults} budgeted={budgeted} />);
  await waitFor(() => expect(view.getByTestId('lsel-toggle-memories').textContent).toMatch(/1 default/));
  return view;
}

/* Jev's answer for the memories group: the one default, ranked over budget, and a non-default pick. */
const MEM_RANKED: EntitySuggestion = {
  items: [
    { ...item('ent-mem-tokens', 'memory', 1.8, false, ['teammate']), promptBytes: 900, reason: 'over-budget' },
    { ...item('ent-mem-new', 'memory', 2.9, true, ['space']), promptBytes: 400 },
  ],
  considered: 2,
  total: 2,
  budget: 1024,
  floor: 1.5,
};

describe('a meter per group', () => {
  it('every group mounts one; with no bytes anywhere it is the COUNT only, never an invented number', async () => {
    const view = await mount();
    for (const group of ['memories', 'skills', 'references'] as const) {
      const meter = view.getByTestId(`lsel-meter-${group}`);
      expect(meter.dataset.meter).toBe('count');
      expect(meter.textContent).not.toMatch(/\d+(\.\d)? ?(B|KB)\b/);
    }
    expect(view.getByTestId('lsel-meter-references').textContent).toMatch(/^2 references/);
    expect(view.queryByTestId('jev-meter-memories')).toBeNull();
  });

  it('launch.defaults’ bytes and budget drive the meter without Ask Jev', async () => {
    const view = await mount(withBytes({ 'ent-mem-tokens': 700 }, { memories: 12_288 }));
    expect(view.getByTestId('jev-meter-memories').dataset.meter).toBe('within');
    expect(view.getByTestId('jev-meter-memories').textContent).toContain('700 B / 12 KB');
    // Negative control: skills have no bytes from the node, so still a count.
    expect(view.getByTestId('lsel-meter-skills').dataset.meter).toBe('count');
  });

  it('an index group pays its <context_index> frame; memories do not', async () => {
    await mount(withBytes({ 'ent-sk-review': 100, 'ent-mem-tokens': 100 }, { skills: 4096, memories: 4096 }, 'on'));
    const sel = captured!;
    expect(groupMeter(sel, 'skills', undefined, 'on', undefined)?.usedBytes).toBe(100 + contextGroupFrameBytes('skills', 1));
    expect(groupMeter(sel, 'memories', undefined, 'on', undefined)?.usedBytes).toBe(100);
    // Off: no frame (the index is not rendered), and references say so instead of a number.
    expect(groupMeter(sel, 'skills', undefined, 'off', undefined)?.usedBytes).toBe(100);
  });

  it('references with the context index off say "not in the prompt", memories still count bytes', async () => {
    const view = await mount(withBytes({ 'ent-doc-spec': 0, 'ent-file-log': 0, 'ent-mem-tokens': 500 }, { references: 8192, memories: 12_288 }, 'off'));
    expect(view.getByTestId('jev-meter-references').dataset.meter).toBe('index-off');
    expect(view.getByTestId('jev-meter-references').textContent).toMatch(/not in the prompt while the context index is off/i);
    expect(view.getByTestId('jev-meter-memories').textContent).toContain('500 B');
  });

  it('the skills meter says its bytes assume indexed, not native', async () => {
    const view = await mount(withBytes({ 'ent-sk-review': 120 }, { skills: null }));
    expect(view.getByTestId('jev-meter-skills').getAttribute('title')).toMatch(/indexed, not native/);
    view.unmount();
    // Negative control: the memories meter carries no such tooltip.
    const mem = await mount(withBytes({ 'ent-mem-tokens': 120 }, { memories: 4096 }));
    expect(mem.getByTestId('jev-meter-memories').getAttribute('title')).toBeNull();
  });

  it('Jev’s ranked bytes and budget replace the node’s; the per-launch override replaces both', async () => {
    const view = await mount(withBytes({ 'ent-mem-tokens': 700 }, { memories: 12_288 }), { ranked: { memories: MEM_RANKED } });
    expect(view.getByTestId('lsel-meter-memories').dataset.budgetSource).toBe('jev');
    expect(view.getByTestId('jev-meter-memories').textContent).toContain('900 B / 1.0 KB');
    view.unmount();
    const over = await mount(withBytes({ 'ent-mem-tokens': 700 }, { memories: 12_288 }), { ranked: { memories: MEM_RANKED }, budgets: { memories: 512 } });
    expect(over.getByTestId('lsel-meter-memories').dataset.budgetSource).toBe('override');
    expect(over.getByTestId('jev-meter-memories').dataset.meter).toBe('over');
  });

  it('it measures the LAUNCH’S set: an untick shrinks it, an addition grows it', async () => {
    const view = await mount(withBytes({ 'ent-mem-tokens': 700 }, { memories: 12_288 }), { ranked: { memories: MEM_RANKED } });
    fireEvent.click(view.getByTestId('lsel-toggle-memories'));
    fireEvent.click(view.getByTestId('lsel-row-memories-ent-mem-tokens'));
    expect(view.getByTestId('jev-meter-memories').textContent).toContain('0 B / 1.0 KB');
    act(() => { captured!.setEdit('memories', { removed: [], added: ['ent-mem-new' as never] }, []); });
    expect(view.getByTestId('jev-meter-memories').textContent).toContain('1.3 KB / 1.0 KB');
  });

  it('an id with unknown bytes turns the meter back into a count', async () => {
    const view = await mount(withBytes({ 'ent-mem-tokens': 700 }, { memories: 12_288 }));
    act(() => { captured!.setEdit('memories', { removed: [], added: ['ent-mem-mystery' as never] }, []); });
    expect(view.getByTestId('jev-meter-memories').dataset.meter).toBe('count-only');
    expect(view.getByTestId('jev-meter-memories').textContent).toContain('2 ticked');
    expect(view.getByTestId('jev-meter-memories').textContent).not.toContain('700 B');
  });
});

describe('“over budget” on a default Jev left out', () => {
  it('an Apply’s removal says why', async () => {
    const view = await mount(BARE);
    act(() => { captured!.setEdit('memories', { removed: ['ent-mem-tokens' as never], added: [] }, []); });
    const reasons = appliedReasons(MEM_RANKED, ['ent-mem-tokens'], captured!, 'memories');
    expect(reasons).toEqual({ 'ent-mem-tokens': 'over-budget' });
    view.rerender(<Harness defaults={BARE} budgeted={{ ranked: { memories: MEM_RANKED }, reasons: { memories: reasons } }} />);
    fireEvent.click(view.getByTestId('lsel-toggle-memories'));
    expect(view.getByTestId('lsel-row-memories-ent-mem-tokens').textContent).toContain('default · removed · over budget');
    // Still a visible removal in the group's diff.
    expect(view.getByTestId('lsel-toggle-memories').textContent).toContain('−1 default removed');
  });

  it('negative control: a removal by HAND carries no Jev reason', async () => {
    await mount(BARE);
    act(() => { captured!.setEdit('memories', { removed: ['ent-mem-tokens' as never], added: [] }, []); });
    expect(appliedReasons(MEM_RANKED, [], captured!, 'memories')).toEqual({});
    expect(appliedReasons(MEM_RANKED, undefined, captured!, 'memories')).toEqual({});
  });

  it('negative control: re-ticked after the Apply, the reason goes', async () => {
    await mount(BARE);
    act(() => { captured!.setEdit('memories', { removed: [], added: [] }, []); });
    expect(appliedReasons(MEM_RANKED, ['ent-mem-tokens'], captured!, 'memories')).toEqual({});
  });
});

describe('setEdit', () => {
  it('replaces the group’s edit and keeps an added row’s title', async () => {
    const view = await mount(BARE);
    const row = { id: 'ent-ref-jev' as never, kind: 'doc', title: 'Jev’s pick', text: null, derived: false, via: null };
    let refused: string | null = 'unset';
    act(() => { refused = captured!.setEdit('references', { removed: [], added: [row.id] }, [row]); });
    expect(refused).toBeNull();
    fireEvent.click(view.getByTestId('lsel-toggle-references'));
    expect(view.getByTestId('lsel-row-references-ent-ref-jev').textContent).toContain('Jev’s pick');
    expect(view.getByTestId('lsel-toggle-references').textContent).toContain('+1 added');
  });

  it('negative control: refused past the per-group ceiling, and nothing changes', async () => {
    await mount(BARE);
    const many = Array.from({ length: 400 }, (_, i) => `ent-x-${String(i)}` as never);
    let refused: string | null = null;
    act(() => { refused = captured!.setEdit('skills', { removed: [], added: many }, []); });
    expect(refused).toMatch(/at most/);
    expect(captured!.edits.skills.added).toEqual([]);
  });
});

describe('launch.defaults is asked with the launch’s harness and profile', () => {
  function Params({ load, agentTool, profile }: { load: (input: unknown) => Promise<LaunchDefaultsResult>; agentTool: string | null; profile: string | null }) {
    useLaunchSelection({ load, teammateId: 'tm-1', subjectId: 'task-1', agentTool, interactionProfileId: profile });
    return null;
  }

  it('sends both when picked, and re-reads when either changes', async () => {
    const load = vi.fn(async (_input: unknown) => BARE);
    const view = render(<Params load={load} agentTool="codex" profile="pf-1" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load.mock.calls[0]![0]).toEqual({ teamMemberId: 'tm-1', subjectId: 'task-1', agentTool: 'codex', interactionProfileId: 'pf-1' });
    view.rerender(<Params load={load} agentTool="claude-code" profile="pf-1" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    view.rerender(<Params load={load} agentTool="claude-code" profile="pf-2" />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(3));
    expect(load.mock.calls[2]![0]).toMatchObject({ agentTool: 'claude-code', interactionProfileId: 'pf-2' });
  });

  it('negative control: no profile picked and an unknown harness send neither key, and an unchanged pick does not re-read', async () => {
    const load = vi.fn(async (_input: unknown) => BARE);
    const view = render(<Params load={load} agentTool="some-other-tool" profile={null} />);
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect(load.mock.calls[0]![0]).toEqual({ teamMemberId: 'tm-1', subjectId: 'task-1' });
    view.rerender(<Params load={load} agentTool="some-other-tool" profile={null} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(load).toHaveBeenCalledTimes(1);
  });
});
