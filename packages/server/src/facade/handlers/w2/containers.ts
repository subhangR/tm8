// The `containers.*` handler family (TM8-CONTAINERS-DESIGN §4).
//
// ALL TWENTY-FIVE ROWS ARE REGISTERED HERE, including the fifteen whose
// runtime does not exist yet. That is not tidiness — it is the reserved-op
// honesty rule (DEV-13). A `status: 'v1'` catalog row with NO handler falls
// through the registry and answers `404 not_found`, which tells a caller the
// operation does not exist when in fact it is part of the contract and this
// node simply cannot serve it yet. The honest answer is `501 not_implemented`
// with a reason, and it is the same answer `TM8_CONTAINERS=off` gives, so
// there is ONE gate here rather than a check scattered through each handler.
//
// WHERE THE GATE SITS, AND WHY IT IS NOT PER-HANDLER. `withContainerRuntime`
// wraps every RUNTIME operation once, at registration. A per-handler check is
// the shape that rots: the fifteenth handler added six months from now forgets
// it, and the failure mode is a runtime call succeeding on a node with the
// feature off — silently, because nothing tests the handler nobody wrote yet.
//
// GRAPH-ONLY READS ARE DELIBERATELY NOT GATED. A container that already exists
// is an entity; `entities.get`, `collections.query` and the rest keep working
// with the gate off, because a node that has stopped serving runtimes has not
// stopped being able to describe what it has. Only the runtime verbs 501.

import type { ContainerService } from '@tm8/execution';
import { ContainerError } from '@tm8/execution';

import type { ServerConfig } from '../../../http/config.js';
import { fail } from '../../../http/errors.js';
import type { RequestContext } from '../../../http/types.js';
import { json } from '../../../http/types.js';
import type { HandlerRegistry } from '../../registry.js';
import type { OperationName } from '@tm8/contract';

/**
 * The catalog rows whose work happens on a NODE rather than in the graph.
 *
 * Every one of these answers `501 not_implemented` when `TM8_CONTAINERS=off`.
 * The list is explicit rather than derived from "everything in the family"
 * because two rows are NOT runtime operations: `containers.stream` is the
 * shared socket (its own upgrade path authorizes it) and the universal entity
 * reads serve everything else.
 */
export const CONTAINER_RUNTIME_OPERATIONS = [
  'containers.create',
  'containers.start',
  'containers.stop',
  'containers.pause',
  'containers.resume',
  'containers.destroy',
  'containers.update',
  'containers.policy.set',
  'containers.run',
  'containers.terminal.start',
  'containers.attach',
  'containers.computer',
  'containers.browser.endpoint',
  'containers.files.put',
  'containers.files.get',
  'containers.logs',
  'containers.expose',
  'containers.unexpose',
  'containers.proxy',
  'containers.snapshot',
  'containers.fork',
  'containers.attention',
  'containers.providers.list',
  'containers.pools.set',
] as const satisfies readonly OperationName[];

/**
 * The rows this phase actually serves. Everything else in the family parses
 * and validates and then says so, by name.
 */
const P0_IMPLEMENTED = new Set<OperationName>([
  'containers.create',
  'containers.start',
  'containers.stop',
  'containers.pause',
  'containers.resume',
  'containers.destroy',
  'containers.providers.list',
]);

/**
 * The ONE reason the whole family gives when the gate is off.
 *
 * Uniform on purpose: with containers disabled a node must not give a
 * different explanation per operation depending on which phase happened to
 * ship it. The operation name is prefixed at the throw site; this is the part
 * that must not vary.
 */
const GATE_OFF_REASON = 'containers are not enabled on this node (TM8_CONTAINERS=off)';

/** Why each not-yet-built op is 501 — a NAMED reason, never a bare code. */
const NOT_BUILT_REASON: Partial<Record<OperationName, string>> = {
  'containers.update': 'lands with the graph-only write path',
  'containers.policy.set': 'network policy arrives with the egress proxy (phase 4)',
  'containers.run': 'one-shot exec arrives with the docker provider (phase 1)',
  'containers.terminal.start': 'exec terminals arrive with the docker provider (phase 1)',
  'containers.attach': 'surface attach arrives with the stream bridge (phase 2)',
  'containers.computer': 'computer actions arrive with the desktop profile (phase 2)',
  'containers.browser.endpoint': 'the CDP endpoint arrives with the browser profile (phase 2)',
  'containers.files.put': 'file transfer arrives in phase 5',
  'containers.files.get': 'file transfer arrives in phase 5',
  'containers.logs': 'node-side logs arrive with the docker provider (phase 1)',
  'containers.expose': 'port exposure arrives in phase 3',
  'containers.unexpose': 'port exposure arrives in phase 3',
  'containers.proxy': 'the exposed-port proxy arrives in phase 3',
  'containers.snapshot': 'snapshots arrive in phase 3',
  'containers.fork': 'forking arrives in phase 3',
  'containers.attention': 'takeover requests arrive with the screen surface (phase 2)',
  'containers.pools.set': 'warm pools arrive in phase 3',
};

