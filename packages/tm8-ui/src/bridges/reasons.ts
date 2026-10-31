import type { BridgesPort } from './api';

/**
 * Why a control is off: its operation is not served by this node yet. Null
 * when it is served, so the control is live. The words name the operation, so
 * a reader can tell "not built yet" from "refused".
 */
export function unservedReason(port: Pick<BridgesPort, 'serves'>, op: string, what: string): string | null {
  return port.serves(op) ? null : `${what} arrives with ${op}, which this node does not serve yet.`;
}

/**
 * For a control this surface does not wire yet: the unserved reason while the
 * node lacks the operation, and once it is served, still a reason — never a
 * silently disabled button (D48).
 */
export function pendingReason(port: Pick<BridgesPort, 'serves'>, op: string, what: string): string {
  return unservedReason(port, op, what) ?? `${what} is served by this node (${op}) but not wired on this screen yet.`;
}
