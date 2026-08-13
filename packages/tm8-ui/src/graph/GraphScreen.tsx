/**
 * GraphScreen — the full-width screen the ◉ rail row opens (D65 pattern: the
 * workspace is the ONLY three-panel exception; every other activated menu view
 * replaces the centre wholesale). The graph canvas takes the whole width; a
 * node's C1 click opens its Z3 detail panel as an ASIDE beside the canvas
 * (peek ≈440px, floor 320 — the same geometry EntityView uses), because the
 * user still wants the graph while reading the entity. `⤢ promote` expands to
 * the Z4 full form; Esc walks the ladder down: full → aside → canvas only.
 *
 * The screen takes a NARROW structural port (`GraphScreenData`) rather than
 * views' GateData type: the graph carve-out must not import upward from
 * views/, and the port names exactly what this screen consumes.
 */
import { useEffect, useMemo, useState } from 'react';
import type {
  CommandResult,
  EdgeView,
  EntityDetail,
  EntityId,
  EntitySummary,
  MessageView,
  PostMessageInput,
} from '@tm8/contract';
import { EntityDetailPanel, type DetailReasons, type LaunchSources } from '../panels';
import type { ActionContext, ActionRef } from '../domain/types';
import type { Notice } from '../shell/notices';
import { usePanelPrimaries } from '../views/usePanelPrimaries';
import type { Seam, SessionLiveness } from '../data/seam';
import { GraphView, type GraphTimelineStep } from './GraphView';
import { debugSurfaceFor } from '../views/debugSurface';
import { gitSurfaceFor } from '../views/gitSurface';
import { mergePrPortFor } from '../views/mergePrPort';
import { taskGitSectionFor } from '../views/taskGitSection';
import { graphSurfaceFor } from '../views/graphSurface';
import { attachmentsFor } from '../files/port';
import { useMembershipSurface } from '../views/membershipSurface';

export interface GraphScreenData {
  spaceId: string;
  detailOf(id: string): EntityDetail | undefined;
  messagesOf(id: string): readonly MessageView[] | undefined;
  postMessage(input: PostMessageInput): Promise<void>;
  livenessOf(id: string): SessionLiveness;
  /** Optional: without it the Debug surface renders its explained absence
   *  rather than a broken table. */
  seam?: Seam;
  activity: Readonly<Record<string, boolean>>;
  /** Cache FILL for an aside whose detail is missing. Never a refresh — see
   *  `refetchDetail`, and `useGateData`'s docblock on the difference. */
  pull?(id: string): void;
  /** Invalidating re-read, for a local write that lands on the detail itself
   *  (an `attached_to` edge). REQUIRED: a host without it draws an attachment
   *  control that changes nothing on screen. */
  refetchDetail(id: string): void;
  /**
   * Folds a command's own result back into the detail cache.
   *
   * REVIEW F3 — without it this screen sent Terminate and DROPPED the
   * `CommandResult`, so the aside kept showing the old status until an
   * unrelated live event happened along: the same verb, visibly slower here
   * than at the other four mounts. Optional because the port is narrow by
   * charter and a host may genuinely have no cache to reconcile; `GateData`
   * supplies it, so the real caller gets the same behaviour as everywhere
   * else without naming it.
   */
  reconcileCommand?(result: CommandResult): void;
}

