/**
 * ONE CRAFT'S TABS, FOR THIS PERSON (Craft redesign doc 01a1255d §3, "3rd
 * panel — tabs"): the per-user craft workspace behind the tab strip.
 *
 *  · READ once with `workspace.crafts.get` (get-or-default: the overview alone);
 *  · LIVE by the `craft.workspace` push — another window, or the craft's chat
 *    or session acting on the person's behalf (§4), moves the strip here too;
 *  · A PRESS shows at once (the same pure rules the node applies), and the
 *    node's answer is the truth after that. A refusal puts the node's state
 *    back and says why.
 *
 * Pages are the craft's shared membership; tabs are the person's open subset.
 * A tab whose page has left the craft is dropped by the node; until its push
 * lands, the strip already hides it (`pageIds`).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { craftTabKind, type CraftTab, type CraftWorkspace, type CraftWorkspaceResultReason } from '@tm8/contract';
import type { CraftWorkspacesPort } from '../data/seam';
import {
  applyCraftTabCommand,
  defaultCraftWorkspace,
  memoryCraftWorkspacesPort,
  type CraftTabCommand,
  type CraftTabCommandArgs,
} from '../data/craft-workspace';

export interface CraftTabsHandle {
  /** In strip order; `tabs[0]` is the pinned overview. */
  tabs: readonly CraftTab[];
  activeTab: CraftTab;
  /** The node's state has been read (or the read failed): the strip is no longer the default. */
  loaded: boolean;
  /** Open (or focus) the page's tab. Resolves whether the node took it. */
  open(kind: string, entityId: string): Promise<boolean>;
  close(tabId: string): void;
  activate(tabId: string): void;
  /** Put `tabId` before `beforeTabId` (null = last). */
  move(tabId: string, beforeTabId: string | null): void;
}

/** Why the node refused, in words. */
const REFUSAL: Partial<Record<CraftWorkspaceResultReason, string>> = {
  not_a_page: 'That entity is not a page of this craft.',
  entity_unavailable: 'That page can no longer be read.',
  tab_limit: 'This craft has as many tabs open as it can hold. Close one first.',
  pinned: 'The overview tab stays first and cannot be closed.',
  unsupported_kind: 'That kind of entity cannot be a craft tab.',
};

/** A seam with no craft workspaces (fixtures) keeps them in memory, one store per seam. */
const fallbackPorts = new WeakMap<object, CraftWorkspacesPort>();
export function craftWorkspacesPortOf(seam: { craftWorkspaces?: CraftWorkspacesPort | undefined }): CraftWorkspacesPort {
  if (seam.craftWorkspaces) return seam.craftWorkspaces;
  let port = fallbackPorts.get(seam);
  if (!port) fallbackPorts.set(seam, (port = memoryCraftWorkspacesPort()));
  return port;
}

function requestId(): string {
  return `crafttab:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

export function useCraftWorkspace(
  port: CraftWorkspacesPort,
  spaceId: string,
  craftId: string,
  /** The craft's pages, once read; null while loading (nothing is hidden then). */
  pageIds: ReadonlySet<string> | null,
  onNotice?: (text: string) => void,
): CraftTabsHandle {
  const [confirmed, setConfirmed] = useState<CraftWorkspace>(() => defaultCraftWorkspace(craftId));
  /* The press shown before the node answers; cleared by the answer. */
  const [optimistic, setOptimistic] = useState<CraftWorkspace | null>(null);
  const [loaded, setLoaded] = useState(false);
  const shownRef = useRef<CraftWorkspace>(confirmed);
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  /* A newer revision always wins; an older answer that arrives late never rolls the strip back. */
  const accept = useCallback(
    (next: CraftWorkspace) => {
      if (next.craftId !== craftId) return;
      setConfirmed((was) => (was.craftId === craftId && next.revision < was.revision ? was : next));
    },
    [craftId],
  );

  useEffect(() => {
    setConfirmed(defaultCraftWorkspace(craftId));
    setOptimistic(null);
    setLoaded(false);
    let live = true;
    port.get(spaceId, craftId).then(
      (workspace) => {
        if (!live) return;
        accept(workspace);
        setLoaded(true);
      },
      () => live && setLoaded(true),
    );
    const off = port.onPush((frame) => {
      if (!live || frame.spaceId !== spaceId) return;
      if (frame.type === 'craft.workspaces') {
        const mine = frame.items.find((item) => item.craftId === craftId);
        if (mine) accept(mine);
        return;
      }
      if (frame.workspace.craftId !== craftId) return;
      accept(frame.workspace);
      if (frame.cause?.actorClass === 'agent') {
        noticeRef.current?.(`${frame.cause.actorName ?? 'The craft agent'} changed your tabs.`);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [port, spaceId, craftId, accept]);

  const shown = optimistic ?? confirmed;
  shownRef.current = shown;

  const send = useCallback(
    async <C extends CraftTabCommand>(command: C, args: CraftTabCommandArgs[C]): Promise<boolean> => {
      const local = applyCraftTabCommand(shownRef.current, command, args);
      if (local.status === 'rejected') {
        const text = local.reason ? REFUSAL[local.reason] : undefined;
        if (text) noticeRef.current?.(text);
        return false;
      }
      if (local.status === 'applied') setOptimistic(local.workspace);
      try {
        const result = await port.command(spaceId, craftId, { requestId: requestId(), command, args });
        accept(result.workspace);
        if (result.status === 'rejected') {
          const text = result.reason ? REFUSAL[result.reason] : undefined;
          noticeRef.current?.(text ?? 'The tab change was not saved.');
          return false;
        }
        return result.status !== 'conflict';
      } catch {
        noticeRef.current?.('The tab change was not saved.');
        return false;
      } finally {
        setOptimistic(null);
      }
    },
    [port, spaceId, craftId, accept],
  );

  const tabs = useMemo(
    () => shown.state.tabs.filter((tab) => tab.pinned || !pageIds || pageIds.has(tab.entityId)),
    [shown, pageIds],
  );
  const activeTab = tabs.find((tab) => tab.id === shown.state.activeTabId) ?? tabs[0]!;

  const open = useCallback(
    (kind: string, entityId: string) => send('tabs.open', { kind: craftTabKind(kind) ?? kind, entityId }),
    [send],
  );
  const close = useCallback((tabId: string) => void send('tabs.close', { tabId }), [send]);
  const activate = useCallback((tabId: string) => void send('tabs.activate', { tabId }), [send]);
  const move = useCallback(
    (tabId: string, beforeTabId: string | null) => void send('tabs.move', { tabId, beforeTabId }),
    [send],
  );

  return { tabs, activeTab, loaded, open, close, activate, move };
}
