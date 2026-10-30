import type { BridgesPort } from './api';

/**
 * Why a control is off: its operation is not served by this node yet. Null
 * when it is served, so the control is live. The words name the operation, so
 * a reader can tell "not built yet" from "refused".
 */
export function unservedReason(port: Pick<BridgesPort, 'serves'>, op: string, what: string): string | null {
  return port.serves(op) ? null : `${what} arrives with ${op}, which this node does not serve yet.`;
}
