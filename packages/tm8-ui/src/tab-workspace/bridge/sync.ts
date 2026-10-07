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
 *
 * MULTIPLE WORKSPACES (API doc 01a115c4 §7.6, §10.2). The window speaks
 * today's protocol until it has seen a `workspace.state` that carries
 * `workspaceId` — the proof the node knows workspaces. From then on it is
 * capable: it registers with `caps: ['multiWorkspace']`, addresses every
 * write to the workspace it was made in, and keeps one queue per workspace.
 * `shown` is the workspace the store displays. A state for another workspace
 * only confirms that workspace's queue; it is never rendered nor used as a
 * base. On `workspace.switched` the window keeps showing (and addressing) the
 * old workspace until the new one's state lands, then replaces the store and
 * its draft values. Old queue entries stay addressed to their workspace and
 * are never re-applied on the new base.
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

import { WORKSPACE_DEFAULT_NAME, type WorkspaceStateFrame, type WorkspaceSummary } from '@tm8/contract';

import type { WorkspaceBridgeFrame, WorkspaceSyncFrame } from '../../data/real/socket';
import type { DispatchRecord, WorkspaceRuntime } from '../runtime/dispatch';
import { flushDraftValues } from '../runtime/draftStore';
import { newUuid } from '../runtime/store';
import { inWorkspace } from './notices';

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

/** A workspace id as the window keys it; null = the synthetic "Main". */
type WorkspaceKey = string | null;

