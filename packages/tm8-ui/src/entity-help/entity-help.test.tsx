// @vitest-environment jsdom
/**
 * ENTITY HELP — the shell, the theme's motion fallback, the baseline and
 * the live toolkit (task 01a0e7d6, Wave 0; decisions from form 01a0e7d3).
 *
 * The host here is the smallest honest one: the real `ListRootHeader` (the
 * (?) marks live there) beside a region-B box that mounts the real overlay —
 * the same two pieces Home and the Workspace compose.
 */
import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commands } from '@tm8/cli/discovery';
import { homeRootKinds } from '../domain';
import { ListRootHeader, type ListRootOption } from '../panels/ListRootHeader';
import { EntityHelpOverlay } from './EntityHelpOverlay';
import { commandByPath } from './catalog';
import { entityHelpStore, resetEntityHelp } from './entityHelpStore';
import { registeredHelpModules } from './kinds';
import { TEMPLATE_HELP } from './kinds/_template';
import { MotionProvider } from './motion/MotionContext';
import { TypedTerminal } from './motion/TypedTerminal';
import { resolveHelp } from './resolve';
import { HELP_TABS } from './types';

const OPTIONS: ListRootOption[] = homeRootKinds().map((k) => ({
  kind: k.kind,
  label: k.labelPlural,
  single: k.label,
}));
const TASK = OPTIONS.find((o) => o.kind === 'task')!;

function renderHost(reducedMotion = true) {
  return render(
    <div className="cv2-root">
      <ListRootHeader
        rootsLabel="Home roots"
        cell={TASK}
        cellActive
        onSelectCell={() => undefined}
        options={OPTIONS}
        onPickKind={() => undefined}
      />
      <div style={{ position: 'relative' }} data-testid="region-b">
        <EntityHelpOverlay reducedMotion={reducedMotion} />
      </div>
    </div>,
  );
}

const dialogOf = (view: ReturnType<typeof render>) => view.getByRole('dialog', { name: 'Tasks' });

beforeEach(() => resetEntityHelp());
afterEach(() => resetEntityHelp());

