/**
 * The window's half of server-side Workspaces (Spec D §3).
 *
 * LOCAL FIRST. A click commits in this window at once (the dispatcher, as
 * always). This sync then queues the command — with the ids its reducer
 * minted — and sends it to the node, which applies the same `reduce` to the
 * stored workspace and pushes the result to every window of this identity.
 *
 * REBASE. On every `workspace.state` the window takes the node's state as its
 * base, drops the queued commands the node has confirmed (in order: the node
 * answers a window's commands in the order it sent them), re-applies the ones
 * still in flight on top, and lays its own per-window fields over the result:
 * the active tab and per-tab scroll. A shared change that removed or hid this
 * window's active tab falls back locally (§5.3, `overlayWindow`).
 *
 * ROLLBACK. A command the node did not commit comes back as
 * `workspace.applied`; it is dropped, the window rebuilds from base and says
 * so in a notice.
 *
 * IMPORT. The first time the node has no row for this identity in the space,
 * the window sends what it restored from browser storage, once.
 */
import {
  overlayWindow,
  reduce,
  type CommandEnvelope,
  type CommandName,
  type DraftTabRecord,
  type RailPrefs,
  type Result,
  type WorkspaceHooks,
  type WorkspaceState,
} from '@tm8/contract/workspace';

import type { WorkspaceBridgeFrame, WorkspaceSyncFrame } from '../../data/real/socket';
import type { DispatchRecord, WorkspaceRuntime } from '../runtime/dispatch';
import { newUuid } from '../runtime/store';

/** Commands that never leave this window: reads, dialogs and the route. */
const WINDOW_LOCAL: ReadonlySet<CommandName> = new Set([
  'workspace.inspect',
  'workspace.dialogs.open',
  'workspace.dialogs.close',
  'workspace.view.set',
]);

interface Queued {
  requestId: string;
  env: CommandEnvelope;
  ids: string[];
  sent: boolean;
}

export interface SyncIo {
  /** Send one bridge frame; false while the socket is not open. */
  send(frame: WorkspaceBridgeFrame): boolean;
  /** Tell the person a command of theirs did not stick. */
  notify(text: string): void;
  /** Called once the node's state has landed (stop writing browser storage). */
  onServerMode?(): void;
  /** Tell the person that another window or an agent replaced a draft they are on. */
  notifyDraft?(draftId: string): void;
  /** This browser's legacy Workspace state (storage), for the one-time import. */
  legacy?(): { state: Partial<WorkspaceState> | null; rail: RailPrefs | null };
}

function draftTabOf(state: WorkspaceState, draftId: string): DraftTabRecord | undefined {
  return Object.values(state.tabs).find((t): t is DraftTabRecord => t.type === 'draft' && t.draftId === draftId);
}

const ROLLBACK_COPY: Partial<Record<CommandName, string>> = {
  'workspace.tabs.open': 'Couldn’t open that tab: your workspace changed elsewhere',
  'workspace.tabs.close': 'Couldn’t close that tab: your workspace changed elsewhere',
  'workspace.tabs.move': 'Couldn’t move that tab: your workspace changed elsewhere',
  'workspace.tabScope.set': 'Couldn’t change the tab scope: your workspace changed elsewhere',
};

