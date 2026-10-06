/**
 * The entity action strip (Subhang, feedback round 4; design log R30): a thin,
 * full-height toolbar pinned to the right edge of an entity tab, activity-bar
 * style. Two sections:
 *  - top, the kind's own actions: the body's controls (session surfaces, a
 *    frame's controls, a reader's Edit / Download, forms waiting), its own
 *    registry verbs (Edit, Terminate…, Transfer), Connectors and Attach;
 *  - bottom, the actions every kind shares: Entity · Links · Messages, Run ·
 *    Chat, Expand · More.
 * The panel's verbs and controls are its own components, portalled into the
 * slots here, so permissions, confirmations and flows are unchanged. One
 * component for every kind. Workstream E.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { EntityId, SpaceId } from '@tm8/contract';
import { getKind, KindIcon } from '../../domain';
import { McpEquipment } from '../../mcp/McpEquipment';
import { useMcpCatalog } from '../../mcp/context';
import { countMessages } from '../../panels';
import { attachmentsFor } from '../../files/port';
import { useAlwaysDarkTheme } from '../../theme/useAlwaysDarkTheme';
import { build, emptyPanels, normalize } from '../../routes';
import { useEntityChrome } from '../adapters/entity';
import { getKindAdapter } from '../adapters/registry';
import { TAB_SUBVIEWS, type EntityTabRecord, type TabSubview } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import './content.css';

export interface ActionStripProps {
  tab: EntityTabRecord;
}

/** `#/s/{space}/tabs?tab=<id>` as an absolute URL (Spec A §12). */
export function tabLinkUrl(spaceId: string, entityId: string): string {
  const { hash } = build(
    normalize({ spaceId: spaceId as SpaceId, target: { view: 'tabs', tab: entityId as EntityId }, panels: emptyPanels() }),
  );
  return new URL(hash, window.location.href).toString();
}

function sectionLabel(subview: TabSubview, noun: string): string {
  return subview === 'entity' ? noun : subview === 'connections' ? 'Links' : 'Messages';
}

const FOCUSABLE = 'button:not([disabled]), [role="radio"], [role="tab"], a[href], select, input:not([type="hidden"]):not([hidden])';

/** ↑/↓ move between the strip's controls (role=toolbar, vertical). */
function onToolbarKey(e: ReactKeyboardEvent<HTMLDivElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
  const items = [...e.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.offsetParent !== null && !el.closest('[role="menu"], [role="dialog"]'),
  );
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at === -1 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
  e.preventDefault();
  const next =
    e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}

/* TOOLTIPS (R30): to the LEFT of the control, 8px off, in the rail's
   `.tws-tip` style, for every control in the strip — including the panel's
   portalled ones, whose native `title` is lifted while the tip shows. */
const TIP_DELAY_MS = 400;
const TIP_OFFSET_PX = 8;

interface Tip {
  text: string;
  detail?: string;
  right: number;
  top: number;
  zoom: number;
}

function useStripTips(stats: string) {
  const [tip, setTip] = useState<Tip | null>(null);
  const timer = useRef<number | null>(null);
  const lifted = useRef<{ el: HTMLElement; title: string } | null>(null);
  const restore = () => {
    if (lifted.current) lifted.current.el.setAttribute('title', lifted.current.title);
    lifted.current = null;
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    restore();
    setTip(null);
  };
  const show = (target: EventTarget | null, strip: HTMLElement) => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('[title], [aria-label], [data-tip]');
    if (!el || !strip.contains(el) || el === strip || el.closest('[role="menu"], [role="dialog"]')) return;
    /* A control whose popover is open needs no tooltip over it. */
    if (el.getAttribute('aria-expanded') === 'true') {
      hide();
      return;
    }
    const title = el.getAttribute('title');
    const text = el.getAttribute('data-tip') || title || el.getAttribute('aria-label') || el.textContent?.trim() || '';
    if (!text) return;
    restore();
    if (title) {
      lifted.current = { el, title };
      el.removeAttribute('title');
    }
    const open = () => {
      /* `position: fixed` inside the app's `zoom` scope takes UNZOOMED px while
         a rect reports zoomed ones; divide by the measured scale, or the tip
         drifts further from its button the lower it sits (R32.2). */
      const rect = el.getBoundingClientRect();
      const zoom = strip.offsetWidth > 0 ? strip.getBoundingClientRect().width / strip.offsetWidth : 1;
      setTip({
        text,
        ...(el.hasAttribute('data-tip-stats') && stats ? { detail: stats } : {}),
        right: (window.innerWidth - rect.left) / zoom + TIP_OFFSET_PX,
        top: (rect.top + rect.height / 2) / zoom,
        zoom,
      });
    };
    if (timer.current) window.clearTimeout(timer.current);
    if (tip) open();
    else timer.current = window.setTimeout(open, TIP_DELAY_MS);
  };
  useEffect(() => () => restore(), []);
  /* Centred on its button, clamped 8px inside the viewport. */
  const tipRef = useRef<HTMLSpanElement>(null);
  const [clampedTop, setClampedTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = tipRef.current;
    if (!tip || !el) {
      setClampedTop(null);
      return;
    }
    const half = el.offsetHeight / 2;
    const viewport = window.innerHeight / tip.zoom;
    setClampedTop(Math.min(Math.max(tip.top, TIP_OFFSET_PX + half), viewport - TIP_OFFSET_PX - half));
  }, [tip]);
  const node = tip ? (
    <span
      ref={tipRef}
      className="tws-tip tws-astrip-tip"
      role="tooltip"
      style={{ right: tip.right, top: clampedTop ?? tip.top }}
    >
      <span>{tip.text}</span>
      {tip.detail ? <span className="tws-astrip-tip-stats">{tip.detail}</span> : null}
    </span>
  ) : null;
  return { show, hide, node };
}

