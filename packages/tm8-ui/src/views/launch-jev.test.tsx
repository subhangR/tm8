// @vitest-environment jsdom
/**
 * ✦ Ask Jev on LaunchSheet — ONE entry point (Jev UX lane C, Subhang's I9b
 * note; I7 UI).
 *
 * What must hold: the sheet has exactly one Jev entry point and none of the
 * retired inline pieces; Jev only suggests — nothing changes until a person
 * presses Apply; an applied group is an ordinary selection edit (visible in
 * the group's diff, sent like a hand edit), references included; a default
 * the Apply left out says "over budget"; every group mounts a meter; the
 * per-launch budget override is sent only when set, warns past the prompt's
 * room and never blocks Launch. Each rule has a negative control.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { ContextBudgetsSchema, type EntityId, type EntitySuggestion, type LaunchSuggestResult } from '@tm8/contract';

import { LaunchSheet, type LaunchSelection } from './LaunchSheet';
import { LAUNCH_CAPACITY, LAUNCH_DEFAULTS, LAUNCH_MEMORIES, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES } from './launch-fixtures';
import { MobileSurfaceProvider } from '../mobile';
import type { JevPort } from '../jev/port';
import { answeringPort, item, pendingPort } from '../jev/test-support';

type SheetProps = React.ComponentProps<typeof LaunchSheet>;

function renderSheet(props: Partial<SheetProps> = {}) {
  const onLaunch = vi.fn<(config: LaunchSelection) => void>();
  const onDispatch = vi.fn();
  const view = render(
    <div className="cv2-root">
      <LaunchSheet
        subjectId={'task-1' as EntityId}
        spaceId="sp-1"
        fromChip="◔ Run ▸"
        fromCaption="task pre-associated"
        teammates={LAUNCH_TEAMMATES}
        projects={LAUNCH_PROJECTS}
        profiles={LAUNCH_PROFILES}
        capacity={LAUNCH_CAPACITY}
        memories={LAUNCH_MEMORIES}
        onLaunch={onLaunch}
        onDispatch={onDispatch}
        onCancel={() => {}}
        {...props}
      />
    </div>,
  );
  const launch = () => {
    fireEvent.click(view.getByRole('button', { name: /Launch ▸/ }));
    return onLaunch.mock.calls.at(-1)![0];
  };
  return { ...view, onLaunch, onDispatch, launch };
}

/* Jev's memories: the launch's one default, left out over budget, and a pick that is not a default. */
const MEMORIES: EntitySuggestion = {
  items: [
    item('ent-mem-tokens', 'memory', 1.8, false, ['teammate']),
    item('mem-new', 'memory', 2.9, true, ['space'], 'A memory Jev picked'),
  ],
  considered: 2, total: 2, budget: 1024, floor: 1.5,
};
/* Jev's references: one of the task's two linked defaults, kept, and a new doc. */
const REFERENCES: EntitySuggestion = {
  items: [
    item('ent-doc-spec', 'doc', 2.5, true, ['task']),
    item('ref-new', 'doc', 2.2, true, ['space'], 'A doc Jev picked'),
  ],
  considered: 2, total: 2, budget: 8192, floor: 1.5,
};
const OK = (value: EntitySuggestion) => ({ status: 'ok' as const, value, cost: { calls: 1, inputTokens: 1, outputTokens: 0, usd: 0, latencyMs: 1 } });
const ANSWER: Partial<LaunchSuggestResult['groups']> = { memories: OK(MEMORIES), references: OK(REFERENCES) };

async function asked(props: Partial<SheetProps> = {}) {
  const port = answeringPort(ANSWER);
  const view = renderSheet({ jev: port, loadLaunchDefaults: async () => LAUNCH_DEFAULTS, ...props });
  await waitFor(() => expect(view.getByTestId('lsel-toggle-memories').textContent).toMatch(/1 default/));
  await act(async () => { fireEvent.click(view.getByTestId('jev-entry-button')); });
  await waitFor(() => expect(view.getByTestId('jev-panel')).toBeTruthy());
  return { ...view, port };
}

const RETIRED = ['jev-ask', 'jev-runbar', 'jev-model-hint', 'jev-teammate-ranks', 'jev-checklist-memory', 'jev-checklist-skill', 'jev-reset', 'jev-launch-note'];