export class WorkspaceSync {
  private base: WorkspaceState | null = null;
  private baseRevision = 0;
  private queue: Queued[] = [];
  private loaded = false;
  private imported = false;
  private rebuilding = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly spaceId: string,
    private readonly instanceId: string,
    private readonly io: SyncIo,
  ) {
    this.unsubscribe = runtime.onDispatched((record) => this.onLocal(record));
    runtime.drafts.attach({
      send: (draftId, fields) => {
        const kind = draftTabOf(runtime.store.getState(), draftId)?.kind;
        if (!kind) return;
        this.io.send({ type: 'workspace.draft.patch', spaceId, instanceId, draftId, kind, fields });
      },
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.runtime.drafts.attach(null);
  }

  /**
   * The socket (re)opened and the window registered: resend EVERYTHING still
   * unconfirmed. A command sent on a socket that then died may or may not
   * have landed; the node keeps a record per request id, so a resend of one
   * that did land returns its recorded answer instead of applying twice.
   */
  reconnected(): void {
    for (const item of this.queue) item.sent = false;
    this.flush();
  }

  private flush(): void {
    if (!this.loaded) return;
    for (const item of this.queue) {
      if (!item.sent) item.sent = this.sendApply(item);
    }
  }

  onFrame(frame: WorkspaceSyncFrame): void {
    if (frame.spaceId !== this.spaceId) return;
    switch (frame.type) {
      case 'workspace.state':
        this.onState(frame.revision, frame.state as WorkspaceState | null, frame.cause);
        return;
      case 'workspace.applied': {
        const at = this.queue.findIndex((q) => q.requestId === frame.requestId);
        if (at < 0) return;
        const [dropped] = this.queue.splice(at, 1);
        const result = frame.result as unknown as Result;
        if (result.status === 'rejected' || result.status === 'conflict') {
          const copy = dropped ? ROLLBACK_COPY[dropped.env.command] : undefined;
          if (copy) this.io.notify(copy);
        }
        this.rebuild();
        return;
      }
      case 'workspace.draft': {
        const replaced = this.runtime.drafts.applyRemote(frame.draftId, frame.deleted ? null : (frame.fields ?? {}));
        if (replaced && frame.sourceInstanceId !== this.instanceId) this.io.notifyDraft?.(frame.draftId);
        return;
      }
    }
  }

  // -- internals -------------------------------------------------------------

  private onLocal(record: DispatchRecord): void {
    if (this.rebuilding || !record.significant) return;
    if (record.env.source === 'restore' || WINDOW_LOCAL.has(record.env.command)) return;
    const item: Queued = { requestId: newUuid(), env: record.env, ids: record.ids, sent: false };
    this.queue.push(item);
    if (this.loaded) item.sent = this.sendApply(item);
  }

  private sendApply(item: Queued): boolean {
    return this.io.send({
      type: 'workspace.apply',
      spaceId: this.spaceId,
      instanceId: this.instanceId,
      requestId: item.requestId,
      env: item.env as unknown as Record<string, unknown>,
      ids: item.ids,
    });
  }

  private onState(revision: number, state: WorkspaceState | null, cause?: { instanceId: string; requestId: string }): void {
    if (state === null) {
      // No row yet: carry this browser's state over, once (Spec D §6).
      if (!this.imported) {
        this.imported = true;
        // The import IS this window's state, commands so far included.
        if (this.sendImport()) this.queue = [];
      }
      this.markLoaded();
      return;
    }
    const first = this.base === null;
    this.base = state;
    this.baseRevision = revision;
    if (cause?.instanceId === this.instanceId) {
      const at = this.queue.findIndex((q) => q.requestId === cause.requestId);
      if (at >= 0) this.queue.splice(0, at + 1);
    }
    this.markLoaded();
    // A new window opens on the workspace's last active tab.
    this.rebuild(first);
  }

  private markLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.io.onServerMode?.();
    this.flush();
  }

  private sendImport(): boolean {
    // This window's store if it already holds anything (the Workspace view
    // restored it), else what browser storage holds.
    const current = this.runtime.store.getState();
    const legacy = this.io.legacy?.() ?? { state: null, rail: null };
    const pristine = current.revision === 0 && current.orderedTabIds.length === 0;
    const state: WorkspaceState = {
      ...current,
      ...(pristine && legacy.state ? legacy.state : {}),
      ...(legacy.rail && current.rail === undefined ? { rail: legacy.rail } : {}),
    };
    const hasAnything = state.orderedTabIds.length > 0 || state.scope.mode === 'byType' || state.rail !== undefined;
    if (!hasAnything) return false;
    const draftIds = Object.values(state.tabs).flatMap((t) => (t.type === 'draft' ? [t.draftId] : []));
    const drafts = this.runtime.drafts.legacy(draftIds).map(({ draftId, values }) => ({
      draftId,
      kind: draftTabOf(state, draftId)?.kind ?? 'task',
      values,
    }));
    return this.io.send({
      type: 'workspace.import',
      spaceId: this.spaceId,
      instanceId: this.instanceId,
      state: state as unknown as Record<string, unknown>,
      drafts,
    });
  }

  /** Base + in-flight commands + this window's own fields, into the store. */
  private rebuild(adoptLastActive = false): void {
    if (!this.base) return;
    const local = this.runtime.store.getState();
    let next = overlayWindow(
      { ...this.base, revision: this.baseRevision },
      adoptLastActive ? { ...local, presentation: this.base.presentation } : local,
    );
    for (const item of this.queue) {
      const ids = [...item.ids];
      const hooks: WorkspaceHooks = { ...this.runtime.hooks, newId: () => ids.shift() ?? newUuid() };
      next = reduce(next, item.env, hooks).state;
    }
    this.rebuilding = true;
    try {
      this.runtime.store.setState(next, true);
    } finally {
      this.rebuilding = false;
    }
  }
}
