/**
 * FullViewScreen — the Z4 full view, MOUNTED (PR 1004), for the kinds whose
 * registry row opts in (`panel.fullView`; today only `story`).
 *
 * `EntityFullView` resolves the route and `Z4Host` places it; what neither
 * had was a caller that could build the panel. This is that caller, and it
 * builds it the way every other screen does: the same host bundle HomeView
 * assembles (launch port, primaries, row lifecycle, membership, attachments,
 * control host) handed to the same `AuxEntityPanel`, here with `host='z4'`.
 * One panel, never a poorer second assembly.
 *
 * THE BESIDE SLOT. A story's page opens what you press next to it, never in
 * its place (Subhang, PR 1004). In full view that is a right-hand column
 * holding a second `AuxEntityPanel`; closing it returns the whole width to the
 * story. It is local state: the full view's address names the story, and the
 * entity beside it is a glance, not a destination.
 *
 * LEAVING. ⤢ (the same control that opened it), the panel's ✕, and Esc all
 * return to the companion `companionOf` resolves — the kind screen, with this
 * entity still open there and its graph filter carried along. Esc closes the
 * beside panel first when one is open. A cold link's first step out REPLACES
 * (R15), exactly as `EntityFullView.onLeave` rules it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntityId, EntityKind, ExecutionSpawnInput } from '@tm8/contract';

import { getKind, type ActionRef } from '../../domain';
import { attachmentsFor } from '../../files/port';
import type { ControlHost, DetailReasons } from '../../panels';
import type { Origin } from '../../routes';
import type { Notice } from '../../shell';
import { navStore } from '../../stores/navStore';
import { AuxEntityPanel, type AuxPanelHost } from '../auxPanel';
import { useLaunchPort } from '../useLaunchPort';
import { useMembershipSurface } from '../membershipSurface';
import { usePanelPrimaries } from '../usePanelPrimaries';
import { useRowLifecycle } from '../useRowLifecycle';
import { useEntityVerbs } from '../useEntityVerbs';
import { useChatAbout } from '../useChatAbout';
import type { GateData } from '../useGateData';
import { EntityFullView, companionOf, type EntityArrival } from './EntityFullView';
import type { EntityFullPort } from './port';
import './full-view.css';

export interface FullViewScreenProps {
  data: GateData & { pull?: (id: string) => void };
  reasons: DetailReasons;
  entityId: EntityId;
  origin: Origin | null;
  /** The graph filter the address carries, kept on the way out. */
  hops?: 1 | 2 | 3 | null;
  kinds?: readonly string[] | null;
  serverBaseUrl?: string | undefined;
  viewerMemberId?: string | null | undefined;
  onNotice(notice: Notice): void;
  onSpawn?(input: ExecutionSpawnInput): void | Promise<void>;
  onLaunchOpen?(id: EntityId): void;
  /** The header's Chat — the same dispatcher the kind screen is handed. */
  onChatAbout?(aboutId: EntityId | null): void;
}

/** Does this kind's registry row build a full view? Registry data, no kind literal. */
export function hasFullView(kind: string | null | undefined): boolean {
  return !!kind && getKind(kind).panel.fullView === true;
}

