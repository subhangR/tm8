/**
 * The workspace switcher (API doc 01a115c4 §10): in the top bar and the Work
 * view's left header, next to the space name. The workspace on screen — its
 * colour dot, its name, ▾ — and a popover listing the identity's workspaces
 * in order (`*` the active one, the tab count) with New, Rename, Colour,
 * Move up / Move down and Delete.
 *
 * Every action is an HTTP `workspace.*` call; the node's `workspace.switched`
 * / `workspace.summary` frames are what change the window, never the call's
 * own answer. A refusal (last workspace, the cap, a taken name…) is a notice.
 * Deleting a workspace with unsaved drafts asks Discard / Keep first.
 *
 * The activity dot (phase 3): a row whose workspace an agent changed since it
 * was last active (`agentChangedSinceActive`) carries a dot, and so does the
 * trigger while any such row exists. It clears once that workspace is active.
 *
 * Drawn with the space switcher's own popover classes. Absent until the node
 * has proved it knows workspaces (§10.2); disabled, with a tooltip, while the
 * events socket is down (S13). `g w` and the palette open it through
 * `openWorkspaceSwitcher`, with focus in the list: arrows + Enter, 1–9 jump.
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { WORKSPACE_COLORS, WORKSPACE_DEFAULT_NAME, type WorkspaceColor, type WorkspaceManageResult, type WorkspaceSummary } from '@tm8/contract';

import type { WorkspaceManagePort } from '../../data/seam';
import { WORKSPACE_SWITCHER_OFFLINE, type WorkspaceListStore } from '../bridge/workspaceList';

export interface WorkspaceSwitcherProps {
  store: WorkspaceListStore;
  spaceId: string;
  manage: WorkspaceManagePort | undefined;
  notify(text: string): void;
}

/** A refusal's reason, as the person reads it. */
export function manageRefusalCopy(reason: string | undefined): string {
  switch (reason) {
    case 'last_workspace': return 'A space keeps at least one workspace';
    case 'workspace_cap': return 'You have the most workspaces a space allows';
    case 'workspace_name_taken': return 'You already have a workspace with that name';
    case 'invalid_name': return 'That name can’t be used for a workspace';
    case 'invalid_color': return 'That colour can’t be used';
    case 'workspace_not_found': return 'That workspace no longer exists';
    case 'workspace_switched': return 'Another window switched workspace first';
    case 'human_only': return 'Only you can manage your workspaces';
    default: return 'Couldn’t change your workspaces';
  }
}

/** The reason of a refused call: in the result, or in the error's details. */
export function reasonOf(outcome: WorkspaceManageResult | unknown): string | undefined {
  const value = outcome as { reason?: unknown; details?: { reason?: unknown } } | null;
  if (typeof value?.reason === 'string') return value.reason;
  return typeof value?.details?.reason === 'string' ? value.details.reason : undefined;
}

type RowMode = { id: string; kind: 'actions' | 'rename' | 'colour' } | { id: string; kind: 'delete'; dirty: number };

