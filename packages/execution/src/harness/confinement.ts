/**
 * Reading a harness's declared confinement story — the positive replacement for
 * `if (launch.agentTool !== 'codex') return CONFINED`.
 *
 * A PURE FUNCTION, deliberately. The decision used to be four lines inside a
 * private async method that also probed a subprocess, logged, and threw, which
 * meant the only way to test "what does tm8 conclude for a harness it has never
 * seen?" was to stand up a spawn. Separating the DECLARED part — everything
 * decidable without running anything — from the MEASURED part makes the refusal
 * assertable directly, and leaves the probe exactly where it was.
 */
import type { Harness, SandboxProbeId } from './types.js';

export type DeclaredConfinement =
  /** Nothing to probe and nothing that can silently fail. */
  | { readonly kind: 'confined' }
  /**
   * The harness has not had its confinement measured. tm8 refuses rather than
   * assuming — the old code's answer here was CONFINED, which is the safe-
   * sounding answer on no evidence at all.
   */
  | { readonly kind: 'refuse'; readonly reason: string }
  /** Honestly unconfined. Proceeds, but is recorded and said out loud. */
  | { readonly kind: 'degraded'; readonly detail: string }
  /** Must be established by RUNNING the provider's own sandbox. */
  | { readonly kind: 'probe'; readonly probe: SandboxProbeId };

export function readConfinement(harness: Harness): DeclaredConfinement {
  const confinement = harness.capabilities.confinement;

  // Claude Code's permission modes are enforced inside the agent; the smoke
  // harness runs no arbitrary commands at all. Neither has an OS-level sandbox
  // tm8 drives through flags.
  if (confinement === 'enforced-in-agent' || confinement === 'no-command-execution') {
    return { kind: 'confined' };
  }

  if (confinement === 'unknown') {
    return {
      kind: 'refuse',
      reason:
        `agent tool '${harness.id}' does not declare a confinement story, so tm8 cannot say ` +
        `whether a launch would be confined. Refusing rather than assuming it would be. Give ` +
        `the harness a measured capabilities.confinement — 'enforced-in-agent', ` +
        `'no-command-execution', 'unconfined', or { probe } — before launching it.`,
    };
  }

  if (confinement === 'unconfined') {
    return {
      kind: 'degraded',
      detail: `agent tool '${harness.id}' declares no confinement mechanism`,
    };
  }

  return { kind: 'probe', probe: confinement.probe };
}