export interface GraphScreenProps {
  data: GraphScreenData;
  serverBaseUrl?: string;
  reasons: DetailReasons;
  /**
   * Run's configuration sources for the aside panel.
   *
   * A PROP rather than a member of `GraphScreenData`, deliberately: the port
   * above names what this screen READS, and these are the shell's verbs and
   * catalogues. It also keeps the narrow port from having to describe the
   * whole launch surface. Absent ⇒ Run keeps its disabled-with-reason.
   */
  launch?: LaunchSources;
  /** Where a failed panel command reports. Absent ⇒ it fails silently. */
  onNotice?(notice: Notice): void;
  nodes: readonly EntitySummary[];
  edges: readonly EdgeView[];
  timeline?: readonly GraphTimelineStep[];
  now: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

type DetailMode = 'aside' | 'full';

export function GraphScreen(props: GraphScreenProps) {
  const { data, reasons } = props;

  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [mode, setMode] = useState<DetailMode>('aside');

  const ctx = useMemo<ActionContext>(() => ({ spaceId: data.spaceId }), [data.spaceId]);

  /* ATTACHMENTS. `data.seam` is optional on this port, so the helper answers
     `undefined` for a host without one and the strip stays read-only rather
     than drawing a dropzone that could not upload. */
  const attachments = useMemo(
    () => attachmentsFor(data.seam, data.spaceId),
    [data.seam, data.spaceId],
  );

  /* COLLECTION MEMBERSHIP — the one shared composer (see `membershipSurface`).
     `data.seam` is optional on this port; without one `authoringFor` answers
     null and the block's add control refuses with the unwired reason. */
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => data.refetchDetail(id),
    ...(props.onNotice ? { onNotice: props.onNotice } : {}),
  });

  /* The aside is a FULL panel, so its primaries are wired from the same hook
     the workspace uses. `data.seam` is optional on this port; without one the
     hook answers `undefined` and the verb keeps its honest refusal rather than
     drawing a button whose command could not be sent. */
  const primaries = usePanelPrimaries({
    ...(data.seam ? { seam: data.seam } : {}),
    ...(data.reconcileCommand ? { reconcileCommand: data.reconcileCommand } : {}),
    ...(props.onNotice
      ? {
          onError: (_verb: ActionRef, _entityId: string, error: unknown) =>
            props.onNotice?.({
              id: 'session-close-failed',
              tone: 'error',
              title: 'Session could not be closed',
              body: String((error as { message?: string })?.message ?? error),
              ttlMs: 6_000,
            }),
        }
      : {}),
  });

  // Esc walks DOWN one level per press (EntityView's ladder, same reasons):
  // only when the event reaches the document unclaimed — a focused canvas
  // pans with arrows but never claims Esc.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || selectedId === null) return;
      if (event.defaultPrevented) return;
      event.preventDefault();
      if (mode === 'full') setMode('aside');
      else setSelectedId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedId, mode]);

  const detail = selectedId ? data.detailOf(selectedId) : null;
  const messages = selectedId ? data.messagesOf(selectedId) : undefined;
  if (selectedId && (
    !detail || messages === undefined || messages.length < detail.counters.messages
  )) data.pull?.(selectedId);

  const detailPanel = selectedId ? (
    <EntityDetailPanel
      detail={detail ?? null}
      serverBaseUrl={props.serverBaseUrl}
      loading={!detail}
      host="stack"
      reasons={reasons}
      ctx={{ ...ctx, entityId: selectedId }}
      onAction={primaries.forEntity(selectedId)}
      wiredActions={primaries.wiredActions}
      membershipAuthoring={membership.authoringFor(detail)}
      launch={props.launch}
      // `data.seam` is optional on this narrow port, so the helper answers
      // null for a host without one and the confirm renders its not-wired
      // refusal instead of a live Confirm merge.
      mergePr={mergePrPortFor(data.seam)}
      pinned={false}
      // Same refusal shape as EntityView: the panel HAS a permanent slot here,
      // so the pin verb is refused with the true reason, never hidden (L6).
      pinRefusal="Pinning lives in the Workspace — this view keeps the panel beside the graph already"
      liveness={data.livenessOf(selectedId)}
      debugSurface={debugSurfaceFor(data.seam, selectedId, data.livenessOf)}
      gitSurface={gitSurfaceFor(data.seam, selectedId, data.livenessOf)}
      taskGitSection={taskGitSectionFor(data.seam, detail ?? null, (id) => setSelectedId(id as EntityId))}
      graphSurface={graphSurfaceFor(data.seam, selectedId, data.livenessOf, (id) =>
        setSelectedId(id as EntityId),
      )}
      attachments={attachments}
      onAttachmentUploaded={() => data.refetchDetail(selectedId)}
      messages={messages}
      // The executor the other three panel hosts pass. Without it every
      // title-editable kind selected here dresses its title as locked and
      // mounts a permanently-disabled Save — a refusal about THIS MOUNT, not
      // about the entity, in front of a user who can edit the same thing one
      // screen over.
      commands={data.seam?.commands}
      onPostMessage={(body) => data.postMessage({
        clientMutationId: `graph-post:${selectedId}:${Date.now()}`,
        anchorIds: [selectedId],
        body,
      })}
      streaming={data.activity[selectedId] ?? false}
      onPromote={() => setMode((m) => (m === 'aside' ? 'full' : 'aside'))}
      onClose={() => {
        setSelectedId(null);
        setMode('aside');
      }}
    />
  ) : null;

  const graph = (
    <GraphView
      nodes={props.nodes}
      edges={props.edges}
      timeline={props.timeline}
      now={props.now}
      onSelect={(id) => setSelectedId(id)}
      livenessOf={data.livenessOf}
      selectedId={selectedId}
    />
  );

  if (props.loading && props.nodes.length === 0) {
    return (
      <div className="gv-screen" data-testid="graph-screen" data-mode="loading">
        <div className="gv-empty" role="status">
          <p className="gv-empty__title">Loading the workspace graph…</p>
        </div>
      </div>
    );
  }

  if (props.error && props.nodes.length === 0) {
    return (
      <div className="gv-screen" data-testid="graph-screen" data-mode="error">
        <div className="gv-empty" role="alert">
          <p className="gv-empty__title">The graph could not be read.</p>
          <p className="gv-empty__detail">{props.error}</p>
          {props.onRetry ? (
            <button type="button" className="gv-filter" onClick={props.onRetry}>
              Retry graph
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (mode === 'full' && selectedId) {
    return (
      <div className="gv-screen" data-testid="graph-screen" data-mode="full">
        <div className="gv-screen__full-head">
          <button
            type="button"
            className="gv-screen__collapse"
            onClick={() => setMode('aside')}
            aria-label="Collapse to panel"
          >
            ⇲ collapse
          </button>
          <span className="gv-screen__crumb">graph · full view</span>
          <span className="gv-screen__spacer" />
          <span className="gv-screen__esc">esc</span>
        </div>
        <div className="gv-screen__full-body">{detailPanel}</div>
      </div>
    );
  }

  return (
    <div className="gv-screen" data-testid="graph-screen" data-mode={selectedId ? 'aside' : 'canvas'}>
      <div className="gv-screen__split">
        <section className="gv-screen__canvas" aria-label="Entity graph">
          {graph}
        </section>
        {selectedId ? (
          <aside className="gv-screen__aside" aria-label="Entity details" data-testid="graph-screen-aside">
            {detailPanel}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
