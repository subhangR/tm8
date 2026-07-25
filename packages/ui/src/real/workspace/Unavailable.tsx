/**
 * Shared honest-degradation primitives for the workspace lanes (blueprint §4/§5-C).
 *
 * STUB landed by Vega to unblock Lanes A/B — Draco (Lane C) OWNS this file and
 * fills it out. Contract: thin wrappers over real/capabilities.ts so screens
 * caption unbuilt reads and disable unbuilt writes instead of hiding or throwing.
 */
import type { ReactNode } from 'react';
import { hollowReason, isHollow, isUnavailable } from '../capabilities';

/** Caption for a read that isn't built on this node. Renders nothing when the method is real. */
export function Unavailable({ method, children }: { method: string; children?: ReactNode }) {
  if (!isUnavailable(method)) return null;
  return (
    <p className="ws-unavailable" style={{ opacity: 0.6, fontSize: 12, fontStyle: 'italic' }}>
      {children ?? 'not available on this node'}
    </p>
  );
}

/** Props to spread onto a button whose write isn't built: disabled, reason in title. */
export function disabledBecause(method: string, reason?: string): { disabled: boolean; title?: string } {
  if (!isUnavailable(method)) return { disabled: false };
  return { disabled: true, title: reason ?? `${method} is not implemented on this node` };
}

export { isHollow, hollowReason, isUnavailable };
