/**
 * EntityPanel (Z3) — the workhorse detail view, EXACT uniform anatomy for
 * every kind:
 *   ① header  — breadcrumb (hierarchy.path), kind icon, inline-editable
 *               title, status control, overflow (copy link / copy to space /
 *               watch / delete)
 *   ② action bar — react · points · Link (edge-composer slot, W2/W4) ·
 *               Add child · Pull where meaningful · kind primaries (registry)
 *   ③ body tabs — Content · Discussion · Connections · Activity, SAME ORDER
 *               for every kind. Discussion/Connections accept slot renderers
 *               (the W2 subsystems plug in); sensible fallbacks until then.
 *   ④ footer  — presence avatars · created-by · version + activity time
 *
 * All kind variation comes from the KindRegistry entry — no kind branches.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Avatar, IconBtn, Pill } from '../kit';
import {
  isTombstoned, registryFor, relTime,
} from '../registry';
import { useGraphStore, useNavStore, usePresenceStore } from '../stores';
import {
  isCollabError,
  type ActivityItem, type EdgeGroup, type EntityDetail, type EntityId,
} from '../types/contract';
import type { PanelTab } from '../stores';
import { useFacade } from './context';
import { REGISTRY_CTX } from './ctx';
import { EntityPanelSkeleton } from './skeletons';
import { Tombstone } from './Tombstone';

/** The universal tab set — same order for every kind (the contract). */
export const PANEL_TABS: ReadonlyArray<{ key: PanelTab; label: string }> = [
  { key: 'content', label: 'Content' },
  { key: 'discussion', label: 'Discussion' },
  { key: 'connections', label: 'Connections' },
  { key: 'activity', label: 'Activity' },
];

/** Slot props: W2 subsystems (Thread, ConnectionsRail) mount through these. */
export interface EntityPanelSlots {
  discussion?: (detail: EntityDetail) => ReactNode;
  connections?: (detail: EntityDetail) => ReactNode;
}

export interface EntityPanelProps {
  entityId: EntityId;
  /** Preloaded detail (gallery/tests); when absent the panel fetches. */
  detail?: EntityDetail;
  initialTab?: PanelTab;
  onClose?: () => void;
  /** Edge-composer hook (W4 wires the real composer). */
  onLink?: (detail: EntityDetail) => void;
  /** Add-child hook (W4/W6 wires the creation flow). */
  onAddChild?: (detail: EntityDetail) => void;
  slots?: EntityPanelSlots;
}

function SlotPlaceholder({ name, hint }: { name: string; hint: string }) {
  return (
    <div className="cv2-slot" data-slot={name.toLowerCase()}>
      <span className="cv2-eyebrow">{name}</span>
      <p className="cv2-empty-line">{hint}</p>
    </div>
  );
}

