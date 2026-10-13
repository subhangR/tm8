/**
 * Settings → Space links (W6). A link from this space to another space the
 * viewer is also a member of. Each member signs in for themselves; the server
 * stores that member's own session for the target and nobody else can use it.
 *
 * WHAT A MEMBER MUST BE TOLD (P8), drawn above everything else: the link itself
 * is shared, so every member of this space can see that a link to the target
 * exists; and agents working for you in this space can act in the target
 * space as you while you are signed in (W7 spaceLinks.invoke). Since W7b
 * (owner form response 01a0fbb4) the Allow spawn switch is enforced: with it
 * on, those agents may start, resume or dispatch sessions in the target; off
 * stops new ones and leaves running ones alone (256). (Lead's rule, R3 (ii):
 * every sentence describes only enforcement that ships.)
 *
 * Every write is human-only on the server. A refusal it answers (an agent
 * session, a target you are not a member of, anything else) is rendered as a
 * refusal on the row it came from, and no success notice is shown for it.
 *
 * No secret is drawn: the list carries only the viewer's own row's metadata.
 *
 * W9c: a link to a space on ANOTHER server is added against one of this
 * space's servers and signed in with a single-use pairing code that a member
 * of the target makes there (Grant access, below). Its row shows what this
 * node last saw when it tried to reach that server (`reachStatus`).
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { ServerView, SpaceLinkStatus, SpaceLinkView } from '@tm8/contract';
import { shortDate } from '../kit/time';
import { SectionAbsent, SectionFrame } from '../settings-space';
import { GrantAccess } from './GrantAccess';
import { InboundLinks } from './InboundLinks';
import type { SpaceLinkCandidate, SpaceLinksPort } from './port';
import '../settings-credentials/credentials.css';
import './space-links.css';

export interface SpaceLinksSectionProps {
  port: SpaceLinksPort;
  heading?: string;
  /** Opens a link's own panel (task 01a0e24d). Absent, no row offers it. */
  onOpen?: (linkId: string) => void;
}

/** The server's typed refusal for a non-human session (251). */
export const SPACE_LINKS_HUMAN_ONLY = 'space_links_human_only';

const STATUS_WORD: Record<SpaceLinkStatus, string> = {
  signed_in: 'Signed in',
  signed_out: 'Signed out',
  left: 'You left the target space',
  unreachable: 'Target unreachable',
};

/**
 * Plain words for the server's typed reasons. The server's own message can
 * name internal operations; a reason listed here never shows it.
 */
const REASON_WORDS: Record<string, string> = {
  space_link_pairing_required:
    'This link reaches a space on another server. Paste the pairing code a member of that space made there with Grant access.',
  space_link_pairing_refused:
    'The other server refused that pairing code. Codes are single use and expire after a few minutes: ask for a new one.',
  space_link_pairing_target_mismatch:
    'That pairing code was made for a different space than this link points to.',
  space_link_remote_disabled:
    'Links to spaces on other servers are turned off on this node. Its operator turns them on with TM8_REMOTE_SPACE_LINKS=on.',
  space_link_remote_unsupported:
    'The other server does not accept links from other servers. Its operator turns them on with TM8_REMOTE_SPACE_LINKS=on.',
  space_link_unreachable:
    'This node could not reach the other server. A LAN or Tailscale address needs TM8_REMOTE_SPACE_LINKS_ALLOW_PRIVATE=1 on this node, and every address needs HTTPS.',
  space_link_offline: 'The other server did not answer. It may be down; try again later.',
};

/** The words for a failed call. A `forbidden` always reads as a refusal. */
export function spaceLinkFailureOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const details = (err as { details?: Record<string, unknown> })?.details;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'forbidden' && details?.reason === SPACE_LINKS_HUMAN_ONLY) {
    return 'Refused: space links can only be changed by you in your browser or CLI, not by an agent.';
  }
  const known = typeof details?.reason === 'string' ? REASON_WORDS[details.reason] : undefined;
  if (known) return code === 'forbidden' ? `Refused: ${known}` : known;
  if (code === 'forbidden') return `Refused: ${message}`;
  return message;
}