describe('one entry point', () => {
  it('the sheet has exactly one, and none of the retired inline pieces — before and after asking', async () => {
    const view = await asked();
    expect(view.getAllByTestId('jev-entry')).toHaveLength(1);
    for (const id of RETIRED) expect(view.queryByTestId(id)).toBeNull();
    // Asking does not replace a group: the ordinary groups stay the launch's context.
    for (const group of ['memories', 'skills', 'references']) expect(view.getByTestId(`lsel-group-${group}`)).toBeTruthy();
  });

  it('sits in the launch config, above CONFIGURATION — not in the footer', () => {
    const view = renderSheet({ jev: pendingPort() });
    const entry = view.getByTestId('jev-entry');
    expect(entry.closest('.ls__foot')).toBeNull();
    const config = view.getByText('CONFIGURATION');
    expect(entry.compareDocumentPosition(config) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is refused with a reason, never hidden, when the surface has no Jev port', () => {
    const view = renderSheet();
    expect(view.getAllByTestId('jev-entry')).toHaveLength(1);
  });
});

describe('Jev only suggests: nothing changes until Apply', () => {
  it('an answer alone leaves the launch exactly as a sheet with no Jev — apart from the run it cost', async () => {
    const view = await asked();
    const config = view.launch();
    expect(config.selection).toBeUndefined();
    expect(config.model).toBe('claude-sonnet-5');
    expect(config.teamMemberId).toBe('ent-tm-forge');
    expect(config.jevRunId).toBe(view.port.inputs[0]!.runId);
  });

  it('without pressing the entry point, the payload is identical to a sheet with no Jev at all', () => {
    const withJev = renderSheet({ jev: pendingPort() });
    const a = withJev.launch();
    withJev.unmount();
    const b = renderSheet().launch();
    expect(a).toEqual(b);
    expect('jevRunId' in a).toBe(false);
    expect('contextBudgets' in a).toBe(false);
  });
});

describe('an applied group is an ordinary edit', () => {
  it('Apply memories: the untick is a visible removal saying "over budget", the pick an addition, and Launch sends the exact set', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    const toggle = view.getByTestId('lsel-toggle-memories');
    expect(toggle.textContent).toContain('−1 default removed');
    expect(toggle.textContent).toContain('+1 added');
    fireEvent.click(toggle);
    expect(view.getByTestId('lsel-row-memories-ent-mem-tokens').textContent).toContain('default · removed · over budget');
    expect(view.getByTestId('lsel-row-memories-mem-new').textContent).toContain('A memory Jev picked');
    const config = view.launch();
    expect(config.selection).toEqual({ memoryIds: ['mem-new'] });
    expect('memoryIds' in config).toBe(false);
  });

  it('negative control: the same untick made BY HAND shows no Jev reason', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('lsel-toggle-memories'));
    fireEvent.click(view.getByTestId('lsel-row-memories-ent-mem-tokens'));
    expect(view.getByTestId('lsel-row-memories-ent-mem-tokens').textContent).toContain('default · removed');
    expect(view.getByTestId('lsel-row-memories-ent-mem-tokens').textContent).not.toContain('over budget');
  });

  it('the References group accepts Jev picks; a default Jev did not rank keeps its state', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-references'));
    expect(view.getByTestId('lsel-toggle-references').textContent).toContain('+1 added');
    const config = view.launch();
    expect(config.selection).toEqual({ referenceIds: ['ent-doc-spec', 'ent-file-log', 'ref-new'] });
  });

  it('Undo returns the group to its defaults, and Launch sends no selection', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    fireEvent.click(view.getByTestId('jev-undo-memories'));
    expect(view.getByTestId('lsel-toggle-memories').textContent).not.toMatch(/removed|added/);
    expect(view.launch().selection).toBeUndefined();
  });

  it('Apply model sets model, tool and effort through the sheet’s own controls', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-model'));
    expect((view.getByTestId('launch-reasoning-effort') as HTMLSelectElement).value).toBe('high');
    const config = view.launch();
    expect([config.model, config.agentToolId, config.reasoningEffort]).toEqual(['claude-sonnet-5', 'claude-code', 'high']);
  });

  it('Apply teammate selects Jev’s top fit in the roster', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-teammate'));
    expect(view.launch().teamMemberId).toBe('ent-tm-scout');
  });

  it('Dispatch sends only the subject, whatever was applied', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    fireEvent.click(view.getByTestId('launch-dispatch'));
    expect(view.onDispatch).toHaveBeenCalledWith({ subjectId: 'task-1' });
  });
});

