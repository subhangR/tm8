// @tm8/execution — the provisioning saga (TM8-CONTAINERS-DESIGN §8.4).
//
// Modelled on the worktree saga, WITH THE LOCK FIXED. Read the note on
// `ContainerGraphPort.withNodeLock` for why an in-process Map is wrong here.
//
// The shape, and why each step is where it is:
//
//   1-3. Validate, then RESERVE the record inside the ledgered door with
//        `status = 'requested'`. The reservation is the replay anchor: a
//        replayed create returns this row and never provisions twice.
//   4.   OUTSIDE the transaction, under the per-node lock: `provider.create`,
//        then `set_container_status('provisioning', runtimeRef)`.
//   5.   `provider.start`, then poll `inspect` until the surfaces answer or the
//        start budget expires, then `set_container_status('running', surfaces)`.
//   6.   COMPENSATION: any failure after the reservation moves the record to
//        `failed` and destroys the runtime. Unlike a worktree, a failed
//        container has nothing worth preserving.
//
// WHY THE RUNTIME IS CREATED OUTSIDE THE TRANSACTION AND WHY THAT IS SAFE:
// a runtime object is not transactional, so holding a DB transaction across it
// would either hold a connection for two minutes or lie about atomicity. The
// crash window between reserving and recording the runtime is closed by the
// LABEL, not by the transaction — every runtime carries `tm8.container=<id>`,
// so reconciliation finds an orphan and adopts or destroys it. That is why the
// label rule in the SPI header is a rule and not a convenience.

import type { ContainerStatus, ContainerSurfaceKind } from '@tm8/contract';

import { ContainerError } from './errors.js';
import type { ContainerProvider, RuntimeHandle } from './provider.js';
import type { ContainerGraphAuth, ContainerGraphPort, CreateContainerEntityInput } from './types.js';

export interface ProvisionInput {
  auth: ContainerGraphAuth;
  provider: ContainerProvider;
  create: CreateContainerEntityInput;
  /** Default 120_000; android is 300_000 (§8.4 step 5). */
  startTimeoutMs: number;
  /** Whether to start after creating — `containers.create { start: false }`. */
  start: boolean;
  dataDir: string;
  actorId?: string | null;
  /** Debugging escape hatch: TM8_CONTAINER_KEEP_FAILED=1 (§8.4 step 6). */
  keepFailed: boolean;
}

export interface ProvisionResult {
  containerId: string;
  status: ContainerStatus;
  version: number;
  runtimeRef: string | null;
  surfaces: ContainerSurfaceKind[];
  /** True when the ledger (or the record) said this create already ran. */
  replayed: boolean;
  raw: unknown;
}

