// @vitest-environment jsdom
/**
 * The Work view's half of the keyboard (task 01a113aa): the shell's commands
 * land as the SAME dispatches the pointer makes, the queue carries a command
 * across a navigation to Work, and the browser's row cursor moves, opens and
 * launches.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { installWorkKeys, queueWorkKey, runWorkKey, workKeysMounted } from '../keys';
import { createWorkspaceRuntime } from '../runtime/dispatch';
import { createWorkspaceStore } from '../runtime/store';
import { activeTabId, visibleTabs } from '../runtime/selectors';
import { handleWorkKey } from './useWorkspaceKeys';
import { useListCursor } from './listCursor';

let n = 0;
function runtime() {
  n += 1;
  return createWorkspaceRuntime(`kv-${n}`, `ks-${n}`, createWorkspaceStore(`kv-${n}`, `ks-${n}`));
}

function withTabs(count: number) {
  const rt = runtime();
  for (let i = 1; i <= count; i += 1) {
    rt.dispatch({ command: 'workspace.tabs.open', args: { kind: 'task', entityId: `e${i}` }, source: 'click' });
  }
  return rt;
}

const tabIndex = (rt: ReturnType<typeof runtime>) => {
  const state = rt.store.getState();
  return visibleTabs(state).findIndex((t) => t.id === activeTabId(state));
};

describe('handleWorkKey — tabs', () => {
  it('] and [ cycle the tabs, wrapping', () => {
    const rt = withTabs(3);
    const last = tabIndex(rt);
    handleWorkKey(rt, { command: 'work.tab.next' }, () => {});
    expect(tabIndex(rt)).toBe((last + 1) % 3);
    handleWorkKey(rt, { command: 'work.tab.prev' }, () => {});
    handleWorkKey(rt, { command: 'work.tab.prev' }, () => {});
    expect(tabIndex(rt)).toBe((last + 2) % 3);
  });

  it('1…8 jump to that tab and 9 to the last', () => {
    const rt = withTabs(4);
    handleWorkKey(rt, { command: 'work.tab.nth', ref: '1' }, () => {});
    expect(tabIndex(rt)).toBe(0);
    handleWorkKey(rt, { command: 'work.tab.nth', ref: '9' }, () => {});
    expect(tabIndex(rt)).toBe(3);
    // A position past the end does nothing.
    handleWorkKey(rt, { command: 'work.tab.nth', ref: '7' }, () => {});
    expect(tabIndex(rt)).toBe(3);
  });

  it('w closes the active tab', () => {
    const rt = withTabs(2);
    handleWorkKey(rt, { command: 'work.tab.close' }, () => {});
    expect(visibleTabs(rt.store.getState())).toHaveLength(1);
  });

  it('t f toggles full screen; t l switches the tab to its links', () => {
    const rt = withTabs(1);
    handleWorkKey(rt, { command: 'work.tab.fullscreen' }, () => {});
    expect(rt.store.getState().layout.expanded).toBe(true);
    handleWorkKey(rt, { command: 'work.tab.fullscreen' }, () => {});
    expect(rt.store.getState().layout.expanded).toBe(false);
    handleWorkKey(rt, { command: 'work.tab.section', ref: 'connections' }, () => {});
    const tab = visibleTabs(rt.store.getState())[0];
    expect(tab?.type === 'entity' && tab.ui.subview).toBe('connections');
  });

  it('t c opens and closes the tab chat', () => {
    const rt = withTabs(1);
    const chatOpen = () => {
      const tab = visibleTabs(rt.store.getState())[0];
      return tab?.type === 'entity' ? (tab.ui.chat?.open ?? false) : null;
    };
    handleWorkKey(rt, { command: 'work.tab.chat' }, () => {});
    expect(chatOpen()).toBe(true);
    handleWorkKey(rt, { command: 'work.tab.chat' }, () => {});
    expect(chatOpen()).toBe(false);
  });
});

describe('handleWorkKey — creation and the browser', () => {
  it('n t opens a New task draft tab', () => {
    const rt = runtime();
    handleWorkKey(rt, { command: 'work.create', ref: 'task' }, () => {});
    const tabs = visibleTabs(rt.store.getState());
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ type: 'draft', kind: 'task' });
  });

  it('c drafts the browser’s current kind', () => {
    const rt = runtime();
    rt.dispatch({ command: 'workspace.browser.set', args: { browserId: 'main', kind: 'doc' }, source: 'click' });
    handleWorkKey(rt, { command: 'list.create' }, () => {});
    expect(visibleTabs(rt.store.getState())[0]).toMatchObject({ type: 'draft', kind: 'doc' });
  });

  it('refuses a kind that cannot be created here, and says so', () => {
    const rt = runtime();
    const notify = vi.fn();
    handleWorkKey(rt, { command: 'work.create', ref: 'artifact' }, notify);
    expect(visibleTabs(rt.store.getState())).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/can't be created here/));
  });

  it('l t switches the browser to tasks and brings it back from full screen', () => {
    const rt = runtime();
    rt.dispatch({ command: 'workspace.layout.set', args: { expanded: true }, source: 'click' });
    handleWorkKey(rt, { command: 'work.browser.focus', ref: 'work_session' }, () => {});
    expect(rt.store.getState().browsers.main.kind).toBe('work_session');
    expect(rt.store.getState().layout.expanded).toBe(false);
  });

  it('r on a tab with nothing to launch says so', () => {
    const rt = withTabs(1);
    const notify = vi.fn();
    handleWorkKey(rt, { command: 'work.launch' }, notify);
    expect(notify).toHaveBeenCalledWith('Nothing to launch on this tab.');
  });
});

describe('the shell → Work queue', () => {
  it('runs a queued command when Work installs, once', () => {
    const seen: string[] = [];
    queueWorkKey({ command: 'work.create', ref: 'task' });
    expect(workKeysMounted()).toBe(false);
    const uninstall = installWorkKeys((key) => {
      seen.push(`${key.command}:${key.ref}`);
      return true;
    });
    expect(seen).toEqual(['work.create:task']);
    expect(runWorkKey({ command: 'work.tab.next' })).toBe(true);
    uninstall();
    expect(workKeysMounted()).toBe(false);
    expect(runWorkKey({ command: 'work.tab.next' })).toBe(false);
    expect(seen).toEqual(['work.create:task', 'work.tab.next:undefined']);
  });
});

function CursorHarness({ open, onLaunch }: { open: (id: string) => void; onLaunch: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const cursor = useListCursor(ref, open, () => {});
  return (
    <div ref={ref} tabIndex={-1} data-testid="list" onFocus={cursor.onFocus} onBlur={cursor.onBlur} onKeyDown={cursor.onKeyDown}>
      {['a', 'b', 'c'].map((id) => (
        <div key={id} className="lp__branch">
          <div data-flight-anchor={id}>
            {id}
            <button type="button" data-action="run" onClick={() => onLaunch(id)}>
              Run
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

describe('the Work browser row cursor', () => {
  const cursorId = (root: HTMLElement) => root.querySelector('[data-kbd-cursor]')?.getAttribute('data-flight-anchor');

  it('focus lands on the first row; j/k move; Enter opens; r launches', () => {
    const open = vi.fn();
    const onLaunch = vi.fn();
    const { getByTestId } = render(<CursorHarness open={open} onLaunch={onLaunch} />);
    const list = getByTestId('list');
    list.focus();
    expect(cursorId(list)).toBe('a');
    fireEvent.keyDown(list, { key: 'j' });
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    expect(cursorId(list)).toBe('c');
    fireEvent.keyDown(list, { key: 'j' });
    expect(cursorId(list)).toBe('c'); // clamps at the end
    fireEvent.keyDown(list, { key: 'k' });
    expect(cursorId(list)).toBe('b');
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(open).toHaveBeenCalledWith('b');
    fireEvent.keyDown(list, { key: 'r' });
    expect(onLaunch).toHaveBeenCalledWith('b');
  });

  it('lets other keys through to the shell, and ignores keys from inside a row', () => {
    const { getByTestId, getAllByText } = render(<CursorHarness open={() => {}} onLaunch={() => {}} />);
    const list = getByTestId('list');
    list.focus();
    const chord = new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true });
    list.dispatchEvent(chord);
    expect(chord.defaultPrevented).toBe(false);
    fireEvent.keyDown(getAllByText('Run')[0]!, { key: 'j' });
    expect(cursorId(list)).toBe('a');
  });

  it('Esc leaves the list', () => {
    const { getByTestId } = render(<CursorHarness open={() => {}} onLaunch={() => {}} />);
    const list = getByTestId('list');
    list.focus();
    fireEvent.keyDown(list, { key: 'Escape' });
    expect(document.activeElement).not.toBe(list);
    expect(cursorId(list)).toBeUndefined();
  });
});
