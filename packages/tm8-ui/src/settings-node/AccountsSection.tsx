/**
 * Node admin → Accounts (migration 324, task 01a13574).
 *
 * Two ways to give a person access, from one place:
 *   1. CREATE THE ACCOUNT. No password is set; the server returns a ONE-TIME
 *      setup link (single use, expiring, stored only as a hash). The admin
 *      copies it and sends it; the person opens it, chooses a password and is
 *      signed in. Optionally the account goes straight into one space.
 *   2. SEND A SPACE INVITE LINK — the existing `spaces.invites.create` flow;
 *      the invitee creates their own account when they redeem it.
 *
 * Per account: reset password (new link, every session signed out), disable /
 * enable, grant / revoke node admin, add to a space. The server is the
 * authority for every guard (owner untouchable, last admin kept, not yourself);
 * the buttons hidden here only spare the admin a refusal they can predict.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  AdminSpaceRole,
  NodeAccountListView,
  NodeAccountSetupLink,
  NodeAccountView,
  SpaceId,
  SpaceSummary,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { SectionFrame } from '../settings-space/SectionFrame';
import { joinUrlFor } from '../settings-space/InviteFrames';

/** Everything the section does; the page builds it from the seam behind the node-admin guard. */
export interface AccountsPort {
  load(): Promise<NodeAccountListView>;
  /** Absent: this node has no account administration, and the list is read-only. */
  admin?: NonNullable<Seam['nodeAccounts']>;
  spaces?(): Promise<SpaceSummary[]>;
  createInvite?(spaceId: SpaceId, role: AdminSpaceRole): Promise<{ code: string }>;
  /** The signed-in admin, whose own row offers no reset or disable. */
  viewerAccountId?: string;
  /** Where the setup link is opened; production reads `window.location.origin`. */
  origin?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Hostnames that only resolve on the machine itself: a link built on one reaches nobody else. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

export function setupUrlFor(token: string, origin?: string): string {
  const base = origin ?? (typeof window === 'undefined' ? '' : window.location.origin);
  return `${base.replace(/\/$/, '')}/#setup=${encodeURIComponent(token)}`;
}

type Shared = { title: string; url: string; note: string };

export function AccountsSection({ port }: { port: AccountsPort }) {
  const [state, setState] = useState<{ value?: NodeAccountListView; error?: string }>({});
  const [spaces, setSpaces] = useState<SpaceSummary[]>([]);
  const [shared, setShared] = useState<Shared | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((r) => r + 1), []);

  useEffect(() => {
    let live = true;
    void port.load().then(
      (value) => live && setState({ value }),
      (error) => live && setState({ error: errorText(error) }),
    );
    return () => {
      live = false;
    };
  }, [port, revision]);

  useEffect(() => {
    let live = true;
    void port.spaces?.().then((rows) => live && setSpaces(rows), () => undefined);
    return () => {
      live = false;
    };
  }, [port]);

