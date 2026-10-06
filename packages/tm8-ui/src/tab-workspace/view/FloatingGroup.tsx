/**
 * Floating group (Spec A §8, design log §7): section switcher · registry verbs
 * · Chat · ⤢ · ⋯, anchored top-right of the entity content, outside its scroll.
 *
 * The verbs are the panel's own action bar (permissions, confirmations and
 * flows included), portalled into `verbsSlot` by the embedded panel; Rename
 * and the destructive verbs portal into the ⋯ menu the same way. Workstream E.
 */
import { useEffect, useRef, useState } from 'react';
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

export interface FloatingGroupProps {
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
  return subview === 'entity' ? noun : subview === 'connections' ? 'Connections' : 'Messages';
}

export function FloatingGroup({ tab }: FloatingGroupProps) {
  const { dispatch, gate, spaceId } = useWorkspace();
  const expanded = useWorkspaceState((s) => s.layout.expanded);
  const chrome = useEntityChrome();
  const adapter = getKindAdapter(tab.kind);
  const detail = gate.data.detailOf(tab.entityId);
  const kindConfig = getKind(tab.kind);
  const canvas = kindConfig.panel.composition === 'canvas';
  /* Native on the surface it sits on (Subhang, round 2): on the always-dark
     terminal body the group opens the same dark token scope the panel does,
     so it reads like the surface chips beside it. Registry data, no literal. */
  const darkBody = kindConfig.panel.archetype === 'terminal';
  const darkTheme = useAlwaysDarkTheme();
  /* The panel draws its attach drop zone only where the body does not own its
     bottom; in Workspace that zone is hidden and this paperclip replaces it. */
  const attachable = kindConfig.panel.archetype !== 'terminal' && kindConfig.panel.composition == null;
  const groupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle');

  /* Publish the measured footprint to the content container: the body reserves
     it (content.css), and canvas bodies keep their own floating chrome out of
     it through the same properties the panel's canvas bar used to publish. */
  useEffect(() => {
    const el = groupRef.current;
    const host = el?.parentElement;
    if (!el || !host || typeof ResizeObserver === 'undefined') return;
    const publish = () => {
      for (const [name, value] of [
        ['--tws-fg-w', el.offsetWidth],
        ['--tws-fg-h', el.offsetHeight],
        ['--pn-canvas-bar-w', el.offsetWidth],
        ['--pn-canvas-bar-h', el.offsetHeight],
      ] as const) {
        host.style.setProperty(name, `${value}px`);
      }
    };
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      menuRef.current?.querySelector<HTMLButtonElement>('.tws-fg-more')?.focus();
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
    <div
      ref={groupRef}
      className={`${darkBody ? 'cv2-root ' : ''}tws-floating tws-fg`}
      data-theme={darkBody ? darkTheme : undefined}
      data-surface={darkBody ? 'dark' : 'light'}
      data-testid="tws-floating"
      data-tab={tab.id}
    >
      {detail && !canvas ? (
        <div className="tws-fg-seg" role="radiogroup" aria-label="Section">
          {TAB_SUBVIEWS.map((subview) => {
            const label = sectionLabel(subview, adapter.noun);
            const selected = tab.ui.subview === subview;
            return (
              <button
                key={subview}
                type="button"
                role="radio"
                className="tws-fg-btn tws-fg-seg-btn"
                aria-checked={selected}
                aria-label={subview === 'messages' && messages > 0 ? `${label}, ${messages}` : label}
                title={label}
                data-testid={`tws-section-${subview}`}
                onClick={() => setSubview(subview)}
              >
                {subview === 'entity' ? (
                  <KindIcon kind={tab.kind} size={16} />
                ) : subview === 'connections' ? (
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                    <path
                      d="M6.5 9.5l3-3M7 4.5l1.2-1.2a2.6 2.6 0 0 1 3.7 3.7L10.7 8.2M9 11.5l-1.2 1.2a2.6 2.6 0 0 1-3.7-3.7L5.3 7.8"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
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
                  <span className="tws-fg-badge" aria-hidden="true">
                    {messages > 99 ? '99+' : messages}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="tws-fg-cluster">
        {/* The panel's action bar lands here (registry verbs, flows, save). */}
        <div ref={chrome?.setVerbsSlot} className="tws-fg-verbs" data-testid="tws-floating-verbs" />
        {getKind(tab.kind).mcpEquipment && detail && detail.deletedAt == null ? (
          <ConnectorsButton entityId={tab.entityId} />
        ) : null}
        {attachable && detail && detail.deletedAt == null ? <AttachButton entityId={tab.entityId} /> : null}
        {adapter.supportsChat ? (
          <button
            type="button"
            className="tws-fg-btn tws-fg-chat"
            aria-label="Chat"
            title="Chat"
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
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        ) : null}
      </div>

      <div className="tws-fg-cluster" ref={menuRef}>
        <button
          type="button"
          className="tws-fg-btn"
          aria-label={expanded ? 'Restore navigation' : 'Expand'}
          title={expanded ? 'Restore navigation' : 'Expand'}
          aria-pressed={expanded}
          data-testid="tws-expand"
          onClick={() => dispatch({ command: 'workspace.layout.set', args: { expanded: !expanded }, source: 'click' })}
        >
          {expanded ? (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5l-4-4M9.5 9.5l4 4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5l-4.5 4.5M2.5 13.5l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="tws-fg-btn tws-fg-more"
          aria-label="More actions"
          title="More actions"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid="tws-more"
          onClick={() => setMenuOpen?.(!menuOpen)}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="3.5" cy="8" r="1.25" fill="currentColor" />
            <circle cx="8" cy="8" r="1.25" fill="currentColor" />
            <circle cx="12.5" cy="8" r="1.25" fill="currentColor" />
          </svg>
        </button>
        {menuOpen ? (
          <div className="tws-fg-menu pn-overflow__menu" role="menu" data-testid="tws-more-menu">
            {/* Rename (from the panel's save flow) */}
            <div ref={chrome?.setMenuSlot} className="tws-fg-slot" />
            <button type="button" className="pn-overflow__item" role="menuitem" onClick={copyLink}>
              {copied === 'done' ? 'Copied' : copied === 'failed' ? 'Could not copy' : 'Copy link'}
            </button>
            {/* Secondary verbs from the panel (Transfer) */}
            <div ref={chrome?.setSecondarySlot} className="tws-fg-slot" />
            {/* A separator, then the destructive verbs (from the panel) */}
            <div ref={chrome?.setDangerSlot} className="tws-fg-slot tws-fg-danger" />
          </div>
        ) : null}
      </div>
    </div>
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
      ref.current?.querySelector<HTMLButtonElement>('.tws-fg-connectors')?.focus();
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
    <div className="tws-fg-pop-anchor" ref={ref}>
      <button
        type="button"
        className="tws-fg-btn tws-fg-connectors"
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
          <span className="tws-fg-badge" aria-hidden="true">
            {attached}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="tws-fg-popover pn-overflow__menu" role="dialog" aria-label="Connectors" data-testid="tws-connectors-popover">
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
        className="tws-fg-btn tws-fg-attach"
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
