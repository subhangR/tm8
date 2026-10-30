import { useCallback, useEffect, useState } from 'react';
import { BridgeDeliveryTick, bridgeProviderLabel, BridgeVia } from '../bridge-marks';
import type { BridgeLogEntry, BridgeView } from '@tm8/contract';
import { clockTime } from '../../kit/time';
import type { BridgesPort } from '../api';
import { bridgeFailureOf } from '../format';

const PAGE = 50;

/**
 * CONVERSATION (§4.4): the log anchor's thread, oldest first — the bridge's
 * own discussion, or the channel's for a channel target. Inbound bubbles name
 * the participant (never a number); outbound ones say they were sent, and a
 * worker's carry its `Title (handle)` signature (D23).
 *
 * The composer is the panel's normal Messages composer on the same anchor;
 * this tab says where a message written there goes, and does not draw a
 * second composer.
 */
export function ConversationTab({ view, port }: { view: BridgeView; port: Pick<BridgesPort, 'log'> }) {
  const [items, setItems] = useState<BridgeLogEntry[] | null>(null);
  const [more, setMore] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = bridgeProviderLabel(view.provider);

  const load = useCallback(async (since: string | null) => {
    try {
      const page = await port.log(view.id, { limit: PAGE, ...(since ? { since } : {}) });
      setItems((prev) => (since ? [...(prev ?? []), ...page.items] : page.items));
      setMore(page.more);
      setCursor(page.lastMessageId ?? since);
      setError(null);
    } catch (err) {
      setError(bridgeFailureOf(err));
    }
  }, [port, view.id]);

  useEffect(() => { void load(null); }, [load]);

  if (error && items === null) return <p className="brg-error" role="alert">{error}</p>;
  if (items === null) return <p className="brg-hint" role="status">Loading the conversation…</p>;
  const crosses = view.policy.direction !== 'in' && view.status !== 'ended';
  return (
    <div className="brg-conv" data-testid="bridge-conversation">
      {/* bridges.log.read answers oldest first from the start of the log
          (server readLog); a latest-first read is a follow-up. Say so. */}
      <p className="brg-hint" data-testid="bridge-conversation-order">
        Oldest first, {PAGE} at a time{more ? ' — use Show later messages to read on' : ''}.
      </p>
      {items.length === 0 ? (
        <p className="brg-hint">Nothing has crossed this bridge yet.</p>
      ) : (
        <ol className="brg-conv__list">
          {items.map((m) => <Bubble key={m.id} entry={m} view={view} />)}
        </ol>
      )}
      {more ? (
        <button type="button" className="pn-btn" onClick={() => void load(cursor)}>Show later messages</button>
      ) : null}
      {error ? <p className="brg-error" role="alert">{error}</p> : null}
      <p className="brg-conv__where brg-hint" data-testid="bridge-conversation-where">
        {crosses
          ? view.status === 'paused'
            ? `Paused: a message written in this bridge's Messages stays in tm8 until the bridge is resumed.`
            : `Write in this bridge's Messages to reply in ${provider}${view.policy.outbound === 'replies' ? ' (replies to a bridged message cross; other notes stay here)' : ''}.`
          : `Nothing written here crosses to ${provider}: the bridge only brings messages in.`}
      </p>
    </div>
  );
}

/**
 * One message. The crossing marks are B2-ticks' shared pieces
 * (`bridge-marks.tsx`, §4.5): `BridgeVia` on an inbound bubble, the outbox
 * ledger's `BridgeDeliveryTick` under an outbound one — the same words the
 * chat transcript draws, so the two surfaces can never disagree.
 */
function Bubble({ entry, view }: { entry: BridgeLogEntry; view: BridgeView }) {
  const dir = entry.origin?.direction ?? null;
  const who = dir === 'in'
    ? entry.origin?.participant ?? entry.authorName
    : entry.handle ? `${entry.authorName} (${entry.handle})` : entry.authorName || 'tm8';
  return (
    <li className={`brg-bubble brg-bubble--${dir ?? 'local'}`}>
      <div className="brg-bubble__meta">
        <span className="brg-bubble__who">{who}</span>
        {dir === 'in' ? (
          <BridgeVia
            bridge={{
              bridgeId: view.id, provider: view.provider, conversation: view.title, direction: 'in',
              participant: entry.origin?.participant ?? null,
              // The log read carries no trust yet; B2-ticks adds it to BridgeLogEntry (#1434).
              trust: null,
              delivery: null,
            }}
          />
        ) : null}
        <span className="brg-muted"> · {clockTime(entry.createdAt)}</span>
        {dir === null ? <span className="brg-bubble__state">here only</span> : null}
      </div>
      <p className="brg-bubble__body">{entry.body}</p>
      {entry.delivery ? <BridgeDeliveryTick delivery={entry.delivery} provider={view.provider} /> : null}
    </li>
  );
}
