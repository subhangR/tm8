import { useCallback, useEffect, useState } from 'react';
import { BridgeDeliveryTick, bridgeProviderLabel, BridgeVia } from '../bridge-marks';
import type { BridgeLogEntry, BridgeTrust, BridgeView } from '@tm8/contract';
import { clockTime } from '../../kit/time';
import type { BridgesPort } from '../api';
import { bridgeFailureOf } from '../format';
import { SlackMessageLink, useSlackWorkspace } from '../SlackLink';
import { isSlackTs } from '../slack';

const PAGE = 50;

/**
 * CONVERSATION (§4.4): the log anchor's thread — the bridge's own
 * discussion, or the channel's for a channel target. It opens on the NEWEST
 * page and scrolls back a page at a time (#1446's latest/before); rows read
 * oldest first within what is shown. Inbound bubbles name
 * the participant (never a number); outbound ones say they were sent, and a
 * worker's carry its `Title (handle)` signature (D23).
 *
 * The composer is the panel's normal Messages composer on the same anchor;
 * this tab says where a message written there goes, and does not draw a
 * second composer.
 */
export function ConversationTab({ view, port }: { view: BridgeView; port: Pick<BridgesPort, 'log' | 'connections' | 'serves'> }) {
  const [items, setItems] = useState<BridgeLogEntry[] | null>(null);
  /* The id to pass as `before` for the next older page; null at the start of the log. */
  const [older, setOlder] = useState<string | null>(null);
  /* One read at a time: a second click on a slow link would prepend the same page twice. */
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const provider = bridgeProviderLabel(view.provider);
  /* §1.3: every bridged message offers the way back to Slack. Null on
     WhatsApp and where the workspace cannot be known (see SlackLink). */
  const workspaceUrl = useSlackWorkspace(port, view);

  /* Open on the NEWEST page (#1446: latest=true) and scroll back with
     before=olderCursor; rows stay oldest-first within a page, so an older page
     goes in front. Neither read moves anyone's unread cursor. */
  const load = useCallback(async (before: string | null) => {
    setLoading(true);
    try {
      const page = await port.log(view.id, { limit: PAGE, ...(before ? { before } : { latest: true }) });
      setItems((prev) => (before ? [...page.items, ...(prev ?? [])] : page.items));
      setOlder(page.olderCursor);
      setError(null);
    } catch (err) {
      setError(bridgeFailureOf(err));
    } finally {
      setLoading(false);
    }
  }, [port, view.id]);

  useEffect(() => { void load(null); }, [load]);

  if (error && items === null) return <p className="brg-error" role="alert">{error}</p>;
  if (items === null) return <p className="brg-hint" role="status">Loading the conversation…</p>;
  const crosses = view.policy.direction !== 'in' && view.status !== 'ended';
  return (
    <div className="brg-conv" data-testid="bridge-conversation">
      {older ? (
        <button type="button" className="pn-btn brg-conv__older" disabled={loading} onClick={() => void load(older)} data-testid="bridge-conversation-older">
          {loading ? 'Loading earlier messages…' : 'Show earlier messages'}
        </button>
      ) : items.length > 0 ? (
        <p className="brg-hint" data-testid="bridge-conversation-start">The start of the conversation.</p>
      ) : null}
      {items.length === 0 ? (
        <p className="brg-hint">Nothing has crossed this bridge yet.</p>
      ) : (
        <ol className="brg-conv__list">
          {items.map((m) => (
            <Bubble
              key={m.id}
              entry={m}
              view={view}
              workspaceUrl={workspaceUrl}
              /* The thread root's Slack ts, so a reply's link opens the THREAD
                 rather than the channel. `rootMessageId` is a tm8 id, so it is
                 resolved against this page; a root on an older page gives no
                 thread_ts and the link still opens the message. */
              threadRootTs={rootTsOf(items, m)}
            />
          ))}
        </ol>
      )}
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
/** The Slack `ts` of this entry's thread root, when the root is on this page and is not the entry itself. */
export function rootTsOf(items: readonly BridgeLogEntry[], entry: BridgeLogEntry): string | null {
  const rootId = entry.rootMessageId;
  if (!rootId || rootId === entry.id) return null;
  const ts = items.find((m) => m.id === rootId)?.origin?.externalMessageId;
  /* A thread rooted on a slash command has no linkable root (#1509 review 3). */
  return isSlackTs(ts) ? ts! : null;
}

function Bubble({
  entry,
  view,
  workspaceUrl,
  threadRootTs,
}: {
  entry: BridgeLogEntry;
  view: BridgeView;
  workspaceUrl: string | null;
  threadRootTs: string | null;
}) {
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
              // #1457 adds `trust` to BridgeLogEntry (the MessageBridgeView value); null until it is on main.
              trust: (entry as BridgeLogEntry & { trust?: BridgeTrust | null }).trust ?? null,
              delivery: null,
            }}
          />
        ) : null}
        <span className="brg-muted"> · {clockTime(entry.createdAt)}</span>
        {dir === null ? <span className="brg-bubble__state">here only</span> : null}
        {dir !== null ? (
          <SlackMessageLink
            workspaceUrl={workspaceUrl}
            channelId={view.conversation.externalId}
            ts={entry.origin?.externalMessageId}
            threadRootTs={threadRootTs}
          />
        ) : null}
      </div>
      <p className="brg-bubble__body">{entry.body}</p>
      {entry.delivery ? <BridgeDeliveryTick delivery={entry.delivery} provider={view.provider} /> : null}
    </li>
  );
}
