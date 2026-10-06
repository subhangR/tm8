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
import { getKind } from '../../domain';
import { countMessages } from '../../panels';
import { build, emptyPanels, normalize } from '../../routes';
import { useEntityChrome } from '../adapters/entity';
import { getKindAdapter } from '../adapters/registry';
import { TAB_SUBVIEWS, type EntityTabRecord, type TabSubview } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import './content.css';

export interface FloatingGroupProps {
  tab: EntityTabRecord;
}

/** Below this content width the switcher collapses to one quiet dropdown (design log §7). */
const NARROW_SWITCHER_PX = 520;

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
  const canvas = getKind(tab.kind).panel.composition === 'canvas';
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
  const narrow = (chrome?.contentWidth ?? Infinity) < NARROW_SWITCHER_PX;

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
    <div ref={groupRef} className="tws-floating tws-fg" data-testid="tws-floating" data-tab={tab.id}>
      {detail && !canvas ? (
        narrow ? (
          <select
            className="tws-fg-select"
            aria-label="Section"
            value={tab.ui.subview}
            onChange={(e) => setSubview(e.target.value as TabSubview)}
          >
            {TAB_SUBVIEWS.map((subview) => (
              <option key={subview} value={subview}>
                {sectionLabel(subview, adapter.noun)}
                {subview === 'messages' && messages > 0 ? ` ${messages}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <div className="tws-fg-seg" role="group" aria-label="Section">
            {TAB_SUBVIEWS.map((subview) => (
              <button
                key={subview}
                type="button"
                className="tws-fg-seg-btn"
                aria-pressed={tab.ui.subview === subview}
                data-testid={`tws-section-${subview}`}
                onClick={() => setSubview(subview)}
              >
                {sectionLabel(subview, adapter.noun)}
                {subview === 'messages' && messages > 0 ? (
                  <span className="tws-fg-count" aria-label={`${messages} messages`}>
                    {messages}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )
      ) : null}

      <div className="tws-fg-cluster">
        {/* The panel's action bar lands here (registry verbs, flows, save). */}
        <div ref={chrome?.setVerbsSlot} className="tws-fg-verbs" data-testid="tws-floating-verbs" />
        {adapter.supportsChat ? (
          <button
            type="button"
            className="tws-icon-btn tws-fg-chat"
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
          className="tws-icon-btn"
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
          className="tws-icon-btn tws-fg-more"
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
