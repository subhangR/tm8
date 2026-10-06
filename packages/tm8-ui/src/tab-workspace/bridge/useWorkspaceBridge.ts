/**
 * The window side of the Workspace remote bridge (Spec C, doc 01a1111d-589e).
 *
 * Mounted by GateApp whenever the window is in a space with a known viewer, on
 * EVERY route. It:
 *  - registers this page as a live Workspace instance on the events socket the
 *    page already holds (`workspace.register`), again on every socket open, on
 *    focus / visibility / route / revision changes, and every 25 s;
 *  - answers forwarded `workspace.command` frames by calling the runtime's
 *    `dispatch()` with `source: 'remote'` — the same single entry point the UI
 *    uses, under the remote policy in dispatch.ts — and sends the Result back;
 *  - owns the shell side of the remote-only hooks: the registered dialogs, the
 *    route switch to the Workspace, and the 2 s typing guard;
 *  - shows the coalesced "<actor> opened …" notice (ruling Q5, R35).
 *
 * The instance id is new on every page load and space switch; it survives
 * socket reconnects so a retried request still finds its window.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { WorkspaceBridgeCommandFrame } from '@tm8/contract';

import type { WorkspaceBridgePort } from '../../data/seam';
import type { WorkspaceBridgeFrame } from '../../data/real/socket';
import { NOTICE_TTL_MS, type Notice } from '../../shell';
import { getWorkspaceRuntime } from '../runtime/dispatch';
import { enterServerMode, legacySnapshot } from '../runtime/persistence';
import { applyStoredRail, attachRailWriter, legacyRail } from '../runtime/railStore';
import { WorkspaceSync } from './sync';
import { newUuid, WINDOW_ID } from '../runtime/store';
import type {
  CommandEnvelope,
  CommandName,
  DialogId,
  ExternalOutcome,
  Result,
  TabRecord,
  WorkspaceState,
} from '../runtime/types';
import { COMMAND_NAMES, DIALOG_IDS } from '../runtime/types';
import { actorLabel, DIALOG_TITLES, RemoteNoticeCoalescer, scopeLabel, type RemoteChange } from './notices';

export interface BridgeDialogControl {
  open: boolean;
  setOpen(open: boolean): void;
  /** False when this window cannot show it (no port, unsupported host). */
  available: boolean;
}

export interface WorkspaceBridgeOptions {
  port: WorkspaceBridgePort | undefined;
  spaceId: string | null;
  viewerId: string | null;
  /** The current route view name (`tabs` is the Workspace). */
  view: string;
  dialogs: Record<DialogId, BridgeDialogControl>;
  /** Another blocking modal this registry does not own is open (e.g. the launch sheet). */
  otherModalOpen: boolean;
  showWorkspace(): void;
  titleOf(entityId: string): string | undefined;
  notify(notice: Notice): void;
}

const HEARTBEAT_MS = 25_000;
const REVISION_THROTTLE_MS = 250;
const TYPING_WINDOW_MS = 2000;
const RENDER_ACK_MS = 2000;
const RESULT_CACHE = 200;

/** Where each registered dialog is in the DOM once it has mounted. */
const DIALOG_SELECTORS: Record<DialogId, string> = {
  palette: '[data-testid="command-palette"]',
  prompts: '[role="dialog"][aria-label="System prompts"]',
  agentTools: '.cset-card[role="dialog"]',
  newSpace: '.project-onboard[role="dialog"]',
  addServer: '.server-dialog[role="dialog"]',
};

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  const type = (target as HTMLInputElement).type;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
}

/** Resolve once the dialog's element is in the DOM, or false after `ms`. */
function whenRendered(dialogId: DialogId, ms: number): Promise<boolean> {
  const selector = DIALOG_SELECTORS[dialogId];
  const started = Date.now();
  return new Promise((resolve) => {
    const check = () => {
      if (document.querySelector(selector)) return resolve(true);
      if (Date.now() - started >= ms) return resolve(false);
      setTimeout(check, 16);
    };
    check();
  });
}