export function ActionStrip({ tab }: ActionStripProps) {
  const { dispatch, gate, spaceId } = useWorkspace();
  const expanded = useWorkspaceState((s) => s.layout.expanded);
  const chrome = useEntityChrome();
  const adapter = getKindAdapter(tab.kind);
  const detail = gate.data.detailOf(tab.entityId);
  const kindConfig = getKind(tab.kind);
  const canvas = kindConfig.panel.composition === 'canvas';
  /* On the always-dark terminal body the strip opens the same dark token scope
     the panel does, so it reads as part of the surface (R30). */
  const darkBody = kindConfig.panel.archetype === 'terminal';
  const darkTheme = useAlwaysDarkTheme();
  const attachable = kindConfig.panel.archetype !== 'terminal' && kindConfig.panel.composition == null;
  const stripRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  /* The session's live reading arrives as the panel's own component in the
     hidden stats slot; the strip reads it as one line of text. */
  const [stats, setStats] = useState('');
  const statsEl = chrome?.statsSlot ?? null;
  useEffect(() => {
    if (!statsEl) return;
    const read = () => setStats((statsEl.textContent ?? '').replace(/\s+/g, ' ').trim());
    read();
    const mo = new MutationObserver(read);
    mo.observe(statsEl, { subtree: true, childList: true, characterData: true });
    return () => mo.disconnect();
  }, [statsEl]);
  const tips = useStripTips(stats);

  const outlineRef = useRef<HTMLDivElement>(null);
  const [outlineOpen, setOutlineOpen] = useState(false);
  useEffect(() => {
    if (!outlineOpen) return;
    const onDown = (e: MouseEvent) => {
      if (outlineRef.current && !outlineRef.current.contains(e.target as Node)) setOutlineOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setOutlineOpen(false);
      outlineRef.current?.querySelector<HTMLButtonElement>('[data-testid="tws-outline"]')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [outlineOpen]);

  /* The ⋯ menu dismisses on outside press and Escape, returning focus to its trigger. */
  const menuOpen = chrome?.menuOpen ?? false;
  const setMenuOpen = chrome?.setMenuOpen;
  useEffect(() => {
    if (!menuOpen || !setMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setMenuOpen(false);
      menuRef.current?.querySelector<HTMLButtonElement>('.tws-astrip-more')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, setMenuOpen]);

  const setSubview = (subview: TabSubview) =>
    dispatch({ command: 'workspace.tabs.setUi', args: { tabId: tab.id, patch: { subview } }, source: 'click' });
  const chatOpen = tab.ui.chat?.open ?? false;
  const messages = detail ? countMessages(detail, gate.data.messagesOf(tab.entityId)) : 0;

  const copyLink = () => {
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    const say = (next: 'done' | 'failed') => {
      setCopied(next);
      setTimeout(() => setCopied('idle'), 2000);
    };
    if (!clip?.writeText) return say('failed');
    clip.writeText(tabLinkUrl(spaceId, tab.entityId)).then(
      () => say('done'),
      () => say('failed'),
    );
  };

  return (
    <>
    <div
      ref={stripRef}
      className={`${darkBody ? 'cv2-root ' : ''}tws-astrip`}
      data-theme={darkBody ? darkTheme : undefined}
      data-surface={darkBody ? 'dark' : 'light'}
      role="toolbar"
      aria-orientation="vertical"
      aria-label={`${adapter.noun} actions`}
      data-testid="tws-action-strip"
      data-tab={tab.id}
      onKeyDown={onToolbarKey}
      onPointerOver={(e) => stripRef.current && tips.show(e.target, stripRef.current)}
      onPointerLeave={tips.hide}
      onFocus={(e) => stripRef.current && tips.show(e.target, stripRef.current)}
      onBlur={tips.hide}
      onPointerDown={tips.hide}
    >
      {/* TOP — the kind's own actions. */}
      <div className="tws-astrip-section tws-astrip-section--kind">
        <div ref={chrome?.setKindSlot} className="tws-astrip-cluster tws-astrip-kind" data-testid="tws-astrip-kind" />
        {/* A reader's outline (R32.1): shown only when the body put one in the
            slot; it opens to the left as a popover. */}
        <div className="tws-astrip-cluster tws-astrip-outline" ref={outlineRef} data-open={outlineOpen || undefined}>
          <button
            type="button"
            className="tws-astrip-btn"
            aria-label="Outline"
            aria-haspopup="dialog"
            aria-expanded={outlineOpen}
            data-testid="tws-outline"
            onClick={() => setOutlineOpen((was) => !was)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.5 4h8M5.5 8h8M5.5 12h8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="2.75" cy="4" r="0.9" fill="currentColor" />
              <circle cx="2.75" cy="8" r="0.9" fill="currentColor" />
              <circle cx="2.75" cy="12" r="0.9" fill="currentColor" />
            </svg>
          </button>
          <div
            ref={chrome?.setOutlineSlot}
            className="tws-astrip-outline-pop"
            role="dialog"
            aria-label="Outline"
            data-testid="tws-outline-popover"
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('a, button')) setOutlineOpen(false);
            }}
          />
        </div>
        <div ref={chrome?.setVerbsSlot} className="tws-astrip-cluster tws-astrip-verbs" data-testid="tws-astrip-verbs" />
        {kindConfig.mcpEquipment && detail && detail.deletedAt == null ? (
          <div className="tws-astrip-cluster">
            <ConnectorsButton entityId={tab.entityId} />
          </div>
        ) : null}
        {attachable && detail && detail.deletedAt == null ? (
          <div className="tws-astrip-cluster">
            <AttachButton entityId={tab.entityId} />
          </div>
        ) : null}
      </div>

      {/* BOTTOM — the actions every kind shares. */}
      <div className="tws-astrip-section tws-astrip-section--common">
        {detail && !canvas ? (
          <div className="tws-astrip-cluster" role="radiogroup" aria-label="Section">
            {TAB_SUBVIEWS.map((subview) => {
              const label = sectionLabel(subview, adapter.noun);
              const selected = tab.ui.subview === subview;
              return (
                <button
                  key={subview}
                  type="button"
                  role="radio"
                  className="tws-astrip-btn tws-astrip-seg"
                  aria-checked={selected}
                  aria-label={subview === 'messages' && messages > 0 ? `${label}, ${messages}` : label}
                  data-tip={label}
                  {...(subview === 'entity' ? { 'data-tip-stats': '' } : {})}
                  data-testid={`tws-section-${subview}`}
                  onClick={() => setSubview(subview)}
                >
                  {subview === 'entity' ? (
                    <KindIcon kind={tab.kind} size={14} />
                  ) : subview === 'connections' ? (
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                      <path
                        d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z M5 6h6M5 8h4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  )}
                  {subview === 'messages' && messages > 0 ? (
                    <span className="tws-astrip-badge" aria-hidden="true">
                      {messages > 99 ? '99+' : messages}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        ) : null}

        <div className="tws-astrip-cluster">
          {/* Run, from the panel's own bar (flows and refusals unchanged). */}
          <div ref={chrome?.setCommonVerbsSlot} className="tws-astrip-verbs tws-astrip-common" data-testid="tws-astrip-common" />
          {adapter.supportsChat ? (
            <button
              type="button"
              className="tws-astrip-btn tws-astrip-chat"
              aria-label="Chat"
              aria-pressed={chatOpen}
              data-testid="tws-chat-toggle"
              onClick={() =>
                dispatch({
                  command: 'workspace.tabs.setUi',
                  args: { tabId: tab.id, patch: { chat: { open: !chatOpen } } },
                  source: 'click',
                })
              }
            >
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              </svg>
            </button>
          ) : null}
        </div>

        <div className="tws-astrip-cluster" ref={menuRef}>
          <button
            type="button"
            className="tws-astrip-btn"
            aria-label={expanded ? 'Restore navigation' : 'Expand'}
            aria-pressed={expanded}
            data-testid="tws-expand"
            onClick={() => dispatch({ command: 'workspace.layout.set', args: { expanded: !expanded }, source: 'click' })}
          >
            {expanded ? (
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5l-4-4M9.5 9.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="tws-astrip-btn tws-astrip-more"
            aria-label="More actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            data-testid="tws-more"
            onClick={() => setMenuOpen?.(!menuOpen)}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
              <circle cx="8" cy="8" r="1.25" fill="currentColor" />
              <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
            </svg>
          </button>
          {menuOpen ? (
            <div className="tws-astrip-menu pn-overflow__menu" role="menu" data-testid="tws-more-menu">
              {stats ? (
                <div className="tws-astrip-menu-stats" role="none" data-testid="tws-menu-stats">
                  {stats}
                </div>
              ) : null}
              {/* Rename (from the panel's save flow) */}
              <div ref={chrome?.setMenuSlot} className="tws-astrip-slot" />
              <button type="button" className="pn-overflow__item" role="menuitem" onClick={copyLink}>
                {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy link'}
              </button>
              {/* A separator, then the destructive verbs (from the panel) */}
              <div ref={chrome?.setDangerSlot} className="tws-astrip-slot tws-astrip-danger" />
            </div>
          ) : null}
        </div>
      </div>
      {tips.node}
    </div>
    {/* The session's live reading, read as text for the Session tooltip and ⋯
        (R32.4): outside the toolbar, hidden and inert, so nothing invisible
        is focusable or announced. */}
    <div ref={chrome?.setStatsSlot} className="tws-astrip-stats-source" hidden inert aria-hidden="true" />
    </>
  );
}

/**
 * Connectors (Subhang's ruling, round 3): the task kind's McpEquipment block,
 * folded into one plug button with an anchored popover in Workspace. Shown only
 * where the panel would have drawn the block — the kind's `mcpEquipment` flag
 * and the catalog's `canAttach`. The badge counts attached connectors.
 */
function ConnectorsButton({ entityId }: { entityId: string }) {
  const { catalog } = useMcpCatalog(entityId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>('.tws-astrip-connectors')?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  if (!catalog?.canAttach) return null;
  const attached = catalog.attachedServerIds?.length ?? 0;
  return (
    <div className="tws-astrip-pop-anchor" ref={ref}>
      <button
        type="button"
        className="tws-astrip-btn tws-astrip-connectors"
        aria-label={attached > 0 ? `Connectors, ${attached} attached` : 'Connectors'}
        title="Connectors"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="tws-connectors"
        onClick={() => setOpen((was) => !was)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M6 1.5v3M10 1.5v3M4 4.5h8v3a4 4 0 0 1-8 0zM8 11.5v3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {attached > 0 ? (
          <span className="tws-astrip-badge" aria-hidden="true">
            {attached}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="tws-astrip-popover pn-overflow__menu" role="dialog" aria-label="Connectors" data-testid="tws-connectors-popover">
          <McpEquipment targetId={entityId} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Attach (Subhang, round 2): the body's "Attach / or drop / paste" zone is
 * hidden in Workspace; this paperclip opens the file picker and uploads through
 * the same attachments port the panel uses. Drop onto the content still works
 * (the strip's listeners ride the panel, its drop host).
 */
function AttachButton({ entityId }: { entityId: string }) {
  const { gate } = useWorkspace();
  const data = gate.data;
  const port = attachmentsFor(data.seam, data.spaceId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(0);
  if (!port) return null;
  const upload = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      setBusy((n) => n + 1);
      port
        .startUpload(file, entityId as EntityId)
        .result.then(
          () => data.refetchDetail(entityId),
          (error: unknown) =>
            gate.onNotice({
              id: `tws-attach-${entityId}`,
              tone: 'error',
              title: `Couldn't attach ${file.name}`,
              body: String((error as { message?: string })?.message ?? error),
              ttlMs: 6_000,
            }),
        )
        .finally(() => setBusy((n) => n - 1));
    }
  };
  return (
    <>
      <button
        type="button"
        className="tws-astrip-btn tws-astrip-attach"
        aria-label={busy > 0 ? 'Attach a file (uploading)' : 'Attach a file'}
        title="Attach a file — or drop it on the content"
        aria-busy={busy > 0 || undefined}
        data-testid="tws-attach"
        onClick={() => inputRef.current?.click()}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M10.5 4.5l-5 5a1.4 1.4 0 0 0 2 2l5.5-5.5a2.8 2.8 0 0 0-4-4L3.5 7.5a4.2 4.2 0 0 0 6 6l4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          upload(e.target.files);
          e.target.value = '';
        }}
      />
    </>
  );
}
