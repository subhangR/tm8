import { useCallback, useEffect, useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import {
  clientFor,
  probeDestination,
  signInToServer,
  type DestinationProbe,
  type TransferServer,
} from './transfer-client';
import {
  collectPlan,
  executeTransfer,
  TRANSFERABLE_KINDS,
  type TransferProgress,
  type TransferResult,
} from './engine';

/**
 * THE TRANSFER DIALOG — one card, four facts, in the order they gate:
 * destination server → the viewer's standing there (sign-in when needed) →
 * destination space → what travels. The verb is chosen by the DESTINATION:
 * landing on this machine is a PULL, landing anywhere else is a SEND — same
 * engine, same rights, different word, because "pull" is how the viewer
 * thinks about bringing remote work home and "send" is how they think about
 * sharing it outward.
 *
 * A copy is a copy. The result panel says what arrived and what did not, and
 * the provenance receipt on the copy says where it came from — nothing here
 * pretends the two entities stay connected afterwards.
 */

interface ConnectedPeer {
  id: string;
  kind: string;
  title: string;
  edgeType: string;
  transferable: boolean;
}

/** Every distinct non-self endpoint reachable from the subject's edges. */
export function connectedPeersOf(detail: EntityDetail): ConnectedPeer[] {
  const peers = new Map<string, ConnectedPeer>();
  const groups = [...(detail.connections?.outgoing ?? []), ...(detail.connections?.incoming ?? [])];
  for (const group of groups) {
    for (const edge of group.edges) {
      const peer: EntitySummary = edge.source.id === detail.id ? edge.target : edge.source;
      if (peer.id === detail.id || peers.has(peer.id)) continue;
      peers.set(peer.id, {
        id: peer.id,
        kind: peer.kind,
        title: peer.title,
        edgeType: group.type,
        transferable: TRANSFERABLE_KINDS.has(peer.kind),
      });
    }
  }
  return [...peers.values()];
}

export interface TransferDialogProps {
  subject: EntityDetail;
  sourceServerId: string;
  sourceLabel: string;
  /** Every reachable server, the source included — filtered here. */
  servers: TransferServer[];
  onDismiss(): void;
}

export function TransferDialog({ subject, sourceServerId, sourceLabel, servers, onDismiss }: TransferDialogProps) {
  const destinations = useMemo(
    () => servers.filter((server) => server.id !== sourceServerId),
    [servers, sourceServerId],
  );
  const [destId, setDestId] = useState<string | null>(destinations.length === 1 ? (destinations[0]?.id ?? null) : null);
  const [probe, setProbe] = useState<DestinationProbe | { state: 'probing' } | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [signinUser, setSigninUser] = useState('');
  const [signinPassword, setSigninPassword] = useState('');
  const [signinBusy, setSigninBusy] = useState(false);
  const [signinError, setSigninError] = useState<string | null>(null);

  const peers = useMemo(() => connectedPeersOf(subject), [subject]);
  const childCount = subject.hierarchy?.children?.items?.length ?? 0;
  const hasMoreChildren = subject.hierarchy?.children?.nextCursor != null;
  const [includeChildren, setIncludeChildren] = useState(childCount > 0);
  const [includeMessages, setIncludeMessages] = useState(false);
  const [selectedPeers, setSelectedPeers] = useState<ReadonlySet<string>>(new Set());

  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [result, setResult] = useState<(TransferResult & { skippedCount: number }) | null>(null);

  const destination = destinations.find((server) => server.id === destId) ?? null;
  const verb = destination === null ? 'Transfer' : destination.local ? 'Pull' : 'Send';

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !running) onDismiss();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onDismiss, running]);

  const runProbe = useCallback(async (serverId: string) => {
    setProbe({ state: 'probing' });
    setSpaceId(null);
    setSigninError(null);
    const answer = await probeDestination(serverId);
    setProbe(answer);
    if (answer.state === 'ready' && answer.spaces.length === 1) {
      setSpaceId(answer.spaces[0]?.id ?? null);
    }
  }, []);

  useEffect(() => {
    if (destId !== null) void runProbe(destId);
  }, [destId, runProbe]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    if (destId === null) return;
    setSigninBusy(true);
    setSigninError(null);
    const outcome = await signInToServer(destId, signinUser, signinPassword);
    setSigninBusy(false);
    if (outcome.ok) {
      setSigninPassword('');
      void runProbe(destId);
    } else {
      setSigninError(outcome.message);
    }
  };

  const run = async () => {
    if (destId === null || spaceId === null) return;
    setRunning(true);
    setRunError(null);
    setResult(null);
    try {
      const plan = await collectPlan(
        { client: clientFor(sourceServerId), serverId: sourceServerId, label: sourceLabel },
        subject,
        { includeChildren, connectedIds: [...selectedPeers], includeMessages },
        setProgress,
      );
      const outcome = await executeTransfer(plan, { client: clientFor(destId), spaceId }, setProgress);
      setResult({ ...outcome, skippedCount: plan.skipped.length });
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const stop = (event: MouseEvent) => event.stopPropagation();
  const ready = probe !== null && probe.state === 'ready';
  const canRun = !running && result === null && destId !== null && spaceId !== null && ready;

  return (
    <div className="tr-backdrop" role="presentation" onMouseDown={() => !running && onDismiss()}>
      <div
        className="tr-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-title"
        data-testid="transfer-dialog"
        onMouseDown={stop}
      >
        <h2 id="transfer-title">
          {verb} “{subject.title}”
        </h2>
        <p className="tr-sub">
          From <strong>{sourceLabel}</strong>. The copy belongs to the destination and carries a
          provenance note; it does not stay in sync with its source.
        </p>

        <div className="tr-section">
          <span className="tr-label">DESTINATION SERVER</span>
          <div className="tr-servers" role="radiogroup" aria-label="Destination server">
            {destinations.map((server) => (
              <label key={server.id} className="tr-choice">
                <input
                  type="radio"
                  name="tr-destination"
                  checked={destId === server.id}
                  disabled={running}
                  onChange={() => setDestId(server.id)}
                />
                <span>{server.label}</span>
                <span className="tr-choice__hint">{server.local ? 'pull here' : 'send'}</span>
              </label>
            ))}
          </div>
        </div>

        {probe?.state === 'probing' ? <div className="tr-note">Checking the destination…</div> : null}

        {probe?.state === 'unreachable' ? (
          <div className="tr-error" role="alert">
            Cannot reach this server: {probe.message}
            <button type="button" className="tr-linkbtn" onClick={() => destId !== null && void runProbe(destId)}>
              retry
            </button>
          </div>
        ) : null}

        {probe?.state === 'needs-signin' ? (
          <form className="tr-section tr-signin" onSubmit={signIn}>
            <span className="tr-label">SIGN IN TO {destination?.label ?? 'SERVER'}</span>
            <p className="tr-note">
              Transfers use your own account on each server. No account there? Ask its admin for an
              invite.
            </p>
            <input
              placeholder="username"
              value={signinUser}
              autoComplete="username"
              onChange={(event) => setSigninUser(event.target.value)}
            />
            <input
              placeholder="password"
              type="password"
              value={signinPassword}
              autoComplete="current-password"
              onChange={(event) => setSigninPassword(event.target.value)}
            />
            {signinError ? (
              <div className="tr-error" role="alert">
                {signinError}
              </div>
            ) : null}
            <button type="submit" className="tr-primary" disabled={signinBusy || signinUser === '' || signinPassword === ''}>
              {signinBusy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        ) : null}

        {ready ? (
          <>
            <div className="tr-section">
              <span className="tr-label">
                DESTINATION SPACE
                {probe.signedInAs !== null ? ` · AS @${probe.signedInAs.toUpperCase()}` : ''}
              </span>
              {probe.spaces.length === 0 ? (
                <div className="tr-note">No space on this server is visible to you.</div>
              ) : (
                <select
                  value={spaceId ?? ''}
                  disabled={running}
                  aria-label="Destination space"
                  onChange={(event) => setSpaceId(event.target.value === '' ? null : event.target.value)}
                >
                  <option value="">choose a space…</option>
                  {probe.spaces.map((space) => (
                    <option key={space.id} value={space.id}>
                      {space.name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="tr-section">
              <span className="tr-label">WHAT TRAVELS</span>
              <label className="tr-choice">
                <input
                  type="checkbox"
                  checked={includeChildren}
                  disabled={running || childCount === 0}
                  onChange={(event) => setIncludeChildren(event.target.checked)}
                />
                <span>
                  Sub-items
                  {childCount > 0 ? ` (${childCount}${hasMoreChildren ? '+' : ''})` : ' (none)'}
                </span>
              </label>
              <label className="tr-choice">
                <input
                  type="checkbox"
                  checked={includeMessages}
                  disabled={running}
                  onChange={(event) => setIncludeMessages(event.target.checked)}
                />
                <span>Discussion messages — copied as text, original authors named in the body</span>
              </label>
              {peers.length > 0 ? (
                <div className="tr-peers">
                  <span className="tr-label">CONNECTED ENTITIES — edges between selected items travel too</span>
                  {peers.map((peer) => (
                    <label key={peer.id} className="tr-choice" title={peer.transferable ? undefined : `kind '${peer.kind}' can’t be transferred yet`}>
                      <input
                        type="checkbox"
                        checked={selectedPeers.has(peer.id)}
                        disabled={running || !peer.transferable}
                        onChange={(event) => {
                          setSelectedPeers((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(peer.id);
                            else next.delete(peer.id);
                            return next;
                          });
                        }}
                      />
                      <span>
                        {peer.title} <span className="tr-choice__hint">{peer.kind} · {peer.edgeType}</span>
                        {peer.transferable ? null : <span className="tr-choice__hint"> — not transferable yet</span>}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {progress !== null ? (
          <div className="tr-progress" aria-live="polite">
            {progress.phase === 'reading' ? 'Reading from source' : `Writing ${progress.phase}`}
            {' · '}
            {progress.done}/{progress.total} · {progress.label}
          </div>
        ) : null}

        {runError !== null ? (
          <div className="tr-error" role="alert">
            {runError}
          </div>
        ) : null}

        {result !== null ? (
          <div className="tr-result" data-testid="transfer-result">
            {result.destRootId !== null ? (
              <>
                <div className="tr-result__head">
                  ✓ {verb === 'Pull' ? 'Pulled' : 'Sent'} to {destination?.label}. Switch to that
                  server in the rail to open it.
                </div>
                <div className="tr-note">
                  {result.created.length} {result.created.length === 1 ? 'entity' : 'entities'},{' '}
                  {result.edgesCreated} {result.edgesCreated === 1 ? 'edge' : 'edges'},{' '}
                  {result.messagesPosted} {result.messagesPosted === 1 ? 'message' : 'messages'} created.
                </div>
              </>
            ) : (
              <div className="tr-error" role="alert">
                The transfer failed before the root entity was created.
              </div>
            )}
            {result.failedEntities.length > 0 ? (
              <ul className="tr-result__failures">
                {result.failedEntities.map((failure) => (
                  <li key={failure.sourceId}>
                    “{failure.title}” — {failure.reason}
                  </li>
                ))}
              </ul>
            ) : null}
            {result.edgesFailed.length > 0 ? (
              <div className="tr-note">
                {result.edgesFailed.length} {result.edgesFailed.length === 1 ? 'edge' : 'edges'} refused:{' '}
                {result.edgesFailed.map((edge) => edge.type).join(', ')}
              </div>
            ) : null}
            {result.messagesFailed > 0 ? (
              <div className="tr-note">{result.messagesFailed} messages failed to copy.</div>
            ) : null}
            {result.skippedCount > 0 ? (
              <div className="tr-note">{result.skippedCount} connected entities were skipped.</div>
            ) : null}
          </div>
        ) : null}

        <div className="tr-actions">
          <button type="button" onClick={onDismiss} disabled={running}>
            {result !== null ? 'Close' : 'Cancel'}
          </button>
          {result === null ? (
            <button type="button" className="tr-primary" disabled={!canRun} onClick={() => void run()}>
              {running
                ? `${verb}ing…`
                : destination !== null
                  ? `${verb} to ${destination.local ? 'this machine' : destination.id}`
                  : 'Choose a destination'}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
