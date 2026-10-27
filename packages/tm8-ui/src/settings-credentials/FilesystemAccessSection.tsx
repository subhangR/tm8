/**
 * Settings → Filesystem access (migration 282, design doc 01a0fb62 §4.3).
 *
 * A node admin grants ONE member ONE folder root: the member may then browse
 * under it and pick a project folder from it. Nothing reads files through a
 * grant. Node admins hold every root already, so they are not offered as
 * grantees.
 *
 * - A node admin sees every grant, grants (member + folder from their own
 *   browser + note), revokes, and can re-open a revoked grant.
 * - Everyone else sees the folders granted to them, or how to get one.
 *
 * The server enforces all of it (node admin on an unpinned session, and the
 * folder realpath'd inside TM8_PROJECT_ROOTS); a refusal it answers is shown
 * as one.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  NodeAccountView,
  PathGrantView,
  ProjectDirectoryListing,
} from '@tm8/contract';

import { SectionAbsent, SectionFrame } from '../settings-space';
import type { FilesystemAccessPort } from './filesystem-access-port';
import { failureOf, type SpaceCredentialFailure } from './space-credentials-model';
import '../projects/projects.css';
import './credentials.css';
import './space-credentials.css';

export const NO_GRANT_TEXT =
  'No folder on this node is granted to you. Ask a node admin to grant you a folder path here (Settings → Filesystem access).';

export const BROWSE_IN_SPACE_TEXT =
  'From inside a space, folder browsing only shows folders granted to you, and node admin rights do not apply. Type the folder path instead, or use tm8 node path-grant add.';

export interface FilesystemAccessSectionProps {
  port: FilesystemAccessPort | null;
  heading?: string;
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

function who(account: NodeAccountView | undefined, fallback: string): string {
  if (!account) return fallback;
  return account.displayName ? `${account.displayName} (${account.username})` : account.username;
}

export function FilesystemAccessSection({ port, heading = 'Filesystem access' }: FilesystemAccessSectionProps) {
  const [admin, setAdmin] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!port) return undefined;
    let live = true;
    void port.viewer().then(
      (v) => { if (live) setAdmin(v.isNodeAdmin); },
      (err: unknown) => { if (live) setLoadError(failureOf(err).text); },
    );
    return () => { live = false; };
  }, [port]);

  if (!port) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent
          head="Filesystem access is not available here."
          why="This view has no tm8 node behind it to grant folders on."
          testId="fs-access-absent"
        />
      </SectionFrame>
    );
  }
  if (loadError) {
    return (
      <SectionFrame title={heading}>
        <SectionAbsent head="Filesystem access could not be read." why={loadError} testId="fs-access-load-error" />
      </SectionFrame>
    );
  }

  return (
    <SectionFrame title={heading}>
      <div className="set-spc" data-testid="fs-access">
        <p className="set-spc__lede">
          Which folders on this node a member may browse and pick a project from. A grant lets them look
          under that folder and select one; it never shows them what is inside a file. Node admins can
          already browse every folder.
        </p>
        {admin === null ? null : admin ? <AdminGrants port={port} /> : <MyGrants port={port} />}
      </div>
    </SectionFrame>
  );
}

function MyGrants({ port }: { port: FilesystemAccessPort }) {
  const [grants, setGrants] = useState<PathGrantView[] | null>(null);
  const [failure, setFailure] = useState<SpaceCredentialFailure | null>(null);

  useEffect(() => {
    let live = true;
    void port.mine().then(
      (view) => { if (live) setGrants(view.grants); },
      (err: unknown) => { if (live) setFailure(failureOf(err)); },
    );
    return () => { live = false; };
  }, [port]);

  if (failure) {
    return <p className={`set-spc__fail set-spc__fail--${failure.kind}`} role="alert">{failure.text}</p>;
  }
  if (grants === null) return null;
  if (grants.length === 0) {
    return <p className="set-spc__muted" data-testid="fs-access-none">{NO_GRANT_TEXT}</p>;
  }
  return (
    <div className="set-spc__group">
      <div className="set-spc__group-title">Folders granted to you</div>
      <ul className="set-spc__list" data-testid="fs-access-mine">
        {grants.map((g) => (
          <li className="set-spc__row" key={g.id}>
            <div className="set-spc__row-head">
              <span className="set-spc__label">{g.rootPath}</span>
            </div>
            <div className="set-spc__meta">
              <span>granted {day(g.grantedAt)}</span>
              {g.note ? <span>{g.note}</span> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AdminGrants({ port }: { port: FilesystemAccessPort }) {
  const [grants, setGrants] = useState<PathGrantView[] | null>(null);
  const [accounts, setAccounts] = useState<NodeAccountView[]>([]);
  const [showRevoked, setShowRevoked] = useState(false);
  const [failure, setFailure] = useState<SpaceCredentialFailure | null>(null);

  const reload = useCallback(async () => {
    try {
      const view = await port.list(showRevoked);
      setGrants(view.grants);
    } catch (err) {
      setFailure(failureOf(err));
    }
  }, [port, showRevoked]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    let live = true;
    void port.accounts().then(
      (view) => { if (live) setAccounts(view.accounts); },
      (err: unknown) => { if (live) setFailure(failureOf(err)); },
    );
    return () => { live = false; };
  }, [port]);

  /** True when the write landed, so the form only clears on success. */
  const act = async (run: () => Promise<unknown>): Promise<boolean> => {
    setFailure(null);
    try {
      await run();
    } catch (err) {
      setFailure(failureOf(err));
      return false;
    }
    await reload();
    return true;
  };

  return (
    <>
      <GrantForm
        port={port}
        accounts={accounts.filter((a) => a.status === 'active' && a.isNodeAdmin !== true)}
        onGrant={(accountId, rootPath, note) => act(() => port.create(accountId, rootPath, note))}
      />
      {failure ? (
        <p className={`set-spc__fail set-spc__fail--${failure.kind}`} role="alert" data-testid={`fs-access-failure-${failure.kind}`}>
          {failure.text}
        </p>
      ) : null}
      <div className="set-spc__group">
        <div className="set-spc__group-title">Grants on this node</div>
        <label className="set-spc__toggle">
          <input type="checkbox" checked={showRevoked} onChange={(e) => setShowRevoked(e.target.checked)} />
          Show revoked grants
        </label>
        {grants !== null && grants.length === 0 ? (
          <p className="set-spc__muted" data-testid="fs-access-empty">No member holds a folder grant yet.</p>
        ) : null}
        <ul className="set-spc__list" data-testid="fs-access-grants">
          {(grants ?? []).map((g) => (
            <li className="set-spc__row" key={g.id} data-testid={`fs-access-grant-${g.id}`}>
              <div className="set-spc__row-head">
                <span className="set-spc__label">{who(g.grantee, g.accountId)}</span>
                <span className={`set-spc__badge ${g.revokedAt ? 'set-spc__badge--stale' : 'set-spc__badge--active'}`}>
                  {g.revokedAt ? `revoked ${day(g.revokedAt)}` : `granted ${day(g.grantedAt)}`}
                </span>
              </div>
              <div className="set-spc__meta">
                <span>{g.rootPath}</span>
                {g.note ? <span>{g.note}</span> : null}
                {g.grantedBy ? <span>by {g.grantedBy.username}</span> : null}
              </div>
              <div className="set-spc__actions">
                {g.revokedAt ? (
                  <button type="button" className="cred-action" onClick={() => void act(() => port.create(g.accountId, g.rootPath, g.note))}>
                    Grant again
                  </button>
                ) : (
                  <button type="button" className="cred-action set-spc__danger" onClick={() => void act(() => port.revoke(g.id))}>
                    Revoke
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function GrantForm({
  port,
  accounts,
  onGrant,
}: {
  port: FilesystemAccessPort;
  accounts: NodeAccountView[];
  onGrant(accountId: string, rootPath: string, note?: string): Promise<boolean>;
}) {
  const [accountId, setAccountId] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [listing, setListing] = useState<ProjectDirectoryListing | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);

  const browse = async (path?: string) => {
    if (!port.browse) return;
    setBrowseError(null);
    try {
      setListing(await port.browse(path));
    } catch (err) {
      // Inside a space the browser rides the space's session, which never
      // holds node admin (K6), so the server answers with the MEMBER's
      // grants. Say that, rather than "no folder is granted to you".
      const reason = (err as { details?: { reason?: unknown } })?.details?.reason;
      setBrowseError(reason === 'path_grant_required' ? BROWSE_IN_SPACE_TEXT : failureOf(err).text);
    }
  };

  const submit = async () => {
    if (!accountId || !rootPath.trim()) return;
    setBusy(true);
    try {
      if (await onGrant(accountId, rootPath.trim(), note.trim() || undefined)) {
        setRootPath('');
        setNote('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-spc__add" data-testid="fs-access-form">
      <div className="set-spc__group-title">Grant a folder</div>
      {accounts.length === 0 ? (
        <p className="set-spc__muted">Every account on this node is a node admin, so there is nobody to grant a folder to.</p>
      ) : null}
      <div className="set-spc__form">
        <select className="set-spc__input" aria-label="Member" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
          <option value="">Choose a member…</option>
          {accounts.map((a) => (
            <option key={a.accountId} value={a.accountId}>{who(a, a.accountId)}</option>
          ))}
        </select>
        <input
          className="set-spc__input"
          aria-label="Folder"
          placeholder="/srv/repos"
          value={rootPath}
          onChange={(e) => setRootPath(e.target.value)}
        />
        {port.browse ? (
          <button type="button" className="cred-action" onClick={() => void browse(rootPath.trim() || undefined)}>Browse…</button>
        ) : null}
      </div>
      <div className="set-spc__form">
        <input
          className="set-spc__input"
          aria-label="Note"
          placeholder="Why (optional)"
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="cred-action cred-action--primary"
          disabled={busy || !accountId || !rootPath.trim()}
          onClick={() => void submit()}
        >
          Grant
        </button>
      </div>
      {browseError ? <p className="set-spc__fail set-spc__fail--failed" role="alert">{browseError}</p> : null}
      {listing ? (
        <div className="project-browser" data-testid="fs-access-browser">
          <div className="project-browser__roots" aria-label="Allowed roots">
            {listing.roots.map((root) => (
              <button type="button" key={root} onClick={() => void browse(root)}>{root}</button>
            ))}
          </div>
          <div className="project-browser__path" title={listing.path}>{listing.path}</div>
          <div className="project-browser__actions">
            <button
              type="button"
              className="cred-action cred-action--primary"
              onClick={() => { setRootPath(listing.path); setListing(null); }}
            >
              Use this folder
            </button>
            {listing.parentPath ? (
              <button type="button" className="cred-action" onClick={() => void browse(listing.parentPath!)}>↑ Parent</button>
            ) : null}
            <button type="button" className="cred-action" onClick={() => setListing(null)}>Close</button>
          </div>
          <ul className="project-browser__list" aria-label="Folders">
            {listing.directories.map((directory) => (
              <li key={directory.path}>
                <button type="button" onClick={() => void browse(directory.path)}>
                  <span aria-hidden="true">▱</span> {directory.name}
                </button>
              </li>
            ))}
            {listing.directories.length === 0 ? <li className="project-browser__empty">No child folders</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