export function FullViewScreen(props: FullViewScreenProps) {
  const { data, onNotice, entityId } = props;
  const detail = data.detailOf(entityId);
  const kind = (detail?.kind ?? null) as EntityKind | null;

  /* The beside slot. A different subject drops it. */
  const [besideId, setBesideId] = useState<EntityId | null>(null);
  useEffect(() => setBesideId(null), [entityId]);

  /* A cold link: nothing behind us, so the first step out replaces (R15). */
  const [arrival] = useState<EntityArrival>(() =>
    typeof window !== 'undefined' && window.history.length <= 1 ? 'link' : 'promote',
  );

  const notifyActionFailed = useCallback(
    (_verb: ActionRef, _entityId: string, error: unknown) => {
      onNotice({
        id: 'full-view-action-failed',
        tone: 'error',
        title: 'That did not go through',
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 6_000,
      });
    },
    [onNotice],
  );
  const launchPort = useLaunchPort(data, {
    ...(props.onSpawn ? { onSpawn: props.onSpawn } : {}),
    ...(props.onLaunchOpen ? { onFullOptions: (id: string) => props.onLaunchOpen!(id as EntityId) } : {}),
  });
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: notifyActionFailed,
    versionOf: (id) => data.detailOf(id)?.version,
  });
  const rowLifecycle = useRowLifecycle({ data, viewerMemberId: props.viewerMemberId, onNotice });
  const membership = useMembershipSurface({
    spaceId: data.spaceId,
    seam: data.seam,
    refetchDetail: (id) => data.refetchDetail(id),
    onNotice,
  });
  const attachments = useMemo(() => attachmentsFor(data.seam, data.spaceId), [data.seam, data.spaceId]);
  /* The header's Chat and Edit, wired as on the kind screen's centre panel
     (the aux column is a reading surface and has neither). */
  const chatAbout = useChatAbout({ open: props.onChatAbout });
  const verbs = useEntityVerbs({
    detail,
    spaceId: data.spaceId,
    commands: data.seam.commands,
    onCreated: (id) => setBesideId(id as EntityId),
    onSaved: (id) => data.refetchDetail(id),
  });
  const ctx = useMemo(() => ({ spaceId: data.spaceId }), [data.spaceId]);
  const controls = useMemo<ControlHost>(
    () => ({
      kind: kind ?? '',
      ctx,
      livenessOf: data.livenessOf,
      capabilitiesOf: (id) => data.capabilitiesOf(id),
      onNeedDetail: (id: string) => data.pull?.(id),
      onAction: (ref, id) => primaries.forEntity(id)?.(ref),
      onSetState: rowLifecycle.setState,
      onArchive: rowLifecycle.archive,
      onSetValue: rowLifecycle.setValue,
      onAssign: rowLifecycle.assign,
      assignableActors: rowLifecycle.assignable,
      onMembership: rowLifecycle.membership,
      membershipSets: rowLifecycle.membershipSets,
      connectionsOf: data.connectionsOf,
    }),
    [kind, ctx, data, primaries, rowLifecycle],
  );
  const host: AuxPanelHost = {
    data,
    reasons: props.reasons,
    ctx,
    controls,
    primaries,
    membership,
    launchPort,
    rowLifecycle,
    attachments,
    chatAbout,
    serverBaseUrl: props.serverBaseUrl,
    viewerMemberId: props.viewerMemberId,
  };


  const port = useMemo<EntityFullPort>(
    () => ({
      lookup: (id) => {
        const d = data.detailOf(id);
        return d ? { status: 'ready', kind: d.kind as EntityKind } : { status: 'resolving' };
      },
    }),
    [data],
  );

  /* Back to the companion, WITH this entity open there and the filter kept. */
  const companion = companionOf(props.origin, kind);
  const { hops, kinds } = props;
  const leave = useCallback(() => {
    const back = companion
      ? {
          view: 'entity' as const,
          entityId,
          origin: { slug: companion.slug, mode: companion.mode ?? null },
          ...(hops ? { hops } : {}),
          ...(kinds ? { kinds } : {}),
        }
      : { view: 'home' as const };
    if (arrival === 'link') {
      navStore.setState((s) => ({ view: back, history: 'replace', revision: s.revision + 1 }));
    } else {
      navStore.getState().navigate(back);
    }
  }, [companion, entityId, hops, kinds, arrival]);

  /* Esc: the beside panel first, then the full view itself. Not while typing,
     and not when something else (a sheet, a popover) already used the key. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]') !== null)) return;
      if (besideId) setBesideId(null);
      else leave();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [besideId, leave]);

  /* Fetch what nothing knows yet: the subject on a cold link, and the entity
     opened beside it — the aux column's host pulls its subject the same way,
     and without this the beside panel sat on its skeleton for good. */
  useEffect(() => {
    if (!detail) data.pull?.(entityId);
  }, [detail, data, entityId]);
  const besideDetail = besideId ? data.detailOf(besideId) : undefined;
  useEffect(() => {
    if (besideId && !besideDetail) data.pull?.(besideId);
  }, [besideId, besideDetail, data]);

  const panel = (
    <div className={`fv-split${besideId ? ' fv-split--beside' : ''}`} data-testid="full-view-split">
      <div className="fv-split__main">
        <AuxEntityPanel
          host={host}
          entityId={entityId}
          panelHost="z4"
          onPromote={leave}
          onOpenEntity={(id) => setBesideId(id)}
          onClose={leave}
          story={{ open: (id) => setBesideId(id), selectedId: besideId, layout: 'full' }}
          extraActions={{ onAction: verbs.onAction, wiredActions: verbs.wiredActions }}
        />
      </div>
      {besideId ? (
        <aside className="fv-split__beside" aria-label="Details beside the full view">
          <AuxEntityPanel
            host={host}
            entityId={besideId}
            onOpenEntity={(id) => setBesideId(id)}
            onClose={() => setBesideId(null)}
          />
        </aside>
      ) : null}
    </div>
  );

  return (
    <EntityFullView
      entityId={entityId}
      origin={props.origin}
      arrival={arrival}
      port={port}
      knownKind={kind}
      panel={panel}
      followTheme
    />
  );
}