  const run = useCallback(
    async (act: () => Promise<unknown>) => {
      setBusy(true);
      setActionError(null);
      try {
        await act();
        reload();
      } catch (error) {
        setActionError(errorText(error));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const showLink = (title: string, link: NodeAccountSetupLink) =>
    setShared({
      title,
      url: setupUrlFor(link.setupToken, port.origin),
      note: `Works once. Expires ${new Date(link.expiresAt).toLocaleString()}. It is shown only now — copy it before leaving this page.`,
    });

  const admin = port.admin;
  return (
    <SectionFrame title="Accounts">
      <p>
        Accounts registered on this node.{' '}
        {admin
          ? 'Create an account and send the person its one-time setup link, or send a space invite link and let them create their own.'
          : <>To provision an account, use <code>tm8 node account create</code> from a node-admin CLI session.</>}
      </p>
      {shared ? <SharedLink shared={shared} onDismiss={() => setShared(null)} /> : null}
      {admin && port.origin && isLoopbackOrigin(port.origin) ? (
        <p role="note">
          Links made here point at {port.origin}, which only works on this machine. Set{' '}
          <code>TM8_PUBLIC_ORIGIN</code> on the server to the address people reach it at, or open this page at
          that address.
        </p>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {admin ? (
        <div className="node-admin__account-tools">
          <CreateAccountForm
            spaces={spaces}
            busy={busy}
            onCreate={(input) =>
              run(async () => {
                const created = await admin.create(input);
                showLink(`Setup link for ${created.account.username}`, created);
              })
            }
          />
          {port.createInvite ? (
            <InviteLinkForm
              spaces={spaces}
              busy={busy}
              onCreate={(spaceId, role) =>
                run(async () => {
                  const invite = await port.createInvite!(spaceId, role);
                  const name = spaces.find((s) => s.id === spaceId)?.name ?? 'the space';
                  setShared({
                    title: `Invite link to ${name}`,
                    url: joinUrlFor(invite.code, port.origin),
                    note: 'One use, valid for 7 days. The person opening it creates their own account and joins as ' + role + '.',
                  });
                })
              }
            />
          ) : null}
        </div>
      ) : null}
      {state.error ? (
        <p role="alert">Accounts could not be read: {state.error}</p>
      ) : !state.value ? (
        <p role="status">Reading accounts…</p>
      ) : !state.value.accounts.length ? (
        <p>No accounts found.</p>
      ) : (
        <ul className="node-admin__list">
          {state.value.accounts.map((account) => (
            <AccountRow
              key={account.accountId}
              account={account}
              admin={admin}
              self={account.accountId === port.viewerAccountId}
              spaces={spaces}
              busy={busy}
              run={run}
              onLink={showLink}
            />
          ))}
        </ul>
      )}
    </SectionFrame>
  );
}

function SharedLink({ shared, onDismiss }: { shared: Shared; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="node-admin__shared-link" aria-label={shared.title}>
      <h3>{shared.title}</h3>
      <input readOnly value={shared.url} aria-label="Link to share" onFocus={(e) => e.currentTarget.select()} />
      <p>{shared.note}</p>
      <button
        type="button"
        onClick={() => {
          // Clipboard access is refusable (permissions, insecure origin): the
          // field stays selectable either way.
          void navigator.clipboard?.writeText(shared.url).then(() => setCopied(true), () => undefined);
        }}
      >
        {copied ? 'Copied' : 'Copy link'}
      </button>
      <button type="button" onClick={onDismiss}>Done</button>
    </section>
  );
}

function SpaceRolePicker({
  spaces,
  spaceId,
  role,
  onSpace,
  onRole,
  optional,
}: {
  spaces: SpaceSummary[];
  spaceId: string;
  role: AdminSpaceRole;
  onSpace: (id: string) => void;
  onRole: (role: AdminSpaceRole) => void;
  optional?: boolean;
}) {
  return (
    <>
      <label>
        Space
        <select value={spaceId} onChange={(e) => onSpace(e.target.value)}>
          <option value="">{optional ? 'No space' : 'Choose a space'}</option>
          {spaces.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <label>
        Role
        <select value={role} disabled={!spaceId} onChange={(e) => onRole(e.target.value as AdminSpaceRole)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
      </label>
    </>
  );
}

function CreateAccountForm({
  spaces,
  busy,
  onCreate,
}: {
  spaces: SpaceSummary[];
  busy: boolean;
  onCreate: (input: Parameters<NonNullable<Seam['nodeAccounts']>['create']>[0]) => void;
}) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [nodeAdmin, setNodeAdmin] = useState(false);
  const [spaceId, setSpaceId] = useState('');
  const [role, setRole] = useState<AdminSpaceRole>('member');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const handle = username.trim();
    if (!handle) return;
    onCreate({
      username: handle,
      ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      ...(nodeAdmin ? { isNodeAdmin: true } : {}),
      ...(spaceId ? { spaceId, role } : {}),
    });
    setUsername('');
    setDisplayName('');
    setNodeAdmin(false);
  };
  return (
    <form className="node-admin__form" aria-label="Create account" onSubmit={submit}>
      <h3>Create account</h3>
      <label>
        Username
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" required />
      </label>
      <label>
        Display name
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="off" />
      </label>
      <label className="node-admin__check">
        <input type="checkbox" checked={nodeAdmin} onChange={(e) => setNodeAdmin(e.target.checked)} />
        Node admin
      </label>
      <SpaceRolePicker spaces={spaces} spaceId={spaceId} role={role} onSpace={setSpaceId} onRole={setRole} optional />
      <button type="submit" disabled={busy || !username.trim()}>Create and get setup link</button>
    </form>
  );
}

function InviteLinkForm({
  spaces,
  busy,
  onCreate,
}: {
  spaces: SpaceSummary[];
  busy: boolean;
  onCreate: (spaceId: SpaceId, role: AdminSpaceRole) => void;
}) {
  const [spaceId, setSpaceId] = useState('');
  const [role, setRole] = useState<AdminSpaceRole>('member');
  return (
    <form
      className="node-admin__form"
      aria-label="Send a space invite link"
      onSubmit={(e) => {
        e.preventDefault();
        if (spaceId) onCreate(spaceId, role);
      }}
    >
      <h3>Send a space invite link</h3>
      <SpaceRolePicker spaces={spaces} spaceId={spaceId} role={role} onSpace={setSpaceId} onRole={setRole} />
      <button type="submit" disabled={busy || !spaceId}>Create invite link</button>
    </form>
  );
}

function AccountRow({
  account,
  admin,
  self,
  spaces,
  busy,
  run,
  onLink,
}: {
  account: NodeAccountView;
  admin: AccountsPort['admin'];
  self: boolean;
  spaces: SpaceSummary[];
  busy: boolean;
  run: (act: () => Promise<unknown>) => Promise<void>;
  onLink: (title: string, link: NodeAccountSetupLink) => void;
}) {
  const [spaceId, setSpaceId] = useState('');
  const [role, setRole] = useState<AdminSpaceRole>('member');
  const [added, setAdded] = useState<string | null>(null);
  const name = account.displayName || account.username;
  const kind = account.isOwner ? 'Node owner' : account.isNodeAdmin ? 'Node admin' : 'Account';
  const setup =
    account.hasPassword === false
      ? account.setupExpiresAt
        ? ` · setup link pending (expires ${new Date(account.setupExpiresAt).toLocaleString()})`
        : ' · no password set and no live setup link'
      : '';
  const canChange = admin && !account.isOwner;
  return (
    <li>
      <strong>{name}</strong>
      <span>
        {account.username} · {account.status} · {kind}
        {self ? ' · you' : ''}
        {setup}
      </span>
      {canChange ? (
        <div className="node-admin__row-actions" role="group" aria-label={`Actions for ${account.username}`}>
          {!self ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`Reset ${account.username}'s password? Every session they have is signed out, and they need the new setup link to get back in.`)) return;
                void run(async () => onLink(`Password reset link for ${account.username}`, await admin.reset(account.accountId)));
              }}
            >
              {account.hasPassword === false ? 'New setup link' : 'Reset password'}
            </button>
          ) : null}
          {!self ? (
            account.status === 'active' ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  if (!window.confirm(`Disable ${account.username}? Every session is revoked and their running agents stop.`)) return;
                  void run(() => admin.disable(account.accountId));
                }}
              >
                Disable
              </button>
            ) : (
              <button type="button" disabled={busy} onClick={() => void run(() => admin.enable(account.accountId))}>
                Enable
              </button>
            )
          ) : null}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => admin.setNodeAdmin(account.accountId, !account.isNodeAdmin))}
          >
            {account.isNodeAdmin ? 'Revoke node admin' : 'Make node admin'}
          </button>
          {spaces.length ? (
            <form
              className="node-admin__inline-form"
              aria-label={`Add ${account.username} to a space`}
              onSubmit={(e) => {
                e.preventDefault();
                if (!spaceId) return;
                void run(async () => {
                  const result = await admin.addToSpace(account.accountId, spaceId, role);
                  const space = spaces.find((s) => s.id === spaceId)?.name ?? 'the space';
                  setAdded(result.created ? `Added to ${space} as ${result.role}.` : `Already in ${space} as ${result.role}.`);
                });
              }}
            >
              <SpaceRolePicker spaces={spaces} spaceId={spaceId} role={role} onSpace={setSpaceId} onRole={setRole} />
              <button type="submit" disabled={busy || !spaceId}>Add to space</button>
            </form>
          ) : null}
          {added ? <p role="status">{added}</p> : null}
        </div>
      ) : null}
    </li>
  );
}
