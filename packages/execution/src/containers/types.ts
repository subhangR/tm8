// @tm8/execution — the container block's graph port and row shapes.
//
// This package has NO database driver and must never gain one (the same rule
// `GraphPort` states for spawn). Every graph effect is a method here, and the
// server implements it over `Db` in `facade/execution-handlers.ts`, mapping
// each one to exactly one SECURITY DEFINER door from migration 177.

import type {
  ContainerLifecycle,
  ContainerLifecycleInput,
  ContainerProfile,
  ContainerShareMode,
  ContainerSpec,
  ContainerStatus,
  ContainerSurfaceKind,
} from '@tm8/contract';

/** Opaque caller claims, exactly as spawn's `GraphAuth` is. */
export type ContainerGraphAuth = unknown;

/** What the service needs to know about a container to act on its runtime. */
export interface ContainerRecord {
  containerId: string;
  spaceId: string;
  nodeId: string;
  status: ContainerStatus;
  profile: ContainerProfile;
  provider: string;
  runtimeRef: string | null;
  spec: ContainerSpec;
  lifecycle: ContainerLifecycle;
  version: number;
  providerState?: Record<string, unknown>;
}

/** One row of `public.node_containers` — the reconciler's input. */
export interface NodeContainerRow {
  containerEntityId: string;
  nodeId: string;
  status: ContainerStatus;
  profile: ContainerProfile;
  provider: string;
  runtimeRef: string | null;
  spec: ContainerSpec;
  lifecycle: ContainerLifecycle;
  expiresAt: string | null;
  statusChangedAt: string | null;
  entityExists: boolean;
  deleted: boolean;
  lastSeenAt: string | null;
  attempts: number;
  failureCode: string | null;
}

/** One row of `public.sweep_containers`. */
export interface SweepRow {
  containerEntityId: string;
  action: 'stop' | 'destroy' | 'pause';
  reason: 'ttl' | 'idle' | 'grace';
}

export interface CreateContainerEntityInput {
  spaceId: string;
  title: string;
  actorId?: string | null;
  profile: ContainerProfile;
  provider: string;
  isolation: string;
  nodeId: string;
  image: string;
  spec: ContainerSpec;
  lifecycle: ContainerLifecycle;
  shareMode: ContainerShareMode;
  role?: string;
  parentId?: string | null;
  projectId?: string | null;
  templateId?: string | null;
  spawnedBy?: string | null;
  cap: number;
  clientMutationId: string;
}

export interface CreateContainerEntityResult {
  containerId: string;
  version: number;
  status: ContainerStatus;
  runtimeRef: string | null;
  /**
   * The ledger said this command has already run. When the door cannot report
   * it, the saga falls back to the status itself, which is the more reliable
   * signal anyway: a `requested` record with no runtime has not been
   * provisioned, whatever the ledger thinks.
   */
  replayed?: boolean;
  /** The command result the handler returns verbatim. */
  raw: unknown;
}

/**
 * The status writer. `set_container_status` has TWO MODES and conflating them
 * is the subtle bug:
 *
 *   * A LEDGERED command — non-null `clientMutationId`, `operation` names the
 *     op, `expectedVersion` asserted when given. This is a user verb.
 *   * A NODE-INTERNAL transition — null cmid AND null operation. This is
 *     provisioning->running, the reconciler and the sweepers. No ledger row,
 *     no version assert, because there is no user command to replay and the
 *     version the node last read is already stale by definition.
 *
 * Passing an operation with a null cmid, or a version on an internal
 * transition, is how a reconciler ends up fighting a user's concurrent verb.
 */
export interface SetContainerStatusInput {
  containerId: string;
  status: ContainerStatus;
  runtimeRef?: string | null;
  surfaces?: ContainerSurfaceKind[] | null;
  error?: string | null;
  actorId?: string | null;
  operation?: string | null;
  expectedVersion?: number | null;
  clientMutationId?: string | null;
}

export interface UpdateContainerInput {
  containerId: string;
  expectedVersion: number;
  actorId?: string | null;
  title?: string | null;
  lifecycle?: ContainerLifecycleInput | null;
  shareMode?: ContainerShareMode | null;
  labels?: Record<string, string> | null;
  clientMutationId: string;
}

export interface ContainerGraphPort {
  /** `public.create_container_entity` — ledgered; reserves the record. */
  createContainerEntity(
    auth: ContainerGraphAuth, input: CreateContainerEntityInput,
  ): Promise<CreateContainerEntityResult>;
  /** `public.set_container_status` — the ONLY status writer. */
  setContainerStatus(
    auth: ContainerGraphAuth, input: SetContainerStatusInput,
  ): Promise<unknown>;
  /** `public.update_container` — ledgered; asserts version. */
  updateContainer(auth: ContainerGraphAuth, input: UpdateContainerInput): Promise<unknown>;
  /** `public.record_container_surfaces` — bumps version, no status change. */
  recordContainerSurfaces(
    auth: ContainerGraphAuth, containerId: string, surfaces: ContainerSurfaceKind[],
  ): Promise<void>;
  /** Read one container's runtime-relevant facts. */
  loadContainer(auth: ContainerGraphAuth, containerId: string): Promise<ContainerRecord | null>;
  /** `public.node_containers` — reconciliation's input. */
  nodeContainers(auth: ContainerGraphAuth, nodeId: string): Promise<NodeContainerRow[]>;
  /** `public.sweep_containers` — rows due for action. */
  sweepContainers(auth: ContainerGraphAuth, nodeId: string, now?: Date): Promise<SweepRow[]>;
  /** `public.record_container_heartbeat` — side table ONLY, never the entity. */
  recordHeartbeat(auth: ContainerGraphAuth, input: {
    containerId: string; nodeId: string;
    usage?: Record<string, unknown>; probe?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * THE FIXED LOCK (§8.4, step 4).
   *
   * A per-node DB ADVISORY LOCK keyed by `hashtext('containers:' || node_id)`,
   * taken in its own short transaction — NOT the in-process `Map` the worktree
   * saga uses.
   *
   * The worktree saga's Map is correct for worktrees because the name space it
   * guards is a directory on one process's disk. A container's name space is
   * the RUNTIME's, and in the desktop composition several server processes
   * share one node and one Docker daemon. An in-process lock there guards
   * nothing: two processes both see a free slot, both create, and the node cap
   * is exceeded by exactly the number of processes.
   */
  withNodeLock<T>(auth: ContainerGraphAuth, nodeId: string, fn: () => Promise<T>): Promise<T>;
}
