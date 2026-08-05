/**
 * `gitCredentials.*` — three operations, one subject: the caller.
 *
 * The registration is thin on purpose. Authorization is not decided here and
 * cannot be: `set` and `delete` go through SECURITY DEFINER RPCs that re-derive
 * the account from the transaction's identity, and `status` reads a table whose
 * RLS policy admits one row and whose column grant withholds the ciphertext. A
 * bug in this file cannot widen any of that.
 *
 * `set` answers 200, not 201: it is an upsert of a singleton, so a second call
 * replaces a rotated token rather than creating a second resource, and there is
 * no location to point a client at.
 */
import type { FacadeDeps } from '../../deps.js';
import type { HandlerRegistry } from '../../registry.js';
import {
  W2GitCredentialsService,
  type W2GitCredentialsServiceOptions,
} from '../../services/w2/git-credentials.js';

export function registerW2GitCredentialHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  options: W2GitCredentialsServiceOptions,
): void {
  const service = new W2GitCredentialsService(deps, options);
  registry.registerAll({
    'gitCredentials.set': service.set,
    'gitCredentials.status': service.status,
    'gitCredentials.delete': service.delete,
  });
}
