/**
 * EntityFullView (Z4) — the panel promoted to a URL-addressable route, with
 * room-demanding layout variants keyed by the registry (`fullLayout`):
 *   reader  (doc)        — chapter tree · reader prose · margin-thread slot
 *   hub     (channel)    — content shelf + hub slot (the W3 channel hub)
 *   subtree (task)       — content + children board + dependency slot
 *   profile (member/TM)  — identity header + content + work grid
 *   generic (fallback)   — prose + children grid
 * Expand ⤢ (panel) / collapse ⤡ (here) round-trip through the nav store.
 */
import { useEffect, type ReactNode } from 'react';
import { Avatar, Pill } from '../kit';
import { isTombstoned, registryFor, relTime } from '../registry';
import type { FullLayoutVariant } from '../registry';
import { useGraphStore, useNavStore } from '../stores';
import type { EntityDetail, EntityId, EntitySummary } from '../types/contract';
import { useFacade } from './context';
import { REGISTRY_CTX } from './ctx';
import { EntityCard } from './EntityCard';
import { EntityPanelSkeleton } from './skeletons';
import { Tombstone } from './Tombstone';

export interface EntityFullViewSlots {
  /** doc reader margin threads (W2). */
  margin?: (detail: EntityDetail) => ReactNode;
  /** channel hub feed (W3). */
  hub?: (detail: EntityDetail) => ReactNode;
  /** task dependency mini-graph (W2/W4). */
  dependencies?: (detail: EntityDetail) => ReactNode;
}

export interface EntityFullViewProps {
  entityId: EntityId;
  /** Preloaded detail (gallery/tests); when absent the view fetches. */
  detail?: EntityDetail;
  /** Collapse ⤡ back to a Z3 panel (default: home view + pushed panel). */
  onCollapse?: () => void;
  slots?: EntityFullViewSlots;
}

function SlotBox({ name, hint, children }: { name: string; hint: string; children?: ReactNode }) {
  return (
    <div className="cv2-slot cv2-slot--full" data-slot={name.toLowerCase().replace(/\s+/g, '-')}>
      <span className="cv2-eyebrow">{name}</span>
      {children ?? <p className="cv2-empty-line">{hint}</p>}
    </div>
  );
}

function ChildrenGrid({ items, title }: { items: EntitySummary[]; title: string }) {
  if (items.length === 0) return null;
  const openChild = (id: EntityId): void => useNavStore.getState().setView('entity', id);
  return (
    <div className="cv2-full__section">
      <span className="cv2-eyebrow">{title} · {items.length}</span>
      <div className="cv2-cardgrid">
        {items.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            className="cv2-cardgrid__cell"
            onClick={() => openChild(c.id)}
            onKeyDown={(e) => { if (e.key === 'Enter') openChild(c.id); }}
          >
            <EntityCard entity={c} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function EntityFullView({ entityId, detail: detailProp, onCollapse, slots }: EntityFullViewProps) {
  const facade = useFacade();
  const cached = useGraphStore((s) => s.details[entityId]);
  const detail = detailProp ?? cached;

  useEffect(() => {
    if (detailProp || cached) return;
    let cancelled = false;
    facade.getEntity(entityId)
      .then((d) => { if (!cancelled) useGraphStore.getState().ingestDetail(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [facade, entityId, detailProp, cached]);

  if (!detail) return <EntityPanelSkeleton />;
  if (isTombstoned(detail)) {
    return <div className="cv2-full"><Tombstone entity={detail} variant="card" /></div>;
  }

  const entry = registryFor(detail.kind);
  const status = entry.status.current(detail);
  const children = detail.hierarchy.children.items;
  const collapse = onCollapse ?? (() => {
    const nav = useNavStore.getState();
    nav.setView('home');
    nav.pushPanel({ entityId });
  });
  const content = <entry.Content detail={detail} ctx={REGISTRY_CTX} />;

  const bodies: Record<FullLayoutVariant, ReactNode> = {
    reader: (
      <div className="cv2-full__grid cv2-full__grid--reader">
        <aside className="cv2-full__rail">
          <span className="cv2-eyebrow">Chapters</span>
          {children.length > 0 ? (
            <div className="cv2-chipcol">
              {children.map((c) => <REGISTRY_CTX.Chip key={c.id} entity={c} />)}
            </div>
          ) : <p className="cv2-empty-line">No chapters yet.</p>}
        </aside>
        <article className="cv2-full__prose">{content}</article>
        <aside className="cv2-full__rail">
          <SlotBox name="Margin threads" hint="Anchored doc discussions plug in here (W2).">
            {slots?.margin?.(detail)}
          </SlotBox>
        </aside>
      </div>
    ),
    hub: (
      <div className="cv2-full__grid cv2-full__grid--hub">
        <div>{content}</div>
        <SlotBox name="Channel hub" hint="The full hub — shelf, feed, and auto-tabs — composes here (W3).">
          {slots?.hub?.(detail)}
        </SlotBox>
      </div>
    ),
    subtree: (
      <div className="cv2-full__stack">
        {content}
        <ChildrenGrid items={children} title="Subtree" />
        <SlotBox name="Dependencies" hint="The dependency mini-graph plugs in here (W2/W4).">
          {slots?.dependencies?.(detail)}
        </SlotBox>
      </div>
    ),
    profile: (
      <div className="cv2-full__stack">
        <div className="cv2-full__profilehead">
          <Avatar actor={detail.createdBy} size={44} title={detail.title} />
          <div>
            <div className="t-h3">{detail.title}</div>
            {status && <Pill tone={status.tone} pulse={status.pulse}>{status.label}</Pill>}
          </div>
        </div>
        {content}
        <ChildrenGrid items={children} title="Children" />
      </div>
    ),
    generic: (
      <div className="cv2-full__stack">
        {content}
        <ChildrenGrid items={children} title="Children" />
      </div>
    ),
  };

  return (
    <div className="cv2-full" data-kind={detail.kind} data-layout={entry.fullLayout}>
      <header className="cv2-full__header">
        <div className="cv2-panel__crumbs">
          {detail.hierarchy.path.filter((p) => p.id !== detail.id).map((p) => (
            <span key={p.id} className="cv2-panel__crumb">
              <REGISTRY_CTX.Chip entity={p} variant="ref" draggable={false} />
              <span className="cv2-panel__crumbsep">›</span>
            </span>
          ))}
        </div>
        <div className="cv2-full__titlerow">
          <span className="cv2-chip__glyph cv2-full__glyph" style={{ color: entry.tint(detail) }} aria-hidden="true">
            {entry.glyph}
          </span>
          <h1 className="cv2-full__title">{detail.title}</h1>
          {status && <Pill tone={status.tone} pulse={status.pulse}>{status.label}</Pill>}
          <button
            type="button"
            className="cv2-actionbtn"
            title="Collapse back to a panel"
            onClick={collapse}
          >
            ⤡ Collapse
          </button>
        </div>
        <div className="cv2-panel__meta">
          created by {detail.createdBy.displayName} · v{detail.version} · active {relTime(detail.activityAt)}
        </div>
      </header>
      {bodies[entry.fullLayout]}
    </div>
  );
}