describe('a meter per group', () => {
  it('memories, skills and references each mount one, from launch.defaults without asking Jev', async () => {
    const view = renderSheet({ loadLaunchDefaults: async () => LAUNCH_DEFAULTS });
    await waitFor(() => expect(view.getByTestId('lsel-toggle-memories').textContent).toMatch(/1 default/));
    for (const group of ['memories', 'skills', 'references']) expect(view.getByTestId(`lsel-meter-${group}`)).toBeTruthy();
  });

  it('after an Apply the memories meter measures the launch’s set against Jev’s budget', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    const meter = within(view.getByTestId('lsel-group-memories')).getByTestId('jev-meter-memories');
    expect(meter.textContent).toContain('300 B / 1.0 KB');
  });
});

describe('Budget for this launch', () => {
  const openOverride = (view: ReturnType<typeof renderSheet>) => fireEvent.click(view.getByTestId('launch-budget-toggle'));

  it('is collapsed, and sends nothing until a person fills a group', () => {
    const view = renderSheet();
    expect(view.getByTestId('launch-budget-toggle').getAttribute('aria-expanded')).toBe('false');
    expect(view.queryByTestId('launch-budget-memories')).toBeNull();
    expect('contextBudgets' in view.launch()).toBe(false);
  });

  it('a filled group rides contextBudgets, in the contract’s shape; the others are left out', () => {
    const view = renderSheet();
    openOverride(view);
    fireEvent.change(view.getByTestId('launch-budget-memories'), { target: { value: '4096' } });
    const config = view.launch();
    expect(config.contextBudgets).toEqual({ memories: 4096 });
    expect(ContextBudgetsSchema.safeParse(config.contextBudgets).success).toBe(true);
  });

  it('negative control: a group cleared again is not sent', () => {
    const view = renderSheet();
    openOverride(view);
    fireEvent.change(view.getByTestId('launch-budget-skills'), { target: { value: '2048' } });
    fireEvent.change(view.getByTestId('launch-budget-skills'), { target: { value: '' } });
    expect('contextBudgets' in view.launch()).toBe(false);
  });

  it('past the prompt’s room it warns — and Launch is NOT blocked, the override is still sent', () => {
    const view = renderSheet();
    openOverride(view);
    fireEvent.change(view.getByTestId('launch-budget-skills'), { target: { value: '3000' } });
    expect(view.getByTestId('launch-budget-warning').textContent).toMatch(/Launch still goes/);
    expect((view.getByRole('button', { name: /Launch ▸/ }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.launch().contextBudgets).toEqual({ skills: 3000 });
  });

  it('negative control: within the room there is no warning', () => {
    const view = renderSheet();
    openOverride(view);
    fireEvent.change(view.getByTestId('launch-budget-skills'), { target: { value: '2048' } });
    expect(view.queryByTestId('launch-budget-warning')).toBeNull();
  });

  it('the override replaces the group’s budget in its meter', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-apply-memories'));
    openOverride(view);
    fireEvent.change(view.getByTestId('launch-budget-memories'), { target: { value: '200' } });
    expect(within(view.getByTestId('lsel-group-memories')).getByTestId('lsel-meter-memories').dataset.budgetSource).toBe('override');
    expect(within(view.getByTestId('lsel-group-memories')).getByTestId('jev-meter-memories').dataset.meter).toBe('over');
  });
});

describe('on a phone', () => {
  it('the entry point renders inside the phone sheet', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const port = answeringPort(ANSWER);
    const view = render(
      <div className="cv2-root" data-shell="mobile">
        <MobileSurfaceProvider sheetHost={host}>
          <LaunchSheet
            subjectId={'task-1' as EntityId}
            spaceId="sp-1"
            fromChip="◔ Run ▸"
            fromCaption="task"
            teammates={LAUNCH_TEAMMATES}
            projects={LAUNCH_PROJECTS}
            profiles={LAUNCH_PROFILES}
            memories={LAUNCH_MEMORIES}
            jev={port as JevPort}
            onLaunch={() => {}}
            onCancel={() => {}}
          />
        </MobileSurfaceProvider>
      </div>,
    );
    const sheet = await waitFor(() => within(host).getByTestId('mobile-sheet'));
    await act(async () => { fireEvent.click(within(sheet).getByTestId('jev-entry-button')); });
    expect(within(sheet).getByTestId('jev-panel')).toBeTruthy();
    view.unmount();
    host.remove();
  });
});
