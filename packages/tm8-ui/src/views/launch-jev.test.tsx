// @vitest-environment jsdom
/**
 * ✦ Ask Jev on LaunchSheet (design 01a0cb80 §3.1, lane U).
 *
 * What must hold: the button sits between Cancel and Dispatch; each group's
 * answer lands INSIDE its own section; Apply sets model, tool and effort
 * together or says why it can't; in Jev mode the checklists replace the
 * additive memory picker and the read-only skill preview; Launch carries
 * exactly the ticked `selection` + `jevRunId`; Dispatch carries nothing new;
 * and a launch without Ask Jev is identical to today's.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import type { CredentialsStatusView, EntityId, LaunchSuggestResult, ModelSuggestion } from '@tm8/contract';

import { LaunchSheet, type LaunchSelection } from './LaunchSheet';
import { LAUNCH_CAPACITY, LAUNCH_MEMORIES, LAUNCH_PROFILES, LAUNCH_PROJECTS, LAUNCH_TEAMMATES, LAUNCH_DEFAULTS } from './launch-fixtures';
import { MobileSurfaceProvider } from '../mobile';
import { JEV_ADD_KEY_COPY, JEV_UNAVAILABLE_COPY } from '../jev';
import { navStore } from '../stores/navStore';
import type { JevPort } from '../jev/port';
import { answeringPort, failedGroup, MODEL, okGroup, pendingPort, answer } from '../jev/test-support';

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

async function asked(over: Partial<LaunchSuggestResult['groups']> = {}, props: Partial<SheetProps> = {}) {
  const port = answeringPort(over);
  const view = renderSheet({ jev: port, ...props });
  await act(async () => { fireEvent.click(view.getByTestId('jev-ask')); });
  await waitFor(() => expect(view.getByTestId('jev-model-hint')).toBeTruthy());
  return { ...view, port };
}

const sectionOf = (el: HTMLElement) => el.closest('.ls__section') as HTMLElement;

describe('the button', () => {
  it('sits in the footer between Cancel and Dispatch, beside Launch', () => {
    const { container } = renderSheet({ jev: pendingPort() });
    const footer = container.querySelector('.ls__foot')!;
    const labels = [...footer.querySelectorAll('button')].map((b) => b.textContent);
    expect(labels).toEqual(['Cancel', '✦ Ask Jev', 'Dispatch ⇥', 'Launch ▸']);
  });

  it('shows Asking… while asking — and Launch stays enabled', () => {
    const view = renderSheet({ jev: pendingPort() });
    fireEvent.click(view.getByTestId('jev-ask'));
    expect(view.getByTestId('jev-ask').textContent).toBe('Asking…');
    const launchButton = view.getByRole('button', { name: /Launch ▸/ }) as HTMLButtonElement;
    expect(launchButton.disabled).toBe(false);
    // …and a launch now goes out with today's defaults: no selection.
    const config = view.launch();
    expect(config.selection).toBeUndefined();
    expect(config.jevRunId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is refused with the reason, never hidden, when the surface has no Jev port', () => {
    const view = renderSheet();
    const button = view.getByTestId('jev-ask');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toMatch(/isn’t wired/);
  });
});

describe('each group lands inside its own section', () => {
  it('teammate ranks under the teammate picker, the model hint under model and effort', async () => {
    const view = await asked();
    const ranks = view.getByTestId('jev-teammate-ranks');
    expect(within(sectionOf(ranks)).getByRole('radiogroup', { name: 'Teammates' })).toBeTruthy();
    const hint = view.getByTestId('jev-model-hint');
    expect(within(sectionOf(hint)).getByTestId('launch-reasoning-effort')).toBeTruthy();
    expect(hint.textContent).toContain('✦ Jev: Claude Sonnet 5 · high · standard');
    // Each group shows its own cost, and the run footer the total.
    expect(within(hint).getByText('$0.00004 · 0.4 s')).toBeTruthy();
    expect(view.getByTestId('jev-run-cost').textContent).toBe('✦ 7 calls · 1.1 s · $0.00021');
  });

  it('a rank click selects that teammate', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-rank-ent-tm-scout'));
    const scout = view.getByRole('radio', { name: /scout/ });
    expect(scout.getAttribute('aria-checked')).toBe('true');
    expect(view.launch().teamMemberId).toBe('ent-tm-scout');
  });

  it('says "Nobody fits well" when Jev found no fit', async () => {
    const view = await asked({ teammates: okGroup({ items: [], noFit: true }) });
    expect(view.getByTestId('jev-nofit').textContent).toBe('Nobody fits well');
  });

  it('one failed group shows its reason and Retry in its own section only', async () => {
    const view = await asked({ skills: failedGroup('timeout') });
    const status = view.getByTestId('jev-skills-status');
    expect(status.textContent).toMatch(/timed out/);
    expect(within(status).getByTestId('jev-skills-retry')).toBeTruthy();
    expect(view.queryByTestId('jev-memories-status')).toBeNull();
    // Launch says it will send the defaults, naming the failed group.
    expect(view.getByTestId('jev-launch-note').textContent).toMatch(/Skills failed \(timeout\)/);
    // PER GROUP (I9): the answered memories still go; the failed skills group
    // keeps its defaults, and the audit says Jev failed it.
    const config = view.launch();
    expect(config.selection).toEqual({ memoryIds: ['mem-a', 'mem-b'] });
    expect(config.selectionReasons).toEqual({ skills: 'jev-failed', references: 'not-asked' });
  });

  it('with no key anywhere it says the TypeSafe key is missing, links to Settings, and Launch is unaffected', async () => {
    const port = answeringPort({
      model: failedGroup('no_key'), teammates: failedGroup('no_key'),
      memories: failedGroup('no_key'), skills: failedGroup('no_key'),
      // I7: references is a fifth group, asked with the rest; the server answers it no_key too.
      references: failedGroup('no_key'),
    });
    const view = renderSheet({ jev: port });
    await act(async () => { fireEvent.click(view.getByTestId('jev-ask')); });
    expect(view.getByTestId('jev-unavailable').textContent).toBe(`${JEV_UNAVAILABLE_COPY} ${JEV_ADD_KEY_COPY}`);
    // Said ONCE, inline — a missing key, not five section failures.
    expect(view.getAllByText(new RegExp(JEV_UNAVAILABLE_COPY))).toHaveLength(1);
    // Actionable (Lane K): the link lands on Settings → Agent credentials.
    navStore.getState().navigate({ view: 'home' });
    fireEvent.click(view.getByTestId('jev-add-key'));
    expect(navStore.getState().view).toEqual({ view: 'settings', section: 'credentials' });
    const config = view.launch();
    expect(config.selection).toBeUndefined();
    expect(config.model).toBe('claude-sonnet-5');
  });
});

describe('Apply', () => {
  const CODEX: ModelSuggestion = { ...MODEL, model: 'gpt-5.6-sol', agentTool: 'codex', effort: 'xhigh', tier: 'premium' };

  it('sets model, tool and effort TOGETHER through the sheet’s own controls', async () => {
    const view = await asked({ model: okGroup(CODEX) });
    fireEvent.click(view.getByTestId('jev-model-apply'));
    expect((view.getByTestId('launch-model') as HTMLSelectElement).value).toBe('gpt-5.6-sol');
    expect((view.getByTestId('launch-reasoning-effort') as HTMLSelectElement).value).toBe('xhigh');
    const config = view.launch();
    expect(config).toMatchObject({ agentToolId: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'xhigh' });
    expect(view.getByTestId('jev-model-apply').textContent).toBe('Applied ✓');
  });

  it('changes nothing until clicked', async () => {
    const view = await asked({ model: okGroup(CODEX) });
    expect(view.launch()).toMatchObject({ agentToolId: 'claude-code', model: 'claude-sonnet-5', reasoningEffort: 'low' });
  });

  it.each([
    ['a model this node does not offer', { ...MODEL, model: 'claude-imaginary-9' }, /isn’t in this node’s model catalog/],
    ['a Kimi model (never suggested)', { ...MODEL, model: 'kimi-k2-thinking' }, /never suggests Kimi or Groq/],
    ['a Groq model (never suggested)', { ...MODEL, model: 'openai/gpt-oss-120b', agentTool: 'codex' as const, effort: 'high' as const }, /never suggests Kimi or Groq/],
    ['a model on the wrong tool', { ...MODEL, agentTool: 'codex' as const }, /runs Claude Sonnet 5 on claude-code, not codex/],
    ['an effort the model does not take', { ...MODEL, effort: 'xhigh' as const }, /takes no “xhigh” reasoning effort/],
  ])('is refused with the reason for %s', async (_name, suggestion, reason) => {
    const view = await asked({ model: okGroup(suggestion) });
    const apply = view.getByTestId('jev-model-apply');
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    expect(view.getByTestId('jev-model-refusal').textContent).toMatch(reason);
    fireEvent.click(apply);
    expect(view.launch()).toMatchObject({ agentToolId: 'claude-code', model: 'claude-sonnet-5', reasoningEffort: 'low' });
  });

  it('is refused when the viewer chose their own credential for that provider and it is not connected', async () => {
    const status: CredentialsStatusView = {
      providers: [{ provider: 'anthropic', connected: false, login: null, authMethod: null, status: null, connectedAt: null, lastVerifiedAt: null }],
      gitCredentialStore: 'present',
    };
    const view = renderSheet({ jev: answeringPort({ model: okGroup({ ...MODEL, model: 'claude-opus-5' }) }), loadCredentialStatus: () => Promise.resolve(status) });
    await waitFor(() => expect(view.getByTestId('launch-agent-identity').textContent).not.toMatch(/Checking/));
    fireEvent.change(view.getByTestId('launch-agent-credential-source'), { target: { value: 'member' } });
    await act(async () => { fireEvent.click(view.getByTestId('jev-ask')); });
    expect(view.getByTestId('jev-model-apply').getAttribute('aria-disabled')).toBe('true');
    expect(view.getByTestId('jev-model-refusal').textContent).toMatch(/your Anthropic credential, and it isn’t connected/);
  });
});

describe('Jev mode', () => {
  it('the memory checklist replaces the memories group, and the skill checklist the preview', async () => {
    const loadSkillPreview = vi.fn(() => new Promise<never>(() => {}));
    const port = pendingPort();
    const view = renderSheet({ jev: port, loadSkillPreview });
    expect(view.getByTestId('lsel-group-memories')).toBeTruthy();
    expect(view.getByText('Loading skill preview…')).toBeTruthy();

    fireEvent.click(view.getByTestId('jev-ask'));
    await act(async () => port.calls[0]!.resolve(answer(port.calls[0]!.input)));

    expect(view.queryByTestId('lsel-group-memories')).toBeNull();
    expect(view.queryByText('Loading skill preview…')).toBeNull();
    // Jev does not rank references: that group stays the sheet's own.
    expect(view.getByTestId('lsel-group-references')).toBeTruthy();
    const memories = view.getByTestId('jev-checklist-memory');
    const skills = view.getByTestId('jev-checklist-skill');
    expect(within(sectionOf(memories)).getByText('MEMORIES')).toBeTruthy();
    expect(within(sectionOf(skills)).getByText('SKILLS')).toBeTruthy();
    expect(view.getByTestId('jev-memory-count').textContent).toBe('✦ 2 of 3 ticked · exact set');
    expect(view.getByTestId('jev-skill-considered').textContent).toBe('2 of 812 considered');
    // Level and every source on the row.
    const row = view.getByTestId('jev-row-mem-a');
    expect(row.textContent).toContain('critical');
    expect(row.textContent).toContain('teammate · space');
  });

  it('Launch carries exactly the ticked selection and the run — and no memoryIds', async () => {
    const view = await asked();
    // A pick made in the additive picker BEFORE Jev must not ride along.
    fireEvent.click(view.getByTestId('jev-row-mem-b').querySelector('input')!);
    fireEvent.click(view.getByTestId('jev-row-sk-b').querySelector('input')!);
    const config = view.launch();
    expect(config.selection).toEqual({ memoryIds: ['mem-a'], skillIds: ['sk-a', 'sk-b'] });
    expect(config.jevRunId).toBe(view.port.inputs[0]!.runId);
    expect('memoryIds' in config).toBe(false);
  });

  it('a memories edit made before Ask Jev gives way to Jev’s exact set; a references edit stays', async () => {
    const port = answeringPort();
    const view = renderSheet({ jev: port, loadLaunchDefaults: async () => LAUNCH_DEFAULTS });
    await waitFor(() => expect(view.getByTestId('lsel-toggle-memories').textContent).toMatch(/1 default/));
    fireEvent.click(view.getByTestId('lsel-toggle-memories'));
    fireEvent.click(view.getByTestId('lsel-toggle-references'));
    fireEvent.click(view.getByTestId('lsel-row-memories-ent-mem-tokens'));
    fireEvent.click(view.getByTestId('lsel-row-references-ent-file-log'));
    await act(async () => { fireEvent.click(view.getByTestId('jev-ask')); });
    const config = view.launch();
    expect(config.selection).toEqual({ memoryIds: ['mem-a', 'mem-b'], skillIds: ['sk-a'], referenceIds: ['ent-doc-spec'] });
    expect('selectionReasons' in config).toBe(false);
    expect('memoryIds' in config).toBe(false);
  });

  it('a teammate change re-asks memories and skills in the same run', async () => {
    const view = await asked();
    fireEvent.click(view.getByRole('radio', { name: /scout/ }));
    await waitFor(() => expect(view.port.inputs).toHaveLength(2));
    const [first, second] = view.port.inputs;
    expect(second!.groups).toEqual(['memories', 'skills']);
    expect(second!.teamMemberId).toBe('ent-tm-scout');
    expect(second!.runId).toBe(first!.runId);
    expect(second!.requestId).not.toBe(first!.requestId);
  });

  it('Reset to defaults returns the groups and the preview, and Launch sends no selection', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-reset'));
    expect(view.getByTestId('lsel-group-memories')).toBeTruthy();
    expect(view.queryByTestId('jev-checklist-memory')).toBeNull();
    const config = view.launch();
    expect(config.selection).toBeUndefined();
    expect(config.jevRunId).toBe(view.port.inputs[0]!.runId);
  });
});

describe('what Ask Jev does NOT change', () => {
  it('Dispatch sends only the subject, whatever Jev suggested and whatever is ticked', async () => {
    const view = await asked();
    fireEvent.click(view.getByTestId('jev-model-apply'));
    fireEvent.click(view.getByTestId('launch-dispatch'));
    expect(view.onDispatch).toHaveBeenCalledWith({ subjectId: 'task-1' });
    expect(Object.keys(view.onDispatch.mock.calls[0]![0] as object)).toEqual(['subjectId']);
  });

  it('without pressing Ask Jev, the launch payload is identical to a sheet with no Jev at all', () => {
    const withJev = renderSheet({ jev: pendingPort() });
    const a = withJev.launch();
    withJev.unmount();
    const without = renderSheet();
    const b = without.launch();
    expect(a).toEqual(b);
    expect('selection' in a).toBe(false);
    expect('jevRunId' in a).toBe(false);
  });
});

describe('on a phone', () => {
  it('the checklists render inside the phone sheet', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const port = answeringPort();
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
    await act(async () => { fireEvent.click(within(sheet).getByTestId('jev-ask')); });
    expect(within(sheet).getByTestId('jev-checklist-memory')).toBeTruthy();
    expect(within(sheet).getByTestId('jev-checklist-skill')).toBeTruthy();
    view.unmount();
    host.remove();
  });
});