function targetName(link: SpaceLinkView): string {
  return link.targetSpaceName ?? link.targetSpaceId;
}

/** What this node last saw of a remote link's server; null when there is nothing to warn about. */
const REACH_WORD: Partial<Record<ServerView['reachStatus'], string>> = {
  unreachable: 'Unreachable from this node',
  offline: 'Offline: it did not answer',
};

export function SpaceLinksSection({ port, heading = 'Space links', onOpen }: SpaceLinksSectionProps) {
  const [links, setLinks] = useState<SpaceLinkView[] | null>(null);
  const [candidates, setCandidates] = useState<SpaceLinkCandidate[]>([]);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLinks(await port.list());
    if (port.servers) setServers(await port.servers.list().catch(() => []));
  }, [port]);

  useEffect(() => {
    let live = true;
    void port.list().then(
      (next) => { if (live) { setLinks(next); setLoadError(null); } },
      (err: unknown) => { if (live) setLoadError(spaceLinkFailureOf(err)); },
    );
    // The picker is a convenience; a failed read leaves only the id field.
    void port.candidates().then((next) => { if (live) setCandidates(next); }, () => {});
    // Servers too: a failed read only hides the picker and the reach line.
    void port.servers?.list().then((next) => { if (live) setServers(next); }, () => {});
    return () => { live = false; };
  }, [port]);

  if (loadError) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Space links could not be read." why={loadError} testId="space-links-load-error" />
      </SectionFrame>
    );
  }

  const onChanged = async (message: string) => {
    setNotice(message);
    await reload().catch((err: unknown) => setLoadError(spaceLinkFailureOf(err)));
  };

  const linked = new Set((links ?? []).map((l) => l.targetSpaceId));
  const open = candidates.filter((c) => !linked.has(c.id));

  return (
    <SectionFrame title={heading}>
      <div className="set-spl" data-testid="space-links">
        <p className="set-spl__lede">
          Link this space to another space you are a member of, then sign in to it once. Each member signs in
          for themselves.
        </p>
        <div className="set-spl__warning" role="note" data-testid="space-links-warning">
          <p>
            Every member of this space can see that a link to the target space exists. Only you can use your
            own sign-in.
          </p>
          <p>
            Agents working for you in this space can act in the target space as you while you are signed in.
            Allow spawn lets agents working for you start, resume or dispatch sessions in the target space through this link. Turning it off stops new ones; sessions already running keep running.
          </p>
        </div>
        {notice ? (
          <div className="cred-notice" role="status" data-testid="space-links-notice">
            <span className="cred-notice__head">{notice}</span>
          </div>
        ) : null}
        {links === null ? <p className="set-spl__muted">Reading…</p> : null}
        {links !== null && links.length === 0 ? (
          <p className="set-spl__muted" data-testid="space-links-empty">This space has no links yet.</p>
        ) : null}
        {links !== null && links.length > 0 ? (
          <ul className="set-spl__list">
            {links.map((link) => (
              <LinkRow key={link.id} link={link} port={port} onChanged={onChanged} onOpen={onOpen}
                server={link.targetServerId ? servers.find((x) => x.id === link.targetServerId) : undefined} />
            ))}
          </ul>
        ) : null}
        <AddLink port={port} candidates={open} servers={servers} onChanged={onChanged} />
        {port.inbound?.grant ? <GrantAccess grant={port.inbound.grant} /> : null}
        {port.inbound ? <InboundLinks port={port.inbound} /> : null}
      </div>
    </SectionFrame>
  );
}

