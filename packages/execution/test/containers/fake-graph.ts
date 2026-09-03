// A ContainerGraphPort that behaves like migration 177's doors, in memory.
//
// It models the two behaviours the saga actually depends on and that a naive
// stub would get wrong:
//   * `create_container_entity` is LEDGERED — a second call with the same
//     clientMutationId returns the FIRST result and inserts nothing.
//   * the node cap is enforced INSIDE the reservation, the way the door does
//     it, so a cap test exercises the real ordering rather than a pre-check.

import type { ContainerStatus, ContainerSurfaceKind } from '@tm8/contract';
import type {
  ContainerGraphPort, ContainerRecord, CreateContainerEntityInput,
  CreateContainerEntityResult, NodeContainerRow, SetContainerStatusInput,
  SweepRow, UpdateContainerInput,
} from '../../src/containers/types.js';
import { ContainerError } from '../../src/containers/errors.js';

export interface StatusWrite extends SetContainerStatusInput { at: number }

const LIVE: ContainerStatus[] = ['requested', 'provisioning', 'running', 'paused', 'stopping'];

export class FakeContainerGraph implements ContainerGraphPort {
  readonly rows = new Map<string, ContainerRecord & {
    statusChangedAt: string | null; deleted: boolean; error: string | null;
    surfaces: ContainerSurfaceKind[];
  }>();

  readonly statusWrites: StatusWrite[] = [];

  readonly ledger = new Map<string, CreateContainerEntityResult>();

  /** Every node-lock acquisition, so a test can prove the saga took it. */
  readonly lockAcquisitions: string[] = [];

  sweepRows: SweepRow[] = [];

  private seq = 0;

  private clock = 0;

  constructor(private readonly opts: { idPrefix?: string } = {}) {}

  async createContainerEntity(
    _auth: unknown, input: CreateContainerEntityInput,
  ): Promise<CreateContainerEntityResult> {
    const replayed = this.ledger.get(input.clientMutationId);
    if (replayed) return { ...replayed, replayed: true };

    const liveCount = [...this.rows.values()].filter((r) => LIVE.includes(r.status)).length;
    if (liveCount >= input.cap) {
      // 53400 from the door — the cap is a DB-side refusal, not an advisory
      // check the service could have made.
      throw new ContainerError(
        `node ${input.nodeId} is at its container cap of ${input.cap}`,
        'budget',
        { cap: input.cap, nodeId: input.nodeId },
      );
    }

    this.seq += 1;
    const containerId = `${this.opts.idPrefix ?? 'ctr'}-${this.seq}`;
    this.rows.set(containerId, {
      containerId,
      spaceId: input.spaceId,
      nodeId: input.nodeId,
      status: 'requested',
      profile: input.profile,
      provider: input.provider,
      runtimeRef: null,
      spec: input.spec,
      lifecycle: input.lifecycle,
      version: 1,
      statusChangedAt: new Date(this.clock).toISOString(),
      deleted: false,
      error: null,
      surfaces: [],
    });
    const result: CreateContainerEntityResult = {
      containerId, version: 1, status: 'requested', runtimeRef: null,
      replayed: false, raw: { entity: { id: containerId } },
    };
    this.ledger.set(input.clientMutationId, result);
    return result;
  }

  async setContainerStatus(_auth: unknown, input: SetContainerStatusInput): Promise<unknown> {
    this.statusWrites.push({ ...input, at: this.clock });
    const row = this.rows.get(input.containerId);
    if (!row) throw new ContainerError('container not found', 'not_found');
    if (input.expectedVersion != null && input.expectedVersion !== row.version) {
      throw new ContainerError('version conflict', 'state', { current: row.version });
    }
    row.status = input.status;
    row.statusChangedAt = new Date(this.clock).toISOString();
    if (input.runtimeRef !== undefined && input.runtimeRef !== null) row.runtimeRef = input.runtimeRef;
    if (input.surfaces) row.surfaces = input.surfaces;
    if (input.error !== undefined) row.error = input.error;
    if (input.status === 'destroyed') row.deleted = true;
    row.version += 1;
    return { entity: { id: row.containerId, version: row.version } };
  }

  async updateContainer(_auth: unknown, input: UpdateContainerInput): Promise<unknown> {
    const row = this.rows.get(input.containerId);
    if (!row) throw new ContainerError('container not found', 'not_found');
    if (row.version !== input.expectedVersion) {
      throw new ContainerError('version conflict', 'state', { current: row.version });
    }
    row.version += 1;
    return { entity: { id: row.containerId, version: row.version } };
  }

  async recordContainerSurfaces(
    _auth: unknown, containerId: string, surfaces: ContainerSurfaceKind[],
  ): Promise<void> {
    const row = this.rows.get(containerId);
    if (!row) throw new ContainerError('container not found', 'not_found');
    row.surfaces = surfaces;
    row.version += 1;   // a surface coming live is a real change
  }

  async loadContainer(_auth: unknown, containerId: string): Promise<ContainerRecord | null> {
    return this.rows.get(containerId) ?? null;
  }

  async nodeContainers(_auth: unknown, nodeId: string): Promise<NodeContainerRow[]> {
    return [...this.rows.values()].filter((r) => r.nodeId === nodeId).map((r) => ({
      containerEntityId: r.containerId,
      nodeId: r.nodeId,
      status: r.status,
      profile: r.profile,
      provider: r.provider,
      runtimeRef: r.runtimeRef,
      spec: r.spec,
      lifecycle: r.lifecycle,
      expiresAt: null,
      statusChangedAt: r.statusChangedAt,
      entityExists: !r.deleted,
      deleted: r.deleted,
      lastSeenAt: null,
      attempts: 0,
      failureCode: null,
    }));
  }

  async sweepContainers(): Promise<SweepRow[]> {
    return this.sweepRows;
  }

  async recordHeartbeat(): Promise<void> {
    // Deliberately a no-op that touches NO row: heartbeats never bump the
    // entity version (§15). A fake that mutated here would hide that rule.
  }

  async withNodeLock<T>(_auth: unknown, nodeId: string, fn: () => Promise<T>): Promise<T> {
    this.lockAcquisitions.push(nodeId);
    return fn();
  }

  advance(ms: number): void { this.clock += ms; }
}
