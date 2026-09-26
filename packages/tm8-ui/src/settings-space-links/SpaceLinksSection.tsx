/**
 * Settings → Space links (W6). A link from this space to another space the
 * viewer is also a member of. Each member signs in for themselves; the server
 * stores that member's own session for the target and nobody else can use it.
 *
 * WHAT A MEMBER MUST BE TOLD (P8), drawn above everything else: the link itself
 * is shared, so every member of this space can see that a link to the target
 * exists; and while you are signed in, agents working for you in this space can
 * act in the target space as you. Allow spawn decides whether they may also
 * start sessions there.
 *
 * Every write is human-only on the server. A refusal it answers (an agent
 * session, a target you are not a member of, anything else) is rendered as a
 * refusal on the row it came from, and no success notice is shown for it.
 *
 * No secret is drawn: the list carries only the viewer's own row's metadata.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { SpaceLinkStatus, SpaceLinkView } from '@tm8/contract';
import { SectionAbsent, SectionFrame } from '../settings-space';
import type { SpaceLinkCandidate, SpaceLinksPort } from './port';
import '../settings-credentials/credentials.css';
import './space-links.css';

export interface SpaceLinksSectionProps {
  port: SpaceLinksPort;
  heading?: string;
}

/** The server's typed refusal for a non-human session (244). */
export const SPACE_LINKS_HUMAN_ONLY = 'space_links_human_only';

const STATUS_WORD: Record<SpaceLinkStatus, string> = {
  signed_in: 'Signed in',
  signed_out: 'Signed out',
  left: 'You left the target space',
  unreachable: 'Target unreachable',
};

/** The words for a failed call. A `forbidden` always reads as a refusal. */
export function spaceLinkFailureOf(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  const details = (err as { details?: Record<string, unknown> })?.details;
  const message = err instanceof Error ? err.message : String(err);
  if (code === 'forbidden' && details?.reason === SPACE_LINKS_HUMAN_ONLY) {
    return 'Refused: space links can only be changed by you in your browser or CLI, not by an agent.';
  }
  if (code === 'forbidden') return `Refused: ${message}`;
  return message;
}

function targetName(link: SpaceLinkView): string {
  return link.targetSpaceName ?? link.targetSpaceId;
}

export function SpaceLinksSection({ port, heading = 'Space links' }: SpaceLinksSectionProps) {
  const [links, setLinks] = useState<SpaceLinkView[] | null>(null);
  const [candidates, setCandidates] = useState<SpaceLinkCandidate[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLinks(await port.list());
  }, [port]);

  useEffect(() => {
    let live = true;
    void port.list().then(
      (next) => { if (live) { setLinks(next); setLoadError(null); } },
      (err: unknown) => { if (live) setLoadError(spaceLinkFailureOf(err)); },
    );
    // The picker is a convenience; a failed read leaves only the id field.
    void port.candidates().then((next) => { if (live) setCandidates(next); }, () => {});
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
            While you are signed in, agents working for you in this space can act in the target space as you.
            Allow spawn controls whether they may also start sessions there.
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
              <LinkRow key={link.id} link={link} port={port} onChanged={onChanged} />
            ))}
          </ul>
        ) : null}
        <AddLink port={port} candidates={open} onChanged={onChanged} />
      </div>
    </SectionFrame>
  );
}

function LinkRow({
  link,
  port,
  onChanged,
}: {
  link: SpaceLinkView;
  port: SpaceLinksPort;
  onChanged(message: string): Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const name = targetName(link);
  const mine = link.mine;
  const signedIn = mine?.status === 'signed_in';

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
      </div>
      <p className="set-spl__muted">
        {link.statusSummary.signedIn} of this space&apos;s members signed in
        {mine?.expiresAt ? ` · your sign-in expires ${new Date(mine.expiresAt).toLocaleDateString()}` : ''}
      </p>
      <div className="set-spl__actions">
        {signedIn ? (
          <>
            <button type="button" className="cred-action" aria-label={`Sign in again to ${name}`} disabled={busy}
              onClick={() => void run(() => port.relogin(link.id), `Signed in to ${name} again.`)}>
              Sign in again
            </button>
            <button type="button" className="cred-action" aria-label={`Sign out of ${name}`} disabled={busy}
              onClick={() => void run(() => port.logout(link.id), `Signed out of ${name}.`)}>
              Sign out
            </button>
          </>
        ) : (
          <button type="button" className="cred-action cred-action--primary" aria-label={`Sign in to ${name}`} disabled={busy}
            onClick={() => void run(() => port.login(link.id), `Signed in to ${name}.`)}>
            Sign in
          </button>
        )}
        {mine ? (
          <>
            <label className="set-spl__spawn">
              <input
                type="checkbox"
                aria-label={`Allow spawn in ${name}`}
                checked={mine.allowSpawn}
                disabled={busy}
                onChange={(e) => {
                  const next = e.currentTarget.checked;
                  void run(
                    () => port.setSpawn(link.id, next),
                    next ? `Agents may start sessions in ${name}.` : `Agents may no longer start sessions in ${name}.`,
                  );
                }}
              />
              Allow spawn
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
  onChanged,
}: {
  port: SpaceLinksPort;
  candidates: SpaceLinkCandidate[];
  onChanged(message: string): Promise<void>;
}) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const targetSpaceId = target.trim();
    if (!targetSpaceId) return;
    setBusy(true);
    setFailure(null);
    try {
      const link = await port.add(targetSpaceId);
      setTarget('');
      await onChanged(`Linked ${targetName(link)}. Sign in to use it.`);
    } catch (err) {
      setFailure(spaceLinkFailureOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="set-spl__add" onSubmit={(e) => void submit(e)} data-testid="space-links-add">
      {candidates.length > 0 ? (
        <select className="set-spl__input" aria-label="Space to link" value={target} disabled={busy}
          onChange={(e) => setTarget(e.currentTarget.value)}>
          <option value="">Choose one of your spaces…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      ) : null}
      <input className="set-spl__input" aria-label="Target space id" placeholder="or paste a space id"
        value={target} disabled={busy} onChange={(e) => setTarget(e.currentTarget.value)} />
      <button type="submit" className="cred-action cred-action--primary" aria-label="Add link" disabled={busy || !target.trim()}>
        Add link
      </button>
      {failure ? <p className="set-spl__fail" role="alert" data-testid="space-links-add-failure">{failure}</p> : null}
    </form>
  );
}
