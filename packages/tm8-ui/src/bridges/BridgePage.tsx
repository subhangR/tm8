/**
 * THE BRIDGE PANEL (BRIDGE-ENTITY-DESIGN §4.4, BRIDGES-V2-DESIGN §1.3): the
 * `bridge-page` registry block. One `bridges.get` read feeds a header and six
 * tabs — Conversation · People · Routing · Memory · Loops · Health — so the
 * header's status pill and the Routing tab can never disagree about the same
 * bridge. The panel's own Connections tab sits beside them as for every kind.
 *
 * The header's status pill IS the Pause / Resume control, and its `⋯` holds
 * Move, Send a test message, Copy bridge id and Remove. Every write goes
 * through `BridgesPort`; a refusal is drawn as a refusal where it happened.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { bridgeProviderLabel, BridgeProviderMark } from './bridge-marks';
import type { BridgeDetailView, BridgeView, EntityDetail } from '@tm8/contract';
import { Pill } from '../kit';
import type { BridgesPort } from './api';
import { STATUS_TONE, TARGET_GLYPH, bridgeFailureOf, statusLine } from './format';
import { useDismissable } from '../panels/useDismissable';
import { RemoveBridgeDialog } from './RemoveBridgeDialog';
import { pendingReason } from './reasons';
import { ConversationTab } from './tabs/ConversationTab';
import { HealthTab } from './tabs/HealthTab';
import { LoopsTab } from './tabs/LoopsTab';
import { MemoryTab } from './tabs/MemoryTab';
import { PeopleTab } from './tabs/PeopleTab';
import { RoutingTab } from './tabs/RoutingTab';
import './bridge-panel.css';

export const BRIDGE_TABS = ['conversation', 'people', 'routing', 'memory', 'loops', 'health'] as const;
export type BridgeTab = typeof BRIDGE_TABS[number];
const TAB_LABEL: Record<BridgeTab, string> = {
  conversation: 'Conversation', people: 'People', routing: 'Routing', memory: 'Memory', loops: 'Loops', health: 'Health',
};

/** The `bridges.get` read, re-read when the entity version moves (an event, or another surface's write). */
export function useBridgeView(port: BridgesPort | null | undefined, bridgeId: string, version: number) {
  const [view, setView] = useState<BridgeDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    if (!port) return;
    try {
      setView(await port.get(bridgeId));
      setError(null);
    } catch (err) {
      setError(bridgeFailureOf(err));
    }
  }, [port, bridgeId]);
  useEffect(() => { void reload(); }, [reload, version]);
  /* A write answers the BridgeView; keep the posters this page already read. */
  const accept = useCallback((next: BridgeView) => {
    setView((prev) => ({ ...next, recentPosters: prev?.recentPosters ?? [] }));
  }, []);
  return { view, error, reload, accept };
}

