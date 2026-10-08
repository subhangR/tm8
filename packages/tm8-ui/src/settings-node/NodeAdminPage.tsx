import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  NodeAccountListView,
  SpaceConfigsView,
  SpaceId,
} from '@tm8/contract';
import type { IdentityView, Seam } from '../data/seam';
import { NodeCredentialsSection } from '../settings-credentials/NodeCredentialsSection';
import { FilesystemAccessSection } from '../settings-credentials/FilesystemAccessSection';
import { filesystemAccessPortFromSeam } from '../settings-credentials/filesystem-access-port';
import { spaceCredentialsPortFromSeam } from '../settings-credentials/space-port';
import { SectionFrame } from '../settings-space/SectionFrame';
import { valueLabel } from '../settings-space/ConfigsSection';
import '../settings-space/settings.css';
import './node-admin.css';

export type NodeAdminSection =
  'credentials' | 'filesystem' | 'accounts' | 'configuration';
export interface NodeAdminPageProps {
  seam: Seam;
  spaceId: string;
  nodeName?: string;
  initialSection?: NodeAdminSection;
  identity?: IdentityView | null;
  onSectionChange?: (section: NodeAdminSection) => void;
}
const sections: Record<NodeAdminSection, string> = {
  credentials: 'Node credentials',
  filesystem: 'Filesystem access',
  accounts: 'Accounts',
  configuration: 'Configuration',
};
function sectionOf(value?: string): NodeAdminSection {
  return value && Object.prototype.hasOwnProperty.call(sections, value)
    ? (value as NodeAdminSection)
    : 'credentials';
}
export function canAdministerNode(
  identity: Pick<IdentityView, 'isNodeAdmin' | 'isOwner'>,
): boolean {
  return identity.isNodeAdmin === true || identity.isOwner === true;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function NodeAdminPage({
  seam,
  spaceId,
  nodeName,
  initialSection,
  onSectionChange,
  identity,
}: NodeAdminPageProps) {
  const [section, setSection] = useState(() => sectionOf(initialSection));
  const [revision, setRevision] = useState(0);
  const [gate, setGate] = useState<{
    seam: Seam;
    spaceId: string;
    revision: number;
    identity?: IdentityView | null;
    viewer?: IdentityView;
    allowed?: boolean;
    error?: string;
  }>();
  useEffect(() => setSection(sectionOf(initialSection)), [initialSection]);
  useEffect(() => {
    let live = true;
    const hostIdentity = identity;
    if (hostIdentity === null) return;
    void seam.identity().then(
      (identity) => {
        if (live)
          setGate({
            seam,
            spaceId,
            revision,
            identity: hostIdentity,
            viewer: identity,
            allowed:
              canAdministerNode(identity) &&
              (hostIdentity === undefined || canAdministerNode(hostIdentity)),
          });
      },
      (error) => {
        if (live)
          setGate({
            seam,
            spaceId,
            revision,
            identity,
            error: errorText(error),
          });
      },
    );
    return () => {
      live = false;
    };
  }, [seam, spaceId, revision, identity]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    // Recheck when returning to the page or reconnecting after missed changes.
    window.addEventListener('focus', refresh);
    const off = seam.onResync(refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      off();
    };
  }, [seam]);
  const current =
    gate?.seam === seam &&
    gate.spaceId === spaceId &&
    gate.revision === revision &&
    gate.identity === identity
      ? gate
      : undefined;
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return (
    <main className="node-admin" aria-label="Node admin">
      <header className="node-admin__header">
        <h1>Node admin</h1>
        {nodeName && <p>{nodeName}</p>}
      </header>
      {!current ? (
        <p role="status">Checking node access…</p>
      ) : current.error ? (
        <div role="alert">
          <p>Node access could not be checked: {current.error}</p>
          <button className="node-admin__access-action" onClick={retry}>
            Retry
          </button>
        </div>
      ) : !current.allowed ? (
        <div>
          <p role="alert">
            Node admin access is required. Only node admins and node owners can
            open this page.
          </p>
          <button className="node-admin__access-action" onClick={retry}>
            Check access again
          </button>
        </div>
      ) : (
        <>
          <nav
            className="node-admin__nav"
            aria-label="Node administration sections"
          >
            {(Object.keys(sections) as NodeAdminSection[]).map((id) => (
              <button
                key={id}
                aria-current={section === id ? 'page' : undefined}
                onClick={() => {
                  setSection(id);
                  onSectionChange?.(id);
                }}
              >
                {sections[id]}
              </button>
            ))}
          </nav>
          <div className="node-admin__toolbar">
            <button onClick={retry}>Refresh section</button>
          </div>
          <NodeContents
            key={`${revision}:${section}`}
            seam={seam}
            spaceId={spaceId}
            section={section}
            viewer={current.viewer!}
            onDenied={retry}
          />
        </>
      )}
    </main>
  );
}

