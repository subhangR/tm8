/**
 * ConnectionsRail — the graph, made tactile. Two stacked sections:
 *
 *   ① Hierarchy — parent chip up, ordered children down (add / reorder /
 *     reparent intents, "open as tree|board").
 *   ② Edges grouped by type with direction labels — per-item HARD/SOFT
 *     resolution badges, an unresolved rollup per group, a blocked rollup
 *     banner for the whole entity, hover previews + click-hops (the chip),
 *     inline "+" per group, remove on hover, `x:*` groups rendered as-is.
 *
 * Mounts anywhere: `<ConnectionsRail entityId />` fetches its own sections;
 * inside EntityPanel it plugs into the Connections SLOT (see
 * `connectionsSlot()` below) and reuses the detail the panel already has.
 *
 * Every mutation carries a clientMutationId (idempotency is universal in the
 * contract) and every failure is reported by error CODE, not status text.
 */
import { useCallback, useState } from 'react';
import { EntityChip, useFacade, type EntityPanelSlots } from '../../entity';
import { Pill } from '../../kit';
import { useGraphStore, useNavStore } from '../../stores';
import {
  isCollabError,
  type CommandResult, type EdgeGroup, type EdgeView, type EntityDetail,
  type EntityId, type EntitySummary,
} from '../../types/contract';
import { EdgeComposer, type PickEntity } from './EdgeComposer';
import { EdgeGroupSection } from './EdgeGroupSection';
import { HierarchySection } from './HierarchySection';
import {
  edgeEndpoints, groupKey, newMutationId, orderedGroups, waitingOn,
  type ReorderPlan,
} from './model';
import { useRailData } from './useRailData';
import './rail.css';

export interface ConnectionsRailProps {
  entityId: EntityId;
  /** Preloaded detail (the panel slot) — skips the lazy section fetch. */
  detail?: EntityDetail;
  /** Click-hop target; defaults to pushing a Z3 panel on the nav stack. */
  onOpenEntity?: (id: EntityId) => void;
  /** W3: open the family as a tree/board collection view. */
  onOpenCollection?: (intent: { entityId: EntityId; layout: 'tree' | 'board' }) => void;
  /** W4/W6 creation flow. */
  onAddChild?: (parentId: EntityId) => void;
  /**
   * Reorder intent. Omitted → the rail performs the move itself through
   * `moveEntity`; supply it to take over (e.g. dnd-kit optimistic ordering).
   */
  onReorder?: (plan: ReorderPlan) => void;
  /** Reparent intent (drag in/out). Omitted → the rail performs the move. */
  onReparent?: (move: { childId: EntityId; newParentId: EntityId | null }) => void;
  /** Entity picker for the inline composer — the ⌘K palette becomes this. */
  pickEntity?: PickEntity;
  /** Offline candidates for the composer while there is no picker. */
  candidates?: EntitySummary[];
  /** Force read-only (audit views, tombstones). */
  readOnly?: boolean;
}

