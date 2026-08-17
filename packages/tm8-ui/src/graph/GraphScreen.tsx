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
import { EntityDetailPanel, type DetailReasons } from '../panels';
import type { ActionContext } from '../domain/types';
import type { Seam, SessionLiveness } from '../data/seam';
import { GraphView, type GraphTimelineStep } from './GraphView';
import { attentionSectionFor } from '../views/attentionSurface';
import { debugSurfaceFor } from '../views/debugSurface';
import { graphSurfaceFor } from '../views/graphSurface';
import { useSessionResume } from '../views/useSessionResume';
import type { Notice } from '../shell/notices';

export interface GraphScreenData {
  spaceId: string;
  detailOf(id: string): EntityDetail | undefined;
  messagesOf(id: string): readonly MessageView[] | undefined;
  postMessage(input: PostMessageInput): Promise<void>;
  livenessOf(id: string): SessionLiveness;
  /** Optional: without it the Debug surface renders its explained absence
   *  rather than a broken table, and resume renders disabled with the same
   *  honesty rather than the generic "not wired on this surface" copy. */
  seam?: Seam;
  /** Folds a command's authoritative detail back into the store. */
  reconcileCommand?(result: CommandResult): void;
  activity: Readonly<Record<string, boolean>>;
  pull?(id: string): void;
}

export interface GraphScreenProps {
  data: GraphScreenData;
  serverBaseUrl?: string;
  reasons: DetailReasons;
  nodes: readonly EntitySummary[];
  edges: readonly EdgeView[];
  timeline?: readonly GraphTimelineStep[];
  now: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** A resume refusal is a server sentence the user can act on. */
  onNotice(notice: Notice): void;
}

type DetailMode = 'aside' | 'full';

export function GraphScreen(props: GraphScreenProps) {
  const { data, reasons } = props;

  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [mode, setMode] = useState<DetailMode>('aside');

  const ctx = useMemo<ActionContext>(() => ({ spaceId: data.spaceId }), [data.spaceId]);

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

  /* A selected node is often a work session, and the aside renders the same
     terminal body as every other host — so it gets the same resume executor. */
  const sessionResume = useSessionResume({
    seam: data.seam,
    reconcile: data.reconcileCommand,
    onNotice: props.onNotice,
  });

  const detailPanel = selectedId ? (
    <EntityDetailPanel
      detail={detail ?? null}
      serverBaseUrl={props.serverBaseUrl}
      loading={!detail}
      host="stack"
      reasons={reasons}
      ctx={{ ...ctx, entityId: selectedId }}
      pinned={false}
      // Same refusal shape as EntityView: the panel HAS a permanent slot here,
      // so the pin verb is refused with the true reason, never hidden (L6).
      pinRefusal="Pinning lives in the Workspace — this view keeps the panel beside the graph already"
      liveness={data.livenessOf(selectedId)}
      attentionSection={attentionSectionFor(data.seam, data.spaceId, selectedId, () => data.pull?.(selectedId))}
      debugSurface={debugSurfaceFor(data.seam, selectedId, data.livenessOf)}
      graphSurface={graphSurfaceFor(data.seam, selectedId, data.livenessOf, (id) =>
        setSelectedId(id as EntityId),
      )}
      {...(sessionResume.resume
        ? { onResumeSession: () => sessionResume.resume?.(selectedId) }
        : {})}
      resumingSession={sessionResume.resumingId === selectedId}
      {...(sessionResume.unavailableReason
        ? { resumeSessionDisabledReason: sessionResume.unavailableReason }
        : {})}
      messages={messages}
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
