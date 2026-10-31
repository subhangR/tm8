/**
 * Settings → Bridges (BRIDGE-ENTITY-DESIGN §4.2, BRIDGES-V2-DESIGN §1.6). The
 * management home of the `bridge` kind: the accounts bridges ride on, and
 * every bridge in the space with its target, people and status.
 *
 * Built on `SectionFrame` (settings-space/SECTION-CONTRACT.md): one scroller,
 * no inline padding, and every enabled control is registered in `LIVE_VERBS`
 * with the operation that makes it live. A control whose operation the node
 * does not serve yet (the add-bridge wizard's `bridges.connections.*`, the
 * test round trip `bridges.test`) is drawn disabled WITH its reason, never
 * hidden and never live.
 *
 * Status is colour and word. A row opens the bridge's panel; its `⋯` holds the
 * lifecycle (pause, resume, remove), the same operations as the panel header.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bridgeProviderLabel, BridgeProviderMark } from './bridge-marks';
import type { BridgeView } from '@tm8/contract';
import { Pill } from '../kit';
import { shortDate } from '../kit/time';
import { SectionAbsent, SectionFrame } from '../settings-space';
import type { BridgesPort } from './api';
import {
  CONNECTION_TONE, CONNECTION_WORD, STATUS_TONE, TARGET_GLYPH, bridgeFailureOf,
  conversationLine, peopleLine, statusLine,
} from './format';
import { useDismissable } from '../panels/useDismissable';
import { RemoveBridgeDialog } from './RemoveBridgeDialog';
import { AccountsBlock } from './AccountsBlock';
import { AddBridgeWizard } from './AddBridgeWizard';
import { pendingReason, unservedReason } from './reasons';
import './bridge-panel.css';

export interface BridgesSectionProps {
  port: BridgesPort;
  spaceId: string;
  heading?: string;
  /** Opens a bridge's own panel. Absent, rows do not offer it. */
  onOpen?: (bridgeId: string) => void;
}

export { connectionRowsOf } from './AccountsBlock';

