/**
 * The mounted Work view's half of the keyboard (task 01a113aa): the commands
 * the shell hands over through `../keys.ts`, acted on with the SAME dispatches
 * the pointer uses — the tab strip's activate/close, the browser's new box,
 * the action strip's section, chat and expand buttons. No second path.
 */
import { useEffect } from 'react';
import { installTerminalArrowScroll } from './terminalArrowScroll';
import { NOTICE_TTL_MS, type Notice } from '../../shell';
import { canCreateKind, getKindAdapter } from '../adapters/registry';
import { installWorkKeys, type WorkKey } from '../keys';
import type { WorkspaceRuntime } from '../runtime/dispatch';
import { activeTab, activeTabId, visibleTabs } from '../runtime/selectors';
import { isWorkspaceKind, TAB_SUBVIEWS, type KindId, type TabSubview } from '../runtime/types';

/** The launch verbs a panel draws as its primary (`panel-primary-{ref}`), in preference order. */
const LAUNCH_PRIMARIES = ['run', 'launch-session', 'coordinate'];

/** Run `fn` once React has painted what a dispatch just changed. */
function afterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

/** Focus the Work browser's list; it puts its row cursor on the first row. */
export function focusWorkBrowser(): boolean {
  const list = document.querySelector<HTMLElement>('[data-testid="tws-browser-list"]');
  if (!list) return false;
  list.focus();
  return true;
}

/** Focus the open tab's Links list; it puts its row cursor on the first row. */
export function focusLinksList(): boolean {
  const list = document.querySelector<HTMLElement>('[data-testid="tws-content"] [data-testid="pn-peers-list"]');
  if (!list) return false;
  list.focus();
  return true;
}

/** Click the first launch verb inside `root`, as the pointer would. */
export function clickLaunch(root: ParentNode): boolean {
  for (const ref of LAUNCH_PRIMARIES) {
    const button = root.querySelector<HTMLButtonElement>(
      `[data-testid="panel-primary-${ref}"]:not(:disabled), button[data-action="${ref}"]:not(:disabled)`,
    );
    if (button) {
      button.click();
      return true;
    }
  }
  return false;
}

export function handleWorkKey(
  runtime: WorkspaceRuntime,
  key: WorkKey,
  notify: (text: string) => void,
): boolean {
  const { dispatch, store } = runtime;
  const state = store.getState();
  // A blocking prompt (discard, reveal) owns the moment; keys wait.
  if (state.pending) return true;
  const ids = visibleTabs(state).map((t) => t.id);
  const current = activeTabId(state);
  const tab = activeTab(state);
  const entityTab = tab?.type === 'entity' ? tab : null;
  const activate = (tabId: string | undefined) => {
    if (tabId) dispatch({ command: 'workspace.tabs.activate', args: { tabId }, source: 'keyboard' });
  };
  const create = (kind: KindId) => {
    if (!canCreateKind(kind)) {
      notify(`${getKindAdapter(kind).nounPlural} can't be created here.`);
      return;
    }
    dispatch({ command: 'workspace.drafts.open', args: { kind }, source: 'keyboard' });
  };

  switch (key.command) {
    case 'work.tab.next':
    case 'work.tab.prev': {
      if (ids.length === 0) return true;
      const at = current ? ids.indexOf(current) : -1;
      const delta = key.command === 'work.tab.next' ? 1 : -1;
      activate(ids[at < 0 ? (delta > 0 ? 0 : ids.length - 1) : (at + delta + ids.length) % ids.length]);
      return true;
    }
    case 'work.tab.nth': {
      const n = Number(key.ref);
      // `9` is the last tab, as in every browser.
      activate(n === 9 ? ids[ids.length - 1] : ids[n - 1]);
      return true;
    }
    case 'work.tab.close':
      if (current) dispatch({ command: 'workspace.tabs.close', args: { tabId: current }, source: 'keyboard' });
      return true;
    case 'work.create':
      if (key.ref && isWorkspaceKind(key.ref)) create(key.ref);
      return true;
    case 'list.create':
      create(state.browsers.main.kind);
      return true;
    case 'work.browser.focus': {
      if (key.ref && isWorkspaceKind(key.ref) && key.ref !== state.browsers.main.kind) {
        dispatch({ command: 'workspace.browser.set', args: { browserId: 'main', kind: key.ref }, source: 'keyboard' });
      }
      // Full screen hides the browser; asking for the list brings it back.
      if (state.layout.expanded) dispatch({ command: 'workspace.layout.set', args: { expanded: false }, source: 'keyboard' });
      afterPaint(() => void focusWorkBrowser());
      return true;
    }
    case 'work.tab.section': {
      if (!entityTab) return true;
      const subview = key.ref as TabSubview;
      if (!TAB_SUBVIEWS.includes(subview)) return true;
      dispatch({ command: 'workspace.tabs.setUi', args: { tabId: entityTab.id, patch: { subview } }, source: 'keyboard' });
      // `t l` lands IN the links, not merely on them: the list takes focus so
      // j/k/Enter work at once (task 01a11567). Nothing linked ⇒ no list, and
      // the section switch alone is the whole effect.
      if (subview === 'connections') afterPaint(() => void focusLinksList());
      return true;
    }
    case 'work.tab.chat':
    case 'work.chat.focus': {
      if (!entityTab || !getKindAdapter(entityTab.kind).supportsChat) {
        notify('This tab has no chat.');
        return true;
      }
      const open = entityTab.ui.chat?.open ?? false;
      const toggle = key.command === 'work.tab.chat';
      if (toggle || !open) {
        dispatch({
          command: 'workspace.tabs.setUi',
          args: { tabId: entityTab.id, patch: { chat: { open: toggle ? !open : true } } },
          source: 'keyboard',
        });
      }
      if (!toggle || !open) {
        afterPaint(() =>
          document
            .querySelector<HTMLElement>('[data-testid="tws-chat"] textarea, [data-testid="tws-chat"] [contenteditable="true"]')
            ?.focus(),
        );
      }
      return true;
    }
    case 'work.tab.fullscreen':
      dispatch({ command: 'workspace.layout.set', args: { expanded: !state.layout.expanded }, source: 'keyboard' });
      return true;
    case 'work.launch': {
      const content = document.querySelector('[data-testid="tws-content"]');
      if (!content || !clickLaunch(content)) notify('Nothing to launch on this tab.');
      return true;
    }
    default:
      return false;
  }
}

/** Install the Work view's key handler while it is mounted. */
export function useWorkspaceKeys(runtime: WorkspaceRuntime, onNotice: (notice: Notice) => void): void {
  useEffect(
    () =>
      installWorkKeys((key) =>
        handleWorkKey(runtime, key, (text) =>
          onNotice({ id: `tws-key-${Date.now()}`, tone: 'info', title: text, body: '', ttlMs: NOTICE_TTL_MS }),
        ),
      ),
    [runtime, onNotice],
  );
  // Arrows scroll the terminal on screen without taking focus into it.
  useEffect(() => installTerminalArrowScroll(), []);
}