export function ConnectionsRail({
  entityId, detail, onOpenEntity, onOpenCollection, onAddChild,
  onReorder, onReparent, pickEntity, candidates, readOnly = false,
}: ConnectionsRailProps) {
  const facade = useFacade();
  const summary = useGraphStore((s) => s.entities[entityId]);
  const { hierarchy, connections, loading, failed, childrenLoading, refresh, loadMoreChildren } =
    useRailData(entityId, detail);
  const [error, setError] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  const capabilities = detail?.capabilities;
  const canEdit = !readOnly && (capabilities?.canLink ?? true);
  const canAddChild = !readOnly && (capabilities?.canAddChild ?? true);

  const openEntity = onOpenEntity
    ?? ((id: EntityId) => useNavStore.getState().pushPanel({ entityId: id }));

  const run = useCallback((p: Promise<CommandResult>) => {
    setError(null);
    void p
      .then((res) => {
        if (res.entity) useGraphStore.getState().ingestDetail(res.entity);
        if (res.patches.length > 0) useGraphStore.getState().ingestSummaries(res.patches);
        refresh();
      })
      .catch((e: unknown) => {
        if (isCollabError(e)) {
          if (e.current) useGraphStore.getState().ingestDetail(e.current);
          setError(`${e.code}: ${e.message}`);
        } else {
          setError(e instanceof Error ? e.message : 'command failed');
        }
        refresh();
      });
  }, [refresh]);

  const addEdge = useCallback((input: {
    type: string; otherId: EntityId; direction: EdgeGroup['direction'];
  }) => {
    const { srcId, dstId } = edgeEndpoints(entityId, input.otherId, input.direction);
    run(facade.createEdge({ srcId, dstId, type: input.type, clientMutationId: newMutationId() }));
  }, [facade, entityId, run]);

  const removeEdge = useCallback((edge: EdgeView) => {
    run(facade.deleteEdge(edge.id, { clientMutationId: newMutationId() }));
  }, [facade, run]);

  const childVersion = (childId: EntityId): number | undefined =>
    hierarchy?.children.items.find((c) => c.id === childId)?.version
    ?? useGraphStore.getState().entities[childId]?.version;

  const handleReorder = useCallback((plan: ReorderPlan) => {
    if (onReorder) { onReorder(plan); return; }
    const expectedVersion = childVersion(plan.childId);
    if (expectedVersion == null) return;
    run(facade.moveEntity(plan.childId, {
      parentId: entityId, position: plan.position, expectedVersion,
      clientMutationId: newMutationId(),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facade, entityId, onReorder, run, hierarchy]);

  const handleReparent = useCallback((move: { childId: EntityId; newParentId: EntityId | null }) => {
    if (onReparent) { onReparent(move); return; }
    const expectedVersion = childVersion(move.childId)
      ?? (move.childId === entityId ? (detail?.version ?? summary?.version) : undefined);
    if (expectedVersion == null) return;
    const siblings = move.newParentId === entityId ? (hierarchy?.children.items.length ?? 0) : 0;
    run(facade.moveEntity(move.childId, {
      parentId: move.newParentId, position: siblings, expectedVersion,
      clientMutationId: newMutationId(),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facade, entityId, onReparent, run, hierarchy, detail, summary]);

  if (loading && !connections && !hierarchy) {
    return (
      <div className="cv2-rail" data-state="loading" aria-busy="true">
        <span className="cv2-skel" style={{ width: '55%' }} />
        <span className="cv2-skel" style={{ width: '75%', marginTop: 8 }} />
        <span className="cv2-skel" style={{ width: '40%', marginTop: 8 }} />
      </div>
    );
  }

  if (failed && !connections) {
    return (
      <div className="cv2-rail" data-state="failed">
        <p className="cv2-empty-line">Connections could not be loaded.</p>
        <button type="button" className="cv2-actionbtn" onClick={refresh}>Retry</button>
      </div>
    );
  }

  const blockedCount = connections?.unresolvedHardDependencyCount ?? 0;
  const blockers = connections
    ? waitingOn(connections, (detail ?? summary)?.badges.blocked?.waitingOn)
    : [];
  const groups = connections ? orderedGroups(connections) : [];

  return (
    <div className="cv2-rail" data-entity={entityId}>
      {blockedCount > 0 && (
        <div className="cv2-rail__blocked" role="status">
          <Pill tone="blocked">⚠ Blocked</Pill>
          <span className="cv2-rail__blockedtext">
            {blockedCount} unresolved hard {blockedCount === 1 ? 'dependency' : 'dependencies'} · waiting on
          </span>
          <span className="cv2-chiprow">
            {blockers.map((b) => <EntityChip key={b.id} entity={b} onOpen={openEntity} />)}
          </span>
        </div>
      )}

      {hierarchy && (
        <HierarchySection
          entityId={entityId}
          hierarchy={hierarchy}
          canAddChild={canAddChild}
          canEdit={canEdit}
          onOpenEntity={openEntity}
          onAddChild={onAddChild}
          onReorder={handleReorder}
          onReparent={handleReparent}
          onOpenCollection={onOpenCollection}
          childrenLoading={childrenLoading}
          onLoadMoreChildren={loadMoreChildren}
        />
      )}

      <div className="cv2-rail__edges">
        {groups.length === 0 && (
          <p className="cv2-empty-line">Nothing linked yet — use “+ Link” or drop a chip here.</p>
        )}
        {groups.map((group) => (
          <EdgeGroupSection
            key={groupKey(group)}
            entityId={entityId}
            group={group}
            canEdit={canEdit}
            onOpenEntity={openEntity}
            onRemove={removeEdge}
            onAdd={addEdge}
            pickEntity={pickEntity}
            candidates={candidates}
          />
        ))}
      </div>

      {canEdit && (
        composing
          ? (
            <EdgeComposer
              sourceId={entityId}
              direction="outgoing"
              pickEntity={pickEntity}
              candidates={candidates}
              onSubmit={(input) => { setComposing(false); addEdge(input); }}
              onCancel={() => setComposing(false)}
            />
          )
          : (
            <button type="button" className="cv2-actionbtn" onClick={() => setComposing(true)}>
              + Link
            </button>
          )
      )}

      {error && <p className="cv2-rail__error" role="alert">{error}</p>}
    </div>
  );
}

/**
 * The EntityPanel Connections-slot adapter. `slots={{ connections: connectionsSlot() }}`
 * — the panel hands the detail it already loaded straight through.
 */
export type ConnectionsSlot = NonNullable<EntityPanelSlots['connections']>;

export function connectionsSlot(
  options: Omit<ConnectionsRailProps, 'entityId' | 'detail'> = {},
): ConnectionsSlot {
  return (detail) => (
    <ConnectionsRail {...options} entityId={detail.id} detail={detail} />
  );
}
