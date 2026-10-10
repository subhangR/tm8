import { useEffect, useState } from 'react';
import type { IdentityView } from '../data/seam';
import { ownerRoleRef } from './port';
import { SettingsShell } from './SettingsShell';
import type { SettingsShellProps, SettingsSectionId } from './types';

export const SPACE_ADMIN_SECTIONS: readonly SettingsSectionId[] = [
  'profile', 'members', 'invites', 'sessions', 'sharing', 'axes', 'workflows',
  'chat-defaults', 'space-credentials', 'space-links', 'projects', 'menu', 'kinds', 'configs', 'danger',
];

/** Resolve authorization before any privileged section (including injected content) mounts. */
export function SpaceAdminPage(props: SettingsShellProps & { identity?: IdentityView | null }) {
  const { port, identity: hostIdentity } = props;
  const [revision, setRevision] = useState(0);
  const [access, setAccess] = useState<{ port: SettingsShellProps['port']; hostIdentity: typeof hostIdentity; revision: number; allowed: boolean; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([port.loadSpace(), port.loadIdentity()]).then(([space, identity]) => {
      if (!live) return;
      const hasMembership = (viewer: IdentityView | null) => !!space && !!viewer?.memberships.some((membership) =>
        membership.spaceId === space.id && (membership.role === ownerRoleRef() || membership.role === 'admin'));
      const allowed = hasMembership(identity) && (hostIdentity === undefined || hasMembership(hostIdentity));
      setAccess({ port, hostIdentity, revision, allowed });
    }, (error: unknown) => {
      if (live) setAccess({ port, hostIdentity, revision, allowed: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { live = false; };
  }, [port, hostIdentity, revision]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);

  if (!access || access.port !== port || access.hostIdentity !== hostIdentity || access.revision !== revision) return <div role="status">Checking space admin access…</div>;
  if (!access.allowed) return <div><p role="alert">{access.error ?? 'Space admin access requires an owner or admin membership in this space.'}</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Retry access check</button></div>;
  return <section className="set-space-admin" aria-label="Space admin" data-framed={props.framed || undefined}>{props.framed ? null : <h1>Space admin</h1>}
    <SettingsShell {...props} sectionIds={SPACE_ADMIN_SECTIONS} initialSection={props.initialSection ?? 'profile'} />
  </section>;
}
