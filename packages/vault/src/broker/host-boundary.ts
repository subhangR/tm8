import { CONTAINER_SOCKETS, parseGroupFile } from '../relay/host-identity.js';
import { realHostProc, type HostProc } from './host-memory.js';

/**
 * Review F03, check B3 (design doc 01a1fe13, section 4): the broker's own uid is not in the docker
 * group, so nothing running as the broker can start a container that mounts the host. It also may
 * not connect to a container daemon's socket at its default path (docker, containerd, podman,
 * CRI-O, BuildKit), which goes beyond the design's B3: a socket can be opened by its mode, owner or
 * an ACL, without the group. The core-dump and swap half of B3 is protectHostMemory (review F05).
 *
 * Production refuses to start on a failure; the other modes log the same facts and run, as the
 * memory check does.
 *
 * Not covered: a docker group that only NSS knows (only the local /etc/group is read; design doc
 * N2), a daemon on another path or on TCP, and sudo or other root-equivalent grants. These are
 * point-in-time reads at start: the design asks for a periodic re-check (every 10 minutes, say)
 * that switches the vault to vault_unavailable on drift, and that is a follow-up.
 */
export type HostBoundaryFailure = 'group_file' | 'groups' | 'docker_group' | 'container_socket';

export interface HostBoundaryFacts {
  /** Whether this process is in a group /etc/group names docker. null: not known. */
  dockerGroup: boolean | null;
  /** The container daemon sockets this process may connect to. */
  containerSockets: string[];
}

export interface HostBoundaryCheck { facts: HostBoundaryFacts; failures: HostBoundaryFailure[] }

export class HostBoundaryError extends Error {
  constructor(readonly failures: readonly HostBoundaryFailure[]) {
    super(`vault broker: refused (host boundary: ${failures.join(', ')})`);
    this.name = 'HostBoundaryError';
  }
}

export function checkHostBoundary(proc: HostProc = realHostProc): HostBoundaryCheck {
  const failures: HostBoundaryFailure[] = [];
  const text = proc.read('/etc/group');
  const groups = text === null ? null : parseGroupFile(text);
  if (groups === null) failures.push('group_file');
  const own = proc.groups();
  if (own === null) failures.push('groups');
  let dockerGroup: boolean | null = null;
  if (groups !== null && own !== null) {
    dockerGroup = groups.some((group) => group.name === 'docker' && own.includes(group.gid));
    if (dockerGroup) failures.push('docker_group');
  }
  const containerSockets = CONTAINER_SOCKETS.filter((socket) => proc.canWrite(socket));
  if (containerSockets.length > 0) failures.push('container_socket');
  return { facts: { dockerGroup, containerSockets }, failures };
}