function registerFrame(
  runtime: ReturnType<typeof getWorkspaceRuntime>,
  spaceId: string,
  instanceId: string,
  view: string,
  lastFocusedAt: number | null,
): WorkspaceBridgeFrame {
  return {
    type: 'workspace.register',
    spaceId,
    instanceId,
    windowId: WINDOW_ID,
    focused: document.hasFocus(),
    visible: document.visibilityState === 'visible',
    view: view || 'unknown',
    mounted: runtime.hooks.viewMounted(),
    revision: runtime.store.getState().revision,
    ...(lastFocusedAt !== null ? { lastFocusedAt: new Date(lastFocusedAt).toISOString() } : {}),
  };
}

function tabTitle(tab: TabRecord | undefined, titleOf: (id: string) => string | undefined): string | undefined {
  if (!tab) return undefined;
  if (tab.type === 'entity') return titleOf(tab.entityId);
  if (tab.type === 'draft') return `New ${tab.kind.replace(/_/g, ' ')}`;
  return undefined;
}

/** What the human now sees differently, for the notice; null = stay silent. */
export function changeOf(
  env: CommandEnvelope,
  result: Result,
  prev: WorkspaceState,
  next: WorkspaceState,
  titleOf: (id: string) => string | undefined,
): RemoteChange | null {
  if (result.status !== 'applied') return null;
  const args = (env.args ?? {}) as Record<string, unknown>;
  switch (env.command) {
    case 'workspace.tabs.open':
    case 'workspace.drafts.open':
      return { verb: 'opened', count: 1, ...titled(tabTitle(result.tabId ? next.tabs[result.tabId] : undefined, titleOf)) };
    case 'workspace.tabs.close':
      return { verb: 'closed', count: 1, ...titled(tabTitle(prev.tabs[String(args.tabId)], titleOf)) };
    case 'workspace.tabs.closeVisible': {
      const gone = prev.orderedTabIds.filter((id) => !next.tabs[id]);
      if (gone.length === 0) return null;
      return { verb: 'closed', count: gone.length, ...titled(gone.length === 1 ? tabTitle(prev.tabs[gone[0]!], titleOf) : undefined) };
    }
    case 'workspace.tabs.move':
      return { verb: 'moved', count: 1, ...titled(tabTitle(next.tabs[String(args.tabId)], titleOf)) };
    case 'workspace.tabs.activate':
      return { verb: 'switched', ...titled(tabTitle(next.tabs[String(args.tabId)], titleOf)) };
    case 'workspace.tabScope.set':
      return { verb: 'scope', label: scopeLabel(next.scope) };
    case 'workspace.dialogs.open':
      return result.dialogId ? { verb: 'dialog', title: DIALOG_TITLES[result.dialogId] } : null;
    case 'workspace.view.set':
      return { verb: 'view' };
    default:
      return null;
  }
}

function titled(title: string | undefined): { title?: string } {
  return title ? { title } : {};
}

