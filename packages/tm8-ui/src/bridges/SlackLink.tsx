import { useEffect, useState } from 'react';
import type { BridgeConnectionView, BridgeView } from '@tm8/contract';
import type { BridgesPort } from './api';
import { isSlackTs, safeWorkspaceUrl, slackChannelUrl, slackMessageUrl } from './slack';

/**
 * VIEW IN SLACK — the way back out (Slack design §1.3: "every Slack message
 * appears on the bridge and the session, with a link back to Slack").
 *
 * The URLs are built from the WORKSPACE URL, which `auth.test` answered and
 * which therefore rides the CONNECTION, not the bridge. So a surface can only
 * draw these links if it can see the connection: `useSlackWorkspace` reads the
 * viewer's own connections and matches the bridge's `connectionId`.
 *
 * A bridge on ANOTHER member's workspace is not in that list (`connections.list`
 * is a `/v2/me` read, D28), so there is no URL and NO LINK IS DRAWN. That is
 * deliberate: a guessed host would take someone to the wrong workspace, and on
 * Enterprise Grid the host is the thing that differs.
 */

/** The workspace URL for this bridge, or null when it cannot be known here. */
export function useSlackWorkspace(
  port: Pick<BridgesPort, 'connections' | 'serves'> | null | undefined,
  view: Pick<BridgeView, 'provider' | 'connectionId'> | null | undefined,
): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const provider = view?.provider ?? null;
  const connectionId = view?.connectionId ?? null;
  useEffect(() => {
    setUrl(null);
    if (!port || provider !== 'slack' || !connectionId) return;
    if (!port.serves('bridges.connections.list')) return;
    let live = true;
    void port.connections.list().then(
      (rows: BridgeConnectionView[]) => {
        if (!live) return;
        setUrl(safeWorkspaceUrl(rows.find((r) => r.id === connectionId)?.account?.url));
      },
      () => {},
    );
    return () => { live = false; };
  }, [port, provider, connectionId]);
  return url;
}

/** *↗ View in Slack* for the whole channel. Nothing when there is no workspace URL. */
export function SlackChannelLink({
  workspaceUrl,
  channelId,
  label = 'View in Slack',
}: {
  workspaceUrl: string | null;
  channelId: string;
  label?: string;
}) {
  if (!workspaceUrl) return null;
  return (
    <a
      className="brg-link brg-slacklink"
      data-testid="slack-channel-link"
      href={slackChannelUrl(workspaceUrl, channelId)}
      target="_blank"
      rel="noreferrer noopener"
      title="Open this channel in Slack"
    >
      ↗ {label}
    </a>
  );
}

/**
 * *↗ In Slack* under one message: the permalink shape
 * `archives/<channel>/p<ts without the dot>`, and for a reply inside a thread
 * the `?thread_ts=…&cid=…` that makes Slack open the thread at that message.
 */
export function SlackMessageLink({
  workspaceUrl,
  channelId,
  ts,
  threadRootTs,
}: {
  workspaceUrl: string | null;
  channelId: string;
  /** The Slack `ts`: the bridge log's `origin.externalMessageId`. */
  ts: string | null | undefined;
  /** The thread root's `ts`, when this message is a reply in a thread. */
  threadRootTs?: string | null;
}) {
  /* Only a real `<seconds>.<microseconds>` names a message in Slack. A
     slash command's `cmd:<trigger_id>` does not, so it gets no link at all
     rather than a 404 permalink (#1509 review 3). */
  if (!workspaceUrl || !isSlackTs(ts)) return null;
  return (
    <a
      className="brg-link brg-slacklink"
      data-testid="slack-message-link"
      href={slackMessageUrl(workspaceUrl, channelId, ts, threadRootTs)}
      target="_blank"
      rel="noreferrer noopener"
      title={threadRootTs ? 'Open this reply in its Slack thread' : 'Open this message in Slack'}
    >
      ↗ In Slack
    </a>
  );
}
