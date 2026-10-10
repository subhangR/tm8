/**
 * THE CRAFT DETAIL PANEL — the overview tab's body (Craft redesign §3, L4.2).
 * Every page of the craft, LIVE, stacked one after another on one scrolling
 * page, in `contains` order:
 *
 *   ┌ ◇ Launch flow · Graph ……………… [view ▾] [Open] ┐
 *   │ the blueprint canvas                           │
 *   └────────────────────────────────────────────────┘
 *   ┌ ▤ Spec · Doc …………………………………………………… [Open] ┐
 *   │ the doc's real body                            │
 *   └────────────────────────────────────────────────┘
 *   ┌ ◈ Sub craft · Craft ……………………………………… [Open] ┐
 *   │ its pages, as chips (no nested rows)           │
 *   └────────────────────────────────────────────────┘
 *
 *  · A graph page is the live blueprint canvas (`GraphPage`); its view
 *    switcher sits in the section's own header, not the strip.
 *  · A doc, artifact or drawing is the Workspace entity body, the same one
 *    Home draws, in the screen's private runtime. Its chrome is cut off here
 *    (no provider value), so a stacked body never portals verbs into the
 *    strip: the strip belongs to the craft while the overview is selected.
 *  · A page that is itself a craft is a compact live section: its title and
 *    its pages as chips. Open (or a chip) takes it to its own tab.
 *
 * Live by the same events as the rest of the screen: the page list is the
 * caller's `useDesign` read, a graph re-reads on its patch event, an entity
 * body is the Workspace runtime's, and a nested craft runs its own read.
 */
import { useLayoutEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { DESIGN_KIND, getKind, KindIcon } from '../domain';
import type { WorkspaceGateHandles } from '../tab-workspace';
import {
  EntityChromeContext,
  EntityTabBody,
  embeddedTab,
  getKindAdapter,
  type EntityTabRecord,
  type WorkspaceRuntime,
} from '../tab-workspace/embed';
import { GraphPage } from './GraphPage';
import { useCraft } from './useCraft';
import type { CraftPageRow, CraftSource } from './craft-source';
import './craft-detail-panel.css';

export interface CraftDetailPanelProps {
  seam: Seam;
  source: CraftSource;
  /** The craft's pages, in `contains` order (the screen's live read). */
  pages: readonly CraftPageRow[];
  /** Present ⇒ doc/artifact/drawing pages render their real Workspace body. */
  gate?: WorkspaceGateHandles | undefined;
  runtime: WorkspaceRuntime;
  /** Open one page on its own (its tab). */
  onOpenPage(id: EntityId): void;
  onAsk(text: string): void;
  onOpenEntity(id: EntityId): void;
  onNotice?: ((text: string) => void) | undefined;
}

const noop = () => undefined;

/** A page that is itself a craft (the kind is still named `design` until lane L1 lands). */
export function isCraftPage(page: Pick<CraftPageRow, 'kind'>): boolean {
  return page.kind === DESIGN_KIND || page.kind === 'craft';
}

export function CraftDetailPanel(props: CraftDetailPanelProps) {
  const { pages } = props;
  return (
    <div className="cdp" data-testid="craft-detail-panel" aria-label="All pages">
      {pages.map((page) => (
        <PageSection key={page.id} {...props} page={page} />
      ))}
    </div>
  );
}

function PageSection(props: CraftDetailPanelProps & { page: CraftPageRow }) {
  const { page, onOpenPage } = props;
  /* The section's own controls slot: a graph's view switcher lands here. */
  const [controlsSlot, setControlsSlot] = useState<HTMLDivElement | null>(null);
  const craft = isCraftPage(page);
  return (
    <section
      className="cdp-page"
      data-testid="craft-detail-page"
      data-page-id={page.id}
      data-kind={page.kind}
      data-compact={craft ? 'true' : undefined}
      aria-label={page.title}
    >
      <header className="cdp-page__head">
        <KindIcon kind={page.kind} size={16} />
        <button type="button" className="cdp-page__title" title={`Open ${page.title}`} onClick={() => onOpenPage(page.id)}>
          {page.title}
        </button>
        <span className="cdp-page__kind">{craft ? 'Craft' : getKind(page.kind).label}</span>
        {page.running ? <span className="cdp-page__live" title="A session is working on this page">live</span> : null}
        <span className="cdp-page__fill" />
        <div className="cdp-page__controls" ref={setControlsSlot} />
        <button type="button" className="dsn-btn cdp-page__open" data-testid="craft-detail-open" onClick={() => onOpenPage(page.id)}>
          Open
        </button>
      </header>
      <div className="cdp-page__body">
        {/* No chrome: a stacked body's verbs never reach the craft's strip. */}
        <EntityChromeContext.Provider value={null}>
          <SectionBody {...props} controlsSlot={controlsSlot} />
        </EntityChromeContext.Provider>
      </div>
    </section>
  );
}

function SectionBody(props: CraftDetailPanelProps & { page: CraftPageRow; controlsSlot: HTMLElement | null }) {
  const { page, seam, gate, runtime } = props;
  if (page.kind === 'graph') {
    return (
      <GraphPage
        seam={seam}
        graphId={page.id}
        controlsSlot={props.controlsSlot}
        onAsk={props.onAsk}
        onOpenEntity={props.onOpenEntity}
      />
    );
  }
  if (isCraftPage(page)) return <CraftSection {...props} />;
  if (!gate) {
    return (
      <p className="cdp-plain" data-testid="craft-detail-plain">
        {getKind(page.kind).label} · open it to see its body.
      </p>
    );
  }
  return <EntitySection page={page} runtime={runtime} onOpenEntity={props.onOpenEntity} />;
}

/** The private runtime's record for one entity, seeded after render. */
function useEmbeddedTab(runtime: WorkspaceRuntime, entityId: string, kind: string): EntityTabRecord | null {
  const record = useStore(runtime.store, (s) => s.tabs[entityId]);
  useLayoutEffect(() => {
    embeddedTab(runtime, entityId, kind);
  }, [runtime, entityId, kind]);
  return record?.type === 'entity' && record.kind === kind ? record : null;
}

/** A doc, artifact or drawing: the Workspace entity body, as Home draws it. */
function EntitySection({ page, runtime, onOpenEntity }: { page: CraftPageRow; runtime: WorkspaceRuntime; onOpenEntity(id: EntityId): void }) {
  const tab = useEmbeddedTab(runtime, page.id, page.kind);
  if (!tab) return null;
  return (
    <div className="cdp-entity tws-entity-main tws-entity-host">
      <EntityTabBody tab={tab} adapter={getKindAdapter(page.kind)} onOpenEntity={(id) => onOpenEntity(id as EntityId)} onClose={noop} />
    </div>
  );
}

/** A craft page, compact and live: its pages as chips. No nested rows. */
function CraftSection({ page, source, onOpenPage, onNotice }: CraftDetailPanelProps & { page: CraftPageRow }) {
  const handle = useCraft(source, page.id, null, onNotice);
  if (handle.state === 'loading') return <p className="crf-empty" role="status">Loading the craft…</p>;
  if (handle.state !== 'ready') return <p className="crf-empty">This craft could not be read.</p>;
  if (handle.pages.length === 0) return <p className="crf-empty" data-testid="craft-detail-nested-empty">No pages yet.</p>;
  return (
    <ul className="cdp-chips" data-testid="craft-detail-nested" aria-label={`Pages of ${handle.craft?.title ?? page.title}`}>
      {handle.pages.map((inner) => (
        <li key={inner.id}>
          <button type="button" className="cdp-chip" data-testid="craft-detail-chip" onClick={() => onOpenPage(page.id)}>
            <KindIcon kind={inner.kind} size={14} />
            <span className="cdp-chip__title">{inner.title}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