function NodeContents({
  seam,
  spaceId,
  section,
  viewer,
  onDenied,
}: {
  seam: Seam;
  spaceId: string;
  section: NodeAdminSection;
  viewer: IdentityView;
  onDenied: () => void;
}) {
  // Each privileged operation checks the authoritative identity again. A changed
  // session cannot keep using controls drawn from the previous identity.
  const ports = useMemo(() => {
    const guard = async <T,>(read: () => Promise<T>): Promise<T> => {
      if (!canAdministerNode(await seam.identity())) {
        onDenied();
        throw new Error('Node admin access is required.');
      }
      return read();
    };
    const credentials = spaceCredentialsPortFromSeam(
      seam,
      spaceId as SpaceId,
      null,
    );
    const filesystem = filesystemAccessPortFromSeam(seam);
    return {
      credentials: {
        ...credentials,
        viewer: async () => ({
          accountId: viewer.accountId,
          isNodeAdmin: true,
          isSpaceAdmin: false,
          sharedServer: true,
        }),
        nodeStatus: () => guard(() => credentials.nodeStatus()),
        setNodePolicy: (
          ...args: Parameters<typeof credentials.setNodePolicy>
        ) => guard(() => credentials.setNodePolicy(...args)),
      },
      filesystem: filesystem && {
        ...filesystem,
        viewer: async () => ({ isNodeAdmin: true }),
        list: (...args: Parameters<typeof filesystem.list>) =>
          guard(() => filesystem.list(...args)),
        accounts: () => guard(() => filesystem.accounts()),
        create: (...args: Parameters<typeof filesystem.create>) =>
          guard(() => filesystem.create(...args)),
        revoke: (id: string) => guard(() => filesystem.revoke(id)),
        ...(filesystem.browse
          ? { browse: (path?: string) => guard(() => filesystem.browse!(path)) }
          : {}),
      },
      accounts: () =>
        guard(() =>
          seam.pathGrants
            ? seam.pathGrants.accounts()
            : Promise.reject(
                new Error('Accounts are not available on this node.'),
              ),
        ),
      configuration: () => guard(() => seam.spaceConfigs(spaceId as SpaceId)),
    };
  }, [seam, spaceId, viewer, onDenied]);
  if (section === 'credentials')
    return <NodeCredentialsSection port={ports.credentials} nodeOnly />;
  if (section === 'filesystem')
    return <FilesystemAccessSection port={ports.filesystem} />;
  if (section === 'accounts') return <Accounts load={ports.accounts} />;
  return <Configuration load={ports.configuration} />;
}

function useRead<T>(load: () => Promise<T>) {
  const [state, setState] = useState<{ value?: T; error?: string }>({});
  useEffect(() => {
    let live = true;
    void load().then(
      (value) => {
        if (live) setState({ value });
      },
      (error) => {
        if (live) setState({ error: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [load]);
  return state;
}
function Accounts({ load }: { load: () => Promise<NodeAccountListView> }) {
  const { value, error } = useRead(load);
  return (
    <SectionFrame title="Accounts">
      <p>
        Accounts registered on this node. To provision an account, use{' '}
        <code>tm8 auth signup</code> from a node-admin CLI session, then invite
        the person to a space.
      </p>
      {error ? (
        <p role="alert">Accounts could not be read: {error}</p>
      ) : !value ? (
        <p role="status">Reading accounts…</p>
      ) : !value.accounts.length ? (
        <p>No accounts found.</p>
      ) : (
        <ul className="node-admin__list">
          {value.accounts.map((account) => (
            <li key={account.accountId}>
              <strong>{account.displayName || account.username}</strong>
              <span>
                {account.username} · {account.status} ·{' '}
                {account.isNodeAdmin ? 'Node admin or owner' : 'Account'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </SectionFrame>
  );
}
function Configuration({ load }: { load: () => Promise<SpaceConfigsView> }) {
  const { value, error } = useRead(load);
  return (
    <SectionFrame title="Configuration">
      <p>
        Server environment and code constants. Environment changes take effect
        after restarting the server. Secret values are never displayed.
      </p>
      {error ? (
        <p role="alert">Configuration could not be read: {error}</p>
      ) : !value ? (
        <p role="status">Reading configuration…</p>
      ) : (
        <>
          {!value.node.visible && <p role="alert">{value.node.reason}</p>}
          {[
            {
              title: 'Node environment',
              knobs: value.node.visible ? value.node.knobs : [],
            },
            { title: 'Code constants', knobs: value.code },
          ].map(({ title, knobs }) => (
            <section key={title}>
              <h3>{title}</h3>
              <ul className="node-admin__list">
                {knobs.map((knob) => (
                  <li key={knob.name}>
                    <strong>{knob.name}</strong>
                    <code>{valueLabel(knob.value)}</code>
                    <p>{knob.summary}</p>
                    <span>
                      Source: {knob.source}
                      {knob.default !== null
                        ? ` · Default: ${knob.default}`
                        : ''}
                    </span>
                    <span>
                      {knob.change === 'env'
                        ? `Set ${knob.name} in the server environment and restart.`
                        : 'Requires a code change.'}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </SectionFrame>
  );
}
