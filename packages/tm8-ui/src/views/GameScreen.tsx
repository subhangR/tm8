/** The Game shell owns inspection; GameMode owns walking and browser resume. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import GameMode from '../game/GameMode';
import type { GameMapLoader } from '../data/game-maps';
import type { ControlHost, DetailReasons } from '../panels';
import type { Notice } from '../shell';
import { attachmentsFor } from '../files/port';
import { AuxEntityPanel, type AuxPanelHost } from './auxPanel';
import { useLaunchPort } from './useLaunchPort';
import { useMembershipSurface } from './membershipSurface';
import { usePanelPrimaries } from './usePanelPrimaries';
import { useRowLifecycle } from './useRowLifecycle';
import type { GateData } from './useGateData';
import './game-screen.css';

interface GameScreenProps {
  data: GateData & { pull(id: string): void };
  memberId: string;
  loadMap: GameMapLoader;
  reasons: DetailReasons;
  serverBaseUrl?: string;
  onNotice(notice: Notice): void;
}

export function GameScreen({ data, memberId, loadMap, reasons, serverBaseUrl, onNotice }: GameScreenProps) {
  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const mapRegion = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasInspecting = useRef(false);
  const inspect = useCallback((id: string) => {
    const active = document.activeElement;
    if (!wasInspecting.current) returnFocus.current = active instanceof HTMLElement && mapRegion.current?.contains(active) ? active : null;
    setSelectedId(id as EntityId);
  }, []);
  useEffect(() => {
    if (!selectedId && wasInspecting.current) {
      const target = returnFocus.current;
      if (target?.isConnected) target.focus();
      else mapRegion.current?.focus();
      returnFocus.current = null;
    }
    wasInspecting.current = !!selectedId;
  }, [selectedId]);
  const detail = selectedId ? data.detailOf(selectedId) : undefined;
  useEffect(() => {
    if (selectedId && !detail) data.pull(selectedId);
  }, [selectedId, detail, data]);

  // Dismissing an inspection consumes Esc before GameMode can pop a map.
  useEffect(() => {
    if (!selectedId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedId(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [selectedId]);

  const ctx = useMemo(() => ({ spaceId: data.spaceId }), [data.spaceId]);
  const launchPort = useLaunchPort(data);
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    versionOf: (id) => data.detailOf(id)?.version,
    stateOf: (id) => data.detailOf(id)?.state,
    onError: (_verb, _id, error) => onNotice({
      id: 'game-inspection-action-failed', tone: 'error', title: 'That did not go through',
      body: String(error instanceof Error ? error.message : error), ttlMs: 6000,
    }),
  });
  const rowLifecycle = useRowLifecycle({ data, viewerMemberId: memberId, onNotice });
  const membership = useMembershipSurface({
    spaceId: data.spaceId, seam: data.seam, refetchDetail: data.refetchDetail, onNotice,
  });
  const attachments = useMemo(() => attachmentsFor(data.seam, data.spaceId), [data.seam, data.spaceId]);
  const controls: ControlHost = {
    kind: detail?.kind ?? '', ctx, livenessOf: data.livenessOf,
    capabilitiesOf: data.capabilitiesOf, onNeedDetail: data.pull,
    onAction: (ref, id) => primaries.forEntity(id)?.(ref),
    onSetState: rowLifecycle.setState, onArchive: rowLifecycle.archive,
    onSetValue: rowLifecycle.setValue, onAssign: rowLifecycle.assign,
    assignableActors: rowLifecycle.assignable, onMembership: rowLifecycle.membership,
    membershipSets: rowLifecycle.membershipSets, connectionsOf: data.connectionsOf,
  };
  const host: AuxPanelHost = {
    data, reasons, ctx, controls, primaries, membership, launchPort, rowLifecycle,
    attachments, serverBaseUrl, viewerMemberId: memberId,
  };

  return (
    <div className="game-screen" data-testid="game-screen">
      <div className="game-screen__map" ref={mapRegion} tabIndex={-1} aria-label="Game map">
        <GameMode spaceId={data.spaceId} memberId={memberId} spaceTitle={data.spaces.find(space => space.id === data.spaceId)?.name}
          loadMap={loadMap} onInspect={inspect} />
      </div>
      {selectedId ? (
        <aside className="game-screen__inspection" aria-label="Entity details" data-testid="game-inspection">
          <AuxEntityPanel host={host} entityId={selectedId} onOpenEntity={setSelectedId}
            onClose={() => setSelectedId(null)} />
        </aside>
      ) : null}
      {primaries.dialog}
    </div>
  );
}
