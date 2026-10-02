/**
 * Sessions (W4) — `auth.sessions.list` / `auth.sessions.revoke`.
 *
 * ONE COMPONENT, TWO SCOPES, because the server answers both from one op:
 *
 *   own    — "Your sessions": every live session of the signed-in person,
 *            wherever it is pinned. Beside "Your profile", the account half
 *            of settings.
 *   space  — "Sessions": the sessions pinned to THIS space, anyone's. Space
 *            admins only; for anyone else the server refuses and this section
 *            draws the refusal, not an empty table.
 *
 * Revoke is live: the row's socket closes server-side, and revoking a gate
 * login also kills the pinned sessions entered from it — the list is re-read
 * after every revoke rather than patched, so what is drawn is what is left.
 *
 * Revoke takes TWO clicks: the first arms the row ("confirm revoke"), the
 * second calls the server. Only signing in again undoes a revoke, so a stray
 * click must not be enough.
 *
 * REVOKING THIS BROWSER'S OWN SESSION is a sign-out, not a list edit. When the
 * revoke ends the `current` row — itself, or by cascade from its gate login —
 * the pass this tab holds is dead: a re-read would 401 and the socket would
 * keep reconnecting with it. So the section hands over to `signOutHere`, the
 * host's sign-out path, which clears the stored pass and drops the viewer to
 * the gate, and does not re-read.
 *
 * No token is ever in this data. Rows carry ids only.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AuthSessionListing, AuthSessionOrigin, AuthSessionsListResult, AuthSessionsRevokeResult } from '@tm8/contract';
import { SectionAbsent, SectionFrame } from './SectionFrame';
import './sessions-section.css';

export type SessionsScope = 'own' | 'space';

export interface SessionsSectionProps {
  heading: string;
  scope: SessionsScope;
  load?: () => Promise<AuthSessionsListResult>;
  revoke?: (sessionId: string) => Promise<AuthSessionsRevokeResult>;
  /** The host's sign-out. Run instead of the re-read when a revoke ends this browser's session. */
  signOutHere?: () => void;
}

const ORIGIN_LABEL: Record<AuthSessionOrigin, string> = {
  login: 'sign-in',
  space_enter: 'entered space',
  spawn: 'agent spawn',
  chat: 'agent chat',
  link: 'stored link',
};

/** Minute precision, UTC, locale-free — the same string on every reader. */
export function sessionTime(iso: string | null): string {
  if (!iso) return 'never';
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** The label column: 'stored in <space>' for a link session (W6), else its own label. */
export function sessionLabel(row: AuthSessionListing): string {
  if (row.origin === 'link' && row.spaceName) return `stored in ${row.spaceName}`;
  return row.label ?? '—';
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SessionsSection({ heading, scope, load, revoke, signOutHere }: SessionsSectionProps) {
  const [rows, setRows] = useState<readonly AuthSessionListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const read = useCallback(async () => {
    if (!load) return;
    try {
      setRows((await load()).sessions);
      setError(null);
    } catch (err) {
      setRows(null);
      setError(message(err));
    }
  }, [load]);

  useEffect(() => {
    setRows(null);
    setError(null);
    let live = true;
    if (load) {
      load().then(
        (next) => { if (live) setRows(next.sessions); },
        (err: unknown) => { if (live) setError(message(err)); },
      );
    }
    return () => { live = false; };
  }, [load]);

  const onRevoke = async (sessionId: string) => {
    if (!revoke) return;
    const current = rows?.find((row) => row.current)?.sessionId ?? null;
    setConfirming(null);
    setPending(sessionId);
    setRevokeError(null);
    try {
      const result = await revoke(sessionId);
      if (signOutHere && current !== null
          && (sessionId === current || result.revokedSessionIds.includes(current))) {
        signOutHere();
        return;
      }
      await read();
    } catch (err) {
      setRevokeError(message(err));
    } finally {
      setPending(null);
    }
  };

  if (!load) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Sessions are not wired on this surface." why="this settings host passed no sessions reader" />
      </SectionFrame>
    );
  }
  if (error) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent
          head={scope === 'space' ? 'This space’s sessions could not be read.' : 'Your sessions could not be read.'}
          why={error}
        />
      </SectionFrame>
    );
  }
  if (!rows) {
    return (
      <SectionFrame title={heading}>
        <p className="set-sessions__note">Reading sessions…</p>
      </SectionFrame>
    );
  }

  return (
    <SectionFrame title={heading} measure={false} pad={false} bodyTestId={`sessions-${scope}-body`}>
      <div className="set-sessions">
        <p className="set-sessions__lede">
          {scope === 'space'
            ? 'Every live session pinned to this space, whoever holds it. Revoking one signs it out at once and closes its open connections.'
            : 'Every place you are signed in. Revoking a sign-in also ends the space sessions entered from it.'}
        </p>
        {revokeError ? (
          <p className="set-sessions__error" role="alert" data-testid="sessions-revoke-error">{revokeError}</p>
        ) : null}
        {rows.length === 0 ? (
          <p className="set-sessions__note" data-testid="sessions-empty">
            {scope === 'space' ? 'No live sessions are pinned to this space.' : 'No live sessions.'}
          </p>
        ) : (
          <table className="set-sessions__table">
            <thead>
              <tr>
                {scope === 'space' ? <th scope="col">Who</th> : null}
                <th scope="col">Kind</th>
                <th scope="col">Created</th>
                <th scope="col">Last used</th>
                <th scope="col">Label</th>
                <th scope="col">Origin</th>
                {scope === 'own' ? <th scope="col">Space</th> : null}
                <th scope="col"><span className="set-sessions__sr">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.sessionId} data-testid={`session-row-${row.sessionId}`}>
                  {scope === 'space' ? <td>{row.owner.displayName ?? row.owner.identityId}</td> : null}
                  <td>
                    {row.kind}
                    {row.current ? <span className="set-sessions__current"> · this browser</span> : null}
                  </td>
                  <td>{sessionTime(row.createdAt)}</td>
                  <td>{sessionTime(row.lastUsedAt)}</td>
                  <td>{sessionLabel(row)}</td>
                  <td>{ORIGIN_LABEL[row.origin]}</td>
                  {scope === 'own' ? <td>{row.spaceName ?? 'any space'}</td> : null}
                  <td className="set-sessions__act-cell">
                    {revoke ? (
                      <>
                        {confirming === row.sessionId ? (
                          <button
                            type="button"
                            className="set-sessions__act set-sessions__act--quiet"
                            data-testid={`session-revoke-cancel-${row.sessionId}`}
                            onClick={() => setConfirming(null)}
                          >
                            cancel
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={confirming === row.sessionId ? 'set-sessions__act set-sessions__act--armed' : 'set-sessions__act'}
                          data-testid={`session-revoke-${row.sessionId}`}
                          disabled={pending !== null}
                          onClick={() => {
                            if (confirming === row.sessionId) void onRevoke(row.sessionId);
                            else setConfirming(row.sessionId);
                          }}
                        >
                          {pending === row.sessionId
                            ? 'revoking…'
                            : confirming === row.sessionId
                              ? row.current ? 'confirm sign out' : 'confirm revoke'
                              : row.current ? 'sign out here' : 'revoke'}
                        </button>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </SectionFrame>
  );
}