function EdgeGroupList({ groups }: { groups: EdgeGroup[] }) {
  if (groups.length === 0) return null;
  return (
    <>
      {groups.map((g) => (
        <div key={`${g.direction}:${g.type}`} className="cv2-content__section">
          <span className="cv2-eyebrow">
            {g.label} · {g.edges.length}
          </span>
          <div className="cv2-chiprow">
            {g.edges.map((e) => {
              const other = g.direction === 'outgoing' ? e.target : e.source;
              return (
                <span key={e.id} className="cv2-edgeitem">
                  <REGISTRY_CTX.Chip entity={other} />
                  {e.hard != null && (
                    <span className={`cv2-edgeres${e.resolved ? '' : ' cv2-edgeres--open'}`}>
                      HARD {e.resolved ? '✓' : '⚠'}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/** Fallback Connections tab until the W2 rail plugs into the slot. */
function ConnectionsFallback({ detail }: { detail: EntityDetail }) {
  const { hierarchy, connections } = detail;
  return (
    <div className="cv2-content" data-slot="connections-fallback">
      <div className="cv2-content__section">
        <span className="cv2-eyebrow">Hierarchy</span>
        {hierarchy.parent
          ? <div className="cv2-chiprow"><span className="cv2-edgedir">↑</span><REGISTRY_CTX.Chip entity={hierarchy.parent} /></div>
          : <p className="cv2-empty-line">Top of its tree.</p>}
        {hierarchy.children.items.length > 0 && (
          <div className="cv2-chiprow">
            <span className="cv2-edgedir">↓</span>
            {hierarchy.children.items.map((c) => <REGISTRY_CTX.Chip key={c.id} entity={c} />)}
          </div>
        )}
      </div>
      {connections.unresolvedHardDependencyCount > 0 && (
        <Pill tone="blocked">⚠ {connections.unresolvedHardDependencyCount} unresolved hard deps</Pill>
      )}
      <EdgeGroupList groups={connections.outgoing} />
      <EdgeGroupList groups={connections.incoming} />
      <p className="cv2-empty-line">The Connections rail (W2) replaces this basic list.</p>
    </div>
  );
}

function ActivityTab({ entityId }: { entityId: EntityId }) {
  const facade = useFacade();
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void facade.getActivity(entityId)
      .then((page) => { if (!cancelled) setItems(page.items); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [facade, entityId]);

  if (items === null) {
    return (
      <div className="cv2-content" aria-hidden="true">
        <span className="cv2-skel" style={{ width: '80%' }} />
        <span className="cv2-skel" style={{ width: '65%', marginTop: 8 }} />
        <span className="cv2-skel" style={{ width: '70%', marginTop: 8 }} />
      </div>
    );
  }
  if (items.length === 0) return <p className="cv2-empty-line">No activity yet.</p>;
  return (
    <div className="cv2-content cv2-activity">
      {items.map((a) => (
        <div key={a.id} className="cv2-activity__row">
          {a.actor ? <Avatar actor={a.actor} size={18} /> : <span className="cv2-activity__sys">⚙</span>}
          <span className="t-code">{a.verb}</span>
          <span className="cv2-activity__time">{relTime(a.createdAt)}</span>
        </div>
      ))}
    </div>
  );
}

export function EntityPanel({
  entityId, detail: detailProp, initialTab, onClose, onLink, onAddChild, slots,
}: EntityPanelProps) {
  const facade = useFacade();
  const cached = useGraphStore((s) => s.details[entityId]);
  const summary = useGraphStore((s) => s.entities[entityId]);
  const presence = usePresenceStore((s) => s.byEntity[entityId]);
  const isPinned = useNavStore((s) => s.pinned.some((r) => r.entityId === entityId));

  const [tab, setTab] = useState<PanelTab>(initialTab ?? 'content');
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [watching, setWatching] = useState(false);
  const titleInputRef = useRef<HTMLInputElement>(null);

  const detail = detailProp ?? cached;
  // A fresher summary envelope (live events) overlays the cached detail.
  const live = useMemo(
    () => (detail && summary && summary.version >= detail.version ? { ...detail, ...summary } : detail),
    [detail, summary],
  );

  useEffect(() => {
    if (detailProp || cached) return;
    let cancelled = false;
    facade.getEntity(entityId)
      .then((d) => { if (!cancelled) useGraphStore.getState().ingestDetail(d); })
      .catch(() => { /* not_found → tombstone path below when a summary exists */ });
    return () => { cancelled = true; };
  }, [facade, entityId, detailProp, cached]);

  useEffect(() => {
    let cancelled = false;
    facade.getPresence(entityId)
      .then((snap) => { if (!cancelled) usePresenceStore.getState().setSnapshot(entityId, snap); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [facade, entityId]);

  useEffect(() => {
    if (editingTitle) titleInputRef.current?.focus();
  }, [editingTitle]);

  if (!live) {
    return summary && isTombstoned(summary)
      ? <div className="cv2-panel"><div className="cv2-panel__body"><Tombstone entity={summary} variant="card" /></div></div>
      : <EntityPanelSkeleton />;
  }

  const entry = registryFor(live.kind);
  const status = entry.status.current(live);
  const canSetStatus = Boolean(entry.status.options && entry.status.set);
  const refetch = (): void => {
    void facade.getEntity(entityId)
      .then((d) => useGraphStore.getState().ingestDetail(d))
      .catch(() => {});
  };
  const runCommand = (p: Promise<unknown>): void => {
    void p.then(refetch).catch((e: unknown) => {
      if (isCollabError(e) && e.current) useGraphStore.getState().ingestDetail(e.current);
      else refetch();
    });
  };

  const selectTab = (next: PanelTab): void => {
    setTab(next);
    useNavStore.getState().setPanelTab(entityId, next);
  };

  const commitTitle = (): void => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!next || next === live.title || !entry.patchTitle) return;
    runCommand(entry.patchTitle(facade, live, next));
  };

  const close = onClose ?? (() => useNavStore.getState().popPanel());
  const promote = (id: EntityId): void => useNavStore.getState().promotePanel(id);
  const breadcrumb = live.hierarchy.path.filter((p) => p.id !== live.id);
  const viewerReaction = live.counters.viewerReaction;

  return (
    <section className="cv2-panel" data-kind={live.kind} aria-label={`${entry.label}: ${live.title}`}>
      {/* ① header ---------------------------------------------------------- */}
      <header className="cv2-panel__header">
        <div className="cv2-panel__crumbs">
          {breadcrumb.map((p) => (
            <span key={p.id} className="cv2-panel__crumb">
              <REGISTRY_CTX.Chip entity={p} variant="ref" draggable={false} />
              <span className="cv2-panel__crumbsep">›</span>
            </span>
          ))}
          <span className="cv2-panel__controls">
            <IconBtn aria-label={isPinned ? 'Unpin panel' : 'Pin panel as split'} active={isPinned}
              onClick={() => (isPinned ? useNavStore.getState().unpinPanel(entityId) : useNavStore.getState().pinPanel(entityId))}>
              📌
            </IconBtn>
            <IconBtn aria-label="Expand to full view" onClick={() => promote(entityId)}>⤢</IconBtn>
            <IconBtn aria-label="Close panel" onClick={close}>✕</IconBtn>
          </span>
        </div>
        <div className="cv2-panel__titlerow">
          <span className="cv2-chip__glyph" style={{ color: entry.tint(live) }} aria-hidden="true">{entry.glyph}</span>
          {editingTitle && entry.patchTitle ? (
            <input
              ref={titleInputRef}
              className="cv2-panel__titleinput"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setEditingTitle(false);
              }}
              aria-label="Edit title"
            />
          ) : (
            <h2
              className="cv2-panel__title"
              data-editable={entry.patchTitle ? true : undefined}
              title={entry.patchTitle ? 'Click to rename' : undefined}
              onClick={() => {
                if (!entry.patchTitle) return;
                setTitleDraft(live.title);
                setEditingTitle(true);
              }}
            >
              {live.title}
            </h2>
          )}
          {status && <Pill tone={status.tone} pulse={status.pulse}>{status.label}</Pill>}
          {canSetStatus && (
            <select
              className="cv2-panel__status"
              aria-label="Change status"
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v && entry.status.set) runCommand(entry.status.set(facade, live, v));
              }}
            >
              <option value="" disabled>change…</option>
              {entry.status.options!(live).map((o) => (
                <option key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}{o.hint ? ` (${o.hint})` : ''}
                </option>
              ))}
            </select>
          )}
          <span className="cv2-panel__overflow">
            <IconBtn aria-label="More actions" active={menuOpen} onClick={() => setMenuOpen((v) => !v)}>⋯</IconBtn>
            {menuOpen && (
              <div className="cv2-menu" role="menu">
                <button type="button" role="menuitem" onClick={() => {
                  void navigator.clipboard?.writeText(`#/s/${live.spaceId}/e/${live.id}`);
                  setMenuOpen(false);
                }}>Copy link</button>
                <button type="button" role="menuitem" disabled title="Cross-space copy arrives later">Copy to space</button>
                <button type="button" role="menuitem" onClick={() => { setWatching((v) => !v); setMenuOpen(false); }}>
                  {watching ? 'Unwatch' : 'Watch'}
                </button>
                {live.capabilities.canDelete && (
                  <button type="button" role="menuitem" className="cv2-menu__danger" onClick={() => {
                    setMenuOpen(false);
                    void facade.deleteEntity(live.id).then(close).catch(() => refetch());
                  }}>Delete</button>
                )}
              </div>
            )}
          </span>
        </div>
      </header>

      {/* ② action bar ------------------------------------------------------- */}
      <div className="cv2-panel__actions">
        {live.capabilities.canReact && (
          <>
            <IconBtn aria-label="Like" active={viewerReaction === 'like'}
              onClick={() => runCommand(facade.setReaction(live.id, { reaction: 'like', enabled: viewerReaction !== 'like' }))}>
              👍<span className="cv2-actioncount">{live.counters.likes}</span>
            </IconBtn>
            <IconBtn aria-label="Dislike" active={viewerReaction === 'dislike'}
              onClick={() => runCommand(facade.setReaction(live.id, { reaction: 'dislike', enabled: viewerReaction !== 'dislike' }))}>
              👎
            </IconBtn>
            <IconBtn aria-label="Star" active={viewerReaction === 'star'}
              onClick={() => runCommand(facade.setReaction(live.id, { reaction: 'star', enabled: viewerReaction !== 'star' }))}>
              ⭐<span className="cv2-actioncount">{live.counters.stars}</span>
            </IconBtn>
          </>
        )}
        {live.capabilities.canGrantPoints && (
          <IconBtn aria-label="Grant a point" title={`pool ${live.counters.points} pts · hold-to-choose arrives in W4`}
            onClick={() => runCommand(facade.grantPoints(live.id, { amount: 1, reason: 'grant' }))}>
            ◈<span className="cv2-actioncount">{live.counters.points}</span>
          </IconBtn>
        )}
        <span className="cv2-panel__actionsep" />
        {live.capabilities.canLink && (
          <button type="button" className="cv2-actionbtn" data-slot="edge-composer"
            title={onLink ? 'Link to another entity' : 'Edge composer arrives in W4'}
            onClick={() => onLink?.(live)}>
            Link
          </button>
        )}
        {live.capabilities.canAddChild && (
          <button type="button" className="cv2-actionbtn"
            title={onAddChild ? 'Add a child' : 'Creation flow arrives in W4'}
            onClick={() => onAddChild?.(live)}>
            Add child
          </button>
        )}
        {live.capabilities.canPull && (
          <button type="button" className="cv2-actionbtn" title={`Pull at v${live.version}`}
            onClick={() => runCommand(facade.pullEntity(live.id, { pinnedVersion: live.version }))}>
            Pull
          </button>
        )}
        {entry.primaryActions(live).map((a) => (
          <button key={a.id} type="button" className="cv2-actionbtn cv2-actionbtn--primary" title={a.title}
            onClick={() => {
              const out = a.run({ facade, detail: live, nav: { promote } });
              if (out instanceof Promise) runCommand(out);
            }}>
            {a.label}
          </button>
        ))}
      </div>

      {/* ③ body tabs -------------------------------------------------------- */}
      <div className="cv2-panel__tabs" role="tablist" aria-label="Entity sections">
        {PANEL_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className="cv2-panel__tab"
            data-active={tab === t.key || undefined}
            onClick={() => selectTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="cv2-panel__body" role="tabpanel">
        {tab === 'content' && <entry.Content detail={live} ctx={REGISTRY_CTX} />}
        {tab === 'discussion' && (
          slots?.discussion?.(live)
            ?? <SlotPlaceholder name="Discussion" hint="The universal Thread subsystem (W2) plugs in here — every conversation, one component." />
        )}
        {tab === 'connections' && (slots?.connections?.(live) ?? <ConnectionsFallback detail={live} />)}
        {tab === 'activity' && <ActivityTab entityId={live.id} />}
      </div>

      {/* ④ footer ----------------------------------------------------------- */}
      <footer className="cv2-panel__footer">
        <span className="cv2-avatarrow" title="viewing now">
          {(presence?.viewers ?? []).map((v) => <Avatar key={v.id} actor={v} size={18} />)}
        </span>
        <span className="cv2-panel__createdby">
          <Avatar actor={live.createdBy} size={16} /> {live.createdBy.displayName}
        </span>
        <span className="cv2-panel__meta">v{live.version} · active {relTime(live.activityAt)}</span>
      </footer>
    </section>
  );
}