function LinkRow({
  link,
  port,
  onChanged,
  onOpen,
  server,
}: {
  link: SpaceLinkView;
  port: SpaceLinksPort;
  onChanged(message: string): Promise<void>;
  onOpen?: (linkId: string) => void;
  /** The target's server, for a link to another server (W9c). */
  server?: ServerView;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const name = targetName(link);
  const mine = link.mine;
  const signedIn = mine?.status === 'signed_in';
  const remote = link.targetServerId !== null;
  const reach = server ? REACH_WORD[server.reachStatus] : undefined;
  const pairingCode = code.trim();
  // A link to another server signs in with a pairing code; a local one never does.
  const signInWith = (relogin: boolean) => () => remote
    ? (relogin ? port.relogin(link.id, pairingCode) : port.login(link.id, pairingCode)).then((v) => { setCode(''); return v; })
    : (relogin ? port.relogin(link.id) : port.login(link.id));

  async function run(act: () => Promise<unknown>, done: string) {
    setBusy(true);
    setFailure(null);
    try {
      await act();
      await onChanged(done);
    } catch (err) {
      setFailure(spaceLinkFailureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="set-spl__row" data-testid={`space-link-${link.id}`}>
      <div className="set-spl__row-head">
        <span className="set-spl__name">{name}</span>
        <span className="set-spl__status" data-testid={`space-link-status-${link.id}`}>
          {mine ? STATUS_WORD[mine.status] : 'You have not signed in'}
        </span>
        {onOpen ? (
          <button type="button" className="cred-action" data-testid={`space-link-open-${link.id}`}
            aria-label={`Open ${name}`} onClick={() => onOpen(link.id)}>Open</button>
        ) : null}
      </div>
      {remote ? (
        <p className="set-spl__muted" data-testid={`space-link-server-${link.id}`}>
          On {server ? `${server.name} (${server.baseUrl})` : 'another server'}
          {reach ? (
            <>
              {' · '}
              <span className="set-spl__unreachable" data-testid={`space-link-reach-${link.id}`}>{reach}</span>
              {server?.reachCheckedAt ? ` (checked ${shortDate(server.reachCheckedAt)})` : ''}
            </>
          ) : null}
          {server && port.servers ? (
            <>
              {' '}
              <button type="button" className="cred-action" aria-label={`Check ${server.name} is reachable`} disabled={busy}
                onClick={() => void run(async () => {
                  const probe = await port.servers!.probe(server.id);
                  if (probe.outcome !== 'response') {
                    throw Object.assign(new Error(`${server.name} is ${probe.outcome} from this node${probe.reason ? ` (${probe.reason})` : ''}.`),
                      { details: { reason: probe.outcome === 'offline' ? 'space_link_offline' : 'space_link_unreachable' } });
                  }
                }, `${server.name} is reachable from this node.`)}>
                Check
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {link.targetRevokedAt ? (
        <p className="set-spl__fail" data-testid={`space-link-revoked-${link.id}`}>
          An admin of {name} revoked this link {shortDate(link.targetRevokedAt)}. Signing in is refused until they restore it.
        </p>
      ) : null}
      <p className="set-spl__muted">
        {link.statusSummary.signedIn} of this space&apos;s members signed in
        {mine?.expiresAt ? ` · your sign-in expires ${shortDate(mine.expiresAt)}` : ''}
      </p>
      <div className="set-spl__actions">
        {remote ? (
          <input className="set-spl__input" aria-label={`Pairing code for ${name}`} placeholder="Pairing code from the other server"
            value={code} disabled={busy} autoComplete="off" spellCheck={false}
            onChange={(e) => setCode(e.currentTarget.value)} data-testid={`space-link-code-${link.id}`} />
        ) : null}
        {signedIn ? (
          <>
            <button type="button" className="cred-action" aria-label={`Sign in again to ${name}`} disabled={busy || (remote && !pairingCode)}
              onClick={() => void run(signInWith(true), `Signed in to ${name} again.`)}>
              Sign in again
            </button>
            <button type="button" className="cred-action" aria-label={`Sign out of ${name}`} disabled={busy}
              onClick={() => void run(() => port.logout(link.id), `Signed out of ${name}.`)}>
              Sign out
            </button>
          </>
        ) : (
          <button type="button" className="cred-action cred-action--primary" aria-label={`Sign in to ${name}`} disabled={busy || (remote && !pairingCode)}
            onClick={() => void run(signInWith(false), `Signed in to ${name}.`)}>
            Sign in
          </button>
        )}
        {mine ? (
          <>
            <label className="set-spl__spawn">
              <input
                type="checkbox"
                aria-label={`Allow spawn in ${name}`}
                aria-describedby={`set-spl-spawn-help-${link.id}`}
                checked={mine.allowSpawn}
                disabled={busy}
                onChange={(e) => {
                  const next = e.currentTarget.checked;
                  void run(
                    () => port.setSpawn(link.id, next),
                    next
                      ? `Allow spawn is on for ${name}. Allow spawn lets agents working for you start, resume or dispatch sessions in the target space through this link. Turning it off stops new ones; sessions already running keep running.`
                      : `Allow spawn is off for ${name}. Allow spawn lets agents working for you start, resume or dispatch sessions in the target space through this link. Turning it off stops new ones; sessions already running keep running.`,
                  );
                }}
              />
              Allow spawn
              <span className="set-spl__spawn-help" id={`set-spl-spawn-help-${link.id}`} data-testid="space-links-spawn-help">
                Allow spawn lets agents working for you start, resume or dispatch sessions in the target space through this link. Turning it off stops new ones; sessions already running keep running.
              </span>
            </label>
            <button type="button" className="cred-action" aria-label={`Remove ${name}`} disabled={busy}
              onClick={() => void run(() => port.remove(link.id), `Removed your sign-in row for ${name}. The link stays for other members.`)}>
              Remove
            </button>
          </>
        ) : null}
      </div>
      {failure ? (
        <p className="set-spl__fail" role="alert" data-testid={`space-link-failure-${link.id}`}>{failure}</p>
      ) : null}
    </li>
  );
}

function AddLink({
  port,
  candidates,
  servers,
  onChanged,
}: {
  port: SpaceLinksPort;
  candidates: SpaceLinkCandidate[];
  /** This space's other servers; empty hides the picker (only same-server links). */
  servers: ServerView[];
  onChanged(message: string): Promise<void>;
}) {
  const [target, setTarget] = useState('');
  /** '' = a space on this server. */
  const [serverId, setServerId] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const targetSpaceId = target.trim();
    if (!targetSpaceId) return;
    setBusy(true);
    setFailure(null);
    try {
      const link = serverId ? await port.add(targetSpaceId, serverId) : await port.add(targetSpaceId);
      setTarget('');
      await onChanged(serverId
        ? `Linked ${targetName(link)}. To sign in, a member of that space makes a pairing code on the other server (Space links → Grant access there, for this space's id), then you paste it here.`
        : `Linked ${targetName(link)}. Sign in to use it.`);
    } catch (err) {
      setFailure(spaceLinkFailureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="set-spl__add" onSubmit={(e) => void submit(e)} data-testid="space-links-add">
      {servers.length > 0 ? (
        <select className="set-spl__input" aria-label="Server the space is on" value={serverId} disabled={busy}
          onChange={(e) => { setServerId(e.currentTarget.value); setTarget(''); }}>
          <option value="">On this server</option>
          {servers.map((x) => <option key={x.id} value={x.id}>On {x.name} ({x.baseUrl})</option>)}
        </select>
      ) : null}
      {candidates.length > 0 && !serverId ? (
        <select className="set-spl__input" aria-label="Space to link" value={target} disabled={busy}
          onChange={(e) => setTarget(e.currentTarget.value)}>
          <option value="">Choose one of your spaces…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      ) : null}
      <input className="set-spl__input" aria-label="Target space id"
        placeholder={serverId ? 'the space id on that server' : 'or paste a space id'}
        value={target} disabled={busy} onChange={(e) => setTarget(e.currentTarget.value)} />
      <button type="submit" className="cred-action cred-action--primary" aria-label="Add link" disabled={busy || !target.trim()}>
        Add link
      </button>
      {failure ? <p className="set-spl__fail" role="alert" data-testid="space-links-add-failure">{failure}</p> : null}
    </form>
  );
}
