import { useCallback, useEffect, useRef, useState } from 'react';
import type { BridgeConnectionView, BridgeView } from '@tm8/contract';
import { Pill } from '../kit';
import { shortDate } from '../kit/time';
import { useDismissable } from '../panels/useDismissable';
import type { BridgesPort } from './api';
import { BridgeProviderMark, bridgeProviderLabel } from './bridge-marks';
import { ConsequenceDialog } from './ConsequenceDialog';
import { CONNECTION_TONE, CONNECTION_WORD, bridgeFailureOf } from './format';
import { LinkNumberDialog } from './LinkNumberDialog';

/**
 * Settings → Bridges › ACCOUNTS & SECRETS (§4.2, v2 §1.6).
 *
 * With `bridges.connections.list` served, the rows are the viewer's OWN numbers
 * (it is a `/v2/me` read: nobody else's number is listed, D28), each saying
 * whether it is offered to this space, with its ⋯: Offer to this space,
 * Withdraw from this space, Re-link, Remove. A bridge here that rides another
 * member's number is shown as one line per such number, with no controls —
 * only its owner can act on it. Without the op, the rows are read off the
 * bridges, as before.
 */
interface DerivedRow { id: string; provider: BridgeView['provider']; connection: BridgeView['health']['connection']; bridges: number; lastInboundAt: string | null }

export function connectionRowsOf(bridges: readonly BridgeView[]): DerivedRow[] {
  const rows = new Map<string, DerivedRow>();
  for (const b of bridges) {
    const row = rows.get(b.connectionId);
    if (!row) {
      rows.set(b.connectionId, {
        id: b.connectionId, provider: b.provider, connection: b.health.connection, bridges: 1,
        lastInboundAt: b.health.lastInboundAt,
      });
    } else {
      row.bridges += 1;
      if ((b.health.lastInboundAt ?? '') > (row.lastInboundAt ?? '')) row.lastInboundAt = b.health.lastInboundAt;
    }
  }
  return [...rows.values()];
}