export interface ContainerHandlerDeps {
  readonly config: ServerConfig;
  /**
   * Absent when the node has no container runtime at all — no database, or
   * the gate is off. The handlers then answer 501 rather than dereferencing
   * a service that was never composed.
   */
  readonly service?: ContainerService;
}

/**
 * Map a `ContainerError` onto the closed taxonomy (§4.3).
 *
 * It is a total switch over the code union rather than a lookup with a
 * default, so adding a code to the contract fails to compile here until it is
 * given a taxonomy — an unmapped code silently becoming a 500 is exactly the
 * kind of drift this table exists to stop.
 */
export function toContainerCollabError(error: unknown): unknown {
  if (!(error instanceof ContainerError)) return error;
  switch (error.code) {
    case 'invalid_spec':
      return fail('invalid_input', error.message, error.detail);
    case 'not_found':
      return fail('not_found', error.message, error.detail);
    case 'forbidden':
      return fail('forbidden', error.message, error.detail);
    // A REFUSAL, not a gap: the node could run this, but not at an isolation
    // class the policy accepts. 403, and the message names what would satisfy.
    case 'policy':
      return fail('forbidden', error.message, error.detail);
    case 'state':
      return fail('invariant_violation', error.message, error.detail);
    case 'budget':
      return fail('limit_exceeded', error.message, error.detail);
    // The honest 501 (T-L12): the operation exists and is part of the
    // contract; no provider on THIS node can serve it.
    case 'no_provider':
      return fail('not_implemented', error.message, error.detail);
    case 'runtime':
    case 'timeout':
      return fail('upstream_unavailable', error.message, error.detail);
    default: {
      // EXHAUSTIVENESS. A new `ContainerErrorCode` fails to compile here until
      // it is given a taxonomy, which is the point of the switch — the closed
      // taxonomy has no 500, so an unmapped code has nowhere honest to go and
      // must be caught at build time rather than at 3am.
      const unmapped: never = error.code;
      throw new Error(`unmapped ContainerErrorCode: ${String(unmapped)}`);
    }
  }
}

async function rethrowingContainer<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toContainerCollabError(error);
  }
}

export function registerW2ContainerHandlers(
  registry: HandlerRegistry,
  deps: ContainerHandlerDeps,
): void {
  const enabled = deps.config.containers?.enabled === true;

  /**
   * THE GATE, applied once per runtime operation at registration.
   *
   * Order matters: the feature gate is checked BEFORE the not-built list, so a
   * node with containers off gives one consistent answer for the whole family
   * rather than a different sentence per operation depending on which phase
   * happened to ship it.
   */
  const withContainerRuntime = (
    name: OperationName,
    handler: (ctx: RequestContext, service: ContainerService) => Promise<unknown>,
  ) => async (ctx: RequestContext): Promise<unknown> => {
    // Every message NAMES THE OPERATION, because the standard closed 501
    // envelope is asserted that way across the suite — an operator reading a
    // log needs to know which call refused, and `details.operation` alone is
    // not what a human sees first. The REASON after the name is what stays
    // uniform across the family for a given cause.
    if (!enabled) {
      throw fail(
        'not_implemented',
        `${name}: ${GATE_OFF_REASON}`,
        { operation: name },
      );
    }
    if (!P0_IMPLEMENTED.has(name)) {
      throw fail(
        'not_implemented',
        `${name}: ${NOT_BUILT_REASON[name] ?? 'not implemented on this node yet'}`,
        { operation: name },
      );
    }
    const service = deps.service;
    if (!service) {
      throw fail(
        'not_implemented',
        `${name}: this node has no container runtime composed`,
        { operation: name },
      );
    }
    return rethrowingContainer(() => handler(ctx, service));
  };

  const handlers: Partial<Record<OperationName, (ctx: RequestContext) => Promise<unknown>>> = {};
  for (const name of CONTAINER_RUNTIME_OPERATIONS) {
    handlers[name] = withContainerRuntime(name, async (_ctx, service) => {
      // The runtime ops that DO work are bound by the execution wiring, which
      // replaces these entries. Reaching this body means the op is in
      // P0_IMPLEMENTED but nothing bound it — a wiring bug, and an honest 501
      // beats a crash.
      void service;
      throw fail('not_implemented', `${name} is not bound on this node`, { operation: name });
    });
  }

  registry.registerAll(handlers as Record<string, (ctx: RequestContext) => Promise<unknown>>);
  void json;
}