export interface SagaDeps {
  graph: ContainerGraphPort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string, detail?: Record<string, unknown>) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function provisionContainer(
  deps: SagaDeps,
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const { graph } = deps;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;
  const { auth, provider, create } = input;

  // Steps 1-3: the ledgered door reserves the record. Cap and spec validity are
  // enforced INSIDE it (53400 / 22023) so two servers racing cannot both pass a
  // cap check and then both insert.
  const reserved = await graph.createContainerEntity(auth, create);

  // REPLAY (§4.4). The ledger's own answer is preferred, but the RECORD is the
  // more reliable signal and is checked either way: a create that already
  // provisioned is not `requested`, and one that already has a runtime must
  // never be provisioned a second time. Trusting only a `replayed` flag would
  // re-provision whenever the door could not report one.
  const alreadyRan = reserved.replayed === true
    || reserved.status !== 'requested'
    || reserved.runtimeRef !== null;
  if (alreadyRan) {
    return {
      containerId: reserved.containerId,
      status: reserved.status,
      version: reserved.version,
      runtimeRef: reserved.runtimeRef,
      surfaces: [],
      replayed: true,
      raw: reserved.raw,
    };
  }

  let handle: RuntimeHandle | null = null;
  try {
    // Step 4: the per-node advisory lock, held ONLY across the runtime-name
    // space work — not across the whole saga, and not across `start`, which can
    // take two minutes and would serialize every create on the node.
    handle = await graph.withNodeLock(auth, create.nodeId, async () => provider.create(
      create.spec,
      {
        containerId: reserved.containerId,
        spaceId: create.spaceId,
        nodeId: create.nodeId,
        dataDir: input.dataDir,
      },
    ));

    await graph.setContainerStatus(auth, {
      containerId: reserved.containerId,
      status: 'provisioning',
      runtimeRef: handle.runtimeRef,
      // A NODE-INTERNAL transition: no cmid, no operation, no version assert.
      // See the two-mode note on SetContainerStatusInput.
      operation: null,
      clientMutationId: null,
    });

    if (!input.start) {
      return {
        containerId: reserved.containerId,
        status: 'provisioning',
        version: reserved.version,
        runtimeRef: handle.runtimeRef,
        surfaces: [],
        replayed: false,
        raw: reserved.raw,
      };
    }

    // Step 5: start, then wait for the surfaces to actually answer. "Started"
    // is not "usable" — a VNC port that is not accepting yet would hand a
    // client a socket that closes.
    await provider.start(handle);
    const surfaces = await waitForSurfaces({
      provider, handle, startTimeoutMs: input.startTimeoutMs, now, sleep,
    });

    await graph.setContainerStatus(auth, {
      containerId: reserved.containerId,
      status: 'running',
      runtimeRef: handle.runtimeRef,
      surfaces,
      operation: null,
      clientMutationId: null,
    });

    return {
      containerId: reserved.containerId,
      status: 'running',
      version: reserved.version,
      runtimeRef: handle.runtimeRef,
      surfaces,
      replayed: false,
      raw: reserved.raw,
    };
  } catch (err) {
    // Step 6: compensation. It must never throw over the original failure —
    // the caller needs to know why provisioning failed, not why cleanup did.
    const message = err instanceof Error ? err.message : String(err);
    try {
      await graph.setContainerStatus(auth, {
        containerId: reserved.containerId,
        status: 'failed',
        error: message,
        runtimeRef: handle?.runtimeRef ?? null,
        operation: null,
        clientMutationId: null,
      });
    } catch (statusErr) {
      deps.log?.('container compensation could not record failed status', {
        containerId: reserved.containerId,
        detail: statusErr instanceof Error ? statusErr.message : String(statusErr),
      });
    }

    if (handle && !input.keepFailed) {
      try {
        await provider.destroy(handle);
      } catch (destroyErr) {
        // The runtime is now an orphan. Reconciliation finds it by label and
        // cleans it up; logging is the right response, not a second throw.
        deps.log?.('container compensation could not destroy the runtime', {
          containerId: reserved.containerId,
          runtimeRef: handle.runtimeRef,
          detail: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
        });
      }
    }

    throw err instanceof ContainerError
      ? err
      : new ContainerError(message, 'runtime', { containerId: reserved.containerId });
  }
}

async function waitForSurfaces(input: {
  provider: ContainerProvider;
  handle: RuntimeHandle;
  startTimeoutMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}): Promise<ContainerSurfaceKind[]> {
  const { provider, handle, startTimeoutMs, now, sleep } = input;
  const deadline = now() + startTimeoutMs;
  let lastDetail = 'the container never reported a running runtime';

  for (;;) {
    const inspection = await provider.inspect(handle);
    if (inspection.status === 'running' && inspection.surfaces.length > 0) {
      return inspection.surfaces.map((s) => s.kind);
    }
    if (inspection.status === 'gone') {
      throw new ContainerError('the runtime disappeared while starting', 'runtime');
    }
    lastDetail = `the runtime is ${inspection.status} with ${inspection.surfaces.length} live surfaces`;
    if (now() >= deadline) {
      // A TIMEOUT, not a runtime error: the record moves to `failed` and the
      // taxonomy says `upstream_unavailable`. Naming the last observation is
      // what makes this debuggable without node access.
      throw new ContainerError(
        `container did not become ready within ${startTimeoutMs}ms — ${lastDetail}`,
        'timeout',
      );
    }
    await sleep(100);
  }
}