export function BridgesSection({ port, spaceId, heading = 'Bridges', onOpen }: BridgesSectionProps) {
  const [bridges, setBridges] = useState<BridgeView[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; text: string } | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [removing, setRemoving] = useState<BridgeView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setBridges(await port.list(spaceId));
      setLoadError(null);
    } catch (err) {
      setLoadError(bridgeFailureOf(err));
    }
  }, [port, spaceId]);

  useEffect(() => { void reload(); }, [reload]);
  /* The row menu closes on Escape or a tap outside it — the shared rule
     (panels/useDismissable: pointerdown, Escape consumed). */
  const menuCell = useRef<HTMLTableCellElement>(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);
  useDismissable(menuFor !== null, menuCell, closeMenu);

  /* The wizard needs the number list, the live group list and create. */
  const wizardReason = unservedReason(port, 'bridges.connections.list', 'The add-bridge wizard')
    ?? unservedReason(port, 'bridges.conversations.list', 'The add-bridge wizard');
  const [adding, setAdding] = useState(false);

  if (loadError) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Bridges could not be read." why={loadError} testId="bridges-load-error" />
      </SectionFrame>
    );
  }

  const act = async (bridge: BridgeView, verb: 'pause' | 'resume') => {
    setMenuFor(null);
    setBusy(bridge.id);
    setRowError(null);
    try {
      await port[verb](bridge.id, bridge.version);
      setNotice(verb === 'pause'
        ? `${bridge.title} is paused. Messages are still logged; nobody is answered and nothing is sent.`
        : `${bridge.title} is live again.`);
      await reload();
    } catch (err) {
      setRowError({ id: bridge.id, text: bridgeFailureOf(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <SectionFrame
      title={heading}
      measure={false}
      pad={false}
      action={(
        <button
          type="button"
          className="set-chip"
          disabled={wizardReason !== null}
          title={wizardReason ?? undefined}
          data-testid="bridges-add"
          onClick={() => setAdding(true)}
        >
          + Add bridge
        </button>
      )}
    >
      <div className="brg-set" data-testid="bridges-section">
        {wizardReason ? <p className="brg-set__lede set-note">{wizardReason}</p> : null}
        {notice ? (
          <div className="cred-notice brg-set__notice" role="status" data-testid="bridges-notice">
            <span className="cred-notice__head">{notice}</span>
          </div>
        ) : null}

        <AccountsBlock
          port={port}
          spaceId={spaceId}
          bridges={bridges ?? []}
          onChanged={(message) => { setNotice(message); void reload(); }}
        />

        <div className="brg-set__group">
          <div className="brg-set__grouphead"><span className="set-eyebrow">Bridges</span></div>
          {bridges === null ? (
            <p className="brg-set__empty set-prose" role="status">Loading bridges…</p>
          ) : bridges.length === 0 ? (
            <p className="brg-set__empty set-prose" data-testid="bridges-empty">
              No bridges yet. A bridge brings one WhatsApp group, Slack channel or DM into a chat, a session or a
              channel here.
            </p>
          ) : (
            <table className="brg-set__table" data-testid="bridges-table">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Conversation</th>
                  <th scope="col">Target</th>
                  <th scope="col">People</th>
                  <th scope="col">Status</th>
                  <th scope="col"><span className="brg-sr">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {bridges.map((b) => (
                  <tr key={b.id} data-testid={`bridge-row-${b.id}`}>
                    <td>
                      <span className="brg-set__prov">
                        <BridgeProviderMark provider={b.provider} />
                        {bridgeProviderLabel(b.provider)}
                      </span>
                    </td>
                    <td>
                      {onOpen ? (
                        <button type="button" className="brg-link" onClick={() => onOpen(b.id)} aria-label={`Open ${b.title} bridge`}>
                          {conversationLine(b)}
                        </button>
                      ) : conversationLine(b)}
                    </td>
                    <td><span aria-hidden="true">→ {TARGET_GLYPH[b.target.kind]} </span>{b.target.title}</td>
                    <td className="brg-set__muted">{peopleLine(b)}</td>
                    <td>
                      <Pill tone={STATUS_TONE[b.status]} dot="solid" title={statusLine(b)}>{statusLine(b)}</Pill>
                      {rowError?.id === b.id ? <p className="brg-error" role="alert">{rowError.text}</p> : null}
                    </td>
                    <td className="brg-set__menu" ref={menuFor === b.id ? menuCell : undefined}>
                      <button
                        type="button"
                        className="set-ghost"
                        aria-label={`More for ${b.title}`}
                        aria-expanded={menuFor === b.id}
                        disabled={busy === b.id}
                        onClick={() => setMenuFor(menuFor === b.id ? null : b.id)}
                      >
                        ⋯
                      </button>
                      {menuFor === b.id ? (
                        <div className="brg-menu" role="menu" aria-label={`${b.title} actions`}>
                          {b.status === 'paused' ? (
                            <button type="button" role="menuitem" onClick={() => void act(b, 'resume')}>Resume {b.title}</button>
                          ) : (
                            <button type="button" role="menuitem" onClick={() => void act(b, 'pause')}>Pause {b.title}</button>
                          )}
                          <button
                            type="button"
                            role="menuitem"
                            disabled
                            title={pendingReason(port, 'bridges.test', 'Send a test message')}
                          >
                            Send a test message
                          </button>
                          <button type="button" role="menuitem" className="brg-menu__danger" onClick={() => { setMenuFor(null); setRemoving(b); }}>
                            Remove {b.title}…
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {adding ? (
        <AddBridgeWizard
          port={port}
          spaceId={spaceId}
          onClose={() => { setAdding(false); void reload(); }}
          onCreated={(view) => {
            setAdding(false);
            setNotice(`${view.title} is bridged to ${view.target.title}.`);
            void reload();
            onOpen?.(view.id);
          }}
        />
      ) : null}
      {removing ? (
        <RemoveBridgeDialog
          bridge={removing}
          port={port}
          onClose={() => setRemoving(null)}
          onRemoved={(view) => {
            setRemoving(null);
            setNotice(`${view.title} is removed. The ${bridgeProviderLabel(view.provider)} conversation is not touched.`);
            void reload();
          }}
        />
      ) : null}
    </SectionFrame>
  );
}