export function AccountsBlock({
  port,
  spaceId,
  bridges,
  onChanged,
}: {
  port: BridgesPort;
  spaceId: string;
  bridges: readonly BridgeView[];
  /** A connection change can pause or end bridges here: the section re-reads them. */
  onChanged(notice: string): void;
}) {
  const live = port.serves('bridges.connections.list');
  const [mine, setMine] = useState<BridgeConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [linking, setLinking] = useState<{ relink: BridgeConnectionView | null } | null>(null);
  const [removing, setRemoving] = useState<BridgeConnectionView | null>(null);
  const [withdrawing, setWithdrawing] = useState<BridgeConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const menuCell = useRef<HTMLDivElement>(null);
  const closeMenu = useCallback(() => setMenuFor(null), []);
  useDismissable(menuFor !== null, menuCell, closeMenu);

  const reload = useCallback(async () => {
    if (!live) return;
    try {
      setMine(await port.connections.list());
      setError(null);
    } catch (err) {
      setError(bridgeFailureOf(err));
    }
  }, [port, live]);
  useEffect(() => { void reload(); }, [reload]);

  const act = async (work: () => Promise<string>) => {
    setMenuFor(null);
    setBusy(true);
    setError(null);
    try {
      const notice = await work();
      await reload();
      onChanged(notice);
    } catch (err) {
      setError(bridgeFailureOf(err));
    } finally {
      setBusy(false);
    }
  };

  const derived = connectionRowsOf(bridges);
  const mineIds = new Set((mine ?? []).map((c) => c.id));
  const others = live ? derived.filter((d) => !mineIds.has(d.id)) : derived;
  const linkReason = live && port.serves('bridges.connections.begin') ? null
    : 'Linking a new account arrives with bridges.connections.begin, which this node does not serve yet.';

  return (
    <div className="brg-set__group">
      <div className="brg-set__grouphead">
        <span className="set-eyebrow">Accounts &amp; secrets</span>
        <button
          type="button"
          className="set-chip set-chip--sm"
          disabled={linkReason !== null || busy}
          title={linkReason ?? undefined}
          onClick={() => setLinking({ relink: null })}
        >
          + Link a new account
        </button>
      </div>
      {error ? <p className="brg-error brg-set__note" role="alert">{error}</p> : null}
      <ul className="brg-set__rows" data-testid="bridges-connections">
        {(mine ?? []).map((c) => {
          const offer = c.offers.find((o) => o.spaceId === spaceId);
          const status = c.status === 'removed' ? 'offline' : c.status;
          return (
            <li key={c.id} className="brg-set__conn" data-testid={`connection-${c.id}`}>
              <BridgeProviderMark provider={c.provider} />
              <span className="brg-set__provider">{c.label}</span>
              <span className="brg-set__mono">{c.externalAccountId ?? 'not linked yet'}</span>
              <Pill tone={CONNECTION_TONE[status]} dot="solid">{CONNECTION_WORD[status]}</Pill>
              <span className="brg-set__muted">{c.lastSeenAt ? `seen ${shortDate(c.lastSeenAt)}` : 'never seen'}</span>
              <span className="brg-set__count">
                {offer ? `${offer.bridges} ${offer.bridges === 1 ? 'bridge' : 'bridges'} here` : 'not offered here'}
              </span>
              <div className="brg-set__menu" ref={menuFor === c.id ? menuCell : undefined}>
                <button
                  type="button"
                  className="set-ghost"
                  aria-label={`More for ${c.label}`}
                  aria-expanded={menuFor === c.id}
                  disabled={busy}
                  onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                >
                  ⋯
                </button>
                {menuFor === c.id ? (
                  <div className="brg-menu" role="menu" aria-label={`${c.label} actions`}>
                    {offer ? (
                      <button type="button" role="menuitem" onClick={() => { setMenuFor(null); setWithdrawing(c); }}>
                        Withdraw {c.label} from this space
                      </button>
                    ) : (
                      <button type="button" role="menuitem" onClick={() => void act(async () => {
                        await port.connections.offer(c.id, spaceId);
                        return `${c.label} is offered to this space: you can bridge its groups here.`;
                      })}>
                        Offer {c.label} to this space
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      title="Give it to a member who wants to hand you a bridge: they paste it in Hand over."
                      onClick={() => {
                        setMenuFor(null);
                        void navigator.clipboard?.writeText(c.id).then(() => onChanged(`${c.label}: connection id copied.`), () => onChanged(`${c.label}: connection id ${c.id}`));
                      }}
                    >
                      Copy connection id
                    </button>
                    <button type="button" role="menuitem" onClick={() => { setMenuFor(null); setLinking({ relink: c }); }}>
                      Re-link {c.label}
                    </button>
                    <hr className="brg-menu__rule" />
                    <button type="button" role="menuitem" className="brg-menu__danger" onClick={() => { setMenuFor(null); setRemoving(c); }}>
                      Remove {c.label}…
                    </button>
                  </div>
                ) : null}
              </div>
            </li>
          );
        })}
        {others.map((c) => (
          <li key={c.id} className="brg-set__conn" data-testid={`connection-other-${c.id}`}>
            <BridgeProviderMark provider={c.provider} />
            <span className="brg-set__provider">{bridgeProviderLabel(c.provider)}</span>
            <span className="brg-set__muted">{live ? 'another member’s number' : `account ···· ${c.id.slice(-4)}`}</span>
            <Pill tone={CONNECTION_TONE[c.connection]} dot="solid">{CONNECTION_WORD[c.connection]}</Pill>
            <span className="brg-set__muted">{c.lastInboundAt ? `seen ${shortDate(c.lastInboundAt)}` : 'never seen'}</span>
            <span className="brg-set__count">{c.bridges} {c.bridges === 1 ? 'bridge' : 'bridges'} here</span>
          </li>
        ))}
      </ul>
      {(mine ?? []).length === 0 && others.length === 0 ? (
        <p className="brg-set__empty set-prose">{live ? 'You have not linked a number yet, and no bridge here rides one.' : 'No account carries a bridge in this space yet.'}</p>
      ) : null}
      <p className="brg-set__note set-note" data-testid="bridges-connections-note">
        {live
          ? 'Your numbers are yours: only you see them and their groups. A number carries bridges in a space only once you offer it there.'
          : 'Accounts are listed from the bridges they carry. Offering an account to another space, re-linking and removing it arrive with the account operations.'}
      </p>
      <div className="brg-set__secrets">
        <span className="brg-set__muted">Shared secrets</span>
        <span className="brg-set__muted">coming soon — tracked in the Resources task</span>
      </div>

      {linking ? (
        <LinkNumberDialog
          port={port}
          spaceId={spaceId}
          relink={linking.relink}
          onClose={() => setLinking(null)}
          onLinked={(c) => { setLinking(null); void reload(); onChanged(`${c.label} is linked${c.offers.some((o) => o.spaceId === spaceId) ? ' and offered to this space' : ''}.`); }}
        />
      ) : null}
      {withdrawing ? (() => {
        /* v2 §1.5: unsharing a connection stops every bridge riding it here —
           named, in numbers, before the second click (review #1447 r1). */
        const riding = bridges.filter((b) => b.connectionId === withdrawing.id && b.status !== 'ended');
        return (
          <ConsequenceDialog
            title={`Withdraw ${withdrawing.label} from this space?`}
            consequences={[
              riding.length
                ? `${riding.length} ${riding.length === 1 ? 'bridge' : 'bridges'} in this space stop: ${riding.map((b) => b.title).join(', ')}. They are paused, not removed; offering the number again lets you resume them.`
                : 'No bridge in this space rides it, so nothing stops.',
              'The number stays linked, and stays offered to any other space it is offered to.',
            ]}
            confirmLabel="Withdraw it"
            onCancel={() => setWithdrawing(null)}
            onConfirm={async () => {
              const c = withdrawing;
              setWithdrawing(null);
              await act(async () => {
                const r = await port.connections.withdraw(c.id, spaceId);
                return r.pausedBridgeIds.length
                  ? `${c.label} is withdrawn from this space; ${r.pausedBridgeIds.length} bridge(s) riding it are paused.`
                  : `${c.label} is withdrawn from this space.`;
              });
            }}
          />
        );
      })() : null}
      {removing ? (
        <ConsequenceDialog
          title={`Remove ${removing.label}?`}
          consequences={[
            'WhatsApp logs this device out; the phone keeps its chats.',
            `${removing.offers.reduce((n, o) => n + o.bridges, 0)} bridge(s) riding it, in every space it is offered to, end. Their logged messages stay, read-only.`,
            `It is withdrawn from ${removing.offers.length} space(s).`,
          ]}
          confirmLabel="Remove it"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const c = removing;
            setRemoving(null);
            await act(async () => {
              const r = await port.connections.remove(c.id);
              return `${c.label} is removed; ${r.endedBridgeIds.length} bridge(s) ended.`;
            });
          }}
        />
      ) : null}
    </div>
  );
}