export function WorkspaceSwitcher(props: WorkspaceSwitcherProps) {
  const { store, spaceId, manage, notify } = props;
  const capable = useStore(store, (s) => s.capable);
  const online = useStore(store, (s) => s.online);
  const open = useStore(store, (s) => s.open);
  const shown = useStore(store, (s) => s.shown);
  const items = useStore(store, (s) => s.items);
  const activeWorkspaceId = useStore(store, (s) => s.activeWorkspaceId);
  const [mode, setMode] = useState<RowMode | null>(null);
  const [draftName, setDraftName] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const setOpen = (value: boolean) => store.setState({ open: value });
  const current = items.find((w) => w.id === shown);
  const name = current?.name ?? WORKSPACE_DEFAULT_NAME;
  const changed = (w: WorkspaceSummary) => w.agentChangedSinceActive && !w.active && w.id !== activeWorkspaceId;
  const anyChanged = items.some(changed);

  useEffect(() => {
    if (!open) {
      setMode(null);
      return undefined;
    }
    // Focus lands in the list, on the workspace on screen.
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>('[data-ws-row]');
    const at = items.findIndex((w) => w.id === shown);
    (rows?.[Math.max(at, 0)] ?? rows?.[0])?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
    // Focus once per opening, not on every summary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!capable) return null;

  /** Run one management call; a refusal is a notice, never a throw. */
  const run = async (call: (port: WorkspaceManagePort) => Promise<WorkspaceManageResult>): Promise<WorkspaceManageResult | null> => {
    if (!manage || !store.getState().online) return null;
    try {
      const result = await call(manage);
      if (result.status === 'rejected' || result.status === 'conflict') {
        if (result.reason !== 'unsaved_changes') notify(manageRefusalCopy(reasonOf(result)));
      }
      return result;
    } catch (error) {
      notify(manageRefusalCopy(reasonOf(error)));
      return null;
    }
  };

  const switchTo = (workspace: WorkspaceSummary | undefined) => {
    if (!workspace) return;
    setOpen(false);
    if (workspace.id === null || workspace.id === shown) return;
    const id = workspace.id;
    void run((port) => port.switch(spaceId, id, store.getState().shown));
  };

  const move = (index: number, by: -1 | 1) => {
    const workspace = items[index];
    if (!workspace?.id) return;
    const id = workspace.id;
    // Before the one above, or before the one two below (null = the end).
    const before = by < 0 ? items[index - 1]?.id : items[index + 2]?.id ?? null;
    if (before === undefined) return;
    void run((port) => port.reorder(spaceId, id, before));
  };

  const remove = async (id: string, discard: boolean) => {
    const result = await run((port) => port.remove(spaceId, id, discard));
    if (result?.status === 'rejected' && result.reason === 'unsaved_changes') {
      setMode({ id, kind: 'delete', dirty: result.dirtyDraftIds?.length ?? 0 });
      return;
    }
    setMode(null);
  };

  const rename = (id: string) => {
    const next = draftName.trim();
    setMode(null);
    if (!next || next === items.find((w) => w.id === id)?.name) return;
    void run((port) => port.update(spaceId, id, { name: next }));
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).tagName === 'INPUT') return;
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[data-ws-row]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = at < 0 ? 0 : (at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      rows[next]?.focus();
      return;
    }
    if (event.key.length !== 1 || event.key === ' ' || event.metaKey || event.ctrlKey || event.altKey) return;
    // A plain key here is the switcher's: the shell's own `1`–`9`, `w`… must not also fire.
    event.preventDefault();
    if (/^[1-9]$/.test(event.key)) switchTo(items[Number(event.key) - 1]);
  };

  const trigger = online ? `Workspace: ${name} (g w)` : WORKSPACE_SWITCHER_OFFLINE;

  return (
    <div className="shell-switcher tws-wsw" ref={rootRef} data-testid="workspace-switcher">
      <button
        type="button"
        className="shell-switcher__trigger shell-switcher__trigger--quiet tws-wsw__trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-disabled={online ? undefined : 'true'}
        aria-label={`Workspace: ${name}`}
        title={trigger}
        onClick={(event) => {
          if (!online) {
            event.preventDefault();
            return;
          }
          setOpen(!open);
        }}
      >
        <span className="tws-wsw__dot" data-color={current?.color ?? 'none'} aria-hidden="true" />
        <span className="shell-switcher__space">{name}</span>
        {anyChanged ? <span className="tws-wsw__activity" data-testid="workspace-activity" aria-label="An agent changed another workspace" /> : null}
        <span className="shell-switcher__caret" aria-hidden="true">▾</span>
      </button>

      {open && online ? (
        <div className="shell-switcher__pop tws-wsw__pop" role="dialog" aria-label="Switch workspace">
          <div ref={listRef} role="list" onKeyDown={onListKeyDown}>
            {items.map((workspace, index) => {
              const id = workspace.id;
              const here = mode && mode.id === id ? mode : null;
              return (
                <div key={id ?? 'main'} role="listitem" className="tws-wsw__item">
                  {here?.kind === 'rename' ? (
                    <input
                      className="tws-wsw__rename"
                      aria-label={`Rename ${workspace.name}`}
                      value={draftName}
                      autoFocus
                      maxLength={60}
                      onChange={(event) => setDraftName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') rename(id!);
                        if (event.key === 'Escape') {
                          event.stopPropagation();
                          setMode(null);
                        }
                      }}
                      onBlur={() => setMode(null)}
                    />
                  ) : (
                    <div className="tws-wsw__line">
                      <button
                        type="button"
                        data-ws-row
                        className={`shell-switcher__space-row ${id === shown ? 'shell-switcher__space-row--active' : ''}`}
                        aria-current={id === shown ? 'true' : undefined}
                        title={index < 9 ? `${workspace.name} (${index + 1})` : workspace.name}
                        onClick={() => switchTo(workspace)}
                      >
                        <span className="shell-switcher__check" aria-hidden="true">{workspace.active ? '*' : ''}</span>
                        <span className="tws-wsw__dot" data-color={workspace.color ?? 'none'} aria-hidden="true" />
                        <span className="tws-wsw__name">{workspace.name}</span>
                        {changed(workspace) ? (
                          <span
                            className="tws-wsw__activity"
                            data-testid="workspace-row-activity"
                            role="img"
                            aria-label={workspace.lastAgentChange?.actorName ? `Changed by ${workspace.lastAgentChange.actorName}` : 'Changed by an agent'}
                          />
                        ) : null}
                        <span className="tws-wsw__count" aria-label={`${workspace.tabCount} tabs`}>{workspace.tabCount}</span>
                      </button>
                      {id !== null ? (
                        <button
                          type="button"
                          className="tws-wsw__more"
                          aria-label={`Manage ${workspace.name}`}
                          aria-expanded={here !== null}
                          onClick={() => setMode(here ? null : { id, kind: 'actions' })}
                        >
                          ⋯
                        </button>
                      ) : null}
                    </div>
                  )}
                  {here?.kind === 'actions' && id !== null ? (
                    <div className="tws-wsw__actions">
                      <button type="button" onClick={() => { setDraftName(workspace.name); setMode({ id, kind: 'rename' }); }}>Rename</button>
                      <button type="button" onClick={() => setMode({ id, kind: 'colour' })}>Colour</button>
                      <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>Move up</button>
                      <button type="button" disabled={index === items.length - 1} onClick={() => move(index, 1)}>Move down</button>
                      <button type="button" onClick={() => void remove(id, false)}>Delete</button>
                    </div>
                  ) : null}
                  {here?.kind === 'colour' && id !== null ? (
                    <div className="tws-wsw__actions" role="group" aria-label={`Colour of ${workspace.name}`}>
                      {[...WORKSPACE_COLORS, null].map((color: WorkspaceColor | null) => (
                        <button
                          key={color ?? 'none'}
                          type="button"
                          className="tws-wsw__swatch"
                          aria-label={color ?? 'No colour'}
                          aria-pressed={workspace.color === color}
                          onClick={() => {
                            setMode(null);
                            void run((port) => port.update(spaceId, id, { color }));
                          }}
                        >
                          <span className="tws-wsw__dot" data-color={color ?? 'none'} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {here?.kind === 'delete' && id !== null ? (
                    <div className="tws-wsw__actions" role="alertdialog" aria-label={`Delete ${workspace.name}`}>
                      <span className="shell-switcher__hint">
                        {here.dirty === 1 ? '1 unsaved draft' : `${here.dirty} unsaved drafts`}
                      </span>
                      <button type="button" onClick={() => void remove(id, true)}>Discard</button>
                      <button type="button" onClick={() => setMode(null)}>Keep</button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          <div className="shell-switcher__footer">
            <button
              type="button"
              className="shell-switcher__add"
              onClick={() => void run((port) => port.create(spaceId, {}))}
            >
              ＋ New workspace
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
