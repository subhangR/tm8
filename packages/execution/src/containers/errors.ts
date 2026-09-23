// @tm8/execution — the container family's error type.
//
// It mirrors `SpawnError` exactly: a plain Error with a CLOSED code, mapped to
// the contract taxonomy in the handler layer and nowhere else. The execution
// block never imports the HTTP taxonomy, so a code here is the only vocabulary
// this package speaks about failure.
//
// The mapping (TM8-CONTAINERS-DESIGN §4.3) lives in the server's
// execution-handlers, next to the `rethrowing` wrapper that applies it.

import type { ContainerErrorCode } from '@tm8/contract';

export class ContainerError extends Error {
  constructor(
    message: string,
    readonly code: ContainerErrorCode,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContainerError';
  }
}

/**
 * The taxonomy each code maps to (§4.3). Exported as DATA rather than written
 * as a `switch` in the handler so the handler cannot silently grow a default
 * arm: a new code with no row here fails to compile at the mapping site.
 */
export const CONTAINER_ERROR_TAXONOMY = {
  invalid_spec: 'invalid_input',
  not_found: 'not_found',
  forbidden: 'forbidden',
  // Isolation policy is a REFUSAL, not a missing feature: the node could serve
  // this profile, but not at a class the policy accepts. It is 403 and the
  // message names the class and the provider that would satisfy it.
  policy: 'forbidden',
  state: 'invariant_violation',
  budget: 'limit_exceeded',
  // The honest 501 (T-L12): no provider on THIS node satisfies profile+policy.
  // Not a 404 — the operation exists and is part of the contract; this node
  // just cannot serve it.
  no_provider: 'not_implemented',
  runtime: 'upstream_unavailable',
  timeout: 'upstream_unavailable',
} as const satisfies Record<ContainerErrorCode, string>;

export function isContainerError(err: unknown): err is ContainerError {
  return err instanceof ContainerError;
}