export function BridgePageBlock({
  detail,
  port,
  onOpenEntity,
}: {
  detail: EntityDetail;
  port: BridgesPort | null | undefined;
  onOpenEntity?: (id: string) => void;
}) {
  const { view, error, reload, accept } = useBridgeView(port, detail.id, detail.version);
  const [tab, setTab] = useState<BridgeTab>('conversation');
  if (!port) {
    return <p className="brg-hint" role="status">Bridge controls are not wired on this surface (no bridges client).</p>;
  }
  if (!view) {
    return error ? (
      <div role="alert" className="brg-error">
        <p>{error}</p>
        <button type="button" className="pn-btn" onClick={() => void reload()}>Retry</button>
      </div>
    ) : <p className="brg-hint" role="status">Loading bridge…</p>;
  }
  return (
    <div className="brg-page" data-testid="bridge-page">
      <BridgeHeader view={view} port={port} onView={accept} onMove={() => setTab('routing')} onOpenEntity={onOpenEntity} />
      <div className="brg-tabs" role="tablist" aria-label="Bridge">
        {BRIDGE_TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            id={`brg-tab-${t}`}
            aria-selected={tab === t}
            aria-controls={`brg-panel-${t}`}
            className="brg-tabs__tab"
            onClick={() => setTab(t)}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      <div className="brg-tabpanel" role="tabpanel" id={`brg-panel-${tab}`} aria-labelledby={`brg-tab-${tab}`}>
        {tab === 'conversation' ? <ConversationTab view={view} port={port} /> : null}
        {tab === 'people' ? <PeopleTab view={view} /> : null}
        {tab === 'routing' ? <RoutingTab view={view} port={port} onView={accept} onOpenEntity={onOpenEntity} /> : null}
        {tab === 'memory' ? <MemoryTab view={view} port={port} onOpenEntity={onOpenEntity} /> : null}
        {tab === 'loops' ? <LoopsTab view={view} /> : null}
        {tab === 'health' ? <HealthTab view={view} port={port} /> : null}
      </div>
    </div>
  );
}

function BridgeHeader({
  view,
  port,
  onView,
  onMove,
  onOpenEntity,
}: {
  view: BridgeDetailView;
  port: BridgesPort;
  onView(next: BridgeView): void;
  onMove(): void;
  onOpenEntity?: (id: string) => void;
}) {
  const [open, setOpen] = useState<'status' | 'more' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const menus = useRef<HTMLDivElement>(null);
  /* The shared dismiss rule (panels/useDismissable): pointerdown outside —
     iOS fires no mousedown on an inert tap — and Escape, consumed, so the
     panel's own Escape (close the entity) never sees it. */
  const closeMenu = useCallback(() => setOpen(null), []);
  useDismissable(open !== null, menus, closeMenu);

  const ended = view.status === 'ended';
  const provider = bridgeProviderLabel(view.provider);
  const lifecycle = async (verb: 'pause' | 'resume') => {
    setOpen(null);
    setBusy(true);
    setError(null);
    try {
      onView(await port[verb](view.id, view.version));
      setNote(verb === 'pause'
        ? 'Paused. Messages are still logged; nobody is answered, nothing is sent. Loops and workers wait.'
        : 'Live again. Messages that arrived while paused are logged, not answered.');
    } catch (err) {
      setError(bridgeFailureOf(err));
    } finally {
      setBusy(false);
    }
  };
  const testReason = pendingReason(port, 'bridges.test', 'Send a test message');
  const pauseForReason = 'Pause for a set time arrives when bridges.pause takes an end time (`until`).';

  return (
    <header className="brg-head" data-testid="bridge-header">
      <div className="brg-head__line" ref={menus}>
        <span className="brg-head__title">
          <BridgeProviderMark provider={view.provider} />
          <strong>{view.title}</strong>
          <span className="brg-muted"> · {provider}</span>
        </span>
        <span className="brg-head__status">
          <button
            type="button"
            className="brg-pillbtn"
            aria-haspopup="menu"
            aria-expanded={open === 'status'}
            aria-label={`Status: ${statusLine(view)}. Pause or resume`}
            disabled={busy || ended}
            onClick={() => setOpen(open === 'status' ? null : 'status')}
          >
            <Pill tone={STATUS_TONE[view.status]} dot="solid">{statusLine(view)} ▾</Pill>
          </button>
          {open === 'status' ? (
            <div className="brg-menu brg-menu--wide" role="menu" aria-label="Pause or resume">
              {view.status === 'paused' ? (
                <button type="button" role="menuitem" onClick={() => void lifecycle('resume')}>
                  ▶ Resume bridge
                  <span className="brg-menu__help">Messages that arrived while paused are logged, not answered.</span>
                </button>
              ) : (
                <>
                  <button type="button" role="menuitem" onClick={() => void lifecycle('pause')}>
                    ⏸ Pause bridge
                    <span className="brg-menu__help">
                      Messages are still logged; nobody is answered, nothing is sent. Loops and workers wait.
                    </span>
                  </button>
                  <button type="button" role="menuitem" disabled title={pauseForReason}>⏸ Pause for…</button>
                </>
              )}
            </div>
          ) : null}
        </span>
        <span className="brg-muted brg-head__facts">
          {view.conversation.memberCount != null ? `${view.conversation.memberCount} in ${view.conversation.kind === 'dm' ? 'conversation' : view.conversation.kind} · ` : ''}
          bridged to{' '}
          {onOpenEntity ? (
            <button type="button" className="brg-link" onClick={() => onOpenEntity(view.target.id)}>
              {TARGET_GLYPH[view.target.kind]} {view.target.title}
            </button>
          ) : <span>{TARGET_GLYPH[view.target.kind]} {view.target.title}</span>}
        </span>
        <span className="brg-head__more">
          <button
            type="button"
            className="set-ghost"
            aria-haspopup="menu"
            aria-expanded={open === 'more'}
            aria-label={`More for ${view.title}`}
            onClick={() => setOpen(open === 'more' ? null : 'more')}
          >
            ⋯
          </button>
          {open === 'more' ? (
            <div className="brg-menu brg-menu--end" role="menu" aria-label={`${view.title} actions`}>
              <button type="button" role="menuitem" disabled={ended} onClick={() => { setOpen(null); onMove(); }}>Move to another target…</button>
              <button type="button" role="menuitem" disabled title={testReason}>Send a test message</button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(null);
                  void navigator.clipboard?.writeText(view.id).then(() => setNote('Bridge id copied.'), () => setNote(view.id));
                }}
              >
                Copy bridge id
              </button>
              <hr className="brg-menu__rule" />
              <button type="button" role="menuitem" className="brg-menu__danger" disabled={ended} onClick={() => { setOpen(null); setRemoving(true); }}>
                Remove bridge…
              </button>
            </div>
          ) : null}
        </span>
      </div>
      {view.purpose ? <p className="brg-head__purpose">{view.purpose}</p> : null}
      {error ? <p className="brg-error" role="alert">{error}</p> : null}
      {note ? <p className="brg-hint" role="status">{note}</p> : null}
      {removing ? (
        <RemoveBridgeDialog
          bridge={view}
          port={port}
          onClose={() => setRemoving(false)}
          onRemoved={(next) => { setRemoving(false); onView(next); setNote(`Removed. The ${provider} conversation is not touched.`); }}
        />
      ) : null}
    </header>
  );
}
