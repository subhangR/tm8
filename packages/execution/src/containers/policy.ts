// @tm8/execution — the isolation policy (§12.1), CHECKED AT CREATE.
//
// It answers one question: what is the WEAKEST isolation class this container
// may run at. The registry then refuses any provider below it.
//
// It is evaluated at create and RECORDED on the container, so a later read
// says what was actually decided rather than what today's policy would decide.
// A policy that changed under an existing container and silently reclassified
// it would make the recorded `isolation` a lie.

import type { ContainerIsolationClass, ContainerNetworkPreset, ContainerProfile } from '@tm8/contract';

export interface IsolationPolicyInput {
  profile: ContainerProfile;
  network: ContainerNetworkPreset;
  /** The project the container mounts, when it mounts one. */
  projectTrust?: 'trusted' | 'untrusted' | null;
  /** True when a session that will `runs_in` this container bypasses prompts. */
  bypassPermissions?: boolean;
  /** Docker Desktop's VM is a host boundary the Linux nodes do not have. */
  hostVmBoundary?: boolean;
}

export interface IsolationDecision {
  minimum: ContainerIsolationClass;
  /** Why — carried into the refusal message so a caller can act on it. */
  reason: string;
}

/**
 * §12.1's table, in order of severity. FIRST MATCH WINS, and the order is the
 * table's order, so a `browser` on an untrusted project resolves through the
 * browser row and not the shell row.
 */
export function requiredIsolation(input: IsolationPolicyInput): IsolationDecision {
  const { profile, network, projectTrust, bypassPermissions, hostVmBoundary } = input;

  // The sandbox is the only guardrail left when the agent has none.
  if (bypassPermissions) {
    return { minimum: 'gvisor', reason: 'a session with bypassPermissions runs_in this container' };
  }

  if (profile === 'dind') {
    // A nested daemon is root-equivalent without sysbox.
    return { minimum: 'microvm', reason: 'a nested docker daemon is root-equivalent' };
  }

  if (profile === 'browser' || profile === 'desktop') {
    // Browses the open web by definition (D3). On Docker Desktop the host
    // boundary is the Docker VM, which phase 1 accepts for `browser` on the
    // Mac only — with a visible "isolation: container (host VM)" chip.
    if (hostVmBoundary) {
      return { minimum: 'container', reason: `${profile} on a host-VM boundary (Docker Desktop)` };
    }
    return { minimum: 'gvisor', reason: `${profile} browses the open web by definition` };
  }

  if (profile === 'custom') {
    if (network === 'locked') {
      return { minimum: 'container', reason: 'custom image on a locked network' };
    }
    return { minimum: 'gvisor', reason: 'custom image with egress' };
  }

  // shell, android, ios.
  if (network === 'open' || projectTrust === 'untrusted') {
    return {
      minimum: 'gvisor',
      reason: projectTrust === 'untrusted'
        ? 'an untrusted project is mounted'
        : 'open egress with unreviewed code is the exfiltration case',
    };
  }

  return { minimum: 'container', reason: 'the trust a node session already grants this project' };
}