export function useWorkspaceBridge(options: WorkspaceBridgeOptions): void {
  const { port, spaceId, viewerId } = options;
  const latest = useRef(options);
  latest.current = options;

  const runtime = useMemo(
    () => (spaceId && viewerId ? getWorkspaceRuntime(viewerId, spaceId) : null),
    [spaceId, viewerId],
  );
  // New per page load AND per (viewer, space): a switch is a new instance.
  const instanceId = useMemo(() => (runtime ? newUuid() : null), [runtime]);
  const lastTypedAt = useRef(0);
  const lastFocusedAt = useRef<number | null>(null);
  const coalescer = useMemo(() => new RemoteNoticeCoalescer(), []);

  // The typing guard: a keystroke in an editable field, window-wide.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isEditable(event.target)) lastTypedAt.current = Date.now();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // The shell side of the remote-only hooks.
  useEffect(() => {
    if (!runtime) return undefined;
    const busy = (except: DialogId): boolean =>
      latest.current.otherModalOpen ||
      DIALOG_IDS.some((id) => id !== except && latest.current.dialogs[id].open);
    return runtime.setHooks({
      openDialog: (dialogId): ExternalOutcome => {
        const control = latest.current.dialogs[dialogId];
        if (!control.available) return { status: 'rejected', reason: 'dialog_unavailable', dialogId };
        if (control.open) return { status: 'no_op', dialogId, dialogState: 'open' };
        if (busy(dialogId)) return { status: 'rejected', reason: 'busy', dialogId };
        control.setOpen(true);
        return { status: 'applied', dialogId, dialogState: 'open' };
      },
      closeDialog: (dialogId): ExternalOutcome => {
        const control = latest.current.dialogs[dialogId];
        if (!control.available) return { status: 'rejected', reason: 'dialog_unavailable', dialogId };
        if (!control.open) return { status: 'no_op', dialogId, dialogState: 'closed' };
        control.setOpen(false);
        return { status: 'applied', dialogId, dialogState: 'closed' };
      },
      showWorkspace: (): ExternalOutcome => {
        if (latest.current.view === 'tabs') return { status: 'no_op' };
        latest.current.showWorkspace();
        return { status: 'applied' };
      },
      userTyping: () => Date.now() - lastTypedAt.current < TYPING_WINDOW_MS,
    });
  }, [runtime]);

  // Registration, heartbeat and the command channel.
  useEffect(() => {
    if (!runtime || !port || !spaceId || !instanceId) return undefined;
    let lastSentRevision = -1;
    let revisionTimer: ReturnType<typeof setTimeout> | null = null;

    const register = () => {
      if (document.hasFocus()) lastFocusedAt.current = Date.now();
      const frame = registerFrame(runtime, spaceId, instanceId, latest.current.view, lastFocusedAt.current);
      lastSentRevision = runtime.store.getState().revision;
      port.send(frame);
    };

    const results = new Map<string, Record<string, unknown>>();
    const reply = (requestId: string, result: Result) => {
      const body = result as unknown as Record<string, unknown>;
      results.set(requestId, body);
      if (results.size > RESULT_CACHE) results.delete(results.keys().next().value as string);
      port.send({ type: 'workspace.result', instanceId, requestId, result: body });
    };

    const onCommand = async (frame: WorkspaceBridgeCommandFrame) => {
      if (frame.instanceId !== instanceId) return;
      // A re-sent forward (the node retried after a reconnect) gets the
      // recorded answer, never a second run.
      const recorded = results.get(frame.requestId);
      if (recorded) {
        port.send({ type: 'workspace.result', instanceId, requestId: frame.requestId, result: recorded });
        return;
      }
      if (!(COMMAND_NAMES as readonly string[]).includes(frame.command)) {
        reply(frame.requestId, { status: 'rejected', reason: 'invalid_arguments', revision: runtime.store.getState().revision });
        return;
      }
      const env: CommandEnvelope = {
        command: frame.command as CommandName,
        args: frame.args,
        source: 'remote',
        ...(frame.expectedRevision === undefined ? {} : { expectedRevision: frame.expectedRevision }),
      };
      const prev = runtime.store.getState();
      let result = runtime.dispatch(env);

      // Opened is not rendered (API §9.2, ruling Q3): answer only once the
      // dialog's element is in the DOM, or say it never appeared.
      if (env.command === 'workspace.dialogs.open' && result.status === 'applied' && result.dialogId) {
        const rendered = await whenRendered(result.dialogId, RENDER_ACK_MS);
        if (!rendered) {
          latest.current.dialogs[result.dialogId].setOpen(false);
          result = { status: 'rejected', reason: 'not_rendered', revision: result.revision, dialogId: result.dialogId };
        }
      }
      reply(frame.requestId, result);

      const change = changeOf(env, result, prev, runtime.store.getState(), latest.current.titleOf);
      if (change) {
        const actor = actorLabel(frame.actorClass, frame.actorName);
        const { id, title } = coalescer.add(actor, change);
        latest.current.notify({ id, tone: 'info', title, body: '', ttlMs: NOTICE_TTL_MS });
        // A freshly opened entity's title usually lands a moment after the
        // open; name it then, if this change is still the actor's latest.
        const entityId = (env.args as { entityId?: unknown } | undefined)?.entityId;
        if (env.command === 'workspace.tabs.open' && typeof entityId === 'string' && !('title' in change && change.title)) {
          setTimeout(() => {
            const late = latest.current.titleOf(entityId);
            const fixed = late ? coalescer.retitle(actor, change, late) : null;
            if (fixed) latest.current.notify({ ...fixed, tone: 'info', body: '', ttlMs: NOTICE_TTL_MS });
          }, 1000);
        }
      }
    };

    const offCommand = port.onCommand((frame) => void onCommand(frame));

    // Spec D: the stored workspace. The node sends this window the state right
    // after it registers; from then on the window's commits go to the node and
    // every commit anywhere comes back as a push.
    const viewerId = runtime.viewerId;
    const sync = port.onSync
      ? new WorkspaceSync(runtime, spaceId, instanceId, {
          send: (frame) => port.send(frame),
          notify: (title) => latest.current.notify({ id: `tws-sync-${Date.now()}`, tone: 'info', title, body: '', ttlMs: NOTICE_TTL_MS }),
          onServerMode: () => {
            enterServerMode(runtime);
            attachRailWriter(spaceId, {
              write: (patch) => void runtime.dispatch({ command: 'workspace.rail.set', args: patch, source: 'click' }),
            });
          },
          notifyDraft: (draftId) => {
            const state = runtime.store.getState();
            const active = state.presentation.surface === 'tab' ? state.tabs[state.presentation.tabId] : undefined;
            if (active?.type === 'draft' && active.draftId === draftId) {
              latest.current.notify({ id: `tws-draft-${draftId}`, tone: 'info', title: 'Updated in another window', body: '', ttlMs: NOTICE_TTL_MS });
            }
          },
          legacy: () => ({ state: legacySnapshot({ viewerId, spaceId }), rail: legacyRail(spaceId) }),
        })
      : null;
    const offSync = sync && port.onSync ? port.onSync((frame) => sync.onFrame(frame)) : () => {};
    let lastRail: unknown = runtime.store.getState().rail;
    const offRail = runtime.store.subscribe((state) => {
      if (state.rail === lastRail) return;
      lastRail = state.rail;
      if (state.rail) applyStoredRail(spaceId, state.rail);
    });
    const offOpen = port.onOpen(() => {
      register();
      sync?.reconnected();
    });
    register();

    const heartbeat = setInterval(register, HEARTBEAT_MS);
    const onFocus = () => {
      lastFocusedAt.current = Date.now();
      register();
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', register);
    document.addEventListener('visibilitychange', register);
    const offStore = runtime.store.subscribe((state) => {
      if (state.revision === lastSentRevision || revisionTimer) return;
      revisionTimer = setTimeout(() => {
        revisionTimer = null;
        register();
      }, REVISION_THROTTLE_MS);
    });

    return () => {
      offCommand();
      offOpen();
      offSync();
      offRail();
      sync?.dispose();
      attachRailWriter(spaceId, null);
      offStore();
      clearInterval(heartbeat);
      if (revisionTimer) clearTimeout(revisionTimer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', register);
      document.removeEventListener('visibilitychange', register);
      port.send({ type: 'workspace.unregister', instanceId });
    };
  }, [runtime, port, spaceId, instanceId]);

  // A route change (and the Workspace view mounting) re-registers, after the
  // view's own mount effect has had its turn to set `viewMounted`.
  useEffect(() => {
    if (!runtime || !port || !spaceId || !instanceId) return undefined;
    const timer = setTimeout(() => {
      port.send(registerFrame(runtime, spaceId, instanceId, options.view, lastFocusedAt.current));
    }, 50);
    return () => clearTimeout(timer);
  }, [runtime, port, spaceId, instanceId, options.view]);
}
