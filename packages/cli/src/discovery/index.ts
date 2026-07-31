/**
 * The discovery surface, as a browser-reachable barrel.
 *
 * WHY IT EXISTS. `discovery/operations.ts` holds the 107-row operation catalog
 * — every summary, syntax line, note and example an agent reads out of
 * `tm8 help` — and it is the largest body of agent-facing prose in the repo.
 * Until now it could only be read by running the CLI, because one `node:crypto`
 * import (the catalog digest, since pinned) made the whole tree unbundleable.
 * The prompt catalog screen shows these rows, so the tree needs a public entry
 * point that a browser can resolve.
 *
 * `observe.ts` is DELIBERATELY NOT re-exported: it imports the HTTP client and
 * the CLI context, which drag node-only transport into anything that touches
 * this barrel. Discovery *data* is portable; discovery *execution* is not.
 */
export {
  CATALOG_DIGEST,
  GRAMMAR_VERSION,
  DISCOVERY,
  COMMAND_PATHS,
  NOUNS,
  PUBLIC_NOUNS,
  UNBOUND_MARKER,
  UNBOUND_NOTE,
  EXPOSURES,
  SIDE_EFFECTS,
  AUTHZ_TARGETS,
  IDEMPOTENCIES,
  VERSIONINGS,
  commands,
  discovery,
  discoveryFor,
  lookupOperation,
  type OperationDiscovery,
  type Exposure,
  type SideEffect,
  type AuthzTarget,
  type Idempotency,
  type Versioning,
} from './operations.js';

export type {
  Availability,
  AvailabilityReason,
  AvailabilitySource,
  AvailabilityLedger,
} from './availability.js';