/** What the switcher needs to know, published on every change. */
export interface WorkspaceView {
  /** The node proved it knows workspaces (§10.2). */
  capable: boolean;
  shown: WorkspaceKey;
  /** A switch is under way: the new workspace's state has not landed yet. */
  switching: boolean;
  listRevision: number;
  activeWorkspaceId: WorkspaceKey;
  items: WorkspaceSummary[];
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
  /** The node proved it knows workspaces: re-register with caps, fetch the list. */
  onCapable?(): void;
  /** The workspace view changed (shown, switch, list). */
  onWorkspaces?(view: WorkspaceView): void;
  /** Another window or an agent deleted a draft of a workspace not on screen (S14). */
  notifyDraftElsewhere?(draftId: string, workspaceName: string): void;
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
  /** One queue per workspace, in send order. Before the proof, all under `shown` (null). */
  private readonly queues = new Map<WorkspaceKey, Queued[]>();
  private loaded = false;
  private imported = false;
  private rebuilding = false;
  private capableNow = false;
  private shownNow: WorkspaceKey = null;
  /** The workspace a `switched` named, until its state lands. */
  private switchingTo: WorkspaceKey | undefined = undefined;
  private listRevision = 0;
  private activeWorkspaceId: WorkspaceKey = null;
  private items: WorkspaceSummary[] = [];
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
        // A draft belongs to the workspace on screen; null ("Main" without a row) is never addressed.
        const workspaceId = this.capableNow && this.shownNow !== null ? { workspaceId: this.shownNow } : {};
        this.io.send({ type: 'workspace.draft.patch', spaceId, instanceId, draftId, kind, fields, ...workspaceId });
      },
    });
  }

  dispose(): void {
    this.unsubscribe();
    this.runtime.drafts.attach(null);
  }

  /** The node proved it knows workspaces (§10.2). */
  get capable(): boolean {
    return this.capableNow;
  }

  /** The workspace this window shows; meaningful once capable. */
  get shown(): WorkspaceKey {
    return this.shownNow;
  }

  /** What `workspace.register` adds: nothing until the proof (§10.2). */
  registerFields(): { caps?: ['multiWorkspace']; workspaceId?: WorkspaceKey } {
    return this.capableNow ? { caps: ['multiWorkspace'], workspaceId: this.shownNow } : {};
  }

  /** The list as `workspace.list` returned it over HTTP; a frame at least as new wins. */
  adoptList(items: WorkspaceSummary[], listRevision: number, activeWorkspaceId: WorkspaceKey): void {
    if (listRevision < this.listRevision) return;
    this.listRevision = listRevision;
    this.items = items;
    this.activeWorkspaceId = activeWorkspaceId;
    this.publish();
  }

  /** A workspace's name, for notices about one not on screen. */
  nameOf(workspaceId: WorkspaceKey): string {
    return this.items.find((w) => w.id === workspaceId)?.name ?? (workspaceId === null ? WORKSPACE_DEFAULT_NAME : 'another workspace');
  }

  /**
   * The socket (re)opened and the window registered: resend EVERYTHING still
   * unconfirmed, in every queue, each addressed to its own workspace. A
   * command sent on a socket that then died may or may not have landed; the
   * node keeps a record per request id, so a resend of one that did land
   * returns its recorded answer instead of applying twice.
   */
  reconnected(): void {
    for (const queue of this.queues.values()) for (const item of queue) item.sent = false;
    this.flush();
  }

  private flush(): void {
    if (!this.loaded) return;
    for (const [workspaceId, queue] of this.queues) {
      for (const item of queue) {
        if (!item.sent) item.sent = this.sendApply(item, workspaceId);
      }
    }
  }

  onFrame(frame: WorkspaceSyncFrame): void {
    if (frame.spaceId !== this.spaceId) return;
    switch (frame.type) {
      case 'workspace.state':
        this.onState(frame);
        return;
      case 'workspace.applied': {
        for (const [workspaceId, queue] of this.queues) {
          const at = queue.findIndex((q) => q.requestId === frame.requestId);
          if (at < 0) continue;
          const [dropped] = queue.splice(at, 1);
          const elsewhere = this.capableNow && workspaceId !== this.shownNow;
          const result = frame.result as unknown as Result;
          if (result.status === 'rejected' || result.status === 'conflict') {
            const copy = dropped ? ROLLBACK_COPY[dropped.env.command] : undefined;
            if (copy) this.io.notify(elsewhere ? inWorkspace(copy, this.nameOf(workspaceId)) : copy);
          }
          // Only the shown workspace's queue is on screen.
          if (!elsewhere) this.rebuild();
          return;
        }
        return;
      }
      case 'workspace.draft': {
        const workspaceId = frame.workspaceId ?? null;
        const elsewhere = this.capableNow && workspaceId !== this.shownNow && workspaceId !== this.switchingTo;
        // A draft of a workspace not on screen is not this window's business, except its deletion.
        if (elsewhere && !frame.deleted) return;
        const replaced = this.runtime.drafts.applyRemote(frame.draftId, frame.deleted ? null : (frame.fields ?? {}));
        if (elsewhere) {
          if (frame.sourceInstanceId !== this.instanceId) this.io.notifyDraftElsewhere?.(frame.draftId, this.nameOf(workspaceId));
          return;
        }
        if (replaced && frame.sourceInstanceId !== this.instanceId) this.io.notifyDraft?.(frame.draftId);
        return;
      }
      case 'workspace.switched': {
        if (!this.capableNow) return;
        if (frame.workspaceId === this.shownNow) {
          this.switchingTo = undefined;
        } else {
          // Edits typed so far go out now, addressed to the workspace they were made in.
          flushDraftValues();
          this.switchingTo = frame.workspaceId;
        }
        this.publish();
        return;
      }
      case 'workspace.summary': {
        if (frame.listRevision < this.listRevision) return;
        this.listRevision = frame.listRevision;
        this.items = frame.items;
        this.activeWorkspaceId = frame.activeWorkspaceId;
        // After a reconnect the summary leads the snapshot: an active workspace
        // that changed while this window was away is a switch.
        if (this.capableNow && this.loaded && this.switchingTo === undefined && frame.activeWorkspaceId !== this.shownNow) {
          flushDraftValues();
          this.switchingTo = frame.activeWorkspaceId;
        }
        this.publish();
        return;
      }
    }
  }

  // -- internals -------------------------------------------------------------

  private queueOf(workspaceId: WorkspaceKey): Queued[] {
    let queue = this.queues.get(workspaceId);
    if (!queue) {
      queue = [];
      this.queues.set(workspaceId, queue);
    }
    return queue;
  }

  private publish(): void {
    this.io.onWorkspaces?.({
      capable: this.capableNow,
      shown: this.shownNow,
      switching: this.switchingTo !== undefined,
      listRevision: this.listRevision,
      activeWorkspaceId: this.activeWorkspaceId,
      items: this.items,
    });
  }

  private onLocal(record: DispatchRecord): void {
    if (this.rebuilding || !record.significant) return;
    if (record.env.source === 'restore' || WINDOW_LOCAL.has(record.env.command)) return;
    const item: Queued = { requestId: newUuid(), env: record.env, ids: record.ids, sent: false };
    // A click lands in the workspace on screen, even while a switch is under way.
    this.queueOf(this.shownNow).push(item);
    if (this.loaded) item.sent = this.sendApply(item, this.shownNow);
  }

  private sendApply(item: Queued, workspaceId: WorkspaceKey): boolean {
    return this.io.send({
      type: 'workspace.apply',
      spaceId: this.spaceId,
      instanceId: this.instanceId,
      requestId: item.requestId,
      env: item.env as unknown as Record<string, unknown>,
      ids: item.ids,
      ...(this.capableNow ? { workspaceId } : {}),
    });
  }

  private onState(frame: WorkspaceStateFrame): void {
    const state = frame.state as WorkspaceState | null;
    const workspaceId = frame.workspaceId ?? null;
    if (!this.capableNow && frame.workspaceId !== undefined) {
      // The proof (§10.2): the node knows workspaces. What was queued so far was
      // made in the workspace this state is for.
      this.capableNow = true;
      const pending = this.queues.get(null);
      this.queues.delete(null);
      this.shownNow = workspaceId;
      if (pending?.length) this.queueOf(workspaceId).unshift(...pending);
      this.io.onCapable?.();
      this.publish();
    }
    const confirm = (queue: Queued[]) => {
      if (frame.cause?.instanceId !== this.instanceId) return;
      const at = queue.findIndex((q) => q.requestId === frame.cause!.requestId);
      if (at >= 0) queue.splice(0, at + 1);
    };
    if (this.capableNow && workspaceId !== this.shownNow) {
      if (this.switchingTo === undefined || workspaceId !== this.switchingTo || state === null) {
        // Another workspace: it only confirms its own queue.
        confirm(this.queueOf(workspaceId));
        return;
      }
      this.completeSwitch(workspaceId, state, frame.revision);
      confirm(this.queueOf(workspaceId));
      this.rebuild(true);
      return;
    }
    if (state === null) {
      // No row yet: carry this browser's state over, once (Spec D §6).
      if (!this.imported) {
        this.imported = true;
        // The import IS this window's state, commands so far included.
        if (this.sendImport()) this.queues.set(this.shownNow, []);
      }
      this.markLoaded();
      return;
    }
    const first = this.base === null;
    this.base = state;
    this.baseRevision = frame.revision;
    confirm(this.queueOf(this.shownNow));
    this.markLoaded();
    // A new window opens on the workspace's last active tab.
    this.rebuild(first);
  }

  /** The new workspace's state landed: it becomes the base, the old one's draft values go. */
  private completeSwitch(workspaceId: WorkspaceKey, state: WorkspaceState, revision: number): void {
    flushDraftValues();
    const old = this.runtime.store.getState();
    for (const tab of Object.values(old.tabs)) {
      if (tab.type === 'draft') this.runtime.drafts.delete(tab.draftId);
    }
    this.shownNow = workspaceId;
    this.switchingTo = undefined;
    this.base = state;
    this.baseRevision = revision;
    this.markLoaded();
    this.publish();
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
      ...(this.capableNow ? { workspaceId: null } : {}),
    });
  }

  /**
   * Base + the shown workspace's in-flight commands + this window's own
   * fields, into the store. `adoptLastActive`: a new window, or a switch,
   * opens on the workspace's stored last active tab.
   */
  private rebuild(adoptLastActive = false): void {
    if (!this.base) return;
    const local = this.runtime.store.getState();
    let next = overlayWindow(
      { ...this.base, revision: this.baseRevision },
      adoptLastActive ? { ...local, presentation: this.base.presentation } : local,
    );
    for (const item of this.queues.get(this.shownNow) ?? []) {
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