describe('the (?) mark', () => {
  it('sits beside the kind name in the cell and on every dropdown row, named "Help for <Kind label>"', () => {
    const view = renderHost();
    expect(view.getByRole('button', { name: 'Help for Tasks' })).toBeTruthy();
    fireEvent.click(view.getByLabelText('Choose which list to show'));
    const menu = within(view.getByRole('menu', { name: 'Entity lists' }));
    for (const option of OPTIONS) {
      expect(menu.getByRole('button', { name: `Help for ${option.label}` })).toBeTruthy();
    }
    /* Never a menu item: the menu still offers exactly one item per kind. */
    expect(menu.getAllByRole('menuitem')).toHaveLength(OPTIONS.length);
  });

  it('keeps every existing accessible name verbatim', () => {
    const view = renderHost();
    expect(view.getByRole('tab', { name: 'Tasks' })).toBeTruthy();
    expect(view.getByRole('button', { name: 'New task' })).toBeTruthy();
    expect(view.getByLabelText('Choose which list to show')).toBeTruthy();
    expect(view.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Tasks']);
  });

  it('opens that kind — from the cell, and from a row (which also closes the menu)', () => {
    const view = renderHost();
    fireEvent.click(view.getByRole('button', { name: 'Help for Tasks' }));
    expect(dialogOf(view).getAttribute('data-kind')).toBe('task');
    fireEvent.click(view.getByLabelText('Choose which list to show'));
    fireEvent.click(view.getByRole('button', { name: 'Help for Docs' }));
    expect(view.queryByRole('menu')).toBeNull();
    expect(view.getByRole('dialog', { name: 'Docs' }).getAttribute('data-kind')).toBe('doc');
  });
});

describe('the overlay shell', () => {
  it('covers region B only, moves focus to the selected tab, and hands it back on close', () => {
    const view = renderHost();
    const mark = view.getByRole('button', { name: 'Help for Tasks' });
    mark.focus();
    fireEvent.click(mark);
    const dialog = dialogOf(view);
    expect(view.getByTestId('region-b').contains(dialog)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole('tab', { name: /Story/ }));
    /* The list is still there and still a control. */
    expect(view.getByRole('tab', { name: 'Tasks' })).toBeTruthy();

    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(mark);
  });

  it('closes on the ✕ button', () => {
    const view = renderHost();
    fireEvent.click(view.getByRole('button', { name: 'Help for Tasks' }));
    fireEvent.click(within(dialogOf(view)).getByRole('button', { name: 'Close help' }));
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('Esc is stopped at the dialog so a host Esc handler underneath does not also fire', () => {
    const outer = vi.fn();
    const view = render(
      <div className="cv2-root" onKeyDown={outer}>
        <div style={{ position: 'relative' }}>
          <EntityHelpOverlay reducedMotion />
        </div>
      </div>,
    );
    act(() => entityHelpStore.getState().open('task'));
    fireEvent.keyDown(view.getByRole('dialog'), { key: 'Escape' });
    expect(outer).not.toHaveBeenCalled();
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('tabs are Story / Toolkit / Constellation, in that order, and the arrow keys walk them', () => {
    const view = renderHost();
    fireEvent.click(view.getByRole('button', { name: 'Help for Tasks' }));
    const dialog = dialogOf(view);
    const tabs = within(dialog).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent?.replace(/^\d+/, ''))).toEqual(['Story', 'Toolkit', 'Constellation']);
    expect(HELP_TABS.map((t) => t.id)).toEqual(['story', 'toolkit', 'constellation']);

    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(dialog.getAttribute('data-tab')).toBe('toolkit');
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1]!, { key: 'End' });
    expect(dialog.getAttribute('data-tab')).toBe('constellation');
    fireEvent.keyDown(tabs[2]!, { key: 'ArrowRight' });
    expect(dialog.getAttribute('data-tab')).toBe('story');
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowLeft' });
    expect(dialog.getAttribute('data-tab')).toBe('constellation');
    fireEvent.keyDown(tabs[2]!, { key: 'Home' });
    expect(dialog.getAttribute('data-tab')).toBe('story');
    /* The tabpanel names its tab. */
    expect(within(dialog).getByRole('tabpanel').getAttribute('aria-labelledby')).toBe('eh-tab-story');
  });

  it('Tab wraps inside the dialog in both directions', () => {
    const view = renderHost();
    fireEvent.click(view.getByRole('button', { name: 'Help for Tasks' }));
    const dialog = dialogOf(view);
    const close = within(dialog).getByRole('button', { name: 'Close help' });
    const focusable = [
      ...dialog.querySelectorAll<HTMLElement>('button:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])'),
    ].filter((el) => !el.closest('[aria-hidden="true"]'));
    const last = focusable[focusable.length - 1]!;
    last.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('a Constellation neighbour opens that kind, with a way back', () => {
    const view = renderHost();
    fireEvent.click(view.getByRole('button', { name: 'Help for Tasks' }));
    act(() => entityHelpStore.getState().setTab('constellation'));
    const graph = within(view.getByTestId('constellation-graph'));
    fireEvent.click(graph.getByRole('button', { name: 'Open help for Teammates' }));
    const teammates = view.getByRole('dialog', { name: 'Teammates' });
    expect(teammates.getAttribute('data-kind')).toBe('team_member');
    fireEvent.click(within(teammates).getByRole('button', { name: /Back to Tasks/ }));
    expect(dialogOf(view).getAttribute('data-kind')).toBe('task');
    expect(view.queryByRole('button', { name: /Back to/ })).toBeNull();
  });
});

describe('the baseline — every dropdown kind has a full page', () => {
  it.each(homeRootKinds().map((k) => [k.kind, k.labelPlural]))('%s (%s) resolves three non-empty tabs', (kind) => {
    const page = resolveHelp(kind);
    expect(page.story.logline.length).toBeGreaterThan(20);
    expect(page.story.beats.length).toBeGreaterThanOrEqual(3);
    expect(page.story.lifecycle?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(page.toolkit.scenes.length).toBeGreaterThanOrEqual(1);
    expect(page.toolkit.catalog.own.length + page.toolkit.catalog.generic.length).toBeGreaterThan(5);
    expect(page.authored).toEqual({ story: false, toolkit: false, constellation: false });
  });

  it.each(homeRootKinds().map((k) => [k.kind, k.labelPlural]))('%s (%s) renders text on every tab', (kind) => {
    const view = render(
      <div className="cv2-root">
        <div style={{ position: 'relative' }}>
          <EntityHelpOverlay reducedMotion />
        </div>
      </div>,
    );
    act(() => entityHelpStore.getState().open(kind));
    const dialog = view.getByRole('dialog');
    for (const tab of HELP_TABS) {
      act(() => entityHelpStore.getState().setTab(tab.id));
      const panel = within(dialog).getByRole('tabpanel');
      expect(panel.textContent?.trim().length, `${kind}/${tab.id}`).toBeGreaterThan(80);
      if (tab.id === 'toolkit') expect(within(panel).getAllByTestId('toolkit-command').length).toBeGreaterThan(0);
      if (tab.id === 'constellation') {
        expect(panel.querySelectorAll('.eh-relation').length).toBeGreaterThan(0);
      }
    }
    view.unmount();
  });
});

describe('the toolkit reads the live catalog', () => {
  it('prints the catalog’s own syntax for a task verb, verbatim', () => {
    const view = renderHost();
    fireEvent.click(view.getByRole('button', { name: 'Help for Tasks' }));
    act(() => entityHelpStore.getState().setTab('toolkit'));
    const tick = commandByPath('task tick')!;
    const card = within(dialogOf(view)).getByTestId('entity-help-toolkit').querySelector('[data-command="task tick"]')!;
    expect(card.textContent).toContain(tick.summary);
    expect(card.querySelector('.eh-cmd__syntax')?.textContent).toBe(`tm8 ${tick.syntax.replace(/^tm8 /, '')}`);
  });

  it('every registered module names a dropdown kind and only commands the catalog knows', () => {
    const kinds = new Set(homeRootKinds().map((k) => k.kind));
    const paths = new Set(commands().map((row) => row.command));
    for (const module of registeredHelpModules()) {
      expect(kinds.has(module.kind), module.kind).toBe(true);
      for (const scene of module.toolkit?.scenes ?? []) {
        for (const path of scene.commands) expect(paths.has(path), `${module.kind}: ${path}`).toBe(true);
      }
    }
    /* The template's command paths are real too, so a copy starts green. */
    for (const scene of TEMPLATE_HELP.toolkit?.scenes ?? []) {
      for (const path of scene.commands) expect(paths.has(path), path).toBe(true);
    }
  });
});

describe('motion', () => {
  it('types the terminal under rich motion and shows it whole under reduced motion', () => {
    vi.useFakeTimers();
    try {
      const rich = render(
        <MotionProvider reduced={false}>
          <TypedTerminal lines={['# hi', 'tm8 entity context <id>']} speed={1} lineGap={1} delay={1} />
        </MotionProvider>,
      );
      const richScreen = rich.container.querySelector('.eh-term__screen')!;
      expect(rich.container.querySelector('.eh-term')?.getAttribute('data-typed')).toBe('typing');
      expect(richScreen.textContent?.trim()).toBe('');
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(rich.container.querySelector('.eh-term')?.getAttribute('data-typed')).toBe('complete');
      expect(richScreen.textContent).toContain('tm8 entity context <id>');
      /* The screen reader copy was whole from the first frame. */
      expect(rich.container.querySelector('.eh-sr-only')?.textContent).toBe('# hi\ntm8 entity context <id>');

      const still = render(
        <MotionProvider reduced>
          <TypedTerminal lines={['tm8 entity get <id>']} />
        </MotionProvider>,
      );
      expect(still.container.querySelector('.eh-term')?.getAttribute('data-typed')).toBe('complete');
      expect(still.container.querySelector('.eh-term__screen')?.textContent).toContain('tm8 entity get <id>');
      expect(still.container.querySelector('.eh-term__replay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the overlay marks its motion mode and stills every reveal under reduced motion', () => {
    const view = renderHost(true);
    fireEvent.click(view.getByRole('button', { name: 'Help for Tasks' }));
    const dialog = dialogOf(view);
    expect(dialog.getAttribute('data-motion')).toBe('reduced');
    expect(dialog.querySelectorAll('.eh-reveal').length).toBeGreaterThan(0);
    expect(dialog.querySelectorAll('.eh-reveal:not(.eh-reveal--still)').length).toBe(0);
  });
});
